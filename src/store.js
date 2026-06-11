"use strict";
/**
 * 구조화 색인 저장소 — Postgres + pgvector.
 * DATABASE_URL + GEMINI_API_KEY 둘 다 있을 때만 활성(enabled). 없으면 봇은 기존 방식으로 동작.
 */
const { config } = require("./config");

const enabled = config.hasIndex;
let pool = null;

if (enabled) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 4,
  });
}

// 벡터 배열 → pgvector 리터럴 문자열
function toVector(arr) {
  return `[${arr.join(",")}]`;
}

async function init() {
  if (!enabled) return false;
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS lsb_messages (
      id text PRIMARY KEY,
      channel text,
      ts text,
      thread_ts text,
      author_id text,
      author_name text,
      mentions text[],
      body text,
      permalink text,
      created timestamptz,
      embedding vector(${config.embedDim})
    )`
  );
  await pool.query("CREATE INDEX IF NOT EXISTS lsb_author_idx ON lsb_messages (author_id)");
  await pool.query("CREATE INDEX IF NOT EXISTS lsb_created_idx ON lsb_messages (created)");
  await pool.query("CREATE INDEX IF NOT EXISTS lsb_mentions_idx ON lsb_messages USING gin (mentions)");
  try {
    await pool.query(
      "CREATE INDEX IF NOT EXISTS lsb_vec_idx ON lsb_messages USING hnsw (embedding vector_cosine_ops)"
    );
  } catch (e) {
    console.error("[store] 벡터 인덱스 생성 보류:", e && e.message);
  }
  return true;
}

async function upsert(rec) {
  if (!enabled) return;
  await pool.query(
    `INSERT INTO lsb_messages
       (id,channel,ts,thread_ts,author_id,author_name,mentions,body,permalink,created,embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO UPDATE SET
       body=EXCLUDED.body, embedding=EXCLUDED.embedding, mentions=EXCLUDED.mentions,
       author_name=EXCLUDED.author_name, permalink=EXCLUDED.permalink`,
    [
      rec.id, rec.channel, rec.ts, rec.thread_ts || rec.ts,
      rec.author_id || "", rec.author_name || "", rec.mentions || [],
      rec.body || "", rec.permalink || "", rec.created || new Date(),
      toVector(rec.embedding),
    ]
  );
}

// 의미검색: 질문 임베딩과 가까운 순
async function vectorSearch(queryEmbedding, limit) {
  if (!enabled) return [];
  const r = await pool.query(
    `SELECT id,channel,ts,thread_ts,author_id,author_name,body,permalink,created,
            1 - (embedding <=> $1) AS score
     FROM lsb_messages
     ORDER BY embedding <=> $1
     LIMIT $2`,
    [toVector(queryEmbedding), limit]
  );
  return r.rows;
}

// 완전검색: 특정 인물이 멘션됐거나 작성한 모든 글 (빠짐없이, 최신순)
async function mentionSearch(personId, limit) {
  if (!enabled) return [];
  const r = await pool.query(
    `SELECT id,channel,ts,thread_ts,author_id,author_name,body,permalink,created
     FROM lsb_messages
     WHERE $1 = ANY(mentions) OR author_id = $1
     ORDER BY created DESC
     LIMIT $2`,
    [personId, limit]
  );
  return r.rows;
}

async function count() {
  if (!enabled) return 0;
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM lsb_messages");
  return r.rows[0].n;
}

module.exports = { enabled, init, upsert, vectorSearch, mentionSearch, count, toVector };
