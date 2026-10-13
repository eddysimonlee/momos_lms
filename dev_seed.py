"""Create sample accounts for a local trial run. Never use against cloud data.

    python3 dev_seed.py --data-dir ./data

Creates an administrator, a trainer and a learner with one shared local-only
password, and enrols the learner. Refuses to run if the data folder already
has accounts, so it cannot overwrite a real or earlier trial database.
"""
import argparse
import os
import uuid
from pathlib import Path

import access
import onboarding as ob
import server

PASSWORD = 'Momos-local-2026!'
ACCOUNTS = [('관리자', '체험 관리자', 'admin@local.test'),
            ('교육자', '체험 교육자', 'trainer@local.test'),
            ('교육생', '체험 교육생', 'learner@local.test')]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, default=server.APP / 'data')
    args = parser.parse_args()
    if os.environ.get('ERP_DATABASE_URL'):
        raise SystemExit('클라우드 DB 설정이 있는 환경에서는 실행하지 않습니다.')
    store = server.Store(args.data_dir)
    auth = access.Access(store)
    with store.connect() as db:
        if db.execute('SELECT COUNT(*) FROM access_users').fetchone()[0]:
            raise SystemExit('이미 계정이 있는 데이터 폴더입니다. 새 폴더를 지정하세요: --data-dir ./data-trial')
    # The first administrator must be on the ADMINS list; allow the trial name for this process only.
    access.ADMINS = set(access.ADMINS) | {'체험 관리자'}
    admin = auth.create(dict(name='체험 관리자', email='admin@local.test', password=PASSWORD), setup=True)
    users = {'관리자': admin}
    for role, name, email in ACCOUNTS[1:]:
        u = auth.create(dict(name=name, email=email, password=PASSWORD, company='momos'))
        users[role] = auth.update_user(admin, u['id'], dict(status='active', role='member'))
    service = ob.Service(store)
    context = service.get(admin)
    service.update(admin, dict(action='config.enrol', target=context['target'], revision=context['learner']['revision'],
                               rootRevision=context['rootRevision'], requestId=str(uuid.uuid4()),
                               data=dict(learner=users['교육생']['id'], trainer=users['교육자']['id'],
                                         assessor=users['교육자']['id'], join=ob.plus(ob.today(), -4))))
    print('체험용 계정을 만들었습니다 (이 컴퓨터에서만 사용):')
    for role, name, email in ACCOUNTS:
        print(f'  {role:4} {name:8} {email:22} 비밀번호 {PASSWORD}')
    print('다음: python3 server.py --data-dir', args.data_dir)


if __name__ == '__main__':
    main()
