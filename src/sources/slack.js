"use strict";
/**
 * Slack 지식 소스
 *  - 과거 전체 검색: search.messages (SLACK_USER_TOKEN, search:read) — 있으면 최우선
 *  - 없으면: 채널 "전체 히스토리"를 페이지네이션으로 끌어와 캐시 후 검색 (최근만 X)
 *  - 읽기: 스레드 전체를 가져와 맥락 복원
 */
const { WebClient } = require("@slack/web-api");
const { config } = require("../config");

const bot = new WebClient(config.slackBotToken);
const userClient = config.slackUserToken ? new WebClient(config.slackUserToken) : null;

function tsToIso(ts) {
  const n = parseFloat(ts);
  return Number.isNaN(n) ? "" : new Date(n * 1000).toISOString();
}
function snippet(text, max = 240) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
async function permalink(channel, ts) {
  try {
    const r = await bot.chat.getPermalink({ channel, message_ts: ts });
    return r.permalink || "";
  } catch {
    return "";
  }
}

// ── (1순위) search.messages: 워크스페이스 전체 색인 검색 ──
function scopedQuery(query) {
  if (!config.allowedChannels.length) return query;
  const scope = config.allowedChannels.map((c) => `in:<#${c}>`).join(" ");
  return `${query} ${scope}`;
}
async function searchViaApi(query) {
  const res = await userClient.search.messages({
    query: scopedQuery(query),
    count: config.maxHitsPerSource,
    sort: "score",
  });
  const matches = (res.messages && res.messages.matches) || [];
  return matches.map((m) => ({
    id: `slack:${m.channel && m.channel.id}:${m.ts}`,
    source: "slack",
    title: `#${(m.channel && m.channel.name) || ""} · ${m.username || ""}`,
    snippet: snippet(m.text),
    url: m.permalink || "",
    timestamp: tsToIso(m.ts),
    author: m.username || "",
    channel: m.channel && m.channel.id,
  }));
}

// ── (폴백) 채널 전체 히스토리 적재 + 캐시 ──
const histCache = new Map(); // channel -> { ts, messages }
async function fetchChannelAll(channel) {
  const cached = histCache.get(channel);
  if (cached && Date.now() - cached.ts < config.historyCacheTtlMs) return cached.messages;

  const all = [];
  let cursor;
  while (all.length < config.historyMaxMessages) {
    let r;
    try {
      r = await bot.conversations.history({ channel, limit: 200, cursor });
    } catch (e) {
      console.error("[slack.history]", e && e.message);
      break;
    }
    all.push(...(r.messages || []));
    cursor = r.response_metadata && r.response_metadata.next_cursor;
    if (!cursor) break;
  }
  console.log(`[slack] #${channel} 히스토리 ${all.length}건 적재(캐시)`);
  histCache.set(channel, { ts: Date.now(), messages: all });
  return all;
}

function terms(query) {
  return (query || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

async function searchViaHistory(query) {
  const ts = terms(query);
  if (!ts.length) return [];
  const hits = [];
  for (const channel of config.allowedChannels) {
    const msgs = await fetchChannelAll(channel);
    const scored = msgs
      .filter((m) => m.text && !m.bot_id)
      .map((m) => {
        const base = m.text.toLowerCase();
        const score = ts.reduce((s, t) => (base.includes(t) ? s + 1 : s), 0);
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || parseFloat(b.m.ts) - parseFloat(a.m.ts))
      .slice(0, config.maxHitsPerSource);

    for (const { m } of scored) {
      hits.push({
        id: `slack:${channel}:${m.ts}`,
        source: "slack",
        title: `#${channel} · ${m.user || ""}`,
        snippet: snippet(m.text),
        url: await permalink(channel, m.ts),
        timestamp: tsToIso(m.ts),
        author: m.user || "",
        channel,
      });
    }
  }
  return hits.slice(0, config.maxHitsPerSource);
}

async function search(query) {
  try {
    return userClient ? await searchViaApi(query) : await searchViaHistory(query);
  } catch (e) {
    console.error("[slack.search]", e && e.message);
    return [];
  }
}

// ref: "slack:<channel>:<ts>" → 스레드 전체 텍스트
async function read(ref) {
  const [, channel, ts] = ref.split(":");
  try {
    const r = await bot.conversations.replies({ channel, ts, limit: 200 });
    const msgs = r.messages || [];
    const url = await permalink(channel, ts);
    const body = msgs
      .filter((m) => m.text)
      .map((m) => `[${tsToIso(m.ts)}] ${m.user || m.username || ""}: ${m.text}`)
      .join("\n");
    return { url, text: body || "(내용 없음)" };
  } catch (e) {
    return { url: "", text: `읽기 실패: ${e && e.message}` };
  }
}

module.exports = { search, read, bot };
