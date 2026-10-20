// REQ-875 웹앱 설정. 버전은 맨 끝 번호만 올린다. 공개키는 android/gradle.properties 의 서버 승인 서명 공개키와 같아야 한다
// (scripts/release/publish_wincheck_pwa.py 가 올리기 전에 확인한다). 공개키라 비밀이 아니다(APK 에도 들어 있음).
export const VERSION = '1.2.2';
export const VERSION_CODE = 5;
export const PUBLIC_REPOSITORY = 'HongJeongHwan/IRMS-app';
/** 당첨 자료 암호문·요약(wins-latest.json)을 받는 곳 — 같은 GitHub Pages 의 data/ (릴리스 첨부는 브라우저에서 CORS 로 막힘). */
export const DATA_BASE = './data/';
export const SERVER_PUBLIC_KEY_BASE64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwaXhYTuiMNTj7q/k9mhCJt5xbtZNYaM75xjF8UbqvJu+2TjnwY/TdDFl6gZddw0K7PbRLKR2b12FuJqo7cSnOA==';
// REQ-889 기록 암호화 공개키(android/gradle.properties 와 같아야 한다).
export const RECORD_PUBLIC_KEY_BASE64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEs6RQ/wfdDtrfMpyqclM8ozEbwwbA4Pr5Lz1YzVpouDbsCW8w3y5DX+bM+KbxlDTxsEx7fnCwsWk1HS+DktTpDw==';
