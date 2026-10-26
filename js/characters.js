// 카스몬고 3D 캐릭터 3종 — 외부 에셋 없이 three.js 기본 도형으로 직접 만든 마스코트.
// 모든 캐릭터는 Y-up, 발바닥 y=0, 키 약 1.1 단위로 만든다. 정면은 +Z.
import * as THREE from "../vendor/three/three.module.js";

export const CHARACTERS = {
  cool: { id: "cool", name: "쿨몽", color: "#1f6bff", desc: "시원한 거품 왕관을 쓴 카스몬고의 리더" },
  bubble: { id: "bubble", name: "버블몽", color: "#ffc21a", desc: "톡톡 튀는 탄산 방울을 몰고 다니는 장난꾸러기" },
  hop: { id: "hop", name: "홉몽", color: "#3fbf5a", desc: "홉 숲에서 건너온 초록 탐험가" },
};

const mat = (color, opts = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.0, ...opts });

function sphere(r, material, seg = 28) {
  return new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.75)), material);
}

/** 눈·입·볼. 반환값의 eyes 는 깜박임에 쓴다. */
function addFace(parent, { y, z, spread = 0.17, eyeR = 0.12, mouth = "smile", cheek = 0xff8fa3 }) {
  const white = mat(0xffffff, { roughness: 0.2 });
  const black = mat(0x111522, { roughness: 0.3 });
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * spread, y, z);
    const ball = sphere(eyeR, white);
    ball.scale.set(1, 1.15, 0.55);
    const pupil = sphere(eyeR * 0.58, black);
    pupil.position.set(0, -eyeR * 0.08, eyeR * 0.42);
    pupil.scale.set(1, 1.1, 0.5);
    const shine = sphere(eyeR * 0.2, white, 10);
    shine.position.set(eyeR * 0.22, eyeR * 0.25, eyeR * 0.68);
    eye.add(ball, pupil, shine);
    parent.add(eye);
    eyes.push(eye);
  }
  if (mouth === "smile") {
    const m = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.022, 10, 20, Math.PI), black);
    m.rotation.z = Math.PI;
    m.position.set(0, y - 0.17, z + 0.02);
    parent.add(m);
  } else {
    const m = sphere(0.07, mat(0x5a1020));
    m.scale.set(1, 0.8, 0.4);
    m.position.set(0, y - 0.18, z + 0.01);
    parent.add(m);
  }
  for (const sx of [-1, 1]) {
    const c = sphere(0.06, mat(cheek, { roughness: 0.8 }), 12);
    c.scale.set(1, 0.6, 0.3);
    c.position.set(sx * (spread + 0.12), y - 0.12, z - 0.02);
    parent.add(c);
  }
  return eyes;
}

function buildCool() {
  const body = new THREE.Group();
  const blue = mat(0x1f6bff);
  const deep = mat(0x0a3fb8);
  const foam = mat(0xffffff, { roughness: 0.7 });

  const torso = sphere(0.46, blue);
  torso.scale.set(1, 0.92, 0.95);
  torso.position.y = 0.5;
  const belly = sphere(0.33, mat(0xdfeeff));
  belly.scale.set(1, 1.05, 0.45);
  belly.position.set(0, 0.42, 0.3);
  body.add(torso, belly);

  // 거품 왕관
  const crown = new THREE.Group();
  const foamBits = [
    [0, 0.0, 0, 0.17], [0.16, -0.03, 0.05, 0.13], [-0.16, -0.03, 0.05, 0.13],
    [0.08, 0.08, -0.08, 0.12], [-0.09, 0.07, -0.07, 0.12], [0.24, -0.08, -0.06, 0.1], [-0.24, -0.08, -0.06, 0.1],
  ];
  for (const [x, y, z, r] of foamBits) {
    const f = sphere(r, foam, 16);
    f.position.set(x, y, z);
    crown.add(f);
  }
  crown.position.y = 0.94;
  body.add(crown);

  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = sphere(0.12, deep, 16);
    arm.scale.set(0.8, 1.2, 0.8);
    arm.position.set(sx * 0.47, 0.45, 0.05);
    body.add(arm);
    arms.push(arm);
    const foot = sphere(0.13, deep, 16);
    foot.scale.set(1, 0.55, 1.3);
    foot.position.set(sx * 0.2, 0.06, 0.08);
    body.add(foot);
  }
  const eyes = addFace(body, { y: 0.62, z: 0.38 });
  return {
    body, eyes, arms,
    idleExtra(t) {
      crown.rotation.z = Math.sin(t * 3.1) * 0.06;
      crown.scale.setScalar(1 + Math.sin(t * 4.2) * 0.03);
    },
  };
}

