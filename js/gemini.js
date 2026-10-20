// REQ-875 제미나이로 사진 읽기(선택) — android data/gemini/*.kt(REQ-840·841·844)와 같은 묻는 글·답 모양·바꾸기 규칙.
// 키는 점검자가 넣고 이 휴대폰(브라우저 저장소)에만 둔다. 주소에 넣지 않고 머리 x-goog-api-key 로만 보낸다.
// 「틀린 값 0」: 웹앱에는 휴대폰 글자 인식(ML Kit)이 아직 없으므로(2단계) 제미나이가 읽은 줄은 모두
// 안드로이드 두 판독 합치기(DualReadMerger)의 「제미나이만」 줄과 같이 「확인 필요」 — 점검자가 [맞음]을 눌러야 판정한다.

import { PRODUCT_LOTTO, PRODUCT_PENSION, PRODUCT_PENSION520, PRODUCT_SPEETTO, PRODUCT_UNKNOWN, CUMULATIVE_DRAW, CUMULATIVE_NOTE } from './wins.js';

export const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const PROMPT_VERSION = 'req844-1';
export const PRODUCTS = ['LOTTO645', 'PENSION720', 'PENSION520', 'SPEETTO', 'TOTO', 'UNKNOWN'];
const PRODUCTS_ACCEPTED = [...PRODUCTS, 'SPEETTO1000', 'SPEETTO2000', 'SPEETTO500', 'OTHER'];
export const RANKS = ['1', '2', '3', '4', '5', '보너스'];
export const KINDS = ['sheet', 'plaque', 'banner', 'cumulative', 'other'];
export const TIMEOUT_MS = 25000;
export const PRO_TIMEOUT_MS = 60000;
export const CHECK_TIMEOUT_MS = 15000;
export const NOTICE_VERSION = 2;

export const FAILURES = {
  NO_KEY: '키 없음', OFFLINE: '인터넷 연결 없음', TIMEOUT: '응답 시간 초과', QUOTA: '사용 한도 초과', INVALID_KEY: '키가 맞지 않음',
  MODEL: '모델 이름 확인 필요', BLOCKED: '구글이 답을 막음', SERVER: '구글 서버 오류', REQUEST: '요청이 거절됨', NO_MODEL: '쓸 수 있는 모델 없음',
  NETWORK: '연결 실패', FORMAT: '답 형식 오류', IMAGE: '사진 준비 실패',
};

export class GeminiError extends Error {
  constructor(failure, detail) { super(detail || FAILURES[failure]); this.failure = failure; }
}

