# 에이전트 작업 규칙

- 디자인 토큰은 wds를 따른다. 구현 전에 https://pages.navercorp.com/saas-product-design/wds/0.4.0/llms.txt 를 먼저 읽어라. 같은 내용이 `wds/llms.txt`에 vendor돼 있다.
- `wds/` 아래 파일은 받은 그대로 두고 편집하지 않는다. 버전을 바꿀 때는 CHANGELOG를 확인하고 `.wds/status.gen.json`을 함께 갱신한다.
- 1차 화면(`v1.html`·`v1.js`)은 WDS 토큰만 쓴다. 대응 토큰이 없는 값은 같은 줄에 `wds-allow: <사유>`를 남긴다.
- `/onboarding`(기존 전체 화면, `onboarding.*`·`styles.css`)은 원래 요구 사항의 비교·참고용이라 WDS 적용 대상이 아니다.

## 업무문서 반영 절차 (11/03 합의)

LMS 교육 내용의 근거는 드라이브 `공용 드라이브/SOP/ST_매장사업부` 폴더 아래 문서다(11/04부터. 매장사업부 공통 + ST-002_온천본점/업무문서 …). `source_manifest.json` 의 folder 는 이 폴더 아래 경로이고, 다른 매장 폴더·아카이브의 같은 이름 사본은 근거로 쓰지 않는다. 연결된 작업 폴더: Mac `Downloads/ST_매장사업부`. 주기·자동 동기화는 하지 않는다.

1. **받는 것**: 이재현이 그 폴더의 스냅샷(폴더 전체·하위 폴더·개별 파일)과 함께 서버 `/api/works/docs-check` 결과(`docs_check.json`, 커밋하지 않음)를 준다. docs-check 가 없으면 반영 전에 요청한다.
2. **비교**: 같은 문서는 파일 이름 끝 날짜(YYMMDD)가 가장 최근인 판만 쓴다. docx 만 비교한다(이미지/·인포그래픽/ 제외). 일부만 받았으면 그 문서만 비교한다. 형식만 바뀐 절(표↔문단, 순서)은 내용 같음으로 본다.
3. **제안 → 승인 → 반영**: 교육 내용별 AS-IS/TO-BE 를 먼저 보여 주고, 승인 후에만 `v1_lessons.json` 을 고친다. 교육 내용은 지우지 않고 뒤에 추가한다(지우거나 옮길 때는 `onboarding.KP_MOVES` 로 체크 기록을 옮긴다).
   - **문서 `id` 는 바꾸지 않는다**: `source_manifest.json` 의 문서 `id` 는 파일 이름(판 날짜·접두어)이 바뀌어도 처음 정한 그대로 둔다. 수정 요청 티켓의 '(id: …)'와 교육 인용이 이 id 로 문서를 찾는다. `source_parse.py --base` 는 색인의 문서 id 를 manifest 에서 가져온다(11/09 이재현 결정).
4. **드라이브 링크(필수)**: 본문 보기의 '원본 파일' 링크는 `source_manifest.json` 의 `folderKey`(문서가 있는 폴더의 드라이브 fileId)로 만든다.
   - 반영할 때마다 docs-check 의 `folders`·`list` 로 근거 문서의 폴더·파일 이름과 `folderKey` 를 다시 맞춘다. 문서가 다른 폴더로 옮겨졌거나 새 폴더가 생기면 반드시 갱신한다.
   - `v1_build.py` 는 근거 문서마다 manifest 항목·`folderKey` 가 있고 폴더·파일 이름이 맞는지 검사하고, 어긋나면 멈춘다. 검사를 끄지 않는다.
   - docs-check 의 `links` 는 키가 가리키는 실제 폴더 안에 링크 글자의 파일 이름이 실제로 있는지까지 본다. `links.summary` 가 "링크 정상 n / 없어진 폴더 0 / …" 가 아니면 그 결과로 바로 고친다(반영 사이 VOC 예방).
   - 링크 주소: PC `https://drive.worksmobile.com/drive/web/share/folder?resourceKey=<folderKey>&resourceLocation=24101`, 모바일 `worksdrive://folder?version=1&resourceLocation=24101&driveType=SHARE_DRIVE&fileId=<folderKey>`(철자 `resourceLocation`). 파일 fileId 로 파일을 바로 여는 웹 주소는 없다.
5. **기록**: `source_log.json` 에 받은 것 1건 = 기록 1건(받은 것·폴더·드라이브 기준 시각·범위·문서별 상태·바뀐 교육 AS-IS/TO-BE·근거에서 뺀 문서·링크 갱신)을 남기고, `source_manifest.json` 의 문서별 기준을 갱신한다. 문서 상태 이름: 바뀌어 교육 반영 / 새 문서로 교육 반영 / 바뀌었지만 교육 영향 없음 / 바뀐 것 없음 / 근거에서 뺌.
6. **확인 후 커밋**: `python3 v1_build.py` → 테스트(`*_test.py`) → `python3 v1_preview.py` 미리보기를 보여 주고 승인 후 커밋한다. 배포는 이재현이 push 한다(`github` = Render, `origin` = 사내 OSS).

