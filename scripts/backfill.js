#!/usr/bin/env node
"use strict";
/** CLI 백필: npm run backfill (DATABASE_URL + GEMINI_API_KEY + SLACK_BOT_TOKEN 필요) */
require("dotenv").config();
const { runBackfill } = require("../src/indexer");

(async () => {
  console.log("백필 시작...");
  const r = await runBackfill((n) => console.log(`  ...${n}건 처리`));
  if (r.already) { console.log("이미 실행 중"); process.exit(0); }
  console.log(`백필 완료: 총 색인 ${r.total}건 (이번 ${r.processed}건 처리)`);
  process.exit(0);
})().catch((e) => { console.error("백필 실패:", e && (e.stack || e.message || e)); process.exit(1); });
