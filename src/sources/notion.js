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

function clip(text, needle, pad) {
  const t = text || "";
  const i = t.toLowerCase().indexOf((needle || "").toLowerCase());
  const p = pad || 60;
  if (i < 0) return t.slice(0, 120);
  const s = Math.max(0, i - p);
  const e = Math.min(t.length, i + needle.length + p);
  return (s > 0 ? "…" : "") + t.slice(s, e).replace(/\s+/g, " ") + (e < t.length ? "…" : "");
}

// 페이지 속성(제목/텍스트/선택 등)에서 사람이 읽는 텍스트만 모은다
function pagePropsText(page) {
  const out = [];
  for (const pr of Object.values(page.properties || {})) {
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

async function fetchPlainText(pageId, maxChars) {
  const cap = maxChars || 4000;
  let text = "", cursor;
  while (true) {
    const res = await notion.blocks.children.list({ block_id: pageId, page_size: 100, start_cursor: cursor });
    for (const b of res.results || []) {
      const t = blockText(b);
      if (t) text += (text ? "\n" : "") + t;
      if (text.length >= cap) break;
    }
    if (!res.has_more || text.length >= cap) break;
    cursor = res.next_cursor;
  }
  return text.slice(0, cap);
}

/**
 * 완전탐색: 단어가 '글자 그대로' 든 모든 페이지 위치를 빠짐없이 반환.
 *  - 제목/속성은 전 페이지 스캔(추가 호출 없음)
 *  - 본문은 일부 페이지까지 블록 스캔(blockScanCap)
 */
async function findLiteral(word, opts) {
  if (!notion) return [];
  const needle = (word || "").toLowerCase();
  if (!needle) return [];
  const o = opts || {};
  const maxPages = o.maxPages || 400;
  const blockScanCap = o.blockScanCap || 150;

  const pages = [];
  let cursor;
  while (pages.length < maxPages) {
    let res;
    try {
      res = await notion.search({ filter: { property: "object", value: "page" }, page_size: 100, start_cursor: cursor });
    } catch (e) {
      console.error("[notion.findLiteral.list]", e && e.message);
      break;
    }
    pages.push(...(res.results || []));
    if (!res.has_more) break;
    cursor = res.next_cursor;
    await sleep(350);
  }

  const hits = [];
  let scanned = 0;
  for (const pg of pages) {
    const title = pageTitle(pg);
    const propText = pagePropsText(pg);
    let where = null, snip = "";
    if ((title + " " + propText).toLowerCase().includes(needle)) {
      where = "제목/속성"; snip = clip(title + " " + propText, word);
    } else if (scanned < blockScanCap) {
      scanned++;
      let body = "";
      try { body = await fetchPlainText(pg.id, 4000); } catch (e) { body = ""; }
      await sleep(300);
      if (body.toLowerCase().includes(needle)) { where = "본문"; snip = clip(body, word); }
    }
    if (where) {
      hits.push({
        id: `notion:${pg.id}`,
        source: "notion",
        title,
        snippet: `(${where}) ${snip}`,
        url: pg.url || "",
        timestamp: pg.last_edited_time || "",
      });
    }
  }
  const partial = pages.length >= maxPages || scanned >= blockScanCap;
  return { hits, partial, scannedPages: pages.length };
}

module.exports = { search, read, findLiteral };
