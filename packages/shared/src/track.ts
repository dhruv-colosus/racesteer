/**
 * Tracks are data: a closed loop of control points on the ground plane (x, z)
 * plus a width. Everything else — road mesh, walls, checkpoints, start grid,
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
  /** Closed loop of control points, in driving order. The start line sits on the first one. */
  points: readonly (readonly [number, number])[];
  /** Number of equal sectors used to validate laps. */
  sectors: number;
}

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
  /** Unit tangent (direction of travel). */
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
  for (let i = 0; i < count; i++) {
    const p0 = pts[mod(i - 1, count)]!;
    const p1 = pts[i]!;
    const p2 = pts[mod(i + 1, count)]!;
    const p3 = pts[mod(i + 2, count)]!;
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      dense.push(catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t));
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
  }

  const tx = new Float32Array(n);
  const tz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = mod(i - 1, n);
    const b = (i + 1) % n;
    const dx = x[b]! - x[a]!;
    const dz = z[b]! - z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    tx[i] = dx / len;
    tz[i] = dz / len;
  }

  return { def, length, n, step, x, z, tx, tz };
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

/** World position and heading for a point `s` metres along the track, offset `lateral` to the right. */
export function pointOnTrack(path: TrackPath, s: number, lateral = 0): { x: number; z: number; heading: number } {
  const { n, step, x, z, tx, tz } = path;
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
    z: z[i]! + (z[j]! - z[i]!) * t + ux * lateral,
    // Heading is the yaw that turns +Z onto the travel direction.
    heading: Math.atan2(ux, uz),
  };
}

/** Start-grid slot: two cars per row, staggered, behind the start line. */
export function gridSlot(path: TrackPath, slot: number): { x: number; z: number; heading: number } {
  const row = Math.floor(slot / 2);
  const side = slot % 2 === 0 ? -1 : 1;
  const back = 8 + row * 9 + (side > 0 ? 3 : 0);
  return pointOnTrack(path, -back, side * path.def.width * 0.2);
}

export const TRACKS: readonly TrackDef[] = [
  {
    id: 'harbor-loop',
    name: 'Harbor Loop',
    width: 16,
    sectors: 24,
    points: [
      // Main straight, heading +X. Start line on the first point.
      [-40, 0],
      [60, 0],
      [150, 0],
      // Long right-hander
      [215, 30],
      [240, 90],
      [220, 150],
      [165, 180],
      // Back section: left kink, then a climb out to the far corner
      [85, 155],
      [5, 185],
      [-65, 240],
      [-150, 245],
      // Sweeping right into the esses
      [-210, 215],
      [-232, 160],
      [-216, 112],
      [-222, 66],
      [-192, 26],
      // Back onto the straight
      [-140, 0],
    ],
  },
];

export function getTrack(id: string): TrackDef {
  return TRACKS.find((t) => t.id === id) ?? TRACKS[0]!;
}
