"use strict";
/**
 * Slack 지식 소스
 *  - 과거 전체 검색: search.messages (SLACK_USER_TOKEN, search:read) — 있으면 최우선
 *  - 없으면: 채널 "전체 히스토리"를 페이지네이션으로 끌어와 캐시 후 검색
 *  - 읽기: 스레드 전체 + 멘션/채널/링크를 사람이 읽는 형태로 복원
 */
const { WebClient } = require("@slack/web-api");
const { config } = require("../config");

const bot = new WebClient(config.slackBotToken);
const userClient = config.slackUserToken ? new WebClient(config.slackUserToken) : null;

function tsToIso(ts) {
  const n = parseFloat(ts);
  return Number.isNaN(n) ? "" : new Date(n * 1000).toISOString();
}

// ── 사용자 ID → 표시이름 캐시 ──
const nameCache = new Map();
async function userName(id) {
  if (!id) return "";
  if (!nameCache.has(id)) {
    try {
      const r = await bot.users.info({ user: id });
      const p = (r.user && r.user.profile) || {};
      nameCache.set(id, p.display_name || p.real_name || (r.user && r.user.real_name) || id);
    } catch {
      nameCache.set(id, id);
    }
  }
  return nameCache.get(id);
}

// ── <@U123>·<#C123|name>·<url|label> 등을 사람이 읽는 형태로 ──
async function resolveMentions(text) {
  if (!text) return "";
  let t = text;
  const ids = [...t.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)].map((m) => m[1]);
  for (const id of [...new Set(ids)]) {
    const name = await userName(id);
    t = t.replace(new RegExp(`<@${id}(?:\\|[^>]+)?>`, "g"), `@${name}`);
  }
  t = t.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");                 // 채널
  t = t.replace(/<!subteam\^[A-Z0-9]+\|?([^>]*)>/g, (m, l) => l || "@그룹"); // 유저그룹
  t = t.replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)");        // 링크(라벨)
  t = t.replace(/<(https?:[^>]+)>/g, "$1");                       // 링크
  t = t.replace(/<!(here|channel|everyone)>/g, "@$1");
  return t;
}

async function snippet(text, max = 240) {
  const t = await resolveMentions(text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

async function permalink(channel, ts) {
  try {
    const r = await bot.chat.getPermalink({ channel, message_ts: ts });
    return r.permalink || "";
  } catch {
    return "";
  }
}

// ── (1순위) search.messages ──
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
  const out = [];
  for (const m of matches) {
    out.push({
      id: `slack:${m.channel && m.channel.id}:${m.ts}`,
      source: "slack",
      title: `#${(m.channel && m.channel.name) || ""} · ${m.username || ""}`,
      snippet: await snippet(m.text),
      url: m.permalink || "",
      timestamp: tsToIso(m.ts),
      author: m.username || "",
      channel: m.channel && m.channel.id,
    });
  }
  return out;
}

// ── (폴백) 전체 히스토리 적재 + 캐시 ──
const histCache = new Map();
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
        title: `#${channel} · ${await userName(m.user)}`,
        snippet: await snippet(m.text),
        url: await permalink(channel, m.ts),
        timestamp: tsToIso(m.ts),
        author: await userName(m.user),
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

// ref: "slack:<channel>:<ts>" → 스레드 전체 텍스트 (멘션/링크 복원)
async function read(ref) {
  const [, channel, ts] = ref.split(":");
  try {
    const r = await bot.conversations.replies({ channel, ts, limit: 200 });
    const msgs = (r.messages || []).filter((m) => m.text);
    const url = await permalink(channel, ts);
    const lines = [];
    for (const m of msgs) {
      const who = await userName(m.user);
      const body = await resolveMentions(m.text);
      lines.push(`[${tsToIso(m.ts)}] ${who || m.username || ""}: ${body}`);
    }
    return { url, text: lines.join("\n") || "(내용 없음)" };
  } catch (e) {
    return { url: "", text: `읽기 실패: ${e && e.message}` };
  }
}

module.exports = { search, read, bot };
