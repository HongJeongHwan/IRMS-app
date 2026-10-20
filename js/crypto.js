// REQ-875 당첨 확인 웹앱(iPhone) — 안드로이드 앱과 같은 암호 규칙.
//  - 자료 열쇠 QR(REQ-853·854): android data/wins/PublicWins.kt DataKeyQr, 서버 modules/admin/app_data_key_service.py
//  - 공개 당첨 자료(REQ-853): PublicWins.parseLatest·update, 서버 modules/admin/public_wins_service.py
//  - 암호문 IRMSENC1(REQ-852): BundledWinCrypto, 안쪽 자료 서버 서명: WinDataStore.verifyServerSignature
// 브라우저와 Node(시험) 모두에서 도는 순수 ES 모듈 — WebCrypto(crypto.subtle)만 쓴다.

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const KEY_QR_PREFIX = 'irmskey:v1';
export const KEY_QR_PREFIX_V2 = 'irmskey:v2';
export const PBKDF2_ITERATIONS = 200000;
export const KEY_QR_CLOCK_SKEW_SECONDS = 120;
export const PUBLIC_SCHEMA = 'irms-wins-public/1';
export const MAX_LATEST_BYTES = 64 * 1024;
export const MAX_DATA_BYTES = 16 * 1024 * 1024;
export const MAX_JSON_BYTES = 48 * 1024 * 1024;
const KEY_ID = /^[0-9a-f]{16}$/;
const FILE_NAME = /^irms-wins-[0-9a-f]{16}[.]enc$/;
const MAGIC = enc.encode('IRMSENC1');
const NONCE_SIZE = 12;

export const isKeyId = (v) => typeof v === 'string' && KEY_ID.test(v);

export function utf8(text) { return enc.encode(text); }
export function fromUtf8(bytes) { return dec.decode(bytes); }

export function b64urlDecode(text) {
  const s = String(text || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  return b64Decode(s + '='.repeat((4 - (s.length % 4)) % 4));
}

export function b64Decode(text) {
  const bin = atob(String(text || '').trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes) {
  return hex(await subtle.digest('SHA-256', bytes));
}

/** ECDSA DER(SEQUENCE{INTEGER r, INTEGER s}) → WebCrypto 가 받는 r‖s(각 32바이트). 틀리면 null. */
export function derToRaw(der, size = 32) {
  const b = new Uint8Array(der);
  let i = 0;
  if (b[i++] !== 0x30) return null;
  let len = b[i++];
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | b[i++]; }
  if (i + len !== b.length) return null;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part++) {
    if (b[i++] !== 0x02) return null;
    let l = b[i++];
    let v = b.subarray(i, i + l);
    i += l;
    while (v.length > 0 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) return null;
    out.set(v, part * size + (size - v.length));
  }
  return i === b.length ? out : null;
}

/** 서버 승인 서명 공개키(SPKI DER base64) → ECDSA P-256 확인용 CryptoKey. */
export async function importServerPublicKey(spkiBase64) {
  const der = b64Decode(spkiBase64);
  const key = await subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return { key, fingerprint: await sha256Hex(der) };
}

/** SHA256withECDSA(DER 서명) 확인. 형식이 틀리면 false. */
export async function verifyEcdsa(publicKey, derSignature, data) {
  const raw = derToRaw(derSignature);
  if (!raw) return false;
  try {
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey.key || publicKey, raw, data);
  } catch {
    return false;
  }
}

// ── 사용자 연결(REQ-854) 짧은 JSON ────────────────────────────────────────────
/** QR·저장소의 짧은 JSON {u,n,o,r,p,i,e} → 연결. 틀리면 Error. AppUser.kt UserBinding.fromCompactJson 과 같은 규칙. */
export function bindingFromCompact(obj) {
  try {
    const opt = (k) => {
      const v = obj[k];
      if (v === null || v === undefined) return null;
      const s = String(v);
      return s.trim() ? s : null;
    };
    const userId = obj.u;
    const boundAt = obj.i;
    const expiresAt = obj.e;
    if (!Number.isInteger(userId) || !Number.isInteger(boundAt) || !Number.isInteger(expiresAt) || typeof obj.n !== 'string') throw new Error();
    const b = {
      userId, name: obj.n.slice(0, 20), org: opt('o') ? opt('o').slice(0, 30) : null, role: opt('r') ? opt('r').slice(0, 12) : null,
      inspector: (obj.p ?? 0) === 1, boundAt, expiresAt,
    };
    if (!(b.expiresAt > b.boundAt) || !b.name.trim()) throw new Error();
    return b;
  } catch {
    throw new Error('QR의 사용자 정보 형식이 올바르지 않습니다.');
  }
}