## 콘텐츠 수정 요청 처리 (11/03)

역할: 모모스커피 담당자 = 콘텐츠 기획(무엇을 바꿀지 정한다), 이재현(NAVER WORKS) = 서비스 기획(화면·기능).

1. 모모스 담당자(LMS관리자 admin)가 `/v1/graph` 에서 교육이나 원본 문서를 눌러 '수정 요청'을 보낸다. 종류: 문구 수정 · 문구 삭제 · 교육 내용 추가 · 사진 교체 · 원본 매핑 변경 · 원본 문서 변경 확인 · 기타. AS-IS 는 화면에서 자동으로 채워진다.
2. 처리 세션은 LMS관리자 › 수정 요청의 '텍스트로 복사'(티켓 1건 또는 지금 목록) 내용, 또는 `/api/content-requests?open=1` 결과(`content_requests.json`, 커밋하지 않음)를 받아 요청마다 반영안을 보여 주고 승인 후 `v1_lessons.json` 등을 고친다.
3. **지금 화면 틀 안의 수정만** 반영한다. 사진은 그 교육이 인용하는 원본 문서의 사진만, 매핑은 원본 문서의 절로만. 화면 구조·기능·디자인을 바꿔야 하는 요청(기타 포함)은 고치지 않고 '서비스 기획 확인 필요'로 이재현에게 넘긴다.
4. '원본 문서 변경 확인'은 위 '업무문서 반영 절차'로 처리한다(스냅샷·docs-check 필요).
5. 요청에는 티켓 번호(`REQ-n`, 서버가 차례로 매기고 다시 쓰지 않음)가 있다. 반영하면 `source_log.json` 에 기록 1건을 남긴다: `basis.kind` = '수정 요청', **`tickets` = 반영한 티켓 번호 목록**, 바뀐 교육 AS-IS/TO-BE(항목에 티켓 번호 표기). LMS관리자 화면에서 티켓 ↔ 반영 기록이 이 `tickets` 로 서로 이어진다. 커밋 후 LMS관리자 › 수정 요청에서 커밋 번호와 함께 '반영됨'으로 바꾼다(반려는 사유 필수, 반려한 요청만 삭제 가능).
   - 원본 문서 반영(업무문서 반영 절차)이 수정 요청에서 시작됐으면 그 기록에도 `tickets` 를 넣는다.

## 작업 방식(11/04, 이재현 요청)

수정 요청을 받으면 → **실제 LMS 화면 미리보기(v1_preview.html)를 오른쪽 패널에 띄운다** → 승인하면 커밋한다. 비교용 Word·HTML 보고서나 받은 docx 를 다시 내보내지 않는다(받은 파일은 연결된 업무문서 폴더에만 둔다).

## 알파 환경 작업 (11/05, 이재현 결정)

