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

module.exports = { search, read };