function buildBubble() {
  const body = new THREE.Group();
  const gold = mat(0xffc21a, { roughness: 0.35 });
  const amber = mat(0xe58a00);
  const glass = mat(0xffffff, { roughness: 0.1, transparent: true, opacity: 0.75 });

  const torso = sphere(0.42, gold);
  torso.scale.set(1.05, 1, 1);
  torso.position.y = 0.47;
  body.add(torso);

  // 안테나 + 꼭대기 방울
  const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.28, 10), amber);
  stalk.position.set(0.05, 0.98, 0);
  stalk.rotation.z = -0.25;
  const top = sphere(0.11, glass, 18);
  top.position.set(0.11, 1.15, 0);
  body.add(stalk, top);

  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = sphere(0.1, amber, 14);
    arm.scale.set(0.8, 1.25, 0.8);
    arm.position.set(sx * 0.44, 0.42, 0.04);
    body.add(arm);
    arms.push(arm);
    const foot = sphere(0.11, amber, 14);
    foot.scale.set(1, 0.55, 1.3);
    foot.position.set(sx * 0.18, 0.05, 0.07);
    body.add(foot);
  }
  // 주위를 도는 탄산 방울
  const orbit = new THREE.Group();
  orbit.position.y = 0.5;
  const bubbles = [];
  for (let i = 0; i < 6; i++) {
    const b = sphere(0.045 + (i % 3) * 0.018, glass, 14);
    const a = (i / 6) * Math.PI * 2;
    b.userData.base = { a, r: 0.62 + (i % 2) * 0.08, y: (i % 3) * 0.16 - 0.1 };
    orbit.add(b);
    bubbles.push(b);
  }
  body.add(orbit);
  const eyes = addFace(body, { y: 0.56, z: 0.36, eyeR: 0.13, mouth: "open", cheek: 0xff7a5c });
  return {
    body, eyes, arms,
    idleExtra(t) {
      for (const b of bubbles) {
        const { a, r, y } = b.userData.base;
        const aa = a + t * 1.4;
        b.position.set(Math.cos(aa) * r, y + Math.sin(t * 2 + a) * 0.08, Math.sin(aa) * r);
      }
      top.position.y = 1.15 + Math.sin(t * 5) * 0.02;
    },
  };
}

