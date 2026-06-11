"use strict";
/**
 * Gemini 임베딩 클라이언트 (gemini-embedding-001).
 * REST 직접 호출(외부 의존성 없음). 차원 축소 시 정규화 권장 → 항상 L2 정규화.
 */
const { config } = require("./config");

function endpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${config.geminiApiKey}`;
}

function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

async function embed(text, taskType) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY 없음");
  const body = {
    model: `models/${config.embedModel}`,
    content: { parts: [{ text: (text || "").slice(0, 8000) }] },
    taskType: taskType || "RETRIEVAL_DOCUMENT",
    outputDimensionality: config.embedDim,
  };
  const r = await fetch(endpoint(config.embedModel), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`embed ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  const values = j.embedding && j.embedding.values;
  if (!values || !values.length) throw new Error("embed: 응답에 embedding 없음");
  return l2normalize(values);
}

const embedDoc = (t) => embed(t, "RETRIEVAL_DOCUMENT");
const embedQuery = (t) => embed(t, "RETRIEVAL_QUERY");

module.exports = { embed, embedDoc, embedQuery };
