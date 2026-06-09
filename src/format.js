"use strict";
/**
 * 맥락(타임라인) + 출처 정리 + Slack 텍스트 정리 헬퍼.
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

// Slack 표시용 정리 — 모델이 흘린 마크다운 잔재 제거.
// Slack은 별표2개 굵게/샵 헤더를 못 읽어 기호가 그대로 보이므로 제거한다.
function toSlackText(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // 별표2개 굵게 → 마커 제거(내용 유지)
    .replace(/__(.+?)__/g, "$1")        // 밑줄 강조 제거
    .replace(/^#{1,6}\s+/gm, "")         // 샵 헤더 마커 제거
    .replace(/\*\*/g, "")                // 남은 별표2개 제거
    .replace(/\n{3,}/g, "\n\n")          // 과한 빈 줄 정리
    .trim();
}

module.exports = { buildTimeline, buildSources, fmtDate, toSlackText };
