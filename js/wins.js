// REQ-875 당첨 자료 읽기·상호 찾기·비교 — 안드로이드 앱과 같은 규칙(순수 JS, Node 시험).
//  - 자료: android data/wins/WinData.kt (WinPackage·WinDrawList), 형식 docs/ai/tasks/REQ-775-win-package.md
//  - 상호 찾기·거리: StoreSearch.kt (REQ-868·869·870·874)
//  - 상호 칸 1·2·3등: StoreWinsSummary.kt (REQ-867)
//  - 비교: WinComparator.kt (REQ-775·803·809·844), 판독 규칙 docs/ai/tasks/REQ-775-ocr-rules.md

export const PRODUCT_LOTTO = 'LOTTO645';
export const PRODUCT_PENSION = 'PENSION720';
export const PRODUCT_PENSION520 = 'PENSION520';
export const PRODUCT_SPEETTO = 'SPEETTO';
export const PRODUCT_TOTO = 'TOTO';
export const PRODUCT_UNKNOWN = 'UNKNOWN';
export const CUMULATIVE_DRAW = 0;
export const CUMULATIVE_NOTE = '누적';
const MICRO = 1000000;

export const PRODUCT_LABELS = {
  LOTTO645: '로또 6/45', PENSION720: '연금복권720+', PENSION520: '연금복권520', SPEETTO: '스피또', TOTO: '토토', UNKNOWN: '상품 모름',
};
export const PRODUCT_SHORT = { LOTTO645: '로또', PENSION720: '연금720', PENSION520: '연금520', SPEETTO: '스피또', UNKNOWN: '상품 모름' };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byKeys = (...fns) => (x, y) => {
  for (const f of fns) { const r = cmp(f(x), f(y)); if (r) return r; }
  return 0;
};

/** `"93,12,434*2"` → Map{93:1, 105:1, 539:2}; `*?` = 건수 미상(null). */
export function decodeDraws(text) {
  const result = new Map();
  if (!text || !String(text).trim()) return result;
  let draw = 0;
  for (const item of String(text).split(',')) {
    const parts = item.trim().split('*');
    const delta = Number.parseInt(parts[0], 10);
    if (!Number.isInteger(delta) || !(delta >= 1 || (result.size === 0 && delta >= 0))) throw new Error('당첨 회차 목록 형식이 올바르지 않습니다.');
    draw += delta;
    result.set(draw, parts.length === 1 ? 1 : parts[1] === '?' ? null : Number.parseInt(parts[1], 10));
  }
  return result;
}

/** 서명을 확인한 본문(wins) → 자료 객체. WinPackageParser.parseWins + WinPackage. */
export class WinPackage {
  constructor(wins) {
    this.packageId = String(wins.package_id || '').toLowerCase();
    this.generatedAt = wins.generated_at || '';
    this.groups = new Map();
    for (const g of wins.groups || []) {
      this.groups.set(g.code, {
        code: g.code, product: g.product, productLabel: g.product_label || g.product, rank: g.rank,
        rankLabel: g.rank_label || `${g.rank}등`, firstDrawNo: g.first_draw_no, lastDrawNo: g.last_draw_no, lastDrawDate: g.last_draw_date || null,
      });
    }
    this.stores = wins.stores || {};
    this.places = wins.places && typeof wins.places === 'object' ? wins.places : {};
    this.regions = new Map();
    for (const [k, v] of Object.entries(wins.regions || {})) {
      if (Array.isArray(v) && v.length === 2) this.regions.set(k, { lat: v[0] / MICRO, lng: v[1] / MICRO });
    }
    this.storeCount = wins.store_count ?? Object.keys(this.stores).length;
    this.hasPlaces = Object.keys(this.places).length > 0;
  }

  hasStore(id) { return Object.prototype.hasOwnProperty.call(this.stores, id) || Object.prototype.hasOwnProperty.call(this.places, id); }

