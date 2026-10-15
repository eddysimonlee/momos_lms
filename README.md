# Momos 온보딩 LMS

모모스커피 온천본점 신규 입사자 온보딩을 위한 LMS입니다. 교육 과정 배정, 항목별 진행·본인 확인·교육자 확인, 포지션 평가 기록, 퀴즈, 문의·수정 요청, 업무 가이드(위키) 열람을 제공합니다.

이 저장소는 `kdy8968-cell/momos-workspace`(main, 2026-10-11 스냅샷)에서 온보딩 부분만 옮겨 왔습니다. ERP·PI 기능은 가져오지 않았습니다.

## 저장소 운영

- 원본: 사내 GitHub `open.oss.navercorp.com/jaehyun-eddy-lee/momos_lms`
- 외부 협업용 사본: github.com 비공개 저장소 (`mirror` 원격, 필요할 때 연결)
- 변경은 브랜치와 PR로 올리고, 리뷰 후 `main`에 합칩니다.
- 실제 직원 데이터, DB 파일, 비밀값(DB 비밀번호·API 키·토큰)은 커밋하지 않습니다. `.gitignore`가 `data/`, `*.sqlite3`, `.env*`를 막습니다.

## 1차 출시 화면 (release/v1)

`/v1`이 첫 화면입니다. 교육 과정 중 **입사·근무 준비** 단원(6항목)만 보여 줍니다. 역할은 둘입니다. **교육생**은 교재를 읽고 체크·메모한 뒤 확인을 요청하고, **담당자**(매장 관리자)는 교육생을 배정하고 체크를 확인합니다. 배정한 사람이 그 교육생의 확인 담당자가 되며, 기록에는 누가 확인했는지 이름이 남습니다. 휴대폰 화면 기준으로 만들었습니다.

- 파일: `v1.html`(화면·스타일), `v1.js`(동작), `v1_content.json`(교재 조각), `v1_build.py`(조각 생성기)
- 디자인 토큰은 WDS 0.4.0을 따릅니다. `wds/web/variables.css`를 받은 그대로 두고(vendor) `v1.html`이 import하며, 규칙은 `wds/llms.txt`와 `AGENTS.md`에 있습니다. 채택 마커는 `.wds/status.gen.json`입니다. 정적 분석을 붙일 때는 `**/wds/**`를 제외하세요.
- 기록은 기존 `/api/onboarding`에 그대로 저장되므로 `/onboarding`(전체 화면)과 같은 데이터를 봅니다.
- 범위를 넓히려면 `v1_build.py`의 `UNITS`에 단원 id를 추가하고 `python3 v1_build.py`를 실행합니다.
- 교육생 배정은 `/v1`의 담당자 홈에서 합니다. 계정 승인은 아직 `/onboarding?view=account`(기존 화면)에서 합니다. `/onboarding`은 원래 요구 사항 전체를 담은 비교·참고용 화면으로 남겨 둡니다.
- 로컬 체험 중에는 로그인 화면 없이 바로 체험 교육생으로 들어가고, `/v1` 위쪽의 **역할 전환** 띠로 담당자와 교육생 계정을 오갑니다. 로컬 sqlite 저장소에, 같은 컴퓨터에서 접속할 때, `@local.test` 계정에만 동작하고 그 밖에서는 띠도 API도 없습니다.

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

`dev_seed.py`가 담당자 1명과 교육생 2명(한 명은 배정됨, 한 명은 미배정)을 만듭니다. 계정이 이미 있는 폴더에서는 실행되지 않습니다.

## 서버에 올리기 (n3r)

컨테이너 하나에 sqlite 파일로 동작합니다. 외부 DB가 없으니 **Stateful 앱, replicas 1**, 영구 볼륨(CephRBD)을 `/data`에 마운트합니다. 볼륨은 앱 생성 뒤 추가할 수 없으니 처음 만들 때 넣습니다.

| 항목 | 값 |
| --- | --- |
| 빌드 | 저장소 루트 `Dockerfile` (python:3.12-slim) |
| 포트 | 8080 (`PORT`로 변경 가능) |
| 볼륨 | `/data` — 교육 기록·계정 sqlite가 여기 쌓임. 백업 대상 |
| 환경변수 | `LMS_PUBLIC_URL=https://<인그레스 호스트>` (필수, 끝에 `/` 없이). Host·Origin 검사와 보안 쿠키가 이 값을 기준으로 동작 |
| 헬스체크 | `GET /api/health` |
| 사내 스테이징 | `LMS_TRIAL=1` — 빈 저장소에 체험 계정 3개를 만들고 역할 전환 띠를 켭니다. **사내망 전용 서버에서만** 씁니다 |
| 외부 공개 서버 | `LMS_TRIAL`을 넣지 않고 `ERP_BOOTSTRAP_TOKEN`(32자 이상)으로 `/onboarding`에서 최초 관리자 등록 |

n3r은 사내 테스트용입니다(사내망 전용, 보안검수 없음). 모모스 직원이 쓰는 외부 서버는 Render에 따로 올립니다. 같은 Dockerfile을 쓰되 `LMS_TRIAL`은 넣지 않습니다.

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
- 관리자 이름·매장명 하드코딩은 WORKS 로그인 작업(2주차)에서 바꿉니다.
