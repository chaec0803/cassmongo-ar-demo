// 카스몬고 AR 데모 — 화면 흐름·미션·기록을 묶는 진입점.
import * as THREE from "../vendor/three/three.module.js";
import { ArSession, ArError } from "./ar.js";
import { CHARACTERS, createCharacter, createConfetti, createShadow, renderThumbnails } from "./characters.js";
import { CHARACTER_IDS, TAPS_TO_COLLECT, createStore, ensureGame, markStarted, newId, nextGame, registerHit } from "./game.js";
import { EVENT_NAMES, createLogger } from "./logger.js";
import { startBottleExperiment } from "./bottle.js";

const TARGET_URL = "targets/cassmongo-table.mind";
const LOST_GRACE_MS = 700; // 이 시간 안에 다시 잡히면 '유실'로 보지 않는다 (깜박임으로 로그가 쌓이는 것 방지)
const SCAN_TIPS_AFTER_MS = 15000;
const STAGE_SCALE = 0.42; // 캐릭터 키 ≈ 타깃 폭의 46%

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// ---------- 매장·테이블 컨텍스트 ----------
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const rawStore = params.get("store_id");
const rawTable = params.get("table_id");
const placeValid = ID_RE.test(rawStore || "") && ID_RE.test(rawTable || "");

function sessionId() {
  try {
    let id = sessionStorage.getItem("cassmongo.session");
    if (!id) {
      id = newId("s");
      sessionStorage.setItem("cassmongo.session", id);
    }
    return id;
  } catch {
    return newId("s");
  }
}

const ctx = {
  store_id: placeValid ? rawStore : null,
  table_id: placeValid ? rawTable : null,
  session_id: sessionId(),
};

let storage;
try {
  storage = window.localStorage;
  storage.setItem("cassmongo.probe", "1");
  storage.removeItem("cassmongo.probe");
} catch {
  storage = { getItem: () => null, setItem: () => { throw new Error("no storage"); }, removeItem: () => {} };
}
const store = createStore(storage);
const logger = createLogger({ storage, context: ctx });
let state = store.load();
const save = () => store.save(state);

// ---------- 화면 전환 ----------
const screens = ["intro", "permission", "ar", "error"];
let currentScreen = null;
function go(name) {
  if (currentScreen === "ar" && name !== "ar") stopAr();
  for (const s of screens) $(`#screen-${s}`).hidden = s !== name;
  currentScreen = name;
}

function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

const placeLabel = () => (ctx.store_id ? `매장 ${ctx.store_id} · 테이블 ${ctx.table_id}` : "매장 정보 없음");

// ---------- 썸네일·도감 ----------
let thumbs = null;
function thumbImg(id, collected) {
  if (!thumbs) return null;
  const img = new Image();
  img.src = collected ? thumbs[id].color : thumbs[id].silhouette;
  img.alt = collected ? CHARACTERS[id].name : "미발견 캐릭터";
  return img;
}

function speciesCount() {
  return CHARACTER_IDS.filter((id) => state.collection[id] > 0).length;
}

function refreshCounts() {
  document.querySelectorAll(".dex-count").forEach((el) => (el.textContent = `${speciesCount()}/3`));
  const hero = $("#hero-thumbs");
  hero.innerHTML = "";
  for (const id of CHARACTER_IDS) {
    const img = thumbImg(id, state.collection[id] > 0);
    if (img) hero.appendChild(img);
  }
}

