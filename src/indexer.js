"use strict";
/**
 * 색인 적재(백필) 코어 — CLI(scripts/backfill.js)와 봇 명령에서 공용.
 * 허용 채널의 모든 메시지+스레드를 멘션 해석·임베딩 후 upsert. 반복 실행 안전.
 */
const { config } = require("./config");
const store = require("./store");
const { embedDoc } = require("./embed");
const { bot, userName, resolveMentions } = require("./sources/slack");

let running = false;
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
async function* allRoot(channel) {
  let cursor;
  do {
    const r = await bot.conversations.history({ channel, limit: 200, cursor });
    for (const m of r.messages || []) yield m;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (cursor) await sleep(1200);
  } while (cursor);
}
async function* threadReplies(channel, ts) {
  let cursor;
  do {
    const r = await bot.conversations.replies({ channel, ts, limit: 200, cursor });
    for (const m of (r.messages || []).slice(1)) yield m;
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (cursor) await sleep(1200);
  } while (cursor);
}
async function indexMessage(channel, m) {
  if (!m.text || m.bot_id || m.subtype === "channel_join" || m.subtype === "channel_leave") return false;
  const body = await resolveMentions(m.text);
  const embedding = await embedDoc(body);
  await store.upsert({
    id: `slack:${channel}:${m.ts}`,
    channel,
    ts: m.ts,
    thread_ts: m.thread_ts || m.ts,
    author_id: m.user || "",
    author_name: await userName(m.user),
    mentions: mentionIds(m.text),
    body,
    permalink: await permalink(channel, m.ts),
    created: tsToDate(m.ts),
    embedding,
  });
  return true;
}

async function runBackfill(onProgress) {
  if (!store.enabled) throw new Error("색인 비활성: DATABASE_URL/GEMINI_API_KEY 확인");
  if (running) return { already: true };
  running = true;
  try {
    await store.init();
    let n = 0;
    for (const channel of config.allowedChannels) {
      for await (const root of allRoot(channel)) {
        try { if (await indexMessage(channel, root)) n++; } catch (e) { console.error("idx root", e && e.message); }
        if ((root.reply_count || 0) > 0) {
          for await (const rep of threadReplies(channel, root.thread_ts || root.ts)) {
            try { if (await indexMessage(channel, rep)) n++; } catch (e) { console.error("idx reply", e && e.message); }
          }
        }
        if (onProgress && n && n % 100 === 0) { try { onProgress(n); } catch {} }
      }
    }
    const total = await store.count();
    return { total, processed: n };
  } finally {
    running = false;
  }
}

module.exports = { runBackfill, isRunning: () => running };
