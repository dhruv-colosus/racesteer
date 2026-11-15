import * as THREE from 'three';
import {
  INTERP_DELAY_MS,
  NET_SEND_HZ,
  advanceProgress,
  boostPadAt,
  buildTrackPath,
  currentLap,
  getTrack,
  gridSlot,
  isFinished,
  newProgress,
  pointOnTrack,
  progressFraction,
  projectOnTrack,
  raceScore,
  sectorOf,
  type DriveInput,
  type RaceProgress,
  type TrackPath,
  type TransformMessage,
} from '@racing/shared';
import { EngineAudio } from './audio';
import { resolveBarriers, wreck } from './barrier';
import { createCarMesh, createNameTag, type CarMesh } from './carMesh';
import { BARRIER, CAR, PHYSICS_DT, PHYSICS_HZ, TRACKSIDE } from './config';
import type { InputManager } from './input';
import { LocalCar, PhysicsWorld, RemoteBody, initPhysics, type Pose } from './physics';
import { addLighting, buildWorld, type Lighting, type World } from './scene';
import { buildTerrain } from './terrain';

/** What the HUD needs each frame. Plain numbers so the HUD can write them straight to the DOM. */
export interface HudFrame {
  speedKmh: number;
  /** 0..1 */
  rpm: number;
  gear: number;
  /** 0..1 */
  boost: number;
  boosting: boolean;
  /** 0..1 through the whole race */
  progress: number;
  lap: number;
  laps: number;
  wrongWay: boolean;
  /** Crashed head-on into a barrier; the car is put back on the track shortly. */
  wrecked: boolean;
  x: number;
  z: number;
  others: { x: number; z: number; color: string }[];
  padActive: boolean;
  /** Frames per second, or null when the readout is switched off. */
  fps: number | null;
}

export interface GameOptions {
  canvas: HTMLCanvasElement;
  trackId: string;
  laps: number;
  color: string;
  /** Start-grid slot for the local car. */
  slot: number;
  input: InputManager;
  onFrame(frame: HudFrame): void;
  /** Called NET_SEND_HZ times a second with the local car's transform. */
  onNet?(transform: TransformMessage): void;
  /** The local car has completed the race distance. */
  onFinish?(): void;
  /** A hard knock (or a boost pad), 0..1. */
  onImpact?(strength: number): void;
  /** The simulation keeps throwing and has stopped; the stage should be rebuilt. */
  onCrash?(error: unknown): void;
}

interface Snapshot extends Pose {
  t: number;
  steer: number;
  speed: number;
}

interface RemoteCar {
  mesh: CarMesh;
  body: RemoteBody;
  color: string;
  buffer: Snapshot[];
  spin: number;
  pose: Pose | null;
}

const GEARS = [0, 16, 30, 44, 58, 72, 100];
/** Enough catch-up steps to stay real-time down to about 20 frames per second. */
const MAX_STEPS_PER_FRAME = Math.ceil(PHYSICS_HZ / 20);
const HOLD_INPUT: DriveInput = { steer: 0, throttle: 0, brake: 0, boost: false };

const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion();
const _v = new THREE.Vector3();

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  _q0.set(a.qx, a.qy, a.qz, a.qw).slerp(_q1.set(b.qx, b.qy, b.qz, b.qw), t);
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    qx: _q0.x,
    qy: _q0.y,
    qz: _q0.z,
    qw: _q0.w,
  };
}

/** Where a remote car was at time `t`, blending between the snapshots either side of it. */
function sampleSnapshots(buffer: Snapshot[], t: number): Snapshot | null {
  const last = buffer[buffer.length - 1];
  if (!last) return null;
  if (t >= last.t) {
    // Ran out of data: coast along the last known velocity briefly, then hold.
    const prev = buffer[buffer.length - 2];
    if (!prev || last.t === prev.t) return last;
    const ahead = Math.min(t - last.t, 150) / (last.t - prev.t);
    return { ...last, x: last.x + (last.x - prev.x) * ahead, z: last.z + (last.z - prev.z) * ahead };
  }
  for (let i = buffer.length - 2; i >= 0; i--) {
    const a = buffer[i]!;
    if (t < a.t) continue;
    const b = buffer[i + 1]!;
    const f = (t - a.t) / (b.t - a.t || 1);
    return { ...lerpPose(a, b, f), t, steer: a.steer + (b.steer - a.steer) * f, speed: a.speed + (b.speed - a.speed) * f };
  }
  return buffer[0]!;
}

