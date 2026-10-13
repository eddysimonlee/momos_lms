# MOMOS ERP 클라우드 배포 준비

2026-09-10 · 승인된 Supabase 이전·전체 대조 완료. Render 첫 Linux 빌드·배포 성공, 공개 로그인 화면·비로그인 접근 차단 검증 완료. 공개 URL: https://momos-workspace.onrender.com

## 이번에 준비한 구조

직원 PC·모바일 브라우저 → Render Python 앱 → Supabase PostgreSQL / 비공개 Storage.

기존 가입 승인·아이디·비밀번호 해시·권한 로직은 유지하고, 해당 기록의 저장 위치를 SQLite에서 PostgreSQL로 옮긴다. **이번 단계는 Supabase Auth 로그인 전환이 아니다.** Supabase Auth 화면에서 설정한 가입·비밀번호 정책은 현재 앱 로그인에 적용되지 않는다. 앱의 `access.py` 정책과 관리자 승인이 적용된다.

- `cloud.py`: 클라우드 전용 실행, PostgreSQL 연결, 파일 저장·검증·백업. 로컬 실행 방식은 그대로 유지.
- `001_workspace.sql`: 빈 프로젝트에 `erp_workspace` 스키마, 테이블 20개, 앱 전용 DB 계정 `erp_app`을 생성한 SQL. 명시적 승인 후 실행하고 테이블 20개·RLS 20개를 확인했다. 기존 테이블 삭제·변경은 없다.
- 모든 업무 테이블에 RLS를 적용하고 `anon`·`authenticated`의 접근을 차단. 직원별 접근 권한은 Python 앱이 검사하며, DB에는 앱 계정만 접속한다.
- `cloud_migrate.py`: 로컬 원본은 읽기 전용으로 묶고, 검토한 묶음의 SHA-256과 대상 프로젝트를 확인한 뒤 빈 DB에만 복사. 기존 대상 업무가 있으면 중단.
- `Dockerfile`: Python 3.12 + Node 24, 비관리자 프로세스. 앱 소스·로고·폰트만 복사하고 운영 DB·원문·seed·비밀값은 제외.

## 승인 및 적용 기록

1. GitHub Codex Connector (완료): `kdy8968-cell/momos-workspace` 한 저장소만 허용. 설치 화면의 권한은 code·Actions·issues·PR·workflows 읽기/쓰기, checks·commit statuses·metadata 읽기, 계정 이메일 읽기. 구체적 권한 범위 확인 후 사용자 동의로 2026-09-10 설치 완료. 선택한 저장소 한 곳의 접근 권한을 검증했다.
2. Supabase `momos-workspace` (`opmykazfbdtephqhyeuk`)에 전용 스키마·계정·비공개 버킷 생성 완료. 사용자의 구체적 승인 후 파일 478개 / 834,538,300 bytes / 업무 버전 24 / 기존 계정과 이력을 복사했다. 20개 테이블 전체 기록이 원본과 일치하며 표본 7개 파일 SHA-256 일치, 버킷 전체 파일 수·용량 일치를 확인했다. 로컬 원본은 보존했다.
3. 누락 원문 판본 16개는 사용자에게 알리고 승인받았다. 업무·검토 이력은 유지되지만 해당 과거 파일은 내려받지 못한다.
4. Render에 DB 접속 정보와 service_role 키 등 환경변수 여섯 개 저장은 구체적 승인 후 수행했고 값 일치를 확인했다. 승인된 월 USD25 서버를 생성했다. 메일·정기 앱 알림은 비활성화 상태다.

## 적용 순서

1. 사용자 승인 후 Supabase SQL Editor에서 `001_workspace.sql`을 한 번 실행. 새 스키마·역할과 충돌하면 자동 재시도·DROP을 하지 않는다.
2. `erp_app`의 충분히 긴 임의 비밀번호를 서버 비밀 설정에서 지정한다. 비밀번호를 소스·문서·대화에 기재하지 않는다. 관리자 `postgres` 계정으로 앱을 실행하지 않는다.
3. Storage에 `momos-workspace-private` 버킷 생성. Public은 끔. 버킷 최대 파일 크기 50 MiB 이상(현재 이전 파일 최대 약 47.7 MB). 공개 다운로드 정책은 만들지 않는다. 백업은 32 MiB 조각으로 저장하고 다운로드 시 해시 검증 후 ZIP으로 합친다.
4. Connect → Session pooler(5432)의 실제 호스트를 확인. 사용자 이름은 `erp_app.opmykazfbdtephqhyeuk`. 비밀번호 특수문자는 연결 URI에 넣을 때 퍼센트 인코딩한다. 저장소 비밀 키는 서버에만 둔다.
5. 검토한 로컬 이전 묶음을 적용한다. 전체 앱 데이터와 보존된 원문을 복사하며, 활성 로그인 세션·일회용 복구 링크·임시 엑셀 미리보기는 이전하지 않는다. 기존 비밀번호로 다시 로그인한다. 대기 초대 링크는 만료 처리하고 대기 메일은 자동 재발송하지 않는다.
6. 코드만 GitHub에 올리고 Render 설정·비밀값 입력. 아래 설정으로 Deploy를 실행한다.
7. 실제 공개 주소에서 HTTPS 로그인, 가입 승인, 권한별 자료 노출, WBS 상태·엑셀 변경, 첨부 재다운로드, 서버 재배포 후 데이터 보존을 검증한다. 시험 데이터는 별도 계정·업무로 구분하고 운영 내용을 임의 변경하지 않는다.
8. 사용 중인 로컬 버전과 클라우드 버전을 동시에 수정하지 않도록 전환 시점을 안내한다. 이전 후 로컬 쓰기는 클라우드에 자동 합쳐지지 않는다.

