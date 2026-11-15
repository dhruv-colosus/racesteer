import * as THREE from 'three';
import { BOOST_PAD, pointOnTrack, type TrackPath } from '@racing/shared';
import { TRACKSIDE } from './config';
import type { Terrain } from './terrain';

/** Everything in the world but the cars: sky, hills, road, kerbs, barriers, boost pads, start gantry, trees. */

export const SKY = { top: 0x2f7fe0, horizon: 0xcfe6f7, fog: 0xcfe6f7 };

interface Edge {
  /** Lateral offset from the centre line; positive is right of travel. */
  offset: number;
  /** Height above the road surface. */
  y: number;
}

/**
 * A strip that follows the track between two edges. `a` must be to the left
 * of `b` (or below it) for the face to point up/outwards. `tile` is the
 * length of one texture repeat along the track, snapped so the loop closes
 * without a seam.
 */
function ribbon(path: TrackPath, a: Edge, b: Edge, tile: number): THREE.BufferGeometry {
  const rows = path.n + 1;
  const positions = new Float32Array(rows * 2 * 3);
  const uvs = new Float32Array(rows * 2 * 2);
  const repeats = Math.max(1, Math.round(path.length / tile));
  for (let r = 0; r < rows; r++) {
    const i = r % path.n;
    const rx = -path.tz[i]!;
    const rz = path.tx[i]!;
    const v = (r / path.n) * repeats;
    positions.set(
      [
        path.x[i]! + rx * a.offset,
        path.y[i]! + a.y,
        path.z[i]! + rz * a.offset,
        path.x[i]! + rx * b.offset,
        path.y[i]! + b.y,
        path.z[i]! + rz * b.offset,
      ],
      r * 6,
    );
    uvs.set([0, v, 1, v], r * 4);
  }
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    const a0 = r * 2;
    const b0 = a0 + 1;
    const a1 = a0 + 2;
    const b1 = a0 + 3;
    indices.push(a0, b0, a1, b0, b1, a1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Small deterministic PRNG so every player sees the same trees and the same speckle. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function speckle(ctx: CanvasRenderingContext2D, w: number, h: number, base: string, tones: string[], count: number, seed: number) {
  const rand = mulberry32(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = tones[Math.floor(rand() * tones.length)]!;
    const size = 1 + rand() * 2.5;
    ctx.globalAlpha = 0.25 + rand() * 0.5;
    ctx.fillRect(rand() * w, rand() * h, size, size);
  }
  ctx.globalAlpha = 1;
}

function createSky(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(SKY.top) },
      horizon: { value: new THREE.Color(SKY.horizon) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.55)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1200, 24, 12), material);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  return sky;
}

function createGantry(path: TrackPath): THREE.Group {
  const start = pointOnTrack(path, 0);
  const group = new THREE.Group();
  group.position.set(start.x, start.y, start.z);
  group.rotation.y = start.heading;

  const span = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap + TRACKSIDE.wallThickness + 0.6;
  const steel = new THREE.MeshLambertMaterial({ color: 0x1e293b });
  const postGeometry = new THREE.BoxGeometry(0.6, 7.4, 0.6);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeometry, steel);
    post.position.set(side * span, 3.7, 0);
    post.castShadow = true;
    group.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.6, 0.5, 0.7), steel);
  beam.position.y = 7.4;
  beam.castShadow = true;
  group.add(beam);

  const bannerTexture = canvasTexture(1024, 128, (ctx, w, h) => {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);
    const cell = h / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < w / cell; x++) {
        if ((x + y) % 2 === 0) continue;
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    ctx.fillStyle = '#ff2d78';
    ctx.fillRect(0, 0, w, 10);
    ctx.fillRect(0, h - 10, w, 10);
  });
  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(span * 2 - 0.6, 1.5),
    new THREE.MeshBasicMaterial({ map: bannerTexture, side: THREE.DoubleSide }),
  );
  banner.position.set(0, 6.3, 0);
  group.add(banner);
  return group;
}

