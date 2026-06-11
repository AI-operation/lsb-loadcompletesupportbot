# Phase 1 — 구조화 색인(의미검색) 셋업 가이드

목표: Slack 채널 전체를 색인(Postgres + Gemini 임베딩)해 "빠짐없이 + 뜻으로" 검색. 색인 미설정 시 봇은 기존 라이브 검색으로 정상 동작(안전).

## 새로 추가된 것
- `src/embed.js` Gemini 임베딩 호출
- `src/store.js` Postgres+pgvector 저장/검색 (DATABASE_URL+GEMINI 둘 다 있을 때만 활성)
- `src/sources/index_search.js` 색인 기반 검색(에이전트가 색인 활성 시 우선 사용)
- `scripts/backfill.js` 채널 전체 메시지+스레드 색인 (npm run backfill)
- 의존성: `pg`

## 셋업 순서
1. Render에서 PostgreSQL 생성 (Render 대시보드 → New → PostgreSQL, 무료/소액 티어). pgvector 확장은 코드가 자동 생성(CREATE EXTENSION vector). Render Postgres는 pgvector 지원.
2. 생성된 DB의 Internal Database URL을 복사 → 봇 서비스(Render Web Service) Environment에 `DATABASE_URL` 로 추가.
3. `GEMINI_API_KEY` 가 봇 서비스 Environment에 있는지 확인.
4. 변경 코드 push → Render 재배포 → 의존성(pg) 설치됨. 부팅 로그에 "색인: ON (Postgres, 0건)" 떠야 정상.
5. 백필 1회 실행:
   - 로컬에서: `DATABASE_URL=... GEMINI_API_KEY=... SLACK_BOT_TOKEN=... npm run backfill`
   - 또는 Render Shell(유료 플랜) / 일회성 Job 으로 `node scripts/backfill.js`
   - 끝나면 "백필 완료: 총 색인 N건" 출력.
6. 테스트: 채널에서 "실장님 언급 전부", 모호한 질문 등으로 검색 품질 확인.

## 운영
- 증분 갱신: `npm run backfill` 은 upsert라 반복 실행 안전. Render Cron Job(또는 스케줄)으로 매시간/매일 돌리면 색인이 최신 유지.
- 차원: 기본 1536 (pgvector hnsw 인덱스 한도 고려). 변경 시 재백필 필요.
- 비용: 백필 1회 임베딩 = 소액. 질문당 임베딩 1회(쿼리) = 거의 0.

## 검증 포인트(주의)
- Render Postgres SSL: store.js 에서 ssl rejectUnauthorized:false 로 연결.
- gemini 임베딩 REST 응답 형태(embedding.values)·taskType·outputDimensionality 는 실호출로 1회 확인 권장.
- hnsw 인덱스는 데이터가 쌓인 뒤 한 번 생성됨(에러 시 로그만, 검색은 인덱스 없이도 동작).