  store(id, withDraws = true) {
    const entry = this.stores[id] && typeof this.stores[id] === 'object' ? this.stores[id] : null;
    const place = this.places[id] && typeof this.places[id] === 'object' ? this.places[id] : null;
    if (!entry && !place) return null;
    const draws = new Map();
    if (entry && withDraws) {
      for (const code of this.groups.keys()) if (typeof entry[code] === 'string') draws.set(code, decodeDraws(entry[code]));
    }
    const text = (o, k) => { const v = o && o[k]; if (v === null || v === undefined) return null; const s = String(v).trim(); return s || null; };
    const lat = place && place.y != null ? place.y : null;
    const lng = place && place.x != null ? place.x : null;
    return {
      storeId: id, name: text(entry, 'n') || text(place, 'n'), notInRegister: entry?.u === 1, draws,
      address: text(place, 'a'), point: lat != null && lng != null ? { lat: lat / MICRO, lng: lng / MICRO } : null,
      closed: place?.c === 1, alias: text(place, 'k'), listed: place !== null,
    };
  }

  storeIds() { return [...new Set([...Object.keys(this.stores), ...Object.keys(this.places)])]; }
  regionPoint(address) { const k = regionKey(address); return k ? this.regions.get(k) || null : null; }
  groupsOf(product) { return [...this.groups.values()].filter((g) => g.product === product); }
  group(product, rank) { return [...this.groups.values()].find((g) => g.product === product && g.rank === rank) || null; }
  lastDrawOf(product) { const gs = this.groupsOf(product); return gs.length ? Math.max(...gs.map((g) => g.lastDrawNo)) : null; }

  get basisDate() {
    const ds = [...this.groups.values()].map((g) => g.lastDrawDate).filter(Boolean).sort();
    return ds.length ? ds[ds.length - 1] : null;
  }

  /** 「2026-10-03 추첨분까지 · 판매점 14,100곳」 */
  get label() { return (this.basisDate ? `${this.basisDate} 추첨분까지` : '기준일 미상') + ` · 판매점 ${num(this.storeCount)}곳`; }
}

export const num = (n) => Number(n).toLocaleString('en-US');

/** 내용 요약(REQ-862) — 「로또 1244회·연금 335회까지, 판매점 14,100곳」. */
export function contentSummary(wins) {
  const lastDraws = {};
  for (const g of wins.groups || []) if (g && g.code && g.last_draw_no != null) lastDraws[g.code] = g.last_draw_no;
  const storeCount = wins.store_count ?? Object.keys(wins.stores || {}).length;
  return { lastDraws, storeCount, rowCount: wins.row_count ?? null };
}

function lottoDraw(s) { return s.lastDraws.L1 ?? maxOf(Object.entries(s.lastDraws).filter(([k]) => k.startsWith('L')).map(([, v]) => v)); }
function pensionDraw(s) { return s.lastDraws.P1 ?? maxOf(Object.entries(s.lastDraws).filter(([k]) => k.startsWith('P')).map(([, v]) => v)); }
function maxOf(list) { return list.length ? Math.max(...list) : null; }

export function summaryText(s) {
  const draws = [lottoDraw(s) != null ? `로또 ${lottoDraw(s)}회` : null, pensionDraw(s) != null ? `연금 ${pensionDraw(s)}회` : null].filter(Boolean);
  return (draws.length ? draws.join('·') + '까지, ' : '') + `판매점 ${num(s.storeCount)}곳`;
}

export function summaryChanges(now, before) {
  const ch = [];
  const l = lottoDraw(now), lb = lottoDraw(before), p = pensionDraw(now), pb = pensionDraw(before);
  if (l !== lb && l != null) ch.push(`로또 ${lb ?? '-'} → ${l}회`);
  if (p !== pb && p != null) ch.push(`연금 ${pb ?? '-'} → ${p}회`);
  if (now.storeCount !== before.storeCount) ch.push(`판매점 ${num(before.storeCount)} → ${num(now.storeCount)}곳`);
  if (!ch.length) for (const [code, d] of Object.entries(now.lastDraws)) if (before.lastDraws[code] !== d) ch.push(`${code} ${before.lastDraws[code] ?? '-'} → ${d}회`);
  if (!ch.length && now.rowCount != null && before.rowCount != null && now.rowCount !== before.rowCount) ch.push(`당첨 기록 ${num(before.rowCount)} → ${num(now.rowCount)}건`);
  return ch.length ? ch.join(', ') : `당첨 기록이 고쳐졌습니다 (${summaryText(now)})`;
}

