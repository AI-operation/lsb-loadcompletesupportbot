# 경락이 (LSB) — Claude Code 인계 문서

> 이 문서 하나로 새 환경(Claude Code)에서 맥락 없이 이어 작업할 수 있게 정리한 자급식 핸드오프.
> 대상 독자: 코딩 에이전트 + 오너(박성훈). 작업 폴더 = 이 저장소 루트.

---

## 1. 경락이가 뭔가 (한 줄)

경영지원실(GA)의 사내 Slack 지식 에이전트. **지나간 보고·결정·문서가 어디 있는지 찾아주고, 그 맥락(언제·왜·누가, 이후 어떻게 바뀌었는지)까지 출처와 함께 설명**한다. 일반 대화도 가능.

- **한글명**: `@경락이` (경락 = 기운이 흐르는 통로 → "맥락" 추적과 의미가 통함)
- **영어명**: **LSB (Loadcomplete Support Bot)**
- **오너/구축**: 박성훈 (경영지원실 GA, Slack 워크스페이스 관리자 권한 보유, 봇 구축 경험 있음)
- **호출**: 채널에서 `@경락이` 멘션 또는 봇에게 DM
- **핵심 차별점**: 단순 검색이 아니라 **맥락 추적** — 결정의 시간축 전개를 엮어 설명.

---

## 2. 현재 상태 (이 저장소)

밑바닥부터 새로 짠 **v1 스캐폴드**. Node.js / CommonJS / Slack Bolt(HTTP·Events API 모드, ExpressReceiver) / Anthropic SDK. 배포는 **GitHub + Render Web Service**(오너 기존 워크플로와 동일).
**전 파일 `node --check` 통과.** 아직 실제 토큰으로 런타임 구동/E2E 테스트는 안 한 상태(= 다음 작업).

### 파일 구조
```
index.js               엔트리. Bolt(HTTP/ExpressReceiver, GET / 헬스), app_mention + DM(message.im) 핸들러,
                       로딩메시지 → 답변 chat.update, 스레드 맥락 수집
src/config.js          모든 환경변수 로딩·검증(assertReady), 화이트리스트 파싱
src/guardrails.js      채널/사용자 화이트리스트, PII·시크릿 마스킹, 시크릿요청 차단
src/agent.js           ★두뇌. Claude 에이전틱 루프 + 시스템 프롬프트.
                       도구: search_knowledge / read_source / web_search
src/format.js          맥락 타임라인(buildTimeline) + 출처 링크(buildSources)
src/sources/slack.js   Slack 검색(search.messages 우선, 없으면 history 폴백) + 스레드 읽기
src/sources/notion.js  Notion 검색 + 페이지 본문 읽기 (NOTION_TOKEN 있을 때만 활성)
src/sources/drive.js   Drive 검색 + 문서 export 읽기 (서비스계정 있을 때만 활성)
.env.example           환경변수 템플릿
render.yaml            Render Blueprint (Web Service)
README.md              사용자용 설명
HANDOFF.md             (이 문서)
```

### 데이터 흐름
1. `@경락이 작년 보안감사 보고서 어디 있었지?`
2. `agent.ask()` → Claude가 `search_knowledge` 호출 → `sources/*` 병렬 검색 → 시간순 후보(ref 포함) 반환
3. Claude가 `read_source(ref)`로 핵심 후보 본문 확인, 필요 시 `web_search`
4. Claude가 "처음 ○월 논의 → 이후 △월 변경" 맥락으로 답 작성, 시스템이 출처 링크를 하단에 자동 첨부

### 정규화된 검색 hit 스키마 (소스 공통)
```
{ id:"slack:<ch>:<ts>" | "notion:<pageId>" | "drive:<fileId>",
  source, title, snippet, url, timestamp(ISO), author, channel }
```
`read_source`는 id의 접두(slack/notion/drive)로 적절한 소스 모듈에 위임.

---

## 3. 확정된 결정 (P0)

| 항목 | 값 |
|---|---|
| 봇 형태 | 진짜 Slack 앱 `@경락이`, **HTTP/Events API 모드**. GitHub + Render Web Service 배포. Request URL = `https://<service>.onrender.com/slack/events` |
| 권한 모델 | **B (화이트리스트)** — `LSB_ALLOWED_CHANNELS` 채널만. 단, 모든 hit에 `permission_tag`를 달아 P5에서 모델 A(멤버십 추적) 졸업 대비 |
| 대상 채널 | `C028C2HTZNZ` (경영지원실, 1채널 dogfooding부터) |
| 데이터 소스 | Slack 메시지·스레드 + Slack 첨부(메타) + Notion + Google Drive |
| 스택 | Node.js, @slack/bolt, @anthropic-ai/sdk(model `claude-sonnet-4-6`), @notionhq/client, googleapis |
| 외부전송 | LLM(Anthropic)로 채널 내용 전송이 전제됨 → **민감채널 편입 전 보안 정책 확정 필요(폴백 담당: 경묵)**. 현재 1채널은 민감도 낮은 곳으로 한정 |

