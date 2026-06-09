"use strict";
/**
 * Google Drive 지식 소스 (선택) — 보고문서가 Drive에 있을 때.
 *  - search: 파일명/본문 fullText 검색
 *  - read: 구글 문서/시트는 텍스트로 export, 그 외 바이너리는 메타+링크만 (본문추출 P2)
 */
const { config } = require("../config");

let drive = null;
if (config.hasDrive) {
  const { google } = require("googleapis");
  const sa = JSON.parse(config.googleServiceAccountJson);
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  drive = google.drive({ version: "v3", auth });
}

async function search(query) {
  if (!drive) return [];
  try {
    let q = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
    if (config.driveFolderIds.length) {
      const inFolders = config.driveFolderIds.map((id) => `'${id}' in parents`).join(" or ");
      q = `(${inFolders}) and ${q}`;
    }
    const res = await drive.files.list({
      q,
      pageSize: config.maxHitsPerSource,
      orderBy: "modifiedTime desc",
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))",
    });
    return (res.data.files || []).map((f) => ({
      id: `drive:${f.id}`,
      source: "drive",
      title: f.name,
      snippet: f.mimeType,
      url: f.webViewLink || "",
      timestamp: f.modifiedTime || "",
      author: (f.owners && f.owners[0] && f.owners[0].displayName) || "",
      channel: "drive",
      _mimeType: f.mimeType,
    }));
  } catch (e) {
    console.error("[drive.search]", e && e.message);
    return [];
  }
}

// ref: "drive:<fileId>"
async function read(ref, maxChars = 4000) {
  if (!drive) return { url: "", text: "Drive 미설정" };
  const fileId = ref.split(":")[1];
  try {
    const meta = await drive.files.get({ fileId, fields: "name,mimeType,webViewLink" });
    const { mimeType, webViewLink } = meta.data;
    let text = "";

    if (mimeType === "application/vnd.google-apps.document") {
      const r = await drive.files.export({ fileId, mimeType: "text/plain" }, { responseType: "text" });
      text = String(r.data);
    } else if (mimeType === "application/vnd.google-apps.spreadsheet") {
      const r = await drive.files.export({ fileId, mimeType: "text/csv" }, { responseType: "text" });
      text = String(r.data);
    } else {
      text = `(${mimeType} 본문 자동추출은 P2 예정. 링크로 확인: ${webViewLink})`;
    }
    return { url: webViewLink || "", text: text.slice(0, maxChars) || "(본문 없음)" };
  } catch (e) {
    return { url: "", text: `읽기 실패: ${e && e.message}` };
  }
}

module.exports = { search, read };