export const PROMPT = `
이 사진은 한국 복권 판매점에 붙은 당첨 기록을 찍은 것입니다. 사진에서 **회차가 적힌 당첨 표시**를 모두 찾아 JSON으로만 답하세요.

찾을 것(예):
- 손글씨·인쇄 A4 안내문 「1177회 / 3등 2명 / 4등 35명 / 5등 811명」 — 판 하나에 회차 하나, **등위 줄마다 항목 하나**(이 예는 항목 3개). 이런 판은 로또6/45입니다.
- 동행복권 명패·현수막·종이 「로또 1102회차 1등 당첨점」, 「1등 당첨 ★1102 회차★」, 「제1211회 2등 당첨」 — 명수가 적혀 있으면 count, 없으면 null.
- 연금복권720+ 「NNN회 1등」, 연금복권520, 스피또 「스피또1000 NN회 1등」 같은 다른 복권 표시.
- 회차 없이 누적 횟수만 적힌 표시 「로또 1등 8번 당첨」, 「8번째 1등 당첨」, 「1등 당첨 8회」 — 항목 하나: draw=null, rank="1", count=N(「8번째」도 8), kind="cumulative". 옆에 회차(예: 1103회)가 따로 적혀 있으면 그 회차 표시는 다른 항목으로 적습니다.

넣지 말 것:
- 「판매점 당첨 보고서」 영수증의 기간 합계(「기준회차 제001216회차-제001244회차 1등 1명…」)처럼 회차 하나에 묶이지 않은 합계, 「1등 5번」처럼 회차 없는 표시.
- 판매점ID·단말기 번호·날짜·시각·거래번호·전화번호 숫자(회차가 아님).
- **사진 가장자리에 걸려 잘린 안내문**, **물건·다른 종이·빛 반사에 가려 일부가 안 보이는 안내문**은 통째로 빼고 skipped 에 적으세요(보이는 줄만 골라 넣지 마세요).

규칙(가장 중요):
- 사진에 **똑똑히 보이는 것만** 적습니다. 흔한 값, 옆 판의 값, 복권 상식으로 짐작해 채우지 마세요.
- 숫자 하나라도 흐리거나 자신이 없으면 그 칸은 null 로 두고 certain=false 로 하세요. 틀린 숫자를 적는 것보다 null 이 훨씬 낫습니다.
- certain=true 는 그 항목에서 null 이 아닌 칸이 모두 확실히 보일 때만.
- 등위가 안 보이면 rank=null, 회차가 안 보이면 draw=null.

각 항목:
- product: "LOTTO645" | "PENSION720" | "PENSION520" | "SPEETTO" | "TOTO" | "UNKNOWN"
- draw: 회차 숫자(정수) 또는 null
- rank: "1" | "2" | "3" | "4" | "5" | "보너스" | null
- count: 그 등위 당첨 명수(정수) 또는 null
- certain: true | false
- box_hint: 사진 어디쯤인지 짧게(예: "위 줄 왼쪽에서 두 번째 판")
- kind: 손글씨·인쇄 안내문 판 "sheet" | 1등·2등 당첨 명패 "plaque" | 현수막 "banner" | 회차 없는 누적 횟수 "cumulative" | 그 밖 "other"
- box: 그 표시(회차 글자와 등위 줄)를 감싸는 상자 [x0, y0, x1, y1] — 사진 너비·높이에 대한 0~1 비율, 모르면 null

답 형식(JSON만, 다른 말 없이):
{"items": [{"product": "LOTTO645", "draw": 1177, "rank": "3", "count": 2, "certain": true, "box_hint": "...", "kind": "sheet", "box": [0.1, 0.2, 0.3, 0.4]}],
 "skipped": [{"reason": "edge | occluded | unclear", "box_hint": "..."}]}
`.trim();

export function schema() {
  const type = (t, nullable = false, en = null) => ({ type: t, ...(nullable ? { nullable: true } : {}), ...(en ? { enum: en } : {}) });
  const obj = (fields, required) => ({
    type: 'OBJECT', properties: Object.fromEntries(fields), required, propertyOrdering: fields.map((f) => f[0]),
  });
  const item = obj([
    ['product', type('STRING', false, PRODUCTS)], ['draw', type('INTEGER', true)], ['rank', type('STRING', true, RANKS)],
    ['count', type('INTEGER', true)], ['certain', type('BOOLEAN')], ['box_hint', type('STRING')], ['kind', type('STRING', false, KINDS)],
    ['box', { ...type('ARRAY', true), items: type('NUMBER') }],
  ], ['product', 'draw', 'rank', 'count', 'certain', 'box_hint', 'kind']);
  const skip = obj([['reason', type('STRING')], ['box_hint', type('STRING')]], ['reason', 'box_hint']);
  return obj([['items', { type: 'ARRAY', items: item }], ['skipped', { type: 'ARRAY', items: skip }]], ['items', 'skipped']);
}

export function requestBody(jpegBase64) {
  return {
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: jpegBase64 } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: schema() },
  };
}

export function failureOf(code, body) {
  if (code === 429 || body.includes('RESOURCE_EXHAUSTED')) return 'QUOTA';
  if (code === 401 || code === 403 || body.includes('API_KEY_INVALID') || body.includes('API key not valid')) return 'INVALID_KEY';
  if (code === 404) return 'MODEL';
  if (code >= 500) return 'SERVER';
  return 'REQUEST';
}

