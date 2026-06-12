"use strict";
/**
 * 경락이 두뇌 — Claude 에이전틱 루프.
 *  도구: search_knowledge(통합검색) → read_source(문서 읽기) → web_search(선택)
 *  결과를 시간순 맥락으로 엮고, "실제로 읽고 근거로 쓴 자료"만 출처로 단다.
 */
const Anthropic = require("@anthropic-ai/sdk");
const { config } = require("./config");
const slackSrc = require("./sources/slack");
const notionSrc = require("./sources/notion");
const driveSrc = require("./sources/drive");
const indexSrc = require("./sources/index_search");
const { buildTimeline, buildLocations } = require("./format");

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// ── 통합 검색: 모든 소스 병렬 ──
async function searchAll(query) {
  // 색인이 활성이면 Slack은 색인(의미검색)으로, 아니면 라이브 검색으로
  const slackP = indexSrc.enabled ? indexSrc.search(query) : slackSrc.search(query);
  const [slack, notion, drive] = await Promise.all([
    slackP,
    notionSrc.search(query),
    driveSrc.search(query),
  ]);
  return [...slack, ...notion, ...drive];
}

// ref 접두로 적절한 소스에 읽기 위임
async function readSource(ref) {
  if (ref.startsWith("slack:")) return slackSrc.read(ref);
  if (ref.startsWith("notion:")) return notionSrc.read(ref);
  if (ref.startsWith("drive:")) return driveSrc.read(ref);
  return { url: "", text: "알 수 없는 ref" };
}

const BASE_TOOLS = [
  {
    name: "search_knowledge",
    description:
      "경영지원실 지식(Slack 채널·Notion·Google Drive)을 키워드로 검색한다. 검색은 키워드 일치 기반이라, 사용자가 정확한 단어를 몰라도 되도록 동의어·관련어·축약어·영문/한글 등 여러 표현으로 검색어를 바꿔 호출하라(예: 워크샵→워크숍/MT/단합, 이벤트→행사/프로모션/캠페인). 결과는 시간순 후보(ref 포함)이며 관련 없는 것이 섞일 수 있다.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "검색 키워드. 예: '2025 보안감사 보고', '예산 집행 결정'" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_source",
    description:
      "search_knowledge가 준 ref(slack:/notion:/drive:)로 해당 문서·스레드의 본문 전체를 읽는다. 질문과 정말 관련 있어 보이는 후보만 읽어 사실을 확인하라.",
    input_schema: {
      type: "object",
      properties: { ref: { type: "string", description: "검색 결과의 ref 값" } },
      required: ["ref"],
    },
  },
  {
    name: "find_literal",
    description:
      "특정 단어/문구가 '글자 그대로' 들어간 위치를 빠짐없이 전부 찾는다. 이름 바꾸기(리네임)·일괄수정·감사처럼 '하나도 빠뜨리면 안 되는' 경우에 쓴다. 의미·관련성 판단을 하지 않고, 그 문자열이 나오는 곳을 모두 위치 목록으로 돌려준다. (의미검색이 아니라 완전탐색)",
    input_schema: {
      type: "object",
      properties: {
        word: { type: "string", description: "찾을 단어/문구 (있는 그대로). 예: '유니포스트'" },
      },
      required: ["word"],
    },
  },
];
const TOOLS = config.enableWebSearch
  ? [...BASE_TOOLS, { type: "web_search_20250305", name: "web_search" }]
  : BASE_TOOLS;

