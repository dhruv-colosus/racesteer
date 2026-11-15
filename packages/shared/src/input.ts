/** What a car is being told to do this instant, whatever device it came from. */
export interface DriveInput {
  /** -1 full left … +1 full right. */
  steer: number;
  /** 0 … 1 */
  throttle: number;
  /** 0 … 1 */
  brake: number;
  boost: boolean;
}

export const NEUTRAL_INPUT: Readonly<DriveInput> = { steer: 0, throttle: 0, brake: 0, boost: false };

/** Wire format for pad input: [steer, throttle, brake, boost]. */
export type PadInputMessage = [number, number, number, number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function encodePadInput(input: DriveInput): PadInputMessage {
  return [
    Math.round(clamp(input.steer, -1, 1) * 1000) / 1000,
    Math.round(clamp(input.throttle, 0, 1) * 100) / 100,
    Math.round(clamp(input.brake, 0, 1) * 100) / 100,
    input.boost ? 1 : 0,
  ];
}

/** Validates untrusted pad input. Returns null if it is not a well-formed message. */
export function decodePadInput(message: unknown): DriveInput | null {
  if (!Array.isArray(message) || message.length !== 4) return null;
  const [steer, throttle, brake, boost] = message as unknown[];
  if (![steer, throttle, brake, boost].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return {
    steer: clamp(steer as number, -1, 1),
    throttle: clamp(throttle as number, 0, 1),
    brake: clamp(brake as number, 0, 1),
    boost: (boost as number) > 0.5,
  };
}

export interface TiltOptions {
  /** Roll inside this band reads as dead centre. */
  deadZoneDeg: number;
  /** Roll at which steering is fully locked. */
  fullLockDeg: number;
  /** >1 makes the centre gentler without losing full lock. */
  curve: number;
}

export const DEFAULT_TILT: Readonly<TiltOptions> = { deadZoneDeg: 2, fullLockDeg: 35, curve: 1.25 };

/** Below this much gravity in the screen plane the phone is lying too flat to read a roll angle. */
const MIN_PLANAR_GRAVITY = 1.5;

/**
 * Roll of a phone held like a steering wheel, in degrees; positive = turned
 * clockwise = steer right. Takes `accelerationIncludingGravity` x/y and the
 * screen orientation angle.
 *
 * iOS and Android report gravity with opposite signs, and browsers disagree on
 * which landscape is 90 vs 270. Both amount to negating the in-plane vector,
 * so it is normalised by assuming the screen is the right way up for the user
 * (which the OS guarantees by rotating the page).
 *
 * Returns null when the phone is too flat for the reading to mean anything.
 */
export function rollFromGravity(ax: number, ay: number, screenAngle: number): number | null {
  let sx: number;
  let sy: number;
  switch (((Math.round(screenAngle / 90) % 4) + 4) % 4) {
    case 1: // device top points left: screen-right = -y, screen-up = +x
      sx = -ay;
      sy = ax;
      break;
    case 2:
      sx = -ax;
      sy = -ay;
      break;
    case 3: // device top points right
      sx = ay;
      sy = -ax;
      break;
    default:
      sx = ax;
      sy = ay;
  }
  if (Math.hypot(sx, sy) < MIN_PLANAR_GRAVITY) return null;
  const k = sy >= 0 ? 1 : -1;
  return (Math.atan2(-sx * k, sy * k) * 180) / Math.PI;
}

/** Maps a roll angle to steering in [-1, 1], relative to a calibrated centre. */
export function tiltToSteer(rollDeg: number, centerDeg = 0, options: TiltOptions = DEFAULT_TILT): number {
  const delta = rollDeg - centerDeg;
  const magnitude = Math.abs(delta);
  if (magnitude <= options.deadZoneDeg) return 0;
  const span = options.fullLockDeg - options.deadZoneDeg;
  const normalised = clamp((magnitude - options.deadZoneDeg) / span, 0, 1);
  return Math.sign(delta) * Math.pow(normalised, options.curve);
}
