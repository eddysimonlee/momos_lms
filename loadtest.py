"""부하 테스트(11/25): 내 PC 에서 LMS 를 띄우고, 가상 사용자 N명이 실제 교육 화면처럼 요청을 보낸다.

    python3 loadtest.py                       # 200명(교육자 40·교육생 160), 3분, DB 왕복 20ms, DB 연결 8개
    python3 loadtest.py --users 50 --minutes 1
    python3 loadtest.py --legacy-poll         # 11/24 이전 화면(5초마다 전체 기록)으로 비교

실서비스·알파에는 요청을 보내지 않는다. 임시 폴더에 체험 DB(SQLite)를 새로 만들고, 끝나면 지운다.
Supabase 를 흉내 내려고 서버 쪽 DB 조회마다 --db-latency-ms 만큼 쉬고, DB 연결은 --pool 개만 동시에 쓰게 한다
(15초 안에 연결을 못 받으면 실서비스의 PoolTimeout 처럼 500).

가상 사용자가 하는 일(v1.js 와 같은 순서)
- 접속: /v1_content.json → /api/auth/status → /api/onboarding (첫 화면 전체)
- 계속: 20초마다 /api/onboarding?peek=1, 표시가 바뀌었으면 전체 다시 받기(--legacy-poll 이면 5초마다 전체)
- 교육자(--trainers 명): 교육생 한 명을 열고(?target=) 평균 --mark-every 초마다 체크 하나를 켜고 끈다(step.mark)
결과: 요청 종류별 건수·실패·응답 시간(중간값·95%·최대), 서버 로그의 요청당 DB 조회 수·연결 대기 시간.
"""
import argparse
import http.client
import json
import os
import random
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import defaultdict
from pathlib import Path

APP = Path(__file__).resolve().parent
PASSWORD = 'LoadTestOnly-Password1!'


# ---------------------------------------------------------------- 서버 (따로 띄우는 프로세스)
def serve(data, port, latency_ms, pool):
    sys.path.insert(0, str(APP))
    import server
    from contextlib import contextmanager
    sem, original = threading.BoundedSemaphore(pool), server.Store.connect

    class Slow:
        def __init__(self, db): self._db = db
        def execute(self, *a, **k):
            time.sleep(latency_ms / 1000)  # Supabase 왕복 흉내 — 서버 로그의 DB 시간(dbms)에 넣는다
            server._REQ.dbtime = getattr(server._REQ, 'dbtime', 0.0) + latency_ms / 1000
            return self._db.execute(*a, **k)
        def __getattr__(self, n): return getattr(self._db, n)

    @contextmanager
    def connect(self):
        if not sem.acquire(timeout=15):
            raise RuntimeError("couldn't get a connection after 15.00 sec (load test pool)")
        try:
            with original(self) as db:
                yield Slow(db)
        finally:
            sem.release()

    server.Store.connect = connect
    import access
    access.Access.rate = lambda self, key, limit=8: None  # 가상 사용자는 모두 127.0.0.1 → 로그인 횟수 제한만 끈다(테스트 서버에서만)
    store = server.Store(Path(data))
    srv = server.make_server(store, port)
    print('READY', flush=True)
    srv.serve_forever()


# ---------------------------------------------------------------- 준비: 계정·교육 배정
def seed(data, users, trainers):
    sys.path.insert(0, str(APP))
    os.environ.pop('LMS_DATABASE_URL', None)
    import server, access, onboarding as ob, lms_store as projects, sqlite3
    store = server.Store(Path(data))
    with sqlite3.connect(store.db) as db:  # PostgreSQL 처럼 읽기가 쓰기에 막히지 않게
        db.execute('PRAGMA journal_mode=WAL')
    auth = access.Access(store)
    admin = auth.create(dict(name='고성운', email='admin@load.test', password=PASSWORD), setup=True)
    people = []
    for i in range(users):
        u = auth.create(dict(name=f'가상{i:03d}', email=f'u{i:03d}@load.test', password=PASSWORD, company='momos'))
        people.append(u)
    with store.connect() as db:
        db.execute("UPDATE access_users SET status='active'")
    svc = ob.Service(store)
    staff = people[:trainers]
    for i, u in enumerate(people):
        with store.connect() as db:
            root = projects.Rooms.read(db, ob.ROOT) or {}
        t = staff[i % len(staff)] if staff else admin
        if t['id'] == u['id']: t = staff[(i + 1) % len(staff)] if len(staff) > 1 else admin  # 교육자는 본인이 아니어야 한다
        svc.update(admin, dict(action='config.enrol', target=admin['id'], revision=0, rootRevision=root.get('revision', 0), requestId=str(uuid.uuid4()),
                               data=dict(learner=u['id'], trainer=t['id'], assessor=t['id'], join=ob.plus(ob.today(), -3))))
    return [u['email'] for u in people], len(ob.STEPS)


# ---------------------------------------------------------------- 가상 사용자
class Stats:
    def __init__(self):
        self.lock, self.times, self.fails = threading.Lock(), defaultdict(list), defaultdict(lambda: defaultdict(int))
        self.inflight = defaultdict(int)  # 끝날 때까지 응답을 못 받은 요청

    def add(self, kind, ms, status):
        with self.lock:
            self.times[kind].append(ms)
            if status != 200: self.fails[kind][status] += 1