export const timeoutFor = (model) => (model.includes('pro') ? PRO_TIMEOUT_MS : TIMEOUT_MS);

export const cleanKey = (key) => String(key || '').trim().replace(/^['"]+|['"]+$/g, '').replace(/\s+/g, '');
export const maskKey = (key) => '••••••••' + String(key).slice(-4);

export class GeminiClient {
  constructor(fetcher = globalThis.fetch?.bind(globalThis), clock = () => Date.now()) { this.fetcher = fetcher; this.clock = clock; }

  async call(url, key, body, timeoutMs) {
    if (!key || !key.trim()) throw new GeminiError('NO_KEY');
    if (globalThis.navigator && navigator.onLine === false) throw new GeminiError('OFFLINE');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetcher(url, {
        method: body == null ? 'GET' : 'POST',
        headers: { 'x-goog-api-key': key.trim(), 'Content-Type': 'application/json; charset=utf-8' },
        body: body == null ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
    } catch (e) {
      throw new GeminiError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    if (response.status >= 200 && response.status < 300) return text;
    let status = null;
    try { status = JSON.parse(text).error?.status ?? null; } catch { /* 무시 */ }
    throw new GeminiError(failureOf(response.status, text), status || undefined);
  }

  async listModels(key) {
    const text = await this.call(`${BASE}/models?pageSize=200`, key, null, CHECK_TIMEOUT_MS);
    let root;
    try { root = JSON.parse(text); } catch { throw new GeminiError('FORMAT'); }
    return (root.models || []).map((o) => {
      const methods = o.supportedGenerationMethods || [];
      const name = String(o.name || '').replace(/^models\//, '');
      return name.startsWith('gemini') && methods.includes('generateContent') ? name : null;
    }).filter(Boolean);
  }

  async probe(key, model) {
    await this.call(`${BASE}/models/${model.trim()}:generateContent`, key, {
      contents: [{ role: 'user', parts: [{ text: 'OK 라고만 답하세요.' }] }], generationConfig: { temperature: 0, maxOutputTokens: 16 },
    }, CHECK_TIMEOUT_MS);
  }

  /** 사진 한 장(JPEG base64) 판독 → {text, model, modelVersion, latencyMs, 토큰}. */
  async generate(key, model, jpegBase64) {
    const started = this.clock();
    const text = await this.call(`${BASE}/models/${model.trim()}:generateContent`, key, requestBody(jpegBase64), timeoutFor(model));
    const latencyMs = this.clock() - started;
    let root;
    try { root = JSON.parse(text); } catch { throw new GeminiError('FORMAT'); }
    if (root.promptFeedback?.blockReason) throw new GeminiError('BLOCKED', root.promptFeedback.blockReason);
    const candidate = root.candidates?.[0];
    if (!candidate) throw new GeminiError('FORMAT', '답 후보 없음');
    const answer = (candidate.content?.parts || []).filter((p) => p.thought !== true).map((p) => p.text || '').join('');
    if (!answer.trim()) {
      const reason = candidate.finishReason;
      throw new GeminiError(reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' ? 'BLOCKED' : 'FORMAT', reason);
    }
    const u = root.usageMetadata || {};
    return { text: answer, model, modelVersion: root.modelVersion ?? null, latencyMs,
      promptTokens: u.promptTokenCount ?? null, outputTokens: u.candidatesTokenCount ?? null, thoughtTokens: u.thoughtsTokenCount ?? null, totalTokens: u.totalTokenCount ?? null };
  }
}

const FLASH = /^gemini-(\d+(?:\.\d+)?)-flash(-preview(?:-[\w-]+)?|-latest|-\d{3})?$/;

/** 목록 → Flash 후보(새 버전 먼저, 같은 버전이면 정식 → 미리보기). lite·image·tts 등은 뺀다. */
export function flashCandidates(models) {
  return models.map((name) => [name, FLASH.exec(name)]).filter(([, m]) => m)
    .filter(([name]) => !['lite', 'image', 'tts', 'live', 'audio', 'thinking', 'exp'].some((w) => name.includes(w)))
    .sort((a, b) => {
      const v = Number(b[1][1]) - Number(a[1][1]);
      if (v) return v;
      const t = (m) => (!m[2] ? 0 : m[2].startsWith('-preview') ? 2 : 1);
      return t(a[1]) - t(b[1]) || a[0].length - b[0].length;
    }).map(([name]) => name);
}

/** 가장 새 Flash 부터 작은 요청으로 답하는 첫 모델(REQ-841). */
export async function pickModel(client, key, preferred = null) {
  const models = await client.listModels(key);
  const order = [...new Set([...(preferred && models.includes(preferred) ? [preferred] : []), ...flashCandidates(models)])];
  const tried = [];
  for (const model of order) {
    try {
      await client.probe(key, model);
      return { model, tried, models };
    } catch (e) {
      if (!(e instanceof GeminiError) || !['MODEL', 'QUOTA', 'REQUEST'].includes(e.failure)) throw e;
      tried.push([model, e.failure]);
    }
  }
  throw new GeminiError('NO_MODEL', '답하는 Flash 모델 없음(' + tried.map(([m, f]) => `${m} ${FAILURES[f]}`).join(', ') + ')');
}

// ── 답 → 판독 ──────────────────────────────────────────────────────────────────
function stripFence(text) {
  const t = String(text).trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```json/, '').replace(/^```/, '').replace(/```$/, '').trim();
}

const str = (v) => (typeof v === 'string' ? v : null);
const int = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 1000000 ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return null;
};

/** 답 글자 → {items, skipped}. 모양이 틀리면 GeminiError('FORMAT'). */
export function parseAnswer(text) {
  let root;
  try { root = JSON.parse(stripFence(text)); } catch { throw new GeminiError('FORMAT', '답이 JSON 이 아님'); }
  const obj = root && typeof root === 'object' && !Array.isArray(root) ? root : null;
  const array = Array.isArray(obj?.items) ? obj.items : Array.isArray(obj?.readings) ? obj.readings : Array.isArray(root) ? root : null;
  if (!array) throw new GeminiError('FORMAT', '답에 items 목록이 없음');
  const skipped = (Array.isArray(obj?.skipped) ? obj.skipped : []).filter((o) => o && typeof o === 'object')
    .map((o) => ({ reason: (str(o.reason) || 'unclear').trim().toLowerCase(), hint: str(o.box_hint) }));
  const items = array.filter((o) => o && typeof o === 'object' && !Array.isArray(o)).map((o) => {
    const product = (str(o.product) || '').toUpperCase();
    const rank = str(o.rank)?.trim();
    const kind = (str(o.kind) || '').toLowerCase();
    const box = Array.isArray(o.box) ? o.box.filter((v) => typeof v === 'number') : null;
    return {
      product: PRODUCTS_ACCEPTED.includes(product) ? product : 'OTHER', draw: int(o.draw), rank: RANKS.includes(rank) ? rank : null,
      count: int(o.count), certain: o.certain === true, kind: KINDS.includes(kind) ? kind : 'other', box: box && box.length === 4 ? box : null,
    };
  });
  return { items, skipped };
}

export function productOf(code) {
  switch (code) {
    case 'LOTTO645': return PRODUCT_LOTTO;
    case 'PENSION720': return PRODUCT_PENSION;
    case 'PENSION520': return PRODUCT_PENSION520;
    case 'SPEETTO': case 'SPEETTO1000': case 'SPEETTO2000': case 'SPEETTO500': return PRODUCT_SPEETTO;
    case 'UNKNOWN': return PRODUCT_UNKNOWN;
    default: return null;
  }
}

export function rankOf(rank) {
  if (rank == null) return null;
  if (rank === '보너스') return 'BONUS';
  return ['1', '2', '3', '4', '5'].includes(rank) ? rank : null;
}

/** 0~1 비율 상자 → 사진 화소 상자(0~1000 도 받음). 틀리면 []. */
export function boxOf(box, width, height) {
  if (!box || box.length !== 4 || width <= 0 || height <= 0) return [];
  const scale = box.some((v) => v > 1) ? 1000 : 1;
  const v = box.map((x) => Math.min(1, Math.max(0, x / scale)));
  const x0 = Math.min(v[0], v[2]), x1 = Math.max(v[0], v[2]), y0 = Math.min(v[1], v[3]), y1 = Math.max(v[1], v[3]);
  if (x1 <= x0 || y1 <= y0) return [];
  return [Math.round(x0 * width), Math.round(y0 * height), Math.round(x1 * width), Math.round(y1 * height)];
}

/**
 * 답 → 판독(GeminiWinConverter.toResult 와 같음).
 * - 토토·그 밖은 버림. certain=false → 상품·등위·명수는 모름, 회차만.
 * - 회차가 없거나 1보다 작거나 자료 마지막 회차보다 크면 「회차 못 읽음」(other 제외).
 * - 같은 (상품·등위·회차)는 한 줄(명수가 다르면 명수 모름). 같은 회차에 등위 있는 줄이 있으면 등위 모름 줄은 뺀다.
 * - 누적(cumulative, draw 없음)은 certain 이고 횟수 1~99 일 때만.
 */
export function toResult(answer, width, height, lastDrawNo = () => null) {
  const cut = answer.skipped.filter((s) => s.reason === 'edge' || s.reason === 'occluded').map((s) => ({ reason: s.reason === 'edge' ? 'edge-gemini' : 'incomplete' }));
  const readings = new Map();
  const unread = [];
  for (const item of answer.items) {
    const read = productOf(item.product);
    if (!read) continue;
    const product = item.certain ? read : PRODUCT_UNKNOWN;
    const box = boxOf(item.box, width, height);
    const last = lastDrawNo(read);
    if (item.kind === 'cumulative' && item.draw == null) {
      const n = item.count != null && item.count >= 1 && item.count <= 99 ? item.count : null;
      if (item.certain && n != null) {
        const rank = rankOf(item.rank) || '1';
        const k = `${read}|${rank}|${CUMULATIVE_DRAW}`;
        if (!readings.has(k)) readings.set(k, { reading: { product: read, rank, drawNo: CUMULATIVE_DRAW, note: CUMULATIVE_NOTE, count: n }, box });
      }
      continue;
    }
    const draw = item.draw != null && item.draw >= 1 && (last == null || item.draw <= last) ? item.draw : null;
    if (draw == null) { if (item.kind !== 'other') unread.push(box); continue; }
    const rank = item.certain ? rankOf(item.rank) : null;
    const count = item.certain && item.count != null && item.count > 0 ? item.count : null;
    const k = `${product}|${rank}|${draw}`;
    const prev = readings.get(k);
    if (!prev) readings.set(k, { reading: { product, rank, drawNo: draw, note: null, count }, box });
    else prev.reading = { ...prev.reading, count: prev.reading.count === count ? count : null };
  }
  const values = [...readings.values()];
  const kept = values.filter((r) => r.reading.rank != null
    || !values.some((o) => o !== r && o.reading.drawNo === r.reading.drawNo && o.reading.product === r.reading.product && o.reading.rank != null));
  return { readings: kept, unread, cut };
}

/**
 * 휴대폰 판독 없이 제미나이만 있을 때의 합치기 — DualReadMerger.merge(mlkit = 빈 목록)과 같음:
 * 모든 줄이 「확인 필요 · 제미나이만」, 명수는 후보로만(누적 줄은 횟수가 값이라 그대로).
 */
export function geminiOnly(readings) {
  return readings.map((r) => {
    const cumulative = r.reading.drawNo === CUMULATIVE_DRAW;
    const kept = cumulative ? r.reading : { ...r.reading, count: null };
    const note = '제미나이만' + (!cumulative && r.reading.count != null ? ` ${r.reading.count}명` : '');
    return { reading: kept, box: r.box, status: 'CHECK', note, candidateCount: cumulative ? null : r.reading.count };
  });
}
