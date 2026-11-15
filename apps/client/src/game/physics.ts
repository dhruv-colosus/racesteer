import RAPIER from '@dimforge/rapier3d-compat';
import type { DriveInput, TrackPath } from '@racing/shared';
import { CAR, GROUPS, PHYSICS_DT, TRACKSIDE } from './config';

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

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

  constructor(path: TrackPath) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = PHYSICS_DT;

    this.trackBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(1000, 1, 1000).setTranslation(0, -1, 0).setFriction(1).setCollisionGroups(GROUPS.ground),
      this.trackBody,
    );
    this.buildWalls(path);
  }

  /** A chain of boxes down each side of the road. Boxes, not a thin mesh, so a fast car cannot slip through. */
  private buildWalls(path: TrackPath) {
    const half = path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap + TRACKSIDE.wallThickness / 2;
    const stride = 2;
    for (const side of [-1, 1]) {
      for (let i = 0; i < path.n; i += stride) {
        const j = (i + stride) % path.n;
        const ax = path.x[i]! + -path.tz[i]! * half * side;
        const az = path.z[i]! + path.tx[i]! * half * side;
        const bx = path.x[j]! + -path.tz[j]! * half * side;
        const bz = path.z[j]! + path.tx[j]! * half * side;
        const dx = bx - ax;
        const dz = bz - az;
        const length = Math.hypot(dx, dz);
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(TRACKSIDE.wallThickness / 2, 1.5, length / 2 + 0.25)
            .setTranslation((ax + bx) / 2, 1.5, (az + bz) / 2)
            .setRotation(yawQuat(Math.atan2(dx, dz)))
            .setFriction(0.02)
            .setRestitution(0.05)
            .setCollisionGroups(GROUPS.wall),
          this.trackBody,
        );
      }
    }
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

  /** Drops the car at rest at a ground position, facing `heading` (yaw from +Z). */
  place(x: number, z: number, heading: number) {
    this.body.setTranslation({ x, y: REST_HEIGHT + 0.05, z }, true);
    this.body.setRotation(yawQuat(heading), true);
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

    // Boost tank.
    this.boosting = input.boost && this.boost > 0 && input.throttle > 0.1;
    if (this.boosting) this.boost = Math.max(0, this.boost - dt / CAR.boostDuration);
    else this.boost = Math.min(1, this.boost + dt / CAR.boostRefill);

    // Steering: less lock the faster you go, and the wheels take a moment to follow.
    const speedRatio = Math.min(1, speed / CAR.maxSpeed);
    const lock = CAR.steerLow + (CAR.steerHigh - CAR.steerLow) * Math.pow(speedRatio, 0.6);
    const targetSteer = -input.steer * lock; // positive wheel angle turns toward +X, which is the car's left
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, CAR.steerRate * dt);

    // Drive and brakes.
    let engine = 0;
    let brake: number = CAR.coastImpulse;
    const topSpeed = this.boosting ? CAR.boostMaxSpeed : CAR.maxSpeed;
    if (hold) {
      brake = CAR.brakeImpulse;
    } else if (input.brake > 0.05 && this.forwardSpeed > 1.5) {
      brake = CAR.brakeImpulse * input.brake;
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

    for (let i = 0; i < WHEELS.length; i++) {
      this.vehicle.setWheelEngineForce(i, engine / WHEELS.length);
      this.vehicle.setWheelBrake(i, brake);
      this.vehicle.setWheelSteering(i, WHEELS[i]!.front ? this.steerAngle : 0);
    }
    this.vehicle.updateVehicle(dt, undefined, GROUPS.wheelRay);

    for (let i = 0; i < WHEELS.length; i++) {
      const wheel = this.wheels[i]!;
      wheel.y = CAR.mountY - (this.vehicle.wheelSuspensionLength(i) ?? CAR.suspensionRest);
      wheel.steer = WHEELS[i]!.front ? this.steerAngle : 0;
      wheel.spin = this.vehicle.wheelRotation(i) ?? 0;
      wheel.grounded = this.vehicle.wheelIsInContact(i);
    }
  }

  get steer() {
    return this.steerAngle;
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
