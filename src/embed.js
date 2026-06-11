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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 응답 본문에서 Google이 권하는 재시도 지연(초)을 뽑는다. 없으면 0.
function retryDelaySec(t) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(t || "");
  return m ? parseFloat(m[1]) : 0;
}

async function embed(text, taskType) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY 없음");
  const body = {
    model: `models/${config.embedModel}`,
    content: { parts: [{ text: (text || "").slice(0, 8000) }] },
    taskType: taskType || "RETRIEVAL_DOCUMENT",
    outputDimensionality: config.embedDim,
  };
  const maxRetry = config.embedMaxRetry;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(endpoint(config.embedModel), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const j = await r.json();
      const values = j.embedding && j.embedding.values;
      if (!values || !values.length) throw new Error("embed: 응답에 embedding 없음");
      return l2normalize(values);
    }
    const t = await r.text();
    // 429(쿼터/속도제한)·503(과부하)는 백오프 후 재시도
    if ((r.status === 429 || r.status === 503) && attempt < maxRetry) {
      const hinted = retryDelaySec(t);
      const backoff = hinted ? hinted * 1000 : Math.min(60000, 2000 * 2 ** attempt);
      await sleep(backoff + Math.random() * 500);
      continue;
    }
    throw new Error(`embed ${r.status}: ${t.slice(0, 200)}`);
  }
}

const embedDoc = (t) => embed(t, "RETRIEVAL_DOCUMENT");
const embedQuery = (t) => embed(t, "RETRIEVAL_QUERY");

module.exports = { embed, embedDoc, embedQuery };