채수민 님(모모스커피)은 알파(테스트 서비스, https://momos-lms-alpha.onrender.com)에서 ChatGPT Codex(로컬)로 LMS 를 직접 고쳐 본다. 수정 요청 티켓 없이, 서비스를 둘러보며 본인 판단으로 바로 작업한다. 실서비스에는 채수민 님이 반영을 요청한 작업만 이재현이 가져간다.

- **브랜치**: `alpha` = 테스트 서비스(Render 알파 서비스·알파 전용 DB, push 하면 자동 배포). `release/v1` = 실서비스(이재현만 바꿀 수 있음, GitHub Ruleset). 작업은 항상 최신 `alpha` 를 받아(`git pull`) 시작하고, 끝나면 `alpha` 에 **작업 1건 = 커밋 1개**로 커밋한다. **push 는 하지 않는다** — 채수민 님이 직접 `git push origin alpha` 로 배포한다. 커밋 후 커밋 번호와 push 명령을 알려 준다. `release/v1` 로 push 하지 않는다.
- **요청한 것만 바꾼다**: 애매하면 바꾸기 전에 묻는다. 한 작업에 한 가지만 — 나중에 골라서 실서비스에 반영할 수 있게.
- **반영 기록**: 알파 작업도 `source_log.json` 에 기록 1건을 남긴다. `basis.kind` = '알파 작업', `tickets` = 빈 목록(티켓 없음), `approvedBy` = 채수민 님, 무엇을 왜 바꿨는지와 AS-IS/TO-BE. 교육 내용 칸 삭제·순서 변경·문항 교체가 있으면 `checks` 에 적는다(실서비스 체크 기록에 영향).
- **DB 는 따라가지 않는다**: 서버마다 자기 DB 를 본다(Render 환경변수). 레포로 넘어가는 것은 교육 콘텐츠·교육과정·문서-콘텐츠 매핑·반영 기록·사진뿐이다.
- **고칠 수 있는 파일**: 교육 콘텐츠(`v1_lessons.json` · `curriculum.json` · `source_manifest.json` · `source_log.json`)와 빌드 결과(`v1_content.json` · `v1_photos/`).
- **화면 코드(`v1.js` · `v1.html` · `v1_graph.html`)**: 알파에서는 고쳐도 된다(11/06 이재현 결정).
  - **기존 UI 재활용**: 이미 있는 클래스·버튼·카드·목록과 WDS 토큰만으로 만드는 변경(예: 기존 버튼 스타일로 '이전 항목' 추가)은 일반 작업과 같다.
  - **새 UI 요소**: 새 컴포넌트·새 화면 구조·새 클래스 체계·WDS 에 없는 값을 만들면 알파에 적용하되, 반영 기록 `rules` 에 '새 UI 요소 — 이재현 검수 필요'를 적고 채수민 님께도 알린다. 실서비스 반영은 이재현 검수 후.
  - 테스트는 추가할 수 있다. 기존 테스트를 고치면 이유를 반영 기록에 적는다.
- **서비스(서버) 코드(`server.py` · `onboarding.py` · `works_auth.py` · `cloud.py` 등)**: 알파에서는 고쳐도 된다(11/06 이재현 결정). 기능·API 를 바꾸면 테스트(`*_test.py` · `*.cjs`)를 모두 돌리고, 반영 기록 `rules` 에 '서비스 코드 변경 — 이재현 검수 필요'와 무엇이 바뀌는지를 적는다. 실서비스 반영은 이재현 검수 후.
  - 특히 조심할 것(바꾸면 반영 기록에 따로 적는다): DB 구조·저장 형식(알파 DB 는 따로지만, 실서비스에 넘어가면 실 DB 에 적용된다), 로그인·권한(`works_auth.py` · `access.py`), 기존 교육 기록·체크를 읽는 방식.
- **고치지 않는 것**: `Dockerfile`, `deploy/`, Render·Supabase·WORKS 설정과 환경변수. 비밀번호·키·토큰은 코드·파일·대화에 넣지 않는다. 필요하면 이재현에게 넘긴다.
- **원본 색인**: `source_index.json`·`source_images/` 는 레포에 없다. 작업 PC 에 받은 드라이브 `ST_매장사업부` 폴더로 만든다.
  `python3 source_parse.py --base <ST_매장사업부 폴더> --images source_images`
  `source_manifest.json` 의 문서만 읽고 순서·시각도 manifest 로 정하므로, 같은 원본이면 누구나 같은 색인·같은 `v1_content.json` 이 나온다. '기준과 내용이 다름'이 나오면 원본이 바뀐 것이다 — 작업 전에 채수민 님에게 알리고 업무문서 반영 절차로 처리한다(반영하면 manifest 의 sha1·updated 갱신).
- **원본이 바뀐 경우(알파)**: 채수민 님이 바뀐 docx 를 주거나 PC 의 `ST_매장사업부` 폴더를 새로 받았다고 하면, 업무문서 반영 절차(비교 → AS-IS/TO-BE 확인 → 반영 → 기록)대로 처리한다. 문서가 **같은 폴더 안에서** 바뀐 것(같은 이름 내용 변경, 파일 이름 끝 날짜만 바뀐 새 판)이면 docs-check 없이 반영한다 — 폴더가 같으니 `folderKey` 는 그대로 두고 manifest 의 file·sha1·revised·updated 만 고친다. 문서 `id` 는 파일 이름이 바뀌어도 바꾸지 않는다(수정 요청 티켓·반영 기록이 이 id 로 문서를 가리킨다). 받은 docx 는 PC 의 `ST_매장사업부` 같은 경로에 넣는다. 다른 폴더로 옮겨졌거나 새 폴더에 생긴 문서는 `folderKey` 가 필요하므로 반영하지 않고 이재현에게 넘긴다. 드라이브에서 빠진 문서·사진은 PC 에서 지우지 않아도 되며, 채수민 님이 쓰지 말라고 하면 교육 인용과 manifest 에서 뺀다.
- **확인**: `python3 v1_build.py` → 테스트(`*_test.py`) → `python3 v1_preview.py` 로 만든 `v1_preview.html` 을 브라우저로 연다. 채수민 님은 주로 알파 주소에서 결과를 보므로, 바꾼 교육의 번호·제목과 어디서 보면 되는지를 쉬운 말로 알려 준다.
- **실서비스 반영(이재현)**: 채수민 님이 요청한 알파 커밋만 `release/v1` 로 cherry-pick 한다. `v1_content.json` 충돌은 손으로 풀지 않고 `python3 v1_build.py` 를 다시 돌린다. 반영 기록에 실서비스 티켓이 있으면 `tickets` 에 넣는다.
- **실서비스를 먼저 고친 경우(이재현)**: `release/v1` 커밋 뒤 바로 `release/v1 → alpha` 를 합친다. 충돌 처리는 위와 같다.
