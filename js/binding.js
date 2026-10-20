// REQ-854 사용자 연결 90일 — android data/wins/AppUser.kt UserBinding·UserBindingView 와 같은 규칙(DEC-REQ854-EXPIRY).

export const DAY = 86400;
export const REMIND_DAYS = 14;
export const CLOCK_SKEW_SECONDS = 600;
export const FIRST_NOTICE = '처음 한 번 사무실에서 IRMS에 로그인한 뒤 자료 열쇠 QR을 찍어 주세요';
export const EXPIRED_NOTICE = '사용 기간이 끝났습니다 — 사무실에서 IRMS에 로그인한 뒤 자료 열쇠 QR을 다시 찍어 주세요';
export const CLOCK_NOTICE = '휴대폰 시계가 맞지 않습니다(전에 본 시각보다 이릅니다) — 시계를 맞추거나 IRMS 자료 열쇠 QR을 다시 찍어 주세요';
export const remindNotice = (days) => `${days}일 남음 — 사무실에서 IRMS 자료 열쇠 QR을 다시 찍어 주세요`;

const SEOUL_OFFSET = 9 * 3600;

/** 「2027-01-17」(서울 날짜). */
export function seoulDate(epochSeconds) {
  return new Date((epochSeconds + SEOUL_OFFSET) * 1000).toISOString().slice(0, 10);
}

/** 「2027-01-17T09:30:00+09:00」 */
export function seoulIso(epochSeconds) {
  return new Date((epochSeconds + SEOUL_OFFSET) * 1000).toISOString().slice(0, 19) + '+09:00';
}

export const expired = (b, now) => now > b.expiresAt;
export const daysLeft = (b, now) => Math.floor((b.expiresAt - now + DAY - 1) / DAY);
export const bindingLabel = (b) => [b.name, b.org && b.org.trim() ? b.org : null, b.role && b.role.trim() ? b.role : null].filter(Boolean).join(' · ');
export const untilText = (b) => `~${seoulDate(b.expiresAt)}까지`;

/** 기록(record.json·manifest)에 적는 모양 — AppUser.kt UserBinding.json 과 같은 칸. */
export function bindingRecordJson(b, now) {
  return { id: b.userId, name: b.name, org: b.org, role: b.role, inspector: b.inspector,
    boundAt: seoulIso(b.boundAt), expiresAt: seoulIso(b.expiresAt), expired: expired(b, now) };
}

/**
 * 첫 화면 맨 위 사용자 줄. 연결 없음·기간 끝·시계 되돌림 → blocked(당첨 확인을 막음, 기록 보내기·열쇠 QR 찍기만).
 * lastSeen = 앱이 전에 본 가장 늦은 시각(되돌림 막기).
 */
export function bindingView(b, now, lastSeen = 0) {
  if (!b) return { label: null, until: null, notice: FIRST_NOTICE, warning: true, blocked: true };
  const rolledBack = now + CLOCK_SKEW_SECONDS < b.boundAt || now + CLOCK_SKEW_SECONDS < lastSeen;
  if (rolledBack) return { label: bindingLabel(b), until: untilText(b), notice: CLOCK_NOTICE, warning: true, blocked: true };
  if (expired(b, now)) return { label: bindingLabel(b), until: untilText(b), notice: EXPIRED_NOTICE, warning: true, blocked: true };
  const left = daysLeft(b, now);
  if (left <= REMIND_DAYS) return { label: bindingLabel(b), until: untilText(b), notice: remindNotice(left), warning: true, blocked: false };
  return { label: bindingLabel(b), until: untilText(b), notice: null, warning: false, blocked: false };
}
