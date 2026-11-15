import { projectOnTrack, type TrackPath } from '@racing/shared';
import { BARRIER, CAR, TRACKSIDE } from './config';
import type { LocalCar } from './physics';

/** The corners of the car's footprint in the chassis frame (+Z forward, +X left). */
const CORNERS = [
  { x: CAR.halfWidth, z: CAR.halfLength, front: true },
  { x: -CAR.halfWidth, z: CAR.halfLength, front: true },
  { x: CAR.halfWidth, z: -CAR.halfLength, front: false },
  { x: -CAR.halfWidth, z: -CAR.halfLength, front: false },
] as const;

export interface BarrierHit {
  /** Horizontal speed at the moment of contact, m/s. */
  speed: number;
  /** Speed straight into the barrier, m/s (0 when only resting against it). */
  into: number;
  /** Angle between the travel direction and the barrier, radians: 0 scrapes along it, π/2 drives straight in. */
  angle: number;
  /** Fast and nose-first: the car is wrecked rather than glancing off. */
  headOn: boolean;
  /** Barrier normal, flat, pointing back onto the track. */
  nx: number;
  nz: number;
}

/**
 * Keeps the car between the barriers. Call after each physics step.
 *
 * Any corner of the car past a barrier face is pushed back out along the
 * barrier's flat normal, and the car loses its speed into the barrier (with a
 * small bounce), some speed along it (friction), and is swung parallel to it.
 * Nothing here pushes the car upward, so a glancing hit slides it along the
 * wall instead of launching it.
 *
 * A fast, nose-first hit is left untouched and reported as `headOn` for the
 * caller to turn into a wreck. While `wrecked`, the barrier still holds the
 * car in but never reports another head-on hit or straightens the car.
 */
export function resolveBarriers(car: LocalCar, path: TrackPath, hint: number, wrecked: boolean): BarrierHit | null {
  const body = car.body;
  const t = body.translation();
  const q = body.rotation();
  // The chassis +X (left) and +Z (forward) axes in world space, flattened.
  const lx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const lz = 2 * (q.x * q.z - q.w * q.y);
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);

  const face = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap;
  const centre = projectOnTrack(path, t.x, t.z, hint);
  // Already over the top and out the far side: the off-track recovery deals with that.
  if (Math.abs(centre.lateral) > face + TRACKSIDE.wallThickness) return null;
  if (t.y - path.y[centre.index]! > BARRIER.height) return null;

  let depth = 0;
  let side = 0;
  let index = -1;
  let front = false;
  for (const c of CORNERS) {
    const p = projectOnTrack(path, t.x + lx * c.x + fx * c.z, t.z + lz * c.x + fz * c.z, centre.index);
    const over = Math.abs(p.lateral) - face;
    if (over > depth) {
      depth = over;
      side = Math.sign(p.lateral);
      index = p.index;
      front = c.front;
    }
  }
  if (index < 0) return null;

  // Lateral is positive to the right of travel, and right is (-tz, tx); the normal points the other way.
  const nx = side * path.tz[index]!;
  const nz = -side * path.tx[index]!;

  const v = body.linvel();
  const vn = v.x * nx + v.z * nz;
  const into = Math.max(0, -vn);
  const speed = Math.hypot(v.x, v.z);
  const angle = speed > 0.5 ? Math.asin(Math.min(1, into / speed)) : 0;
  const fh = Math.hypot(fx, fz) || 1;
  const noseIn = -(fx * nx + fz * nz) / fh; // 1 = nose square to the barrier, < 0 = pointing away
  const headOn =
    !wrecked &&
    front &&
    speed > BARRIER.crashSpeed &&
    angle > BARRIER.crashAngle &&
    noseIn > Math.sin(BARRIER.crashAngle);
  const hit: BarrierHit = { speed, into, angle, headOn, nx, nz };

  body.setTranslation({ x: t.x + nx * depth, y: t.y, z: t.z + nz * depth }, true);
  if (headOn) return hit;

  if (into > 0) {
    // Split into along-the-barrier and into-the-barrier parts; rub off speed along it, bounce a little off it.
    const ax = v.x - nx * vn;
    const az = v.z - nz * vn;
    const along = Math.hypot(ax, az);
    const keep = along > 1e-3 ? Math.max(0, 1 - (BARRIER.friction * into) / along) : 0;
    const out = into * BARRIER.restitution;
    body.setLinvel({ x: ax * keep + nx * out, y: v.y, z: az * keep + nz * out }, true);
  }

  if (!wrecked) {
    const av = body.angvel();
    let yaw = av.y;
    if (noseIn > 0 && car.forwardSpeed > 2) {
      // A positive yaw rate turns the nose toward +n when (f × n).y > 0, i.e. away from the barrier.
      const turn = Math.sign(fz * nx - fx * nz);
      const target = turn * Math.min(BARRIER.alignMaxRate, BARRIER.alignGain * noseIn);
      yaw += (target - yaw) * BARRIER.alignBlend;
    }
    body.setAngvel({ x: av.x * BARRIER.tipDamping, y: yaw, z: av.z * BARRIER.tipDamping }, true);
  }
  return hit;
}

/** Throws the car off a head-on hit: up, back off the barrier, tumbling end over end. */
export function wreck(car: LocalCar, hit: BarrierHit) {
  const body = car.body;
  const v = body.linvel();
  const vn = v.x * hit.nx + v.z * hit.nz;
  const ax = v.x - hit.nx * vn;
  const az = v.z - hit.nz * vn;
  const bounce = hit.into * BARRIER.wreckBounce;
  const lift = BARRIER.wreckLift + hit.speed * BARRIER.wreckLiftPerSpeed;
  body.setLinvel(
    {
      x: ax * BARRIER.wreckCarry + hit.nx * bounce,
      y: Math.max(0, v.y) + lift,
      z: az * BARRIER.wreckCarry + hit.nz * bounce,
    },
    true,
  );

  // Spin about the car's own axes: +X (left) tips the nose down and the tail over it.
  const q = body.rotation();
  const left = { x: 1 - 2 * (q.y * q.y + q.z * q.z), y: 2 * (q.x * q.y + q.w * q.z), z: 2 * (q.x * q.z - q.w * q.y) };
  const fwd = { x: 2 * (q.x * q.z + q.w * q.y), y: 2 * (q.y * q.z - q.w * q.x), z: 1 - 2 * (q.x * q.x + q.y * q.y) };
  const flip = BARRIER.wreckFlip;
  const roll = (Math.random() - 0.5) * 2 * BARRIER.wreckTwist;
  const yaw = (Math.random() - 0.5) * 2 * BARRIER.wreckTwist;
  body.setAngvel(
    {
      x: left.x * flip + fwd.x * roll,
      y: left.y * flip + fwd.y * roll + yaw,
      z: left.z * flip + fwd.z * roll,
    },
    true,
  );
}
