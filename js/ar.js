// 카메라 + 카스 병 탐지 + three.js 렌더링.
// 병 탐지는 화면 속 병의 위치·크기(박스)만 준다. 캐릭터는 그 병 옆 바닥선에 서도록 놓고,
// 병이 움직이거나 가까워지면(커지면) 따라 움직이고 커진다. 병의 기울기·원근(3D 자세)은 알 수 없으므로 반영하지 않는다.
import * as THREE from "../vendor/three/three.module.js";
import { createTracker } from "./tracker.js";

export class ArError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // insecure | unsupported | denied | no_camera | camera_busy | webgl | model_load | runtime | unknown
    this.cause = cause;
  }
}

export function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

function classifyMediaError(err) {
  const name = err && err.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no_camera";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "camera_busy";
  return "unknown";
}

const DEPTH = 4; // 캐릭터를 놓는 카메라 앞 거리(월드 단위). 화면 px ↔ 월드 환산에만 쓴다
const FOV = 50;
const CHAR_UNITS = 1.15; // characters.js 캐릭터 키(월드 단위)

export class ArSession {
  /**
   * @param {HTMLElement} container
   * @param {object} cb { onFound(det), onLost(), onFrame(t, dt), onDetect(dets) }
   */
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;
    this.video = null;
    this.stream = null;
    this.renderer = null;
    this.detector = null;
    this.running = false;
    this.tracker = createTracker();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    this.anchor = new THREE.Group(); // 캐릭터가 서는 자리
    this.anchor.visible = false;
    this.scene.add(this.anchor);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 2.0));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(0.5, 1, 1);
    this.scene.add(dl);

    this._goal = null; // {x, y, s, side} 목표 배치 (화면 px)
    this._cur = null;
    this._side = 1;
    this._raf = 0;
    this._lastT = 0;
    this._onResize = () => this.resize();
    this.stats = { detectMs: 0, detectFps: 0, renderFps: 0, rawFound: 0, rawLost: 0, lastDets: [] };
    this._detTimes = [];
  }

  /** detector: 이미 load() 된 BottleDetector */
  async start(detector) {
    if (this.running) return;
    this.detector = detector;
    if (!window.isSecureContext) throw new ArError("insecure");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new ArError("unsupported");
    if (!hasWebGL()) throw new ArError("webgl");

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" } } });
    } catch (e) {
      throw new ArError(classifyMediaError(e), e);
    }

    try {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.setAttribute("muted", "");
      video.autoplay = true;
      video.className = "ar-video";
      this.container.prepend(video);
      this.video = video;
      video.srcObject = this.stream;
      await new Promise((resolve, reject) => {
        if (video.readyState >= 1) resolve();
        video.onloadedmetadata = () => resolve();
        setTimeout(() => reject(new Error("video metadata timeout")), 10000);
      });
      await video.play().catch(() => {});

      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      this.renderer.domElement.className = "ar-canvas";
      this.container.appendChild(this.renderer.domElement);

      this.running = true;
      this.resize();
      window.addEventListener("resize", this._onResize);
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.container);
      this._lastT = performance.now();
      this._loop();
      this._detectLoop();
    } catch (e) {
      this.stop();
      throw e instanceof ArError ? e : new ArError("unknown", e);
    }
  }

  async _detectLoop() {
    while (this.running) {
      const v = this.video;
      if (!v || v.readyState < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      let dets = [];
      try {
        dets = await this.detector.detect(v);
      } catch (e) {
        console.error("[detect]", e && e.message ? e.message : e);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      if (!this.running) break;
      const now = performance.now();
      this._detTimes.push(now);
      while (this._detTimes.length && now - this._detTimes[0] > 1000) this._detTimes.shift();
      this.stats.detectFps = this._detTimes.length;
      this.stats.detectMs = this.detector.lastMs;
      this.stats.lastDets = dets;
      this.cb.onDetect && this.cb.onDetect(dets);

      const change = this.tracker.update(dets, now);
      if (this.tracker.showing) this._setGoal(this.tracker.box);
      if (change === "found") {
        this.stats.rawFound++;
        this._cur = null; // 새로 잡히면 미끄러지지 않고 바로 그 자리에서 등장
        this.anchor.visible = true;
        this.cb.onFound && this.cb.onFound(this.tracker.box);
      } else if (change === "lost") {
        this.stats.rawLost++;
        this.anchor.visible = false; // 병을 놓치면 즉시 숨긴다
        this.cb.onLost && this.cb.onLost();
      }
      // 렌더링에 숨 돌릴 틈을 준다 (WASM 은 메인 스레드에서 돈다)
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
  }

  /** 비디오 좌표 박스 → 화면(CSS px, 컨테이너 기준) 박스 */
  videoBoxToScreen(b) {
    const v = this.video;
    const vr = v.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    const k = vr.width / v.videoWidth;
    return { x1: vr.left - cr.left + b.x1 * k, y1: vr.top - cr.top + b.y1 * k, x2: vr.left - cr.left + b.x2 * k, y2: vr.top - cr.top + b.y2 * k };
  }

  /**
   * 병 옆 바닥선에 캐릭터 자리를 잡는다.
   * - 키는 병 높이의 45% (화면 높이 28% 상한)
   * - 병 오른쪽/왼쪽 중 지금 쪽 → 반대쪽 순으로, 옆 공간에 맞게 줄여서(최소 MIN_SIDE px) 세운다
   * - 양옆 다 좁으면(병이 화면 가운데를 꽉 채움) 병 가장자리에 반쯤 겹쳐 세운다
   * - 발은 하단 안내 카드보다 위에 둔다 (cb.safeBottom)
   */
  _setGoal(vbox) {
    const MIN_SIDE = 80;
    const b = this.videoBoxToScreen(vbox);
    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    const bh = b.y2 - b.y1;
    const want = Math.max(MIN_SIDE, Math.min(H * 0.28, bh * 0.45));
    const gap = Math.max(4, bh * 0.02);
    const space = { 1: W - 4 - (b.x2 + gap), "-1": b.x1 - gap - 4 }; // 캐릭터 폭 ≈ 키
    // 좌우가 프레임마다 뒤집히지 않게: 지금 쪽에 최소 크기라도 들어가면 유지
    if (space[this._side] < MIN_SIDE && space[-this._side] >= MIN_SIDE) this._side = -this._side;
    let x;
    let s;
    if (space[this._side] >= MIN_SIDE) {
      s = Math.min(want, space[this._side]);
      x = this._side === 1 ? b.x2 + gap + s / 2 : b.x1 - gap - s / 2;
    } else {
      s = want;
      const edge = this._side === 1 ? b.x2 : b.x1;
      x = Math.min(W - s / 2 - 4, Math.max(s / 2 + 4, edge));
    }
    const safeBottom = (this.cb.safeBottom && this.cb.safeBottom()) || H;
    const y = Math.max(s + 8, Math.min(safeBottom - 8, b.y2 - bh * 0.02));
    this._goal = { x, y, s, side: this._side };
  }

  _applyAnchor(dt) {
    if (!this._goal) return;
    if (!this._cur) this._cur = { ...this._goal };
    else {
      const a = 1 - Math.exp(-dt * 14); // 탐지 간격 사이를 부드럽게 잇는다
      for (const k of ["x", "y", "s"]) this._cur[k] += (this._goal[k] - this._cur[k]) * a;
    }
    const H = this.container.clientHeight;
    const W = this.container.clientWidth;
    const k = (2 * DEPTH * Math.tan(((FOV / 2) * Math.PI) / 180)) / H; // 화면 px → 월드
    this.anchor.position.set((this._cur.x - W / 2) * k, -(this._cur.y - H / 2) * k, -DEPTH);
    this.anchor.scale.setScalar((this._cur.s * k) / CHAR_UNITS);
    // 병 쪽을 살짝 바라보고, 위에서 내려다본 듯 약간 숙인다
    this.anchor.rotation.set(0.12, -this._goal.side * 0.35, 0);
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._lastT) / 1000);
    this._lastT = now;
    this.stats.renderFps = this.stats.renderFps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
    if (this.anchor.visible) this._applyAnchor(dt);
    this.cb.onFrame && this.cb.onFrame(now / 1000, dt);
    this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const { renderer, camera, container, video } = this;
    if (!video || !renderer) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw0 = video.videoWidth;
    const vh0 = video.videoHeight;
    if (!cw || !ch || !vw0 || !vh0) return;
    // 비디오는 화면을 꽉 채우도록(cover) 배치한다
    let vw;
    let vh;
    if (vw0 / vh0 > cw / ch) {
      vh = ch;
      vw = vh * (vw0 / vh0);
    } else {
      vw = cw;
      vh = vw / (vw0 / vh0);
    }
    video.style.width = vw + "px";
    video.style.height = vh + "px";
    video.style.left = -(vw - cw) / 2 + "px";
    video.style.top = -(vh - ch) / 2 + "px";
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
    renderer.setSize(cw, ch);
  }

  /** 화면 좌표(px) → 레이캐스트. 맞힌 첫 오브젝트 또는 null */
  hitTest(clientX, clientY, targets) {
    if (!this.anchor.visible || !this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.scene.updateMatrixWorld(true);
    const hits = ray.intersectObjects(targets, false);
    return hits.length ? hits[0] : null;
  }

  /** 3D 오브젝트의 로컬 점 → 화면 px (디버그·테스트용) */
  projectObject(obj, local = [0, 0, 0]) {
    if (!this.renderer) return null;
    this.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(...local).applyMatrix4(obj.matrixWorld).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }

  /** 지금 추적 중인 병의 화면 박스(px, 컨테이너 기준) */
  get bottleScreenBox() {
    return this.tracker.showing && this.video ? this.videoBoxToScreen(this.tracker.box) : null;
  }

  /** 카메라를 완전히 해제한다. 여러 번 불러도 안전하다. */
  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    window.removeEventListener("resize", this._onResize);
    this._ro && this._ro.disconnect();
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
      this.video = null;
    }
    if (this.renderer) {
      this.renderer.domElement.remove();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.tracker.reset();
    this.anchor.visible = false;
    this._goal = this._cur = null;
  }

  get cameraActive() {
    return !!(this.stream && this.stream.getTracks().some((t) => t.readyState === "live"));
  }
}
