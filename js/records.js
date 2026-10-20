// REQ-875 당첨 확인 기록(REQ-797 irms-wins-log v1) — 안드로이드 WinLogSession·WinLogStore 와 같은 record.json·manifest 모양.
// import_winlog.py(대시보드 [기록 파일 올리기])가 그대로 받는다. 위치정보는 넣지 않고 사진은 다시 그려 EXIF 를 버린다.

import { buildZip } from './zip.js';
import { sealRecord, RECORD_INNER_NAME } from './crypto.js';
import { deviceFile, DEVICE_FILE_NAME } from './device.js';

export const FORMAT = 'irms-wins-log';
export const LOG_VERSION = 1;
export const BUNDLE_PREFIX = 'IRMS-wins-log-';
export const MAX_RECORDS = 200;
export const BUNDLE_BYTES = 20 * 1024 * 1024;
const NAME = /^[0-9A-Za-z._-]{1,64}$/;

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 「2026-10-20T15:30:12+09:00」(휴대폰 시간대). */
export function isoLocal(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    + `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const newRecordId = (ms) => `${stamp(ms)}-${randomHex(2)}`;

const reading = (r) => ({ product: r.product, rank: r.rank ?? null, drawNo: r.drawNo, note: r.note ?? null, count: r.count ?? null });

/**
 * 기록 한 건. session = {id, startedAt, compareCount}, photos = [{no, file, original, saved, readMs, error, engine, gemini, readings}],
 * rows = 표의 줄, results = 판정한 줄(rows 와 짝이 맞는 것만).
 */
export function buildRecord({ session, device, app, user, storeId, storeName, inData, dataLabel, photos, rows, results, unread, comparedAt }) {
  const photoMs = photos.reduce((s, p) => s + (p.readMs || 0), 0);
  return {
    format: 1, id: session.id, device, app, ...(user ? { user } : {}),
    storeId, storeName: storeName ?? null, inData: !!inData, winData: { label: dataLabel ?? null },
    startedAt: isoLocal(session.startedAt), comparedAt: isoLocal(comparedAt), elapsedMs: comparedAt - session.startedAt,
    readMs: { photos: photoMs, storeIdPhotos: 0, total: photoMs }, compareCount: session.compareCount,
    storeIdPhotos: [],
    photos: [...photos].sort((a, b) => a.no - b.no).map((p) => ({
      no: p.no, file: p.file ?? null, ocr: null, original: { width: p.original.width, height: p.original.height },
      saved: p.saved ? { width: p.saved.width, height: p.saved.height, bytes: p.saved.bytes } : null,
      readMs: p.readMs || 0, hint: null, error: p.error ?? null, saveError: p.saveError ?? null, engine: p.engine || 'manual',
      ...(p.gemini ? { gemini: p.gemini } : {}),
      readings: (p.readings || []).map((x) => ({ ...reading(x.reading), rankFromMark: false, box: x.box || [] })),
    })),
    rows: rows.map((r) => ({
      ...reading(r), rowId: r.rowId, sources: r.sources || [], fromReadings: r.fromReadings || [], edited: !!r.edited,
      rankChoices: [], dataHint: r.dataHint ?? null, needsCheck: !!r.needsCheck, dualConfirmed: false, checkNote: r.checkNote ?? null, hwRead: false,
    })),
    results: results.map((l) => ({ ...reading(l.reading), verdict: l.verdict, verdictLabel: l.verdictLabel, recordedCount: l.recordedCount ?? null, resultNote: l.note ?? null })),
    unread: unread || [],
    cut: [],
    rawReadingCount: photos.reduce((s, p) => s + (p.readings || []).length, 0),
  };
}

/** 안 보낸 기록(오래된 것부터)을 limit 바이트까지 고른다(한 건이 더 크면 그 한 건만). */
export function chooseForBundle(entries, limit = BUNDLE_BYTES) {
  const unsent = entries.filter((e) => !e.sent).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = [];
  let size = 0;
  for (const e of unsent) {
    if (chosen.length && size + e.bytes > limit) break;
    chosen.push(e);
    size += e.bytes;
  }
  return { chosen, remaining: unsent.length - chosen.length };
}

/**
 * zip 묶음. entries = [{id, record, files: {이름: Uint8Array}}] (고른 것), app·user = 묶음 머리.
 * 돌려줌: {name, bytes}.
 */
export function buildBundle({ entries, remaining, device, app, user, now }) {
  const enc = new TextEncoder();
  const manifest = {
    format: FORMAT, version: LOG_VERSION, createdAt: isoLocal(now), device, app, ...(user ? { user } : {}),
    records: entries.map((e) => ({
      id: e.id, storeId: e.record.storeId ?? null, comparedAt: e.record.comparedAt ?? null, photos: (e.record.photos || []).length,
      ...(e.record.user ? { user: e.record.user } : {}), dir: `records/${e.id}`,
    })),
    remaining,
  };
  const files = [{ name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) }];
  for (const e of entries) {
    files.push({ name: `records/${e.id}/record.json`, data: enc.encode(JSON.stringify(e.record)) });
    for (const name of Object.keys(e.files || {}).sort()) {
      if (!NAME.test(name)) continue;
      files.push({ name: `records/${e.id}/${name}`, data: e.files[name] });
    }
  }
  return { name: `${BUNDLE_PREFIX}${device}-${stamp(now)}.zip`, bytes: buildZip(files, new Date(now)) };
}

export const NO_RECORD_KEY = '기록 암호화 공개키가 웹앱 설정에 없어 보낼 수 없습니다. IRMS 담당자에게 웹앱 새 버전을 올려 달라고 해 주세요.';

/**
 * 보내는 파일(REQ-889) — buildBundle 의 묶음 zip 을 IRMS 기록 공개키로 싼 봉투를 zip 에 넣는다.
 * REQ-896: [device] = {privateKey, spki, fp, code}(device.js ensureDeviceKey) 가 있으면 두 번째 항목 irms-device.json(봉투 바이트 기기 서명).
 * 이름은 묶음과 같다(IRMS-wins-log-<기기>-<시각>.zip). 평문 묶음은 밖으로 내보내지 않는다.
 * [fixed] = {ephemeralJwk, iv} 는 시험에서만.
 */
export async function buildSealedBundle(args, recordPublicKeyB64, fixed = {}, device = null) {
  if (!recordPublicKeyB64) throw new Error(NO_RECORD_KEY);
  const plain = buildBundle(args);
  const user = args.user && Number.isInteger(args.user.id) ? args.user.id : null;
  const envelope = await sealRecord(plain.bytes, recordPublicKeyB64, { user, created: isoLocal(args.now), name: plain.name }, fixed);
  const files = [{ name: RECORD_INNER_NAME, data: envelope }];
  if (device) files.push({ name: DEVICE_FILE_NAME, data: await deviceFile(device, envelope) });
  return { name: plain.name, bytes: buildZip(files, new Date(args.now)) };
}

/** 한도(최근 200건)를 넘으면 보낸 기록부터 오래된 차례로 지울 id 목록(방금 쓴 한 건은 남김). */
export function pruneIds(entries, max = MAX_RECORDS) {
  const list = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const removed = [];
  for (const sentFirst of [true, false]) {
    for (const e of list.filter((x) => !sentFirst || x.sent)) {
      if (list.length - removed.length <= max) return removed;
      if (list.length - removed.length <= 1) return removed;
      if (!removed.includes(e.id)) removed.push(e.id);
    }
  }
  return removed;
}
