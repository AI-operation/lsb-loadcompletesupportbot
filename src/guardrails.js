"use strict";
/**
 * 가드레일 — 경영지원실은 인사·급여·계약 등 민감정보가 핵심.
 *  - 권한: 채널/사용자 화이트리스트
 *  - PII/시크릿 마스킹 (로그·LLM 입력 보호)
 */
const { config } = require("./config");

/** 봇이 이 채널에서 동작해도 되는가 */
function isAllowedChannel(channelId, channelType) {
  // DM(im)은 사용자 화이트리스트로만 제어
  if (channelType === "im") return true;
  return config.allowedChannels.includes(channelId);
}

/** 이 사용자가 봇을 써도 되는가 (목록 비어있으면 전체 허용) */
function isAllowedUser(userId) {
  if (!config.allowedUsers.length) return true;
  return config.allowedUsers.includes(userId);
}

/** PII·시크릿 마스킹 — 로그 저장이나 외부전송 전에 적용 */
function maskPII(text) {
  if (!text) return "";
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b01[0-9]-?\d{3,4}-?\d{4}\b/g, "[PHONE]")
    .replace(/\b\d{6}-?\d{7}\b/g, "[RRN]")             // 주민번호
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[CARD]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]+\b/g, "[SECRET]")
    .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, "[SECRET]")
    .replace(/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[SECRET]");
}

/** 답변 자체가 시크릿을 요구하는지 1차 차단 (프롬프트 가드와 이중) */
const SECRET_REQUEST = /(비밀번호|패스워드|password|인증코드|otp|api ?key|토큰|token|주민번호|계좌번호|카드번호)/i;
function looksLikeSecretRequest(text) {
  return SECRET_REQUEST.test(text || "");
}

module.exports = {
  isAllowedChannel,
  isAllowedUser,
  maskPII,
  looksLikeSecretRequest,
};