export function bindingFromQrField(b64url) {
  let obj;
  try { obj = JSON.parse(fromUtf8(b64urlDecode(b64url))); } catch { throw new Error('QR의 사용자 정보 형식이 올바르지 않습니다.'); }
  return bindingFromCompact(obj);
}

export function bindingToCompact(b) {
  return { u: b.userId, n: b.name, o: b.org, r: b.role, p: b.inspector ? 1 : 0, i: b.boundAt, e: b.expiresAt };
}

// ── 자료 열쇠 QR ───────────────────────────────────────────────────────────────
const NOT_KEY_QR = '자료 열쇠 QR이 아닙니다. PC 「모바일 앱 › 앱 설치」의 [열쇠 QR 보이기]로 나온 QR을 찍어 주세요.';

export function looksLikeKeyQr(text) {
  const t = String(text || '').trim();
  return t.startsWith(KEY_QR_PREFIX + ':') || t.startsWith(KEY_QR_PREFIX_V2 + ':');
}

function splitKeyQr(payload) {
  const p = String(payload || '').trim().split(':');
  if (p.length === 9 && `${p[0]}:${p[1]}` === KEY_QR_PREFIX_V2 && isKeyId(p[2])) {
    return { keyId: p[2], expires: p[3], head: p.slice(0, 5).join(':'), salt: p[5], nonce: p[6], sealed: p[7],
      body: p.slice(0, 8).join(':'), signature: p[8], userField: p[4] };
  }
  if (p.length === 8 && `${p[0]}:${p[1]}` === KEY_QR_PREFIX && isKeyId(p[2])) {
    return { keyId: p[2], expires: p[3], head: p.slice(0, 4).join(':'), salt: p[4], nonce: p[5], sealed: p[6],
      body: p.slice(0, 7).join(':'), signature: p[7], userField: null };
  }
  throw new Error(NOT_KEY_QR);
}

/** 서명·만료를 먼저 본다(PIN 을 묻기 전에 틀린 QR 을 거른다). 맞으면 {keyId, user}. */
export async function checkKeyQr(payload, publicKey, nowSeconds) {
  const parts = splitKeyQr(payload);
  let signature;
  try { signature = b64urlDecode(parts.signature); } catch { signature = new Uint8Array(0); }
  const valid = await verifyEcdsa(publicKey, signature, utf8(parts.body));
  if (!valid) throw new Error('IRMS가 만든 자료 열쇠 QR이 아닙니다(서명이 맞지 않음).');
  if (!/^\d+$/.test(parts.expires)) throw new Error('자료 열쇠 QR 형식이 올바르지 않습니다.');
  if (nowSeconds > Number(parts.expires) + KEY_QR_CLOCK_SKEW_SECONDS) {
    throw new Error('자료 열쇠 QR의 시간이 지났습니다. PC에서 [열쇠 QR 보이기]를 다시 눌러 새 QR을 찍어 주세요.');
  }
  const user = parts.userField ? bindingFromQrField(parts.userField) : null;
  return { keyId: parts.keyId, user, parts };
}

/**
 * 서명·만료·PIN 을 모두 확인하고 {keyId, key, user}. key = AES-GCM 복호 전용 CryptoKey.
 * [extractable] 은 시험에서만 true — 휴대폰에서는 꺼낼 수 없는 열쇠로만 둔다.
 */
export async function openKeyQr(payload, pin, publicKey, nowSeconds, { extractable = false } = {}) {
  const { keyId, user, parts } = await checkKeyQr(payload, publicKey, nowSeconds);
  if (!/^\d{6}$/.test(String(pin))) throw new Error('PIN은 숫자 6자리입니다.');
  const base = await subtle.importKey('raw', utf8(String(pin)), 'PBKDF2', false, ['deriveKey']);
  const pinKey = await subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64urlDecode(parts.salt), iterations: PBKDF2_ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  let raw;
  try {
    raw = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlDecode(parts.nonce), additionalData: utf8(parts.head), tagLength: 128 },
      pinKey, b64urlDecode(parts.sealed),
    ));
  } catch {
    throw new Error('PIN이 맞지 않습니다. PC 화면의 QR 옆 PIN 6자리를 넣어 주세요.');
  }
  if (raw.length !== 32) throw new Error('자료 열쇠 길이가 올바르지 않습니다.');
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['decrypt']);
  raw.fill(0);
  return { keyId, key, user };
}

