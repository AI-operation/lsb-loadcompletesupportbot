"use strict";
/**
 * 경락이 (LSB · Loadcomplete Support Bot) — 엔트리
 * 경영지원실 Slack 지식 에이전트. @경락이 멘션 또는 DM으로 동작.
 *
 * 실행:  node index.js   (HTTP/Events API 모드 → Render Web Service)
 *   Slack Request URL:  https://<service>.onrender.com/slack/events
 */
require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { config, assertReady } = require("./src/config");
const { isAllowedChannel, isAllowedUser } = require("./src/guardrails");
const { buildSources, toSlackText } = require("./src/format");
const agent = require("./src/agent");

assertReady();

// HTTP 모드: ExpressReceiver가 /slack/events 를 노출. 헬스체크용 GET / 추가.
const receiver = new ExpressReceiver({ signingSecret: config.slackSigningSecret });
receiver.router.get("/", (_req, res) => res.status(200).send("경락이(LSB) running"));

const app = new App({
  token: config.slackBotToken,
  receiver,
});

const seen = new Set(); // 중복 이벤트 방지

// 멘션에서 봇 호출부 제거
function stripMention(text) {
  return (text || "").replace(/<@[^>]+>/g, "").trim();
}

async function handle({ event, client, say }) {
  const key = `${event.channel}:${event.ts}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 5000) seen.clear();

  const channelType = event.channel_type; // 'im' 이면 DM
  if (!isAllowedChannel(event.channel, channelType)) return;
  if (!isAllowedUser(event.user)) {
    await say({ text: "죄송해요, 아직 사용 권한이 없는 사용자예요. 경영지원실에 문의해 주세요.", thread_ts: event.thread_ts || event.ts });
    return;
  }

  const question = stripMention(event.text);
  if (!question) return;

  const threadTs = event.thread_ts || event.ts;

  // 로딩 메시지
  let loadingTs = "";
  try {
    const r = await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs, text: "맥을 짚어보는 중..." });
    loadingTs = r.ts;
  } catch (_) {}

  try {
    // 스레드 맥락(있으면) 간단 수집
    let threadContext = "";
    if (event.thread_ts) {
      try {
        const tr = await client.conversations.replies({ channel: event.channel, ts: event.thread_ts, limit: 12 });
        threadContext = (tr.messages || [])
          .filter((m) => m.text)
          .map((m) => `${m.bot_id ? "경락이" : "사용자"}: ${m.text}`)
          .join("\n");
      } catch (_) {}
    }

    const { answer, hits } = await agent.ask(question, threadContext);
    const finalText = toSlackText(answer) + buildSources(hits);

    if (loadingTs) {
      await client.chat.update({ channel: event.channel, ts: loadingTs, text: finalText });
    } else {
      await say({ text: finalText, thread_ts: threadTs });
    }
    console.log("ANSWERED:", key);
  } catch (e) {
    console.error("handle error:", (e && e.stack) || e);
    const msg = "처리 중 오류가 났어요. 잠시 후 다시 시도해 주세요.";
    if (loadingTs) await client.chat.update({ channel: event.channel, ts: loadingTs, text: msg }).catch(() => {});
    else await say({ text: msg, thread_ts: threadTs }).catch(() => {});
  }
}

// @경락이 멘션
app.event("app_mention", async (args) => {
  await handle(args);
});

// DM (사용자가 봇에게 직접 보낸 메시지)
app.event("message", async (args) => {
  const { event } = args;
  if (event.channel_type !== "im") return;       // DM만
  if (event.subtype || event.bot_id) return;     // 봇/시스템 메시지 무시
  await handle(args);
});

(async () => {
  await app.start(config.port);
  console.log(`경락이(LSB) 가동 (HTTP :${config.port}) — 모델 ${config.claudeModel}`);
  console.log(`허용 채널: ${config.allowedChannels.join(", ") || "(없음)"}`);
  console.log(`소스: slack${config.hasSlackSearch ? "(search)" : "(history)"}` +
    `${config.hasNotion ? " + notion" : ""}${config.hasDrive ? " + drive" : ""}`);
})();
