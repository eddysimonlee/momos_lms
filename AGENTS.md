# 에이전트 작업 규칙

- 디자인 토큰은 wds를 따른다. 구현 전에 https://pages.navercorp.com/saas-product-design/wds/0.4.0/llms.txt 를 먼저 읽어라. 같은 내용이 `wds/llms.txt`에 vendor돼 있다.
- `wds/` 아래 파일은 받은 그대로 두고 편집하지 않는다. 버전을 바꿀 때는 CHANGELOG를 확인하고 `.wds/status.gen.json`을 함께 갱신한다.
- 1차 화면(`v1.html`·`v1.js`)은 WDS 토큰만 쓴다. 대응 토큰이 없는 값은 같은 줄에 `wds-allow: <사유>`를 남긴다.
- `/onboarding`(기존 전체 화면, `onboarding.*`·`styles.css`)은 원래 요구 사항의 비교·참고용이라 WDS 적용 대상이 아니다.
