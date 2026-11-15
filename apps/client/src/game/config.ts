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
  centerOfMassY: -0.3,
  /** Principal inertia (pitch, yaw, roll). Roll is deliberately heavy. */
  inertia: { x: 1500, y: 1500, z: 1100 },

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

  /** Grip. Lower rear grip than front makes the tail step out under power. */
  frictionSlipFront: 2.6,
  frictionSlipRear: 2.5,
  sideFrictionStiffness: 1,

  /** Total drive force at a standstill, split over four wheels. */
  engineForce: 8200,
  reverseForce: 4200,
  /** Per-wheel brake impulse per physics step at full brake. */
  brakeImpulse: 46,
  /** Per-wheel impulse that slows a coasting car. */
  coastImpulse: 3,

  maxSpeed: 58, // ~209 km/h
  maxReverseSpeed: 12,
  boostMaxSpeed: 72, // ~259 km/h
  boostForceScale: 1.7,
  /** Seconds of boost in a full tank, and seconds to refill it. */
  boostDuration: 2.6,
  boostRefill: 9,

  /** Steering lock in radians at a standstill and at top speed. */
  steerLow: 0.5,
  steerHigh: 0.085,
  /** How fast the wheels follow the stick, per second. */
  steerRate: 9,

  linearDamping: 0.04,
  angularDamping: 1.1,
} as const;

export const PHYSICS_HZ = 60;
export const PHYSICS_DT = 1 / PHYSICS_HZ;

/** Collision groups: 16 bits of membership, 16 bits of "collides with". */
const GROUND = 0x0001;
const WALL = 0x0002;
const CARS = 0x0004;
const groups = (membership: number, filter: number) => ((membership << 16) | filter) >>> 0;

export const GROUPS = {
  ground: groups(GROUND, 0xffff),
  wall: groups(WALL, CARS),
  localCar: groups(CARS, GROUND | WALL | CARS),
  remoteCar: groups(CARS, CARS),
  /** Wheel rays only ever touch the ground — never walls or other cars. */
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