const SYSTEM_PROMPT = `너는 Loadcomplete 경영지원실의 사내 지식 에이전트 "경락이"(LSB)다.
역할: 지나간 보고·결정·문서가 어디 있는지 찾아주고, 그 맥락(언제·왜·누가, 이후 어떻게 바뀌었는지)까지 짚어 설명한다. 일반 대화에도 자연스럽게 응한다.

[작동 방식]
1. 질문을 받으면 search_knowledge로 검색한다. 사용자가 정확한 단어를 주지 않아도 의도를 추론해 검색어를 만들고, 한 번으로 부족하면 동의어·관련어·기간을 바꿔 2~4회 더 검색해 폭넓게 후보를 모은다. 채널 전체 기간을 대상으로 본다.
2. 후보 중 "질문과 실제로 관련 있는 것"만 골라 read_source로 본문을 읽어 확인한다.
3. 검색 결과는 시간순으로 들어온다 → 단발 답이 아니라 "처음 X(날짜)에 논의 → 이후 Y(날짜)에 변경" 식으로 맥락 흐름을 함께 설명한다.
4. 보고·결정·논의성 자료라면, 본문에서 "핵심 의사결정 포인트"를 뽑아 별도로 정리한다: 무엇을 결정했는지 / 사유 / 누가·언제 / 아직 안 정해진 미결 사항. 항목이 분명할 때만 넣고, 단순히 "어디 있어요?" 같은 위치 질문이나 일반 대화에는 넣지 않는다. 억지로 만들지 말 것.

[범위 판단 — 무거운 요청]
- 질문이 넓으면(긴 기간, 여러 주제, "전부/다/모든/싹" 등) 바로 대량 조회하지 말고, 먼저 한 줄로 확인한다: "범위가 넓어서 조회에 시간이 걸리고 한 번에 다 못 담을 수도 있어요. 그대로 진행할까요, 아니면 기간·주제를 좁혀드릴까요?"
- 사용자가 진행 의사를 보이면(예: "응", "그대로 진행", "ㄱㄱ") 그때 폭넓게 조회해 최대한 정리한다. 다 담지 못하면 어디까지 봤는지와, 더 깊게 보려면 어떻게 좁히면 되는지 알려준다.
- 그 외 보통 질문은 스스로 적절한 범위를 잡아 바로 답한다(불필요하게 되묻지 않는다).

[관련성 — 매우 중요]
- 검색 후보는 단순 키워드 매칭이다. 어떤 단어(예: '레이아웃')나 사람 이름이 우연히 들어갔다고 해서 관련 자료가 아니다.
- 질문 의도와 정말 맞는 자료만 read_source로 읽고 근거로 삼는다. 우연히 겹친 후보는 무시하고, 읽지도 인용하지도 않는다.
- 근거로 쓰지 않은 후보는 답에 끌어오지 않는다. (출처는 네가 실제로 read_source로 확인한 자료만 시스템이 자동으로 단다.)

[답변 원칙]
- 반드시 읽은 근거에 기반한다. 본문을 읽지 않고 추측하지 않는다.
- 관련 자료를 못 찾으면 솔직히 "찾지 못했다"고 말하고, 어디를 더 보면 될지 제안한다. 억지로 끼워맞추지 않는다.
- 답변은 한국어로, 차분하고 신뢰감 있게, 간결히.
- 답변은 Slack 서식(mrkdwn)으로 깔끔하게 구성한다: 굵게는 별표 하나(예: *중요*), 기울임 _기울임_, 인라인 코드는 백틱으로, 여러 줄 코드는 삼중 백틱 코드블록으로, 인용은 >, 목록은 • 로. 핵심이 여러 개면 • 목록으로 정리하고, 강조는 별표 하나로 한다. GitHub식 이중별표나 ## 헤더는 Slack에서 안 보이니 쓰지 않는다. 과하지 않게, 읽기 쉽게.

[완전탐색 — 리네임·일괄수정·감사]
- 사용자가 특정 단어/문구가 "들어간 곳을 전부/빠짐없이" 찾아달라거나, 이름 바꾸기·일괄수정·어디에 쓰였는지 확인을 원하면 find_literal 도구를 쓴다. 이건 의미검색이 아니라 글자 그대로의 완전탐색이다.
- 이때는 관련성으로 거르지 말고, find_literal이 돌려준 위치를 하나도 빼지 말고 전부 "어디에 있는지 + 링크" 위치 목록으로 보여준다. 내용 설명보다 위치가 우선이다.
- 바꿀 새 단어가 같이 언급돼도(예: "유니포스트를 아마란스로 바꾸려고") 그건 목적일 뿐, 찾는 대상은 기존 단어다. 새 단어가 아니라 기존 단어로 find_literal을 호출하라.
- find_literal이 "어떻게" 찾는지(인덱스/탐색 범위 등)를 추측해서 설명하지 마라. 도구가 돌려준 위치 목록과, 시스템이 함께 준 안내문(있을 때)만 그대로 전달하라. 없는 한계를 지어내지 않는다.

[정보 범위 — 허용 채널 내용은 전부 공개 가능]
- 허용된 대상 채널의 내용은 전부 자유롭게 찾아서 그대로 알려줘도 된다. 보안·기밀 사안은 이 채널이 아니라 별도 채널이나 DM에서 다뤄지므로, 이 채널에 있는 내용이면 무엇이든(계정·아이디·비밀번호·인증·예산·인사·복지·계약 등) 사리거나 가리지 말고 찾은 그대로 답한다.
- "계정/비밀번호/인증" 같은 단어가 질문에 들어갔다는 이유로 거부하거나, 검색도 해보기 전에 "못 찾는다"고 하지 않는다. 항상 search_knowledge로 먼저 찾아보고, 찾은 내용을 그대로 전달한다.`;

