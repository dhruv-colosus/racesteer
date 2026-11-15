import { describe, expect, it } from 'vitest';
import {
  TRACKS,
  advanceProgress,
  buildTrackPath,
  currentLap,
  decodePadInput,
  encodePadInput,
  formatRaceTime,
  generateRoomCode,
  gridSlot,
  isFinished,
  isRoomCode,
  newProgress,
  normalizeRoomCode,
  ordinal,
  pointOnTrack,
  progressFraction,
  projectOnTrack,
  raceScore,
  rankPlayers,
  rollFromGravity,
  sanitizeSettings,
  sectorOf,
  tiltToSteer,
  type RaceProgress,
} from './index';

const track = TRACKS[0]!;
const path = buildTrackPath(track);

describe('track path', () => {
  it('is a closed loop with even spacing', () => {
    expect(path.length).toBeGreaterThan(900);
    expect(path.length).toBeLessThan(1500);
    for (let i = 0; i < path.n; i++) {
      const j = (i + 1) % path.n;
      const d = Math.hypot(path.x[j]! - path.x[i]!, path.z[j]! - path.z[i]!);
      expect(d).toBeGreaterThan(path.step * 0.9);
      expect(d).toBeLessThan(path.step * 1.1);
    }
  });

  it('never bends tighter than the road is wide', () => {
    // Heading change per metre bounds curvature; radius must exceed half the width so the inner edge cannot fold.
    let maxCurvature = 0;
    for (let i = 0; i < path.n; i++) {
      const j = (i + 1) % path.n;
      const cross = path.tx[i]! * path.tz[j]! - path.tz[i]! * path.tx[j]!;
      maxCurvature = Math.max(maxCurvature, Math.abs(Math.asin(Math.max(-1, Math.min(1, cross)))) / path.step);
    }
    expect(1 / maxCurvature).toBeGreaterThan(track.width / 2 + 4);
  });

  it('does not pass close to itself', () => {
    const clearance = track.width + 8;
    for (let i = 0; i < path.n; i += 4) {
      for (let j = i + 4; j < path.n; j += 4) {
        const alongGap = Math.min(j - i, path.n - (j - i)) * path.step;
        if (alongGap < clearance * 3) continue;
        const d = Math.hypot(path.x[j]! - path.x[i]!, path.z[j]! - path.z[i]!);
        expect(d).toBeGreaterThan(clearance);
      }
    }
  });

  it('projects points back to where they came from', () => {
    for (const s of [0, 13.7, 250, path.length - 3]) {
      for (const lateral of [-5, 0, 6]) {
        const p = pointOnTrack(path, s, lateral);
        const proj = projectOnTrack(path, p.x, p.z);
        const ds = Math.abs(proj.s - s);
        expect(Math.min(ds, path.length - ds)).toBeLessThan(0.6);
        expect(proj.lateral).toBeCloseTo(lateral, 0);
      }
    }
  });

  it('gives the same answer with and without a hint', () => {
    const p = pointOnTrack(path, 400, 2);
    const full = projectOnTrack(path, p.x, p.z);
    const hinted = projectOnTrack(path, p.x, p.z, full.index - 5);
    const stale = projectOnTrack(path, p.x, p.z, (full.index + path.n / 2) % path.n);
    expect(hinted.index).toBe(full.index);
    expect(stale.index).toBe(full.index);
  });

  it('puts the grid behind the line, on the road, no two cars overlapping', () => {
    const slots = Array.from({ length: 8 }, (_, i) => gridSlot(path, i));
    slots.forEach((slot) => {
      const proj = projectOnTrack(path, slot.x, slot.z);
      expect(proj.s).toBeGreaterThan(path.length / 2); // behind the line = near the end of the lap
      expect(Math.abs(proj.lateral)).toBeLessThan(track.width / 2 - 2);
    });
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        expect(Math.hypot(slots[i]!.x - slots[j]!.x, slots[i]!.z - slots[j]!.z)).toBeGreaterThan(5);
      }
    }
  });
});