// ── 상호 찾기(REQ-868~870·874) ────────────────────────────────────────────────
/** 주소 → 시군구 열쇠(첫 두 낱말, 세종은 「세종」). */
export function regionKey(address) {
  const tokens = String(address || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  if (tokens[0] === '세종') return '세종';
  return tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : null;
}

const SUFFIXES = ['로또복권판매점', '복권판매점', '복권판매소', '로또판매점', '복권전문점', '로또복권방', '로또복권', '복권방', '복권점',
  '로또방', '로또점', '판매점', '판매소', 'lotto645', '로또645', 'lotto', '로또', '복권', '645'];
const PREFIXES = ['로또645', 'lotto645', '로또복권', 'lotto', '로또'];

export const StoreNames = {
  /** 공백·문장부호를 빼고 영문은 소문자(한글 완성형·영문·숫자만). */
  full(text) {
    let out = '';
    for (const c of String(text || '').normalize('NFKC').toLowerCase()) {
      if ((c >= '가' && c <= '힣') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) out += c;
    }
    return out;
  },
  /** 앞뒤의 흔한 말(복권·로또·판매점·…점)을 뗀 것. 다 떼면 빈 글이 되는 상호는 full 그대로. */
  core(text) {
    const whole = StoreNames.full(text);
    let s = whole;
    let changed = true;
    while (changed && s.length) {
      changed = false;
      const suf = SUFFIXES.find((x) => s.length > x.length && s.endsWith(x));
      if (suf) { s = s.slice(0, s.length - suf.length); changed = true; }
      if (!changed && s.length >= 3 && s.endsWith('점')) { s = s.slice(0, -1); changed = true; }
    }
    const pre = PREFIXES.find((x) => s.length > x.length + 1 && s.startsWith(x));
    if (pre) s = s.slice(pre.length);
    return s || whole;
  },
};

export const MIN_QUERY = 2;
const MATCH_ORDER = byKeys((m) => m.tier, (m) => (m.closed ? 1 : 0), (m) => m.name, (m) => m.address || '', (m) => m.storeId);

export class StoreSearch {
  constructor(entries) {
    this.entries = entries;
    this.byCore = new Map();
    for (const e of entries) {
      if (!this.byCore.has(e.core)) this.byCore.set(e.core, []);
      this.byCore.get(e.core).push(e);
    }
  }

  /** REQ-869: 로또 판매점 목록의 운영 판매점만, REQ-870: 로또 자기 상호만. places 없는 옛 자료는 전부. */
  static of(data) {
    const entries = [];
    for (const id of data.storeIds()) {
      const store = data.store(id, false);
      if (!store) continue;
      if (data.hasPlaces && (!store.listed || store.closed)) continue;
      if (!store.name) continue;
      entries.push({ store, name: store.name, full: StoreNames.full(store.name), core: StoreNames.core(store.name) });
    }
    return new StoreSearch(entries);
  }

  get size() { return this.entries.length; }

  match(e, tier) { return { storeId: e.store.storeId, name: e.name, address: e.store.address, point: e.store.point, closed: e.store.closed, tier }; }

  /** 같은 상호(0)·흔한 말을 떼면 같음(1)·일부가 같음(2). 두 자보다 짧으면 찾지 않는다. */
  byName(query) {
    const qFull = StoreNames.full(query);
    const qCore = StoreNames.core(query);
    if (qCore.length < MIN_QUERY || qFull.length < MIN_QUERY) return [];
    const equal = (this.byCore.get(qCore) || []).map((e) => this.match(e, e.full === qFull ? 0 : 1));
    const seen = new Set(equal.map((m) => m.storeId));
    const partial = [];
    for (const e of this.entries) {
      if (seen.has(e.store.storeId)) continue;
      if (e.full.includes(qFull) || e.core.includes(qCore)) partial.push(this.match(e, 2));
    }
    return [...equal, ...partial].sort(MATCH_ORDER);
  }
}

const EARTH_KM = 6371.0088;
const NEAR_KM = 3.0;
const APPROX_ERROR_KM = 5.0;
const rad = (d) => (d * Math.PI) / 180;

export const StoreDistance = {
  km(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
  },
  /** 위치가 있으면 거리순(좌표 → 시군구 중심점 → 모름), 없으면 상호·주소순. */
  rank(matches, here, data) {
    if (!here) return [...matches].sort(MATCH_ORDER).map((m) => ({ match: m, distanceKm: null, approx: false }));
    return matches.map((m) => {
      if (m.point) return { match: m, distanceKm: StoreDistance.km(here, m.point), approx: false };
      const approx = data ? data.regionPoint(m.address) : null;
      if (approx) return { match: m, distanceKm: StoreDistance.km(here, approx), approx: true };
      return { match: m, distanceKm: null, approx: false };
    }).sort(byKeys((r) => (r.distanceKm == null ? 1 : 0), (r) => r.distanceKm ?? 0, (r) => (r.match.closed ? 1 : 0), (r) => r.match.tier, (r) => r.match.name));
  },
  /** 맨 앞이 「가장 가까움」이라 할 만큼 뚜렷한가(좌표 거리, 둘째보다 1km 이상·두 배 이상). */
  clearlyNearest(ranked) {
    const first = ranked[0];
    if (!first || first.distanceKm == null || first.approx) return false;
    const second = ranked[1];
    if (!second) return true;
    if (second.distanceKm == null) return first.distanceKm <= NEAR_KM;
    const margin = Math.max(1.0, first.distanceKm) + (second.approx ? APPROX_ERROR_KM : 0);
    return second.distanceKm - first.distanceKm >= margin;
  },
  /** 「0.4km」·「12km」·「약 12km(시군구 기준)」 */
  text(r) {
    if (r.distanceKm == null) return null;
    const t = r.distanceKm < 10 ? `${r.distanceKm.toFixed(1)}km` : `${num(Math.round(r.distanceKm))}km`;
    return r.approx ? `약 ${t}(시군구 기준)` : t;
  },
};

/**
 * REQ-869: 판매점ID가 폐업했거나 로또 판매점 목록에 없으면 안내 한 줄(당첨 확인으로 넘어가지 않음). 판단할 수 없으면 null.
 */
export function storeBlockNotice(data, storeId) {
  if (!data || !/^\d{8}$/.test(storeId) || !data.hasPlaces) return null;
  const s = data.store(storeId, false);
  if (!s || !s.listed) return `로또 판매점 목록에 없는 판매점입니다 (판매점ID ${storeId})`;
  if (s.closed) return `폐업한 판매점입니다 (판매점ID ${storeId} · ${s.name || '상호 없음'})`;
  return null;
}

// ── 상호 칸 1·2·3등(REQ-867) ─────────────────────────────────────────────────
export const NO_LOTTO_WINS = '로또 1·2·3등 당첨 기록 없음';
export const SUMMARY_LIMIT = 6;

function rankWins(store, code, label) {
  const m = store?.draws?.get(code) || new Map();
  const draws = [...m.entries()].sort((a, b) => b[0] - a[0]);
  return { code, label, wins: draws.reduce((s, [, c]) => s + (c ?? 1), 0), draws, unknownCount: draws.some(([, c]) => c == null) };
}

export function rankWinsText(r, limit = null) {
  if (!r.draws.length) return `${r.label} 없음`;
  const shown = limit != null && r.draws.length > limit ? r.draws.slice(0, limit) : r.draws;
  const list = shown.map(([d, c]) => (c == null ? `${d}` : c > 1 ? `${d}×${c}` : `${d}`)).join('·');
  const hidden = r.draws.length - shown.length;
  return `${r.label} ${r.wins}회${r.unknownCount ? '(건수 미상 포함)' : ''} (${list}${hidden > 0 ? ` …외 ${hidden}회` : '회'})`;
}

export function storeWinsSummary(store) {
  const lotto = [['L1', '1등'], ['L2', '2등'], ['L3', '3등']].map(([c, l]) => rankWins(store, c, l));
  const pension = [['P1', '1등'], ['P2', '2등'], ['PB', '보너스']].map(([c, l]) => rankWins(store, c, l));
  const hasLotto = lotto.some((r) => r.draws.length);
  return {
    lotto, pension, hasLotto,
    lottoLines: (limit = SUMMARY_LIMIT) => (hasLotto ? lotto.map((r) => rankWinsText(r, limit)) : [NO_LOTTO_WINS]),
    pensionLine: (limit = SUMMARY_LIMIT) => {
      const p = pension.filter((r) => r.draws.length);
      return p.length ? p.map((r) => rankWinsText(r, limit)).join(' · ') : null;
    },
    collapsed: (limit = SUMMARY_LIMIT) => [...lotto, ...pension].some((r) => r.draws.length > limit),
    countsText: () => (hasLotto ? lotto.map((r) => (r.draws.length ? `${r.label} ${r.wins}회` : `${r.label} 없음`)).join(' · ') : NO_LOTTO_WINS),
  };
}

// ── 비교(WinComparator) ───────────────────────────────────────────────────────
export const VERDICT_LABELS = {
  MATCH: '일치', MATCH_COUNT_UNKNOWN: '일치(건수 미상)', COUNT_MISMATCH: '명수 다름(확인 필요)', NOT_IN_RECORD: '기록에 없음(확인 필요)',
  UNVERIFIABLE: '확인 불가', NOT_COMPARED: '비교 안 함(4·5등 자료 없음)', CHECK_NEEDED: '확인 필요',
};
const NOT_COMPARED_RANKS = new Set(['4', '5']);
const LOTTO_FIRST_PRIZE_FIRST_DRAW = 2;

const line = (reading, verdict, recordedCount, note) => ({ reading, verdict, verdictLabel: VERDICT_LABELS[verdict], recordedCount, note });
const isCumulative = (r) => r.drawNo === CUMULATIVE_DRAW;
const rankOrder = (g) => (/^\d+$/.test(g.rank) ? Number(g.rank) : Number.MAX_SAFE_INTEGER);

export function coversAllWins(group) {
  return group.firstDrawNo <= 1 || (group.product === PRODUCT_LOTTO && group.rank === '1' && group.firstDrawNo <= LOTTO_FIRST_PRIZE_FIRST_DRAW);
}

export function oneDigitApart(a, b) {
  if (a.length === b.length) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n === 1; }
  if (Math.abs(a.length - b.length) === 1) {
    const [s, l] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < l.length; i++) if (l.slice(0, i) + l.slice(i + 1) === s) return true;
  }
  return false;
}