export class Game {
  readonly path: TrackPath;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(66, 1, 0.3, 2000);
  private readonly lighting: Lighting;
  private readonly world: World;
  private readonly physics: PhysicsWorld;
  private readonly car: LocalCar;
  private readonly carMesh: CarMesh;
  private readonly remotes = new Map<string, RemoteCar>();
  private readonly audio = new EngineAudio();
  private readonly resizeObserver: ResizeObserver;

  private raf = 0;
  private running = false;
  private lastFrame = 0;
  private accumulator = 0;
  private netAccumulator = 0;
  private prevPose: Pose;
  private currPose: Pose;

  /** performance.now() at which the lights go green. Infinity keeps the car held on the grid. */
  goAt = Infinity;
  finished = false;
  private readonly progress: RaceProgress = newProgress();
  private trackHint = -1;
  private trackS = 0;
  private wrongWay = false;
  private stuckFor = 0;
  /** Seconds the car has spent outside the barriers. */
  private offTrackFor = 0;
  /** A head-on crash in progress: seconds left, and where on the track to put the car back. */
  private wreck: { left: number; s: number; lateral: number } | null = null;
  /** Pad the car is currently on, so one pass gives one kick. */
  private onPad = -1;
  /** Frames in a row that threw. */
  private faults = 0;
  /** Input used by the most recent physics step. */
  private lastInput: DriveInput = HOLD_INPUT;

  private readonly camForward = new THREE.Vector3(0, 0, 1);
  private shake = 0;
  /** Smoothed frames per second. */
  fps = 60;
  private showFps = false;
  private pixelRatio = 1;
  /** Seconds the frame rate has been below target; drives the quality fallback. */
  private slowFor = 0;

  static async create(options: GameOptions): Promise<Game> {
    await initPhysics();
    return new Game(options);
  }

