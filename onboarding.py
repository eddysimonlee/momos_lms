"""Employee education records, isolated from ERP state and canonical documents.

Uses the existing metadata transaction/Cloud adapter. No account, schema, policy,
mail, scheduler, or document modifications. Every write rechecks current identity.
"""
import base64
import binascii
import re
import html
import zipfile
import io
from html.parser import HTMLParser
import calendar
import copy
import hashlib
import json
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import lms_store as projects

ROOT = 2026100201
FORMAT = 'momos-education-v1'
COURSE = json.loads(Path(__file__).with_name('onboarding_course.json').read_text(encoding='utf-8'))
STEPS = {s['id']: dict(s, unit=u['id'], plan=s.get('defaultDays', u['plan'])) for u in COURSE['units'] for s in u['steps']}
# v1 교육안(v1_lessons.json)이 원본 문서 기준으로 다시 쓴 항목은 제목·수행 확인 문구를 그쪽으로 맞춘다.
# 기록의 체크 배열 길이는 fit()이 맞추므로, 문구가 바뀐 항목의 이전 체크는 앞에서부터 이어진다.
_LESSONS = Path(__file__).with_name('v1_lessons.json')
if _LESSONS.exists():
    for _id, _l in json.loads(_LESSONS.read_text(encoding='utf-8')).get('lessons', {}).items():
        if _id in STEPS and _l.get('checks'):
            STEPS[_id]['checks'] = [c['text'] if isinstance(c, dict) else c for c in _l['checks']]
        if _id in STEPS and _l.get('title'):
            STEPS[_id]['title'] = _l['title']
    # 6단계 교육과정(curriculum.json)에서 새로 생긴 세션: 교육과정 파일에는 없고 교육안에만 있다. 기록 칸을 만들 수 있도록 단계 항목으로 등록한다.
    # 권장 일차는 아직 정해지지 않아(교육과정 메모) 입사 후 1~180일로 둔다.
    _CURRICULUM = Path(__file__).with_name('curriculum.json')
    if _CURRICULUM.exists():
        _all = json.loads(_LESSONS.read_text(encoding='utf-8')).get('lessons', {})
        for _st in json.loads(_CURRICULUM.read_text(encoding='utf-8')).get('stages', []):
            for _u in _st['units']:
                for _s in _u['sessions']:
                    _l = _all.get(_s['id'], {})
                    if _s['id'] not in STEPS and _l.get('checks'):
                        STEPS[_s['id']] = dict(id=_s['id'], title=_s.get('title') or _l.get('title', ''), copy=[], photos=[], note='', ref='', refs=[],
                                               checks=[c['text'] if isinstance(c, dict) else c for c in _l['checks']],
                                               unit='curriculum-' + _u['no'], plan=_u.get('plan') or [1, 180])
                    elif _s['id'] in STEPS and _u.get('plan'):
                        STEPS[_s['id']]['plan'] = list(_u['plan'])  # 교육과정이 단원 일정을 정했으면 그 단원의 항목도 같은 일정
TESTS = {t['id']: t for t in COURSE['tests']}
QUESTIONS = {q['id']: q for q in COURSE['bank']}
SYSTEM_REVIEWS = json.loads(Path(__file__).with_name('onboarding_reviews.json').read_text(encoding='utf-8'))
ACTION_NAMES = {'step.start':'실습 시작','step.self':'직원 실습 체크','step.request':'교육자 확인 요청',
                'step.teacher':'교육자 항목 확인','step.complete':'실습 확인 완료','step.retry':'새 시도 · 재실습',
                'step.memo':'실습 메모 저장','schedule.reason':'일정 지연 사유 기록','plan.save':'개별 실습 예정일 조정','plan.test':'포지션 시험 예정일 조정',
                'practice.add':'포지션 반복 연습 기록','test.record':'현장 포지션 평가 기록',
                'quiz.assign':'학습 퀴즈 문항 배정','quiz.retry':'학습 퀴즈 재응시 · 이전 답안 보존',
                'quiz.answers':'학습 퀴즈 답안 저장','quiz.submit':'학습 퀴즈 답안 제출','quiz.grade':'제조 순서 답안 교육자 검토'}
CATEGORIES = {'technical': ['체크·저장 오류','화면·사용성','가입·로그인·권한','기타 기술 문의'],
              'content': ['내용 상충','기준 변경','설명·사진 보완','문제·채점 기준','기타 내용 문의']}



class InquiryHTML(HTMLParser):
    """Only formatting and this author's validated education image references."""
    tags={'p','div','br','strong','b','em','i','u','ul','ol','li','blockquote'}
    def __init__(self, images):
        super().__init__(convert_charrefs=True)
        self.images=images;self.out=[];self.plain=[];self.skip=0;self.used=[]
    def handle_starttag(self, tag, attrs):
        if tag in ('script','style','iframe','object','svg','math'):
            self.skip+=1;return
        if self.skip:return
        if tag in self.tags:
            self.out.append('<'+tag+'>')
            if tag in ('br','p','div','li'):self.plain.append('\n')
        elif tag=='img':
            src=dict(attrs).get('src','')
            ident=src.removeprefix('/api/onboarding/attachments/')
            if src=='/api/onboarding/attachments/'+ident and ident in self.images:
                self.out.append('<img src="/api/onboarding/attachments/'+ident+'" alt="문의에 첨부한 사진">');self.used.append(ident)
            else:raise ValueError('문의 사진은 직접 첨부한 파일을 사용하세요.')
    def handle_endtag(self,tag):
        if tag in ('script','style','iframe','object','svg','math'):
            self.skip=max(0,self.skip-1);return
        if not self.skip and tag in self.tags and tag!='br':self.out.append('</'+tag+'>')
    def handle_data(self,data):
        if not self.skip:self.out.append(html.escape(data));self.plain.append(data)

def inquiry_rich(value, images):
    value=projects.text(value,20000)
    parser=InquiryHTML(images);parser.feed(value);parser.close()
    return ''.join(parser.out),''.join(parser.plain).strip(),parser.used


def today():
    return datetime.now(timezone(timedelta(hours=9))).date().isoformat()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def day(v):
    v = projects.text(v, 10, True)
    if len(v) != 10 or date.fromisoformat(v).isoformat() != v:
        raise ValueError('유효한 날짜를 입력하세요.')
    return v


def plus(d, n):
    return (date.fromisoformat(d) + timedelta(days=n)).isoformat()


def month(d, n):
    x = date.fromisoformat(d)
    y, m = divmod(x.year * 12 + x.month - 1 + n, 12)
    return date(y, m + 1, min(x.day, calendar.monthrange(y, m + 1)[1])).isoformat()


def fit(learner):
    """Pad or trim per-check arrays when a step's check list changed length after records were saved.
    교육과정에 새로 생긴 항목은 기존 기록에 빈 기록 칸과 일정을 더한다."""
    if not learner:
        return learner
    records = learner.setdefault('records', {})
    plans = learner.setdefault('planDates', {})
    join = learner.get('join') or today()
    for ident, s in STEPS.items():
        if ident not in records:
            n = len(s['checks'])
            records[ident] = dict(status='ready', self=[False]*n, teacher=[False]*n, selfAt=[None]*n, teacherAt=[None]*n, start=None,
                                  done=None, request=None, attempt=1, memo='', feedback='', history=[], lessonVersion=COURSE['version'])
        if ident not in plans:
            plans[ident] = dict(start=plus(join, s['plan'][0]-1), end=plus(join, s['plan'][1]-1), edited=False)
    for ident, r in learner.get('records', {}).items():
        s = STEPS.get(ident)
        if not s: continue
        n = len(s['checks'])
        for key, empty in (('self', False), ('teacher', False), ('selfAt', None), ('teacherAt', None), ('selfBy', None), ('teacherBy', None)):
            if key in r and len(r[key]) != n:
                r[key] = (list(r[key]) + [empty] * n)[:n]
    return learner


