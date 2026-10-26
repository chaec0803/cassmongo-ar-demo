// 변신 연출: 인식 순간의 실제 병 모습을 잘라 3D 판에 붙이고 → 빛나며 → 비틀려 줄어들고 → 터지면서 캐릭터가 나온다.
import * as THREE from "../vendor/three/three.module.js";

export const TRANSFORM_MS = 1300;
export const REVEAL_AT = 0.62; // 진행률이 이 지점일 때 캐릭터 등장

export class TransformFx {
  /**
   * @param {HTMLVideoElement} video
   * @param {{x1,y1,x2,y2}} vbox 비디오 좌표 병 박스
   */
  constructor(video, vbox) {
    const w = Math.max(2, Math.round(vbox.x2 - vbox.x1));
    const h = Math.max(2, Math.round(vbox.y2 - vbox.y1));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(video, vbox.x1, vbox.y1, w, h, 0, 0, w, h);
    this.texture = new THREE.CanvasTexture(c);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // 아래쪽 가운데를 기준점으로: 바닥에 붙은 채 줄어든다
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false });
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    this.group = new THREE.Group();
    this.plane = new THREE.Mesh(geo, this.mat);
    this.glow = new THREE.Mesh(geo, this.glowMat);
    this.glow.position.z = 0.001;
    this.group.add(this.plane, this.glow);

    // 반짝이 (병 둘레를 돌며 모인다)
    this.sparks = [];
    const sg = new THREE.SphereGeometry(0.035, 8, 6);
    for (let i = 0; i < 18; i++) {
      const m = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: i % 3 ? 0xffffff : 0xffce00, transparent: true, toneMapped: false }));
      m.userData = { a: (i / 18) * Math.PI * 2, y: 0.1 + (i % 6) * 0.15, r: 0.75 + (i % 4) * 0.12 };
      this.group.add(m);
      this.sparks.push(m);
    }
    this.t0 = performance.now();
    this.revealed = false;
    this.done = false;
  }

  /** 매 프레임. place: {x, y(바닥), w, h} 월드 단위 병 크기·위치. 반환: 진행률 0..1 */
  update(place) {
    const p = Math.min(1, (performance.now() - this.t0) / TRANSFORM_MS);
    const g = this.group;
    g.position.set(place.x, place.y, place.z);
    const glowP = Math.min(1, p / 0.3);
    const shrinkP = Math.max(0, Math.min(1, (p - 0.3) / 0.35));
    const e = shrinkP * shrinkP;
    // 1) 빛나며 살짝 떨림  2) 비틀며 가늘고 낮게 줄어듦
    const wobble = p < 0.3 ? 1 + Math.sin(p * 60) * 0.03 * glowP : 1;
    this.plane.scale.set(place.w * wobble * (1 - 0.92 * e), place.h * (1 - 0.7 * e), 1);
    this.glow.scale.copy(this.plane.scale);
    this.plane.rotation.y = e * Math.PI * 1.5;
    this.glow.rotation.y = this.plane.rotation.y;
    this.glowMat.opacity = p < 0.3 ? glowP * 0.75 : 0.75 * (1 - shrinkP);
    this.mat.opacity = 1 - Math.max(0, (p - 0.5) / 0.15);
    for (const s of this.sparks) {
      const { a, y, r } = s.userData;
      const k = 1 - e;
      const aa = a + p * 9;
      s.position.set(Math.cos(aa) * r * place.w * 1.6 * k, (y * place.h) * (1 - 0.6 * e), Math.sin(aa) * 0.2);
      s.scale.setScalar(Math.max(0.01, place.h * 0.5 * (p < 0.65 ? 1 : 1 - (p - 0.65) / 0.35)));
      s.material.opacity = p < 0.65 ? Math.min(1, p * 5) : Math.max(0, 1 - (p - 0.65) / 0.3);
    }
    if (p >= 1) this.done = true;
    return p;
  }

  dispose() {
    this.group.removeFromParent();
    this.texture.dispose();
    this.mat.dispose();
    this.glowMat.dispose();
    this.plane.geometry.dispose();
    this.sparks.forEach((s) => s.material.dispose());
    this.sparks[0] && this.sparks[0].geometry.dispose();
  }
}
