/**
 * Tracks are data: a closed loop of control points (x, z, and an optional
 * elevation y) plus a width. Everything else — road mesh, walls, checkpoints, start grid,
 * minimap — is derived from the sampled path, on the client and the server.
 *
 * Axes follow three.js: Y is up, the ground is the XZ plane.
 * For a travel direction (tx, tz) the right-hand side is (-tz, tx).
 */

export interface TrackDef {
  id: string;
  name: string;
  /** Drivable width in metres. */
  width: number;
  /**
   * Closed loop of control points `[x, z, y?]`, in driving order. The start
   * line sits on the first one. `y` is the road's elevation in metres (default 0).
   */
  points: readonly (readonly [x: number, z: number, y?: number])[];
  /** Number of equal sectors used to validate laps. */
  sectors: number;
  /** Speed pads on the road surface. */
  boostPads?: readonly BoostPadDef[];
}

export interface BoostPadDef {
  /** Where the pad starts, as a fraction of the lap (0..1). */
  at: number;
  /** Offset of the pad's centre from the centre line; positive is right of travel. */
  lateral: number;
}

/** Size of a boost pad on the road, in metres. */
export const BOOST_PAD = { length: 12, width: 6 } as const;

export interface TrackPath {
  def: TrackDef;
  /** Total centre-line length in metres. */
  length: number;
  /** Number of evenly spaced samples. */
  n: number;
  /** Arc length between neighbouring samples. */
  step: number;
  x: Float32Array;
  z: Float32Array;
  /** Road elevation. */
  y: Float32Array;
  /** Slope along the direction of travel (rise over run); positive is uphill. */
  grade: Float32Array;
  /** Unit tangent (direction of travel), flattened onto the ground plane. */
  tx: Float32Array;
  tz: Float32Array;
}

export interface TrackProjection {
  /** Nearest sample index — pass it back as the hint next time. */
  index: number;
  /** Distance along the track from the start line, in [0, length). */
  s: number;
  /** Signed offset from the centre line; positive is right of travel. */
  lateral: number;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Samples the closed spline and resamples it at an even spacing of roughly `spacing` metres. */
export function buildTrackPath(def: TrackDef, spacing = 2): TrackPath {
  const pts = def.points;
  const count = pts.length;
  if (count < 4) throw new Error(`Track "${def.id}" needs at least 4 control points`);

  // Dense pass.
  const perSegment = 48;
  const dense: number[] = [];
  const denseY: number[] = [];
  for (let i = 0; i < count; i++) {
    const p0 = pts[mod(i - 1, count)]!;
    const p1 = pts[i]!;
    const p2 = pts[mod(i + 1, count)]!;
    const p3 = pts[mod(i + 2, count)]!;
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      dense.push(catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t));
      denseY.push(catmullRom(p0[2] ?? 0, p1[2] ?? 0, p2[2] ?? 0, p3[2] ?? 0, t));
    }
  }
  const dn = dense.length / 2;
  const cum = new Float64Array(dn + 1);
  for (let i = 0; i < dn; i++) {
    const j = (i + 1) % dn;
    cum[i + 1] = cum[i]! + Math.hypot(dense[j * 2]! - dense[i * 2]!, dense[j * 2 + 1]! - dense[i * 2 + 1]!);
  }
  const length = cum[dn]!;

  // Even resample.
  const n = Math.max(16, Math.round(length / spacing));
  const step = length / n;
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const y = new Float32Array(n);
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const target = i * step;
    while (seg < dn - 1 && cum[seg + 1]! < target) seg++;
    const a = seg;
    const b = (seg + 1) % dn;
    const span = cum[seg + 1]! - cum[seg]!;
    const f = span > 0 ? (target - cum[seg]!) / span : 0;
    x[i] = dense[a * 2]! + (dense[b * 2]! - dense[a * 2]!) * f;
    z[i] = dense[a * 2 + 1]! + (dense[b * 2 + 1]! - dense[a * 2 + 1]!) * f;
    y[i] = denseY[a]! + (denseY[b]! - denseY[a]!) * f;
  }

  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  const grade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = mod(i - 1, n);
    const b = (i + 1) % n;
    const dx = x[b]! - x[a]!;
    const dz = z[b]! - z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    tx[i] = dx / len;
    tz[i] = dz / len;
    grade[i] = (y[b]! - y[a]!) / len;
  }

  return { def, length, n, step, x, z, y, grade, tx, tz };
}

/**
 * Finds where a ground position sits relative to the track.
 * With a `hint` (the previous result's index) only nearby samples are searched,
 * falling back to a full search if the car turns out to be far from them.
 */