class Client:
    def __init__(self, port, stats):
        self.port, self.stats, self.cookie, self.csrf = port, stats, '', ''

    def call(self, kind, method, path, body=None):
        started = time.monotonic()
        with self.stats.lock: self.stats.inflight[kind] += 1
        status, data = 0, None
        try:
            c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)  # 휴대폰 화면도 이 정도면 사람이 포기한다
            h = {'Host': f'127.0.0.1:{self.port}', 'Cookie': self.cookie}
            if method == 'POST':
                h.update({'Content-Type': 'application/json', 'Origin': f'http://127.0.0.1:{self.port}', 'X-CSRF-Token': self.csrf})
            c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
            r = c.getresponse(); raw = r.read(); status = r.status
            for k, v in r.getheaders():
                if k.lower() == 'set-cookie' and v.startswith('erp_session='): self.cookie = v.split(';')[0]
            if r.getheader('Content-Type', '').startswith('application/json'):
                try: data = json.loads(raw)
                except ValueError: status = -2  # JSON 아님 → 화면의 '서버 응답을 확인하지 못했습니다'
            c.close()
        except Exception:
            status = -1  # 연결 실패·시간 초과
        with self.stats.lock: self.stats.inflight[kind] -= 1
        self.stats.add(kind, (time.monotonic() - started) * 1000, status)
        return status, data


def user_loop(email, trainer, args, port, stats, stop, learners_steps):
    cl = Client(port, stats)
    time.sleep(random.uniform(0, args.ramp))
    st, d = cl.call('login', 'POST', '/api/auth/login', dict(email=email, password=PASSWORD))
    if st != 200: return
    cl.csrf = d.get('csrfToken', '')
    cl.call('content.json', 'GET', '/v1_content.json')
    cl.call('auth/status', 'GET', '/api/auth/status')
    st, ctx = cl.call('onboarding (첫 화면)', 'GET', '/api/onboarding')
    if st != 200 or not ctx: return
    target = None
    if trainer:
        others = [r['id'] for r in ctx.get('roster', []) if r['id'] != ctx['user']['id']]
        if others:
            target = random.choice(others)
            st, c2 = cl.call('onboarding ?target (교육생 열기)', 'GET', '/api/onboarding?target=' + target)
            if st == 200 and c2: ctx = c2
    stamps, last_full = ctx.get('stamps'), time.monotonic()
    poll = 5 if args.legacy_poll else args.poll
    next_poll = time.monotonic() + poll * random.uniform(0.5, 1)
    next_mark = time.monotonic() + random.expovariate(1 / args.mark_every) if target else float('inf')
    step_ids, k = learners_steps, 0
    while not stop.is_set():
        now = time.monotonic()
        if now >= next_mark and ctx and ctx.get('learner'):
            sid = random.choice(step_ids)
            on = random.random() < 0.6
            body = dict(action='step.mark', target=target, revision=ctx['learner']['revision'], rootRevision=ctx['rootRevision'],
                        requestId=str(uuid.uuid4()), data=dict(step=sid, index=0, on=on), reply='light')
            st, fresh = cl.call('step.mark (체크 저장)', 'POST', '/api/onboarding', body)
            if st == 200 and fresh: ctx = dict(ctx, learner=fresh['learner'], rootRevision=fresh['rootRevision']) if fresh.get('light') else fresh  # v1.js 처럼 기록만 바꿔 끼운다
            next_mark = now + random.expovariate(1 / args.mark_every)
        elif now >= next_poll:
            q = ('?target=' + target) if target else ''
            if args.legacy_poll:
                st, fresh = cl.call('onboarding (주기 전체)', 'GET', '/api/onboarding' + q)
                if st == 200 and fresh: ctx = fresh
            else:
                k = ctx.get('learnerKey') if ctx else None
                st, p = cl.call('peek (주기 확인)', 'GET', '/api/onboarding?peek=1' + (f'&k={k}' if k is not None else ''))
                now_s = (p or {}).get('stamps') if st == 200 else None
                if now_s and stamps:  # v1.js 와 같은 규칙: 보고 있는 기록·전체 설정이 바뀌면 바로, 다른 사람만 바뀌었으면 1분에 한 번
                    need = now_s['root'] != stamps['root'] or now_s['learner'] != stamps['learner'] or (now_s['all'] != stamps['all'] and now - last_full >= 60)
                else:
                    need = True
                if need:
                    last_full = now
                    st, fresh = cl.call('onboarding (바뀌어서 전체)', 'GET', '/api/onboarding' + q)
                    if st == 200 and fresh: ctx, stamps = fresh, fresh.get('stamps')
            next_poll = now + poll
        stop.wait(0.2)


