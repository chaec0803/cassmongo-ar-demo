// 미션(게임) 상태. DOM·three 에 의존하지 않는 순수 로직이라 단독 테스트가 가능하다.
//
// 규칙
// - 미션 1개 = game_id 1개 = 캐릭터 1종(생성 시점에 확정). 재인식·새로고침으로 바뀌지 않는다.
// - 3번 맞히면 completed. completed 이후의 터치는 무시한다(중복 완료·중복 지급 방지).
// - 새 미션은 '다음 탐험'(nextGame) 으로만 만든다. active 미션이 있으면 nextGame 은 거부된다.
//
// 이 상태는 브라우저 localStorage 에만 저장된다. 기기 간 공유되지 않고, 저장소를 지우면 초기화된다.
// 따라서 실제 부정 참여 방지 기능이 아니다.

export const TAPS_TO_COLLECT = 3;
export const CHARACTER_IDS = ["cool", "bubble", "hop"];

const STORAGE_KEY = "cassmongo.demo.state.v1";

export function emptyState() {
  return {
    v: 1,
    game: null,
    collection: Object.fromEntries(CHARACTER_IDS.map((id) => [id, 0])),
    completed_game_ids: [],
  };
}

export function newId(prefix) {
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  return prefix + "_" + Date.now().toString(36) + Array.from(rnd, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function pickCharacter(rng = Math.random) {
  return CHARACTER_IDS[Math.floor(rng() * CHARACTER_IDS.length) % CHARACTER_IDS.length];
}

function makeGame(ctx, rng) {
  return {
    game_id: newId("g"),
    character_id: pickCharacter(rng),
    taps: 0,
    status: "active",
    created_at: Date.now(),
    started_at: null, // 캐릭터가 처음 화면에 나타난 시각 (game_start)
    completed_at: null,
    store_id: ctx.store_id,
    table_id: ctx.table_id,
  };
}

/** 진행 중(또는 완료 후 '다음 탐험' 전) 미션을 돌려준다. 없을 때만 새로 만든다. */
export function ensureGame(state, ctx, rng) {
  if (state.game) return { state, created: false };
  return { state: { ...state, game: makeGame(ctx, rng) }, created: true };
}

/** '다음 탐험'. 현재 미션이 완료된 경우에만 새 미션을 만든다. */
export function nextGame(state, ctx, rng) {
  if (state.game && state.game.status !== "completed") return { state, created: false, reason: "active_game_exists" };
  return { state: { ...state, game: makeGame(ctx, rng) }, created: true };
}

/** 캐릭터가 처음 나타났을 때 1회만 started_at 을 기록한다. */
export function markStarted(state, now = Date.now()) {
  const g = state.game;
  if (!g || g.started_at !== null) return { state, started: false };
  return { state: { ...state, game: { ...g, started_at: now } }, started: true };
}

/**
 * 캐릭터 적중 1회 처리.
 * result: "ignored"(미션 없음/이미 완료) | "counted"(1·2번째) | "completed"(3번째, 이 미션에서 단 한 번)
 */
export function registerHit(state, now = Date.now()) {
  const g = state.game;
  if (!g || g.status !== "active" || g.started_at === null) return { state, result: "ignored" };
  if (state.completed_game_ids.includes(g.game_id)) return { state, result: "ignored" };
  const taps = g.taps + 1;
  if (taps < TAPS_TO_COLLECT) {
    return { state: { ...state, game: { ...g, taps } }, result: "counted", tapIndex: taps };
  }
  const collection = { ...state.collection, [g.character_id]: (state.collection[g.character_id] || 0) + 1 };
  return {
    state: {
      ...state,
      game: { ...g, taps, status: "completed", completed_at: now },
      collection,
      completed_game_ids: [...state.completed_game_ids, g.game_id].slice(-500),
    },
    result: "completed",
    tapIndex: taps,
    collectCount: collection[g.character_id],
  };
}

// ---- 저장 ----
export function createStore(storage) {
  let memory = null;
  let persistent = true;
  return {
    get persistent() {
      return persistent;
    },
    load() {
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) {
          const s = JSON.parse(raw);
          if (s && s.v === 1) return { ...emptyState(), ...s, collection: { ...emptyState().collection, ...s.collection } };
        }
      } catch {
        persistent = false;
      }
      return memory || emptyState();
    },
    save(state) {
      memory = state;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        persistent = false;
      }
    },
    reset() {
      memory = null;
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {}
    },
  };
}