function renderDex() {
  const total = CHARACTER_IDS.reduce((a, id) => a + state.collection[id], 0);
  $("#dex-summary").textContent = `수집 ${speciesCount()}/3종 · 총 획득 ${total}회`;
  const grid = $("#dex-grid");
  grid.innerHTML = "";
  for (const id of CHARACTER_IDS) {
    const n = state.collection[id];
    const card = document.createElement("div");
    card.className = "dex-card" + (n > 0 ? " got" : "");
    card.dataset.character = id;
    const img = thumbImg(id, n > 0);
    if (img) card.appendChild(img);
    else {
      const f = document.createElement("div");
      f.className = "fallback";
      f.style.background = n > 0 ? CHARACTERS[id].color : "#0b2a66";
      card.appendChild(f);
    }
    const nm = document.createElement("div");
    nm.className = "nm";
    nm.textContent = n > 0 ? CHARACTERS[id].name : "???";
    const st = document.createElement("div");
    st.className = "st";
    st.textContent = n > 0 ? (n > 1 ? `획득 ${n}회 · 중복 ${n - 1}` : "획득 1회") : "미발견";
    card.append(nm, st);
    if (n > 0) {
      const cnt = document.createElement("span");
      cnt.className = "cnt";
      cnt.textContent = `×${n}`;
      card.appendChild(cnt);
    }
    grid.appendChild(card);
  }
}

// ---------- 참여 기록 화면 ----------
function renderLog() {
  const all = logger.all();
  const counts = Object.fromEntries(EVENT_NAMES.map((e) => [e, 0]));
  for (const e of all) counts[e.event] = (counts[e.event] || 0) + 1;
  $("#log-summary").innerHTML = "";
  for (const [k, v] of Object.entries(counts)) {
    const s = document.createElement("span");
    s.textContent = `${k} ${v}`;
    $("#log-summary").appendChild(s);
  }
  const sel = $("#log-filter");
  if (sel.options.length === 1) {
    for (const e of Object.keys(counts)) sel.add(new Option(e, e));
  }
  const filter = sel.value;
  const list = $("#log-list");
  list.innerHTML = "";
  const rows = all.filter((e) => !filter || e.event === filter).slice(-300).reverse();
  if (!rows.length) list.textContent = "기록이 없습니다.";
  for (const e of rows) {
    const div = document.createElement("div");
    div.className = "log-item";
    const { event, timestamp, ...rest } = e;
    div.innerHTML = `<b></b> <span class="t"></span><div></div>`;
    div.querySelector("b").textContent = event;
    div.querySelector(".t").textContent = timestamp;
    div.querySelector("div").textContent = JSON.stringify(rest);
    list.appendChild(div);
  }
}

