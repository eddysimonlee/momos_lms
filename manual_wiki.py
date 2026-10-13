"""Capability-linked, read-only manual. Never reads or writes the ERP database."""
import gzip
import hashlib
import hmac
import json
import os
import re
import threading
import time
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler

MAX_GZIP = 32 * 1024 * 1024
MAX_HTML = 40 * 1024 * 1024
BUCKET = "momos-manual-wiki-private"
VIEW = re.compile(r"/manual/oncheon/([A-Za-z0-9_-]{43,128})/?")
PUBLISH = "/api/manual-wiki/publish"
STATUS = "/api/manual-wiki/status"
MAX_NOTE = 256 * 1024
# Verified consecutive server publications, before update journaling existed.
# Never infer a previous publication from storage upload order (failed uploads may remain).
LEGACY_COMPARISONS = {
    '1dd0aee6d06d27b7f34059d490d7850ff14b9d05aa46aba142fdf2155c087c72':
    '7bb406fba830418b0a728253ebdb2f5484e869b4f02364415c30ec227d896221'
}
CSP = ("sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals; "
       "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
       "img-src data:; font-src data:; connect-src 'none'; "
       "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")


def matches(token, digest):
    return bool(re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token or "")) and hmac.compare_digest(
        hashlib.sha256(token.encode("ascii")).hexdigest(), digest)


def inspect_payload(payload):
    if not payload or len(payload) > MAX_GZIP:
        raise ValueError("위키 파일 크기 제한")
    unpacker = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = unpacker.decompress(payload, MAX_HTML + 1)
    if len(raw) > MAX_HTML or unpacker.unconsumed_tail or not unpacker.eof or unpacker.unused_data:
        raise ValueError("유효하지 않거나 너무 큰 압축 파일")
    html = raw.decode("utf-8")
    if ("<!DOCTYPE html>" not in html[:200] and "<!doctype html>" not in html[:200]) or \
            'id="source-library"' not in html or 'id="view"' not in html:
        raise ValueError("등록된 위키 형식이 아닙니다")
    return raw


def source_changes(current, previous=None):
    """Compare recorded Word hashes, not generated HTML timestamps or guessed authors."""
    def data(raw):
        match = re.search(rb'<script id="wiki-data" type="application/json">(.*?)</script>', raw or b'', re.S)
        return json.loads(match[1]) if match else {}
    new, old = data(current), data(previous)
    documents = {d['id']: d for d in new.get('docs', [])}
    old_documents = {d['id']: d for d in old.get('docs', [])}
    before = {u: s for s in old.get('source_files', []) for u in s.get('units', [])}
    after = {u for s in new.get('source_files', []) for u in s.get('units', [])}
    changes = []
    for file in new.get('source_files', []):
        units = file.get('units', [])
        matches = [before[u] for u in units if u in before]
        prior = matches[0] if matches else None
        if prior and file.get('sha256') == prior.get('sha256') and file.get('file') == prior.get('file'):
            continue
        changes.append({'kind': 'added' if not prior else 'replaced' if file.get('file') != prior.get('file') else 'updated',
                        'file': file.get('file', ''), 'previous_file': prior.get('file', '') if prior else '',
                        'units': [{'id': u, 'title': documents[u]['title']} for u in units if u in documents]})
    for file in old.get('source_files', []):
        removed = [u for u in file.get('units', []) if u not in after and u in old_documents]
        if removed:
            changes.append({'kind': 'removed', 'file': file.get('file', ''), 'previous_file': '',
                            'units': [{'id': u, 'title': old_documents[u]['title']} for u in removed]})
    for key, page in new.get('review_pages', {}).items():
        prior = old.get('review_pages', {}).get(key)
        if prior and page.get('html') != prior.get('html'):
            changes.append({'kind': 'review', 'file': page.get('title', '보완 자료'), 'previous_file': '',
                            'units': [{'id': key, 'title': page.get('title', '보완 자료')}]})
    return changes


