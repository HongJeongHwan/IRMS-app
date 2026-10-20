// REQ-875 당첨 확인 웹앱(iPhone, 홈 화면에 추가) — 화면과 흐름. 규칙은 crypto.js·wins.js·binding.js·gemini.js·records.js.
// 안드로이드 당첨 확인 전용버전(1.0.41)과 같은 순서: 사용자 연결 → 당첨 자료 → ① 판매점 → ② 당첨 기록(사진·줄) → 판정 → 기록 보내기.
// 휴대폰은 IRMS 에 닿지 않는다(사설망). 자료는 같은 GitHub Pages 의 data/ 에서 받고, 사진은 제미나이를 켠 경우에만 구글로 간다.

import * as C from './crypto.js';
import * as W from './wins.js';
import * as B from './binding.js';
import * as G from './gemini.js';
import * as DB from './db.js';
import * as R from './records.js';
import { VERSION, VERSION_CODE, DATA_BASE, SERVER_PUBLIC_KEY_BASE64, RECORD_PUBLIC_KEY_BASE64 } from './config.js';

const $ = (id) => document.getElementById(id);
const nowSec = () => Math.floor(Date.now() / 1000);
const NEED_KEY_MESSAGE = '처음 한 번 IRMS 화면의 자료 열쇠 QR을 [열쇠 QR 찍기]로 찍어 주세요';
const KEY_CHANGED_MESSAGE = '자료 열쇠가 바뀌었습니다. IRMS 화면의 자료 열쇠 QR을 다시 찍어 주세요.';
const ALREADY_CURRENT = '이미 최신 당첨 자료입니다';
const LOCATION_REASON = '같은 상호의 판매점이 여럿입니다. 지금 위치에서 가까운 순으로 보여 드리려고 위치를 씁니다. 위치는 이 휴대폰 안에서 거리를 재는 데만 쓰고 어디에도 보내지 않습니다.';
const GEMINI_NOTICE = '제미나이로 읽기를 켜면 당첨 기록 사진이 구글 서버(Gemini API)로 보내져 읽힙니다. 사진에 사람 얼굴·개인정보가 찍히지 않게 당첨 기록만 가까이 찍어 주세요. 무료 키는 구글이 보낸 내용을 서비스 개선에 쓸 수 있습니다. 키는 이 휴대폰에만 저장됩니다.';
const STORE_LIST_LIMIT = 30;
const SAVE_DELAY_MS = 2000;
const appInfo = () => ({ versionName: `pwa-${VERSION}`, versionCode: VERSION_CODE, winCheckOnly: true, platform: 'ios-pwa' });

const S = {
  pub: null,
  device: null,
  binding: null,
  lastSeen: 0,
  view: B.bindingView(null, nowSec()),
  data: null,
  winsMeta: null,
  needKeyId: null,
  dataNotice: null,
  dataNoticeError: false,
  downloading: false,
  searchIndex: null,
  storeInput: '',
  storeId: '',
  search: null,
  searching: false,
  similarOpen: false,
  location: 'IDLE',
  here: null,
  locationNote: null,
  photos: [],
  rows: [],
  nextRowId: 1,
  editing: null,
  session: null,
  gemini: { key: null, enabled: true, model: '', ack: false },
  readingPhoto: false,
  logEntries: [],
  swReg: null,
};

// ── 작은 도구 ──────────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const mount = (id, ...nodes) => { const el = $(id); el.replaceChildren(...nodes.flat().filter(Boolean)); };

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function showModal(title, ...body) {
  $('modalTitle').textContent = title;
  mount('modalBody', ...body);
  $('modal').hidden = false;
}

let modalCleanup = null;
function closeModal() {
  $('modal').hidden = true;
  $('modalBody').replaceChildren();
  if (modalCleanup) { const f = modalCleanup; modalCleanup = null; f(); }
}

const productShort = (p) => W.PRODUCT_SHORT[p] || p;
const rankText = (r) => (r == null ? '등위 모름' : r === 'BONUS' ? '보너스' : `${r}등`);

function rowLabel(r) {
  if (r.drawNo === W.CUMULATIVE_DRAW) return `${productShort(r.product)} ${rankText(r.rank)} 누적 ${r.count ?? '?'}번`;
  return `${productShort(r.product)} ${r.drawNo}회 ${rankText(r.rank)}` + (r.count != null ? ` ${r.count}명` : '');
}

function verdictBadge(verdict) {
  const cls = { MATCH: 'badge-ok', MATCH_COUNT_UNKNOWN: 'badge-ok', COUNT_MISMATCH: 'badge-warn', NOT_IN_RECORD: 'badge-bad',
    UNVERIFIABLE: 'badge-grey', NOT_COMPARED: 'badge-grey', CHECK_NEEDED: 'badge-warn' }[verdict] || 'badge-grey';
  return h('span', { class: `badge ${cls}` }, W.VERDICT_LABELS[verdict]);
}

// ── 사용자 연결 ────────────────────────────────────────────────────────────────
async function evaluateBinding() {
  const now = nowSec();
  S.view = B.bindingView(S.binding, now, S.lastSeen);
  if (S.view.notice !== B.CLOCK_NOTICE && now > S.lastSeen) {
    S.lastSeen = now;
    try { await DB.kvSet('lastSeen', now); } catch { /* 저장 못 해도 계속 */ }
  }
}

function renderUser() {
  const v = S.view;
  const buttons = h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: S.binding ? 'btn btn-small' : 'btn btn-primary', onclick: openScanner }, S.binding ? '사용자 바꾸기' : '열쇠 QR 찍기'));
  const cls = v.blocked ? 'card card-bad' : v.warning ? 'card card-warn' : 'card';
  mount('userCard', h('section', { class: cls },
    v.label ? h('div', { class: 'user-line' }, h('span', { class: 'user-name' }, v.label), h('span', { class: 'user-until' }, v.until)) : null,
    v.notice ? h('p', { class: `notice ${v.blocked ? 'bad' : 'warn'}` }, v.notice) : null,
    buttons));
}

// ── 당첨 자료 ──────────────────────────────────────────────────────────────────
function renderData() {
  const label = S.data ? S.data.label : S.winsMeta ? S.winsMeta.label : null;
  const blocked = S.view.blocked;
  const notice = S.dataNotice || (!blocked && S.needKeyId ? (S.winsMeta ? KEY_CHANGED_MESSAGE : NEED_KEY_MESSAGE) : null)
    || (!blocked && !S.winsMeta && !S.downloading ? '당첨 자료가 아직 없습니다. [자료 새로 받기]를 눌러 주세요.' : null);
  mount('dataCard', h('section', { class: 'card' },
    h('div', { class: 'card-row' },
      h('div', {}, h('div', { class: 'field-label' }, '당첨 자료'), h('div', { class: 'row-value' }, label || '없음')),
      h('button', { type: 'button', class: 'btn btn-small', disabled: blocked || S.downloading, onclick: downloadWins },
        S.downloading ? h('span', { class: 'spinner' }) : null, '자료 새로 받기')),
    notice ? h('p', { class: `notice ${S.dataNoticeError ? 'bad' : ''}` }, notice) : null));
}

async function loadStoredWins() {
  S.data = null;
  S.searchIndex = null;
  S.winsMeta = (await DB.get('wins', 'current')) || null;
  if (!S.winsMeta) return;
  if (S.view.blocked) return; // REQ-854: 막힌 동안은 자료를 열지 않는다
  const key = await DB.get('keys', S.winsMeta.keyId);
  if (!key) { S.needKeyId = S.winsMeta.keyId; return; }
  S.needKeyId = null;
  try {
    const plain = await C.decryptBundle(S.winsMeta.blob, key, S.winsMeta.keyId, S.winsMeta.packageId);
    const raw = await C.gunzipIfNeeded(plain);
    const root = JSON.parse(C.fromUtf8(raw));
    S.data = new W.WinPackage(root.wins);
    setTimeout(() => ensureIndex(), 50); // REQ-874: 상호 찾기 색인을 미리
  } catch (e) {
    S.dataNotice = e.message || '저장된 당첨 자료를 열지 못했습니다.';
    S.dataNoticeError = true;
  }
}

