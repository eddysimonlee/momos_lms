# 에이전트 작업 규칙

- 디자인 토큰은 wds를 따른다. 구현 전에 https://pages.navercorp.com/saas-product-design/wds/0.4.0/llms.txt 를 먼저 읽어라. 같은 내용이 `wds/llms.txt`에 vendor돼 있다.
- `wds/` 아래 파일은 받은 그대로 두고 편집하지 않는다. 버전을 바꿀 때는 CHANGELOG를 확인하고 `.wds/status.gen.json`을 함께 갱신한다.
- 1차 화면(`v1.html`·`v1.js`)은 WDS 토큰만 쓴다. 대응 토큰이 없는 값은 같은 줄에 `wds-allow: <사유>`를 남긴다.
- `/onboarding`(기존 전체 화면, `onboarding.*`·`styles.css`)은 원래 요구 사항의 비교·참고용이라 WDS 적용 대상이 아니다.

## 업무문서 반영 절차 (11/03 합의)

LMS 교육 내용의 근거는 드라이브 `공용 드라이브/SOP/ST_매장사업부/ST-002_온천본점/업무문서` 폴더뿐이다. 주기·자동 동기화는 하지 않는다.

1. **받는 것**: 이재현이 그 폴더의 스냅샷(폴더 전체·하위 폴더·개별 파일)과 함께 서버 `/api/works/docs-check` 결과(`docs_check.json`, 커밋하지 않음)를 준다. docs-check 가 없으면 반영 전에 요청한다.
2. **비교**: 같은 문서는 파일 이름 끝 날짜(YYMMDD)가 가장 최근인 판만 쓴다. docx 만 비교한다(이미지/·인포그래픽/ 제외). 일부만 받았으면 그 문서만 비교한다. 형식만 바뀐 절(표↔문단, 순서)은 내용 같음으로 본다.
3. **제안 → 승인 → 반영**: 교육 내용별 AS-IS/TO-BE 를 먼저 보여 주고, 승인 후에만 `v1_lessons.json` 을 고친다. 교육 내용은 지우지 않고 뒤에 추가한다(지우거나 옮길 때는 `onboarding.KP_MOVES` 로 체크 기록을 옮긴다).
4. **드라이브 링크(필수)**: 본문 보기의 '원본 파일' 링크는 `source_manifest.json` 의 `folderKey`(문서가 있는 폴더의 드라이브 fileId)로 만든다.
   - 반영할 때마다 docs-check 의 `folders`·`list` 로 근거 문서의 폴더·파일 이름과 `folderKey` 를 다시 맞춘다. 문서가 다른 폴더로 옮겨졌거나 새 폴더가 생기면 반드시 갱신한다.
   - `v1_build.py` 는 근거 문서마다 manifest 항목·`folderKey` 가 있고 폴더·파일 이름이 맞는지 검사하고, 어긋나면 멈춘다. 검사를 끄지 않는다.
   - docs-check 의 `links` 는 키가 가리키는 실제 폴더 안에 링크 글자의 파일 이름이 실제로 있는지까지 본다. `links.summary` 가 "링크 정상 n / 없어진 폴더 0 / …" 가 아니면 그 결과로 바로 고친다(반영 사이 VOC 예방).
   - 링크 주소: PC `https://drive.worksmobile.com/drive/web/share/folder?resourceKey=<folderKey>&resourceLocation=24101`, 모바일 `worksdrive://folder?version=1&resourceLocation=24101&driveType=SHARE_DRIVE&fileId=<folderKey>`(철자 `resourceLocation`). 파일 fileId 로 파일을 바로 여는 웹 주소는 없다.
5. **기록**: `source_log.json` 에 받은 것 1건 = 기록 1건(받은 것·폴더·드라이브 기준 시각·범위·문서별 상태·바뀐 교육 AS-IS/TO-BE·근거에서 뺀 문서·링크 갱신)을 남기고, `source_manifest.json` 의 문서별 기준을 갱신한다. 문서 상태 이름: 바뀌어 교육 반영 / 새 문서로 교육 반영 / 바뀌었지만 교육 영향 없음 / 바뀐 것 없음 / 근거에서 뺌.
6. **확인 후 커밋**: `python3 v1_build.py` → 테스트(`*_test.py`) → `python3 v1_preview.py` 미리보기를 보여 주고 승인 후 커밋한다. 배포는 이재현이 push 한다(`github` = Render, `origin` = 사내 OSS).
