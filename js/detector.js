// 카스 병 탐지기 — 운영 인식 서버의 병 모델(cassBottle.pt, YOLOv5s)을 ONNX 로 바꿔 폰 브라우저에서 돌린다.
// 카메라 프레임은 기기 밖으로 나가지 않는다.
//
// 클래스(cassBottle.pt): 0 cass_cap 1 cass_nocap 2 zero_cap 3 zero_nocap 4 newlemon_cap 5 newlemon_nocap 6 other
// 0~5 만 '카스 병'으로 인정한다. 6(other, 타사·기타 병)은 버린다.
import * as ort from "../vendor/ort/ort.webgpu.min.mjs";

export const MODEL_URL = "models/cass-bottle-416.onnx";
export const INPUT = 416;
export const CLASS_NAMES = ["cass_cap", "cass_nocap", "zero_cap", "zero_nocap", "newlemon_cap", "newlemon_nocap", "other"];
const CASS_CLASSES = new Set([0, 1, 2, 3, 4, 5]);
const MIN_SCORE = 0.25; // 후보 하한. 등장·유지 판정 임계값은 tracker.js
const NMS_IOU = 0.45;

export class DetectorError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind; // model_load | runtime
    this.cause = cause;
  }
}

/** 모델을 내려받는다 (진행률 콜백). 브라우저 HTTP 캐시를 쓴다. */
async function fetchModel(url, onProgress) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new DetectorError("model_load", e);
  }
  if (!res.ok) throw new DetectorError("model_load", new Error(`HTTP ${res.status}`));
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      // 압축 전송이면 content-length 가 실제보다 작을 수 있어 1 을 넘지 않게 자른다
      if (total && onProgress) onProgress(Math.min(1, got / total));
    }
  } catch (e) {
    throw new DetectorError("model_load", e);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export class BottleDetector {
  constructor() {
    this.session = null;
    this.backend = null;
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.canvas.height = INPUT;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.input = new Float32Array(3 * INPUT * INPUT);
    this.lastMs = 0;
  }

  /** 모델 로드. WebGPU 가 되면 WebGPU, 아니면 WASM(교차 출처 격리 시 멀티스레드). */
  async load(onProgress) {
    ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    ort.env.logLevel = "error";
    const bytes = await fetchModel(MODEL_URL, onProgress);
    const tries = [];
    if (navigator.gpu) tries.push("webgpu");
    else ort.env.wasm.proxy = true; // WebGPU 가 없으면 WASM 추론을 워커에서 돌려 화면(애니메이션)이 멈추지 않게 한다
    tries.push("wasm");
    let lastErr;
    for (const ep of tries) {
      try {
        this.session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: "all" });
        this.backend = ep;
        // 첫 실행은 셰이더·커널 준비로 느리다 → 미리 한 번 돌려 둔다
        await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * INPUT * INPUT), [1, 3, INPUT, INPUT]) });
        return { backend: ep, threads: ep === "wasm" ? ort.env.wasm.numThreads : null };
      } catch (e) {
        lastErr = e;
        console.error(`[detector] ${ep} 실패`, e);
        this.session = null;
      }
    }
    throw new DetectorError("runtime", lastErr);
  }

  /**
   * 비디오 한 프레임에서 카스 병 후보를 찾는다.
   * @returns {Array<{cls:number, name:string, score:number, x1:number, y1:number, x2:number, y2:number}>} 비디오 픽셀 좌표
   */
  async detect(video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !this.session) return [];
    // letterbox: 비율 유지, 회색(114) 여백 — 학습·서버 전처리와 같다
    const r = Math.min(INPUT / vw, INPUT / vh);
    const nw = Math.round(vw * r);
    const nh = Math.round(vh * r);
    const px = Math.floor((INPUT - nw) / 2);
    const py = Math.floor((INPUT - nh) / 2);
    const ctx = this.ctx;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, INPUT, INPUT);
    ctx.drawImage(video, 0, 0, vw, vh, px, py, nw, nh);
    const data = ctx.getImageData(0, 0, INPUT, INPUT).data;
    const plane = INPUT * INPUT;
    // 프록시(워커) 모드는 입력 버퍼를 워커로 넘겨(transfer) 비워 버리므로 매번 새로 만든다
    const inp = ort.env.wasm.proxy ? new Float32Array(3 * plane) : this.input;
    for (let i = 0, j = 0; i < plane; i++, j += 4) {
      inp[i] = data[j] / 255;
      inp[i + plane] = data[j + 1] / 255;
      inp[i + 2 * plane] = data[j + 2] / 255;
    }
    const t0 = performance.now();
    const out = await this.session.run({ [this.session.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, INPUT, INPUT]) });
    this.lastMs = performance.now() - t0;
    const t = out[this.session.outputNames[0]];
    const [, n, stride] = t.dims; // [1, N, 5+nc]
    const d = t.data;
    const nc = stride - 5;
    const cands = [];
    for (let i = 0; i < n; i++) {
      const o = i * stride;
      const obj = d[o + 4];
      if (obj < MIN_SCORE) continue;
      let best = 0;
      let bc = -1;
      for (let c = 0; c < nc; c++) {
        if (d[o + 5 + c] > best) {
          best = d[o + 5 + c];
          bc = c;
        }
      }
      const score = obj * best;
      if (score < MIN_SCORE || !CASS_CLASSES.has(bc)) continue;
      const cx = d[o];
      const cy = d[o + 1];
      const w = d[o + 2];
      const h = d[o + 3];
      cands.push({
        cls: bc,
        name: CLASS_NAMES[bc],
        score,
        x1: (cx - w / 2 - px) / r,
        y1: (cy - h / 2 - py) / r,
        x2: (cx + w / 2 - px) / r,
        y2: (cy + h / 2 - py) / r,
      });
    }
    return nms(cands, NMS_IOU);
  }

  dispose() {
    try {
      this.session && this.session.release && this.session.release();
    } catch {}
    this.session = null;
  }
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return u > 0 ? inter / u : 0;
}

// 클래스 구분 없이 NMS: 같은 병이 cap/nocap 두 클래스로 겹쳐 나와도 하나로 본다
function nms(boxes, thr) {
  boxes.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of boxes) if (keep.every((k) => iou(k, b) < thr)) keep.push(b);
  return keep;
}
