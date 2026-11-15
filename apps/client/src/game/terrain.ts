import type { TrackPath } from '@racing/shared';
import { TRACKSIDE } from './config';

/**
 * The land around the track: a regular height grid shared by the rendered
 * ground and its physics collider, so what you see is what you drive on.
 *
 * Inside the barriers the ground sits just under the road. Outside them it
 * eases from the road's elevation back to sea level and rises into rolling
 * hills, which fade out again towards the edge of the grid.
 */
export interface Terrain {
  minX: number;
  minZ: number;
  /** Grid spacing in metres. */
  cell: number;
  /** Vertex counts along X and Z. */
  cols: number;
  rows: number;
  /** Height per vertex, row-major: index = row * cols + col. */
  heights: Float32Array;
  /** Vertex positions (x, y, z) and triangle indices, ready for a mesh or a trimesh collider. */
  positions: Float32Array;
  indices: Uint32Array;
  /** Ground height under a point, interpolated the same way the triangles are. */
  heightAt(x: number, z: number): number;
}

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Deterministic lattice noise, so every player sees the same hills. */
function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Fractal noise in roughly [0, 1]. */
function fbm(x: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, z) * amp;
    norm += amp;
    x = x * 2.03 + 17.1;
    z = z * 2.03 - 9.7;
    amp *= 0.5;
  }
  return sum / norm;
}

/** Height of the hills alone at a point, before fading them in near the track. */
function hills(x: number, z: number): number {
  const n = fbm(x / 210, z / 210, 4);
  const ridge = Math.pow(Math.max(0, n - 0.26) / 0.74, 1.4);
  return ridge * 85 + fbm(x / 55, z / 55, 2) * 4;
}

/** Track samples bucketed on a coarse grid, for fast "nearest bit of track" lookups. */
function bucketTrack(path: TrackPath, size: number) {
  const buckets = new Map<number, number[]>();
  const key = (bx: number, bz: number) => (bx + 4096) * 8192 + (bz + 4096);
  for (let i = 0; i < path.n; i++) {
    const k = key(Math.floor(path.x[i]! / size), Math.floor(path.z[i]! / size));
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }
  return { buckets, key };
}

export function buildTerrain(path: TrackPath, cell = 5, margin = 340): Terrain {
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
  const trackBox = { minX, maxX, minZ, maxZ };
  minX = Math.floor((minX - margin) / cell) * cell;
  minZ = Math.floor((minZ - margin) / cell) * cell;
  const cols = Math.ceil((maxX + margin - minX) / cell) + 1;
  const rows = Math.ceil((maxZ + margin - minZ) / cell) + 1;

  // Everything inside this distance from the centre line is road, kerb, barrier or the strip behind it.
  const corridor = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap + TRACKSIDE.wallThickness + 1.5;
  const reach = 170;
  const bucketSize = 34;
  const { buckets, key } = bucketTrack(path, bucketSize);
  const span = Math.ceil(reach / bucketSize);

  const heights = new Float32Array(cols * rows);
  const positions = new Float32Array(cols * rows * 3);
  for (let r = 0; r < rows; r++) {
    const z = minZ + r * cell;
    for (let c = 0; c < cols; c++) {
      const x = minX + c * cell;

      // Nearest track sample within reach.
      let best = -1;
      let bestD = reach * reach;
      const bx = Math.floor(x / bucketSize);
      const bz = Math.floor(z / bucketSize);
      for (let dz = -span; dz <= span; dz++) {
        for (let dx = -span; dx <= span; dx++) {
          const list = buckets.get(key(bx + dx, bz + dz));
          if (!list) continue;
          for (const i of list) {
            const d = (x - path.x[i]!) ** 2 + (z - path.z[i]!) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      const dist = best >= 0 ? Math.sqrt(bestD) : reach;
      const trackY = best >= 0 ? path.y[best]! : 0;

      let h: number;
      if (dist <= corridor) {
        h = trackY - 0.08;
      } else {
        const out = dist - corridor;
        // How far outside the track's bounding box, for fading everything out at the grid edge.
        const outside = Math.max(trackBox.minX - x, x - trackBox.maxX, trackBox.minZ - z, z - trackBox.maxZ, 0);
        const edgeFade = 1 - smoothstep(margin * 0.5, margin * 0.92, outside);
        const base = trackY * (1 - smoothstep(0, 150, out));
        const rise = smoothstep(3, 55, out);
        h = (base + rise * hills(x, z)) * edgeFade - 0.08 * (1 - rise);
      }
      const v = r * cols + c;
      heights[v] = h;
      positions[v * 3] = x;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = z;
    }
  }

  // Two triangles per cell, wound so their faces point up.
  const indices = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices[k++] = a;
      indices[k++] = d;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = d;
      indices[k++] = e;
    }
  }

  const heightAt = (x: number, z: number) => {
    const fc = Math.max(0, Math.min(cols - 1.0001, (x - minX) / cell));
    const fr = Math.max(0, Math.min(rows - 1.0001, (z - minZ) / cell));
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    const u = fc - c;
    const w = fr - r;
    const a = heights[r * cols + c]!;
    const b = heights[r * cols + c + 1]!;
    const d = heights[(r + 1) * cols + c]!;
    const e = heights[(r + 1) * cols + c + 1]!;
    // Match the triangle split used above (diagonal from b to d).
    return u + w <= 1 ? a + (b - a) * u + (d - a) * w : e + (d - e) * (1 - u) + (b - e) * (1 - w);
  };

  return { minX, minZ, cell, cols, rows, heights, positions, indices, heightAt };
}