def blank(join):
    records = {}
    plans = {}
    for ident, s in STEPS.items():
        count = len(s['checks'])
        records[ident] = dict(status='ready', self=[False]*count, teacher=[False]*count,
                              selfAt=[None]*count, teacherAt=[None]*count, start=None,
                              done=None, request=None, attempt=1, memo='', feedback='',
                              history=[], lessonVersion=COURSE['version'])
        plans[ident] = dict(start=plus(join,s['plan'][0]-1), end=plus(join,s['plan'][1]-1),edited=False)
    for ident, t in TESTS.items():
        d = plus(month(join,t['month']),-t['buffer'])
        plans['test-'+ident] = dict(start=d,end=d,edited=False)
    return dict(revision=0, join=join, startDate=join, records=records, planDates=plans,
                tests={k:dict(attempts=[],planHistory=[]) for k in TESTS},
                practiceLogs=[],exam=None,examArchive=[],events=[],planHistory=[])


class Service:
    def __init__(self, store):
        self.store = store

    def root(self, db):
        root = projects.Rooms.read(db, ROOT)
        if root is None:
            return dict(format=FORMAT,revision=0,learners={},technical=[],content=[],
                        tickets=[],requests=[],audit=[])
        if root.get('format') != FORMAT:
            raise ValueError('교육 저장 영역의 기존 형식이 다릅니다. 운영자 확인이 필요합니다.')
        return root

    def identity(self, db, user):
        row = db.execute("SELECT id,name,role,company,status FROM access_users WHERE id=?", (user['id'],)).fetchone()
        if not row or row['status'] != 'active':
            raise PermissionError('승인된 계정으로 다시 로그인하세요.')
        return dict(row)

    def admin(self, user):
        return user['company'] == 'momos' and user['role'] == 'admin'

    def admitted(self, root, user):
        if self.admin(user): return True
        override=root.get('accessOverrides',{}).get(user['id'])
        if override is not None: return override['allowed']
        return (user['company']=='momos' or user['id'] in root['technical'] or user['id'] in root['content']
                or any(user['id'] in (x['trainer'],x['assessor']) for x in root['learners'].values()))

    def roles(self, root, user, target):
        entry = root['learners'].get(target)
        own = user['id'] == target and bool(entry)
        # 1차: 배정 없이 운영한다. 관리자는 누구의 교육이든 확인할 수 있다(본인 것은 제외). 배정된 교육자·평가자도 그대로 인정.
        admin=self.admin(user)
        return dict(own=own, trainer=bool(entry and not own and (admin or user['id']==entry['trainer'])),
                    assessor=bool(entry and not own and (admin or user['id']==entry['assessor'])),
                    admin=admin,technical=user['id'] in root['technical'],content=user['id'] in root['content'])

    def may_view(self, root, user, target):
        p = self.roles(root,user,target)
        return target==user['id'] or p['trainer'] or p['assessor'] or p['admin']

    def get(self, user, target=None):
        with self.store.connect() as db:
            return self.context(db,self.root(db),self.identity(db,user),target or user['id'])

    def context(self, db, root, user, target):
        if not self.admitted(root,user):
            raise PermissionError('현장 온보딩 접근이 허용되지 않았습니다. 관리자에게 온보딩 접근 권한을 요청하세요.')
        if not self.may_view(root,user,target):
            raise PermissionError('본인 또는 배정된 교육생의 기록만 열 수 있습니다.')
        users = {r['id']:dict(r) for r in db.execute("SELECT id,name,company,role FROM access_users WHERE status='active'").fetchall()}
        entry = root['learners'].get(target)
        learner = fit(projects.Rooms.read(db,entry['key'])) if entry else blank(today())
        learner = copy.deepcopy(learner)
        learner['startDate']=entry.get('startDate',entry['join']) if entry else None
        for exam in [learner['exam'], *learner['examArchive']]:
            if exam and exam['status']=='assigned':
                for q in exam['questions']:
                    q.pop('answer',None);q.pop('explain',None)
                    if q.get('pairs'):
                        for p in q['pairs']:p.pop('right',None)
        permissions = self.roles(root,user,target)
        tickets = [copy.deepcopy(t) for t in root['tickets'] if self.ticket_visible(t,user,permissions)]
        roster = [dict(id=i,name=users[i]['name'],join=x['join'],startDate=x.get('startDate',x['join']),trainer=users.get(x['trainer'],{}).get('name','미배정'),
                       assessor=users.get(x['assessor'],{}).get('name','미배정'))
                  for i,x in root['learners'].items() if i in users and self.may_view(root,user,i)]
        if not any(x['id']==user['id'] for x in roster):
            roster.insert(0,dict(id=user['id'],name=user['name'],join=None,startDate=None,trainer='미배정',assessor='미배정'))
        workspace_roles=dict(admin=self.admin(user),learner=user['id'] in root['learners'],
                             trainer=any(x['trainer']==user['id'] for x in root['learners'].values()),
                             assessor=any(x['assessor']==user['id'] for x in root['learners'].values()),
                             technical=user['id'] in root['technical'],content=user['id'] in root['content'])
        review_access=any(workspace_roles[k] for k in ('admin','trainer','assessor','technical','content'))
        summaries=[]
        for r in roster:
            item=root['learners'].get(r['id'])
            if not item: continue
            l=fit(projects.Rooms.read(db,item['key']));records=l['records']
            done=sum(records[i]['status']=='done' for i in STEPS);waiting=[i for i in STEPS if records[i]['status']=='review']
            started=item.get('startDate',item['join'])
            summaries.append(dict(**r,total=len(STEPS),done=done,waiting=waiting,canConfirm=self.roles(root,user,r['id'])['trainer'],canAssess=self.roles(root,user,r['id'])['assessor'],
                                  overdue=sum(records[i]['status']!='done' and l['planDates'][i]['end']<today() for i in STEPS) if started and started<=today() else 0,
                                  tests={i:dict(date=l['planDates']['test-'+i]['start'],passed=any(a['result']=='pass' for a in l['tests'][i]['attempts'])) for i in TESTS}))
        reviews=self.system_reviews(root) if review_access else []
        # Static teaching caveats only; processing comments, attachments and history stay restricted.
        lesson_notes=[{k:copy.deepcopy(r[k]) for k in ('id','title','category','step','relatedSteps','needed','evidence','sourceFile','sourceVersion','checkedAt') if k in r} for r in SYSTEM_REVIEWS if root.get('systemReviews',{}).get(r['id'],{}).get('status')!='applied']
        return dict(workspaceRoles=workspace_roles,educationSummary=summaries,systemReviews=reviews,reviewAccess=review_access,lessonReviewNotes=lesson_notes,
                    user=user,target=target,name=users.get(target,{}).get('name','교육생'),
                    enrolled=bool(entry),scheduled=bool(learner['startDate']),today=today(),rootRevision=root['revision'],learner=learner,
                    permissions=permissions,roster=roster,tickets=tickets,
                    assets={i:copy.deepcopy(a) for i,a in root.get('assets',{}).items() if a['owner']==user['id'] or any(i in t.get('attachments',[]) or any(i in m.get('attachments',[]) for m in t['messages']) for t in tickets) or any(i in r.get('attachments',[]) for r in reviews)},
                    notifications=self.notices(db,root,user,users),
                    assignments=self.assignments(learner, bool(entry)),
                    names={t['person']:t['author'] for t in tickets},
                    configuration=dict(learners=root['learners'],technical=root['technical'],content=root['content'],
                                       accessOverrides=copy.deepcopy(root.get('accessOverrides',{})),
                                       users=[dict(u,admitted=self.admitted(root,u)) for u in users.values()]) if permissions['admin'] else None)

    def system_reviews(self,root):
        saved=root.get('systemReviews',{})
        return [dict(copy.deepcopy({k:v for k,v in r.items() if k!='image'}),**copy.deepcopy(saved.get(r['id'],dict(status='open',comment='',source='',attachments=[],history=[])))) for r in SYSTEM_REVIEWS]

    def review_system(self,db,root,user,d):
        if set(d)!={'id','status','comment','source','attachments'}: raise ValueError('수정 요청의 처리 내용을 확인하세요.')
        definition=next((r for r in SYSTEM_REVIEWS if r['id']==d['id']),None)
        if not definition: raise ValueError('수정 요청을 확인하세요.')
        if not (self.admin(user) or user['id'] in root['technical' if definition['kind']=='technical' else 'content']):
            raise PermissionError('이 종류의 수정 요청은 관리자 또는 지정된 문의 담당자가 처리합니다.')
        if d['status'] not in ('open','working','resolved','hold','applied'): raise ValueError('처리 상태를 확인하세요.')
        comment=projects.text(d['comment'],2000,True);source=projects.text(d['source'],2000)
        if d['status'] in ('resolved','applied') and not source: raise ValueError('보완 확인·반영 완료 시 자료 또는 반영 위치와 확인 판본을 기록하세요.')
        previous=root.get('systemReviews',{}).get(d['id'],dict(status='open',comment='',source='',attachments=[],history=[]))
        ids=d['attachments']
        if not isinstance(ids,list) or len(ids)>5 or len(set(ids))!=len(ids): raise ValueError('첨부는 최대 5개입니다.')
        for i in ids:
            a=root.get('assets',{}).get(i)
            if not a or (a['owner']!=user['id'] and i not in previous['attachments']): raise PermissionError('수정 요청에 연결된 첨부 또는 직접 올린 파일을 선택하세요.')
        item=dict(status=d['status'],comment=comment,source=source,attachments=ids[:],history=copy.deepcopy(previous['history']))
        item['history'].append(dict(at=stamp(),actor=user['name'],status=d['status'],comment=comment,source=source,attachments=ids[:]))
        root.setdefault('systemReviews',{})[d['id']]=item

    def ticket_visible(self,t,user,p):
        # Missing visibility means legacy private; admission is checked by callers.
        return t['person']==user['id'] or p[t['type']] or t.get('visibility')=='shared'

    def upload_asset(self,user,v):
        if not isinstance(v,dict) or set(v)!={'requestId','name','contentBase64'}:
            raise ValueError('첨부 파일 요청을 확인하세요.')
        try: ident=uuid.UUID(v['requestId']).hex
        except (ValueError,TypeError,AttributeError):raise ValueError('첨부 요청 식별자를 확인하세요.')
        name=projects.text(v['name'],200,True)
        if any(c in name for c in '/\\\x00\r\n') or any(ord(c)<32 for c in name):raise ValueError('첨부 파일명을 확인하세요.')
        encoded=v['contentBase64']
        if not isinstance(encoded,str) or len(encoded)>4*((8*1024*1024+2)//3):raise ValueError('첨부는 파일당 8MB 이하로 올려 주세요.')
        try:raw=base64.b64decode(encoded,validate=True)
        except (ValueError,binascii.Error):raise ValueError('첨부 파일을 읽을 수 없습니다.')
        if not raw or len(raw)>8*1024*1024:raise ValueError('첨부는 파일당 8MB 이하로 올려 주세요.')
        suffix=Path(name).suffix.lower();mime='application/octet-stream'
        if suffix in ('.png','.jpg','.jpeg'):
            from lms_store import image_info
            mime=image_info(raw,name)['mime']
        elif suffix=='.pdf':
            if not raw.startswith(b'%PDF-'):raise ValueError('PDF 파일 내용을 확인하세요.')
        elif suffix in ('.docx','.xlsx'):
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    names=archive.namelist()
                    if '[Content_Types].xml' not in names or not any(n.startswith('word/' if suffix=='.docx' else 'xl/') for n in names) or any('vbaproject' in n.lower() for n in names):raise ValueError()
            except (ValueError,zipfile.BadZipFile):raise ValueError('매크로 없는 Word 또는 Excel 파일을 선택하세요.')
        elif suffix in ('.txt','.csv'):
            try:raw.decode('utf-8-sig')
            except UnicodeError:raise ValueError('텍스트·CSV는 UTF-8 파일로 올려 주세요.')
        else:raise ValueError('PNG·JPEG·PDF·DOCX·XLSX·TXT·CSV 파일을 올려 주세요.')
        digest=hashlib.sha256(raw).hexdigest();created=False;path=self.store.data/'uploads'/ident
        try:
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE');user=self.identity(db,user);root=self.root(db)
                if not self.admitted(root,user):raise PermissionError('교육 참여 계정으로 로그인하세요.')
                assets=root.setdefault('assets',{})
                if ident in assets:
                    asset=assets[ident]
                    if asset['owner']!=user['id'] or asset['sha256']!=digest or asset['name']!=name:raise ValueError('첨부 요청 식별자가 중복되었습니다.')
                    return dict(asset=copy.deepcopy(asset),rootRevision=root['revision'])
                if db.execute('SELECT id FROM files WHERE id=?',(ident,)).fetchone():raise ValueError('첨부 요청 식별자가 중복되었습니다.')
                asset=dict(id=ident,name=name,size=len(raw),sha256=digest,mime=mime,owner=user['id'],createdAt=stamp())
                assets[ident]=asset;root['revision']+=1
                projects.Rooms.write(db,ROOT,root)
                db.execute('INSERT INTO files VALUES(?,?,?,?,?)',(ident,name,len(raw),digest,stamp()))
                db.execute('INSERT INTO file_access VALUES(?,?,?)',(ident,user['id'],'education:'+user['id']))
                with path.open('xb') as handle:created=True;handle.write(raw)
                if self.store.objects:self.store.objects.put('uploads',ident,raw)
                return dict(asset=copy.deepcopy(asset),rootRevision=root['revision'])
        except Exception:
            if created and path.is_file():path.unlink()
            raise

    def get_asset(self,user,ident):
        if not re.fullmatch('[a-f0-9]{32}',ident):raise FileNotFoundError()
        with self.store.connect() as db:
            user=self.identity(db,user);root=self.root(db)
            if not self.admitted(root,user):raise PermissionError('교육 참여 계정으로 로그인하세요.')
            asset=root.get('assets',{}).get(ident)
            if not asset:raise FileNotFoundError()
            attached=[t for t in root['tickets'] if ident in t.get('attachments',[]) or any(ident in m.get('attachments',[]) for m in t['messages'])]
            p=self.roles(root,user,user['id'])
            if attached:
                if not any(self.ticket_visible(t,user,p) for t in attached):raise PermissionError('이 문의의 첨부를 볼 권한이 없습니다.')
            elif any(ident in r.get('attachments',[]) for r in root.get('systemReviews',{}).values()):
                role=self.roles(root,user,user['id'])
                if not (role['admin'] or role['technical'] or role['content'] or any(user['id'] in (x['trainer'],x['assessor']) for x in root['learners'].values())): raise PermissionError('수정 요청 첨부를 볼 권한이 없습니다.')
            elif asset['owner']!=user['id']:raise PermissionError('작성 중인 첨부는 작성자만 확인할 수 있습니다.')
            binding=db.execute('SELECT task_id FROM file_access WHERE file_id=?',(ident,)).fetchone()
            if not binding or binding['task_id']!='education:'+asset['owner']:raise ValueError('첨부 연결을 확인하세요.')
        path=self.store.upload_file(ident)
        if path.stat().st_size!=asset['size'] or hashlib.sha256(path.read_bytes()).hexdigest()!=asset['sha256']:raise ValueError('첨부 파일 저장 내용을 확인하세요.')
        return path,asset['name'],asset['mime'].startswith('image/')

    def inquiry_assets(self,root,user,d):
        ids=d.get('attachments',[])
        if not isinstance(ids,list) or len(ids)>5 or any(not isinstance(i,str) for i in ids) or len(set(ids))!=len(ids):raise ValueError('첨부는 문의·답변당 최대 5개입니다.')
        assets=root.get('assets',{})
        if any(i not in assets or assets[i]['owner']!=user['id'] for i in ids):raise PermissionError('직접 올린 첨부만 연결할 수 있습니다.')
        images={i for i in ids if assets[i]['mime'].startswith('image/')}
        return ids,images

    def assignments(self, learner, enrolled):
        # Existing curriculum records are the assignments; a read never starts or completes practice.
        base=learner.get('startDate')
        available=[];waiting=[];upcoming=[];completed=[]
        for ident in STEPS:
            r=learner['records'][ident];p=learner['planDates'][ident]
            if r['status']=='done':completed.append(ident)
            elif r['status']=='review':waiting.append(ident)
            elif enrolled and base and (r['start'] or p['start']<=today()):available.append(ident)
            else:upcoming.append(ident)
        current=next((i for i in available if learner['records'][i]['status']=='practice'),None)
        current=current or next(iter(available),None)
        following=next(iter(sorted(upcoming,key=lambda i:(learner['planDates'][i]['start'],list(STEPS).index(i)))),None) if enrolled and base else None
        return dict(available=available,waiting=waiting,upcoming=upcoming,completed=completed,
                    next=current or following,nextAvailable=bool(current),
                    status='unassigned' if not enrolled else 'unscheduled' if not base else 'scheduled' if base>today() and not any(r['start'] for r in learner['records'].values()) else 'active',
                    total=len(STEPS))

    def update(self, user, v):
        if not isinstance(v,dict) or len(json.dumps(v).encode()) > 120000:
            raise ValueError('교육 요청 크기를 확인하세요.')
        if set(v)-{'action','target','revision','rootRevision','requestId','data'}:
            raise ValueError('허용되지 않은 교육 요청입니다.')
        action = projects.text(v.get('action'),60,True)
        target = projects.text(v.get('target'),64,True)
        rid = projects.text(v.get('requestId'),36,True)
        try: uuid.UUID(rid)
        except ValueError: raise ValueError('요청 식별자를 확인하세요.')
        data = v.get('data',{})
        if not isinstance(data,dict): raise ValueError('입력 내용을 확인하세요.')
        for field in ('step','item','test','question','ticket','learner','trainer','assessor','type','category','ref','operation','result'):
            if field in data:projects.text(data[field],200)
        digest = hashlib.sha256(json.dumps(v,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            user = self.identity(db,user)
            root = self.root(db)
            if not self.admitted(root,user) or not self.may_view(root,user,target):
                raise PermissionError('본인 또는 배정된 교육생만 변경할 수 있습니다.')
            old = next((r for r in root['requests'] if r['user']==user['id'] and r['id']==rid),None)
            if old:
                if old['digest']!=digest: raise ValueError('같은 요청 식별자에 다른 내용을 저장할 수 없습니다.')
                return self.context(db,root,user,target)
            root_action = action.startswith(('config.','ticket.','notification.','system.'))
            if type(v.get('rootRevision' if root_action else 'revision')) is not int:
                raise ValueError('서버 판본을 확인하세요.')
            if root_action and action!='notification.read' and v['rootRevision']!=root['revision']:
                raise projects.Conflict('교육 배정·문의 기록이 바뀌었습니다. 새로 불러온 뒤 다시 저장하세요.')
            p = self.roles(root,user,target)
            if action == 'notification.read':
                if set(data)!={'ids'} or not isinstance(data['ids'],list) or len(data['ids'])>200 or any(not isinstance(i,str) for i in data['ids']):
                    raise ValueError('읽을 알림 목록을 확인하세요.')
                visible={n['id'] for n in self.notices(db,root,user)}
                if any(i not in visible for i in data['ids']):
                    raise PermissionError('본인에게 보이는 알림만 읽음 처리할 수 있습니다.')
                readers=root.setdefault('noticeReads',{})
                readers[user['id']]=list(dict.fromkeys(readers.get(user['id'],[])+data['ids']))[-500:]
            elif action=='config.selfEnrol':
                self.self_enrol(db,root,user,data)
            elif action.startswith('config.'):
                if not p['admin']: raise PermissionError('교육 배정은 모모스 관리자만 변경합니다.')
                self.configure(db,root,user,action,data)
            elif action=='system.review':
                self.review_system(db,root,user,data)
            elif action.startswith('ticket.'):
                self.ticket(root,user,p,action,data)
            else:
                entry = root['learners'].get(target)
                if not entry: raise ValueError('관리자가 교육생·입사일·교육자를 먼저 배정해야 합니다.')
                learner = fit(projects.Rooms.read(db,entry['key']))
                if v['revision']!=learner['revision']:
                    raise projects.Conflict('다른 기기에서 교육 기록이 바뀌었습니다. 새로 불러온 뒤 다시 저장하세요.')
                self.education(db,root,user,p,learner,action,data)
                learner['revision']+=1
                label=ACTION_NAMES[action]
                if action in ('step.self','step.teacher'):
                    label+=' · '+('체크' if data['on'] else '체크 해제')+' · '+STEPS[data['step']]['checks'][data['index']]
                elif action=='step.retry':label+=' · '+data['reason']
                learner['events'].append(dict(person='A',date=today(),at=stamp(),id=data.get('step',data.get('item')),
                                             actor=user['name'],actorId=user['id'],text=label,action=action,attempt=learner['records'].get(data.get('step'),{}).get('attempt'),
                                             detail={k:copy.deepcopy(data[k]) for k in ('step','item','index','on','date','test','question','result','reason') if k in data},
                                             lessonVersion=COURSE['version'],sourceVersion=COURSE['sourceVersion']))
                projects.Rooms.write(db,entry['key'],learner)
            if action!='notification.read':root['revision']+=1
            if root_action:
                root['audit'].append(dict(at=stamp(),date=today(),actor=user['id'],name=user['name'],target=target,action=action,requestId=rid))
            root['requests'].append(dict(user=user['id'],id=rid,digest=digest))
            root['requests']=root['requests'][-2000:]
            projects.Rooms.write(db,ROOT,root)
            return self.context(db,root,user,target)

    def notices(self,db,root,user,users=None):
        """Recipient-specific feed derived from saved education records; GET is read-only."""
        if users is None:
            users={r['id']:dict(r) for r in db.execute("SELECT id,name FROM access_users WHERE status='active'").fetchall()}
        items=[]
        reads=set(root.get('noticeReads',{}).get(user['id'],[]))
        def add(key,title,detail,day_value,**location):
            ident=hashlib.sha256(key.encode()).hexdigest()[:32]
            items.append(dict(id=ident,title=title,detail=detail,date=day_value,read=ident in reads,**location))
        for target,entry in root['learners'].items():
            if target not in users:continue
            own=target==user['id'];trainer=entry['trainer']==user['id'] and not own
            assessor=entry['assessor']==user['id'] and not own
            if not (own or trainer or assessor):continue
            l=fit(projects.Rooms.read(db,entry['key']))
            name=users[target]['name']
            assigned=next((e for e in reversed(l['events']) if e.get('text')=='교육 배정·담당·입사일 확인'),None)
            if assigned:
                add('assign:'+target+':'+assigned['at'],name+' · 교육 배정',
                    '교육 시작 기준일과 담당자를 확인하세요.',assigned['date'],target=target,view='home')
            for ident,r in l['records'].items():
                title=STEPS[ident]['title'];attempt=str(r['attempt'])
                if trainer and r['status']=='review':
                    add('review:'+target+':'+ident+':'+attempt,name+' · '+title+' 확인 요청',
                        '항목별 실습 확인이 필요합니다.',r['request'],target=target,step=ident)
                if own and r['feedback']:
                    add('feedback:'+target+':'+ident+':'+attempt,title+' · 재실습 피드백',
                        r['feedback'],r['history'][-1].get('archived') if r['history'] else r['start'],target=target,step=ident)
                if own and r['status']=='done':
                    add('complete:'+target+':'+ident+':'+attempt,title+' · 멘토 확인 완료',
                        '확인 결과와 다음 실습을 살펴보세요.',r['done'],target=target,step=ident)
            if (own or assessor) and entry.get('startDate',entry['join']):
                for ident,t in TESTS.items():
                    attempts=l['tests'][ident]['attempts'];p=l['planDates']['test-'+ident]
                    days=(date.fromisoformat(p['start'])-date.fromisoformat(today())).days
                    if not any(a['result']=='pass' for a in attempts) and days<=7:
                        add('due:'+target+':'+ident+':'+p['start'],name+' · '+t['title']+(' 예정일 경과' if days<0 else ' 예정'),
                            '교육 담당자와 준비·응시 일정을 확인하세요.',p['start'],target=target,view='certification')
                    if own:
                        for a in attempts:
                            add('test:'+target+':'+ident+':'+str(a['attempt']),t['title']+' · 평가 결과',
                                {'pass':'통과 기록','retry':'보완·재시험','deferred':'평가 보류'}[a['result']],a['date'],target=target,view='certification')
            exam=l.get('exam')
            if trainer and exam and exam['status']=='submitted' and any(v['status']=='pending' for v in exam['results'].values()):
                add('quiz:'+target+':'+str(exam['attempt']),name+' · 서술 답안 검토 요청',
                    '제조 순서와 이유를 확인하세요.',exam['submitted'],target=target,view='trainer')
            if own and exam and exam['status']=='submitted':
                for ident,result in exam['results'].items():
                    if result.get('reviewerId'):
                        add('grade:'+target+':'+ident+':'+result['at'],'학습 퀴즈 · 멘토 검토 결과',
                            '판정과 피드백을 확인하세요.',result['date'],target=target,view='exam')
        for t in root['tickets']:
            own=t['person']==user['id'];handler=user['id'] in root[t['type']]
            if not (own or handler):continue
            if handler and not own and t['status'] in ('received','working','review'):
                add('ticket:'+t['id'],('기술' if t['type']=='technical' else '내용')+' 문의 접수',
                    '담당 문의를 확인하세요.',t['created'],target=user['id'],view='inquiries',ticket=t['id'],kind=t['type'])
            for m in t['messages']:
                if m['actorId']!=user['id']:
                    add('reply:'+t['id']+':'+m['at'],'1:1 문의 · 새 답변',
                        '문의 상세에서 답변을 확인하세요.',m['date'],target=user['id'],view='inquiries',ticket=t['id'],kind=t['type'])
        for doc in COURSE.get('materials',[]):
            add('material:'+doc['id']+':'+doc['hash'],'교육 참고자료 반영 · '+doc['title'],
                doc['status']+' · 반영일 '+doc['reflectedAt'],doc['reflectedAt'],target=user['id'],view='materials',material=doc['id'])
        return sorted(items,key=lambda n:(n.get('date') or '',n['id']),reverse=True)[:200]

    def self_enrol(self, db, root, user, d):
        """처음 들어온 교육생을 바로 등록한다: 입사일·교육 시작일 = 오늘, 담당자 미배정(관리자 누구나 확인)."""
        if d not in ({}, None): raise ValueError('자동 등록에는 입력 항목이 없습니다.')
        if user['company']!='momos': raise PermissionError('모모스 계정만 교육을 시작할 수 있습니다.')
        if user['id'] in root['learners']: return
        key=-int(uuid.uuid4().hex[:7],16)-10000
        while db.execute('SELECT 1 FROM metadata WHERE id=?',(key,)).fetchone():key-=1
        start=today()
        root['learners'][user['id']]=dict(key=key,join=start,startDate=start,trainer=None,assessor=None)
        learner=blank(start); learner['startDate']=start
        learner['events'].append(dict(person='A',date=start,at=stamp(),actor=user['name'],actorId=user['id'],id=None,
                                     text='교육 시작 (처음 접속한 날)',attempt=None,lessonVersion=COURSE['version'],sourceVersion=COURSE['sourceVersion']))
        projects.Rooms.write(db,key,learner)
        root['audit'].append(dict(at=stamp(),actor=user['id'],action='교육 자동 등록',learner=user['id'],previous=None,next=copy.deepcopy(root['learners'][user['id']])))

    def configure(self, db, root, user, action, d):
        active = {r['id']:dict(r) for r in db.execute("SELECT id,name,company FROM access_users WHERE status='active'").fetchall()}
        if action=='config.access':
            if set(d)!={'user','allowed','reason'} or d.get('user') not in active or type(d.get('allowed')) is not bool:
                raise ValueError('승인된 계정과 접근 여부를 확인하세요.')
            account=self.identity(db,{'id':d['user']})
            if self.admin(account): raise ValueError('온보딩 관리자의 접근은 차단할 수 없습니다.')
            reason=projects.text(d['reason'],1000,True)
            previous=copy.deepcopy(root.get('accessOverrides',{}).get(d['user']))
            root.setdefault('accessOverrides',{})[d['user']]=dict(allowed=d['allowed'],reason=reason,actor=user['id'],name=user['name'],at=stamp())
            root['audit'].append(dict(at=stamp(),actor=user['id'],action='온보딩 접근 권한',user=d['user'],previous=previous,next=copy.deepcopy(root['accessOverrides'][d['user']])))
            return
        if action=='config.support':
            if set(d)!={'technical','content'}: raise ValueError('문의 담당을 확인하세요.')
            previous={kind:root[kind][:] for kind in ('technical','content')}
            for kind in ('technical','content'):
                ids=d[kind]
                if not isinstance(ids,list) or len(ids)>30 or any(not isinstance(i,str) or i not in active for i in ids):
                    raise ValueError('승인된 문의 담당 계정을 선택하세요.')
                if kind=='content' and any(active[i]['company']!='momos' for i in ids):
                    raise ValueError('내용 검토 담당은 모모스 계정으로 지정하세요.')
                root[kind]=list(dict.fromkeys(ids))
            root['audit'].append(dict(at=stamp(),actor=user['id'],action='문의 담당 배정',previous=previous,next=copy.deepcopy(d)))
            return
        if action!='config.enrol' or set(d) not in ({'learner','trainer','assessor','join'}, {'learner','trainer','assessor','join','startDate'}):
            raise ValueError('교육 배정 항목을 확인하세요.')
        ident=d['learner']; join=day(d['join'])
        if ident not in active or active[ident]['company']!='momos' or join>today():
            raise ValueError('승인된 모모스 교육생과 실제 입사일을 선택하세요.')
        start_date=(day(d['startDate']) if d['startDate'] not in ('',None) else None) if 'startDate' in d else join
        if start_date and start_date<join:
            raise ValueError('교육 시작일은 입사일 이후로 지정하세요.')
        for k in ('trainer','assessor'):
            if d[k] not in active or d[k]==ident:
                raise ValueError('교육생과 다른 승인된 교육자·평가자를 지정하세요.')
        entry=root['learners'].get(ident)
        previous=copy.deepcopy(entry)
        if not entry:
            key=-int(uuid.uuid4().hex[:7],16)-10000
            while db.execute('SELECT 1 FROM metadata WHERE id=?',(key,)).fetchone():key-=1
            entry=root['learners'][ident]=dict(key=key,join=join,startDate=start_date,trainer=d['trainer'],assessor=d['assessor'])
            learner=blank(join)
            learner['startDate']=start_date
            if start_date:learner['planDates']=blank(start_date)['planDates']
        else:
            learner=fit(projects.Rooms.read(db,entry['key']))
            learner.setdefault('startDate',entry.get('startDate',learner['join']))
            if join!=learner['join']:
                self.join_change(learner,join,user,rebase=learner['startDate'] is None and start_date is None)
            if start_date!=learner['startDate']:
                self.start_change(learner,start_date,user)
            entry.update(join=join,startDate=start_date,trainer=d['trainer'],assessor=d['assessor'])
            learner['revision']+=1
        learner['events'].append(dict(person='A',date=today(),at=stamp(),actor=user['name'],actorId=user['id'],id=None,
                                     text='교육 배정·담당·입사일 확인',attempt=None,lessonVersion=COURSE['version'],sourceVersion=COURSE['sourceVersion']))
        projects.Rooms.write(db,entry['key'],learner)
        root['audit'].append(dict(at=stamp(),actor=user['id'],action='교육 배정',learner=ident,previous=previous,next=copy.deepcopy(entry)))

    def join_change(self,l,join,user,rebase=True):
        dates=self.actual_dates(l)
        if join>today() or dates and join>min(dates):
            raise ValueError('입사일은 실제 기록일 이후로 변경할 수 없습니다.')
        delta=(date.fromisoformat(join)-date.fromisoformat(l['join'])).days
        previous=copy.deepcopy(l['planDates'])
        for k,p in l['planDates'].items() if rebase else []:
            t=TESTS.get(k.removeprefix('test-')) if k.startswith('test-') else None
            if t and not p['edited']:p['start']=p['end']=plus(month(join,t['month']),-t['buffer'])
            else:p['start']=plus(p['start'],delta);p['end']=plus(p['end'],delta)
        l['planHistory'].append(dict(at=stamp(),actor=user['name'],oldJoin=l['join'],join=join,previous=previous,next=copy.deepcopy(l['planDates'])))
        l['join']=join

    def actual_dates(self,l):
        dates=[]
        for r in l['records'].values():
            for current in [r,*r.get('history',[])]:
                dates.extend(x for x in [current.get('start'),current.get('request'),current.get('done'),*current.get('selfAt',[]),*current.get('teacherAt',[])] if x)
        dates.extend(x['date'] for x in l['practiceLogs'])
        dates.extend(a['date'] for t in l['tests'].values() for a in t['attempts'])
        dates.extend(e['date'] for e in l['events'] if e.get('id'))
        for exam in [l['exam'],*l['examArchive']]:
            if exam and exam.get('submitted'):dates.append(exam['submitted'])
        return dates

    def start_change(self,l,start,user):
        dates=self.actual_dates(l)
        if dates and (not start or start>min(dates)):
            raise ValueError('교육 시작일은 실제 수행 이력보다 뒤로 옮기거나 지울 수 없습니다.')
        previous=copy.deepcopy(l['planDates'])
        before=l.get('startDate',l['join'])
        if start or before:
            base=before or l['join']
            anchor=start or l['join']
            delta=(date.fromisoformat(anchor)-date.fromisoformat(base)).days
            for k,p in l['planDates'].items():
                t=TESTS.get(k.removeprefix('test-')) if k.startswith('test-') else None
                if t and not p['edited']:p['start']=p['end']=plus(month(anchor,t['month']),-t['buffer'])
                else:p['start']=plus(p['start'],delta);p['end']=plus(p['end'],delta)
        l['planHistory'].append(dict(at=stamp(),actor=user['name'],oldStart=before,startDate=start,
                                    previous=previous,next=copy.deepcopy(l['planDates'])))
        l['startDate']=start

    def education(self,db,root,user,p,l,action,d):
        fields={'step.start':{'step'},'step.self':{'step','index','on'},'step.request':{'step'},
                'step.teacher':{'step','index','on'},'step.complete':{'step'},'step.retry':{'step','reason'},
                'step.memo':{'step','memo'},'schedule.reason':{'item','reason'},'plan.save':{'plans'},'plan.test':{'test','date'},
                'practice.add':{'step','date','condition','observation'},
                'test.record':{'test','date','result','criteria','feedback','confirmed'},
                'quiz.assign':set(),'quiz.retry':set(),'quiz.answers':{'answers'},'quiz.submit':{'answers'},
                'quiz.grade':{'question','result','feedback'}}
        if action not in fields or set(d)!=fields[action]:raise ValueError('교육 작업과 입력 항목을 확인하세요.')
        teacher=action in ('step.teacher','step.complete','plan.save','plan.test','quiz.grade')
        if action=='schedule.reason':
            permitted=p['own'] or (p['assessor'] if d['item'].startswith('test-') else p['trainer'])
            if not permitted:raise PermissionError('본인 또는 배정된 해당 교육 담당자만 지연 사유를 기록합니다.')
        if teacher and not p['trainer'] or action=='test.record' and not p['assessor']:
            raise PermissionError('배정된 교육자·평가자만 확인합니다. 자기 승인은 허용하지 않습니다.')
        if not teacher and action not in ('test.record','schedule.reason') and not (p['own'] or action=='step.retry' and p['trainer']):
            raise PermissionError('직원 실습·답안은 해당 직원만 기록합니다.')
        baseline=l.get('startDate',l['join'])
        if not baseline:
            raise ValueError('교육 시작일을 먼저 지정하세요. 과정은 미리 볼 수 있습니다.')
        ident=d.get('step');s=STEPS.get(ident);r=l['records'].get(ident)
        if action.startswith('step.') or action=='practice.add':
            if not s:raise ValueError('배정된 교육 단계를 선택하세요.')
        if action=='step.start':
            if r['status'] not in ('ready','practice'):raise ValueError('확인 요청·완료 단계는 재실습으로 시작하세요.')
            r['status']='practice';r['start']=r['start'] or today()
        elif action in ('step.self','step.teacher'):
            k='teacher' if action=='step.teacher' else 'self'
            if (k=='teacher' and r['status']!='review') or (k=='self' and r['status'] not in ('ready','practice')):
                raise ValueError('현재 단계 상태에서 이 체크를 변경할 수 없습니다.')
            i=d['index']
            if type(i) is not int or not 0<=i<len(s['checks']) or type(d['on']) is not bool:raise ValueError('체크 항목을 확인하세요.')
            r[k][i]=d['on'];r[k+'At'][i]=today() if d['on'] else None
            r.setdefault(k+'By',[None]*len(s['checks']))[i]=user['id'] if d['on'] else None
            if k=='self':r['status']='practice';r['start']=r['start'] or today()
        elif action=='step.request':
            if r['status']!='practice' or not all(r['self']):raise ValueError('직원 실습 체크를 모두 완료하세요.')
            r['status']='review';r['request']=today()
        elif action=='step.complete':
            if r['status']!='review' or not all(r['teacher']):raise ValueError('교육자가 실습 항목을 모두 확인하세요.')
            r['status']='done';r['done']=today();r['completedBy']=user['id']
        elif action=='step.memo':
            if r['status'] not in ('ready','practice'):raise ValueError('확인 요청·완료 후 메모는 보존합니다.')
            r['memo']=projects.text(d['memo'],4000)
        elif action=='step.retry':
            reason=projects.text(d['reason'],2000,True)
            history=copy.deepcopy(r['history']);old=copy.deepcopy(r);old.pop('history');old['archived']=today();old['archivedBy']=user['id'];history.append(old)
            new=blank(l['join'])['records'][ident];new.update(history=history,attempt=r['attempt']+1,feedback=reason)
            l['records'][ident]=new
        elif action=='schedule.reason':
            item=d['item']
            if item not in STEPS and item not in {'test-'+k for k in TESTS}:
                raise ValueError('교육 실습 또는 포지션 시험을 선택하세요.')
            plan=l['planDates'][item]
            if item in STEPS:
                current=l['records'][item]
                started,finished,attempt=current['start'],current['done'],current['attempt']
            else:
                attempts=l['tests'][item[5:]]['attempts']
                passed=sorted((a for a in attempts if a['result']=='pass'),key=lambda a:a['date'])
                last=passed[0] if passed else attempts[-1] if attempts else None
                started=finished=last['date'] if last else None
                attempt=last['attempt'] if last else None
            start_days=max(0,(date.fromisoformat(started)-date.fromisoformat(plan['start'])).days) if started else 0
            end_days=max(0,(date.fromisoformat(finished or today())-date.fromisoformat(plan['end'])).days)
            if not start_days and not end_days:raise ValueError('현재 계획보다 지연된 항목에 사유를 기록하세요.')
            reason=projects.text(d['reason'],2000,True)
            l.setdefault('delayNotes',[]).append(dict(item=item,reason=reason,at=stamp(),date=today(),
                actor=user['name'],actorId=user['id'],plan=copy.deepcopy(plan),start=started,end=finished,
                startDays=start_days,endDays=end_days,attempt=attempt))
        elif action=='plan.save':
            if not isinstance(d['plans'],dict) or set(d['plans'])!=set(STEPS):raise ValueError('전체 실습 계획을 확인하세요.')
            previous=copy.deepcopy(l['planDates'])
            for k,v in d['plans'].items():
                if not isinstance(v,dict) or set(v)!={'start','end'}:raise ValueError('예정일 항목을 확인하세요.')
                a,b=day(v['start']),day(v['end'])
                if a<baseline or a>b:raise ValueError('예정 시작·끝일은 교육 시작일 이후 순서대로 입력하세요.')
                l['planDates'][k]=dict(start=a,end=b,edited=True)
            l['planHistory'].append(dict(at=stamp(),actor=user['name'],previous=previous,next=copy.deepcopy(l['planDates'])))
        elif action=='plan.test':
            k=d['test'];a=day(d['date'])
            if k not in TESTS or a<baseline:raise ValueError('시험 종류·예정일을 확인하세요.')
            prev=l['planDates']['test-'+k]['start']
            l['tests'][k]['planHistory'].append(dict(previous=prev,next=a,changed=today(),actor=user['name'],at=stamp()))
            l['planDates']['test-'+k]=dict(start=a,end=a,edited=True)
        elif action=='practice.add':
            a=day(d['date'])
            if s['unit'] not in TESTS or not l['join']<=a<=today():raise ValueError('포지션 연습일은 입사일 이후 오늘까지 입력하세요.')
            l['practiceLogs'].append(dict(id=uuid.uuid4().hex,step=ident,date=a,condition=projects.text(d['condition'],1000,True),
                                         observation=projects.text(d['observation'],4000,True),attempt=r['attempt'],educationVersion=COURSE['version'],actor=user['name'],at=stamp()))
        elif action=='test.record':
            k=d['test'];a=day(d['date']);result=d['result']
            if k not in TESTS or not l['join']<=a<=today() or result not in ('pass','retry','deferred') or type(d['confirmed']) is not bool:
                raise ValueError('시험 종류·실제 평가일·판정을 확인하세요.')
            attempts=l['tests'][k]['attempts']
            if attempts and a<attempts[-1]['date']:raise ValueError('이전 시험 이후의 실제 시험일을 입력하세요.')
            if result=='pass' and not d['confirmed']:raise ValueError('현장 평가 기준을 확인한 통과 결과만 기록하세요.')
            attempts.append(dict(attempt=len(attempts)+1,date=a,result=result,criteria=projects.text(d['criteria'],2000,True),
                                 feedback=projects.text(d['feedback'],4000,True),confirmed=d['confirmed'],assessor=user['name'],assessorId=user['id'],
                                 educationVersion=COURSE['version'],sourceVersion=COURSE['sourceVersion'],at=stamp()))
        elif action in ('quiz.assign','quiz.retry'):
            if action=='quiz.retry':
                if not l['exam'] or l['exam']['status']!='submitted':raise ValueError('제출된 이전 답안을 보존한 뒤 재응시하세요.')
                l['examArchive'].append(copy.deepcopy(l['exam']));l['exam']=None
            if l['exam']:raise ValueError('이미 배정된 문제가 있습니다.')
            qs=[];previous=l['examArchive'][-1]['questions'] if l['examArchive'] else []
            # Distinct current variants where possible; random choices never change after assignment.
            others=[]
            for entry in root['learners'].values():
                if len(others)>200:break
                other=fit(projects.Rooms.read(db,entry['key']))
                if other and other['exam']:others.extend(other['exam']['questions'])
            for kind in ('choice','photo','match','order'):
                pool=[q for q in QUESTIONS.values() if q['type']==kind]
                avoid={q['id'] for q in previous+others}
                q=copy.deepcopy(secrets.choice([x for x in pool if x['id'] not in avoid] or pool))
                for field in ('options','items'):
                    if field in q:
                        a=q[field][:];secrets.SystemRandom().shuffle(a)
                        q['display' if field=='items' else field]=a
                if 'pairs' in q:
                    q['choices']=[p['right'] for p in q['pairs']];secrets.SystemRandom().shuffle(q['choices'])
                qs.append(q)
            l['exam']=dict(attempt=len(l['examArchive'])+1,date=today(),status='assigned',questions=qs,
                           answers={q['id']:dict(order=q['display'][:],reason='') if q['type']=='order' else ['']*len(q['pairs']) if q['type']=='match' else '' for q in qs},
                           results={},submitted=None)
        elif action in ('quiz.answers','quiz.submit'):
            t=l['exam']
            if not t or t['status']!='assigned':raise ValueError('답안 작성 중인 시험만 저장·제출합니다.')
            answers=d['answers']
            if not isinstance(answers,dict) or set(answers)!=set(t['answers']):raise ValueError('배정된 문제의 답안을 확인하세요.')
            for q in t['questions']:
                a=answers[q['id']]
                if q['type']=='order':
                    if not isinstance(a,dict) or set(a)!={'order','reason'} or not isinstance(a['order'],list) or not all(isinstance(x,str) for x in a['order']) or sorted(a['order'])!=sorted(q['items']):raise ValueError('음료 순서를 확인하세요.')
                    a['reason']=projects.text(a['reason'],4000,action=='quiz.submit')
                elif q['type']=='match':
                    if not isinstance(a,list) or len(a)!=len(q['pairs']) or any(x not in q['choices']+[''] for x in a):raise ValueError('연결 답안을 확인하세요.')
                    if action=='quiz.submit' and not all(a):raise ValueError('모든 연결 답안을 입력하세요.')
                elif not isinstance(a,str) or a not in q['options']+[''] or action=='quiz.submit' and not a:
                    raise ValueError('모든 선택 답안을 입력하세요.')
            t['answers']=copy.deepcopy(answers)
            if action=='quiz.submit':
                for q in t['questions']:
                    a=answers[q['id']]
                    correct=all(x['right']==a[i] for i,x in enumerate(q['pairs'])) if q['type']=='match' else a==q.get('answer')
                    t['results'][q['id']]=dict(status='pending' if q['type']=='order' else 'correct' if correct else 'incorrect',
                                              feedback=q.get('explain','교육자가 순서와 이유를 검토합니다. 미확정 제조 순서를 자동 채점하지 않습니다.'))
                t.update(status='submitted',submitted=today(),submittedAt=stamp())
        elif action=='quiz.grade':
            t=l['exam'];ident=d['question']
            if not t or t['status']!='submitted' or not any(q['id']==ident and q['type']=='order' for q in t['questions']) or d['result'] not in ('adequate','repractice'):
                raise ValueError('제출된 제조 순서 답안과 판단을 확인하세요.')
            t.setdefault('gradeHistory',[]).append(copy.deepcopy(t['results'][ident]))
            t['results'][ident]=dict(status=d['result'],feedback=projects.text(d['feedback'],4000,True),date=today(),at=stamp(),reviewer=user['name'],reviewerId=user['id'])

    def ticket(self,root,user,p,action,d):
        if action=='ticket.create':
            fields={'type','category','title','body','expected','proposal','step','ref'}
            if not fields.issubset(d) or set(d)-fields-{'visibility','bodyHtml','expectedHtml','attachments'} or d['type'] not in CATEGORIES or d['category'] not in CATEGORIES[d['type']]:raise ValueError('문의 종류·분류를 확인하세요.')
            s=STEPS.get(d['step']) if d['step'] else None
            if d['step'] and not s:raise ValueError('관련 교육 단계를 확인하세요.')
            ref=d['ref'] or (s['ref'] if s else '')
            if ref and ref not in COURSE['refs']:raise ValueError('관련 기준을 확인하세요.')
            visibility=d.get('visibility','private')
            if visibility not in ('private','shared'):raise ValueError('문의 공유 범위를 선택하세요.')
            ids,images=self.inquiry_assets(root,user,d)
            body_html,body_text,body_images=inquiry_rich(d.get('bodyHtml',''),images)
            expected_html,expected_text,_=inquiry_rich(d.get('expectedHtml',''),images)
            body=projects.text(body_text if d.get('bodyHtml') else d['body'],4000)
            if not body and not body_images:raise ValueError('상황 설명이나 사진을 넣어 주세요.')
            root['tickets'].append(dict(id=uuid.uuid4().hex,person=user['id'],author=user['name'],store='온천본점',
                type=d['type'],category=d['category'],title=projects.text(d['title'],120,True),body=body,bodyHtml=body_html,expectedHtml=expected_html,visibility=visibility,attachments=ids,
                expected=projects.text(expected_text if d.get('expectedHtml') else d['expected'],2000),proposal=projects.text(d['proposal'],2000),step=d['step'],ref=ref,
                sourceVersion=COURSE['sourceVersion'],sourceFile=COURSE['refs'].get(ref,{}).get('file',''),wikiHash=COURSE['wikiHash'],lessonVersion=COURSE['version'],
                created=today(),createdAt=stamp(),status='received',messages=[],decision=None,
                history=[dict(date=today(),at=stamp(),actor=user['name'],action='문의 접수')]))
            return
        t=next((x for x in root['tickets'] if x['id']==d.get('ticket')),None)
        if not t or not (t['person']==user['id'] or p[t['type']]):raise PermissionError('본인 문의 또는 배정된 종류의 문의만 열 수 있습니다.')
        if action=='ticket.reply' and {'ticket','text'}.issubset(d) and not set(d)-{'ticket','text','html','attachments'}:
            if t['status']=='closed':raise ValueError('종료된 문의에는 새 문의로 접수하세요.')
            ids,images=self.inquiry_assets(root,user,d)
            rich,text,image_ids=inquiry_rich(d.get('html',''),images)
            text=projects.text(text if d.get('html') else d['text'],4000)
            if not text and not image_ids and not ids:raise ValueError('답변 내용을 입력하세요.')
            t['messages'].append(dict(actor=user['name'],actorId=user['id'],date=today(),at=stamp(),text=text,html=rich,attachments=ids))
        elif action=='ticket.status' and set(d)=={'ticket','operation','reason'}:
            if not p[t['type']]:raise PermissionError('문의 종류별 담당만 처리 상태를 변경합니다.')
            op=d['operation'];reason=projects.text(d['reason'],2000,True)
            if op=='work' and t['status']=='received':t['status']='working' if t['type']=='technical' else 'review'
            elif op=='answer' and t['status'] in ('received','working','review') and any(m['actorId']!=t['person'] for m in t['messages']):t['status']='answered'
            elif op=='approve' and t['type']=='content' and t['status'] in ('review','answered') and t['proposal'] and p['content']:
                t['status']='approved';t['decision']=dict(actor=user['name'],date=today(),at=stamp(),reason=reason,status='정본 반영 미실행')
            elif op=='close' and t['status']=='answered':t['status']='closed'
            else:raise ValueError('현재 문의 상태에서 가능한 처리를 확인하세요.')
            t['history'].append(dict(actor=user['name'],actorId=user['id'],date=today(),at=stamp(),action=op,reason=reason))
        else:raise ValueError('문의 작업과 입력 항목을 확인하세요.')
