// 화면 속 실제 병을 '지운 것처럼' 가린다.
// 탐지 모델은 병의 네모 박스만 주므로 정확한 윤곽은 모른다. 그래서
//  1) 박스 양옆(병 바깥) 색을 줄마다 좌→우로 이어 붙여 병 자리를 메우고 (작은 해상도로 만들어 키우므로 자연히 흐려진다)
//  2) 카스 병 모양 실루엣(가장자리 흐림)으로 잘라
//  3) 카메라 영상 위·3D 캔버스 아래의 2D 캔버스에 그린다.
// 배경이 단순할수록 자연스럽고, 복잡하면 번진 자국이 보인다. 병을 눕히면 실루엣이 맞지 않는다.

const FW = 40; // 메움 계산 해상도 (가로)
const FH = 120; // (세로)
const MARGIN_X = 0.2; // 병 폭 대비 양옆 샘플 여백 (실루엣 여유보다 커야 메움 색이 병 바깥에서 나온다)
const MARGIN_Y = 0.06;

/** 0..1 정규화 좌표의 카스 병 실루엣 (가로 중심 0.5). 뚜껑 → 목 → 어깨 → 몸통 */
function bottlePath(ctx, w, h) {
  // 목은 넉넉하게(병마다 목 굵기가 다르고, 박스 오차도 있다)
  const P = [
    [0.27, 0.0], [0.73, 0.0], [0.75, 0.06], [0.74, 0.1], [0.74, 0.26],
    [0.86, 0.34], [0.97, 0.42], [1.0, 0.5], [1.0, 0.96], [0.94, 1.0],
    [0.06, 1.0], [0.0, 0.96], [0.0, 0.5], [0.03, 0.42], [0.14, 0.34],
    [0.26, 0.26], [0.26, 0.1], [0.25, 0.06],
  ];
  ctx.beginPath();
  P.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)));
  ctx.closePath();
}

export class BottleCover {
  constructor(container) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "ar-mask";
    this.ctx = this.canvas.getContext("2d");
    container.appendChild(this.canvas);

    this.fill = document.createElement("canvas"); // 메움 결과 (작은 해상도)
    this.fill.width = FW;
    this.fill.height = FH;
    this.fctx = this.fill.getContext("2d", { willReadFrequently: true });

    // 가장자리가 부드러운 실루엣: 작은 크기로 그린 뒤 키워 쓰면 경계가 흐려진다
    this.sil = document.createElement("canvas");
    this.sil.width = 24;
    this.sil.height = 72;
    const s = this.sil.getContext("2d");
    s.translate(2, 2);
    bottlePath(s, 20, 68);
    s.fillStyle = "#000";
    s.fill();