// ── 공개 당첨 자료(wins-latest.json) ──────────────────────────────────────────
export function signedMessage(l) {
  return utf8([PUBLIC_SCHEMA, l.keyId, l.packageId, l.generatedAt, l.file, String(l.fileSize), l.sha256].join('\n'));
}

/** wins-latest.json → 서명 확인한 요약. 틀리면 Error. */
export async function parseLatest(bytes, publicKey) {
  if (bytes.length > MAX_LATEST_BYTES) throw new Error('깃허브의 당첨 자료 요약이 너무 큽니다.');
  let json;
  try { json = JSON.parse(fromUtf8(bytes)); } catch { throw new Error('깃허브의 당첨 자료 요약을 읽지 못했습니다.'); }
  if (!json || json.schema !== PUBLIC_SCHEMA) throw new Error('깃허브의 당첨 자료 요약 형식이 아닙니다.');
  const str = (v) => (typeof v === 'string' ? v : null);
  const latest = {
    keyId: str(json.key_id), packageId: str(json.package_id), generatedAt: str(json.generated_at), file: str(json.file),
    fileSize: Number.isInteger(json.file_size) ? json.file_size : null, sha256: str(json.sha256)?.toLowerCase() ?? null,
    storeCount: json.store_count ?? null, groups: Array.isArray(json.groups) ? json.groups : [],
  };
  if ([latest.keyId, latest.packageId, latest.generatedAt, latest.file, latest.fileSize, latest.sha256].some((v) => v === null)) {
    throw new Error('깃허브의 당첨 자료 요약에 빠진 칸이 있습니다.');
  }
  if (!isKeyId(latest.keyId) || !FILE_NAME.test(latest.file) || latest.fileSize < 1 || latest.fileSize > MAX_DATA_BYTES || latest.sha256.length !== 64) {
    throw new Error('깃허브의 당첨 자료 요약 값이 올바르지 않습니다.');
  }
  const signature = json.signature;
  if (!signature || signature.algorithm !== 'ECDSA_P256_SHA256') throw new Error('당첨 자료 요약에 서버 서명이 없습니다.');
  let sig;
  try { sig = b64Decode(signature.value); } catch { sig = new Uint8Array(0); }
  if (!(await verifyEcdsa(publicKey, sig, signedMessage(latest)))) {
    throw new Error('깃허브의 당첨 자료가 IRMS 서명과 맞지 않아 받지 않았습니다.');
  }
  return latest;
}

export function bundleAad(keyId, packageId) {
  return utf8(`IRMS:BUNDLED-WINS:v1:${keyId}:${packageId}`);
}

/** IRMSENC1 + nonce(12) + 암호문‖태그 → 평문. key 는 AES-GCM CryptoKey. */
export async function decryptBundle(blob, key, keyId, packageId) {
  const b = new Uint8Array(blob);
  const head = b.subarray(0, MAGIC.length);
  if (b.length <= MAGIC.length + NONCE_SIZE + 16 || !head.every((v, i) => v === MAGIC[i])) {
    throw new Error('당첨 자료가 암호화 형식이 아닙니다.');
  }
  try {
    return new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: b.subarray(MAGIC.length, MAGIC.length + NONCE_SIZE), additionalData: bundleAad(keyId, packageId), tagLength: 128 },
      key, b.subarray(MAGIC.length + NONCE_SIZE),
    ));
  } catch {
    throw new Error('자료 열쇠가 맞지 않아 당첨 자료를 열지 못했습니다.');
  }
}

/** 받은 암호문 확인: 크기·SHA-256 이 요약과 같은가. */
export async function checkBlob(blob, latest) {
  if (blob.length !== latest.fileSize) throw new Error('받은 당첨 자료 크기가 요약과 달라 넣지 않았습니다. 잠시 뒤 다시 받아 주세요.');
  if ((await sha256Hex(blob)) !== latest.sha256) throw new Error('받은 당첨 자료가 요약과 달라(SHA-256) 넣지 않았습니다. 잠시 뒤 다시 받아 주세요.');
}