function buildHop() {
  const body = new THREE.Group();
  const greens = [mat(0x3fbf5a), mat(0x2f9e47), mat(0x5ad672)];
  const leaf = mat(0x1f7a35, { side: THREE.DoubleSide });

  const core = sphere(0.4, greens[0]);
  core.scale.set(0.95, 1.2, 0.95);
  core.position.y = 0.52;
  body.add(core);

  // 홉 비늘: 줄마다 어긋나게 겹친 납작 구
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    const y = 0.14 + r * 0.15;
    const ringR = Math.sin(((r + 0.5) / rows) * Math.PI) * 0.4 + 0.05;
    const n = 9;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (r % 2) * (Math.PI / n);
      // 정면(얼굴 자리)은 비워 둔다
      if (r >= 2 && r <= 4 && Math.abs(Math.atan2(Math.sin(a), Math.cos(a)) - Math.PI / 2) < 0.75) continue;
      const s = sphere(0.13, greens[(r + i) % 3], 12);
      s.scale.set(1, 0.75, 0.35);
      s.position.set(Math.cos(a) * ringR, y, Math.sin(a) * ringR);
      s.lookAt(Math.cos(a) * 3, y - 0.4, Math.sin(a) * 3);
      body.add(s);
    }
  }
  // 잎사귀 귀
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.2, 0.15, 0, 0.42);
  shape.quadraticCurveTo(-0.2, 0.15, 0, 0);
  const leafGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false });
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(leafGeo, leaf);
    ear.position.set(sx * 0.16, 0.98, 0);
    ear.rotation.z = -sx * 0.6;
    body.add(ear);
    ears.push(ear);
  }
  const arms = [];
  for (const sx of [-1, 1]) {
    const arm = sphere(0.09, greens[1], 12);
    arm.scale.set(0.8, 1.3, 0.8);
    arm.position.set(sx * 0.43, 0.5, 0.05);
    body.add(arm);
    arms.push(arm);
    const foot = sphere(0.1, greens[1], 12);
    foot.scale.set(1, 0.55, 1.3);
    foot.position.set(sx * 0.17, 0.05, 0.06);
    body.add(foot);
  }
  const eyes = addFace(body, { y: 0.62, z: 0.37, spread: 0.15, eyeR: 0.11 });
  return {
    body, eyes, arms,
    idleExtra(t) {
      ears[0].rotation.z = 0.6 + Math.sin(t * 2.6) * 0.15;
      ears[1].rotation.z = -0.6 - Math.sin(t * 2.6 + 0.8) * 0.15;
    },
  };
}

const BUILDERS = { cool: buildCool, bubble: buildBubble, hop: buildHop };

const easeOutBack = (p) => 1 + 2.7 * Math.pow(p - 1, 3) + 1.7 * Math.pow(p - 1, 2);

/**
 * 캐릭터 인스턴스. root 는 Y-up 무대 좌표의 Group 이다.
 * hitTargets: 레이캐스트 대상(캐릭터 몸에 속한 메시만, 그림자·효과 제외).
 */
export function createCharacter(id) {
  const built = BUILDERS[id]();
  const root = new THREE.Group();
  root.name = `character:${id}`;
  const mover = new THREE.Group(); // 점프·회전용
  mover.add(built.body);
  root.add(mover);

  const hitTargets = [];
  built.body.traverse((o) => {
    if (o.isMesh) {
      o.userData.characterId = id;
      hitTargets.push(o);
    }
  });

  let reaction = null; // {kind, t0, dur}
  let spawnT0 = null;
  let celebrating = false;
  let nextBlink = 1.5;

  return {
    id,
    root,
    hitTargets,
    spawn(t) {
      spawnT0 = t;
    },
    react(kind, t) {
      reaction = { kind, t0: t, dur: kind === "dance" ? 2.2 : kind === "spin" ? 0.8 : 0.6 };
      if (kind === "dance") celebrating = true;
    },
    update(t) {
      // 등장 연출
      let s = 1;
      if (spawnT0 !== null) {
        const p = Math.min(1, (t - spawnT0) / 0.6);
        s = Math.max(0.001, easeOutBack(p));
        if (p >= 1) spawnT0 = null;
      }
      root.scale.setScalar(s);

      // 대기 애니메이션: 호흡 + 살짝 흔들기 + 깜박임
      const bob = celebrating ? Math.abs(Math.sin(t * 5)) * 0.12 : Math.sin(t * 2.2) * 0.025 + 0.025;
      const breathe = 1 + Math.sin(t * 2.2) * 0.03;
      built.body.position.y = 0;
      built.body.scale.set(1 / Math.sqrt(breathe), breathe, 1 / Math.sqrt(breathe));
      mover.position.y = bob;
      mover.rotation.set(0, Math.sin(t * 0.8) * 0.18, Math.sin(t * 1.3) * 0.04);
      if (t > nextBlink) {
        const bp = (t - nextBlink) / 0.14;
        const ey = bp < 1 ? Math.max(0.1, Math.abs(1 - bp * 2)) : 1;
        built.eyes.forEach((e) => (e.scale.y = ey));
        if (bp >= 1) nextBlink = t + 2 + Math.random() * 2.5;
      }
      built.arms.forEach((a, i) => (a.rotation.z = (i ? -1 : 1) * (celebrating ? 0.9 + Math.sin(t * 10) * 0.4 : Math.sin(t * 2.2) * 0.1)));
      built.idleExtra(t);

      // 터치 반응
      if (reaction) {
        const p = (t - reaction.t0) / reaction.dur;
        if (p >= 1) {
          reaction = null;
        } else if (reaction.kind === "jump" || reaction.kind === "spin") {
          mover.position.y = bob + 0.55 * 4 * p * (1 - p);
          const squash = p < 0.12 ? 1 - p * 2 : p > 0.88 ? 1 - (1 - p) * 2 : 1.06;
          built.body.scale.y *= squash;
          if (reaction.kind === "spin") mover.rotation.y += p * Math.PI * 2;
        } else if (reaction.kind === "dance") {
          const k = p * 4;
          mover.position.y = bob + Math.abs(Math.sin(k * Math.PI)) * 0.35;
          mover.rotation.y += p * Math.PI * 4;
          mover.rotation.z = Math.sin(k * Math.PI * 2) * 0.35;
        }
      }
    },
    dispose() {
      root.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      });
    },
  };
}