  private constructor(private readonly options: GameOptions) {
    this.path = buildTrackPath(getTrack(options.trackId));

    this.renderer = new THREE.WebGLRenderer({ canvas: options.canvas, antialias: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const terrain = buildTerrain(this.path);
    this.world = buildWorld(this.scene, this.path, terrain, this.renderer.capabilities.getMaxAnisotropy());
    this.lighting = addLighting(this.scene);

    this.physics = new PhysicsWorld(this.path, terrain);
    this.car = new LocalCar(this.physics);
    this.carMesh = createCarMesh(options.color);
    this.scene.add(this.carMesh.group);

    const slot = gridSlot(this.path, options.slot);
    this.car.place(slot.x, slot.y, slot.z, slot.heading, slot.grade);
    this.prevPose = this.currPose = this.car.pose();
    this.camForward.set(Math.sin(slot.heading), 0, Math.cos(slot.heading));

    options.input.onKey = (code) => {
      this.audio.resume();
      if (code === 'KeyR') this.respawn();
      if (code === 'KeyM') this.audio.toggleMute();
      if (code === 'KeyF') this.showFps = !this.showFps;
    };

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);
    this.resize();

    if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = this;
  }

  private resize() {
    const canvas = this.options.canvas;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Lets the engine note play; call from a click or key press. */
  enableAudio() {
    this.audio.resume();
  }

  // ---- other players -------------------------------------------------------

  /** Feeds in the latest known transform for another player. Creates their car on first sight. */
  pushRemote(id: string, name: string, color: string, now: number, t: Pose & { speed: number; steer: number }) {
    let remote = this.remotes.get(id);
    if (!remote) {
      const mesh = createCarMesh(color);
      mesh.group.add(createNameTag(name, color));
      mesh.group.visible = false;
      this.scene.add(mesh.group);
      remote = { mesh, body: new RemoteBody(this.physics), color, buffer: [], spin: 0, pose: null };
      this.remotes.set(id, remote);
    }
    const last = remote.buffer[remote.buffer.length - 1];
    // State patches arrive for every change in the room; only keep the ones where this car actually moved.
    if (last && last.x === t.x && last.z === t.z && last.qy === t.qy && last.qw === t.qw && last.y === t.y) return;
    remote.buffer.push({ t: now, x: t.x, y: t.y, z: t.z, qx: t.qx, qy: t.qy, qz: t.qz, qw: t.qw, steer: t.steer, speed: t.speed });
    if (remote.buffer.length > 24) remote.buffer.shift();
  }

  removeRemote(id: string) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.scene.remove(remote.mesh.group);
    remote.mesh.dispose();
    remote.body.dispose();
    this.remotes.delete(id);
  }

  remoteIds(): string[] {
    return [...this.remotes.keys()];
  }

  // ---- simulation ----------------------------------------------------------

  /**
   * Picks a race back up part-way through, after a reload or a rebuilt stage:
   * the car goes back on the track nearest to where the server last saw it,
   * with the lap progress the server has on record.
   */
  resume(x: number, z: number, count: number, finished: boolean) {
    this.currPose = { ...this.currPose, x, z };
    this.trackHint = -1;
    this.respawn();
    const proj = projectOnTrack(this.path, this.currPose.x, this.currPose.z, -1);
    this.trackHint = proj.index;
    this.progress.count = count;
    this.progress.sector = sectorOf(proj.s, this.path.length, this.path.def.sectors);
    this.finished = finished;
    const heading = pointOnTrack(this.path, proj.s, 0).heading;
    this.camForward.set(Math.sin(heading), 0, Math.cos(heading));
  }

  private respawn() {
    const proj = projectOnTrack(this.path, this.currPose.x, this.currPose.z, this.trackHint);
    this.placeOnTrack(proj.s, proj.lateral);
  }

  /** Puts the car down at rest, facing along the track, `s` metres round and `lateral` across (kept off the barriers). */
  private placeOnTrack(s: number, lateral: number) {
    const limit = this.path.def.width / 2 - 2.5;
    const spot = pointOnTrack(this.path, s, Math.max(-limit, Math.min(limit, lateral)));
    this.car.place(spot.x, spot.y, spot.z, spot.heading, spot.grade);
    this.prevPose = this.currPose = this.car.pose();
    this.camForward.set(Math.sin(spot.heading), 0, Math.cos(spot.heading));
    this.stuckFor = 0;
    this.offTrackFor = 0;
    this.onPad = -1;
    this.wreck = null;
  }

  private fixedStep(now: number) {
    const live = now >= this.goAt && !this.finished;
    const wrecked = this.wreck !== null;
    const input = live && !wrecked ? this.options.input.sample(now) : HOLD_INPUT;
    this.lastInput = input;

    const renderTime = now - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) {
      const snapshot = sampleSnapshots(remote.buffer, renderTime);
      if (snapshot) remote.body.moveTo(snapshot);
    }

    this.prevPose = this.currPose;
    // A wrecked car gets no throttle and no air control, so it tumbles freely.
    this.car.update(input, PHYSICS_DT, !live || wrecked);
    this.physics.step();

    const hit = resolveBarriers(this.car, this.path, this.trackHint, wrecked);
    if (hit?.headOn) {
      const at = this.car.body.translation();
      const proj = projectOnTrack(this.path, at.x, at.z, this.trackHint);
      this.wreck = { left: BARRIER.wreckTime, s: proj.s, lateral: proj.lateral };
      wreck(this.car, hit);
      this.shake = 1;
      this.options.onImpact?.(1);
    }
    this.currPose = this.car.pose();

    // Lap progress.
    const proj = projectOnTrack(this.path, this.currPose.x, this.currPose.z, this.trackHint);
    this.trackHint = proj.index;
    this.trackS = proj.s;
    const sectors = this.path.def.sectors;
    advanceProgress(this.progress, sectorOf(proj.s, this.path.length, sectors), sectors);
    if (!this.finished && isFinished(this.progress.count, this.options.laps, sectors)) {
      this.finished = true;
      this.options.onFinish?.();
    }

    // Facing against the flow of the track while moving?
    const { qx, qy, qz, qw } = this.currPose;
    const fx = 2 * (qx * qz + qw * qy);
    const fz = 1 - 2 * (qx * qx + qy * qy);
    const along = fx * this.path.tx[proj.index]! + fz * this.path.tz[proj.index]!;
    this.wrongWay = live && along < -0.35 && this.car.forwardSpeed > 4;

    // Boost pads: one kick per pass, only when driving the right way.
    const pad = boostPadAt(this.path, proj.s, proj.lateral);
    const groundY = this.path.y[proj.index]!;
    if (pad >= 0 && pad !== this.onPad && live && !wrecked && along > 0.5 && this.currPose.y - groundY < 2.5) {
      this.car.hitBoostPad();
      this.shake = Math.max(this.shake, 0.25);
      this.options.onImpact?.(0.35);
    }
    this.onPad = pad;

    // Knocks.
    if (this.car.impact > 3.5) {
      const strength = Math.min(1, this.car.impact / 14);
      this.shake = Math.max(this.shake, strength);
      this.options.onImpact?.(strength);
    }

    // Recover a car that has ended up on its roof or out of the world.
    const upY = 1 - 2 * (qx * qx + qz * qz);
    const height = this.currPose.y - groundY;
    if (upY < 0.3 || height < -4 || height > 40) this.stuckFor += PHYSICS_DT;
    else this.stuckFor = 0;
    // Launched over the barrier into the hills: bring it back.
    const barrier = this.path.def.width / 2 + TRACKSIDE.kerbWidth + TRACKSIDE.wallGap + TRACKSIDE.wallThickness;
    if (Math.abs(proj.lateral) > barrier + 1) this.offTrackFor += PHYSICS_DT;
    else this.offTrackFor = 0;
    if (this.wreck) {
      // The wreck plays out, then the car goes back where it crashed; the usual recovery waits.
      this.wreck.left -= PHYSICS_DT;
      if (this.wreck.left <= 0) this.placeOnTrack(this.wreck.s, this.wreck.lateral);
    } else if (this.stuckFor > 1.2 || this.offTrackFor > 1.5) {
      this.respawn();
    }

    this.netAccumulator += PHYSICS_DT;
    if (this.netAccumulator >= 1 / NET_SEND_HZ) {
      this.netAccumulator = 0;
      const p = this.currPose;
      const r = (v: number) => Math.round(v * 1000) / 1000;
      this.options.onNet?.([
        r(p.x),
        r(p.y),
        r(p.z),
        r(p.qx),
        r(p.qy),
        r(p.qz),
        r(p.qw),
        r(this.car.forwardSpeed),
        r(this.car.steer),
      ]);
    }
  }

