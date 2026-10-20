// REQ-896 휴대폰 등록 — 서버 modules/admin/wincheck_device_service.py 와 같은 규칙(시험 자료 tests/fixtures/req896/vectors.json).
//  1. 꺼낼 수 없는 기기 열쇠(ECDSA P-256, extractable=false)를 IndexedDB 에 둔다. 지문 = SHA-256(SPKI DER) hex.
//  2. 기기 확인 번호 = SHA-256("irms-device-v1" ‖ 지문 32바이트) 앞 45비트 → 5비트씩 9글자 + 검사 글자 1(Crockford 32글자).
//  3. 등록 QR "irmsdev:v1:<b64url JSON>:<b64url DER 서명>" — 서버 승인 서명키로 확인하고 사용자·번호·만료를 맞춘다.
//  4. 기록 보내기 파일에 irms-device.json(기기 공개키·번호·봉투 바이트 서명 r‖s)을 붙인다.
// 브라우저와 Node(시험) 모두에서 도는 순수 ES 모듈.

import * as C from './crypto.js';

const subtle = globalThis.crypto.subtle;
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_DATA = 9;
export const CODE_INFO = 'irms-device-v1';
export const ACTIVATION_PREFIX = 'irmsdev:v1';
export const DEVICE_FILE_NAME = 'irms-device.json';
export const KEY_STORE_ID = 'device';          // keys 저장소: {privateKey, publicKey}
export const ACTIVATION_KV = 'deviceActivation'; // kv 저장소: 등록 QR 글자 그대로

export const NOT_IRMS = 'IRMS가 만든 등록 QR이 아닙니다';
export const OTHER_USER = '다른 사용자의 등록 QR입니다';
export const OTHER_DEVICE = '이 휴대폰의 등록 QR이 아닙니다';
export const EXPIRED = '등록 QR의 기간이 지났습니다';
export const LOCK_TITLE = '휴대폰 등록이 필요합니다';
export const LOCK_TEXT = '사무실 IRMS 앱 설치 화면에서 열쇠 QR을 찍고 아래 기기 확인 번호를 넣은 뒤, 나오는 등록 QR을 찍어 주세요.';

export class DeviceError extends Error {}

const hexToBytes = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));

export const fingerprint = (spki) => C.sha256Hex(spki);

/** 지문(hex) → 10글자 번호. */
export async function deviceCode(fpHex) {
  const info = C.utf8(CODE_INFO);
  const fp = hexToBytes(fpHex);
  const buf = new Uint8Array(info.length + fp.length);
  buf.set(info, 0);
  buf.set(fp, info.length);
  const d = new Uint8Array(await subtle.digest('SHA-256', buf));
  let bits = 0n;
  for (let i = 0; i < 6; i++) bits = (bits << 8n) | BigInt(d[i]);
  bits >>= 3n;
  const values = [];
  for (let i = 0; i < CODE_DATA; i++) values.push(Number((bits >> BigInt(5 * (CODE_DATA - 1 - i))) & 31n));
  const check = values.reduce((s, v, i) => s + (i + 1) * v, 0) % 32;
  return values.map((v) => CODE_ALPHABET[v]).join('') + CODE_ALPHABET[check];
}

export const formatCode = (code) => `${code.slice(0, 5)}-${code.slice(5)}`;

export const looksLikeActivation = (text) => String(text || '').trim().startsWith(`${ACTIVATION_PREFIX}:`);

/** 공개키 → {spki, fp, code}. */
export async function describeKey(publicKey) {
  const spki = new Uint8Array(await subtle.exportKey('spki', publicKey));
  const fp = await fingerprint(spki);
  return { spki, fp, code: await deviceCode(fp) };
}

/** 저장된 기기 열쇠를 꺼내거나 처음이면 만든다. store = {get(id), put(id, value)} (db.js keys 저장소). */
export async function ensureDeviceKey(store) {
  let pair = await store.get(KEY_STORE_ID);
  if (!pair || !pair.privateKey || !pair.publicKey) {
    const made = await subtle.generateKey(ECDSA_P256, false, ['sign', 'verify']);
    pair = { privateKey: made.privateKey, publicKey: made.publicKey };
    await store.put(KEY_STORE_ID, pair);
  }
  return { ...pair, ...(await describeKey(pair.publicKey)) };
}

/**
 * 등록 QR 확인 → JSON {u,c,d,e,i,n}. serverKey = C.importServerPublicKey 결과. 틀리면 DeviceError(화면 문구).
 */
export async function openActivation(payload, serverKey, { userId, code, now }) {
  const parts = String(payload || '').trim().split(':');
  if (parts.length !== 4 || `${parts[0]}:${parts[1]}` !== ACTIVATION_PREFIX) throw new DeviceError(NOT_IRMS);
  let sig;
  try { sig = C.b64urlDecode(parts[3]); } catch { throw new DeviceError(NOT_IRMS); }
  if (!(await C.verifyEcdsa(serverKey, sig, C.utf8(parts.slice(0, 3).join(':'))))) throw new DeviceError(NOT_IRMS);
  let data;
  try { data = JSON.parse(C.fromUtf8(C.b64urlDecode(parts[2]))); } catch { throw new DeviceError(NOT_IRMS); }
  if (!data || !Number.isInteger(data.u) || typeof data.c !== 'string' || !Number.isInteger(data.e)) throw new DeviceError(NOT_IRMS);
  if (data.u !== userId) throw new DeviceError(OTHER_USER);
  if (data.c !== code) throw new DeviceError(OTHER_DEVICE);
  if (!(data.e > now)) throw new DeviceError(EXPIRED);
  return data;
}

/** 봉투 바이트 서명 → r‖s 64바이트(WebCrypto ECDSA 는 이미 r‖s). */
export async function signEnvelope(privateKey, envelope) {
  return new Uint8Array(await subtle.sign(SIGN, privateKey, envelope));
}

/** irms-device.json 바이트. device = {privateKey, spki, fp, code}. */
export async function deviceFile(device, envelope) {
  const sig = await signEnvelope(device.privateKey, envelope);
  return C.utf8(JSON.stringify({ v: 1, fp: device.fp, code: device.code, spki: C.b64Encode(device.spki), sig: C.b64Encode(sig) }));
}
