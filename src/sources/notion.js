"use strict";
/**
 * Notion 지식 소스 (선택) — 보고문서가 Notion에 있을 때.
 *  - search: 워크스페이스 페이지 검색
 *  - read: 페이지 본문 추출
 */
const { config } = require("../config");

let notion = null;
if (config.hasNotion) {
  const { Client } = require("@notionhq/client");
  notion = new Client({ auth: config.notionToken });
}

function pageTitle(page) {
  const props = page.properties || {};
  const titleProp = Object.values(props).find((p) => p.type === "title");
  return (titleProp && titleProp.title.map((t) => t.plain_text).join("")) || "(제목 없음)";
}

async function search(query) {
  if (!notion) return [];
  try {
    const res = await notion.search({
      query,
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: config.maxHitsPerSource,
    });
    return (res.results || []).map((p) => ({
      id: `notion:${p.id}`,
      source: "notion",
      title: pageTitle(p),
      snippet: "",
      url: p.url || "",
      timestamp: p.last_edited_time || "",
      author: (p.last_edited_by && p.last_edited_by.id) || "",
      channel: "notion",
    }));
  } catch (e) {
    console.error("[notion.search]", e && e.message);
    return [];
  }
}

const richText = (b, key) =>
  (b[key] && b[key].rich_text && b[key].rich_text.map((r) => r.plain_text).join("")) || "";

function blockText(b) {
  return (
    richText(b, "paragraph") ||
    richText(b, "heading_1") ||
    richText(b, "heading_2") ||
    richText(b, "heading_3") ||
    richText(b, "bulleted_list_item") ||
    richText(b, "numbered_list_item") ||
    richText(b, "to_do") ||
    richText(b, "toggle") ||
    richText(b, "quote") ||
    richText(b, "callout") ||
    richText(b, "code") ||
    (b.table_row &&
      b.table_row.cells.map((c) => c.map((r) => r.plain_text).join("")).join(" | ")) ||
    ""
  );
}

// ref: "notion:<pageId>"
async function read(ref, maxChars = 4000) {
  if (!notion) return { url: "", text: "Notion 미설정" };
  const pageId = ref.split(":")[1];
  let text = "";
  try {
    let cursor;
    while (true) {
      const res = await notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
        start_cursor: cursor,
      });
      for (const b of res.results || []) {
        const t = blockText(b);
        if (t) text += (text ? "\n" : "") + t;
        if (text.length >= maxChars) break;
      }
      if (!res.has_more || text.length >= maxChars) break;
      cursor = res.next_cursor;
    }
    return { url: `https://www.notion.so/${pageId.replace(/-/g, "")}`, text: text.slice(0, maxChars) || "(본문 없음)" };
  } catch (e) {
    return { url: "", text: `읽기 실패: ${e && e.message}` };
  }
}

// ── 완전탐색 헬퍼 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SCAN_SLEEP = Number(process.env.LSB_NOTION_SCAN_SLEEP || 150);
const SCAN_MAX_CALLS = Number(process.env.LSB_NOTION_SCAN_CALLS || 700); // API 호출 예산(과다 방지)

function clip(text, needle, pad) {
  const t = text || "";
  const i = t.toLowerCase().indexOf((needle || "").toLowerCase());
  const p = pad || 70;
  if (i < 0) return t.slice(0, 140);
  const s = Math.max(0, i - p);
  const e = Math.min(t.length, i + needle.length + p);
  return (s > 0 ? "…" : "") + t.slice(s, e).replace(/\s+/g, " ") + (e < t.length ? "…" : "");
}

function pagePropsText(page) {
  const out = [];
  for (const pr of Object.values((page && page.properties) || {})) {
    if (pr.type === "title") out.push((pr.title || []).map((t) => t.plain_text).join(""));
    else if (pr.type === "rich_text") out.push((pr.rich_text || []).map((t) => t.plain_text).join(""));
    else if (pr.type === "select" && pr.select) out.push(pr.select.name || "");
    else if (pr.type === "multi_select") out.push((pr.multi_select || []).map((x) => x.name).join(" "));
    else if (pr.type === "status" && pr.status) out.push(pr.status.name || "");
    else if (pr.type === "url") out.push(pr.url || "");
    else if (pr.type === "email") out.push(pr.email || "");
    else if (pr.type === "phone_number") out.push(pr.phone_number || "");
  }
  return out.join(" ");
}

