// 카스몬고 AR 데모 — 화면 흐름·미션·기록을 묶는 진입점.
// 카스 병을 비추면 병 옆에 카스몬(3D 캐릭터)이 나타난다.
import * as THREE from "../vendor/three/three.module.js";
import { ArSession, ArError, hasWebGL } from "./ar.js";
import { BottleDetector, DetectorError } from "./detector.js";
import { CHARACTERS, createCharacter, createConfetti, createShadow, renderThumbnails } from "./characters.js";
import { CHARACTER_IDS, TAPS_TO_COLLECT, createStore, ensureGame, markStarted, newId, nextGame, registerHit } from "./game.js";
import { EVENT_NAMES, createLogger } from "./logger.js";

const PLACEMENT = new URLSearchParams(location.search).get("placement") === "side" ? "side" : "transform"; // 기본: 병이 변신
const LOST_GRACE_MS = 700; // 이 시간 안에 다시 잡히면 '유실'로 보지 않는다 (깜박임으로 로그가 쌓이는 것 방지)
const SCAN_TIPS_AFTER_MS = 15000;

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

// ---------- 병 탐지기 (한 번만 내려받는다) ----------
let detectorPromise = null;
let detectorInfo = null;
let modelProgress = 0;
function getDetector() {
  if (!detectorPromise) {
    const d = new BottleDetector();
    detectorPromise = d
      .load((p) => {
        modelProgress = p;
        const el = $("#ar-loading-text");
        if (el && currentScreen === "ar") el.textContent = `카스몬 탐지기 준비 중… ${Math.round(p * 100)}%`;
      })
      .then((info) => {
        detectorInfo = info;
        return d;
      })
      .catch((e) => {
        detectorPromise = null; // 다시 시도할 수 있게
        throw e;
      });
  }
  return detectorPromise;
}

// ---------- AR 미션 ----------
let ar = null;
let stage = null; // 앵커 아래 Y-up 무대
let character = null;
let confetti = null;
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
  if (s === "scanning") {
    badge.textContent = "병 찾는 중";
    title.textContent = "테이블 위 카스 병을 비춰주세요";
    sub.textContent = PLACEMENT === "transform" ? "병 전체가 화면에 들어오게 비추면 병이 카스몬으로 변신해요." : "병 전체가 화면에 들어오게 비추면 카스몬이 나타나요.";
  } else if (s === "lost") {
    badge.textContent = "다시 찾는 중";
    title.textContent = "카스 병을 다시 비춰주세요";
    sub.textContent = g && g.status === "active" ? `${ch.name} 미션 진행 ${g.taps}/${TAPS_TO_COLLECT} 은(는) 그대로 유지돼요.` : "병을 비추면 캐릭터가 다시 나타나요.";
    $("#tap-dots").classList.toggle("keep", !!(g && g.status === "active"));
  } else if (s === "transforming") {
    badge.textContent = "카스 병 발견";
    title.textContent = "카스 병이 변신하고 있어요!";
    sub.textContent = "병을 계속 비춰 주세요.";
  } else if (s === "found") {
    badge.textContent = PLACEMENT === "transform" ? "변신 성공" : "캐릭터 발견";
    title.textContent = PLACEMENT === "transform" ? `카스 병이 ${ch.name}(으)로 변신! 3번 터치하세요` : `${ch.name} 발견! 캐릭터를 3번 터치하세요`;
    sub.textContent = g.taps ? `좋아요! ${TAPS_TO_COLLECT - g.taps}번 더 터치하면 획득해요.` : "캐릭터를 직접 눌러야 해요.";
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
  // 앵커(ar.js)가 병 옆 바닥선 위치·크기를 잡아 주므로 무대는 그대로 둔다
  stage = new THREE.Group();
  stage.add(createShadow());
  confetti = createConfetti();
  stage.add(confetti.group);
  ar.anchor.add(stage);
}

function onRawFound(det) {
  if (track.lostTimer) {
    // 유실 유예 시간 안에 다시 잡힘 → 연속 추적으로 본다(로그 없음)
    clearTimeout(track.lostTimer);
    track.lostTimer = 0;
    // 변신 도중에 잠깐 놓쳤다면(연출이 취소됨) 다시 변신시킨다
    if (stage && !stage.visible) playReveal();
    return;
  }
  if (track.confirmed) return;
  track.confirmed = true;
  track.foundAt = performance.now();

  // 첫 인식 때 미션이 없으면 만든다 (캐릭터는 이때 무작위로 확정, 이후 재인식으로 바뀌지 않음)
  const r = ensureGame(state, ctx);
  state = r.state;
  save();
  const g = state.game;
  if (!character || character.id !== g.character_id) buildStageFor(g.character_id);
  // 변신 연출이 끝날 무렵(REVEAL) 캐릭터(그림자 포함 무대 전체)를 보인다. side 모드는 바로 등장
  stage.visible = false;
  track.loggedFound++;
  logger.log("target_found", {
    game_id: g.game_id,
    character_id: g.character_id,
    detected_class: det ? det.name : null,
    confidence: det ? +det.score.toFixed(3) : null,
    elapsed_ms: Math.round(performance.now() - track.cameraReadyAt),
    lost_ms: track.everFound ? Math.round(performance.now() - track.lostAt) : null,
    occurrence: track.loggedFound,
  });
  track.everFound = true;
  startGameIfNeeded();
  playReveal();
}

