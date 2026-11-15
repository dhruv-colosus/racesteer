import RAPIER from '@dimforge/rapier3d-compat';
import type { DriveInput, TrackPath } from '@racing/shared';
import { BOOST_PAD_KICK, CAR, GROUPS, PHYSICS_DT, TRACKSIDE } from './config';
import type { Terrain } from './terrain';

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/** Yaw from +Z, then the nose pitched up a slope of `grade` (rise over run). */
function yawPitchQuat(yaw: number, grade: number) {
  const pitch = -Math.atan(grade); // rotating about +X tips +Z downwards, so nose-up is negative
  const sy = Math.sin(yaw / 2);
  const cy = Math.cos(yaw / 2);
  const sp = Math.sin(pitch / 2);
  const cp = Math.cos(pitch / 2);
  return { x: cy * sp, y: sy * cp, z: -sy * sp, w: cy * cp };
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Wheel order: front-left, front-right, rear-left, rear-right. Left is +X in the chassis frame. */
const WHEELS = [
  { x: CAR.axleHalfTrack, z: CAR.axleFront, front: true },
  { x: -CAR.axleHalfTrack, z: CAR.axleFront, front: true },
  { x: CAR.axleHalfTrack, z: CAR.axleRear, front: false },
  { x: -CAR.axleHalfTrack, z: CAR.axleRear, front: false },
] as const;

export interface WheelState {
  /** Position in the chassis frame. */
  x: number;
  y: number;
  z: number;
  steer: number;
  spin: number;
  grounded: boolean;
}

/** Ride height of the chassis origin when the car is sitting still on flat ground. */
export const REST_HEIGHT =
  CAR.wheelRadius + CAR.suspensionRest - 9.81 / (4 * CAR.suspensionStiffness) - CAR.mountY;

export class PhysicsWorld {
  readonly world: RAPIER.World;
  private readonly trackBody: RAPIER.RigidBody;

  constructor(path: TrackPath, terrain: Terrain) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;

    this.trackBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // Safety net far below everything, so nothing falls forever.
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1500, 1, 1500).setTranslation(0, -31, 0).setFriction(1).setCollisionGroups(GROUPS.ground),
      this.trackBody,
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(terrain.positions, terrain.indices).setFriction(0.8).setCollisionGroups(GROUPS.ground),
      this.trackBody,
    );
    this.buildRoad(path);
  }

  /**
   * The drivable surface between the barriers: an exact copy of the rendered
   * road's profile, so the wheels follow every rise and dip without the
   * stepping a coarse terrain grid would add.
   */
  private buildRoad(path: TrackPath) {
    const half = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap + TRACKSIDE.wallThickness + 0.5;
    const vertices = new Float32Array(path.n * 2 * 3);
    for (let i = 0; i < path.n; i++) {
      const rx = -path.tz[i]!;
      const rz = path.tx[i]!;
      vertices.set(
        [
          path.x[i]! - rx * half,
          path.y[i]!,
          path.z[i]! - rz * half,
          path.x[i]! + rx * half,
          path.y[i]!,
          path.z[i]! + rz * half,
        ],
        i * 6,
      );
    }
    const indices = new Uint32Array(path.n * 6);
    for (let i = 0; i < path.n; i++) {
      const a0 = i * 2;
      const b0 = a0 + 1;
      const a1 = ((i + 1) % path.n) * 2;
      const b1 = a1 + 1;
      indices.set([a0, b0, a1, b0, b1, a1], i * 6);
    }
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(vertices, indices).setFriction(1).setCollisionGroups(GROUPS.ground),
      this.trackBody,
    );
  }

  step() {
    this.world.step();
  }

  dispose() {
    this.world.free();
  }
}

/** The car the local player drives: a dynamic body on a raycast-vehicle suspension. */
export class LocalCar {
  readonly body: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  private steerAngle = 0;
  /** 0..1 */
  boost = 1;
  boosting = false;
  /** Seconds left of a boost pad's surge. */
  surge = 0;
  /** Signed speed along the car's nose, m/s. */
  forwardSpeed = 0;
  /** Largest change in velocity over the last step — spikes on impacts. */
  impact = 0;
  private lastVel = { x: 0, y: 0, z: 0 };
  readonly wheels: WheelState[] = WHEELS.map((w) => ({ x: w.x, y: 0, z: w.z, steer: 0, spin: 0, grounded: true }));

