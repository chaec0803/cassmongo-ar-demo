// 실험 모드: 카스 병 라벨 추적 시험.
// 평면 이미지 추적기(MindAR)를 곡면 라벨에 그대로 적용했을 때 얼마나 유지되는지 '측정'만 한다.
// - 라벨은 현장에서 촬영하거나(가운데 점선 영역) 평면 라벨 이미지 파일을 골라 즉석에서 타깃으로 만든다.
// - 미션·수집은 없다. 결과는 지정 이미지(테이블 카드) 인식 성공과 섞지 않는다.
import { Compiler } from "../vendor/mindar/mindar-image.prod.js";

export function startBottleExperiment({ ar, logger, ctx, track, onExit, toast }) {
  const panel = document.getElementById("exp-panel");
  const screen = document.getElementById("screen-ar");
  const title = document.getElementById("status-title");
  const sub = document.getElementById("status-sub");
  const badge = document.getElementById("status-badge");
  const guide = document.createElement("div");
  guide.className = "exp-capture";
  screen.appendChild(guide);
  screen.dataset.state = "scanning";

  const stats = {
    readyAt: 0, trackedMs: 0, foundCount: 0, lostCount: 0, longestMs: 0, curStart: 0, features: 0, source: null,
  };
  let phase = "capture"; // capture | compiling | tracking
  let disposed = false;

  function renderCapture() {
    phase = "capture";
    guide.hidden = false;
    badge.textContent = "실험 · 1단계";
    title.textContent = "병 라벨을 노란 점선 안에 맞춰 주세요";
    sub.textContent = "라벨 정면을 가깝게 찍으면 즉석에서 인식 대상으로 만들어요. 평면 라벨 이미지 파일이 있으면 그 파일을 써도 돼요.";
    panel.innerHTML = `
      <div class="row"><button class="btn small primary" id="exp-shot">라벨 촬영</button>
      <label class="btn small ghost" style="margin:0;text-align:center">이미지 파일<input type="file" accept="image/*" id="exp-file" hidden></label></div>
      <div class="row"><button class="btn small ghost" id="exp-exit" style="margin:0">실험 종료</button></div>`;
    panel.querySelector("#exp-shot").onclick = () => {
      const r = guide.getBoundingClientRect();
      const canvas = ar.captureRegion(r);
      if (!canvas) return toast("카메라 화면을 가져오지 못했어요.");
      compile(canvas, "camera_capture");
    };
    panel.querySelector("#exp-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const img = new Image();
      img.src = URL.createObjectURL(f);
      try {
        await img.decode();
      } catch {
        return toast("이미지를 읽지 못했어요.");
      }
      compile(img, "uploaded_file");
    };
    panel.querySelector("#exp-exit").onclick = onExit;
  }

  function downscale(src, maxSide = 640) {
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  async function compile(src, source) {
    phase = "compiling";
    guide.hidden = true;
    badge.textContent = "실험 · 2단계";
    title.textContent = "라벨을 인식 대상으로 만드는 중…";
    sub.textContent = "기기 성능에 따라 수십 초 걸릴 수 있어요.";
    panel.innerHTML = `<div class="progress"><i id="exp-prog"></i></div>`;
    const img = downscale(src);
    const compiler = new Compiler();
    try {
      const data = await compiler.compileImageTargets([img], (p) => {
        const el = document.getElementById("exp-prog");
        if (el) el.style.width = Math.min(100, p) + "%";
      });
      if (disposed) return;
      stats.features = data[0].matchingData.reduce((a, d) => a + d.maximaPoints.length + d.minimaPoints.length, 0);
      stats.source = source;
      const buf = compiler.exportData();
      await ar.replaceTarget(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      Object.assign(stats, { readyAt: performance.now(), trackedMs: 0, foundCount: 0, lostCount: 0, longestMs: 0, curStart: 0 });
      logger.log("experiment_target_ready", {
        mode: "bottle_experiment", source, feature_points: stats.features, width: img.width, height: img.height,
      });
      phase = "tracking";
      renderTracking();
    } catch (e) {
      toast("인식 대상 만들기에 실패했어요. 다시 촬영해 주세요.");
      renderCapture();
    }
  }

  function renderTracking() {
    badge.textContent = "실험 · 3단계";
    title.textContent = track.confirmed ? "라벨 추적 중" : "같은 병 라벨을 비춰 주세요";
    sub.textContent = "병을 천천히 돌리거나 기울여 보세요. 추적이 얼마나 유지되는지 그대로 기록해요.";
  }

  function fmt(ms) {
    return (ms / 1000).toFixed(1) + "초";
  }

  function renderStats() {
    const now = performance.now();
    const total = now - stats.readyAt;
    const tracked = stats.trackedMs + (stats.curStart ? now - stats.curStart : 0);
    const longest = Math.max(stats.longestMs, stats.curStart ? now - stats.curStart : 0);
    if (!panel.querySelector("#exp-stats")) {
      // 버튼이 눌리는 도중 다시 그려지지 않도록 틀은 한 번만 만들고 숫자만 갱신한다
      panel.innerHTML = `
        <table id="exp-stats">
          <tr><td>타깃 특징점</td><td data-k="features"></td></tr>
          <tr><td>현재 상태</td><td data-k="state"></td></tr>
          <tr><td>추적 유지율</td><td data-k="ratio"></td></tr>
          <tr><td>인식 / 유실 횟수</td><td data-k="counts"></td></tr>
          <tr><td>최장 연속 추적</td><td data-k="longest"></td></tr>
        </table>
        <p class="fineprint" style="margin:6px 0">실험 결과입니다. 테이블 카드(지정 이미지) 인식 성공과 별개이며, 이 결과를 병 인식 성공으로 해석하지 마세요.</p>
        <div class="row"><button class="btn small ghost" id="exp-again" style="margin:0">라벨 다시 찍기</button><button class="btn small ghost" id="exp-exit2" style="margin:0">실험 종료</button></div>`;
      panel.querySelector("#exp-again").onclick = () => { summary(); renderCapture(); };
      panel.querySelector("#exp-exit2").onclick = onExit;
    }
    const set = (k, v) => (panel.querySelector(`[data-k="${k}"]`).textContent = v);
    set("features", `${stats.features}${stats.features < 150 ? " (적음 — 추적 불안정 예상)" : ""}`);
    set("state", track.confirmed ? "추적 중" : "놓침");
    set("ratio", `${total > 0 ? Math.round((tracked / total) * 100) : 0}% (${fmt(tracked)} / ${fmt(total)})`);
    set("counts", `${stats.foundCount} / ${stats.lostCount}`);
    set("longest", fmt(longest));
  }

  function summary() {
    if (phase !== "tracking" || !stats.readyAt) return;
    const now = performance.now();
    if (stats.curStart) {
      stats.trackedMs += now - stats.curStart;
      stats.longestMs = Math.max(stats.longestMs, now - stats.curStart);
      stats.curStart = 0;
    }
    const total = now - stats.readyAt;
    logger.log("experiment_summary", {
      mode: "bottle_experiment",
      source: stats.source,
      feature_points: stats.features,
      duration_ms: Math.round(total),
      tracked_ms: Math.round(stats.trackedMs),
      tracked_ratio: total > 0 ? +(stats.trackedMs / total).toFixed(3) : 0,
      found_count: stats.foundCount,
      lost_count: stats.lostCount,
      longest_track_ms: Math.round(stats.longestMs),
    });
    stats.readyAt = 0;
  }

  let lastRender = 0;
  renderCapture();

  return {
    onFound() {
      if (phase !== "tracking") return;
      stats.foundCount++;
      stats.curStart = performance.now();
      logger.log("target_found", { mode: "bottle_experiment", game_id: null, elapsed_ms: Math.round(performance.now() - stats.readyAt) });
      screen.dataset.state = "found";
      renderTracking();
    },
    onLost() {
      if (phase !== "tracking") return;
      stats.lostCount++;
      const now = performance.now();
      if (stats.curStart) {
        const span = now - stats.curStart;
        stats.trackedMs += span;
        stats.longestMs = Math.max(stats.longestMs, span);
        stats.curStart = 0;
      }
      logger.log("target_lost", { mode: "bottle_experiment", game_id: null });
      screen.dataset.state = "lost";
      renderTracking();
    },
    onFrame() {
      if (phase !== "tracking") return;
      const now = performance.now();
      if (now - lastRender > 300) {
        lastRender = now;
        renderStats();
      }
    },
    dispose() {
      summary();
      disposed = true;
      guide.remove();
      panel.innerHTML = "";
    },
  };
}