async function fetchBytes(url, maxBytes) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error('깃허브에 연결하지 못했습니다. 인터넷(와이파이·데이터) 연결을 확인해 주세요.');
  }
  if (res.status === 404) throw new Error('깃허브에 올린 당첨 자료가 아직 없습니다.');
  if (!res.ok) throw new Error(`깃허브가 당첨 자료를 주지 않았습니다. (응답 ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error('깃허브의 당첨 자료 파일이 너무 큽니다.');
  return buf;
}

/** [자료 새로 받기] — 요약 → 서명 → (이미 최신이면 끝) → 열쇠 → 암호문 → 크기·SHA-256 → 풀기 → 안쪽 서명 → 넣기. */
async function downloadWins() {
  if (S.view.blocked) { toast(S.view.notice); return; }
  if (S.downloading) return;
  S.downloading = true;
  S.dataNotice = '깃허브에서 새 당첨 자료를 확인하는 중…';
  S.dataNoticeError = false;
  renderData();
  try {
    const latest = await C.parseLatest(await fetchBytes(`${DATA_BASE}wins-latest.json`, C.MAX_LATEST_BYTES), S.pub);
    const stored = S.winsMeta;
    if (stored && S.data && stored.generatedAt >= latest.generatedAt) {
      S.dataNotice = `${ALREADY_CURRENT} (${W.summaryText(stored.summary)})`;
      return;
    }
    const key = await DB.get('keys', latest.keyId);
    if (!key) {
      S.needKeyId = latest.keyId;
      S.dataNotice = stored ? KEY_CHANGED_MESSAGE : NEED_KEY_MESSAGE;
      S.dataNoticeError = true;
      return;
    }
    S.dataNotice = '당첨 자료를 받는 중…';
    renderData();
    const blob = await fetchBytes(`${DATA_BASE}${latest.file}`, C.MAX_DATA_BYTES);
    await C.checkBlob(blob, latest);
    const plain = await C.decryptBundle(blob, key, latest.keyId, latest.packageId);
    const wins = await C.verifyWinsFile(plain, S.pub);
    if (stored && stored.packageId !== wins.package_id && stored.generatedAt > wins.generated_at) {
      throw new Error('지금 앱에 있는 당첨 자료보다 오래된 파일입니다.');
    }
    const summary = W.contentSummary(wins);
    const cid = await C.contentId(wins);
    const pkg = new W.WinPackage(wins);
    const meta = { packageId: wins.package_id, generatedAt: wins.generated_at, keyId: latest.keyId, blob, label: pkg.label, contentId: cid, summary };
    await DB.put('wins', 'current', meta);
    const same = stored && stored.contentId === cid;
    S.winsMeta = meta;
    S.data = pkg;
    S.searchIndex = null;
    S.needKeyId = null;
    S.dataNotice = same || (stored && stored.packageId === meta.packageId) ? `${ALREADY_CURRENT} (${W.summaryText(summary)})`
      : stored ? `새 당첨 자료를 넣었습니다 — ${W.summaryChanges(summary, stored.summary)}` : `새 당첨 자료를 넣었습니다 (${W.summaryText(summary)})`;
    setTimeout(() => ensureIndex(), 50);
    rerunStore();
  } catch (e) {
    S.dataNotice = e.message || '당첨 자료를 받지 못했습니다.';
    S.dataNoticeError = true;
  } finally {
    S.downloading = false;
    renderAll();
  }
}

// ── 자료 열쇠 QR ───────────────────────────────────────────────────────────────
function openScanner() {
  let stream = null;
  let stopped = false;
  const video = h('video', { class: 'scan-video', playsinline: true, muted: true, autoplay: true });
  video.muted = true;
  const status = h('p', { class: 'hint' }, 'PC 화면의 자료 열쇠 QR을 네모 안에 맞춰 주세요.');
  const error = h('p', { class: 'error-text', role: 'alert' });
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const stop = () => { stopped = true; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  modalCleanup = stop;

  const pasteArea = h('textarea', { class: 'input', placeholder: 'irmskey:v2:… (QR을 찍을 수 없을 때 글자를 붙여 넣기)' });
  const photoInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    status.textContent = '사진에서 QR을 찾는 중…';
    const text = await decodeQrFromFile(file);
    if (text) { stop(); onQrText(text); } else { error.textContent = '사진에서 QR을 찾지 못했습니다. QR이 화면 가운데에 크게 나오게 다시 찍어 주세요.'; status.textContent = ''; }
  } });

  showModal('자료 열쇠 QR 찍기',
    h('div', { class: 'scan-wrap' }, video, h('div', { class: 'scan-frame' })),
    status, error,
    h('div', { class: 'btn-row' },
      h('label', { class: 'btn file-btn' }, '사진으로 찍기', photoInput),
      h('button', { type: 'button', class: 'btn', onclick: () => { stop(); closeModal(); } }, '닫기')),
    h('details', {}, h('summary', { class: 'hint' }, 'QR 글자 붙여 넣기'), pasteArea,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => { const t = pasteArea.value.trim(); if (t) { stop(); onQrText(t); } } }, '확인')));

  const tick = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
      if (code && code.data) { stop(); onQrText(code.data); return; }
    }
    setTimeout(() => requestAnimationFrame(tick), 120);
  };

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    error.textContent = '이 브라우저에서는 카메라를 바로 쓸 수 없습니다. [사진으로 찍기]를 눌러 주세요.';
    return;
  }
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false })
    .then((s) => {
      if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      video.srcObject = s;
      video.play().catch(() => {});
      tick();
    })
    .catch(() => { error.textContent = '카메라를 쓰지 못했습니다(권한 없음). [사진으로 찍기]를 누르거나, 설정 › Safari › 카메라에서 허용해 주세요.'; });
}

async function decodeQrFromFile(file) {
  const img = await loadImage(file);
  if (!img || !window.jsQR) return null;
  for (const size of [1200, 800, 1800, 600]) {
    const scale = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) return code.data;
  }
  return null;
}

async function onQrText(text) {
  if (!C.looksLikeKeyQr(text)) {
    showModal('자료 열쇠 QR', h('p', { class: 'error-text' }, '자료 열쇠 QR이 아닙니다. PC 「모바일 앱 › 앱 설치」의 [열쇠 QR 보이기]로 나온 QR을 찍어 주세요.'),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { closeModal(); openScanner(); } }, '다시 찍기'),
        h('button', { type: 'button', class: 'btn', onclick: closeModal }, '닫기')));
    return;
  }
  let checked;
  try {
    checked = await C.checkKeyQr(text, S.pub, nowSec());
  } catch (e) {
    showModal('자료 열쇠 QR', h('p', { class: 'error-text' }, e.message),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { closeModal(); openScanner(); } }, '다시 찍기'),
        h('button', { type: 'button', class: 'btn', onclick: closeModal }, '닫기')));
    return;
  }
  const pin = h('input', { class: 'input pin-input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'one-time-code', 'aria-label': 'PIN 6자리' });
  const err = h('p', { class: 'error-text', role: 'alert' });
  const ok = h('button', { type: 'submit', class: 'btn btn-primary' }, '확인');
  const who = checked.user ? h('p', { class: 'hint' }, `사용자: ${B.bindingLabel(checked.user)}`) : null;
  const form = h('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    err.textContent = '';
    ok.disabled = true;
    ok.replaceChildren(h('span', { class: 'spinner' }), ' 여는 중…');
    try {
      const opened = await C.openKeyQr(text, pin.value.trim(), S.pub, nowSec());
      await DB.put('keys', opened.keyId, opened.key);
      if (opened.user) {
        S.binding = opened.user;
        await DB.kvSet('binding', C.bindingToCompact(opened.user));
      }
      closeModal();
      await evaluateBinding();
      const name = opened.user ? `${opened.user.name}님으로 연결했습니다. ` : '';
      S.dataNotice = name + '자료 열쇠를 받았습니다.';
      S.dataNoticeError = !opened.user;
      S.needKeyId = null;
      await loadStoredWins();
      renderAll();
      if (!S.data && !S.view.blocked) downloadWins();
    } catch (e) {
      err.textContent = e.message;
      ok.disabled = false;
      ok.textContent = '확인';
    }
  } }, h('label', { class: 'field-label' }, 'PC 화면의 QR 옆 PIN 6자리'), pin, err, who, h('div', { class: 'btn-row' }, ok,
    h('button', { type: 'button', class: 'btn', onclick: closeModal }, '취소')));
  showModal('PIN 넣기', form);
  setTimeout(() => pin.focus(), 50);
}

// ── ① 판매점 ──────────────────────────────────────────────────────────────────
const storeIdValid = () => /^\d{8}$/.test(S.storeId);
const blockNotice = () => W.storeBlockNotice(S.data, S.storeId);
const storeReady = () => storeIdValid() && !blockNotice();
const canJudge = () => !!S.data && storeReady() && !S.view.blocked;

function ensureIndex() {
  if (!S.searchIndex && S.data) S.searchIndex = W.StoreSearch.of(S.data);
  return S.searchIndex;
}

let searchTimer = null;
function onStoreInput(value) {
  ensureSession();
  clearTimeout(searchTimer);
  if (/\p{L}/u.test(value)) {
    S.storeInput = value;
    S.storeId = '';
    S.searching = true;
    renderStore();
    searchTimer = setTimeout(() => searchByName(value), 250);
    return;
  }
  S.storeInput = '';
  S.search = null;
  S.storeId = value.replace(/\D/g, '').slice(0, 8);
  renderStore();
  renderRows();
  scheduleSave();
}

function searchByName(value) {
  S.searching = false;
  if (!S.data) { S.search = null; renderStore('당첨 자료가 없어 상호로 찾을 수 없습니다. 판매점ID를 넣어 주세요.'); return; }
  if (W.StoreNames.core(value).length < W.MIN_QUERY) { S.search = null; renderStore(); return; }
  const matches = ensureIndex().byName(value);
  S.similarOpen = false;
  S.search = { query: value.trim(), matches };
  const exact = matches.filter((m) => m.tier === 0);
  const single = exact.length ? (exact.length === 1 ? exact[0] : null) : matches.length === 1 ? matches[0] : null;
  S.storeId = single ? single.storeId : '';
  if (!S.storeId && matches.length >= 2 && S.data.hasPlaces) maybeAutoLocate();
  renderStore();
  renderRows();
  scheduleSave();
}

function rerunStore() {
  if (S.storeInput && S.data) searchByName(S.storeInput);
}

function chooseStore(id) {
  ensureSession();
  S.storeId = id;
  renderStore();
  renderRows();
  scheduleSave();
}

async function maybeAutoLocate() {
  if (S.location === 'KNOWN' || S.location === 'LOCATING') return;
  if (await DB.kvGet('locationAllowed', false)) locate();
}

function locate() {
  if (!navigator.geolocation) { S.location = 'UNAVAILABLE'; S.locationNote = '이 브라우저는 위치를 지원하지 않음'; renderStore(); return; }
  S.location = 'LOCATING';
  renderStore();
  navigator.geolocation.getCurrentPosition((pos) => {
    S.here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    S.location = 'KNOWN';
    S.locationNote = pos.coords.accuracy > 500 ? `오차 약 ${Math.round(pos.coords.accuracy / 100) / 10}km` : null;
    DB.kvSet('locationAllowed', true).catch(() => {});
    renderStore();
  }, (err) => {
    S.location = err.code === 1 ? 'DENIED' : 'UNAVAILABLE';
    S.locationNote = err.code === 3 ? '시간 초과' : null;
    if (err.code === 1) DB.kvSet('locationAllowed', false).catch(() => {});
    renderStore();
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 });
}

function locationLine() {
  switch (S.location) {
    case 'LOCATING': return '위치를 확인하는 중… 그동안은 상호·주소순입니다. 위치가 잡히면 가까운 순으로 바뀝니다.';
    case 'KNOWN': return '지금 위치에서 가까운 순입니다' + (S.locationNote ? ` (${S.locationNote})` : '') + '. 주소를 보고 눌러서 고르세요.';
    case 'DENIED': return '위치를 쓰지 않아 상호·주소순입니다. 주소를 보고 눌러서 고르세요. (설정 › 개인정보 보호 › 위치 서비스 › Safari 웹 사이트에서 허용할 수 있습니다.)';
    case 'UNAVAILABLE': return '위치를 얻지 못해 상호·주소순입니다' + (S.locationNote ? ` (${S.locationNote})` : '') + '. 주소를 보고 눌러서 고르세요.';
    default: return null;
  }
}

function storeRows(rows) {
  const nearest = W.StoreDistance.clearlyNearest(rows);
  const items = rows.slice(0, STORE_LIST_LIMIT).map((r, i) => {
    const m = r.match;
    const selected = m.storeId === S.storeId;
    return h('button', { type: 'button', class: `choice${selected ? ' selected' : ''}`, 'aria-pressed': selected ? 'true' : 'false', onclick: () => chooseStore(m.storeId) },
      h('div', { class: 'c-name' }, m.name, i === 0 && nearest && rows.length >= 2 ? h('span', { class: 'badge badge-line' }, '가장 가까움') : null,
        m.closed ? h('span', { class: 'badge badge-bad' }, '운영 안 함') : null),
      h('div', { class: 'c-addr' }, [m.address || '주소 없음', W.StoreDistance.text(r)].filter(Boolean).join(' · ')),
      h('div', { class: 'c-id' }, `판매점ID ${m.storeId}`));
  });
  if (rows.length > STORE_LIST_LIMIT) items.push(h('p', { class: 'hint' }, `그 밖에 ${rows.length - STORE_LIST_LIMIT}곳 — 상호를 더 자세히 넣어 주세요.`));
  return items;
}

function renderSearch() {
  const search = S.search;
  if (!search) return null;
  const ranked = W.StoreDistance.rank(search.matches, S.location === 'KNOWN' ? S.here : null, S.data);
  const same = ranked.filter((r) => r.match.tier === 0);
  const similar = ranked.filter((r) => r.match.tier > 0);
  const head = same.length || !ranked.length ? `상호 「${search.query}」와 같은 상호 ${same.length}곳` : `상호 「${search.query}」와 같은 상호는 없고 비슷한 상호 ${ranked.length}곳`;
  const box = h('div', { class: 'search-box' }, h('div', { class: 'search-head' }, head),
    h('p', { class: 'hint' }, '로또 판매점 목록의 운영 중인 판매점에서 찾습니다. 폐업한 판매점은 판매점ID를 넣어 주세요.'));
  if (!ranked.length) { box.append(h('p', { class: 'error-text' }, '같은 상호를 찾지 못했습니다. 상호를 다르게 넣거나 판매점ID를 넣어 주세요.')); return box; }
  if (ranked.length >= 2) {
    if (!S.data.hasPlaces) box.append(h('p', { class: 'hint' }, '이 당첨 자료에는 판매점 주소가 없습니다. [자료 새로 받기] 뒤에 다시 찾으면 주소·거리가 보입니다.'));
    else if (S.location === 'IDLE') box.append(h('p', { class: 'hint' }, LOCATION_REASON), h('button', { type: 'button', class: 'btn btn-block', onclick: locate }, '위치 허용하고 가까운 순으로 보기'),
      h('p', { class: 'hint' }, '허용하지 않으면 상호·주소순으로 보입니다.'));
    else {
      box.append(h('p', { class: 'hint' }, S.location === 'LOCATING' ? h('span', { class: 'spinner' }) : null, ' ', locationLine()));
      if (S.location === 'DENIED' || S.location === 'UNAVAILABLE') box.append(h('button', { type: 'button', class: 'btn btn-text', onclick: locate }, S.location === 'DENIED' ? '위치 다시 허용' : '위치 다시 찾기'));
    }
  }
  const primary = same.length ? same : similar;
  const folded = same.length ? similar : [];
  box.append(...storeRows(primary));
  if (folded.length) {
    box.append(h('button', { type: 'button', class: 'btn btn-text', onclick: () => { S.similarOpen = !S.similarOpen; renderStore(); } },
      S.similarOpen ? '비슷한 상호 접기' : `비슷한 상호 ${folded.length}곳 더 보기`));
    if (S.similarOpen) box.append(...storeRows(folded));
  }
  return box;
}

let drawsExpanded = false;
function renderStoreBox() {
  if (!S.data || !storeIdValid()) return null;
  const notice = blockNotice();
  if (notice) return h('div', { class: 'store-notice', role: 'alert' }, notice);
  if (!S.data.hasStore(S.storeId)) return null;
  const store = S.data.store(S.storeId);
  const summary = W.storeWinsSummary(store);
  const limit = drawsExpanded ? null : W.SUMMARY_LIMIT;
  const rankLine = (text) => {
    const i = text.indexOf(' (');
    return h('div', { class: 'rank-line' }, h('b', {}, i > 0 ? text.slice(0, i) : text), i > 0 ? text.slice(i) : '');
  };
  const pension = summary.pensionLine(limit);
  return h('div', { class: 'store-box' },
    h('div', { class: 'store-name' }, store.name || '상호 없음', store.closed ? h('span', { class: 'badge badge-bad' }, '운영 안 함') : null),
    h('div', { class: 'store-meta' }, `판매점ID ${store.storeId}` + (store.address ? ` · ${store.address}` : '')),
    h('div', { class: 'store-lines' }, h('div', { class: 'label' }, '로또 당첨'), summary.lottoLines(limit).map(rankLine),
      pension ? [h('div', { class: 'label' }, '연금 당첨'), rankLine(pension)] : null,
      summary.collapsed() ? h('button', { type: 'button', class: 'btn btn-text', onclick: () => { drawsExpanded = !drawsExpanded; renderStore(); } },
        drawsExpanded ? '회차 접기' : '회차 모두 보기') : null));
}

function renderStore(message = null) {
  const input = $('storeInput');
  const want = S.storeInput || S.storeId;
  if (document.activeElement !== input && input.value !== want) input.value = want;
  mount('storeArea',
    message ? h('p', { class: 'error-text' }, message) : null,
    S.searching ? h('p', { class: 'hint' }, h('span', { class: 'spinner' }), ' 판매점을 찾는 중…') : null,
    !S.searching && S.storeInput && W.StoreNames.core(S.storeInput).length < W.MIN_QUERY ? h('p', { class: 'hint' }, '상호를 두 자 넘게 넣으면 찾습니다.') : null,
    renderSearch(),
    renderStoreBox());
}

// ── ② 사진 ────────────────────────────────────────────────────────────────────
function loadImage(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function drawJpeg(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve({ blob: b, width: canvas.width, height: canvas.height }), 'image/jpeg', quality));
}

const geminiActive = () => !!S.gemini.key && S.gemini.enabled && S.gemini.ack;

async function addPhotos(files) {
  if (S.view.blocked) { toast(S.view.notice); return; }
  ensureSession();
  for (const file of files) {
    const img = await loadImage(file);
    if (!img) { toast('사진을 열지 못했습니다.'); continue; }
    const saved = await drawJpeg(img, 2560, 0.85); // 사진 사본: 긴 변 2560px, JPEG 85(EXIF·위치 없음)
    const no = (S.photos.reduce((m, p) => Math.max(m, p.no), 0)) + 1;
    const photo = {
      no, file: `photo-${no}.jpg`, blob: saved.blob, url: URL.createObjectURL(saved.blob),
      original: { width: img.naturalWidth, height: img.naturalHeight }, saved: { width: saved.width, height: saved.height, bytes: saved.blob.size },
      readMs: 0, error: null, engine: 'manual', readings: [], gemini: null,
    };
    S.photos.push(photo);
    renderPhotos();
    if (geminiActive() && navigator.onLine !== false) await readWithGemini(photo, img);
  }
  renderPhotos();
  renderRows();
  scheduleSave();
}

async function readWithGemini(photo, img) {
  S.readingPhoto = true;
  renderPhotos();
  const started = Date.now();
  const client = new G.GeminiClient();
  let model = S.gemini.model;
  let answer = null;
  try {
    if (!model) {
      model = (await G.pickModel(client, S.gemini.key, null)).model;
      S.gemini.model = model;
      await DB.kvSet('geminiModel', model);
      await DB.kvSet('geminiModelAuto', true);
    }
    const small = await drawJpeg(img, 2048, 0.9);
    const b64 = await blobToBase64(small.blob);
    answer = await client.generate(S.gemini.key, model, b64);
    const parsed = G.parseAnswer(answer.text);
    const result = G.toResult(parsed, small.width, small.height, (p) => S.data?.lastDrawOf(p) ?? null);
    const factor = small.width > 0 ? photo.original.width / small.width : 1;
    const readings = result.readings.map((r) => ({ reading: r.reading, box: r.box.length === 4 ? r.box.map((v) => Math.round(v * factor)) : [] }));
    photo.readings = readings;
    photo.engine = 'gemini';
    const dual = G.geminiOnly(readings);
    dual.forEach((d, index) => mergeGeminiRow(photo.no, index, d));
    photo.gemini = geminiLog(model, answer, small, null);
    if (!readings.length) toast(`사진 ${photo.no}: 제미나이가 회차가 적힌 당첨 표시를 찾지 못했습니다. 줄을 직접 넣어 주세요.`);
    else toast(`사진 ${photo.no}: 제미나이가 ${readings.length}줄을 읽었습니다 — 사진과 맞춰 보고 [맞음]을 눌러 주세요.`);
  } catch (e) {
    const failure = e instanceof G.GeminiError ? e.failure : 'NETWORK';
    photo.error = `제미나이: ${G.FAILURES[failure]}`;
    photo.gemini = geminiLog(model, answer, null, failure);
    toast(`사진 ${photo.no}: 제미나이로 읽지 못했습니다(${G.FAILURES[failure]}). 사진을 보고 줄을 직접 넣어 주세요.`);
  } finally {
    photo.readMs = Date.now() - started;
    S.readingPhoto = false;
  }
}

function geminiLog(model, answer, image, failure) {
  let raw = null;
  if (answer?.text) { try { raw = JSON.parse(answer.text); } catch { raw = null; } }
  return {
    model, modelVersion: answer?.modelVersion ?? null, prompt: G.PROMPT_VERSION, latencyMs: answer?.latencyMs ?? null,
    tokens: { prompt: answer?.promptTokens ?? null, output: answer?.outputTokens ?? null, thoughts: answer?.thoughtTokens ?? null, total: answer?.totalTokens ?? null },
    ...(image ? { image: { width: image.width, height: image.height } } : {}),
    ...(raw ? { raw } : answer?.text ? { rawText: answer.text.slice(0, 20000) } : {}),
    error: failure, errorLabel: failure ? G.FAILURES[failure] : null,
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new G.GeminiError('IMAGE'));
    r.readAsDataURL(blob);
  });
}

const rowKey = (r) => `${r.product}|${r.rank ?? ''}|${r.drawNo}`;

function mergeGeminiRow(photoNo, index, d) {
  const key = rowKey(d.reading);
  const existing = S.rows.find((r) => rowKey(r) === key);
  if (existing) {
    if (!existing.sources.includes(photoNo)) existing.sources.push(photoNo);
    existing.fromReadings.push([photoNo, index]);
    if (existing.needsCheck && d.candidateCount != null && existing.candidateCount !== d.candidateCount) existing.candidateCount = null;
    return;
  }
  S.rows.push({
    rowId: S.nextRowId++, product: d.reading.product, rank: d.reading.rank, drawNo: d.reading.drawNo, note: d.reading.note ?? null,
    count: d.reading.count ?? null, sources: [photoNo], fromReadings: [[photoNo, index]], edited: false, needsCheck: true,
    checkNote: d.note, candidateCount: d.candidateCount,
  });
}

function askConfirm(title, text, okLabel, onOk) {
  showModal(title, h('p', {}, text), h('div', { class: 'btn-row' },
    h('button', { type: 'button', class: 'btn btn-danger', onclick: () => { closeModal(); onOk(); } }, okLabel),
    h('button', { type: 'button', class: 'btn', onclick: closeModal }, '취소')));
}

function removePhoto(no) {
  if (!S.photos.some((p) => p.no === no)) return;
  askConfirm('사진 지우기', `사진 ${no}을(를) 지울까요? 이 사진에서만 읽은 확인 전 줄도 함께 지웁니다.`, '지우기', () => removePhotoNow(no));
}

function removePhotoNow(no) {
  const photo = S.photos.find((p) => p.no === no);
  if (!photo) return;
  URL.revokeObjectURL(photo.url);
  S.photos = S.photos.filter((p) => p.no !== no);
  S.rows = S.rows.filter((r) => {
    r.sources = r.sources.filter((s) => s !== no);
    r.fromReadings = r.fromReadings.filter(([p]) => p !== no);
    return r.edited || r.sources.length > 0;
  });
  renderPhotos();
  renderRows();
  scheduleSave();
}

function openViewer(no) {
  const photo = S.photos.find((p) => p.no === no);
  if (!photo) return;
  $('viewerImg').src = photo.url;
  $('viewerScroll').classList.remove('zoom');
  $('viewer').hidden = false;
}

function renderPhotos() {
  const hint = S.view.blocked ? S.view.notice
    : geminiActive() ? '제미나이로 읽기가 켜져 있습니다 — 읽은 줄은 사진과 맞춰 본 뒤 [맞음]을 눌러야 판정합니다.'
      : '사진을 보고 아래 「줄 넣기」로 회차·등위·명수를 넣으면 바로 판정합니다. (사진 글자 자동 읽기: 설정 › 제미나이)';
  $('photoHint').textContent = hint;
  mount('photoArea',
    S.readingPhoto ? h('p', { class: 'hint' }, h('span', { class: 'spinner' }), ' 제미나이로 사진을 읽는 중…') : null,
    S.photos.length ? h('div', { class: 'photo-strip' }, S.photos.map((p) => h('div', { class: 'photo-thumb' },
      h('button', { type: 'button', class: 'thumb', onclick: () => openViewer(p.no), 'aria-label': `사진 ${p.no} 크게 보기` }, h('img', { src: p.url, alt: '' })),
      h('button', { type: 'button', class: 'thumb-del', onclick: () => removePhoto(p.no), 'aria-label': `사진 ${p.no} 지우기` }, h('span', {}, '×')),
      h('span', { class: 'thumb-cap' }, `사진 ${p.no}` + (p.error ? ' · 못 읽음' : p.engine === 'gemini' ? ` · ${p.readings.length}줄` : ''))))) : null);
  const disabled = S.view.blocked;
  $('photoCamera').disabled = disabled;
  $('photoPick').disabled = disabled;
}

// ── 줄 ────────────────────────────────────────────────────────────────────────
function parseRowInput({ product, rank, draw, count, cumulative }) {
  const drawText = String(draw || '').trim();
  const countText = String(count || '').trim();
  if (countText && !/^\d{1,3}$/.test(countText)) throw new Error('명수는 숫자로 넣어 주세요.');
  const c = countText ? Number(countText) : null;
  if (cumulative) {
    if (c == null || c < 1 || c > 99) throw new Error('누적 횟수(1~99)를 「명수」 칸에 넣어 주세요.');
    return { product, rank: rank || '1', drawNo: W.CUMULATIVE_DRAW, note: W.CUMULATIVE_NOTE, count: c };
  }
  if (!/^\d{1,5}$/.test(drawText) || Number(drawText) < 1) throw new Error('회차를 숫자로 넣어 주세요.');
  if (c != null && c < 1) throw new Error('명수는 1 이상입니다.');
  return { product, rank: rank || null, drawNo: Number(drawText), note: null, count: c };
}

function addRowFromForm(ev) {
  ev.preventDefault();
  $('addError').textContent = '';
  if (S.view.blocked) { $('addError').textContent = S.view.notice; return; }
  try {
    const r = parseRowInput({ product: $('addProduct').value, rank: $('addRank').value, draw: $('addDraw').value, count: $('addCount').value, cumulative: $('addCumulative').checked });
    if (S.rows.some((x) => rowKey(x) === rowKey(r) && !x.needsCheck)) throw new Error('같은 줄이 이미 있습니다.');
    const pending = S.rows.find((x) => rowKey(x) === rowKey(r) && x.needsCheck);
    if (pending) Object.assign(pending, r, { needsCheck: false, edited: true });
    else S.rows.push({ rowId: S.nextRowId++, ...r, sources: [], fromReadings: [], edited: true, needsCheck: false, checkNote: null, candidateCount: null });
    ensureSession();
    $('addDraw').value = '';
    $('addCount').value = '';
    $('addDraw').focus();
    renderRows();
    scheduleSave();
  } catch (e) {
    $('addError').textContent = e.message;
  }
}

function syncCumulative() {
  const on = $('addCumulative').checked;
  $('addDraw').disabled = on;
  $('addDrawLabel').textContent = on ? '회차(없음)' : '회차';
  $('addCountLabel').textContent = on ? '누적 횟수' : '명수';
}

function confirmRow(row) {
  row.needsCheck = false;
  row.edited = true;
  renderRows();
  scheduleSave();
}

function deleteRow(row) {
  S.rows = S.rows.filter((r) => r !== row);
  if (S.editing === row.rowId) S.editing = null;
  renderRows();
  scheduleSave();
}

function rowEditor(row) {
  const sel = (options, value) => {
    const s = h('select', { class: 'input' });
    for (const [v, t] of options) { const o = h('option', { value: v }, t); if (v === (value ?? '')) o.selected = true; s.append(o); }
    return s;
  };
  const product = sel([['LOTTO645', '로또 6/45'], ['PENSION720', '연금720+'], ['PENSION520', '연금520'], ['SPEETTO', '스피또'], ['UNKNOWN', '상품 모름']], row.product);
  const rank = sel([['1', '1등'], ['2', '2등'], ['3', '3등'], ['4', '4등'], ['5', '5등'], ['BONUS', '보너스'], ['', '등위 모름']], row.rank);
  const cumulative = row.drawNo === W.CUMULATIVE_DRAW;
  const draw = h('input', { class: 'input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '5', value: cumulative ? '' : String(row.drawNo), disabled: cumulative });
  const count = h('input', { class: 'input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '3', placeholder: '모름',
    value: row.count != null ? String(row.count) : row.candidateCount != null ? String(row.candidateCount) : '' });
  const err = h('p', { class: 'error-text', role: 'alert' });
  return h('div', {},
    h('div', { class: 'row-edit' },
      h('label', {}, h('span', { class: 'field-label' }, '상품'), product), h('label', {}, h('span', { class: 'field-label' }, '등위'), rank),
      h('label', {}, h('span', { class: 'field-label' }, cumulative ? '회차(없음)' : '회차'), draw),
      h('label', {}, h('span', { class: 'field-label' }, cumulative ? '누적 횟수' : '명수'), count)),
    err,
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => {
        try {
          const r = parseRowInput({ product: product.value, rank: rank.value, draw: draw.value, count: count.value, cumulative });
          if (S.rows.some((x) => x !== row && rowKey(x) === rowKey(r))) throw new Error('같은 줄이 이미 있습니다.');
          Object.assign(row, r, { edited: true, needsCheck: false });
          S.editing = null;
          renderRows();
          scheduleSave();
        } catch (e) { err.textContent = e.message; }
      } }, '저장'),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => { S.editing = null; renderRows(); } }, '취소')));
}

function currentResults() {
  if (!canJudge()) return new Map();
  const store = S.data.store(S.storeId);
  const map = new Map();
  for (const r of S.rows) {
    if (r.needsCheck) continue;
    map.set(r.rowId, W.compareOne(S.data, store, { product: r.product, rank: r.rank, drawNo: r.drawNo, note: r.note, count: r.count }));
  }
  return map;
}

const ROW_ORDER = (results) => (a, b) => {
  const folded = (r) => (results.get(r.rowId)?.verdict === 'NOT_COMPARED' ? 1 : 0); // REQ-807: 비교 안 하는 줄은 맨 아래
  return folded(a) - folded(b);
};

function renderRows() {
  const results = currentResults();
  const rows = [...S.rows].sort(ROW_ORDER(results));
  const judging = canJudge();
  const items = rows.map((row) => {
    const result = results.get(row.rowId);
    const hint = judging ? W.dataHint(S.data, S.storeId, row) : null;
    const subs = [];
    if (row.needsCheck) subs.push(`확인 필요 · ${row.checkNote || ''}`.trim());
    if (result?.note) subs.push(result.note);
    if (result && (result.verdict === 'MATCH' || result.verdict === 'COUNT_MISMATCH') && row.count != null && result.recordedCount != null && row.drawNo !== W.CUMULATIVE_DRAW) {
      subs.push(`사진 ${rankText(row.rank)} ${row.count}명 · 등록 ${rankText(row.rank)} ${result.recordedCount}명`);
    }
    if (hint) subs.push(hint);
    if (row.sources.length) subs.push(`사진 ${row.sources.join('·')}`);
    else subs.push('직접 넣음');
    const badge = row.needsCheck ? h('span', { class: 'badge badge-warn' }, '확인 필요') : result ? verdictBadge(result.verdict)
      : h('span', { class: 'badge badge-grey' }, judging ? '' : '판정 대기');
    const li = h('li', { class: `row-item${row.needsCheck ? ' check' : ''}` },
      h('div', { class: 'row-main' }, h('span', { class: 'row-value' }, rowLabel(row)), badge),
      subs.map((s) => h('div', { class: 'row-sub' }, s)));
    if (S.editing === row.rowId) li.append(rowEditor(row));
    else {
      li.append(h('div', { class: 'row-actions' },
        row.needsCheck ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => confirmRow(row) }, '맞음') : null,
        h('button', { type: 'button', class: 'btn btn-small', onclick: () => { S.editing = row.rowId; renderRows(); } }, '고치기'),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => askConfirm('줄 지우기', `「${rowLabel(row)}」 줄을 지울까요?`, '지우기', () => deleteRow(row)) }, '지우기')));
    }
    return li;
  });
  const counts = {};
  for (const r of results.values()) if (r.verdict !== 'NOT_COMPARED') counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const pending = S.rows.filter((r) => r.needsCheck).length;
  const why = !S.rows.length ? null
    : !S.data ? '당첨 자료가 없어 판정하지 못합니다. [자료 새로 받기]를 눌러 주세요.'
      : !storeIdValid() ? '판매점ID(8자리)를 넣거나 상호로 판매점을 고르면 판정합니다.'
        : blockNotice() ? '판매점을 바르게 고르면 판정합니다.' : null;
  mount('rowsArea',
    S.rows.length ? h('ul', { class: 'rows' }, items) : h('p', { class: 'hint' }, '아직 넣은 줄이 없습니다.'),
    why ? h('p', { class: 'notice warn' }, why) : null,
    Object.keys(counts).length || pending ? h('div', { class: 'summary' },
      Object.entries(counts).map(([v, n]) => h('span', { class: `badge ${['MATCH', 'MATCH_COUNT_UNKNOWN'].includes(v) ? 'badge-ok' : v === 'NOT_IN_RECORD' ? 'badge-bad' : v === 'UNVERIFIABLE' ? 'badge-grey' : 'badge-warn'}` }, `${W.VERDICT_LABELS[v]} ${n}`)),
      pending ? h('span', { class: 'badge badge-warn' }, `확인 전 ${pending}`) : null) : null,
    rows.some((r) => results.get(r.rowId)?.verdict === 'NOT_COMPARED') ? h('p', { class: 'hint' }, '등록 자료가 없는 등위는 비교하지 않고 표 맨 아래에 접어 둡니다') : null);
}

// ── 기록(REQ-797) ─────────────────────────────────────────────────────────────
function ensureSession() {
  if (!S.session) S.session = { id: R.newRecordId(Date.now()), startedAt: Date.now(), compareCount: 0 };
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveRecord().catch(() => {}), SAVE_DELAY_MS);
}

async function saveRecord() {
  clearTimeout(saveTimer);
  if (!S.session || !canJudge() || !(S.rows.length || S.photos.length)) return false;
  S.session.compareCount += 1;
  const results = currentResults();
  const now = Date.now();
  const record = R.buildRecord({
    session: S.session, device: S.device, app: appInfo(), user: S.binding ? B.bindingRecordJson(S.binding, nowSec()) : null,
    storeId: S.storeId, storeName: S.data.store(S.storeId, false)?.name ?? null, inData: S.data.hasStore(S.storeId), dataLabel: S.data.label,
    photos: S.photos, rows: S.rows.map((r) => ({ ...r, dataHint: W.dataHint(S.data, S.storeId, r) })),
    results: S.rows.filter((r) => results.has(r.rowId)).map((r) => results.get(r.rowId)), unread: [], comparedAt: now,
  });
  const files = {};
  for (const p of S.photos) files[p.file] = p.blob;
  const bytes = S.photos.reduce((s, p) => s + p.blob.size, 0) + JSON.stringify(record).length;
  await DB.put('records', S.session.id, { id: S.session.id, record, files, sent: false, bytes });
  const entries = (await DB.all('records')).map((e) => ({ id: e.id, sent: e.sent }));
  for (const id of R.pruneIds(entries)) await DB.del('records', id);
  await refreshLog();
  return true;
}

function resetCheck() {
  for (const p of S.photos) URL.revokeObjectURL(p.url);
  S.session = null;
  S.photos = [];
  S.rows = [];
  S.editing = null;
  S.storeId = '';
  S.storeInput = '';
  S.search = null;
  S.similarOpen = false;
  drawsExpanded = false;
  $('storeInput').value = '';
  renderStore();
  renderPhotos();
  renderRows();
}

async function nextStore() {
  const saved = await saveRecord().catch(() => false);
  if (saved) toast('이 판매점 확인을 기록에 남겼습니다. [기록 보내기]로 보낼 수 있습니다.');
  resetCheck();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refreshLog() {
  const list = await DB.all('records');
  S.logEntries = list.sort((a, b) => (a.id < b.id ? 1 : -1));
  const unsent = S.logEntries.filter((e) => !e.sent).length;
  const badge = $('logBadge');
  badge.hidden = unsent === 0;
  badge.textContent = String(unsent);
  renderLog();
}

function renderLog() {
  const unsent = S.logEntries.filter((e) => !e.sent);
  const total = S.logEntries.reduce((s, e) => s + (e.bytes || 0), 0);
  const items = S.logEntries.slice(0, 50).map((e) => {
    const res = e.record.results || [];
    const n = (v) => res.filter((r) => r.verdict === v).length;
    return h('li', {},
      h('div', { class: 'row-main' }, h('b', {}, `${e.record.storeName || '상호 없음'} (${e.record.storeId})`), h('span', { class: `badge ${e.sent ? 'badge-grey' : 'badge-warn'}` }, e.sent ? '보냄' : '안 보냄')),
      h('div', { class: 'row-sub' }, `${e.record.comparedAt.replace('T', ' ').slice(0, 16)} · 사진 ${(e.record.photos || []).length}장 · 일치 ${n('MATCH') + n('MATCH_COUNT_UNKNOWN')} · 기록에 없음 ${n('NOT_IN_RECORD')} · 그 밖 ${res.length - n('MATCH') - n('MATCH_COUNT_UNKNOWN') - n('NOT_IN_RECORD')}`));
  });
  mount('logArea',
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '기록 보내기'),
      h('p', { class: 'hint' }, '판매점마다 확인한 결과(판매점ID·사진·줄·판정)가 이 휴대폰에만 쌓입니다. [기록 보내기]를 누르면 안 보낸 기록을 zip 파일 하나(약 20MB까지)로 묶고 IRMS만 열 수 있게 암호화해 카카오톡·메일 등으로 보냅니다. 받은 파일은 PC 대시보드 [기록 파일 올리기]로 넣습니다.'),
      h('dl', { class: 'kv' }, h('dt', {}, '안 보낸 기록'), h('dd', {}, `${unsent.length}건`), h('dt', {}, '모든 기록'), h('dd', {}, `${S.logEntries.length}건 · ${(total / 1048576).toFixed(1)}MB`)),
      h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: !unsent.length, onclick: exportLog }, `기록 보내기 (${unsent.length}건)`),
      h('p', { class: 'hint' }, '위치정보는 넣지 않습니다. 기록은 최근 200건까지 남고, 넘으면 보낸 기록부터 오래된 차례로 지웁니다.')),
    S.logEntries.length ? h('section', { class: 'card' }, h('h2', { class: 'card-title' }, '최근 기록'), h('ul', { class: 'list' }, items)) : null);
}

async function exportLog() {
  await saveRecord().catch(() => false);
  const all = await DB.all('records');
  const { chosen, remaining } = R.chooseForBundle(all);
  if (!chosen.length) { toast('보낼 기록이 없습니다.'); return; }
  const entries = [];
  for (const e of chosen) {
    const files = {};
    for (const [name, blob] of Object.entries(e.files || {})) files[name] = new Uint8Array(await blob.arrayBuffer());
    entries.push({ id: e.id, record: e.record, files });
  }
  let bundle;
  try {
    bundle = await R.buildSealedBundle({ entries, remaining, device: S.device, app: appInfo(), user: S.binding ? B.bindingRecordJson(S.binding, nowSec()) : null, now: Date.now() }, RECORD_PUBLIC_KEY_BASE64);
  } catch (e) {
    toast(e && e.message === R.NO_RECORD_KEY ? R.NO_RECORD_KEY : `기록을 암호화하지 못해 보내지 않았습니다: ${(e && e.message) || e}`);
    return;
  }
  const file = new File([bundle.bytes], bundle.name, { type: 'application/zip' });
  let shared = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: bundle.name });
      shared = true;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') { toast('보내기를 취소했습니다.'); return; }
  }
  if (!shared) {
    const a = h('a', { href: URL.createObjectURL(file), download: bundle.name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  showModal('보냈습니까?',
    h('p', {}, `${bundle.name} (${chosen.length}건${remaining ? `, 남은 기록 ${remaining}건은 다시 누르면 다음 묶음` : ''})`),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
        for (const e of chosen) { const cur = await DB.get('records', e.id); if (cur) { cur.sent = true; cur.sentAt = R.isoLocal(Date.now()); cur.bundle = bundle.name; await DB.put('records', e.id, cur); } }
        closeModal();
        await refreshLog();
      } }, '보낸 것으로 표시'),
      h('button', { type: 'button', class: 'btn', onclick: closeModal }, '아직 아님')));
}

// ── 설정 ──────────────────────────────────────────────────────────────────────
async function loadGemini() {
  S.gemini.key = await DB.openText(await DB.kvGet('geminiKey'), 'irms-gemini-api-key/1');
  S.gemini.enabled = await DB.kvGet('geminiEnabled', true);
  S.gemini.model = await DB.kvGet('geminiModel', '');
  S.gemini.ack = (await DB.kvGet('geminiNoticeVersion', 0)) >= G.NOTICE_VERSION;
}

function renderSettings() {
  const keyInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: S.gemini.key ? G.maskKey(S.gemini.key) : 'AIza… (Google AI Studio에서 받은 키)' });
  const status = h('p', { class: 'hint', role: 'status' });
  const enabled = h('input', { type: 'checkbox', checked: S.gemini.enabled, onchange: async () => { S.gemini.enabled = enabled.checked; await DB.kvSet('geminiEnabled', enabled.checked); renderPhotos(); } });
  const standalone = isStandalone();
  mount('settingsArea',
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '제미나이로 사진 읽기(선택)'),
      h('p', { class: 'hint' }, '키를 넣으면 당첨 기록 사진의 회차·등위·명수를 제미나이가 읽어 줄로 넣습니다. 읽은 줄은 모두 「확인 필요」로 들어오고, 사진과 맞춰 본 뒤 [맞음]을 눌러야 판정합니다(틀린 값을 그대로 판정하지 않게). 키가 없어도 줄을 직접 넣어 판정할 수 있습니다.'),
      h('label', { class: 'field-label' }, 'Gemini API 키'), keyInput,
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
          const k = G.cleanKey(keyInput.value);
          if (!k) { status.textContent = '키를 넣어 주세요.'; return; }
          const first = !S.gemini.key;
          await DB.kvSet('geminiKey', await DB.sealText(k, 'irms-gemini-api-key/1'));
          S.gemini.key = k;
          if (first) { S.gemini.enabled = true; await DB.kvSet('geminiEnabled', true); }
          keyInput.value = '';
          if (!S.gemini.ack) askGeminiNotice(); else renderSettings();
          renderPhotos();
        } }, '저장'),
        h('button', { type: 'button', class: 'btn', disabled: !S.gemini.key, onclick: async () => {
          status.textContent = '연결을 확인하는 중…';
          try {
            const picked = await G.pickModel(new G.GeminiClient(), S.gemini.key, S.gemini.model || null);
            S.gemini.model = picked.model;
            await DB.kvSet('geminiModel', picked.model);
            status.textContent = `연결됨 — 모델 ${picked.model}`;
          } catch (e) {
            status.textContent = `연결 실패: ${e instanceof G.GeminiError ? G.FAILURES[e.failure] : e.message}`;
          }
        } }, '연결 확인'),
        h('button', { type: 'button', class: 'btn btn-danger', disabled: !S.gemini.key, onclick: () => askConfirm('키 지우기', '이 휴대폰에 저장한 제미나이 키를 지울까요?', '지우기', async () => {
          await DB.del('kv', 'geminiKey');
          S.gemini.key = null;
          renderSettings();
          renderPhotos();
        }) }, '키 지우기')),
      status,
      h('div', { class: 'switch-line' }, h('span', {}, '제미나이로 읽기'), enabled),
      h('dl', { class: 'kv' }, h('dt', {}, '키'), h('dd', {}, S.gemini.key ? G.maskKey(S.gemini.key) : '없음'),
        h('dt', {}, '모델'), h('dd', {}, S.gemini.model || '처음 읽을 때 자동으로 고름'),
        h('dt', {}, '사진 보내기 안내'), h('dd', {}, S.gemini.ack ? '확인함' : h('button', { type: 'button', class: 'btn btn-text', onclick: askGeminiNotice }, '안내 보기·확인')))),
    h('section', { class: 'card' },
      h('h2', { class: 'card-title' }, '앱'),
      h('dl', { class: 'kv' }, h('dt', {}, '버전'), h('dd', {}, `웹앱 ${VERSION}`),
        h('dt', {}, '설치'), h('dd', {}, standalone ? '홈 화면에 설치됨' : '아직 홈 화면에 추가하지 않음'),
        h('dt', {}, '기기 기록 id'), h('dd', {}, S.device || '-'),
        h('dt', {}, '당첨 자료'), h('dd', {}, S.winsMeta ? `${S.winsMeta.label} · 열쇠 ${S.winsMeta.keyId}` : '없음')),
      h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: checkUpdate }, '새 버전 확인')),
      !standalone ? h('p', { class: 'notice warn' }, 'Safari 아래 [공유] 단추 → [홈 화면에 추가]로 설치해 주세요. 설치하지 않으면 아이폰이 이 웹앱의 자료(열쇠·당첨 자료·기록)를 지울 수 있습니다.') : null));
}

function askGeminiNotice() {
  showModal('사진이 구글로 보내집니다', h('p', {}, GEMINI_NOTICE),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { S.gemini.ack = true; await DB.kvSet('geminiNoticeVersion', G.NOTICE_VERSION); closeModal(); renderSettings(); renderPhotos(); } }, '확인'),
      h('button', { type: 'button', class: 'btn', onclick: () => { closeModal(); renderSettings(); } }, '나중에')));
}

// ── 업데이트(서비스 워커) ──────────────────────────────────────────────────────
function showUpdate() { $('updateBar').hidden = false; }

let updateRequested = false;

async function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  // 처음 설치할 때(이 페이지를 다스리는 워커가 없을 때)는 새 버전 띠를 띄우지도, 다시 열지도 않는다.
  const hadController = !!navigator.serviceWorker.controller;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    S.swReg = reg;
    if (reg.waiting && hadController) showUpdate();
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && hadController) showUpdate(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (updateRequested) { updateRequested = false; location.reload(); } });
  } catch { /* 서비스 워커 없이도 동작 */ }
}

async function checkUpdate() {
  if (!S.swReg) { toast('이 브라우저에서는 업데이트 확인을 할 수 없습니다.'); return; }
  try {
    await S.swReg.update();
    if (S.swReg.waiting || S.swReg.installing) { showUpdate(); toast('새 버전이 있습니다. 위의 [새로 고침]을 눌러 주세요.'); }
    else toast(`최신 버전입니다 (웹앱 ${VERSION})`);
  } catch {
    toast('업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요.');
  }
}

function applyUpdate() {
  const w = S.swReg && S.swReg.waiting;
  updateRequested = true;
  if (w) w.postMessage('SKIP_WAITING');
  else location.reload();
}

// ── 화면 전체 ──────────────────────────────────────────────────────────────────
function isStandalone() {
  return navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

function renderInstallBar() {
  const bar = $('installBar');
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isStandalone() || !ios || sessionStorageGet('installBarClosed')) { bar.hidden = true; return; }
  bar.replaceChildren(h('p', {}, 'Safari 아래 [공유] → [홈 화면에 추가]로 설치해 주세요. 설치해야 자료가 지워지지 않습니다.'),
    h('button', { type: 'button', class: 'btn btn-small', onclick: () => { sessionStorageSet('installBarClosed', '1'); bar.hidden = true; } }, '닫기'));
  bar.hidden = false;
}

function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 무시 */ } }

function renderAll() {
  renderUser();
  renderData();
  $('checkBody').hidden = false;
  document.querySelectorAll('#checkBody input, #checkBody select, #checkBody button').forEach((el) => {
    if (el.closest('#rowsArea') || el.closest('#storeArea') || el.closest('#photoArea')) return;
    el.disabled = S.view.blocked && el.id !== 'nextStore';
  });
  if (!S.view.blocked) syncCumulative();
  renderStore();
  renderPhotos();
  renderRows();
  renderSettings();
}

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle('active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
  for (const n of ['check', 'log', 'settings']) $(`tab-${n}`).hidden = n !== name;
  if (name === 'log') refreshLog();
  if (name === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

async function init() {
  $('topVersion').textContent = `웹앱 ${VERSION}`;
  registerWorker();
  renderInstallBar();
  try {
    S.pub = await C.importServerPublicKey(SERVER_PUBLIC_KEY_BASE64);
  } catch {
    mount('userCard', h('section', { class: 'card card-bad' }, h('p', { class: 'notice bad' }, '이 브라우저에서 암호 기능을 쓸 수 없습니다. iOS 16.4 이상 Safari에서 열어 주세요.')));
    return;
  }
  try {
    await DB.openDb();
  } catch {
    mount('userCard', h('section', { class: 'card card-bad' }, h('p', { class: 'notice bad' }, '휴대폰 저장소를 열지 못했습니다. 개인정보 보호 브라우징을 끄고 다시 열어 주세요.')));
    return;
  }
  DB.askPersist();
  S.device = await DB.kvGet('deviceId');
  if (!S.device || !/^[0-9a-f]{8}$/.test(S.device)) { S.device = R.randomHex(4); await DB.kvSet('deviceId', S.device); }
  const compact = await DB.kvGet('binding');
  if (compact) { try { S.binding = C.bindingFromCompact(compact); } catch { S.binding = null; } }
  S.lastSeen = await DB.kvGet('lastSeen', 0);
  await evaluateBinding();
  await loadGemini();
  await loadStoredWins();

  $('storeInput').addEventListener('input', (e) => onStoreInput(e.target.value));
  $('photoCamera').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; addPhotos(f); });
  $('photoPick').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; addPhotos(f); });
  $('addForm').addEventListener('submit', addRowFromForm);
  $('addCumulative').addEventListener('change', syncCumulative);
  $('nextStore').addEventListener('click', nextStore);
  $('updateReload').addEventListener('click', applyUpdate);
  $('viewerClose').addEventListener('click', () => { $('viewer').hidden = true; $('viewerImg').removeAttribute('src'); });
  $('viewerImg').addEventListener('dblclick', () => $('viewerScroll').classList.toggle('zoom'));
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { saveRecord().catch(() => {}); return; }
    const before = S.view.blocked;
    await evaluateBinding();
    if (before !== S.view.blocked) { await loadStoredWins(); renderAll(); } else renderUser();
    if (S.swReg) S.swReg.update().catch(() => {});
  });

  renderAll();
  await refreshLog();
  if (!S.view.blocked && S.winsMeta && S.data && navigator.onLine !== false) {
    // 하루 한 번 새 자료가 있는지 조용히 본다(안드로이드 앱의 하루 한 번 확인과 같은 뜻).
    const last = await DB.kvGet('lastWinsCheck', 0);
    if (Date.now() - last > 86400000) { await DB.kvSet('lastWinsCheck', Date.now()); downloadWins(); }
  }
}

init();