export function suggestion(data, store, product, drawNo) {
  if (!store) return null;
  const codes = new Set(data.groupsOf(product).map((g) => g.code));
  const recorded = new Set();
  for (const [code, m] of store.draws) if (codes.has(code)) for (const d of m.keys()) recorded.add(d);
  const read = String(drawNo);
  const near = [...recorded].sort((a, b) => a - b).filter((d) => d !== drawNo && oneDigitApart(read, String(d)));
  return near.length ? '혹시 ' + near.map((d) => `${d}회`).join(', ') + '?' : null;
}

function outOfRangeNote(group, drawNo) {
  if (drawNo < group.firstDrawNo) return `자료 기준: ${group.productLabel} ${group.rankLabel}은 ${group.firstDrawNo}회부터`;
  return `자료 기준: ${group.productLabel} ${group.rankLabel} ${group.lastDrawNo}회` + (group.lastDrawDate ? `(${group.lastDrawDate})` : '') + '까지';
}

function matched(reading, count, note) {
  const read = reading.count ?? null;
  const verdict = count == null ? 'MATCH_COUNT_UNKNOWN' : read != null && read !== count ? 'COUNT_MISMATCH' : 'MATCH';
  return line(reading, verdict, count ?? null, note);
}

function compareCumulative(data, store, reading) {
  const product = reading.product === PRODUCT_UNKNOWN ? PRODUCT_LOTTO : reading.product;
  const group = data.group(product, reading.rank || '1');
  if (!group) return line(reading, 'UNVERIFIABLE', null, '이 상품·등위의 당첨 자료가 없음');
  const all = store?.draws?.get(group.code) || new Map();
  const draws = [...all.entries()].filter(([d]) => d <= group.lastDrawNo);
  const recorded = draws.reduce((s, [, c]) => s + (c ?? 1), 0);
  const unknownCounts = draws.some(([, c]) => c == null);
  const full = coversAllWins(group);
  const basis = `등록 자료 ${group.rankLabel} ${recorded}건(${group.lastDrawNo}회까지` + (!full ? `, ${group.firstDrawNo}회부터` : '') + ')';
  const read = reading.count;
  if (read == null) return line(reading, 'CHECK_NEEDED', recorded, `누적 횟수 모름 — ${basis}`);
  if (read === recorded && !unknownCounts) return line(reading, 'MATCH', recorded, basis);
  if (read === recorded) return line(reading, 'MATCH_COUNT_UNKNOWN', recorded, basis);
  if (recorded < read && !full) return line(reading, 'CHECK_NEEDED', recorded, `확인 필요 — ${basis}`);
  if (recorded < read) return line(reading, 'COUNT_MISMATCH', recorded, `${basis} — 안내문 ${read}번보다 적음`);
  return line(reading, 'COUNT_MISMATCH', recorded, `${basis} — 안내문 ${read}번보다 많음(옛 안내문)`);
}