// ── 안쪽 자료(.irms-wins) ─────────────────────────────────────────────────────
export async function gunzipIfNeeded(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 1 || b.length > MAX_DATA_BYTES) throw new Error('당첨 자료 파일 크기가 올바르지 않습니다.');
  if (!(b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b)) return b;
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_JSON_BYTES) throw new Error('당첨 자료 파일을 풀면 허용 크기를 넘습니다.');
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/**
 * 정규화 JSON — 서버 json.dumps(sort_keys=True, separators=(",",":"), ensure_ascii=False) 와 같은 바이트.
 * 키 사전순(UTF-16 단위 — 키는 ASCII·숫자), 공백 없음, null 유지. 정수가 아닌 숫자가 있으면 파이썬과 모양이 다를 수 있어 거절한다.
 */
export function canonicalJson(value) {
  const parts = [];
  const walk = (v) => {
    if (v === null) { parts.push('null'); return; }
    switch (typeof v) {
      case 'string': parts.push(JSON.stringify(v)); return;
      case 'boolean': parts.push(v ? 'true' : 'false'); return;
      case 'number':
        if (!Number.isSafeInteger(v)) throw new Error('당첨 자료에 정수가 아닌 숫자가 있어 서명을 확인할 수 없습니다.');
        parts.push(String(v));
        return;
      case 'object':
        if (Array.isArray(v)) {
          parts.push('[');
          v.forEach((item, i) => { if (i) parts.push(','); walk(item); });
          parts.push(']');
        } else {
          parts.push('{');
          Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).forEach((k, i) => {
            if (i) parts.push(',');
            parts.push(JSON.stringify(k), ':');
            walk(v[k]);
          });
          parts.push('}');
        }
        return;
      default:
        throw new Error('당첨 자료 JSON 형식이 올바르지 않습니다.');
    }
  };
  walk(value);
  return parts.join('');
}

export async function computePackageId(wins) {
  const body = { ...wins };
  delete body.package_id;
  return sha256Hex(utf8(canonicalJson(body)));
}

/** 내용 id(REQ-862) — package_id·generated_at·groups[].imported_at 을 뺀 정규화 JSON 의 SHA-256. */
export async function contentId(wins) {
  const body = { ...wins };
  delete body.package_id;
  delete body.generated_at;
  if (Array.isArray(body.groups)) body.groups = body.groups.map((g) => { const c = { ...g }; delete c.imported_at; return c; });
  return sha256Hex(utf8(canonicalJson(body)));
}

/**
 * 파일(.irms-wins, gzip JSON {wins, signature}) → 서버 서명을 확인한 본문(wins).
 * WinDataStore.verifiedWins + WinPackageParser.parseWins 의 package_id 확인과 같다.
 */
export async function verifyWinsFile(fileBytes, publicKey) {
  const raw = await gunzipIfNeeded(fileBytes);
  let root;
  try { root = JSON.parse(fromUtf8(raw)); } catch { throw new Error('당첨 자료 파일 JSON 형식이 올바르지 않습니다.'); }
  const wins = root && root.wins;
  if (!wins || typeof wins !== 'object') throw new Error('당첨 자료 본문(wins)이 없습니다.');
  const signature = root.signature;
  if (!signature) throw new Error('당첨 자료 서명이 없습니다.');
  if (signature.algorithm !== 'ECDSA_P256_SHA256') throw new Error('지원하지 않는 서버 서명 알고리즘입니다.');
  if (String(signature.signing_key_fingerprint || '').toLowerCase() !== publicKey.fingerprint) {
    throw new Error('서버 서명키 지문이 앱 신뢰키와 일치하지 않습니다.');
  }
  let sig;
  try { sig = b64Decode(signature.value); } catch { throw new Error('서명 값의 Base64 형식이 올바르지 않습니다.'); }
  const canonical = utf8(canonicalJson(wins));
  if (!(await verifyEcdsa(publicKey, sig, canonical))) throw new Error('당첨 자료 서버 서명 검증에 실패했습니다.');
  if (wins.schema !== 'irms-lottery-wins/1') throw new Error('지원하지 않는 당첨 자료 형식입니다.');
  const packageId = String(wins.package_id || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(packageId)) throw new Error('당첨 자료 package_id 형식이 올바르지 않습니다.');
  if (packageId !== (await computePackageId(wins))) throw new Error('당첨 자료 package_id가 내용과 일치하지 않습니다.');
  return wins;
}