def update_note(meta, current, previous=None):
    return {'id': meta['sha256'], 'published_at': meta['published_at'],
            'basis': 'compared' if previous else 'baseline',
            'changes': source_changes(current, previous) if previous else [], 'previous': ''}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Storage:
    def __init__(self, url, key):
        self.url, self.key = url, key
        self.opener = build_opener(NoRedirect)

    def request(self, method, name, payload=None, content_type="application/octet-stream", limit=MAX_GZIP):
        if not re.fullmatch(r"(?:current\.json|[a-f0-9]{64}\.(?:html\.gz|update\.json))", name):
            raise ValueError("Invalid wiki object")
        return self._call(method, "/object/" + BUCKET + "/oncheon/" + name, payload, content_type, limit)

    def _call(self, method, suffix, payload=None, content_type="application/json", limit=8192):
        url = self.url + "/storage/v1" + suffix
        headers = {"Authorization": "Bearer " + self.key, "apikey": self.key}
        if payload is not None:
            headers.update({"Content-Type": content_type, "x-upsert": "true"})
        try:
            with self.opener.open(Request(url, data=payload, headers=headers, method=method), timeout=20) as response:
                result = response.read(limit + 1)
                if len(result) > limit:
                    raise ValueError("Oversized storage response")
                return result
        except HTTPError as error:
            status = error.code
            try:
                provider = json.loads(error.read(8192))
            except (ValueError, OSError):
                provider = {}
            error.close()
            if method == "GET" and (status == 404 or
                    (status == 400 and isinstance(provider, dict) and str(provider.get("statusCode")) == "404")):
                raise FileNotFoundError("Wiki object unavailable") from None
            raise OSError("Wiki storage request failed") from None

    def ensure_private(self):
        try:
            bucket = json.loads(self._call("GET", "/bucket/" + BUCKET))
        except FileNotFoundError:
            payload = json.dumps({"id": BUCKET, "name": BUCKET, "public": False,
                                  "file_size_limit": MAX_GZIP,
                                  "allowed_mime_types": ["application/gzip", "application/json"]}).encode()
            self._call("POST", "/bucket", payload)
            bucket = json.loads(self._call("GET", "/bucket/" + BUCKET))
        if bucket.get("public") is not False:
            raise ValueError("Wiki storage must be private")

    def get(self, name, limit=MAX_GZIP):
        return self.request("GET", name, limit=limit)

    def put(self, name, payload, content_type):
        self.request("POST", name, payload, content_type, limit=65536)


@dataclass
class Snapshot:
    metadata: dict
    compressed: bytes
    html: bytes