/** 한 줄 비교. reading = {product, rank(null=모름), drawNo, note, count}. 거짓이라 단정하지 않는다. */
export function compareOne(data, store, reading) {
  if (isCumulative(reading)) return compareCumulative(data, store, reading);
  if ([PRODUCT_SPEETTO, PRODUCT_PENSION520, PRODUCT_TOTO].includes(reading.product)) return line(reading, 'UNVERIFIABLE', null, '당첨 자료에 없는 상품');
  const rank = reading.rank ?? null;
  if (NOT_COMPARED_RANKS.has(rank) && (reading.product === PRODUCT_LOTTO || reading.product === PRODUCT_UNKNOWN)) {
    return line(reading, 'NOT_COMPARED', null, `${rank}등 자료 없음`);
  }
  if (rank != null && reading.product !== PRODUCT_UNKNOWN) {
    const group = data.group(reading.product, rank);
    if (!group) return line(reading, 'UNVERIFIABLE', null, '이 상품·등위의 당첨 자료가 없음');
    if (!(reading.drawNo >= group.firstDrawNo && reading.drawNo <= group.lastDrawNo)) return line(reading, 'UNVERIFIABLE', null, outOfRangeNote(group, reading.drawNo));
    const draws = store?.draws?.get(group.code) || new Map();
    if (draws.has(reading.drawNo)) return matched(reading, draws.get(reading.drawNo), null);
    const elsewhere = data.groupsOf(reading.product).filter((g) => g.code !== group.code && store?.draws?.get(g.code)?.has(reading.drawNo));
    const note = elsewhere.length ? '기록엔 ' + elsewhere.map((g) => g.rankLabel).join(', ') : suggestion(data, store, reading.product, reading.drawNo);
    return line(reading, 'NOT_IN_RECORD', null, note);
  }
  const groups = reading.product === PRODUCT_UNKNOWN ? [...data.groupsOf(PRODUCT_LOTTO), ...data.groupsOf(PRODUCT_PENSION)] : data.groupsOf(reading.product);
  const wanted = rank == null ? groups : groups.filter((g) => g.rank === rank);
  if (!wanted.length) return line(reading, 'UNVERIFIABLE', null, '이 상품의 당첨 자료가 없음');
  const missing = reading.product === PRODUCT_UNKNOWN ? '상품 미확인' : '등위 미확인';
  const found = wanted.filter((g) => store?.draws?.get(g.code)?.has(reading.drawNo)).sort((a, b) => rankOrder(a) - rankOrder(b));
  if (found.length) {
    const counts = found.map((g) => store.draws.get(g.code).get(reading.drawNo));
    const total = found.length > 1 || counts.some((c) => c == null) ? null : counts[0];
    const labels = found.map((g, i) => (reading.product === PRODUCT_UNKNOWN ? `${g.productLabel} ${g.rankLabel}` : g.rankLabel)
      + (found.length > 1 && counts[i] != null ? ` ${counts[i]}건` : '')).join(', ');
    return matched(reading, total, `${missing}: 기록엔 ${labels}`);
  }
  const uncovered = wanted.filter((g) => !(reading.drawNo >= g.firstDrawNo && reading.drawNo <= g.lastDrawNo));
  if (uncovered.length) {
    const byLabel = new Map();
    for (const g of uncovered) { if (!byLabel.has(g.productLabel)) byLabel.set(g.productLabel, []); byLabel.get(g.productLabel).push(g); }
    const parts = [...byLabel.entries()].map(([label, list]) => label + ' ' + [...new Set(list.map((g) => (reading.drawNo < g.firstDrawNo
      ? `${g.rankLabel}은 ${g.firstDrawNo}회부터` : `${g.lastDrawNo}회` + (g.lastDrawDate ? `(${g.lastDrawDate})` : '') + '까지')))].join(', '));
    return line(reading, 'UNVERIFIABLE', null, `${missing} — 자료 기준: ` + parts.join(' / '));
  }
  const hint = reading.product === PRODUCT_UNKNOWN ? null : suggestion(data, store, reading.product, reading.drawNo);
  return line(reading, 'NOT_IN_RECORD', null, [`${missing} — 어느 등위에도 없음`, hint].filter(Boolean).join(' · '));
}

