"""Item-scoped collaboration; existing metadata, no operational status changes."""
import copy
import hashlib
import json
import uuid
import access
import projects

ROOT = 2026100601
FORMAT = 'momos-item-collaboration-v1'


class Service:
    def __init__(self, store):
        self.store = store

    def authorize(self, db, user, target):
        if not isinstance(target, dict) or set(target) != {'room', 'kind', 'id', 'person'}:
            raise ValueError('항목 연결을 확인해 주세요.')
        target = {k: projects.text(v, 100, k != 'person') for k, v in target.items()}
        account = db.execute("SELECT id,name,role,company,status FROM access_users WHERE id=?", (user['id'],)).fetchone()
        if not account or account['status'] != 'active':
            raise access.LoginRequired()
        user = dict(account)
        active = [dict(r) for r in db.execute("SELECT id,name,role,company,status FROM access_users WHERE status='active'")]
        room, kind, ident = target['room'], target['kind'], target['id']
        if room == 'onboarding':
            import onboarding as ob
            service = ob.Service(self.store)
            root = service.root(db)
            person = target['person']
            if not person or not service.admitted(root, user) or not service.may_view(root, user, person):
                raise PermissionError('이 교육 기록을 볼 권한이 없습니다.')
            entry = root['learners'].get(person)
            roles = service.roles(root, user, person)
            if kind == 'step':
                item = ob.STEPS.get(ident)
            elif kind == 'test':
                item = next((t for t in ob.COURSE['tests'] if t['id'] == ident), None)
            else:
                item = None
            if not item:
                raise FileNotFoundError()
            writable = bool(entry and any(roles[k] for k in ('own', 'trainer', 'assessor', 'admin')))
            choices = [a for a in active if entry and service.admitted(root, a) and
                       (a['id'] in (person, entry['trainer'], entry['assessor']) or service.admin(a))]
        else:
            if target['person']:
                raise ValueError('프로젝트 항목에는 교육생 연결을 사용하지 않습니다.')
            rooms = projects.Rooms(self.store)
            directory = rooms.directory(db)
            project = rooms.find(directory, room, user)
            role = project['members'][user['id']]
            if room == 'erp':
                if kind != 'task':
                    raise FileNotFoundError()
                row = db.execute('SELECT body FROM state WHERE id=1').fetchone()
                state = json.loads(row[0]) if row and row[0] else {}
                effective = dict(user, role='viewer' if role == 'viewer' else 'lead' if role != 'owner' and user['role'] == 'admin' else user['role'])
                state.setdefault('people', [])
                for a in active:
                    state['people'] = [p for p in state['people'] if p.get('name') != a['name']]
                    state['people'].append(dict(name=a['name'], role=a['role'], org=access.company_name(a['company']), active=True, confirmed=True))
                item = next((i for i in access.regular_visible_items(state, effective) if i['id'] == ident), None)
                if not item:
                    raise FileNotFoundError()
                writable = role != 'viewer' and access.may_perform(item, effective, state)
                choices = []
                for a in active:
                    r = project['members'].get(a['id'])
                    identity = dict(a, role='lead' if r != 'owner' and a['role'] == 'admin' else a['role'])
                    if r and r != 'viewer' and access.may_perform(item, identity, state):
                        choices.append(a)
            else:
                data = rooms.read(db, project['storageId'])
                field = 'tasks' if kind == 'task' else 'piCases' if kind == 'case' and project['kind'] == 'pi' else ''
                item = next((i for i in (data or {}).get(field, []) if i['id'] == ident), None)
                if not item:
                    raise FileNotFoundError()
                writable = role != 'viewer'
                choices = [a for a in active if project['members'].get(a['id']) in ('owner', 'editor')]
        return target, user, writable, [dict(id=a['id'], name=a['name']) for a in choices], item.get('title', ident)

    def summary(self, user, room, person=''):
        # Authorize the scope even when no collaboration record exists yet.
        with self.store.connect() as db:
            account = db.execute("SELECT * FROM access_users WHERE id=? AND status='active'", (user['id'],)).fetchone()
            if not account:
                raise access.LoginRequired()
            user = dict(account)
            if room == 'onboarding':
                import onboarding
                service = onboarding.Service(self.store)
                root = service.root(db)
                if not service.admitted(root, user) or not service.may_view(root, user, person):
                    raise PermissionError()
            else:
                rooms = projects.Rooms(self.store)
                rooms.find(rooms.directory(db), room, user)
            root = projects.Rooms.read(db, ROOT)
            if root is None:
                return dict(items=[])
            if root.get('format') != FORMAT:
                raise ValueError('협업 저장 영역을 확인하세요.')
            items = []
            for key, value in root['items'].items():
                target = json.loads(key)
                if target['room'] != room or target['person'] != person or not value.get('blocker'):
                    continue
                try:
                    _, _, _, _, title = self.authorize(db, user, target)
                except (PermissionError, FileNotFoundError):
                    continue
                items.append(dict(target=target, title=title, blocker=copy.deepcopy(value['blocker'])))
            return dict(items=items)

    def context(self, user, target, value=None):
        with self.store.connect() as db:
            if value is not None:
                db.execute('BEGIN IMMEDIATE')
            target, user, writable, choices, _ = self.authorize(db, user, target)
            key = json.dumps(target, sort_keys=True, ensure_ascii=False)
            root = projects.Rooms.read(db, ROOT)
            if root is None:
                root = dict(format=FORMAT, items={})
            if root.get('format') != FORMAT:
                raise ValueError('협업 저장 영역을 운영자가 확인해야 합니다.')
            item = root['items'].get(key, dict(revision=0, comments=[], blocker=None, history=[], receipts=[]))

            def result():
                return dict(target=target, canWrite=writable, people=choices,
                            acceptedRequests=[r['id'] for r in item['receipts'] if r['user'] == user['id']],
                            **copy.deepcopy({k: item[k] for k in ('revision', 'comments', 'blocker', 'history')}))

            if value is None:
                return result()
            if not writable:
                raise PermissionError('이 항목에 협업 기록을 남길 권한이 없습니다.')
            if not isinstance(value, dict) or set(value) - {'target', 'action', 'revision', 'requestId', 'text', 'resolver'}:
                raise ValueError('협업 입력 항목을 확인해 주세요.')
            action = value.get('action')
            if action not in ('comment', 'block', 'resolve'):
                raise ValueError('협업 작업을 확인해 주세요.')
            request_id = str(uuid.UUID(projects.text(value.get('requestId'), 36, True)))
            digest = hashlib.sha256(json.dumps({k: v for k, v in value.items() if k not in ('revision', 'requestId')},
                                             sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            receipt = next((r for r in item['receipts'] if r['id'] == request_id), None)
            if receipt:
                if receipt['user'] != user['id'] or receipt['digest'] != digest:
                    raise projects.Conflict('이미 사용한 저장 요청 번호입니다.')
                return result()
            if type(value.get('revision')) is not int or value['revision'] != item['revision']:
                raise projects.Conflict('협업 기록이 변경되었습니다. 최신 기록을 확인한 뒤 작성 내용을 저장하세요.')
            text = projects.text(value.get('text', ''), 4000, True)
            at = projects.stamp()
            event = dict(action=action, text=text, actor=user['name'], actorId=user['id'], at=at)
            if action == 'comment':
                if len(item['comments']) >= 300:
                    raise ValueError('이 항목의 협업 기록이 300개에 도달했습니다. 운영자에게 문의하세요.')
                item['comments'].append(dict(id=uuid.uuid4().hex, **event))
            elif action == 'block':
                resolver = projects.text(value.get('resolver', ''), 100)
                if resolver not in {p['id'] for p in choices}:
                    raise ValueError('이 항목에 참여 가능한 해결 담당자를 선택하세요.')
                item['blocker'] = dict(reason=text, resolver=resolver,
                                       resolverName=next(p['name'] for p in choices if p['id'] == resolver),
                                       actor=user['name'], at=at)
                event['resolver'] = resolver
            else:
                if not item['blocker']:
                    raise ValueError('해결할 진행 장애가 없습니다.')
                event['before'] = copy.deepcopy(item['blocker'])
                item['blocker'] = None
            if len(item['history']) >= 600:
                raise ValueError('이 항목의 변경 이력이 한도에 도달했습니다. 운영자에게 문의하세요.')
            item['history'].append(event)
            item['revision'] += 1
            item['receipts'].append(dict(id=request_id, user=user['id'], digest=digest))
            # Keep every event. Receipts have the same bounded lifetime as events.
            root['items'][key] = item
            projects.Rooms.write(db, ROOT, root)
            return result()
