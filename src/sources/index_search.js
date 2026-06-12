"use strict";
/**
 * 색인 기반 검색 소스 — Postgres 색인이 활성일 때 Slack 검색을 대체.
 *  - 의미검색(벡터): 질문을 임베딩해 가까운 메시지
 *  - 결과를 공통 hit 스키마로 반환 (read_source는 기존 slack.read가 스레드 전체를 다시 읽음)
 */
const store = require("../store");
const { embedQuery } = require("../embed");

function rowToHit(r) {
  return {
    id: r.id, // slack:<channel>:<ts>
    source: "slack",
    title: `#${r.channel} · ${r.author_name || ""}`,
    snippet: (r.body || "").slice(0, 240),
    url: r.permalink || "",
    timestamp: r.created ? new Date(r.created).toISOString() : "",
    author: r.author_name || "",
    channel: r.channel,
  };
}

async function search(query, limit) {
  if (!store.enabled) return [];
  try {
    const qv = await embedQuery(query);
    const rows = await store.vectorSearch(qv, limit || 12);
    return rows.map(rowToHit);
  } catch (e) {
    console.error("[index_search]", e && e.message);
    return [];
  }
}

// 특정 인물 완전검색(빠짐없이): 멘션되거나 작성한 모든 글
async function byPerson(personId, limit) {
  if (!store.enabled) return [];
  try {
    const rows = await store.mentionSearch(personId, limit || 200);
    return rows.map(rowToHit);
  } catch (e) {
    console.error("[index_search.byPerson]", e && e.message);
    return [];
  }
}

// 단어 주변만 잘라 보여주는 스니펫
function clip(text, needle, pad) {
  const t = text || "";
  const i = t.toLowerCase().indexOf((needle || "").toLowerCase());
  const p = pad || 60;
  if (i < 0) return t.slice(0, 120);
  const s = Math.max(0, i - p);
  const e = Math.min(t.length, i + needle.length + p);
  return (s > 0 ? "…" : "") + t.slice(s, e).replace(/\s+/g, " ") + (e < t.length ? "…" : "");
}

// 완전탐색: 본문에 단어가 글자 그대로 든 모든 메시지를 위치로 반환
async function literal(word) {
  if (!store.enabled) return [];
  try {
    const rows = await store.literalSearch(word, 500);
    return rows.map((r) => ({
      id: r.id,
      source: "slack",
      title: `#${r.channel} · ${r.author_name || ""}`,
      snippet: clip(r.body, word),
      url: r.permalink || "",
      timestamp: r.created ? new Date(r.created).toISOString() : "",
    }));
  } catch (e) {
    console.error("[index_search.literal]", e && e.message);
    return [];
  }
}

module.exports = { search, byPerson, literal, enabled: store.enabled };
