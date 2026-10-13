"""Isolated wiki tests: memory storage, temporary ERP DB, no external traffic."""
import gzip
import hashlib
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
import manual_wiki as wiki
import server

READ = "r" * 43
WRITE = "w" * 43
HTML = b'<!DOCTYPE html><html><body><div id="view"></div><template id="source-library"><section>test</section></template></body></html>'
PACKED = gzip.compress(HTML, mtime=0)
DIGEST = hashlib.sha256(PACKED).hexdigest()
SOURCE = hashlib.sha256(HTML).hexdigest()

def source_html(version='one', filename='원고.docx', generated='now', units=None):
    units = units or [{'id': 'U01', 'title': '근무 준비'}]
    data = {'docs': units, 'generated_at': generated,
            'source_files': [{'file': filename, 'sha256': hashlib.sha256(version.encode()).hexdigest(),
                              'units': [u['id'] for u in units]}]}
    return HTML.replace(b'</body>', ('<script id="wiki-data" type="application/json">' +
        json.dumps(data, ensure_ascii=False) + '</script></body>').encode())


class MemoryStorage:
    def ensure_private(self):
        pass
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.fail = None
    def get(self, name, limit=wiki.MAX_GZIP):
        self.calls.append(("GET", name))
        if self.fail == "GET":
            raise OSError("offline")
        if name not in self.objects:
            raise FileNotFoundError(name)
        return self.objects[name]
    def put(self, name, raw, content_type):
        self.calls.append(("PUT", name))
        if self.fail == name:
            raise OSError("storage failure")
        self.objects[name] = raw