/** 변신 연출 → 끝날 무렵 캐릭터 등장 + 안내 문구 전환 */
function playReveal() {
  setArState("transforming");
  ar.playTransform(() => {
    if (!character || !stage || !track.confirmed) return;
    stage.visible = true;
    character.spawn(t3);
    const gg = state.game;
    if (gg.status === "completed") {
      setArState("collected");
      showCollectCard(false);
    } else {
      if (PLACEMENT === "transform" && confetti) confetti.burst(t3);
      setArState("found");
    }
  });
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
  if (!ar || !ar.running) return;
  const x = ev.clientX;
  const y = ev.clientY;
  // three.js 레이캐스트는 visible 을 보지 않으므로, 변신 중(아직 안 보이는) 캐릭터는 직접 걸러낸다
  const hit = character && ar.anchor.visible && stage && stage.visible ? ar.hitTest(x, y, character.hitTargets) : null;
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

/** 캐릭터 발이 가려지지 않도록 하단 안내 카드(또는 획득 카드) 윗선을 돌려준다 */
function safeBottom() {
  const card = $("#collect-card");
  const el = !card.hidden ? card : $("#status");
  const top = el.getBoundingClientRect().top;
  return top > 0 ? top - $("#ar-stage").getBoundingClientRect().top : null;
}

function onFrame(t, dt) {
  t3 += dt;
  if (character) character.update(t3);
  if (confetti) confetti.update(t3);
  if (!track.confirmed && currentScreen === "ar" && track.scanSince &&
      performance.now() - track.scanSince > SCAN_TIPS_AFTER_MS && $("#scan-tips").hidden &&
      $("#screen-ar").dataset.state !== "loading") {
    $("#scan-tips").hidden = false;
  }
  if (debugOn) updateDebug();
}

async function startAr() {
  go("ar");
  $("#ar-place").textContent = placeLabel();
  $("#collect-card").hidden = true;
  $("#resume").hidden = true;
  $("#ar-loading").hidden = false;
  $("#ar-loading-text").textContent = detectorInfo ? "카메라 준비 중…" : `카스몬 탐지기 준비 중… ${Math.round(modelProgress * 100)}%`;
  $("#screen-ar").dataset.state = "loading";
  Object.assign(track, { confirmed: false, lostTimer: 0, everFound: false, scanSince: 0 });
  track.startPressedAt = performance.now();

  // 모델(약 27MB)을 받기 전에, 어차피 안 되는 환경은 바로 안내한다
  if (!window.isSecureContext) return showError(new ArError("insecure"));
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return showError(new ArError("unsupported"));
  if (!hasWebGL()) return showError(new ArError("webgl"));

  let detector;
  try {
    detector = await getDetector();
  } catch (e) {
    showError(new ArError(e instanceof DetectorError ? e.kind : "runtime", e.cause || e));
    return;
  }
  if (currentScreen !== "ar") return;
  $("#ar-loading-text").textContent = "카메라 준비 중…";

  ar = new ArSession($("#ar-stage"), { onFound: onRawFound, onLost: onRawLost, onFrame, safeBottom }, { placement: PLACEMENT });
  ensureStage();
  try {
    await ar.start(detector);
  } catch (e) {
    const err = e instanceof ArError ? e : new ArError("unknown", e);
    ar.stop();
    ar = null;
    showError(err);
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
    video_width: ar.video.videoWidth,
    video_height: ar.video.videoHeight,
    detector_backend: detectorInfo.backend,
    detector_threads: detectorInfo.threads,
    placement: PLACEMENT,
    elapsed_ms: Math.round(track.cameraReadyAt - track.startPressedAt),
  });
  $("#ar-loading").hidden = true;
  // 이전 미션이 있으면 같은 캐릭터를 미리 올려 둔다 (보이는 건 병을 찾은 뒤)
  if (state.game) buildStageFor(state.game.character_id);
  setArState("scanning");
}

function stopAr() {
  if (track.lostTimer) clearTimeout(track.lostTimer);
  track.lostTimer = 0;
  track.confirmed = false;
  if (ar) ar.stop();
  ar = null;
  if (character) { character.dispose(); character = null; }
  stage = null;
}