export function compare(data, storeId, readings) {
  const store = data.store(storeId);
  return readings.map((r) => compareOne(data, store, r));
}

/** 합친 뒤 등위·상품을 모르는 줄에 자료의 등위를 힌트로 — 「자료엔 2등」(자동으로 채우지 않음). */
export function dataHint(data, storeId, reading) {
  if (!data || (reading.rank != null && reading.product !== PRODUCT_UNKNOWN)) return null;
  const store = data.store(storeId);
  if (!store) return null;
  const groups = reading.product === PRODUCT_UNKNOWN ? [...data.groupsOf(PRODUCT_LOTTO), ...data.groupsOf(PRODUCT_PENSION)] : data.groupsOf(reading.product);
  const found = groups.filter((g) => store.draws.get(g.code)?.has(reading.drawNo));
  if (!found.length) return null;
  return '자료엔 ' + found.map((g) => (reading.product === PRODUCT_UNKNOWN ? `${g.productLabel} ${g.rankLabel}` : g.rankLabel)).join(', ');
}

/** 「1239회 3등」·「누적 8번 1등」 */
export function readingLabel(r, withProduct = false) {
  const head = withProduct ? (PRODUCT_SHORT[r.product] || r.product) + ' ' : '';
  const draw = r.drawNo === CUMULATIVE_DRAW ? `누적 ${r.count ?? '?'}번 ` : `${r.drawNo}회 `;
  const rank = r.rank == null ? '등위 모름' : r.rank === 'BONUS' ? '보너스' : `${r.rank}등`;
  return head + draw + rank;
}