function createTrees(path: TrackPath, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(20261115);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < path.n; i++) {
    minX = Math.min(minX, path.x[i]!);
    maxX = Math.max(maxX, path.x[i]!);
    minZ = Math.min(minZ, path.z[i]!);
    maxZ = Math.max(maxZ, path.z[i]!);
  }
  const margin = 230;
  const clearance = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallThickness + 5;
  const spots: { x: number; y: number; z: number; scale: number }[] = [];
  for (let attempt = 0; attempt < 14000 && spots.length < 1600; attempt++) {
    const x = minX - margin + rand() * (maxX - minX + margin * 2);
    const z = minZ - margin + rand() * (maxZ - minZ + margin * 2);
    let near = Infinity;
    for (let i = 0; i < path.n; i += 2) {
      const d = (x - path.x[i]!) ** 2 + (z - path.z[i]!) ** 2;
      if (d < near) near = d;
    }
    if (near < clearance * clearance) continue;
    // Thicker woods on the hills than down in the flats.
    const y = terrain.heightAt(x, z);
    if (y < 3 && rand() < 0.45) continue;
    spots.push({ x, y: y - 0.3, z, scale: 0.75 + rand() * 0.9 });
  }

  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.28, 0.4, 2.4, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2e }),
    spots.length,
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(2.3, 6.2, 7),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    spots.length,
  );
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const color = new THREE.Color();
  spots.forEach((spot, i) => {
    const s = spot.scale;
    quat.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
    matrix.compose(new THREE.Vector3(spot.x, spot.y + 1.2 * s, spot.z), quat, new THREE.Vector3(s, s, s));
    trunks.setMatrixAt(i, matrix);
    matrix.compose(new THREE.Vector3(spot.x, spot.y + (2.2 + 3.1) * s, spot.z), quat, new THREE.Vector3(s, s, s));
    crowns.setMatrixAt(i, matrix);
    crowns.setColorAt(i, color.setHSL(0.3 + rand() * 0.06, 0.5 + rand() * 0.2, 0.24 + rand() * 0.12));
  });
  crowns.instanceColor!.needsUpdate = true;
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.frustumCulled = false; // one draw call for the lot; culling by a single bounding sphere would pop
    group.add(mesh);
  }
  return group;
}

/** The hills: the shared terrain grid, tinted darker and rockier as it climbs and steepens. */
function createTerrainMesh(terrain: Terrain, grassTexture: THREE.Texture): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(terrain.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(terrain.indices, 1));
  geometry.computeVertexNormals();

  const count = terrain.cols * terrain.rows;
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
  const low = new THREE.Color(0xffffff);
  const high = new THREE.Color(0xb7c99a);
  const rock = new THREE.Color(0x9a8f80);
  const color = new THREE.Color();
  for (let v = 0; v < count; v++) {
    const x = terrain.positions[v * 3]!;
    const y = terrain.positions[v * 3 + 1]!;
    const z = terrain.positions[v * 3 + 2]!;
    uvs[v * 2] = x / 11;
    uvs[v * 2 + 1] = z / 11;
    const steep = 1 - normals.getY(v);
    color.copy(low).lerp(high, Math.min(1, Math.max(0, (y - 6) / 45)));
    color.lerp(rock, Math.min(1, Math.max(0, (steep - 0.18) / 0.25)));
    colors.set([color.r, color.g, color.b], v * 3);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: grassTexture, vertexColors: true }));
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * A patch of road surface `s0..s1` metres along the track, between two lateral
 * offsets, lifted `lift` above the tarmac. Follows the road's rise and fall.
 */