  constructor(private readonly physics: PhysicsWorld) {
    const world = physics.world;
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, REST_HEIGHT, 0)
        .setLinearDamping(CAR.linearDamping)
        .setAngularDamping(CAR.angularDamping)
        .setCcdEnabled(true)
        .setCanSleep(false)
        .setAdditionalMassProperties(
          CAR.mass,
          { x: 0, y: CAR.centerOfMassY, z: 0 },
          CAR.inertia,
          { x: 0, y: 0, z: 0, w: 1 },
        ),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(CAR.halfWidth, CAR.halfHeight, CAR.halfLength)
        .setTranslation(0, 0.1, 0)
        .setDensity(0)
        .setFriction(0.15)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.1)
        .setCollisionGroups(GROUPS.localCar),
      this.body,
    );

    this.vehicle = world.createVehicleController(this.body);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;
    WHEELS.forEach((wheel, i) => {
      this.vehicle.addWheel(
        { x: wheel.x, y: CAR.mountY, z: wheel.z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        CAR.suspensionRest,
        CAR.wheelRadius,
      );
      this.vehicle.setWheelSuspensionStiffness(i, CAR.suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, CAR.suspensionCompression);
      this.vehicle.setWheelSuspensionRelaxation(i, CAR.suspensionRelaxation);
      this.vehicle.setWheelMaxSuspensionTravel(i, CAR.suspensionTravel);
      this.vehicle.setWheelMaxSuspensionForce(i, CAR.maxSuspensionForce);
      this.vehicle.setWheelFrictionSlip(i, wheel.front ? CAR.frictionSlipFront : CAR.frictionSlipRear);
      this.vehicle.setWheelSideFrictionStiffness(i, CAR.sideFrictionStiffness);
    });
  }

  /** Drops the car at rest on the road at (x, groundY, z), facing `heading` (yaw from +Z) up a slope of `grade`. */
  place(x: number, groundY: number, z: number, heading: number, grade = 0) {
    this.body.setTranslation({ x, y: groundY + REST_HEIGHT + 0.05, z }, true);
    this.body.setRotation(yawPitchQuat(heading, grade), true);
    this.surge = 0;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this.forwardSpeed = 0;
    this.lastVel = { x: 0, y: 0, z: 0 };
  }

  /**
   * Call once per fixed step, before the world steps.
   * `hold` pins the car with the brakes on (on the grid, or after the flag).
   */
  update(input: DriveInput, dt: number, hold = false) {
    const rot = this.body.rotation();
    const vel = this.body.linvel();
    // Chassis +Z in world space.
    const fx = 2 * (rot.x * rot.z + rot.w * rot.y);
    const fy = 2 * (rot.y * rot.z - rot.w * rot.x);
    const fz = 1 - 2 * (rot.x * rot.x + rot.y * rot.y);
    this.forwardSpeed = vel.x * fx + vel.y * fy + vel.z * fz;
    const speed = Math.abs(this.forwardSpeed);

    this.impact = Math.hypot(vel.x - this.lastVel.x, vel.y - this.lastVel.y, vel.z - this.lastVel.z);
    this.lastVel = { x: vel.x, y: vel.y, z: vel.z };

    // Boost tank. A pad's surge boosts for free and keeps the power on even off the throttle.
    const surging = this.surge > 0 && !hold;
    this.surge = Math.max(0, this.surge - dt);
    const tankBoost = input.boost && this.boost > 0 && input.throttle > 0.1;
    this.boosting = tankBoost || surging;
    if (tankBoost) this.boost = Math.max(0, this.boost - dt / CAR.boostDuration);
    else this.boost = Math.min(1, this.boost + dt / CAR.boostRefill);
    if (surging && input.brake <= 0.05) input = { ...input, throttle: Math.max(input.throttle, BOOST_PAD_KICK.minThrottle) };

    // Steering: full lock asks for a fixed sideways acceleration, so the angle shrinks with speed squared.
    const wheelbase = CAR.axleFront - CAR.axleRear;
    const lock = Math.min(CAR.steerLow, (CAR.steerLateralAccel * wheelbase) / Math.max(1, speed * speed));
    const targetSteer = -input.steer * lock; // positive wheel angle turns toward +X, which is the car's left
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, CAR.steerRate * dt);

    // Drive and brakes.
    let engine = 0;
    // Rapier takes brakes as an impulse per step, so forces are scaled by dt.
    let brake: number = CAR.coastForce * dt;
    const topSpeed = this.boosting ? CAR.boostMaxSpeed : CAR.maxSpeed;
    if (hold) {
      brake = CAR.brakeForce * dt;
    } else if (input.brake > 0.05 && this.forwardSpeed > 1.5) {
      brake = CAR.brakeForce * dt * input.brake;
    } else if (input.brake > 0.05) {
      // Stopped (or already rolling backwards): the brake pedal becomes reverse.
      const room = Math.max(0, 1 - Math.max(0, -this.forwardSpeed) / CAR.maxReverseSpeed);
      engine = -CAR.reverseForce * input.brake * room;
      brake = 0;
    } else if (input.throttle > 0.02) {
      const room = Math.max(0, 1 - Math.pow(Math.max(0, this.forwardSpeed) / topSpeed, 2));
      engine = CAR.engineForce * input.throttle * room * (this.boosting ? CAR.boostForceScale : 1);
      brake = 0;
    }

    // Front wheels only: dragging the rears as well would use up their side grip and spin the car.
    let frontScrub = 0;
    // Tyre scrub: near full lock at speed, bleed speed off so the corner can actually be made.
    if (!hold && this.forwardSpeed > CAR.scrubSpeed) {
      const lockUsed = Math.max(0, (Math.abs(input.steer) - CAR.scrubStart) / (1 - CAR.scrubStart));
      const scrub = lockUsed * Math.min(1, (this.forwardSpeed - CAR.scrubSpeed) / CAR.scrubFade);
      if (engine > 0) engine *= 1 - scrub;
      frontScrub = CAR.scrubForce * dt * scrub;
    }

    for (let i = 0; i < WHEELS.length; i++) {
      this.vehicle.setWheelEngineForce(i, engine / WHEELS.length);
      this.vehicle.setWheelBrake(i, WHEELS[i]!.front ? Math.max(brake, frontScrub) : brake);
      this.vehicle.setWheelSteering(i, WHEELS[i]!.front ? this.steerAngle : 0);
    }
    this.vehicle.updateVehicle(dt, undefined, GROUPS.wheelRay);

    let grounded = 0;
    for (let i = 0; i < WHEELS.length; i++) {
      const wheel = this.wheels[i]!;
      wheel.y = CAR.mountY - (this.vehicle.wheelSuspensionLength(i) ?? CAR.suspensionRest);
      wheel.steer = WHEELS[i]!.front ? this.steerAngle : 0;
      wheel.spin = this.vehicle.wheelRotation(i) ?? 0;
      wheel.grounded = this.vehicle.wheelIsInContact(i);
      if (wheel.grounded) grounded++;
    }

    if (!hold && grounded < WHEELS.length) this.airControl(input, dt, 1 - grounded / WHEELS.length);
  }

  /**
   * Off the ground the tyres do nothing, so without help a car leaving a crest
   * flies far and cannot be pointed anywhere. `air` is the share of wheels off
   * the road (0..1): the more of them, the more of each effect.
   */
  private airControl(input: DriveInput, dt: number, air: number) {
    const m = this.body.mass();
    // Extra gravity: pulls the car back to the road sooner and keeps it from leaving at all on gentle crests.
    this.body.applyImpulse({ x: 0, y: -9.81 * CAR.airGravity * air * m * dt, z: 0 }, true);

    // Air steering only once most of the car is off the road, so a wheel skipping over a kerb changes nothing.
    const flying = Math.max(0, (air - 0.5) * 2);
    if (flying === 0) return;

    // Steering in the air: drive the yaw rate toward what the stick asks for.
    const av = this.body.angvel();
    const targetYaw = -input.steer * CAR.airSteerRate; // stick right (+) is a negative yaw
    const blend = Math.min(1, CAR.airSteerResponse * dt) * flying;
    const yaw = av.y + (targetYaw - av.y) * blend;
    // Settle pitch and roll so the car comes down on its wheels.
    const level = Math.exp(-CAR.airLevelDamping * flying * dt);
    this.body.setAngvel({ x: av.x * level, y: yaw, z: av.z * level }, true);

    // Bend the flight path with the nose, so steering changes where the car lands, not just where it points.
    const turn = yaw * dt * CAR.airSteerCarry * flying;
    if (turn !== 0) {
      const v = this.body.linvel();
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      this.body.setLinvel({ x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }, true);
    }
  }

  get steer() {
    return this.steerAngle;
  }

  /** Drove over a boost pad: an instant shove along the nose, then a short surge. */
  hitBoostPad() {
    this.surge = BOOST_PAD_KICK.surge;
    this.boost = Math.min(1, this.boost + BOOST_PAD_KICK.refill);
    const speed = this.forwardSpeed;
    const dv = Math.max(0, Math.min(BOOST_PAD_KICK.speed, CAR.boostMaxSpeed - speed));
    if (dv <= 0) return;
    const r = this.body.rotation();
    const fx = 2 * (r.x * r.z + r.w * r.y);
    const fy = 2 * (r.y * r.z - r.w * r.x);
    const fz = 1 - 2 * (r.x * r.x + r.y * r.y);
    const m = this.body.mass();
    this.body.applyImpulse({ x: fx * dv * m, y: fy * dv * m, z: fz * dv * m }, true);
  }

  pose(): Pose {
    const t = this.body.translation();
    const r = this.body.rotation();
    return { x: t.x, y: t.y, z: t.z, qx: r.x, qy: r.y, qz: r.z, qw: r.w };
  }

  dispose() {
    this.physics.world.removeVehicleController(this.vehicle);
    this.physics.world.removeRigidBody(this.body);
  }
}

/** Another player's car: moved by the network, solid to the local car. */
export class RemoteBody {
  readonly body: RAPIER.RigidBody;

  constructor(private readonly physics: PhysicsWorld) {
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -50, 0),
    );
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(CAR.halfWidth, CAR.halfHeight, CAR.halfLength)
        .setTranslation(0, 0.1, 0)
        .setFriction(0.15)
        .setRestitution(0.2)
        .setCollisionGroups(GROUPS.remoteCar),
      this.body,
    );
  }

  moveTo(pose: Pose) {
    this.body.setNextKinematicTranslation({ x: pose.x, y: pose.y, z: pose.z });
    this.body.setNextKinematicRotation({ x: pose.qx, y: pose.qy, z: pose.qz, w: pose.qw });
  }

  dispose() {
    this.physics.world.removeRigidBody(this.body);
  }
}
