// 카메라 + MindAR 이미지 추적 + three.js 렌더링.
// MindAR 의 MindARThree 래퍼 대신 Controller 를 직접 쓴다:
//  - 카메라 오류 종류(권한 거부/미지원/점유)를 구분해 안내하기 위해
//  - 종료 시 카메라 트랙을 확실히 stop() 하기 위해
//  - 래퍼가 쓰는 three 구버전 API(sRGBEncoding) 의존을 피하기 위해
import * as THREE from "../vendor/three/three.module.js";
import { Controller } from "../vendor/mindar/mindar-image.prod.js";

export class ArError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // insecure | unsupported | denied | no_camera | camera_busy | webgl | target_load | unknown
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

export class ArSession {
  /**
   * @param {HTMLElement} container 전체 화면 컨테이너
   * @param {object} cb { onFound(), onLost(), onFrame(t, dt), onProcess() }
   */
  constructor(container, cb = {}) {
    this.container = container;
    this.cb = cb;
    this.video = null;
    this.stream = null;
    this.controller = null;
    this.renderer = null;
    this.running = false;
    this.anchorVisible = false;
    this.targetBuffer = null;
    this.markerDims = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera();
    this.anchor = new THREE.Group();
    this.anchor.matrixAutoUpdate = false;
    this.anchor.visible = false;
    this.scene.add(this.anchor);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x223355, 2.0));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(0.5, 1, 1);
    this.scene.add(dl);

    this.postMatrix = new THREE.Matrix4();
    this._raf = 0;
    this._lastT = 0;
    this._onResize = () => this.resize();
    this.stats = { processFps: 0, renderFps: 0, rawFound: 0, rawLost: 0 };
    this._procTimes = [];
  }

  /** target: URL 문자열 또는 ArrayBuffer(.mind) */
  async start(target) {
    if (this.running) return;
    if (!window.isSecureContext) throw new ArError("insecure");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new ArError("unsupported");
    if (!hasWebGL()) throw new ArError("webgl");

    // 1) 추적 데이터 먼저 (카메라를 켠 뒤 네트워크 오류가 나면 카메라만 켜진 채 남는 것을 피한다)
    if (!this.targetBuffer && target) {
      if (typeof target === "string") {
        let res;
        try {
          res = await fetch(target);
        } catch (e) {
          throw new ArError("target_load", e);
        }
        if (!res.ok) throw new ArError("target_load", new Error(`HTTP ${res.status}`));
        this.targetBuffer = await res.arrayBuffer();
      } else {
        this.targetBuffer = target;
      }
    }

    // 2) 후면 카메라
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
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

      if (this.targetBuffer) await this._buildController();
      else this.resize();
      this.running = true;
      window.addEventListener("resize", this._onResize);
      this._ro = new ResizeObserver(this._onResize);
      this._ro.observe(this.container);
      this._lastT = performance.now();
      this._loop();
    } catch (e) {
      this.stop();
      throw e instanceof ArError ? e : new ArError("unknown", e);
    }
  }

  async _buildController() {
    const video = this.video;
    // MindAR 의 입력 로더는 video.width/height 속성을 프레임 크기로 읽는다 (0 이면 빈 프레임을 처리한다)
    video.width = video.videoWidth;
    video.height = video.videoHeight;
    const controller = new Controller({
      inputWidth: video.videoWidth,
      inputHeight: video.videoHeight,
      maxTrack: 1,
      // 기본값(5/5)보다 약간 보수적으로: 순간 오검출로 캐릭터가 튀어나오지 않게
      warmupTolerance: 6,
      missTolerance: 6,
      onUpdate: (data) => this._onUpdate(data),
    });
    this.controller = controller;
    const { dimensions } = controller.addImageTargetsFromBuffer(this.targetBuffer.slice(0));
    const [w, h] = dimensions[0];
    this.markerDims = [w, h];
    // MindAR 좌표(px, 좌하단 원점) → 타깃 중심 원점, 타깃 폭 = 1 단위
    this.postMatrix.compose(
      new THREE.Vector3(w / 2, w / 2 + (h - w) / 2, 0),
      new THREE.Quaternion(),
      new THREE.Vector3(w, w, w),
    );
    this.resize();
    controller.dummyRun(video);
    controller.processVideo(video);
  }

  _onUpdate(data) {
    if (data.type === "processDone") {
      const now = performance.now();
      this._procTimes.push(now);
      while (this._procTimes.length && now - this._procTimes[0] > 1000) this._procTimes.shift();
      this.stats.processFps = this._procTimes.length;
      this.cb.onProcess && this.cb.onProcess();
      return;
    }
    if (data.type !== "updateMatrix") return;
    const { worldMatrix } = data;
    if (worldMatrix) {
      const m = new THREE.Matrix4();
      m.elements = [...worldMatrix];
      m.multiply(this.postMatrix);
      this.anchor.matrix.copy(m);
      this.anchor.matrixWorldNeedsUpdate = true;
      if (!this.anchorVisible) {
        this.anchorVisible = true;
        this.anchor.visible = true;
        this.stats.rawFound++;
        this.cb.onFound && this.cb.onFound();
      }
    } else if (this.anchorVisible) {
      this.anchorVisible = false;
      this.anchor.visible = false; // 추적을 잃으면 즉시 숨긴다
      this.stats.rawLost++;
      this.cb.onLost && this.cb.onLost();
    }
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._lastT) / 1000);
    this._lastT = now;
    this.stats.renderFps = this.stats.renderFps * 0.9 + (dt > 0 ? 1 / dt : 0) * 0.1;
    // 회전 등으로 카메라 해상도 방향이 바뀌면 추적기를 다시 만든다
    if (this.video && this.controller && this.video.videoWidth &&
        (this.video.videoWidth !== this.controller.inputWidth || this.video.videoHeight !== this.controller.inputHeight)) {
      this._rebuild();
    }
    this.cb.onFrame && this.cb.onFrame(now / 1000, dt);
    this.renderer.render(this.scene, this.camera);
  }

  async _rebuild() {
    if (this._rebuilding) return;
    this._rebuilding = true;
    this._disposeController();
    if (this.anchorVisible) this._onUpdate({ type: "updateMatrix", worldMatrix: null });
    await this._buildController();
    this._rebuilding = false;
  }

  _disposeController() {
    if (!this.controller) return;
    try {
      this.controller.stopProcessVideo();
      this.controller.worker && this.controller.worker.terminate();
    } catch {}
    this.controller = null;
  }

  resize() {
    const { renderer, camera, container, video, controller } = this;
    if (!video || !renderer) return;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const vw0 = video.videoWidth;
    const vh0 = video.videoHeight;
    if (!cw || !ch || !vw0 || !vh0) return;

    // 비디오는 화면을 꽉 채우도록(cover) 배치한다
    let vw, vh;
    const videoRatio = vw0 / vh0;
    const containerRatio = cw / ch;
    if (videoRatio > containerRatio) {
      vh = ch;
      vw = vh * videoRatio;
    } else {
      vw = cw;
      vh = vw / videoRatio;
    }
    video.style.width = vw + "px";
    video.style.height = vh + "px";
    video.style.left = -(vw - cw) / 2 + "px";
    video.style.top = -(vh - ch) / 2 + "px";

    renderer.setSize(cw, ch);
    if (!controller) return;
    // three 카메라의 시야각을 잘린 비디오에 맞춘다 (MindAR three.js 래퍼와 같은 식)
    const proj = controller.getProjectionMatrix();
    const fovAdjust = ch / vh;
    camera.fov = (2 * Math.atan((1 / proj[5]) * fovAdjust) * 180) / Math.PI;
    camera.near = proj[14] / (proj[10] - 1.0);
    camera.far = proj[14] / (proj[10] + 1.0);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  }

  /** 화면 좌표(px) → 레이캐스트. 맞힌 첫 오브젝트 또는 null */
  hitTest(clientX, clientY, targets) {
    if (!this.anchorVisible || !this.renderer) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.scene.updateMatrixWorld(true);
    const hits = ray.intersectObjects(targets, false);
    return hits.length ? hits[0] : null;
  }

  /** 앵커 로컬 좌표 점 → 화면 px (디버그·테스트용) */
  project(local) {
    if (!this.renderer) return null;
    this.scene.updateMatrixWorld(true);
    const v = new THREE.Vector3(...local).applyMatrix4(this.anchor.matrixWorld).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height, z: v.z };
  }

  /** 현재 비디오 프레임에서 화면 사각형(px) 부분을 잘라 캔버스로 (병 라벨 실험용) */
  captureRegion(rect) {
    const v = this.video;
    if (!v) return null;
    const scale = v.videoWidth / v.getBoundingClientRect().width;
    const vr = v.getBoundingClientRect();
    const sx = (rect.left - vr.left) * scale;
    const sy = (rect.top - vr.top) * scale;
    const sw = rect.width * scale;
    const sh = rect.height * scale;
    const c = document.createElement("canvas");
    c.width = Math.round(sw);
    c.height = Math.round(sh);
    c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }

  /** 다른 타깃으로 교체 (실험 모드) */
  async replaceTarget(buffer) {
    this.targetBuffer = buffer;
    if (!this.running) return;
    this._disposeController();
    if (this.anchorVisible) this._onUpdate({ type: "updateMatrix", worldMatrix: null });
    await this._buildController();
  }

  /** 카메라를 완전히 해제한다. 여러 번 불러도 안전하다. */
  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._disposeController();
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
    this.anchorVisible = false;
    this.anchor.visible = false;
    this.running = false;
  }

  get cameraActive() {
    return !!(this.stream && this.stream.getTracks().some((t) => t.readyState === "live"));
  }
}
