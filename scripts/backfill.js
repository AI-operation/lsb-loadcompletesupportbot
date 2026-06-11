#!/usr/bin/env node
"use strict";
/**
 * 백필 — 허용 채널의 모든 메시지+스레드를 수집해 임베딩 후 색인(Postgres)에 적재.
 * 반복 실행해도 안전(upsert). 증분 갱신용으로 cron/스케줄에서 주기 실행 권장.
 *
 * 실행:  npm run backfill   (DATABASE_URL + GEMINI_API_KEY + SLACK_BOT_TOKEN 필요)
 */
require("dotenv").config();
const { config } = require("../src/config");
const store = require("../src/store");
const { embedDoc } = require("../src/embed");
const { bot, userName, resolveMentions } = require("../src/sources/slack");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mentionIds(text) {
  return [...new Set([...(text || "").matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]))];
}
function tsToDate(ts) {
  const n = parseFloat(ts);
  return Number.isNaN(n) ? new Date() : new Date(n * 1000);
}
async function permalink(channel, ts) {
  try {
    const r = await bot.chat.getPermalink({ channel, message_ts: ts });
    return r.permalink || "";
  } catch {
    return "";
  }
}

async function* allRootMessages(channel) {
  let cursor;
  do {
    const r = await bot.conversations.history({ channel, limit: 200, cursor });
    for (const m of r.messages || []) yield m;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    await sleep(1200);
  } while (cursor);
}
async function* threadReplies(channel, ts) {
  let cursor;
  do {
    const r = await bot.conversations.replies({ channel, ts, limit: 200, cursor });
    const msgs = (r.messages || []).slice(1); // [0]=부모
    for (const m of msgs) yield m;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (cursor) await sleep(1200);
  } while (cursor);
}

async function indexMessage(channel, m) {
  if (!m.text || m.bot_id || m.subtype === "channel_join" || m.subtype === "channel_leave") return false;
  const id = `slack:${channel}:${m.ts}`;
  const bodyResolved = await resolveMentions(m.text);
  const embedding = await embedDoc(bodyResolved);
  await store.upsert({
    id,
    channel,
    ts: m.ts,
    thread_ts: m.thread_ts || m.ts,
    author_id: m.user || "",
    author_name: await userName(m.user),
    mentions: mentionIds(m.text),
    body: bodyResolved,
    permalink: await permalink(channel, m.ts),
    created: tsToDate(m.ts),
    embedding,
  });
  return true;
}

(async () => {
  if (!store.enabled) {
    console.error("색인 비활성: DATABASE_URL 과 GEMINI_API_KEY 를 설정하세요.");
    process.exit(1);
  }
  await store.init();
  console.log(`백필 시작. 대상 채널: ${config.allowedChannels.join(", ")}`);
  let n = 0;
  for (const channel of config.allowedChannels) {
    console.log(`[${channel}] 수집 시작`);
    for await (const root of allRootMessages(channel)) {
      try { if (await indexMessage(channel, root)) n++; } catch (e) { console.error("idx root", e && e.message); }
      if ((root.reply_count || 0) > 0) {
        for await (const rep of threadReplies(channel, root.thread_ts || root.ts)) {
          try { if (await indexMessage(channel, rep)) n++; } catch (e) { console.error("idx reply", e && e.message); }
        }
      }
      if (n % 50 === 0 && n) console.log(`  ...${n}건 색인`);
    }
  }
  console.log(`백필 완료: 총 색인 ${await store.count()}건 (이번 실행 ${n}건 처리)`);
  process.exit(0);
})().catch((e) => {
  console.error("백필 실패:", e && (e.stack || e.message || e));
  process.exit(1);
});
