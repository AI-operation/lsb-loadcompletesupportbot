# 경락이 (LSB · Loadcomplete Support Bot)

경영지원실 Slack 지식 에이전트. 지나간 보고·결정·문서가 **어디 있는지** 찾아주고, 그 **맥락**(언제·왜·누가, 이후 변화)까지 출처와 함께 짚어준다. 일반 대화도 가능.

`@경락이` 멘션 또는 DM으로 호출. **HTTP/Events API 모드** — GitHub + Render Web Service로 배포.

## 구조

```
index.js              엔트리. Bolt(Socket Mode), 멘션/DM 핸들러, 로딩→답변 갱신
src/config.js         환경변수 로딩·검증
src/guardrails.js     채널/사용자 화이트리스트, PII 마스킹, 시크릿 차단
src/agent.js          Claude 에이전틱 루프 + 시스템 프롬프트 (두뇌)
src/format.js         맥락 타임라인 + 출처 링크 정리
src/sources/slack.js  Slack 검색(search.messages/history) + 스레드 읽기
src/sources/notion.js Notion 검색 + 페이지 읽기 (선택)
src/sources/drive.js  Drive 검색 + 문서 읽기 (선택)
```

## 동작 흐름

1. `@경락이 작년 보안감사 보고서 어디 있었지?`
2. 에이전트가 `search_knowledge`로 Slack·Notion·Drive를 병렬 검색 → 시간순 후보
3. 핵심 후보를 `read_source`로 본문 확인, 필요 시 `web_search` 보완
4. "처음 ○월에 논의 → 이후 △월 변경" 식 맥락 + 출처 링크로 답변

## 로컬 실행 (선택)

```bash
npm install
cp .env.example .env      # 값 채우기 (Windows: copy)
npm start                 # node index.js → http://localhost:3000
```

## 배포 (GitHub + Render)

1. 이 폴더를 GitHub 저장소로 push (`.gitignore`가 `node_modules`·`.env` 제외).
2. Render → New → **Web Service** (또는 Blueprint로 `render.yaml` 읽기).
   - Build: `npm install` / Start: `node index.js` / Health Check Path: `/`
3. Render **Environment**에 시크릿 입력: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY` (+ 선택값).
4. 배포되면 URL `https://<service>.onrender.com` 확인.
5. Slack **Event Subscriptions → Request URL**에 `https://<service>.onrender.com/slack/events` 입력 → `Verified` 확인.

## Slack 앱 설정

- **Event Subscriptions ON** → Request URL = `https://<service>.onrender.com/slack/events`
  - Subscribe to bot events: `app_mention`, `message.im`
- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `users:read`, `files:read`
- (선택) 과거 메시지 검색: **User Token Scope** `search:read` → `SLACK_USER_TOKEN`
- 대상 채널에 `/invite @경락이`

## 권한·보안 (경영지원실 = 민감 영역)

- 권한모델 **B(화이트리스트)**: `LSB_ALLOWED_CHANNELS`의 채널만 검색·답변.
- 모든 검색 결과에 `permission_tag` 부착 → P5에서 권한모델 A(멤버십 추적) 졸업 대비.
- 비밀번호·토큰·주민번호·계좌 등은 안내 거부(프롬프트+코드 이중 가드), 로그엔 PII 마스킹.

## 로드맵상 위치 / 다음

- 현재: P1~P3을 단일 봇에 통합한 v1 (검색·읽기·근거형 답변·기초 맥락).
- v2 업그레이드 지점: **임베딩/벡터 의미검색**(현재 lexical+Claude 판단), **맥락 추적 고도화**(결정 이벤트 그래프), 첨부파일 본문 추출, 권한모델 A.
