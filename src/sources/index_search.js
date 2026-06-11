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

module.exports = { search, byPerson, enabled: store.enabled };