function roadPatch(path: TrackPath, s0: number, s1: number, left: number, right: number, lift: number, segments: number) {
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  for (let k = 0; k <= segments; k++) {
    const s = s0 + ((s1 - s0) * k) / segments;
    const a = pointOnTrack(path, s, left);
    const b = pointOnTrack(path, s, right);
    positions.set([a.x, a.y + lift, a.z, b.x, b.y + lift, b.z], k * 6);
    const v = k / segments;
    uvs.set([0, v, 1, v], k * 4);
  }
  const indices: number[] = [];
  for (let k = 0; k < segments; k++) {
    const a0 = k * 2;
    indices.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Glowing chevron pads on the road. Returns a function that scrolls the arrows. */
function createBoostPads(scene: THREE.Scene, path: TrackPath): (dt: number) => void {
  const pads = path.def.boostPads ?? [];
  if (pads.length === 0) return () => {};

  const arrows = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#0c4a6e';
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#22d3ee');
    grad.addColorStop(1, '#ecfeff');
    ctx.fillStyle = grad;
    // One chevron pointing along +V, the direction of travel. The canvas is
    // flipped onto the texture, so its top edge is the far end of the pad.
    ctx.beginPath();
    ctx.moveTo(w * 0.08, h * 0.65);
    ctx.lineTo(w * 0.5, h * 0.2);
    ctx.lineTo(w * 0.92, h * 0.65);
    ctx.lineTo(w * 0.92, h * 0.98);
    ctx.lineTo(w * 0.5, h * 0.53);
    ctx.lineTo(w * 0.08, h * 0.98);
    ctx.closePath();
    ctx.fill();
  });
  arrows.wrapT = THREE.RepeatWrapping;
  arrows.repeat.set(1, 4);
  const material = new THREE.MeshBasicMaterial({ map: arrows, toneMapped: false });

  const rimTexture = canvasTexture(16, 16, (ctx, w, h) => {
    ctx.fillStyle = '#ff2d78';
    ctx.fillRect(0, 0, w, h);
  });
  const rim = new THREE.MeshBasicMaterial({ map: rimTexture, toneMapped: false });

  for (const pad of pads) {
    const s0 = pad.at * path.length;
    const s1 = s0 + BOOST_PAD.length;
    const half = BOOST_PAD.width / 2;
    const surface = new THREE.Mesh(roadPatch(path, s0, s1, pad.lateral - half, pad.lateral + half, 0.045, 6), material);
    scene.add(surface);
    for (const [a, b] of [
      [pad.lateral - half - 0.35, pad.lateral - half],
      [pad.lateral + half, pad.lateral + half + 0.35],
    ] as const) {
      scene.add(new THREE.Mesh(roadPatch(path, s0 - 0.35, s1 + 0.35, a, b, 0.045, 6), rim));
    }
  }

  let t = 0;
  return (dt) => {
    t += dt;
    arrows.offset.y = -((t * 2.2) % 1);
    // A gentle pulse so they catch the eye from a distance.
    const glow = 0.85 + 0.15 * Math.sin(t * 7);
    material.color.setRGB(glow, glow, glow);
  };
}

export interface World {
  /** Animates the moving bits of scenery. */
  update(dt: number): void;
}