// ── 기록 봉투(REQ-889) — [기록 보내기] 묶음을 IRMS 기록 공개키로 싼다(IRMS 만 연다) ─────────────
// 서버 modules/common/record_envelope.py · 안드로이드와 같은 바이트 규칙:
//   "IRMSREC1"(8) · 머리 길이(4, 빅엔디언) · 머리 JSON(UTF-8) · AES-256-GCM 암호문‖태그(16)
//   열쇠 = HKDF-SHA256(ECDH x 좌표 32바이트, salt = 임시 공개키 65바이트, info = "irms-record-v1"), AAD = 봉투 앞부분 전부.
export const RECORD_MAGIC = 'IRMSREC1';
export const RECORD_ALG = 'ECDH-P256/HKDF-SHA256/AES-256-GCM';
export const RECORD_INNER_NAME = 'irms-record.irmsrec';
const RECORD_INFO = 'irms-record-v1';
const ECDH_P256 = { name: 'ECDH', namedCurve: 'P-256' };

export function b64Encode(bytes) {
  const b = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** 기록 공개키 id = SPKI DER SHA-256 앞 16 hex(서버 record_envelope.key_id 와 같다). */
export async function recordKeyId(spkiBase64) {
  return (await sha256Hex(b64Decode(spkiBase64))).slice(0, 16);
}

/**
 * 묶음 zip(평문) → 기록 봉투 바이트. meta = {user: IRMS 사용자 id(정수) 또는 null, created: ISO 시각, name: 보내는 파일 이름}.
 * [ephemeralJwk]·[iv] 는 시험에서만 고정한다 — 평소에는 매번 새 임시 열쇠와 IV.
 */
export async function sealRecord(plaintext, recipientSpkiB64, { user = null, created = '', name = '' } = {}, { ephemeralJwk = null, iv = null } = {}) {
  if (!recipientSpkiB64) throw new Error('기록 암호화 공개키가 없습니다.');
  const spki = b64Decode(recipientSpkiB64);
  const recipient = await subtle.importKey('spki', spki, ECDH_P256, false, []);
  let priv;
  let epk;
  if (ephemeralJwk) {
    priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: ephemeralJwk.x, y: ephemeralJwk.y, d: ephemeralJwk.d }, ECDH_P256, false, ['deriveBits']);
    epk = new Uint8Array(65);
    epk[0] = 4;
    epk.set(b64urlDecode(ephemeralJwk.x), 1);
    epk.set(b64urlDecode(ephemeralJwk.y), 33);
  } else {
    const pair = await subtle.generateKey(ECDH_P256, false, ['deriveBits']);
    priv = pair.privateKey;
    epk = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  }
  if (epk.length !== 65 || epk[0] !== 4) throw new Error('임시 공개키 형식이 올바르지 않습니다.');
  const nonce = iv ? new Uint8Array(iv) : globalThis.crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  if (nonce.length !== NONCE_SIZE) throw new Error('IV 길이가 올바르지 않습니다.');
  const userId = Number.isInteger(user) ? user : null;
  const header = { v: 1, alg: RECORD_ALG, kid: (await sha256Hex(spki)).slice(0, 16), epk: b64Encode(epk), iv: b64Encode(nonce),
    user: userId, created: String(created || ''), name: String(name || '') };
  const head = utf8(JSON.stringify(header));
  const magic = utf8(RECORD_MAGIC);
  const prefix = new Uint8Array(magic.length + 4 + head.length);
  prefix.set(magic, 0);
  new DataView(prefix.buffer).setUint32(magic.length, head.length, false);
  prefix.set(head, magic.length + 4);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, priv, 256);
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: utf8(RECORD_INFO) }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const sealed = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: prefix, tagLength: 128 }, key, plaintext));
  const out = new Uint8Array(prefix.length + sealed.length);
  out.set(prefix, 0);
  out.set(sealed, prefix.length);
  return out;
}
