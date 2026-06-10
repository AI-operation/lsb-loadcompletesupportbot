"use strict";
/**
 * 맥락(타임라인) + 출처 정리 + Slack 서식 변환 헬퍼.
 */

function fmtDate(iso) {
  if (!iso) return "(시점미상)";
  const d = new Date(iso);
  if (isNaN(d)) return "(시점미상)";
  return d.toISOString().slice(0, 10);
}

/** 검색 후보들을 시간순으로 정렬해 LLM에 넘길 타임라인 텍스트로 */
function buildTimeline(hits) {
  const sorted = [...hits].sort((a, b) =>
    String(a.timestamp || "").localeCompare(String(b.timestamp || ""))
  );
  return sorted
    .map(
      (h, i) =>
        `${i + 1}. [${fmtDate(h.timestamp)}] (${h.source}) ${h.title}\n   ref=${h.id}\n   ${h.snippet || ""}`
    )
    .join("\n");
}

/** 답변 하단에 붙일 출처 목록 (링크 있는 것만). Slack mrkdwn 링크 형식. */
function buildSources(hits) {
  const seen = new Set();
  const lines = [];
  for (const h of hits) {
    if (!h.url || seen.has(h.url)) continue;
    seen.add(h.url);
    lines.push(`• <${h.url}|${h.title} (${fmtDate(h.timestamp)})>`);
  }
  return lines.length ? "\n\n*출처*\n" + lines.join("\n") : "";
}

/**
 * GitHub식 마크다운 → Slack mrkdwn 변환.
 * Slack은 별표2개 굵게/샵 헤더를 못 읽으므로, 제거가 아니라 Slack 문법으로 변환한다.
 * 코드블록(``` ```) 안은 건드리지 않는다.
 */
function toSlackText(text) {
  if (!text) return "";
  // 코드블록 기준으로 쪼개고 홀수 인덱스(코드블록)는 그대로 둔다.
  const parts = text.split(/(```[\s\S]*?```)/g);
  const converted = parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // 코드블록 보존
      let t = part;
      t = t.replace(/^\s{0,3}#{1,6}\s*(.+)$/gm, "*$1*"); // ## 헤더 → 굵게 줄
      t = t.replace(/\*\*(.+?)\*\*/g, "*$1*");           // **굵게** → *굵게*
      t = t.replace(/__(.+?)__/g, "*$1*");               // __굵게__ → *굵게*
      t = t.replace(/^[\t ]*[-*]\s+/gm, "• ");           // 줄머리 - 또는 * → •
      return t;
    })
    .join("");
  return converted.replace(/\n{3,}/g, "\n\n").trim();
}

module.exports = { buildTimeline, buildSources, fmtDate, toSlackText };
