// REQ-875 휴대폰 안 저장소(IndexedDB). 자료 열쇠는 꺼낼 수 없는 CryptoKey 로, 당첨 자료는 받은 암호문 그대로 둔다.
//  kv      : 설정·사용자 연결·마지막 본 시각·기기 id·당첨 자료 요약
//  keys    : key id → CryptoKey(AES-GCM, extractable=false). 'local' = 이 휴대폰의 제미나이 키를 감싸는 열쇠
//  wins    : 'current' → {packageId, generatedAt, keyId, blob(암호문), label, contentId, summary}
//  records : 기록 id → {id, record, files: {이름: Blob}, sent}

const DB_NAME = 'irms-wincheck';
const DB_VERSION = 1;
let opened = null;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

export function openDb() {
  if (opened) return opened;
  opened = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const name of ['kv', 'keys', 'wins', 'records']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return opened;
}

async function tx(store, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((v) => { result = v; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('저장소 쓰기가 취소되었습니다.'));
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => req(s.get(key)));
export const put = (store, key, value) => tx(store, 'readwrite', (s) => req(s.put(value, key)));
export const del = (store, key) => tx(store, 'readwrite', (s) => req(s.delete(key)));
export const keys = (store) => tx(store, 'readonly', (s) => req(s.getAllKeys()));
export const all = (store) => tx(store, 'readonly', (s) => req(s.getAll()));

export const kvGet = (k, fallback = null) => get('kv', k).then((v) => (v === undefined ? fallback : v));
export const kvSet = (k, v) => put('kv', k, v);

/** 이 휴대폰 전용 감싸개 열쇠(꺼낼 수 없음) — 제미나이 키를 저장할 때 쓴다(안드로이드 키스토어 대신). */
async function localKey() {
  let key = await get('keys', 'local');
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await put('keys', 'local', key);
  }
  return key;
}

export async function sealText(text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, await localKey(), new TextEncoder().encode(text));
  return { iv, data: new Uint8Array(data) };
}

export async function openText(sealed, aad) {
  if (!sealed) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: new TextEncoder().encode(aad) }, await localKey(), sealed.data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** 오래 남게 해 달라고 요청(홈 화면에 추가한 웹앱이면 대개 허락). */
export async function askPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* 무시 */ }
  return false;
}