export function buildWorld(scene: THREE.Scene, path: TrackPath, terrain: Terrain, maxAnisotropy: number): World {
  scene.background = new THREE.Color(SKY.horizon);
  scene.fog = new THREE.Fog(SKY.fog, 160, 760);
  scene.add(createSky());

  // Ground
  const grassTexture = canvasTexture(256, 256, (ctx, w, h) =>
    speckle(ctx, w, h, '#4c8a3a', ['#3f7a31', '#5a9a45', '#467f36', '#6aa650'], 5000, 7),
  );
  grassTexture.wrapS = THREE.RepeatWrapping;
  grassTexture.anisotropy = maxAnisotropy;
  scene.add(createTerrainMesh(terrain, grassTexture));
  // Flat land beyond the hills, out to the horizon. A frame with the terrain
  // grid cut out of it, not a sheet under everything: the road dips below
  // sea level in places and a sheet would cover it.
  const inset = terrain.cell;
  const x0 = terrain.minX + inset;
  const z0 = terrain.minZ + inset;
  const x1 = terrain.minX + (terrain.cols - 1) * terrain.cell - inset;
  const z1 = terrain.minZ + (terrain.rows - 1) * terrain.cell - inset;
  const far = 2000;
  const corners = [
    [x0, z0], [x1, z0], [x1, z1], [x0, z1], // hole
    [-far, -far], [far, -far], [far, far], [-far, far], // outer edge
  ];
  const farPositions = new Float32Array(corners.length * 3);
  const farUvs = new Float32Array(corners.length * 2);
  corners.forEach(([x, z], i) => {
    farPositions.set([x!, -0.05, z!], i * 3);
    farUvs.set([x! / 11, z! / 11], i * 2);
  });
  const farGeometry = new THREE.BufferGeometry();
  farGeometry.setAttribute('position', new THREE.BufferAttribute(farPositions, 3));
  farGeometry.setAttribute('uv', new THREE.BufferAttribute(farUvs, 2));
  // One quad per side, between the hole's edge and the outer edge.
  farGeometry.setIndex([0, 4, 1, 1, 4, 5, 1, 5, 2, 2, 5, 6, 2, 6, 3, 3, 6, 7, 3, 7, 0, 0, 7, 4]);
  farGeometry.computeVertexNormals();
  const ground = new THREE.Mesh(farGeometry, new THREE.MeshLambertMaterial({ map: grassTexture, side: THREE.DoubleSide }));
  ground.receiveShadow = true;
  scene.add(ground);

  // Road
  const half = path.def.width / 2;
  const roadTexture = canvasTexture(512, 512, (ctx, w, h) => {
    speckle(ctx, w, h, '#3b3f48', ['#30333b', '#474c56', '#2b2e35', '#525863'], 9000, 11);
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(w * 0.025, 0, w * 0.018, h); // edge lines
    ctx.fillRect(w * 0.957, 0, w * 0.018, h);
    ctx.fillRect(w * 0.5 - w * 0.008, 0, w * 0.016, h * 0.5); // centre dashes
  });
  roadTexture.anisotropy = maxAnisotropy;
  const road = new THREE.Mesh(
    ribbon(path, { offset: -half, y: 0.02 }, { offset: half, y: 0.02 }, 9),
    new THREE.MeshLambertMaterial({ map: roadTexture }),
  );
  road.receiveShadow = true;
  scene.add(road);

  // Kerbs
  const kerbTexture = canvasTexture(32, 64, (ctx, w, h) => {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e11d48';
    ctx.fillRect(0, 0, w, h / 2);
  });
  kerbTexture.anisotropy = maxAnisotropy;
  const kerbMaterial = new THREE.MeshLambertMaterial({ map: kerbTexture });
  const kerbOuter = half + TRACKSIDE.kerbWidth;
  for (const [a, b] of [
    [-kerbOuter, -half],
    [half, kerbOuter],
  ] as const) {
    const kerb = new THREE.Mesh(ribbon(path, { offset: a, y: 0.03 }, { offset: b, y: 0.03 }, 5), kerbMaterial);
    kerb.receiveShadow = true;
    scene.add(kerb);
  }

  // Barriers: an inner face, a top and an outer face per side.
  const wallTexture = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = '#dfe5ee';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ff2d78';
    ctx.fillRect(w * 0.62, 0, w * 0.2, h);
    ctx.fillStyle = '#b8c1cf';
    ctx.fillRect(0, 0, w, 2);
  });
  const wallMaterial = new THREE.MeshLambertMaterial({ map: wallTexture, side: THREE.DoubleSide });
  const capMaterial = new THREE.MeshLambertMaterial({ color: 0xaeb8c7, side: THREE.DoubleSide });
  const face = kerbOuter + TRACKSIDE.wallGap;
  const back = face + TRACKSIDE.wallThickness;
  const top = TRACKSIDE.wallHeight;
  for (const side of [-1, 1]) {
    const inner = side * face;
    const outer = side * back;
    const faces: [Edge, Edge, THREE.Material][] = [
      // Faces run a little below the road so no gap opens up where the ground dips.
      [{ offset: inner, y: -0.6 }, { offset: inner, y: top }, wallMaterial],
      [{ offset: Math.min(inner, outer), y: top }, { offset: Math.max(inner, outer), y: top }, capMaterial],
      [{ offset: outer, y: -0.6 }, { offset: outer, y: top }, wallMaterial],
    ];
    for (const [a, b, material] of faces) {
      const mesh = new THREE.Mesh(ribbon(path, a, b, 4), material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // Start / finish line
  const start = pointOnTrack(path, 0);
  const lineTexture = canvasTexture(256, 32, (ctx, w, h) => {
    const cell = h / 2;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < w / cell; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#f8fafc' : '#0f172a';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  });
  const line = new THREE.Mesh(
    new THREE.PlaneGeometry(path.def.width, 2),
    new THREE.MeshLambertMaterial({ map: lineTexture }),
  );
  // Lay the plane flat, then turn it so its width runs across the road.
  line.rotation.set(-Math.PI / 2, start.heading, 0, 'YXZ');
  line.position.set(start.x, start.y + 0.035, start.z);
  line.receiveShadow = true;
  scene.add(line);

  scene.add(createGantry(path));
  scene.add(createTrees(path, terrain));
  const animatePads = createBoostPads(scene, path);

  return { update: animatePads };
}

export interface Lighting {
  sun: THREE.DirectionalLight;
  /** Keeps the shadow frustum centred on whatever the camera is following. */
  follow(target: THREE.Vector3): void;
}

export function addLighting(scene: THREE.Scene): Lighting {
  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x55703f, 1.15));
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
  const offset = new THREE.Vector3(70, 110, 45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const range = 46;
  sun.shadow.camera.left = -range;
  sun.shadow.camera.right = range;
  sun.shadow.camera.top = range;
  sun.shadow.camera.bottom = -range;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 320;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  return {
    sun,
    follow(target) {
      // Snap to whole metres so shadow edges do not crawl as the car moves.
      const x = Math.round(target.x);
      const z = Math.round(target.z);
      const y = Math.round(target.y);
      sun.target.position.set(x, y, z);
      sun.position.set(x + offset.x, y + offset.y, z + offset.z);
    },
  };
}