def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(len(xs) * p))] if xs else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--users', type=int, default=200)
    ap.add_argument('--active', type=int, default=0, help='실제로 화면을 여는 사람 수(0 = 모두). 계정·교육 배정은 --users 명')
    ap.add_argument('--trainers', type=int, default=40, help='교육생을 열고 체크하는 사람 수(나머지는 자기 교육 화면만 열어 둔다)')
    ap.add_argument('--minutes', type=float, default=3)
    ap.add_argument('--ramp', type=float, default=60, help='접속이 몰리는 시간(초): 이 안에 모두 접속')
    ap.add_argument('--poll', type=float, default=20)
    ap.add_argument('--mark-every', type=float, default=15, help='교육자 한 명이 체크를 누르는 평균 간격(초)')
    ap.add_argument('--db-latency-ms', type=float, default=20)
    ap.add_argument('--pool', type=int, default=8)
    ap.add_argument('--legacy-poll', action='store_true', help='11/24 이전 화면처럼 5초마다 전체 기록')
    ap.add_argument('--port', type=int, default=8791)
    ap.add_argument('--serve', nargs=4, help=argparse.SUPPRESS)
    a = ap.parse_args()
    if a.serve:
        return serve(a.serve[0], int(a.serve[1]), float(a.serve[2]), int(a.serve[3]))
    with tempfile.TemporaryDirectory(prefix='lms-load-') as tmp:
        print(f'준비: 가상 사용자 {a.users}명(교육자 {a.trainers}) 계정·교육 배정 …', flush=True)
        t0 = time.monotonic(); emails, _ = seed(tmp, a.users, a.trainers)
        sys.path.insert(0, str(APP)); import onboarding as ob
        steps = list(ob.STEPS)
        print(f'  {time.monotonic() - t0:.0f}초', flush=True)
        log = open(Path(tmp) / 'server.log', 'w')
        srv = subprocess.Popen([sys.executable, __file__, '--serve', tmp, str(a.port), str(a.db_latency_ms), str(a.pool)],
                               stdout=subprocess.PIPE, stderr=log, text=True, env={**os.environ, 'LMS_DATABASE_URL': ''})
        lines, ready = [], threading.Event()
        def pump():
            for line in srv.stdout:
                if line.startswith('READY'): ready.set()
                elif line.startswith('api '): lines.append(line.strip())
        threading.Thread(target=pump, daemon=True).start()
        if not ready.wait(60): srv.kill(); sys.exit('서버가 켜지지 않았어요: ' + (Path(tmp) / 'server.log').read_text()[-2000:])
        stats, stop = Stats(), threading.Event()
        mode = '5초마다 전체(예전)' if a.legacy_poll else f'{a.poll:.0f}초마다 peek'
        print(f'시작: {a.minutes}분, 화면 {mode}, DB 왕복 {a.db_latency_ms:.0f}ms, DB 연결 {a.pool}개', flush=True)
        threads = [threading.Thread(target=user_loop, args=(e, i < a.trainers, a, a.port, stats, stop, steps), daemon=True) for i, e in enumerate(emails[:a.active or len(emails)])]
        for t in threads: t.start()
        time.sleep(a.minutes * 60); stop.set()
        end = time.monotonic() + 15  # 진행 중인 요청은 15초만 더 기다리고, 못 받은 것은 '끝나지 않음'으로 센다
        for t in threads: t.join(max(0, end - time.monotonic()))
        srv.terminate(); srv.wait(10)
        stuck = {k: v for k, v in stats.inflight.items() if v}
        if stuck: print('\n끝나지 않은 요청(30초 안에 응답 없음 포함 전): ' + ', '.join(f'{k} {v}' for k, v in stuck.items()))
        print('\n요청 종류별 결과 (ms)')
        print(f"{'종류':34} {'건수':>6} {'실패':>5} {'중간':>7} {'95%':>7} {'최대':>7}  실패 내용")
        for k in sorted(stats.times):
            xs = stats.times[k]; f = stats.fails[k]
            why = ', '.join(f"{ {-1: '응답 없음', -2: 'JSON 아님'}.get(s, s)}×{n}" for s, n in f.items())
            print(f'{k:34} {len(xs):6} {sum(f.values()):5} {statistics.median(xs):7.0f} {pct(xs, .95):7.0f} {max(xs):7.0f}  {why}')
        agg = defaultdict(lambda: [0, 0, 0, 0, 0, 0])
        for line in lines:
            m = re.match(r'api (\w+) (\S+) (\d+) (\d+)ms db=(\d+) dbms=(\d+)ms cpu=(\d+)ms wait=(\d+)ms', line)
            if m:
                g = agg[f'{m[1]} {m[2]}']; g[0] += 1
                for i, j in enumerate((4, 5, 6, 7, 8), 1): g[i] += int(m[j])
        print('\n서버 쪽 평균 (요청 1건당)')
        print(f"{'요청':34} {'건수':>6} {'시간ms':>8} {'DB조회':>7} {'DB시간ms':>9} {'계산ms':>7} {'연결대기ms':>10}")
        for k, (n, ms, q, dbms, cpu, w) in sorted(agg.items()):
            print(f'{k:34} {n:6} {ms / n:8.0f} {q / n:7.1f} {dbms / n:9.0f} {cpu / n:7.0f} {w / n:10.0f}')


if __name__ == '__main__':
    main()