describe('lap logic', () => {
  const sectors = track.sectors;
  const L = path.length;

  /** Drives the centre line from `from` to `to` metres (absolute, may exceed a lap) in 3 m steps. */
  const drive = (progress: RaceProgress, from: number, to: number) => {
    const dir = to >= from ? 1 : -1;
    for (let d = from; dir > 0 ? d <= to : d >= to; d += 3 * dir) {
      const s = ((d % L) + L) % L;
      advanceProgress(progress, sectorOf(s, L, sectors), sectors);
    }
  };

  it('counts laps and finishes exactly when the last lap crosses the line', () => {
    const progress: RaceProgress = newProgress();
    drive(progress, -20, -1);
    expect(progress.count).toBe(0);
    drive(progress, -1, L - 5);
    expect(currentLap(progress.count, 2, sectors)).toBe(1);
    expect(isFinished(progress.count, 2, sectors)).toBe(false);
    drive(progress, L - 5, L + 5);
    expect(currentLap(progress.count, 2, sectors)).toBe(2);
    drive(progress, L + 5, 2 * L - 5);
    expect(isFinished(progress.count, 2, sectors)).toBe(false);
    drive(progress, 2 * L - 5, 2 * L + 2);
    expect(isFinished(progress.count, 2, sectors)).toBe(true);
  });

  it('cannot earn laps by reversing or cutting the course', () => {
    const backwards: RaceProgress = newProgress();
    drive(backwards, -5, 5); // off the grid and just over the line
    expect(backwards.count).toBe(1);
    drive(backwards, 5, -30 * L + 10); // thirty whole laps in reverse
    expect(backwards.count).toBe(1);
    drive(backwards, -30 * L + 10, -30 * L + 80); // forwards again picks up where it left off
    expect(backwards.count).toBe(2);

    const cutter: RaceProgress = newProgress();
    drive(cutter, -5, 30);
    const before = cutter.count;
    advanceProgress(cutter, sectorOf(L * 0.6, L, sectors), sectors); // teleport across the infield
    expect(cutter.count).toBe(before);
  });

  it('scores cars in track order, including either side of the line', () => {
    const justBehindLine = raceScore(sectors, L - 2, L, sectors); // in the last sector of lap 1
    const justOverLine = raceScore(sectors + 1, 2, L, sectors);
    expect(justOverLine).toBeGreaterThan(justBehindLine);
    expect(raceScore(1, L - 2, L, sectors)).toBe(0); // rolled back behind the line after starting
    expect(raceScore(0, 50, L, sectors)).toBe(0);
    expect(progressFraction(raceScore(sectors + 1, 0, L, sectors), 2, sectors)).toBeCloseTo(0.5, 2);
    expect(progressFraction(999, 2, sectors)).toBe(1);
  });

  it('ranks finishers by time ahead of everyone still running', () => {
    expect(
      rankPlayers([
        { id: 'slow-finisher', finished: true, finishTime: 95_000, score: 72 },
        { id: 'leader-on-track', finished: false, finishTime: 0, score: 70.5 },
        { id: 'winner', finished: true, finishTime: 90_000, score: 72 },
        { id: 'backmarker', finished: false, finishTime: 0, score: 31 },
      ]),
    ).toEqual(['winner', 'slow-finisher', 'leader-on-track', 'backmarker']);
  });

  it('formats times and places', () => {
    expect(formatRaceTime(83_456)).toBe('1:23.456');
    expect(formatRaceTime(5_007)).toBe('0:05.007');
    expect([1, 2, 3, 4, 11, 12, 13, 21].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st']);
  });
});

describe('tilt steering', () => {
  const G = 9.81;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  /** Android-style reading for a phone in portrait rolled clockwise by `deg`. */
  const androidPortrait = (deg: number) => [-G * Math.sin(rad(deg)), G * Math.cos(rad(deg))] as const;

  it('reads roll in portrait on both platforms', () => {
    const [ax, ay] = androidPortrait(20);
    expect(rollFromGravity(ax, ay, 0)).toBeCloseTo(20, 4);
    expect(rollFromGravity(-ax, -ay, 0)).toBeCloseTo(20, 4); // iOS reports the opposite sign
    expect(rollFromGravity(...androidPortrait(-30), 0)).toBeCloseTo(-30, 4);
  });

  it('reads roll in either landscape, whichever way the browser numbers them', () => {
    // Landscape with the device top pointing left, then rolled clockwise by 15°:
    // device x points up-ish, device y points left-ish.
    const roll = 15;
    const ax = G * Math.cos(rad(roll));
    const ay = G * Math.sin(rad(roll));
    expect(rollFromGravity(ax, ay, 90)).toBeCloseTo(roll, 4);
    expect(rollFromGravity(ax, ay, 270)).toBeCloseTo(roll, 4);
    expect(rollFromGravity(-ax, -ay, 90)).toBeCloseTo(roll, 4);
  });

  it('gives up when the phone is lying flat', () => {
    expect(rollFromGravity(0.3, 0.4, 90)).toBeNull();
  });

  it('maps roll to steering with a dead zone, a centre offset and a hard lock', () => {
    expect(tiltToSteer(1.5)).toBe(0);
    expect(tiltToSteer(-1.5)).toBe(0);
    expect(tiltToSteer(35)).toBe(1);
    expect(tiltToSteer(80)).toBe(1);
    expect(tiltToSteer(-50)).toBe(-1);
    const half = tiltToSteer(18.5);
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.5);
    expect(tiltToSteer(-18.5)).toBeCloseTo(-half, 6);
    expect(tiltToSteer(12, 10)).toBe(0); // re-centred at 10°
    expect(tiltToSteer(45, 10)).toBe(1);
  });

  it('round-trips pad input and rejects junk', () => {
    expect(decodePadInput(encodePadInput({ steer: -0.4567, throttle: 1, brake: 0, boost: true }))).toEqual({
      steer: -0.457,
      throttle: 1,
      brake: 0,
      boost: true,
    });
    expect(decodePadInput([5, -3, 9, 0])).toEqual({ steer: 1, throttle: 0, brake: 1, boost: false });
    expect(decodePadInput([0, 0, 0])).toBeNull();
    expect(decodePadInput([0, NaN, 0, 0])).toBeNull();
    expect(decodePadInput('steer')).toBeNull();
    expect(decodePadInput({ steer: 1 })).toBeNull();
  });
});