class Service:
    def __init__(self, storage, read_digest, publish_digest):
        self.storage = storage
        self.read_digest = read_digest
        self.publish_digest = publish_digest
        self.snapshot = None
        self.checked = 0.0
        self.refresh_lock = threading.Lock()
        self.publish_lock = threading.Lock()
        self.read_slots = threading.BoundedSemaphore(4)
        self.legacy_note = None

    @classmethod
    def from_env(cls):
        # Optional feature: missing/invalid settings must not stop the ERP.
        url = os.environ.get("SUPABASE_URL", "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
        reader = os.environ.get("MANUAL_WIKI_READ_SHA256", "")
        publisher = os.environ.get("MANUAL_WIKI_PUBLISH_SHA256", "")
        if not (re.fullmatch(r"https://[a-z0-9]{20}\.supabase\.co", url) and key
                and re.fullmatch(r"[a-f0-9]{64}", reader)
                and re.fullmatch(r"[a-f0-9]{64}", publisher)
                and reader != publisher):
            return None
        return cls(Storage(url, key), reader, publisher)

    def current(self):
        if self.snapshot and time.monotonic() - self.checked < 300:
            return self.snapshot
        if not self.refresh_lock.acquire(blocking=False):
            if self.snapshot:
                return self.snapshot
            raise OSError("Wiki is loading")
        try:
            meta = json.loads(self.storage.get("current.json", limit=8192))
            digest = meta.get("sha256", "")
            if not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("Invalid wiki manifest")
            if not self.snapshot or self.snapshot.metadata["sha256"] != digest:
                payload = self.storage.get(digest + ".html.gz")
                if hashlib.sha256(payload).hexdigest() != digest:
                    raise ValueError("Wiki checksum mismatch")
                raw = inspect_payload(payload)
                if hashlib.sha256(raw).hexdigest() != meta.get("html_sha256"):
                    raise ValueError("Wiki HTML checksum mismatch")
                self.snapshot = Snapshot(meta, payload, raw)
            self.checked = time.monotonic()
            return self.snapshot
        except Exception:
            # The most recent verified snapshot survives temporary storage errors.
            self.checked = time.monotonic() - 270
            if self.snapshot:
                return self.snapshot
            raise
        finally:
            self.refresh_lock.release()

    def publish(self, payload, source_digest, expected_digest):
        raw = inspect_payload(payload)
        digest = hashlib.sha256(payload).hexdigest()
        if not re.fullmatch(r"[a-f0-9]{64}", source_digest) or not hmac.compare_digest(digest, expected_digest):
            raise ValueError("위키 파일 해시 불일치")
        try:
            previous = self.current()
        except FileNotFoundError:
            previous = None
        if previous and previous.metadata['sha256'] == digest:
            return previous.metadata
        meta = {"sha256": digest, "html_sha256": hashlib.sha256(raw).hexdigest(),
                "source_sha256": source_digest, "bytes": len(payload),
                "published_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
        name = digest + ".html.gz"
        # Keep immutable older snapshots. Change the pointer only after readback verification.
        self.storage.ensure_private()
        self.storage.put(name, payload, "application/gzip")
        if hashlib.sha256(self.storage.get(name)).hexdigest() != digest:
            raise OSError("Uploaded wiki verification failed")
        head = previous.metadata.get('update_head', '') if previous else ''
        if previous and not head:
            legacy = self.legacy_update(previous)
            if legacy['changes'] or legacy['basis'] == 'baseline':
                self.write_note(legacy)
                head = legacy['id']
        note = update_note(meta, raw, previous.html if previous else None)
        if note['changes'] or not previous:
            note['previous'] = head
            self.write_note(note)
            head = digest
        meta['update_head'] = head
        with self.refresh_lock:
            self.storage.put("current.json", json.dumps(meta).encode(), "application/json")
            self.snapshot = Snapshot(meta, payload, raw)
            self.checked = time.monotonic()
        return meta

    def write_note(self, note):
        raw = json.dumps(note, ensure_ascii=False).encode()
        if len(raw) > MAX_NOTE:
            raise ValueError('자료 업데이트 기록 크기 제한')
        name = note['id'] + '.update.json'
        self.storage.put(name, raw, 'application/json')
        if self.storage.get(name, limit=MAX_NOTE) != raw:
            raise OSError('Update note verification failed')

    def legacy_update(self, snapshot):
        if self.legacy_note and self.legacy_note['id'] == snapshot.metadata['sha256']:
            return self.legacy_note
        digest = LEGACY_COMPARISONS.get(snapshot.metadata['sha256'])
        previous = None
        if digest:
            payload = self.storage.get(digest + '.html.gz')
            if hashlib.sha256(payload).hexdigest() != digest:
                raise ValueError('Previous wiki checksum mismatch')
            previous = inspect_payload(payload)
        self.legacy_note = update_note(snapshot.metadata, snapshot.html, previous)
        return self.legacy_note

    def updates(self, cursor=''):
        snapshot = self.current()
        head = snapshot.metadata.get('update_head', '')
        if cursor:
            if not re.fullmatch(r'[a-f0-9]{64}\.[a-f0-9]{64}', cursor):
                raise ValueError('Invalid updates cursor')
            candidate, signature = cursor.split('.')
            if not hmac.compare_digest(signature, self.update_cursor(candidate).split('.')[1]):
                raise ValueError('Invalid updates cursor')
            head = candidate
        if not head:
            note = self.legacy_update(snapshot)
            return {'items': [note] if note['changes'] or note['basis'] == 'baseline' else [], 'next': ''}
        items, seen = [], set()
        while head and len(items) < 10:
            if head in seen or not re.fullmatch(r'[a-f0-9]{64}', head):
                raise ValueError('Invalid updates chain')
            seen.add(head)
            note = json.loads(self.storage.get(head + '.update.json', limit=MAX_NOTE))
            if note.get('id') != head:
                raise ValueError('Update note identity mismatch')
            items.append(note)
            head = note.get('previous', '')
        return {'items': items, 'next': self.update_cursor(head) if head else ''}

    def update_cursor(self, head):
        # Only cursors traversed from the successful pointer may expose an older note.
        # Failed uploads can leave an unreferenced object that must never be browsable.
        signature = hmac.new(self.publish_digest.encode(), head.encode(), hashlib.sha256).hexdigest()
        return head + '.' + signature


def reply(handler, code, raw, content_type="application/json; charset=utf-8", gzip_encoded=False):
    handler.send_response(code)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(len(raw)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("Content-Security-Policy", CSP)
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Vary", "Accept-Encoding")
    if gzip_encoded:
        handler.send_header("Content-Encoding", "gzip")
    handler.end_headers()
    handler.wfile.write(raw)


def error(handler, code):
    reply(handler, code, json.dumps({"error": {
        404: "Not found", 403: "Forbidden", 413: "File too large",
        400: "Invalid wiki payload", 503: "Wiki temporarily unavailable"
    }[code]}).encode())


def wants_gzip(value):
    for item in value.lower().split(","):
        parts = [part.strip() for part in item.split(";")]
        if parts[0] == "gzip":
            try:
                return all(float(p[2:]) > 0 for p in parts[1:] if p.startswith("q="))
            except ValueError:
                return False
    return False


def handle(handler, method):
    path = handler.path
    if not (path.startswith("/manual/") or path.startswith("/api/manual-wiki/")):
        return False
    handler.guard(False)
    service = getattr(handler.server, "manual_wiki", None)
    if service is None:
        error(handler, 404)
        return True
    view = VIEW.fullmatch(path)
    if view and method == "GET" and matches(view[1], service.read_digest):
        if not service.read_slots.acquire(blocking=False):
            error(handler, 503)
            return True
        try:
            snapshot = service.current()
            encoded = wants_gzip(handler.headers.get("Accept-Encoding", ""))
            reply(handler, 200, snapshot.compressed if encoded else snapshot.html,
                  "text/html; charset=utf-8", encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            error(handler, 503)
        finally:
            service.read_slots.release()
        return True
    if path in (PUBLISH, STATUS) and method == ("POST" if path == PUBLISH else "GET"):
        # Machine integration only. Viewer links and ERP cookies grant no write permission.
        auth = handler.headers.get("Authorization", "")
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if (any(handler.headers.get(k) for k in ("Origin", "Cookie", "Sec-Fetch-Site"))
                or not matches(token, service.publish_digest)):
            error(handler, 403)
            return True
        if path == STATUS:
            try:
                snapshot = service.current()
                reply(handler, 200, json.dumps(snapshot.metadata).encode())
            except FileNotFoundError:
                error(handler, 404)
            except Exception:
                error(handler, 503)
            return True
        if not service.publish_lock.acquire(blocking=False):
            error(handler, 503)
            return True
        try:
            if handler.headers.get("Transfer-Encoding") or handler.headers.get("Content-Type") != "application/gzip":
                raise ValueError("Invalid content type")
            length = int(handler.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_GZIP:
                error(handler, 413)
                return True
            handler.connection.settimeout(30)
            payload = handler.rfile.read(length)
            if len(payload) != length:
                raise ValueError("Incomplete upload")
            metadata = service.publish(payload, handler.headers.get("X-Source-SHA256", ""),
                                       handler.headers.get("X-Content-SHA256", ""))
            reply(handler, 200, json.dumps(metadata).encode())
        except (ValueError, UnicodeError, zlib.error):
            error(handler, 400)
        except Exception:
            error(handler, 503)
        finally:
            service.publish_lock.release()
        return True
    error(handler, 404)
    return True