// ---------- 오류 ----------
const inApp = /KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|DaumApps|everytimeApp/i.test(navigator.userAgent);
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function showError(err) {
  const E = {
    denied: {
      t: "카메라 권한이 거부됐어요",
      d: "카메라를 허용해야 카스 병을 찾을 수 있어요.",
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
    model_load: { t: "인식 데이터를 불러오지 못했어요", d: "네트워크가 불안정해 병 인식 데이터(약 27MB)를 받지 못했어요.", s: ["와이파이·데이터 연결을 확인해 주세요.", "아래 ‘다시 시도’를 눌러 주세요."] },
    runtime: { t: "병 인식 기능을 시작하지 못했어요", d: "이 기기·브라우저에서 인식 엔진이 동작하지 않았어요.", s: ["최신 Safari(iPhone) 또는 Chrome(Android)으로 열어 주세요.", "다른 앱을 닫고 다시 시도해 주세요."], copy: true },
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
  lines.push(`screen=${currentScreen} state=${$("#screen-ar").dataset.state} model=${detectorInfo ? detectorInfo.backend + (detectorInfo.threads ? "x" + detectorInfo.threads : "") : Math.round(modelProgress * 100) + "%"} coi=${self.crossOriginIsolated}`);
  if (ar && ar.video) {
    lines.push(`video ${ar.video.videoWidth}x${ar.video.videoHeight} detect ${ar.stats.detectMs.toFixed(0)}ms ${ar.stats.detectFps}fps render ${ar.stats.renderFps.toFixed(0)}fps`);
    lines.push(`raw found/lost ${ar.stats.rawFound}/${ar.stats.rawLost} · logged ${track.loggedFound}/${track.loggedLost} · miss taps ${track.misses} · ${PLACEMENT} fx ${ar.stats.transforms}/${ar.stats.reveals}`);
    lines.push("dets " + (ar.stats.lastDets.map((d) => `${d.name}:${d.score.toFixed(2)}`).join(" ") || "-"));
    const b = ar.bottleScreenBox;
    lines.push(b ? `bottle (${b.x1.toFixed(0)},${b.y1.toFixed(0)})-(${b.x2.toFixed(0)},${b.y2.toFixed(0)})` : "bottle: not tracked");
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
  get characterVisible() { return !!(ar && ar.anchor.visible && character && stage && stage.visible); },
  placement: PLACEMENT,
  /** 병 가림막이 화면 (x,y) 에 칠해졌는지 (alpha 0~255) */
  coverAlpha(x, y) {
    if (!ar || !ar.cover) return null;
    const r = ar.cover.canvas.getBoundingClientRect();
    return ar.cover.ctx.getImageData(Math.round(x - r.left), Math.round(y - r.top), 1, 1).data[3];
  },
  cameraActive: () => !!(ar && ar.cameraActive),
  /** 추적 중인 병의 화면 박스 (컨테이너 기준 px) */
  bottleBox: () => (ar ? ar.bottleScreenBox : null),
  /** 캐릭터 발(앵커 원점)의 화면 위치 */
  anchorScreenPoint: () => (ar && ar.anchor.visible ? ar.projectObject(ar.anchor) : null),
  /** 캐릭터 몸통의 지금 화면 위치 (점프·회전 중이면 그 순간의 메시 위치) */
  characterScreenPoint() {
    if (!ar || !ar.anchor.visible || !character || !stage || !stage.visible) return null;
    ar.scene.updateMatrixWorld(true);
    const c = new THREE.Box3().setFromObject(character.root).getCenter(new THREE.Vector3());
    const local = character.root.worldToLocal(c);
    return ar.projectObject(character.root, [local.x, local.y, local.z]);
  },
  detector: () => detectorInfo,
  logs: () => logger.all(),
  stats: () => (ar ? { ...ar.stats } : null),
};

// ---------- 바인딩 ----------
function bind() {
  $("#adult-check").addEventListener("change", (e) => ($("#btn-start").disabled = !e.target.checked));
  $("#btn-start").addEventListener("click", () => {
    if (window.isSecureContext && navigator.mediaDevices) getDetector().catch(() => {}); // 안내 화면을 읽는 동안 인식 모델을 미리 받는다
    go("permission");
  });
  $("#btn-camera").addEventListener("click", () => startAr());
  $("#btn-close").addEventListener("click", () => go("intro"));
  $("#btn-next").addEventListener("click", onNextExplore);
  $("#btn-retry").addEventListener("click", () => startAr());
  $("#btn-copy-url").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      toast("주소를 복사했어요.");
    } catch {
      prompt("이 주소를 복사해 브라우저에 붙여 넣어 주세요.", location.href);
    }
  });
  $("#btn-resume").addEventListener("click", () => startAr());
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
      stopAr();
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
