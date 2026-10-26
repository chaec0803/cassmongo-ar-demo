// 탐지 결과(프레임마다 독립)를 '같은 병을 계속 보고 있다'는 상태로 묶는다. DOM 의존 없음.
//
// - 등장: 점수 FOUND_SCORE 이상인 후보가 연속 FOUND_HITS 프레임(서로 IoU ≥ MATCH_IOU) → 한 프레임 오검출로 캐릭터가 튀어나오지 않게
// - 유지: 직전 병과 겹치는(IoU ≥ MATCH_IOU) 후보가 KEEP_SCORE 이상이면 같은 병으로 갱신
// - 놓침: 연속 LOST_MISSES 프레임 그리고 LOST_MS 이상 못 찾으면 놓친 것으로 본다
import { iou } from "./detector.js";

export const FOUND_SCORE = 0.6;
export const KEEP_SCORE = 0.4;
export const FOUND_HITS = 2;
export const LOST_MISSES = 2;
export const LOST_MS = 350;
export const MATCH_IOU = 0.2;

export function createTracker() {
  let showing = false;
  let box = null; // 현재 병 (비디오 좌표)
  let pending = null; // 등장 후보
  let pendingHits = 0;
  let misses = 0;
  let lastHitAt = 0;

  function bestMatch(dets, ref, minScore) {
    let best = null;
    let bestKey = -1;
    for (const d of dets) {
      if (d.score < minScore) continue;
      const ov = ref ? iou(d, ref) : 1;
      if (ref && ov < MATCH_IOU) continue;
      const key = ov * 2 + d.score; // 같은 병(겹침) 우선, 다음 점수
      if (key > bestKey) {
        bestKey = key;
        best = d;
      }
    }
    return best;
  }

  return {
    get showing() {
      return showing;
    },
    get box() {
      return box;
    },
    /** @returns {"found"|"lost"|null} 상태가 바뀐 경우만 */
    update(dets, now) {
      if (showing) {
        const m = bestMatch(dets, box, KEEP_SCORE) || bestMatch(dets, null, FOUND_SCORE);
        if (m) {
          box = m;
          misses = 0;
          lastHitAt = now;
          return null;
        }
        misses++;
        if (misses >= LOST_MISSES && now - lastHitAt >= LOST_MS) {
          showing = false;
          box = null;
          pending = null;
          pendingHits = 0;
          return "lost";
        }
        return null;
      }
      const m = bestMatch(dets, pending, FOUND_SCORE);
      if (!m) {
        pending = null;
        pendingHits = 0;
        return null;
      }
      pending = m;
      pendingHits++;
      if (pendingHits >= FOUND_HITS) {
        showing = true;
        box = m;
        misses = 0;
        lastHitAt = now;
        pending = null;
        pendingHits = 0;
        return "found";
      }
      return null;
    },
    reset() {
      showing = false;
      box = null;
      pending = null;
      pendingHits = 0;
      misses = 0;
    },
  };
}
