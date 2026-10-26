// 참여 이벤트 기록기 — 이 브라우저의 localStorage 에만 쌓는다. 서버로 보내지 않는다.
// 카메라 영상·사진은 어떤 경로로도 기록하지 않는다(필드에 이미지 데이터가 들어갈 자리가 없다).

const LOG_KEY = "cassmongo.demo.log.v1";
const ONCE_KEY = "cassmongo.demo.log.once.v1";
const MAX_EVENTS = 3000;

export const EVENT_NAMES = [
  "event_enter",
  "camera_ready",
  "target_found",
  "target_lost",
  "game_start",
  "character_tap",
  "game_complete",
  "character_collected",
];

export function createLogger({ storage, context }) {
  let memLog = [];
  let memOnce = new Set();
  let persistent = true;

  function readJSON(key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      persistent = false;
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      persistent = false;
    }
  }

  memLog = readJSON(LOG_KEY, []);
  memOnce = new Set(readJSON(ONCE_KEY, []));
  const listeners = new Set();

  function log(event, fields = {}) {
    const now = new Date();
    const entry = {
      event,
      store_id: context.store_id,
      table_id: context.table_id,
      session_id: context.session_id,
      game_id: fields.game_id ?? null,
      timestamp: now.toISOString(),
      ...fields,
    };
    if (entry.game_id === undefined) entry.game_id = null;
    memLog.push(entry);
    if (memLog.length > MAX_EVENTS) memLog = memLog.slice(-MAX_EVENTS);
    writeJSON(LOG_KEY, memLog);
    listeners.forEach((fn) => fn(entry));
    return entry;
  }

  /** 같은 key 로는 브라우저 저장소가 유지되는 한 단 1번만 기록한다 (game_start/complete/collected 용). */
  function logOnce(key, event, fields) {
    if (memOnce.has(key)) return null;
    memOnce.add(key);
    writeJSON(ONCE_KEY, [...memOnce].slice(-2000));
    return log(event, fields);
  }

  return {
    log,
    logOnce,
    all: () => memLog.slice(),
    get persistent() {
      return persistent;
    },
    onEntry(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    clear() {
      memLog = [];
      memOnce = new Set();
      try {
        storage.removeItem(LOG_KEY);
        storage.removeItem(ONCE_KEY);
      } catch {}
    },
    exportJSON() {
      return JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          scope: "local-browser-only",
          note: "이 파일은 데모 페이지가 이 브라우저 localStorage 에 쌓은 기록입니다. 서버에 저장된 데이터가 아니며 다른 기기의 기록은 포함되지 않습니다.",
          events: memLog,
        },
        null,
        2,
      );
    },
  };
}
