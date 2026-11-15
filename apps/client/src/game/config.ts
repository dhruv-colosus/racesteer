/**
 * Car handling numbers, in SI units. The chassis frame is: +Z forward, +Y up,
 * so the car's right-hand side is -X.
 */
export const CAR = {
  mass: 900,
  /** Collision box half extents. */
  halfWidth: 0.95,
  halfHeight: 0.4,
  halfLength: 2.1,
  /** Centre of mass sits low so the car corners flat instead of rolling over. */
  centerOfMassY: -0.5,
  /** Principal inertia (pitch, yaw, roll). Roll is deliberately heavy. */
  inertia: { x: 1500, y: 1050, z: 1100 },

  wheelRadius: 0.36,
  wheelWidth: 0.3,
  /** Wheel mount points relative to the chassis origin. */
  axleHalfTrack: 0.86,
  axleFront: 1.35,
  axleRear: -1.3,
  mountY: -0.1,

  suspensionRest: 0.26,
  suspensionTravel: 0.2,
  suspensionStiffness: 42,
  suspensionCompression: 3.6,
  suspensionRelaxation: 5.2,
  maxSuspensionForce: 60_000,

  /** Grip. The rear holds more than the front so the car stays planted when scrubbing speed at full lock. */
  frictionSlipFront: 5.2,
  frictionSlipRear: 5.6,
  sideFrictionStiffness: 1,

  /** Total drive force at a standstill, split over four wheels. */
  engineForce: 15_000,
  reverseForce: 6000,
  /** Brake force per wheel at full brake. */
  brakeForce: 4600,
  /** Drag per wheel when off the throttle, so lifting actually slows the car. */
  coastForce: 520,

  maxSpeed: 78, // ~280 km/h
  maxReverseSpeed: 14,
  boostMaxSpeed: 96, // ~345 km/h
  boostForceScale: 1.6,
  /** Seconds of boost in a full tank, and seconds to refill it. */
  boostDuration: 2.6,
  boostRefill: 9,

  /** Steering lock in radians at low speed. */
  steerLow: 0.5,
  /**
   * Above walking pace, full lock is whatever angle asks the tyres for this
   * much sideways acceleration (m/s²). Keeps full stick useful at every speed
   * instead of throwing the car across the road. Must stay below what the
   * tyres can give (frictionSlip × g).
   */
  steerLateralAccel: 44,
  /**
   * Tyre scrub. Past `scrubStart` of the steering travel, and above
   * `scrubSpeed` (m/s), the front tyres drag the car down and the engine backs
   * off, so holding full lock tightens the turn instead of running wide.
   * `scrubForce` is the drag per front wheel at full lock, well above `scrubSpeed`.
   */
  scrubStart: 0.75,
  scrubSpeed: 32,
  scrubFade: 14,
  scrubForce: 4000,
  /** How fast the wheels follow the stick, per second. High = immediate. */
  steerRate: 20,

  /**
   * Airtime. Extra gravity (in g) pulled on the car while its wheels are off the
   * road — 1 doubles gravity when fully airborne, which halves how high and how
   * long it flies off a crest. Scales with how many wheels have lost contact.
   */
  airGravity: 1,
  /** Yaw rate (rad/s) full stick asks for in the air, and how fast the car gets there, per second. */
  airSteerRate: 1.4,
  airSteerResponse: 5,
  /** How much of that yaw also bends the flight path (0 = spins in place, 1 = turns like on tarmac). */
  airSteerCarry: 0.8,
  /** Per-second damping of pitch and roll spin in the air, so the car lands on its wheels. */
  airLevelDamping: 2.5,

  linearDamping: 0.04,
  angularDamping: 0.8,
} as const;

/** What a boost pad does to the car that drives over it. */
export const BOOST_PAD_KICK = {
  /** Instant gain in speed, m/s (capped at the boost top speed). */
  speed: 9,
  /** Seconds of free boost afterwards. */
  surge: 1.4,
  /** Fraction of the boost tank it tops up. */
  refill: 0.25,
  /** Throttle the surge holds the car at, even with the pedal up. */
  minThrottle: 0.75,
} as const;

/**
 * The barriers. They are not Rapier colliders: a box contact on the car's
 * body sits above its low centre of mass and catches on the seams between
 * boxes, which flicks the car into the air. Instead the car is held inside the
 * barrier faces by hand each step, so a hit can only ever push it sideways.
 */
export const BARRIER = {
  /** Head-on above this speed (m/s, 200 km/h) wrecks the car instead of glancing off. */
  crashSpeed: 200 / 3.6,
  /**
   * How steeply the car must be heading into the barrier to count as head-on,
   * radians: both the travel direction and the nose, with a front corner first to touch.
   */
  crashAngle: (35 * Math.PI) / 180,
  /** Share of the speed into the barrier that comes back out. Low, so a glance does not ping the car across the road. */
  restitution: 0.12,
  /** Speed lost along the barrier per m/s of speed into it — what makes a scrape cost time. */
  friction: 0.3,
  /** Yaw rate (rad/s) that swings the nose parallel to the barrier, per unit of nose-in, and its cap. */
  alignGain: 4.5,
  alignMaxRate: 2.6,
  /** How much of the way to that yaw rate each contact step goes. */
  alignBlend: 0.3,
  /** Pitch and roll spin kept per contact step, so a hit cannot tip the car up. */
  tipDamping: 0.4,
  /** A car more than this far above the road has cleared the barrier. */
  height: 3,

  /** A wreck: upward kick (m/s) plus a bit more per m/s of speed, and the spin it tumbles with. */
  wreckLift: 6,
  wreckLiftPerSpeed: 0.1,
  /** Share of the speed along the barrier the wreck keeps, and of the speed into it that bounces back. */
  wreckCarry: 0.4,
  wreckBounce: 0.3,
  /** Spin (rad/s): end over end, and random roll and yaw on top. */
  wreckFlip: 6,
  wreckTwist: 3,
  /** Seconds the wreck plays out before the car is put back on the track. */
  wreckTime: 2.2,
} as const;

/** 120 Hz halves the wait between an input and the car reacting, compared with 60. */
export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/** Collision groups: 16 bits of membership, 16 bits of "collides with". */
const GROUND = 0x0001;
const CARS = 0x0004;
const groups = (membership: number, filter: number) => ((membership << 16) | filter) >>> 0;

export const GROUPS = {
  ground: groups(GROUND, 0xffff),
  localCar: groups(CARS, GROUND | CARS),
  remoteCar: groups(CARS, CARS),
  /** Wheel rays only ever touch the ground — never other cars. */
  wheelRay: groups(0xffff, GROUND),
} as const;

/** Track furniture offsets from the road edge, in metres. */
export const TRACKSIDE = {
  kerbWidth: 1.2,
  /** Gap between the outside of the kerb and the barrier face. */
  wallGap: 0.15,
  wallHeight: 1.1,
  wallThickness: 1,
} as const;
