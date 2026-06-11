"use strict";
/**
 * 경락이(LSB) 설정 — 환경변수 한 곳에서 읽어 검증.
 */

function splitIds(raw) {
  return (raw || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const config = {
  // ── Slack ── (HTTP 모드 = Events API)
  slackBotToken: process.env.SLACK_BOT_TOKEN || "",            // xoxb- (이벤트 수신/답변)
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET || "",  // 요청 서명 검증
  slackUserToken: process.env.SLACK_USER_TOKEN || "",          // xoxp- (search.messages용, 선택)
  port: Number(process.env.PORT || 3000),                      // Render가 PORT 주입

  // 봇이 검색·답변을 허용하는 채널 (권한모델 B: 화이트리스트)
  allowedChannels: splitIds(process.env.LSB_ALLOWED_CHANNELS || "C028C2HTZNZ,C0AJEEUUTFU"),
  // (선택) 봇 사용을 허용할 사용자 ID. 비우면 전체 허용.
  allowedUsers: splitIds(process.env.LSB_ALLOWED_USERS || ""),
  adminUsers: splitIds(process.env.LSB_ADMIN_USERS || ""),   // 백필 등 관리 명령 허용(비면 DM 한정 허용)

  // ── Anthropic ──
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
  maxAgentLoops: Number(process.env.LSB_MAX_LOOPS || 14),
  readMaxChars: Number(process.env.LSB_READ_MAX_CHARS || 9000),       // read 1건당 본문 상한
  totalReadBudget: Number(process.env.LSB_READ_BUDGET || 90000),      // 한 답변에서 읽는 총량 상한(크래시 방지)
  enableWebSearch: process.env.LSB_ENABLE_WEBSEARCH === "1",  // 기본 off (안정화 후 켜기)

  // ── Notion (선택) ──
  notionToken: process.env.NOTION_TOKEN || "",

  // ── Google Drive (선택) ──
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
  driveFolderIds: splitIds(process.env.LSB_DRIVE_FOLDER_IDS || ""), // 비우면 전체 검색

  // 검색 결과 상한
  maxHitsPerSource: Number(process.env.LSB_MAX_HITS || 8),

  // 폴백 히스토리 검색: 채널 전체 적재 상한 + 캐시 TTL
  historyMaxMessages: Number(process.env.LSB_HISTORY_MAX || 3000),
  historyCacheTtlMs: Number(process.env.LSB_HISTORY_TTL_MS || 600000),

  // ── 색인(Phase 1): Postgres + Gemini 임베딩 ──
  databaseUrl: process.env.DATABASE_URL || "",                    // Render Postgres
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  embedModel: process.env.LSB_EMBED_MODEL || "gemini-embedding-001",
  embedDim: Number(process.env.LSB_EMBED_DIM || 1536),

  // 권한 태그 (색인/로그에 박아 P5에서 권한모델 A 졸업 대비)
  permissionTag: process.env.LSB_PERMISSION_TAG || "ga-channel-whitelist",
};

config.hasNotion = Boolean(config.notionToken);
config.hasDrive = Boolean(config.googleServiceAccountJson);
config.hasSlackSearch = Boolean(config.slackUserToken);
config.hasIndex = Boolean(config.databaseUrl && config.geminiApiKey);

function assertReady() {
  const missing = [];
  if (!config.slackBotToken) missing.push("SLACK_BOT_TOKEN");
  if (!config.slackSigningSecret) missing.push("SLACK_SIGNING_SECRET");
  if (!config.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (missing.length) {
    throw new Error(`필수 환경변수 누락: ${missing.join(", ")}`);
  }
}

module.exports = { config, assertReady };