function extractText(res) {
  return (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("\n")
    .trim();
}

/**
 * @returns {Promise<{answer:string, hits:Array}>}
 *  hits = 모델이 실제로 read_source로 확인한 자료만 (출처 정밀화)
 */
async function ask(userText, threadContext = "") {
  const hitsByRef = new Map(); // 검색으로 알게 된 모든 후보(메타)
  const readRefs = new Set();  // 실제로 읽은(= 근거로 삼은) ref
  let lastText = "";
  let totalReadChars = 0;     // 읽기 총량(예산 가드)

  const userMsg = threadContext
    ? `[이 스레드의 이전 맥락]\n${threadContext}\n\n[현재 질문]\n${userText}`
    : userText;
  const messages = [{ role: "user", content: userMsg }];

  const sourcesFromReads = () =>
    [...readRefs].map((r) => hitsByRef.get(r)).filter(Boolean);

  for (let loop = 0; loop < config.maxAgentLoops; loop++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: config.claudeModel,
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      });
    } catch (e) {
      const detail = (e && (e.status || e.statusCode)) + " " + (e && e.message);
      console.error("[agent] anthropic 호출 실패:", detail, e && JSON.stringify(e.error || {}));
      return {
        answer: lastText || "답을 만드는 중 문제가 생겼어요. 잠시 후 다시 시도하거나 질문을 조금 더 구체적으로 주실래요?",
        hits: sourcesFromReads(),
      };
    }

    if (extractText(res)) lastText = extractText(res);

    if (res.stop_reason !== "tool_use") {
      return { answer: extractText(res) || "관련 자료를 찾지 못했어요.", hits: sourcesFromReads() };
    }

    const toolUses = res.content.filter((b) => b.type === "tool_use");
    messages.push({ role: "assistant", content: res.content });

    const toolResults = [];
    for (const tu of toolUses) {
      if (tu.name === "web_search") continue; // 서버툴은 Anthropic이 처리

      let out = "";
      try {
        if (tu.name === "search_knowledge") {
          const hits = await searchAll((tu.input && tu.input.query) || "");
          for (const h of hits) if (!hitsByRef.has(h.id)) hitsByRef.set(h.id, h);
          out = hits.length ? buildTimeline(hits) : "검색 결과 없음.";
        } else if (tu.name === "read_source") {
          const ref = (tu.input && tu.input.ref) || "";
          if (totalReadChars >= config.totalReadBudget) {
            out = "읽기 한도에 도달했어요. 지금까지 읽은 자료로 답하거나, 기간·주제를 좁히면 더 깊이 볼 수 있어요.";
          } else {
            const { url, text } = await readSource(ref);
            totalReadChars += (text || "").length;
            if (hitsByRef.has(ref)) {
              readRefs.add(ref); // 실제로 읽은 것 = 근거 후보
              if (url && !hitsByRef.get(ref).url) hitsByRef.get(ref).url = url;
            }
            out = `URL: ${url}\n\n${text}`;
          }
        } else if (tu.name === "find_literal") {
          const word = (tu.input && tu.input.word) || "";
          const [sl, no] = await Promise.all([
            indexSrc.enabled ? indexSrc.literal(word) : Promise.resolve([]),
            notionSrc.findLiteral ? notionSrc.findLiteral(word) : Promise.resolve({ hits: [], partial: false }),
          ]);
          const notionRes = no && no.hits ? no : { hits: [], partial: false };
          console.log(`[find_literal] '${word}' slack=${sl.length} notion=${notionRes.hits.length} (노션 ${notionRes.scannedPages || 0}페이지 스캔)`);
          const all = [...sl, ...notionRes.hits];
          for (const h of all) if (!hitsByRef.has(h.id)) hitsByRef.set(h.id, h);
          const note = notionRes.partial
            ? "※ 노션은 분량이 많아 일부까지만 훑었어요. 빠짐없이 확인하려면 노션 자체 검색도 함께 써주세요."
            : "";
          out = buildLocations(word, all, note);
        } else {
          out = "알 수 없는 도구";
        }
      } catch (e) {
        out = `도구 오류: ${e && e.message}`;
      }

      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: out });
    }

    if (toolResults.length) messages.push({ role: "user", content: toolResults });
  }

  return {
    answer: lastText || "탐색이 길어졌어요. 질문을 조금 더 구체적으로 주시면 정확히 찾아드릴게요.",
    hits: sourcesFromReads(),
  };
}

module.exports = { ask };