---

## 4. 실행 / 배포

### 로컬 (선택)
```bash
npm install
cp .env.example .env       # Windows: copy .env.example .env → 값 채우기
npm start                  # node index.js → http://localhost:3000
```

### 배포 (GitHub + Render) — 운영 경로
1. 저장소 GitHub push (`.gitignore`로 node_modules·.env 제외).
2. Render → New → **Web Service** (또는 Blueprint로 `render.yaml`). Build `npm install` / Start `node index.js` / Health `/`.
3. Render Environment에 시크릿 입력.
4. Slack Event Subscriptions → Request URL = `https://<service>.onrender.com/slack/events` → Verified.

### Slack 앱 설정 (관리자 권한으로 직접)
- **Event Subscriptions ON** → Request URL `…/slack/events`, bot events: `app_mention`, `message.im`
- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `channels:history`, `channels:read`, `groups:history`, `groups:read`, `im:history`, `users:read`, `files:read`
- (선택, 과거 검색 품질↑) **User Token Scope** `search:read` → `SLACK_USER_TOKEN`(xoxp-)
- 대상 채널에 `/invite @경락이`

### 필수 env
`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY` (없으면 부팅 시 `assertReady`가 에러).
선택: `SLACK_USER_TOKEN`, `NOTION_TOKEN`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `LSB_ALLOWED_USERS` 등 — `.env.example` 참고.
> Render 무료 Web Service는 유휴 시 슬립 → 첫 응답 지연 가능. 운영 시 유료 인스턴스나 keep-alive 핑 고려.

---

## 5. 다음 작업 (Claude Code가 이어서 할 것)

우선순위 순:

1. **런타임 E2E 검증** — `npm install` 후 실제 토큰으로 구동, `@경락이` 멘션 → 검색→읽기→답변 전체 경로 확인. (지금까진 정적 구문검사만 통과)
2. **소스 API 응답 형태 실측 보정** — `search.messages` / Notion search / Drive list의 실제 반환 필드를 찍어보고 `sources/*`의 매핑이 맞는지 확인(특히 `m.channel.id`, permalink 유무, Drive export mimeType 분기).
3. **에러·레이트리밋 견고화** — Slack 429 재시도 래퍼, Anthropic 호출 타임아웃/재시도, 부분 실패 시 graceful 응답.
4. **(차별점) 맥락 추적 고도화 — P4** — 현재는 `format.buildTimeline`로 시간순 나열까지. 결정/변경 "이벤트"를 추출해 연결하는 로직 추가(스레드/문서 간 참조 링킹).
5. **(검색 품질) 의미검색 — P2 업그레이드** — 현재 lexical + Claude 판단. 임베딩+벡터 스토어(예: pgvector/Chroma) 도입 자리 마련됨(소스 모듈 교체로 흡수 가능). 임베딩 공급자 결정 필요(Anthropic은 임베딩 API 없음 → Voyage 등).
6. **첨부파일 본문 추출** — Slack `files`/Drive 바이너리(PDF·한글·xlsx) 텍스트화 후 검색 대상에 포함(현재 메타데이터/링크까지).
7. **로깅·피드백·권한모델 A** — 질의/응답 로깅(PII 마스킹 적용), 👍/👎 수집, 멤버십 기반 권한 필터.

### 코드 컨벤션 / 주의
- CommonJS(`require`), `"use strict"`. ESM 아님(package.json `"type":"commonjs"`).
- 선택 소스(Notion/Drive)는 env 없으면 모듈이 빈 결과를 반환하도록 설계됨 → 미설정이어도 봇은 동작.
- 출처 링크는 `format.buildSources`가 답변 하단에 자동 첨부 → 시스템 프롬프트가 본문에서의 장황한 링크 나열을 금지함.
- 보안 가드는 **프롬프트(시스템 프롬프트)와 코드(guardrails.js) 이중**. 둘 다 유지할 것.
- 마운트 파일시스템에서 대용량 파일 쓰기가 가끔 잘림 → 쓰기 후 `wc -l`/파싱으로 무결성 확인 습관.

---

## 6. 참고 (이전 자산)
- 오너의 기존 운영 봇 `index.js`(help_me 지원봇)가 별도로 존재 — Bolt(HTTP)+Notion+Google Sheets corpus+Claude 에이전틱 루프+우산 대여 API. 경락이는 그 패턴을 참고해 **경영지원실 보고문서용으로 새로 설계**한 것(코드는 공유하지 않고 새로 작성). 필요 시 corpus 적재/백필 아이디어를 그 봇에서 차용 가능.
- 로드맵 원안(P0~P6)과 상세 권고는 동봉된 `LSB-구축계획서.md` 참조.

---
*v1 · 오너 박성훈(경영지원실 GA) · Cowork에서 작성 → Claude Code로 인계*