// 한 페이지의 본문을 중첩 블록까지 재귀로 모은다.
// child_page / child_database 는 별도 페이지로 큐에 넣는다(여기선 텍스트로만 제목 포함).
async function walkBlocks(blockId, textParts, childRefs, state) {
  let cursor;
  do {
    if (state.calls >= state.maxCalls) { state.partial = true; return; }
    state.calls++;
    let res;
    try {
      res = await notion.blocks.children.list({ block_id: blockId, page_size: 100, start_cursor: cursor });
    } catch (e) {
      return;
    }
    await sleep(SCAN_SLEEP);
    for (const b of res.results || []) {
      if (b.type === "child_page") {
        const t = (b.child_page && b.child_page.title) || "";
        if (t) textParts.push(t);
        childRefs.push({ id: b.id, title: t || "(하위 페이지)" });
        continue;
      }
      if (b.type === "child_database") {
        const t = (b.child_database && b.child_database.title) || "";
        if (t) textParts.push(t);
        childRefs.push({ id: b.id, title: t || "(DB)", db: true });
        continue;
      }
      if (b.type === "link_to_page") {
        const lp = b.link_to_page || {};
        const pid = lp.page_id || lp.database_id;
        if (pid) childRefs.push({ id: pid, title: "(링크된 페이지)", db: !!lp.database_id });
        continue;
      }
      const t = blockText(b);
      if (t) textParts.push(t);
      if (b.has_children) await walkBlocks(b.id, textParts, childRefs, state);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
}

/**
 * 완전탐색(재귀): 접근 가능한 모든 페이지·하위 페이지·DB 행으로 들어가
 * 본문(중첩 블록 포함)까지 글자 그대로 스캔. 단어가 든 페이지를 위치로 반환.
 */
async function findLiteral(word, opts) {
  if (!notion) return { hits: [], partial: false, scannedPages: 0 };
  const needle = (word || "").toLowerCase();
  if (!needle) return { hits: [], partial: false, scannedPages: 0 };
  const o = opts || {};
  const state = { calls: 0, maxCalls: o.maxCalls || SCAN_MAX_CALLS, partial: false };

  const visited = new Set();
  const queue = [];

  // 1) 접근 가능한 루트(페이지/DB) 수집
  let cursor;
  do {
    if (state.calls >= state.maxCalls) { state.partial = true; break; }
    state.calls++;
    let res;
    try {
      res = await notion.search({ page_size: 100, start_cursor: cursor });
    } catch (e) {
      console.error("[notion.findLiteral.search]", e && e.message);
      break;
    }
    await sleep(SCAN_SLEEP);
    for (const r of res.results || []) {
      if (r.object === "page") queue.push({ id: r.id, page: r });
      else if (r.object === "database") queue.push({ id: r.id, db: true });
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  const hits = [];
  // 2) 큐 처리 — 페이지는 본문 스캔+하위 발견, DB는 행 조회
  while (queue.length) {
    if (state.calls >= state.maxCalls) { state.partial = true; break; }
    const item = queue.shift();
    if (visited.has(item.id)) continue;
    visited.add(item.id);

    if (item.db) {
      let dcur;
      do {
        if (state.calls >= state.maxCalls) { state.partial = true; break; }
        state.calls++;
        let qr;
        try {
          qr = await notion.databases.query({ database_id: item.id, page_size: 100, start_cursor: dcur });
        } catch (e) { break; }
        await sleep(SCAN_SLEEP);
        for (const row of qr.results || []) if (!visited.has(row.id)) queue.push({ id: row.id, page: row });
        dcur = qr.has_more ? qr.next_cursor : null;
      } while (dcur);
      continue;
    }

    const page = item.page;
    const title = page ? pageTitle(page) : (item.childTitle || "(페이지)");
    const propText = pagePropsText(page);
    const textParts = [];
    const childRefs = [];
    await walkBlocks(item.id, textParts, childRefs, state);
    for (const cp of childRefs) if (!visited.has(cp.id)) queue.push({ id: cp.id, db: !!cp.db, childTitle: cp.title });

    const full = `${title} ${propText} ${textParts.join("\n")}`;
    if (full.toLowerCase().includes(needle)) {
      const inTitle = `${title} ${propText}`.toLowerCase().includes(needle);
      hits.push({
        id: `notion:${item.id}`,
        source: "notion",
        title,
        snippet: `(${inTitle ? "제목/속성" : "본문"}) ${clip(full, word)}`,
        url: (page && page.url) || `https://www.notion.so/${item.id.replace(/-/g, "")}`,
        timestamp: (page && page.last_edited_time) || "",
      });
    }
  }

  console.log(`[notion.findLiteral] '${word}' 스캔 ${visited.size}페이지, ${hits.length}곳 발견, calls=${state.calls}, partial=${state.partial}`);
  return { hits, partial: state.partial, scannedPages: visited.size };
}

module.exports = { search, read, findLiteral };