class WikiTests(unittest.TestCase):
    def test_private_bucket_creation_and_public_bucket_refusal(self):
        storage = wiki.Storage('https://' + 'a'*20 + '.supabase.co', 'test-key')
        with patch.object(storage, '_call', side_effect=[FileNotFoundError(), b'{}', b'{"public":false}']) as call:
            storage.ensure_private()
            args = call.call_args_list[1].args
            self.assertEqual(args[:2], ('POST', '/bucket'))
            payload = json.loads(args[2])
            self.assertEqual(payload['id'], wiki.BUCKET)
            self.assertFalse(payload['public'])
            self.assertEqual(payload['file_size_limit'], wiki.MAX_GZIP)
        with patch.object(storage, '_call', return_value=b'{"public":true}') as call:
            with self.assertRaises(ValueError):
                storage.ensure_private()
            self.assertEqual(call.call_count, 1)
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = server.Store(Path(self.temp.name) / "data", Path(self.temp.name))
        self.httpd = server.make_server(self.store, 0)
        self.storage = MemoryStorage()
        self.service = wiki.Service(self.storage, hashlib.sha256(READ.encode()).hexdigest(),
                                    hashlib.sha256(WRITE.encode()).hexdigest())
        self.httpd.manual_wiki = self.service
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join()
        self.temp.cleanup()
    def req(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=5)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result
    def publish(self, raw=PACKED, token=WRITE, extra=None):
        return self.req("POST", wiki.PUBLISH, raw, {
            "Authorization": "Bearer " + token, "Content-Type": "application/gzip",
            "X-Content-SHA256": hashlib.sha256(raw).hexdigest(),
            "X-Source-SHA256": SOURCE, **(extra or {})})
    def view(self, token=READ, headers=None):
        return self.req("GET", "/manual/oncheon/" + token + "/", headers=headers)
    def test_publish_read_without_erp_database_and_cache(self):
        before = self.store.db.read_bytes()
        with patch.object(self.store, "connect", side_effect=AssertionError("ERP DB accessed")), \
             patch.object(self.httpd.access, "session", side_effect=AssertionError("ERP auth accessed")):
            self.assertEqual(self.publish()[0], 200)
            status, headers, raw = self.view(headers={"Accept-Encoding": "gzip"})
            self.assertEqual(status, 200)
            self.assertEqual(gzip.decompress(raw), HTML)
            self.assertNotIn("allow-same-origin", headers["Content-Security-Policy"])
            self.assertIn("connect-src 'none'", headers["Content-Security-Policy"])
            self.assertEqual(headers["Referrer-Policy"], "no-referrer")
            self.assertEqual(headers["X-Robots-Tag"], "noindex, nofollow, noarchive")
            calls = len(self.storage.calls)
            self.assertEqual(self.view()[2], HTML)
            self.assertEqual(len(self.storage.calls), calls)
        self.assertEqual(self.store.db.read_bytes(), before)
    def test_viewer_cannot_publish_or_access_erp(self):
        self.assertEqual(self.publish(token=READ)[0], 403)
        for path in ("/api/onboarding", "/api/auth/users", "/api/item-collaboration"):
            self.assertEqual(self.req("GET", path, headers={"Authorization": "Bearer " + READ})[0], 401)
        self.assertEqual(self.view(WRITE)[0], 404)
    def test_missing_invalid_and_encoded_tokens_refused_without_storage(self):
        for path in ("/manual/", "/manual/oncheon/", "/manual/oncheon/" + "x"*43,
                     "/manual/oncheon/" + READ + "/?x=1", "/manual/oncheon/%72" + READ[1:]):
            self.assertEqual(self.req("GET", path)[0], 404)
        self.assertEqual(self.storage.calls, [])
    def test_browser_publish_requests_refused(self):
        for header in ("Origin", "Cookie", "Sec-Fetch-Site"):
            self.assertEqual(self.publish(extra={header: "test"})[0], 403)
        self.assertEqual(self.storage.calls, [])
    def test_failed_pointer_write_retains_previous_snapshot(self):
        self.assertEqual(self.publish()[0], 200)
        before = self.storage.objects["current.json"]
        self.storage.fail = "current.json"
        changed = gzip.compress(HTML.replace(b"test", b"new"), mtime=0)
        self.assertEqual(self.publish(changed)[0], 503)
        self.assertEqual(self.storage.objects["current.json"], before)
        self.assertEqual(self.view()[2], HTML)
    def test_storage_failure_retains_verified_cache(self):
        self.publish()
        self.service.checked = 0
        self.storage.fail = "GET"
        self.assertEqual(self.view()[2], HTML)
    def test_restart_loads_verified_snapshot(self):
        self.publish()
        self.httpd.manual_wiki = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        self.assertEqual(self.view()[2], HTML)
    def test_corrupt_snapshot_fails_closed(self):
        self.publish()
        self.storage.objects[DIGEST + ".html.gz"] = b"bad"
        self.httpd.manual_wiki = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        self.assertEqual(self.view()[0], 503)
        self.assertEqual(self.req("GET", "/api/health")[0], 200)
    def test_malformed_oversized_and_hash_mismatch_do_not_publish(self):
        for raw in (b"not gzip", gzip.compress(b"not html"), PACKED + b"trailing"):
            self.assertEqual(self.publish(raw)[0], 400)
        self.assertEqual(self.publish(extra={"X-Content-SHA256": "0"*64})[0], 400)
        with patch.object(wiki, "MAX_HTML", 20):
            self.assertEqual(self.publish()[0], 400)
        self.assertEqual(self.storage.calls, [])
    def test_disabled_feature_does_not_break_erp(self):
        self.httpd.manual_wiki = None
        self.assertEqual(self.view()[0], 404)
        self.assertEqual(self.req("GET", "/api/health")[0], 200)
        self.assertEqual(self.req("GET", "/api/state")[0], 401)
    def test_host_checks_and_methods_remain_enforced(self):
        self.assertEqual(self.view(headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/manual/oncheon/" + READ + "/")[0], 404)
        self.assertEqual(self.req("PUT", wiki.PUBLISH)[0], 404)
    def test_status_requires_separate_machine_token(self):
        self.publish()
        self.assertEqual(self.req("GET", wiki.STATUS)[0], 403)
        status, _, raw = self.req("GET", wiki.STATUS, headers={"Authorization": "Bearer " + WRITE})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["source_sha256"], SOURCE)
    def test_gzip_negotiation_and_read_concurrency(self):
        self.publish()
        self.assertEqual(self.view(headers={"Accept-Encoding": "gzip;q=0"})[2], HTML)
        for _ in range(4):
            self.service.read_slots.acquire()
        try:
            self.assertEqual(self.view()[0], 503)
            self.assertEqual(self.req("GET", "/api/health")[0], 200)
        finally:
            for _ in range(4):
                self.service.read_slots.release()

    def test_source_updates_survive_restart_and_unchanged_publish_is_idempotent(self):
        initial = gzip.compress(source_html(), mtime=0)
        self.assertEqual(self.publish(initial)[0], 200)
        base = self.service.updates()['items'][0]
        self.assertEqual(base['basis'], 'baseline')
        changed = gzip.compress(source_html('two'), mtime=0)
        self.assertEqual(self.publish(changed)[0], 200)
        latest = self.service.updates()['items'][0]
        self.assertEqual(latest['changes'][0]['kind'], 'updated')
        self.assertEqual(latest['changes'][0]['units'][0]['title'], '근무 준비')
        before = self.storage.objects['current.json']
        self.assertEqual(self.publish(changed)[0], 200)
        self.assertEqual(self.storage.objects['current.json'], before)
        restarted = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        self.assertEqual(restarted.updates()['items'], self.service.updates()['items'])
        self.assertEqual(len(restarted.updates()['items']), 2)
        self.assertNotIn('author', latest)

    def test_file_replacement_and_added_removed_units_are_recorded_from_source(self):
        old = source_html()
        changed = source_html('two', '새 정본.docx')
        self.assertEqual(wiki.source_changes(changed, old)[0]['kind'], 'replaced')
        other = source_html('three', '별도 원고.docx', units=[{'id':'U02','title':'별도 교육'}])
        self.assertEqual([c['kind'] for c in wiki.source_changes(other, changed)], ['added', 'removed'])
        self.assertEqual(wiki.source_changes(source_html(generated='tomorrow'), old), [])

    def test_html_only_changes_do_not_create_content_update_notes(self):
        self.publish(gzip.compress(source_html(), mtime=0))
        before = self.service.updates()['items']
        self.publish(gzip.compress(source_html(generated='tomorrow'), mtime=0))
        self.assertEqual(self.service.updates()['items'], before)

    def test_failed_note_or_pointer_write_never_reports_an_update_and_retry_is_safe(self):
        self.publish(gzip.compress(source_html(), mtime=0))
        before = self.service.updates()['items']
        changed = gzip.compress(source_html('two'), mtime=0)
        for failure in (hashlib.sha256(changed).hexdigest() + '.update.json', 'current.json'):
            self.storage.fail = failure
            self.assertEqual(self.publish(changed)[0], 503)
            self.assertEqual(self.service.updates()['items'], before)
            failed_id = hashlib.sha256(changed).hexdigest()
            for cursor in (failed_id, failed_id + '.' + '0'*64):
                with self.assertRaises(ValueError):self.service.updates(cursor)
        self.storage.fail = None
        self.assertEqual(self.publish(changed)[0], 200)
        self.assertEqual(len(self.service.updates()['items']), 2)

    def test_verified_legacy_pair_is_compared_without_guessing_or_writing_storage(self):
        old, new = gzip.compress(source_html(), mtime=0), gzip.compress(source_html('two'), mtime=0)
        self.publish(new)
        meta = self.service.snapshot.metadata.copy();meta.pop('update_head')
        self.storage.objects['current.json'] = json.dumps(meta).encode()
        old_id = hashlib.sha256(old).hexdigest();self.storage.objects[old_id + '.html.gz'] = old
        restarted = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        with patch.dict(wiki.LEGACY_COMPARISONS, {meta['sha256']:old_id}):
            count = len(self.storage.objects)
            note = restarted.updates()['items'][0]
            self.assertEqual(note['basis'], 'compared')
            self.assertEqual(note['published_at'], meta['published_at'])
            self.assertEqual(len(note['changes']), 1)
            self.assertEqual(len(self.storage.objects), count)
        no_pair = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        self.assertEqual(no_pair.updates()['items'][0]['basis'], 'baseline')

    def test_update_history_paginates_without_losing_older_records(self):
        for i in range(12):
            self.publish(gzip.compress(source_html(str(i)), mtime=0))
        page = self.service.updates()
        self.assertEqual(len(page['items']), 10)
        older = self.service.updates(page['next'])
        self.assertEqual(len(older['items']), 2)
        self.assertFalse(older['next'])
        self.assertFalse(set(x['id'] for x in page['items']) & set(x['id'] for x in older['items']))
        restarted = wiki.Service(self.storage, self.service.read_digest, self.service.publish_digest)
        self.assertEqual(restarted.updates(page['next']), older)
        with self.assertRaises(ValueError):self.service.updates('../../current')

    def test_update_feed_requires_login_and_current_onboarding_admission(self):
        self.publish(gzip.compress(source_html(), mtime=0))
        self.assertEqual(self.req('GET', '/api/onboarding/material-updates')[0], 401)
        # Admission checks use isolated fixtures; no real account or education writes.
        with patch('access.Access.session', return_value={'user': {'id':'test'}, 'csrfToken':'test'}), \
             patch('onboarding.Service.get', return_value={}) as admission:
            status, _, raw = self.req('GET', '/api/onboarding/material-updates')
            self.assertEqual(status, 200);self.assertEqual(json.loads(raw)['items'][0]['basis'], 'baseline')
            admission.assert_called_once()
        with patch('access.Access.session', return_value={'user': {'id':'test'}, 'csrfToken':'test'}), \
             patch('onboarding.Service.get', side_effect=PermissionError('blocked')):
            self.assertEqual(self.req('GET', '/api/onboarding/material-updates')[0], 403)


if __name__ == "__main__":
    unittest.main()