describe('rooms', () => {
  it('generates and validates room codes', () => {
    for (let i = 0; i < 200; i++) expect(isRoomCode(generateRoomCode())).toBe(true);
    expect(generateRoomCode(() => 0)).toBe('AAAAA');
    expect(generateRoomCode(() => 0.999999)).toBe('ZZZZZ');
    expect(normalizeRoomCode(' ab-cd3e! ')).toBe('ABCDE');
    expect(isRoomCode('ABCDE')).toBe(true);
    expect(isRoomCode('ABCDI')).toBe(false); // I and O are never issued
    expect(isRoomCode('ABCD')).toBe(false);
  });

  it('clamps untrusted settings', () => {
    const base = sanitizeSettings({});
    expect(base).toEqual({ roomName: 'Race', maxPlayers: 4, isPrivate: false, laps: 3 });
    expect(sanitizeSettings({ maxPlayers: 99, laps: 4, isPrivate: 'yes', roomName: '   ' }, base)).toEqual({
      ...base,
      maxPlayers: 8,
    });
    expect(sanitizeSettings({ maxPlayers: 0, laps: 5, isPrivate: true, roomName: ' Friday night ' }, base)).toEqual({
      roomName: 'Friday night',
      maxPlayers: 2,
      isPrivate: true,
      laps: 5,
    });
  });
});