export function projectOnTrack(path: TrackPath, px: number, pz: number, hint = -1): TrackProjection {
  const { n, x, z, tx, tz, step, length } = path;
  let best = -1;
  let bestD = Infinity;

  const consider = (i: number) => {
    const dx = px - x[i]!;
    const dz = pz - z[i]!;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  };

  if (hint >= 0) {
    const window = 16;
    for (let k = -window; k <= window; k++) consider(mod(hint + k, n));
    const reach = path.def.width * 2;
    if (bestD > reach * reach) {
      best = -1;
      bestD = Infinity;
    }
  }
  if (best < 0) for (let i = 0; i < n; i++) consider(i);

  const dx = px - x[best]!;
  const dz = pz - z[best]!;
  const along = Math.max(-step, Math.min(step, dx * tx[best]! + dz * tz[best]!));
  const lateral = dx * -tz[best]! + dz * tx[best]!;
  return { index: best, s: mod(best * step + along, length), lateral };
}

export interface TrackPoint {
  x: number;
  /** Road surface elevation. */
  y: number;
  z: number;
  /** Yaw that turns +Z onto the travel direction. */
  heading: number;
  /** Slope along the direction of travel (rise over run). */
  grade: number;
}

/** World position and heading for a point `s` metres along the track, offset `lateral` to the right. */
export function pointOnTrack(path: TrackPath, s: number, lateral = 0): TrackPoint {
  const { n, step, x, y, z, tx, tz, grade } = path;
  const f = mod(s, path.length) / step;
  const i = Math.floor(f) % n;
  const j = (i + 1) % n;
  const t = f - Math.floor(f);
  const dirX = tx[i]! + (tx[j]! - tx[i]!) * t;
  const dirZ = tz[i]! + (tz[j]! - tz[i]!) * t;
  const len = Math.hypot(dirX, dirZ) || 1;
  const ux = dirX / len;
  const uz = dirZ / len;
  return {
    x: x[i]! + (x[j]! - x[i]!) * t + -uz * lateral,
    y: y[i]! + (y[j]! - y[i]!) * t,
    z: z[i]! + (z[j]! - z[i]!) * t + ux * lateral,
    heading: Math.atan2(ux, uz),
    grade: grade[i]! + (grade[j]! - grade[i]!) * t,
  };
}

/** Start-grid slot: two cars per row, staggered, behind the start line. */
export function gridSlot(path: TrackPath, slot: number): TrackPoint {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  const back = 8 + row * 9 + (side > 0 ? 3 : 0);
  return pointOnTrack(path, -back, side * path.def.width * 0.2);
}

export const TRACKS: readonly TrackDef[] = [
  {
    id: 'harbor-loop',
    name: 'Harbor Loop',
    width: 20,
    sectors: 24,
    points: [
      // Main straight, heading +X. Start line on the first point. Flat for the grid, then a dip and a crest.
      [-60, 0, 0],
      [90, 0, -2.1],
      [225, 0, 4.2],
      // Long right-hander, climbing
      [322, 45, 9.8],
      [360, 135, 15.4],
      [330, 225, 18.2],
      [248, 270, 14],
      // Back section: drop into the left kink, kick over a crest, then climb to the far corner
      [128, 232, 2.8],
      [8, 278, 12.6],
      [-98, 360, 19.6],
      [-225, 368, 23.8],
      // Sweeping right and plunging down into the esses
      [-315, 322, 16.8],
      [-348, 240, 7],
      [-324, 168, 1.4],
      [-333, 99, 5.6],
      [-288, 39, 1.4],
      // Back onto the straight
      [-210, 0, 0],
    ],
    boostPads: [
      { at: 0.045, lateral: 0 },
      { at: 0.105, lateral: -4.5 },
      { at: 0.31, lateral: 4 },
      { at: 0.405, lateral: -3 },
      { at: 0.53, lateral: 3.5 },
      { at: 0.635, lateral: 0 },
      { at: 0.945, lateral: -3 },
    ],
  },
];

/** Index of the boost pad under a point on the track, or -1. */
export function boostPadAt(path: TrackPath, s: number, lateral: number): number {
  const pads = path.def.boostPads;
  if (!pads) return -1;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i]!;
    const into = mod(s - pad.at * path.length, path.length);
    if (into <= BOOST_PAD.length && Math.abs(lateral - pad.lateral) <= BOOST_PAD.width / 2) return i;
  }
  return -1;
}

export function getTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]!;
}