/** 획득 축하 색종이 (무대 좌표). */
export function createConfetti() {
  const group = new THREE.Group();
  const colors = [0xffce00, 0xffffff, 0x1f6bff, 0x6ec0ff, 0xff7a5c];
  const geo = new THREE.PlaneGeometry(0.06, 0.035);
  const pieces = [];
  for (let i = 0; i < 60; i++) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: colors[i % colors.length], side: THREE.DoubleSide }));
    group.add(m);
    pieces.push(m);
  }
  let t0 = null;
  group.visible = false;
  return {
    group,
    burst(t) {
      t0 = t;
      group.visible = true;
      for (const p of pieces) {
        const a = Math.random() * Math.PI * 2;
        const sp = 0.5 + Math.random() * 0.9;
        p.userData.v = new THREE.Vector3(Math.cos(a) * sp * 0.6, 1.6 + Math.random() * 1.4, Math.sin(a) * sp * 0.6);
        p.userData.spin = new THREE.Vector3(Math.random() * 9, Math.random() * 9, Math.random() * 9);
        p.position.set(0, 0.7, 0);
      }
    },
    update(t) {
      if (t0 === null) return;
      const dt = t - t0;
      if (dt > 2.4) {
        group.visible = false;
        t0 = null;
        return;
      }
      for (const p of pieces) {
        const v = p.userData.v;
        p.position.set(v.x * dt, 0.7 + v.y * dt - 2.2 * dt * dt, v.z * dt);
        p.rotation.set(p.userData.spin.x * dt, p.userData.spin.y * dt, p.userData.spin.z * dt);
      }
    },
  };
}

/** 바닥 그림자 (반투명 원). 무대 좌표의 바닥(y=0)에 깐다. */
export function createShadow() {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 32),
    new THREE.MeshBasicMaterial({ color: 0x001133, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.003;
  return m;
}

/** 도감용 정지 썸네일 (실제 3D 모델을 렌더링). silhouette=true 면 미발견 실루엣. */
export function renderThumbnails(size = 240) {
  const canvas = document.createElement("canvas");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch {
    return null;
  }
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const out = {};
  for (const id of Object.keys(CHARACTERS)) {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 2.2));
    const dl = new THREE.DirectionalLight(0xffffff, 1.6);
    dl.position.set(1, 2, 2);
    scene.add(dl);
    const c = createCharacter(id);
    c.update(0.4);
    c.root.scale.setScalar(1);
    scene.add(c.root);
    const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    cam.position.set(0.9, 1.0, 2.6);
    cam.lookAt(0, 0.6, 0);
    renderer.render(scene, cam);
    const color = canvas.toDataURL("image/png");
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color: 0x0b2a66 });
    renderer.render(scene, cam);
    const silhouette = canvas.toDataURL("image/png");
    out[id] = { color, silhouette };
    c.dispose();
  }
  renderer.dispose();
  renderer.forceContextLoss?.();
  return out;
}