function downloadLog() {
  const blob = new Blob([logger.exportJSON()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cassmongo-log-${ctx.store_id || "nostore"}-${ctx.table_id || "notable"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function openModal(name) {
  if (name === "dex") renderDex();
  if (name === "log") renderLog();
  document.querySelectorAll(".modal").forEach((m) => (m.hidden = m.id !== `modal-${name}`));
}

// ---------- AR 미션 ----------
let ar = null;
let stage = null; // 앵커 아래 Y-up 무대
let character = null;
let confetti = null;
let arMode = "table"; // table | bottle_experiment
let bottleExp = null;
let t3 = 0; // three 애니메이션 시계(초)
const track = {
  confirmed: false, // 디바운스 거친 '인식 중' 상태
  lostTimer: 0,
  foundAt: 0,
  cameraReadyAt: 0,
  startPressedAt: 0,
  scanSince: 0,
  everFound: false,
  loggedFound: 0,
  loggedLost: 0,
  misses: 0,
};

function setArState(s) {
  $("#screen-ar").dataset.state = s;
  const badge = $("#status-badge");
  const title = $("#status-title");
  const sub = $("#status-sub");
  const g = state.game;
  const ch = g ? CHARACTERS[g.character_id] : null;
  $("#scan-tips").hidden = true;
  if (arMode === "bottle_experiment") return; // 실험 모드는 bottle.js 가 상태 문구를 그린다
  if (s === "scanning") {
    badge.textContent = "인식 대기";
    title.textContent = "테이블의 카스몬고 이미지를 비춰주세요";
    sub.textContent = "카드 전체가 네모 안에 들어오게 맞춰 주세요.";
  } else if (s === "lost") {
    badge.textContent = "다시 찾는 중";
    title.textContent = "이미지를 다시 비춰주세요";
    sub.textContent = g && g.status === "active" ? `${ch.name} 미션 진행 ${g.taps}/${TAPS_TO_COLLECT} 은(는) 그대로 유지돼요.` : "카드를 비추면 캐릭터가 다시 나타나요.";
    $("#tap-dots").classList.toggle("keep", !!(g && g.status === "active"));
  } else if (s === "found") {
    badge.textContent = "캐릭터 발견";
    title.textContent = `${ch.name} 발견! 캐릭터를 3번 터치하세요`;
    sub.textContent = g.taps ? `좋아요! ${TAPS_TO_COLLECT - g.taps}번 더 터치하면 획득해요.` : "카드 위의 캐릭터를 직접 눌러야 해요.";
  }
  document.querySelectorAll("#tap-dots i").forEach((d, i) => d.classList.toggle("on", !!g && i < g.taps));
}

function buildStageFor(characterId) {
  if (character) {
    stage.remove(character.root);
    character.dispose();
  }
  character = createCharacter(characterId);
  stage.add(character.root);
  character.spawn(t3);
}

function ensureStage() {
  stage = new THREE.Group();
  stage.rotation.x = Math.PI / 2; // 무대 Y-up → 타깃 평면의 법선(+Z) 방향으로 세운다
  stage.scale.setScalar(STAGE_SCALE);
  stage.position.set(0, 0.02, 0);
  stage.add(createShadow());
  confetti = createConfetti();
  stage.add(confetti.group);
  ar.anchor.add(stage);
}

function onRawFound() {
  if (track.lostTimer) {
    // 유실 유예 시간 안에 다시 잡힘 → 연속 추적으로 본다(로그 없음)
    clearTimeout(track.lostTimer);
    track.lostTimer = 0;
    return;
  }
  if (track.confirmed) return;
  track.confirmed = true;
  track.foundAt = performance.now();
  if (arMode === "bottle_experiment") return bottleExp && bottleExp.onFound();

  // 첫 인식 때 미션이 없으면 만든다 (캐릭터는 이때 무작위로 확정, 이후 재인식으로 바뀌지 않음)
  const r = ensureGame(state, ctx);
  state = r.state;
  save();
  const g = state.game;
  if (!character || character.id !== g.character_id) buildStageFor(g.character_id);
  else if (!track.everFound) character.spawn(t3);
  track.loggedFound++;
  logger.log("target_found", {
    game_id: g.game_id,
    character_id: g.character_id,
    elapsed_ms: Math.round(performance.now() - track.cameraReadyAt),
    lost_ms: track.everFound ? Math.round(performance.now() - track.lostAt) : null,
    occurrence: track.loggedFound,
  });
  track.everFound = true;
  startGameIfNeeded();
  if (g.status === "completed") {
    setArState("collected");
    showCollectCard(false);
  } else setArState("found");
}

function startGameIfNeeded() {
  const r = markStarted(state);
  state = r.state;
  save();
  const g = state.game;
  logger.logOnce(`game_start:${g.game_id}`, "game_start", {
    game_id: g.game_id,
    character_id: g.character_id,
    elapsed_ms: Math.round(performance.now() - track.cameraReadyAt),
  });
}

function onRawLost() {
  if (!track.confirmed || track.lostTimer) return;
  track.lostTimer = setTimeout(() => {
    track.lostTimer = 0;
    track.confirmed = false;
    track.lostAt = performance.now();
    track.scanSince = performance.now();
    if (arMode === "bottle_experiment") return bottleExp && bottleExp.onLost();
    track.loggedLost++;
    const g = state.game;
    logger.log("target_lost", {
      game_id: g ? g.game_id : null,
      character_id: g ? g.character_id : null,
      tracked_ms: Math.round(performance.now() - track.foundAt - LOST_GRACE_MS),
    });
    $("#collect-card").hidden = true;
    setArState("lost");
  }, LOST_GRACE_MS);
}

function onTap(ev) {
  if (!ar || !ar.running || arMode !== "table") return;
  const x = ev.clientX;
  const y = ev.clientY;
  const hit = character && ar.anchor.visible ? ar.hitTest(x, y, character.hitTargets) : null;
  ring(x, y, !!hit);
  if (!hit) {
    track.misses++;
    return;
  }
  const g0 = state.game;
  const r = registerHit(state);
  if (r.result === "ignored") {
    character.react("jump", t3);
    return;
  }
  state = r.state;
  save();
  const g = state.game;
  const elapsed = Math.round(Date.now() - g.started_at);
  logger.log("character_tap", { game_id: g.game_id, character_id: g.character_id, tap_index: r.tapIndex, elapsed_ms: elapsed });
  navigator.vibrate && navigator.vibrate(25);
  pop(x, y, `${r.tapIndex}/${TAPS_TO_COLLECT}`);
  if (r.result === "counted") {
    character.react(r.tapIndex === 1 ? "jump" : "spin", t3);
    setArState("found");
  } else if (r.result === "completed") {
    character.react("dance", t3);
    confetti.burst(t3);
    logger.logOnce(`game_complete:${g0.game_id}`, "game_complete", {
      game_id: g.game_id, character_id: g.character_id, tap_count: g.taps, elapsed_ms: g.completed_at - g.started_at,
    });
    logger.logOnce(`character_collected:${g0.game_id}`, "character_collected", {
      game_id: g.game_id, character_id: g.character_id, collect_count: r.collectCount, is_duplicate: r.collectCount > 1,
      elapsed_ms: g.completed_at - g.started_at,
    });
    setArState("collected");
    refreshCounts();
    setTimeout(() => state.game && state.game.game_id === g.game_id && showCollectCard(true), 1300);
  }
}

function ring(x, y, hit) {
  const el = document.createElement("div");
  el.className = "tap-ring" + (hit ? " hit" : "");
  el.style.left = x + "px";
  el.style.top = y + "px";
  $("#screen-ar").appendChild(el);
  setTimeout(() => el.remove(), 500);
}
function pop(x, y, text) {
  const el = document.createElement("div");
  el.className = "tap-pop";
  el.textContent = text;
  el.style.left = x + "px";
  el.style.top = y - 30 + "px";
  $("#screen-ar").appendChild(el);
  setTimeout(() => el.remove(), 750);
}

function showCollectCard(fresh) {
  const g = state.game;
  if (!g || g.status !== "completed" || currentScreen !== "ar") return;
  const c = CHARACTERS[g.character_id];
  const n = state.collection[g.character_id];
  $("#collect-img").src = thumbs ? thumbs[c.id].color : "";
  $("#collect-name").textContent = c.name;
  $("#collect-desc").textContent = c.desc;
  $("#collect-count").textContent = n > 1 ? `${n}번째 획득 · 중복 ${n - 1}회` : "처음 획득했어요! 도감에 등록됐어요.";
  $("#collect-dup").textContent = `도감 ${speciesCount()}/3`;
  $(".collect .burst").textContent = fresh ? "획득!" : "획득 완료";
  $("#collect-card").hidden = false;
}

function onNextExplore() {
  const r = nextGame(state, ctx);
  if (!r.created) return;
  state = r.state;
  save();
  $("#collect-card").hidden = true;
  const g = state.game;
  buildStageFor(g.character_id);
  if (track.confirmed) {
    // 카드를 계속 비추는 중이면 새 캐릭터가 바로 등장한다
    startGameIfNeeded();
    setArState("found");
  } else {
    setArState("scanning");
  }
}

function onFrame(t, dt) {
  t3 += dt;
  if (character) character.update(t3);
  if (confetti) confetti.update(t3);
  if (arMode === "table" && !track.confirmed && currentScreen === "ar" && track.scanSince &&
      performance.now() - track.scanSince > SCAN_TIPS_AFTER_MS && $("#scan-tips").hidden &&
      $("#screen-ar").dataset.state !== "loading") {
    $("#scan-tips").hidden = false;
  }
  bottleExp && bottleExp.onFrame();
  if (debugOn) updateDebug();
}

async function startAr(mode = "table") {
  arMode = mode;
  go("ar");
  $("#ar-place").textContent = placeLabel();
  $("#exp-banner").hidden = mode !== "bottle_experiment";
  $("#exp-panel").hidden = mode !== "bottle_experiment";
  $("#collect-card").hidden = true;
  $("#resume").hidden = true;
  $("#ar-loading").hidden = false;
  $("#ar-loading-text").textContent = "카메라 준비 중…";
  $("#screen-ar").dataset.state = "loading";
  Object.assign(track, { confirmed: false, lostTimer: 0, everFound: false, scanSince: 0 });
  track.startPressedAt = performance.now();

  ar = new ArSession($("#ar-stage"), { onFound: onRawFound, onLost: onRawLost, onFrame });
  ensureStage();
  try {
    await ar.start(mode === "table" ? TARGET_URL : null);
  } catch (e) {
    const err = e instanceof ArError ? e : new ArError("unknown", e);
    ar.stop();
    ar = null;
    showError(err, mode);
    return;
  }
  if (currentScreen !== "ar") {
    // 준비 중에 화면을 떠났다
    stopAr();
    return;
  }
  track.cameraReadyAt = performance.now();
  track.scanSince = performance.now();
  logger.log("camera_ready", {
    game_id: state.game ? state.game.game_id : null,
    mode: arMode,
    video_width: ar.video.videoWidth,
    video_height: ar.video.videoHeight,
    elapsed_ms: Math.round(track.cameraReadyAt - track.startPressedAt),
  });
  $("#ar-loading").hidden = true;
  if (mode === "table") {
    // 이전 미션이 있으면 같은 캐릭터를 미리 올려 둔다 (보이는 건 인식 후)
    if (state.game) buildStageFor(state.game.character_id);
    setArState("scanning");
  } else {
    if (character) { stage.remove(character.root); character.dispose(); }
    character = createCharacter("cool");
    stage.add(character.root);
    bottleExp = startBottleExperiment({ ar, logger, ctx, track, onExit: () => go("intro"), toast });
  }
}

function stopAr() {
  if (track.lostTimer) clearTimeout(track.lostTimer);
  track.lostTimer = 0;
  track.confirmed = false;
  if (bottleExp) { bottleExp.dispose(); bottleExp = null; }
  if (ar) ar.stop();
  ar = null;
  if (character) { character.dispose(); character = null; }
  stage = null;
}

// ---------- 오류 ----------
const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|DaumApps|everytimeApp/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let lastErrorMode = "table";

function showError(err, mode) {
  lastErrorMode = mode;
  const E = {
    denied: {
      t: "카메라 권한이 거부됐어요",
      d: "카메라를 허용해야 테이블 카드를 찾을 수 있어요.",
      s: isIOS
        ? ["주소창의 ‘가가(aA)’ 또는 설정 > Safari > 카메라 에서 ‘허용’으로 바꿔 주세요.", "아래 ‘다시 시도’를 눌러 주세요. 계속 안 되면 페이지를 새로고침해 주세요."]
        : ["주소창 왼쪽 아이콘(자물쇠·설정)을 눌러 권한 > 카메라를 ‘허용’으로 바꿔 주세요.", "아래 ‘다시 시도’를 눌러 주세요. 계속 안 되면 페이지를 새로고침해 주세요."],
    },
    unsupported: {
      t: "이 브라우저에서는 카메라를 쓸 수 없어요",
      d: inApp ? "앱 안의 브라우저(인앱 브라우저)는 카메라를 막는 경우가 많아요." : "카메라 기능을 지원하지 않는 브라우저예요.",
      s: inApp
        ? ["화면 오른쪽 위(또는 아래) 메뉴에서 ‘다른 브라우저로 열기’를 눌러 주세요.", isIOS ? "Safari 로 열어 주세요." : "Chrome 으로 열어 주세요.", "또는 아래 ‘주소 복사’ 후 브라우저에 붙여 넣어 주세요."]
        : [isIOS ? "iPhone 은 Safari 로 열어 주세요 (iOS 14.3 이상)." : "Android 는 최신 Chrome 으로 열어 주세요.", "아래 ‘주소 복사’ 후 브라우저에 붙여 넣어 주세요."],
      copy: true,
    },
    insecure: {
      t: "보안 연결(HTTPS)이 아니에요",
      d: "카메라는 https:// 로 시작하는 주소에서만 켤 수 있어요.",
      s: ["테이블 QR을 다시 스캔해 https 주소로 접속해 주세요."],
      copy: true,
    },
    no_camera: { t: "카메라를 찾지 못했어요", d: "이 기기에서 사용할 수 있는 카메라가 없어요.", s: ["후면 카메라가 있는 휴대폰으로 접속해 주세요."] },
    camera_busy: {
      t: "카메라를 다른 곳에서 쓰고 있어요",
      d: "다른 앱이나 탭이 카메라를 쓰는 중이라 켤 수 없어요.",
      s: ["카메라·영상통화 앱을 종료해 주세요.", "이 페이지의 다른 탭이 열려 있다면 닫아 주세요.", "아래 ‘다시 시도’를 눌러 주세요."],
    },
    webgl: { t: "3D 화면을 그릴 수 없어요", d: "이 브라우저는 WebGL(3D 그래픽)을 지원하지 않거나 꺼져 있어요.", s: ["최신 Safari 또는 Chrome 으로 열어 주세요.", "절전 모드를 끄고 다시 시도해 주세요."], copy: true },
    target_load: { t: "인식 데이터를 불러오지 못했어요", d: "네트워크가 불안정해 카드 인식 데이터를 받지 못했어요.", s: ["와이파이·데이터 연결을 확인해 주세요.", "아래 ‘다시 시도’를 눌러 주세요."] },
    unknown: { t: "카메라를 시작하지 못했어요", d: "알 수 없는 오류가 발생했어요.", s: ["페이지를 새로고침한 뒤 다시 시도해 주세요.", "계속되면 Safari(iPhone) 또는 Chrome(Android)으로 열어 주세요."] },
  }[err.kind] || {};
  $("#err-title").textContent = E.t;
  $("#err-desc").textContent = E.d;
  const ol = $("#err-steps");
  ol.innerHTML = "";
  for (const s of E.s || []) {
    const li = document.createElement("li");
    li.textContent = s;
    ol.appendChild(li);
  }
  $("#err-code").textContent = `오류 코드: ${err.kind}${err.cause && err.cause.name ? " / " + err.cause.name : ""}`;
  $("#btn-copy-url").hidden = !E.copy;
  go("error");
}

// ---------- 디버그 ----------
let debugOn = params.get("debug") === "1";
function updateDebug() {
  const now = performance.now();
  if (now - (updateDebug._t || 0) < 200) return;
  updateDebug._t = now;
  const lines = [];
  lines.push(`mode=${arMode} screen=${currentScreen} state=${$("#screen-ar").dataset.state}`);
  if (ar && ar.video) {
    lines.push(`video ${ar.video.videoWidth}x${ar.video.videoHeight} proc ${ar.stats.processFps}fps render ${ar.stats.renderFps.toFixed(0)}fps`);
    lines.push(`raw found/lost ${ar.stats.rawFound}/${ar.stats.rawLost} · logged ${track.loggedFound}/${track.loggedLost} · miss taps ${track.misses}`);
    if (ar.anchor.visible) {
      const c = ar.project([0, 0, 0]);
      const r = ar.project([0.5, 0, 0]);
      lines.push(`target center (${c.x.toFixed(0)},${c.y.toFixed(0)}) halfW ${Math.hypot(r.x - c.x, r.y - c.y).toFixed(0)}px`);
    } else lines.push("target: not tracked");
  }
  const g = state.game;
  lines.push(g ? `game ${g.game_id.slice(-8)} ${g.character_id} ${g.status} taps ${g.taps}` : "game: none");
  lines.push(`collection ${JSON.stringify(state.collection)}`);
  lines.push(`storage ${store.persistent && logger.persistent ? "localStorage" : "memory-only"} · log ${logger.all().length}`);
  lines.push(`ctx ${ctx.store_id}/${ctx.table_id} ${ctx.session_id.slice(-8)}`);
  $("#debug-text").textContent = lines.join("\n");
}
function setDebug(on) {
  debugOn = on;
  $("#debug").hidden = !on;
  if (on) updateDebug();
}

// ---------- 테스트·디버그용 읽기 전용 훅 ----------
window.__cassmongo = {
  get state() { return JSON.parse(JSON.stringify(state)); },
  get arState() { return $("#screen-ar").dataset.state; },
  get screen() { return currentScreen; },
  get tracking() { return !!(ar && ar.anchor.visible); },
  get confirmed() { return track.confirmed; },
  get characterId() { return character ? character.id : null; },
  get characterVisible() { return !!(ar && ar.anchor.visible && character); },
  cameraActive: () => !!(ar && ar.cameraActive),
  project: (p) => (ar && ar.anchor.visible ? ar.project(p) : null),
  /** 캐릭터 몸통(무대 좌표 y=0.5) 의 화면 위치 */
  characterScreenPoint() {
    if (!ar || !ar.anchor.visible || !character) return null;
    ar.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(0, 0.5, 0).applyMatrix4(character.root.matrixWorld).project(ar.camera);
    const rect = ar.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  },
  logs: () => logger.all(),
  stats: () => (ar ? { ...ar.stats } : null),
};

// ---------- 바인딩 ----------
function bind() {
  $("#adult-check").addEventListener("change", (e) => ($("#btn-start").disabled = !e.target.checked));
  $("#btn-start").addEventListener("click", () => go("permission"));
  $("#btn-camera").addEventListener("click", () => startAr("table"));
  $("#btn-bottle").addEventListener("click", () => {
    if (!$("#adult-check").checked) return toast("먼저 ‘만 19세 이상입니다’를 확인해 주세요.");
    startAr("bottle_experiment");
  });
  $("#btn-close").addEventListener("click", () => go("intro"));
  $("#btn-next").addEventListener("click", onNextExplore);
  $("#btn-retry").addEventListener("click", () => startAr(lastErrorMode));
  $("#btn-copy-url").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("주소를 복사했어요.");
    } catch {
      prompt("이 주소를 복사해 브라우저에 붙여 넣어 주세요.", location.href);
    }
  });
  $("#btn-resume").addEventListener("click", () => startAr(arMode));
  $("#btn-resume-exit").addEventListener("click", () => go("intro"));
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  document.querySelectorAll("[data-open]").forEach((b) => b.addEventListener("click", () => openModal(b.dataset.open)));
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || e.target.closest("[data-close]")) m.hidden = true;
    });
  });
  $("#log-filter").addEventListener("change", renderLog);
  $("#btn-log-download").addEventListener("click", downloadLog);
  $("#ar-stage").addEventListener("pointerdown", onTap);

  let vTaps = 0;
  $("#version").addEventListener("click", () => {
    vTaps++;
    clearTimeout(bind._vt);
    bind._vt = setTimeout(() => (vTaps = 0), 1500);
    if (vTaps >= 5) {
      vTaps = 0;
      setDebug(!debugOn);
    }
  });
  $("#btn-debug-hide").addEventListener("click", () => setDebug(false));
  $("#btn-debug-reset").addEventListener("click", () => {
    if (!confirm("이 브라우저의 데모 수집·기록을 모두 지울까요?")) return;
    store.reset();
    logger.clear();
    state = store.load();
    refreshCounts();
    toast("데모 데이터를 초기화했어요.");
  });

  // 페이지를 떠나거나 백그라운드로 가면 카메라를 즉시 해제한다
  window.addEventListener("pagehide", () => stopAr());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && currentScreen === "ar" && ar) {
      const mode = arMode;
      stopAr();
      arMode = mode;
      $("#resume").hidden = false;
    }
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && currentScreen === "ar" && !ar) $("#resume").hidden = false;
  });
}

function init() {
  bind();
  $("#intro-place").textContent = placeLabel();
  $("#place-missing").hidden = placeValid;
  try {
    thumbs = renderThumbnails(220);
  } catch {
    thumbs = null;
  }
  refreshCounts();
  setDebug(debugOn);
  go("intro");
  logger.log("event_enter", {
    game_id: state.game ? state.game.game_id : null,
    entry: placeValid ? "table_qr" : "no_place_params",
    referrer_present: !!document.referrer,
    ua: navigator.userAgent,
  });
}

init();