    this.tmp = document.createElement("canvas");
    this.tctx = this.tmp.getContext("2d");
    this.region = null; // 메움 영역 (비디오 좌표, 병 박스보다 조금 큼)
    this.visible = false;
    this.ready = false;
  }

  resize(w, h) {
    this.canvas.width = Math.round(w);
    this.canvas.height = Math.round(h);
  }

  /** 탐지 때마다: 현재 프레임에서 병 자리 메움 이미지를 다시 만든다 */
  update(video, box) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const bw = box.x2 - box.x1;
    const bh = box.y2 - box.y1;
    const mx = bw * MARGIN_X + 3;
    const my = bh * MARGIN_Y;
    const rx1 = Math.max(0, box.x1 - mx);
    const rx2 = Math.min(vw, box.x2 + mx);
    const ry1 = Math.max(0, box.y1 - my);
    const ry2 = Math.min(vh, box.y2 + my);
    if (rx2 - rx1 < 4 || ry2 - ry1 < 4) return;
    this.region = { x1: rx1, y1: ry1, x2: rx2, y2: ry2 };
    const f = this.fctx;
    f.drawImage(video, rx1, ry1, rx2 - rx1, ry2 - ry1, 0, 0, FW, FH);
    const img = f.getImageData(0, 0, FW, FH);
    const d = img.data;
    // 병 바깥 띠(왼쪽/오른쪽) 폭 — 화면 가장자리에 붙어 띠가 없으면 반대쪽만 쓴다
    const k = FW / (rx2 - rx1);
    const lw = Math.max(0, Math.round((box.x1 - rx1) * k));
    const rw = Math.max(0, Math.round((rx2 - box.x2) * k));
    const useL = lw >= 1;
    const useR = rw >= 1;
    if (!useL && !useR) return;
    const avg = (y, a, b) => {
      let r = 0, g = 0, bl = 0, n = 0;
      for (let x = a; x < b; x++) {
        const i = (y * FW + x) * 4;
        r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++;
      }
      return [r / n, g / n, bl / n];
    };
    const rows = [];
    for (let y = 0; y < FH; y++) {
      const L = useL ? avg(y, 0, lw) : null;
      const R = useR ? avg(y, FW - rw, FW) : null;
      rows.push([L || R, R || L]);
    }
    // 세로로도 살짝 평균 내어 줄무늬를 줄인다
    const sm = rows.map((_, y) => {
      const out = [[0, 0, 0], [0, 0, 0]];
      let n = 0;
      for (let j = Math.max(0, y - 3); j <= Math.min(FH - 1, y + 3); j++, n++) {
        for (let s = 0; s < 2; s++) for (let c = 0; c < 3; c++) out[s][c] += rows[j][s][c];
      }
      return out.map((v) => v.map((c) => c / n));
    });
    for (let y = 0; y < FH; y++) {
      const [L, R] = sm[y];
      for (let x = 0; x < FW; x++) {
        const t = x / (FW - 1);
        const i = (y * FW + x) * 4;
        d[i] = L[0] + (R[0] - L[0]) * t;
        d[i + 1] = L[1] + (R[1] - L[1]) * t;
        d[i + 2] = L[2] + (R[2] - L[2]) * t;
        d[i + 3] = 255;
      }
    }
    f.putImageData(img, 0, 0);
    this.bottleInRegion = { x1: (box.x1 - rx1) / (rx2 - rx1), y1: (box.y1 - ry1) / (ry2 - ry1), x2: (box.x2 - rx1) / (rx2 - rx1), y2: (box.y2 - ry1) / (ry2 - ry1) };
    this.ready = true;
  }

  /**
   * 매 프레임: 화면 좌표의 (부드럽게 따라가는) 병 박스에 맞춰 그린다.
   * @param {{x1,y1,x2,y2}|null} sbox 화면(컨테이너 기준 px) 병 박스. null 이면 지운다.
   */
  draw(sbox, alpha = 1) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!sbox || !this.ready || !this.visible || alpha <= 0) return;
    const bw = sbox.x2 - sbox.x1;
    const bh = sbox.y2 - sbox.y1;
    const r = this.bottleInRegion;
    // 메움 이미지 전체가 놓일 화면 영역 (병 박스로부터 역산)
    const rw = bw / (r.x2 - r.x1);
    const rh = bh / (r.y2 - r.y1);
    const rx = sbox.x1 - r.x1 * rw;
    const ry = sbox.y1 - r.y1 * rh;
    // 실루엣은 병 박스보다 조금 크게 (박스 오차·흐린 가장자리 여유)
    const px = bw * 0.14;
    const py = bh * 0.05;
    const W = Math.ceil(bw + px * 2);
    const H = Math.ceil(bh + py * 2);
    if (this.tmp.width !== W || this.tmp.height !== H) {
      this.tmp.width = W;
      this.tmp.height = H;
    }
    const t = this.tctx;
    t.globalCompositeOperation = "source-over";
    t.clearRect(0, 0, W, H);
    t.imageSmoothingEnabled = true;
    t.drawImage(this.fill, rx - (sbox.x1 - px), ry - (sbox.y1 - py), rw, rh);
    t.globalCompositeOperation = "destination-in";
    t.drawImage(this.sil, 0, 0, W, H);
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.tmp, sbox.x1 - px, sbox.y1 - py);
    ctx.globalAlpha = 1;
  }

  dispose() {
    this.canvas.remove();
  }
}