## Render 설정

| 항목 | 값과 이유 |
|---|---|
| Name / Branch | momos-workspace / main |
| Runtime | Docker |
| Region | Singapore, 현재 선택 유지 |
| Compute | 1c-2g: 1 CPU / 2 GB, 월 USD 25 선택 |
| Root Directory | 공란. 앱 파일이 GitHub 저장소 루트에 올라간다는 전제 |
| Dockerfile Path | `./Dockerfile` |
| Build Context | `.` |
| Health Check | `/api/health`, 실제 DB 읽기도 검사 |
| Auto-Deploy | Off. 코드 변경만으로 운영이 바뀌지 않도록 수동 배포 |
| Disk | 추가하지 않음. 영구 데이터는 Supabase, Render 파일은 임시 캐시 |
| Docker Command / Pre-Deploy | 공란. 시작 시 DB 구조를 자동 변경하지 않음 |

| 환경변수 | 서버에 입력할 값 |
|---|---|
| `ERP_DATABASE_URL` | 같은 Supabase 프로젝트의 `erp_app` Session pooler 연결 URI. 비밀값 |
| `SUPABASE_URL` | `https://opmykazfbdtephqhyeuk.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | 해당 프로젝트의 서버 전용 service_role 키. 공개 키를 대신 넣지 않음 |
| `ERP_STORAGE_BUCKET` | `momos-workspace-private` |
| `ERP_ENABLE_EMAIL` | 최초 `0`. SMTP·수신자 검증과 발송 승인 후 별도 활성화 |
| `ERP_ENABLE_APP_REMINDERS` | 최초 `0`. 기존 알림함은 조회 가능, 정기 생성은 별도 활성화 |

`PORT`, `RENDER_EXTERNAL_URL`은 Render 제공값을 읽는다. 별도 도메인을 연결하기 전에는 `ERP_PUBLIC_URL`을 입력하지 않는다. 도메인이 바뀌면 실제 HTTPS 원점 주소로 설정해야 Host·Origin 검사와 링크가 일치한다. `ERP_BOOTSTRAP_TOKEN`은 기존 관리자 계정을 이전하므로 불필요하다.

## 검증과 남은 한계

- 기존 SQLite 회귀 시험 99개 통과.
- PGlite PostgreSQL 엔진 + psycopg로 클라우드 시험 15개 통과. 가입 승인, 기존 비밀번호 로그인, 권한·CSRF·Secure 쿠키, 변경 충돌 방지, 엑셀 WBS 반영, 첨부 해시·불변성, 분할 백업, 시험 데이터 이전·대상 덮어쓰기 거부 포함.
- PGlite는 한 PostgreSQL 세션을 공유하므로 `SET LOCAL ROLE erp_app`으로 권한을 검사했다. 실제 Supabase TLS·Session pooler·erp_app 로그인·비공개 버킷 검증은 완료했다. 다중 사용자 부하는 미검증이다. Supabase pooler의 extra_float_digits=0으로 숫자 출력이 반올림되는 것을 확인하여 각 연결에서 3으로 설정했다. 저장된 이중 정밀도 값은 원본과 일치했고 보정 후 20개 테이블 전체 값 대조가 통과했다.
- Render의 Python 3.12 / Node 24 Linux 이미지 빌드와 첫 서비스 시작을 실제 확인했다. /api/health는 cloud/supabase/ok, 로그인 화면·manifest는 정상, 비로그인 업무·원문·seed 요청은 401, 서버 소스 요청은 404다. 실제 관리자 로그인·권한별 브라우저 작업·모바일·부하·재배포 후 파일 다운로드·실제 복구는 미검증이다.
- 현재 이전 묶음: 업무 버전 24, 계정 1개, 보존 파일 478개 약 834 MB, 과거 원문 판본 누락 16개. 묶음과 검증 로그는 프로젝트의 `보존관리/실행기록/20260910_클라우드배포준비`에 있고 GitHub 대상에서 제외한다.
- Google Drive API 자동 수집, 새 OCR·음성 처리, 외부 이메일·모바일 푸시는 연결 완료로 표시하지 않는다. 이전한 판본 다운로드와 앱 파일 등록은 별개로 지원한다.
- 클라우드 백업은 DB·등록 첨부·보존 원문의 독립 ZIP이며 2 GB 상한이 있다. 전체 원천 폴더·앱 비밀 설정은 포함하지 않는다. 자동 복구나 기존 운영 덮어쓰기 명령은 제공하지 않는다.

## 운영 경계와 비용

Render 실행용 월 USD 25와 Supabase Pro 기본 월 USD 25를 별도 업체에서 결제하는 계획이다. 사용량·세금·추가 프로젝트에 따라 달라질 수 있다. 사용자 승인 후 Render 1c-2g 서비스 srv-dah7clp5efls738bmjsg를 생성했다. Render 관리 플랜은 Hobby USD0이며 서버 사용료와 별개다. 별도 디스크·유료 추가 옵션은 생성하지 않았다. 정확한 청구 시작일과 실제 청구액은 각 Billing에서 최종 확인한다.

Windows 서비스·예약 작업·시작 프로그램·레지스트리·방화벽 변경 없음. 클라우드 실행은 `python -m cloud`, 기존 PC 실행은 `server.py`의 127.0.0.1 방식 그대로다. 승인된 클라우드 자료 복사와 서버 생성 외에 메일·외부 알림·실제 주문/정산 처리는 수행하지 않았다.

공식 참고: [Render Web Services](https://render.com/docs/web-services), [Health checks의 Host 기준](https://render.com/docs/health-checks), [Supabase DB 연결](https://supabase.com/docs/guides/database/connecting-to-postgres), [Pooler 사용자 이름](https://supabase.com/docs/guides/troubleshooting/tenant-or-user-not-found).

실제 관리 화면: https://dashboard.render.com/web/srv-dah7clp5efls738bmjsg · 최초 배포는 2026-09-10 18:22 KST Live. 실제 직원 이용 주소는 https://momos-workspace.onrender.com 이며, Supabase API URL과 구분한다.

## 가입 신청 알림 메일 (2026-09-11)

가입 신청과 관리자별 발송 대기 기록을 같은 트랜잭션으로 저장한다. 새 테이블이나 마이그레이션은 필요하지 않다. 수신자는 이용 중인 모모스커피 관리자 고성운·최상민의 등록 이메일이다. 신청 중이거나 정지된 관리자 계정에는 보내지 않는다. 이전에 접수한 신청을 임의로 소급 발송하지 않는다.

- `ERP_ENABLE_SIGNUP_EMAIL=1`: 가입 알림만 활성화한다. 미설정 또는 `0`이면 대기 기록만 보존한다.
- `ERP_SMTP_HOST`, `ERP_SMTP_PORT`(보통 587 또는 465), `ERP_SMTP_FROM`: 발신 서비스의 서버·포트·발신 주소.
- `ERP_SMTP_USER`, `ERP_SMTP_PASSWORD`: 발신 서비스가 제공한 SMTP 인증 정보. Render Environment에만 입력하고 코드·문서·채팅에 기록하지 않는다. 587은 STARTTLS, 465는 TLS를 사용한다.
- 직원이 사용하는 HTTPS 주소는 Render의 `RENDER_EXTERNAL_URL`에서 연결된다. 메일의 ‘가입 신청 확인하기’는 로그인 후 가입 승인 화면을 열고, 승인 자체는 수행하지 않는다.
- 기존 `ERP_ENABLE_EMAIL=0`은 유지할 수 있다. 이 경우 업무 요청·리마인드·초대 메일은 활성화되지 않는다.

관리자의 ‘가입 승인·권한 관리 → 가입 신청 이메일 알림’에서 연결 상태, 실제 수신 관리자, 대기·발송·실패 기록을 확인한다. 전송 전 이미 승인·거절된 신청 또는 관리자 계정이 변경된 안내는 취소한다. 전송 결과가 불확실하면 자동으로 다시 보내지 않는다. 설정이 꺼져 있는 동안 접수한 대기 건은 활성화 후에도 신청이 미처리인 경우에만 발송한다.

현재 발신 계정 연결 정보는 미입력이다. 기능 배포와 실제 메일 수신 검증은 구분한다. 이번 개발 검증의 메일은 모의 전송했으며, 실제 직원에게 발송하지 않았다.
