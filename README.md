# Momos 온보딩 LMS

모모스커피 온천본점 신규 입사자 온보딩을 위한 LMS입니다. 교육 과정 배정, 항목별 진행·본인 확인·교육자 확인, 포지션 평가 기록, 퀴즈, 문의·수정 요청, 업무 가이드(위키) 열람을 제공합니다.

이 저장소는 `kdy8968-cell/momos-workspace`(main, 2026-10-11 스냅샷)에서 온보딩 부분만 옮겨 왔습니다. ERP·PI 기능은 가져오지 않았습니다.

## 저장소 운영

- 원본: 사내 GitHub `open.oss.navercorp.com/jaehyun-eddy-lee/momos_lms`
- 외부 협업용 사본: github.com 비공개 저장소 (`mirror` 원격, 필요할 때 연결)
- 변경은 브랜치와 PR로 올리고, 리뷰 후 `main`에 합칩니다.
- 실제 직원 데이터, DB 파일, 비밀값(DB 비밀번호·API 키·토큰)은 커밋하지 않습니다. `.gitignore`가 `data/`, `*.sqlite3`, `.env*`를 막습니다.

## 로컬 실행

Python 3.10 이상, 외부 패키지 없이 실행됩니다.

```bash
ERP_BOOTSTRAP_TOKEN=<32자 이상 임의 문자열> python3 server.py --data-dir ./data --port 8768
```

브라우저에서 `http://127.0.0.1:8768/onboarding`을 열고, 최초 관리자를 만들 때 위 토큰을 입력합니다. 관리자 계정은 `access.py`의 `ADMINS` 목록에 있는 이름만 만들 수 있습니다(2주차에 WORKS 로그인으로 바꿀 예정).

### 체험용 계정으로 바로 보기

```bash
python3 dev_seed.py --data-dir ./data
python3 server.py --data-dir ./data
```

`dev_seed.py`가 관리자·교육자·교육생 체험 계정을 만들고 교육생을 배정합니다. 계정이 이미 있는 폴더에서는 실행되지 않습니다.

## 테스트

```bash
python3 -B -m unittest onboarding_test workspace_items_test manual_wiki_test auth_http_test
node onboarding_failure_test.cjs
node workspace_items_test.cjs
```

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `server.py` | HTTP 서버. 온보딩·계정·위키 라우트만 제공 |
| `lms_store.py` | JSON 기록 저장(`metadata` 행), 입력 검증, 사진 검증 |
| `onboarding.py` | 교육 상태·완료 조건·권한, 문의, 평가, 수정 요청 |
| `onboarding.js`, `onboarding.html` | 교육 화면. `onboarding.html`에 교재(U01~U50) 스냅샷 포함 |
| `onboarding_course.json` | 단원·교육 항목·확인 문구·평가·문제은행 |
| `onboarding_reviews.json` | 수정 요청(시스템 판단) 초기 정의 |
| `access.py`, `auth.js`, `invitations.py` | 계정, 세션, CSRF, 초대 |
| `workspace_items.py`, `workspace_items.js` | 교육 항목별 댓글·진행 장애 |
| `manual_wiki.py` | 업무 가이드(위키) 스냅샷 제공 |
| `cloud.py`, `deploy/` | 클라우드(Supabase) 연결과 DB 스키마 |

## 아직 남은 정리

- `cloud.py`와 `deploy/001_workspace.sql`은 기존 ERP 스키마 기준입니다. 2주차에 새 Supabase 프로젝트를 만들면서 LMS 테이블만 남깁니다.
- `access.py`에는 ERP 업무 권한 함수가 남아 있습니다. WORKS 로그인을 붙일 때 함께 정리합니다.
- `onboarding.js`의 로컬 체험 모드, 관리자 이름·매장명 하드코딩은 1주차 남은 작업입니다.