  private frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    try {
      this.tick(now);
      this.faults = 0;
    } catch (error) {
      // One bad frame is survivable; a run of them means the simulation is broken and needs rebuilding.
      console.error('[game] frame failed', error);
      if (++this.faults >= 5) {
        this.running = false;
        cancelAnimationFrame(this.raf);
        this.options.onCrash?.(error);
      }
    }
  };

  private tick(now: number) {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      this.fixedStep(now);
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0; // fell too far behind (tab was in the background): drop the backlog

    this.guardFrameRate(dt);

    this.render(now, dt, this.accumulator / PHYSICS_DT);
  }

  /**
   * If the machine cannot hold a smooth frame rate, trade sharpness for it:
   * first render fewer pixels, then drop shadows. Low frame rate reads as
   * input lag, so this matters more than the extra detail. Never steps back up,
   * to avoid flickering between settings.
   */
  private guardFrameRate(dt: number) {
    if (dt >= 0.1 || document.visibilityState !== 'visible') {
      this.slowFor = 0; // a stalled or hidden tab says nothing about rendering cost
      return;
    }
    this.slowFor = this.fps < 50 ? this.slowFor + dt : 0;
    if (this.slowFor < 1.5) return;
    this.slowFor = 0;
    if (this.pixelRatio > 1) {
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.resize();
    } else if (this.lighting.sun.castShadow) {
      this.lighting.sun.castShadow = false;
    }
  }

  private render(now: number, dt: number, alpha: number) {
    // Local car, blended between the last two physics states so motion stays smooth at any refresh rate.
    const pose = lerpPose(this.prevPose, this.currPose, alpha);
    const group = this.carMesh.group;
    group.position.set(pose.x, pose.y, pose.z);
    group.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
    this.carMesh.setWheels(this.car.wheels);
    const live = now >= this.goAt && !this.finished;
    this.carMesh.setBraking(!live || this.lastInput.brake > 0.05);
    this.carMesh.setBoosting(this.car.boosting);

    // Other cars.
    const others: HudFrame['others'] = [];
    const renderTime = now - INTERP_DELAY_MS;
    for (const remote of this.remotes.values()) {
      const snapshot = sampleSnapshots(remote.buffer, renderTime);
      if (!snapshot) continue;
      const mesh = remote.mesh.group;
      mesh.visible = true;
      mesh.position.set(snapshot.x, snapshot.y, snapshot.z);
      mesh.quaternion.set(snapshot.qx, snapshot.qy, snapshot.qz, snapshot.qw);
      remote.spin += (snapshot.speed / CAR.wheelRadius) * dt;
      const y = CAR.mountY - CAR.suspensionRest + 0.06;
      remote.mesh.setWheels([
        { x: CAR.axleHalfTrack, y, z: CAR.axleFront, steer: snapshot.steer, spin: remote.spin, grounded: true },
        { x: -CAR.axleHalfTrack, y, z: CAR.axleFront, steer: snapshot.steer, spin: remote.spin, grounded: true },
        { x: CAR.axleHalfTrack, y, z: CAR.axleRear, steer: 0, spin: remote.spin, grounded: true },
        { x: -CAR.axleHalfTrack, y, z: CAR.axleRear, steer: 0, spin: remote.spin, grounded: true },
      ]);
      others.push({ x: snapshot.x, z: snapshot.z, color: remote.color });
    }

    this.world.update(dt);
    this.updateCamera(pose, dt);
    this.lighting.follow(group.position);
    this.renderer.render(this.scene, this.camera);

    // HUD + audio.
    const speed = Math.abs(this.car.forwardSpeed);
    let gear = 1;
    while (gear < GEARS.length - 1 && speed >= GEARS[gear]!) gear++;
    const lo = GEARS[gear - 1]!;
    const hi = GEARS[gear]!;
    const rpm = Math.min(1, 0.22 + 0.78 * ((speed - lo) / (hi - lo)));
    this.audio.update(rpm, this.lastInput.throttle);

    const sectors = this.path.def.sectors;
    const score = raceScore(this.progress.count, this.trackS, this.path.length, sectors);
    this.options.onFrame({
      speedKmh: speed * 3.6,
      rpm,
      gear,
      boost: this.car.boost,
      boosting: this.car.boosting,
      progress: this.finished ? 1 : progressFraction(score, this.options.laps, sectors),
      lap: currentLap(this.progress.count, this.options.laps, sectors),
      laps: this.options.laps,
      wrongWay: this.wrongWay,
      wrecked: this.wreck !== null,
      x: pose.x,
      z: pose.z,
      others,
      padActive: this.options.input.padActive,
      fps: this.showFps ? this.fps : null,
    });
  }

  private updateCamera(pose: Pose, dt: number) {
    // Follow the car's heading only — pitch and roll would make the view lurch.
    _q0.set(pose.qx, pose.qy, pose.qz, pose.qw);
    _v.set(0, 0, 1).applyQuaternion(_q0);
    _v.y = 0;
    // A tumbling car's nose swings everywhere: hold the view steady until it is back on the track.
    if (!this.wreck && _v.lengthSq() > 0.01) {
      _v.normalize();
      this.camForward.lerp(_v, 1 - Math.exp(-5.5 * dt)).normalize();
    }

    const speedRatio = Math.min(1.25, Math.abs(this.car.forwardSpeed) / CAR.maxSpeed);
    const distance = 6.1 + speedRatio * 1.5;
    const height = 2.45 + speedRatio * 0.2;

    this.shake = Math.max(0, this.shake - dt * 2.5);
    const rumble = this.shake * 0.35 + Math.max(0, speedRatio - 0.75) * 0.05;

    this.camera.position.set(
      pose.x - this.camForward.x * distance + (Math.random() - 0.5) * rumble,
      pose.y + height + (Math.random() - 0.5) * rumble,
      pose.z - this.camForward.z * distance + (Math.random() - 0.5) * rumble,
    );
    this.camera.lookAt(pose.x + this.camForward.x * 5, pose.y + 0.9, pose.z + this.camForward.z * 5);

    // The view widens with speed — most of the sensation of going fast comes from this.
    const targetFov = 66 + speedRatio * 20 + (this.car.boosting ? 7 : 0);
    if (Math.abs(targetFov - this.camera.fov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-4 * dt));
      this.camera.updateProjectionMatrix();
    }
  }

  /** Numbers for automated checks and tuning. */
  telemetry() {
    return {
      fps: Math.round(this.fps),
      hz: PHYSICS_HZ,
      pixelRatio: this.pixelRatio,
      shadows: this.lighting.sun.castShadow,
      speed: this.car.forwardSpeed,
      pose: this.currPose,
      s: this.trackS,
      count: this.progress.count,
      finished: this.finished,
      wrongWay: this.wrongWay,
      wrecked: this.wreck !== null,
      boost: this.car.boost,
      remotes: this.remotes.size,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.options.input.onKey = undefined;
    for (const id of this.remoteIds()) this.removeRemote(id);
    this.carMesh.dispose();
    this.car.dispose();
    this.physics.dispose();
    this.audio.dispose();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        (material as THREE.MeshLambertMaterial).map?.dispose();
        material.dispose();
      }
    });
    this.renderer.dispose();
    if (import.meta.env.DEV) delete (window as unknown as { __game?: Game }).__game;
  }
}
