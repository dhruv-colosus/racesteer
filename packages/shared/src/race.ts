/**
 * Lap logic shared by client (instant HUD) and server (the result that counts).
 *
 * The track is cut into equal sectors. A car only makes progress by driving
 * forwards into the sector it is expected to enter next, so cutting the course
 * or reversing over the line earns nothing. `count` is how many sectors have been
 * entered in order; the first one is the start line itself.
 */

export interface RaceProgress {
  /** Sectors entered in order since the start. 0 = still behind the start line. */
  count: number;
  /** Sector the car was last seen in; -1 before the first observation. */
  sector: number;
}

export function newProgress(): RaceProgress {
  return { count: 0, sector: -1 };
}

export function sectorOf(s: number, trackLength: number, sectors: number): number {
  const i = Math.floor((s / trackLength) * sectors);
  return Math.min(sectors - 1, Math.max(0, i));
}

/**
 * Feeds the car's current sector in. Progress advances only when the car
 * moves into the expected sector from the one directly before it, i.e. by
 * driving forwards across the boundary. Returns true when it advanced.
 */
export function advanceProgress(progress: RaceProgress, sector: number, sectors: number): boolean {
  const previous = progress.sector;
  progress.sector = sector;
  if (previous < 0 || previous === sector) return false;
  const expected = progress.count % sectors;
  if (sector !== expected || previous !== (expected - 1 + sectors) % sectors) return false;
  progress.count++;
  return true;
}

/**
 * Continuous race position in sector units: whole sectors done plus how far
 * the car is into the one it last entered. Higher is further ahead.
 */
export function raceScore(count: number, s: number, trackLength: number, sectors: number): number {
  if (count <= 0) return 0;
  const sectorLength = trackLength / sectors;
  const last = (count - 1) % sectors;
  let into = s - last * sectorLength;
  // Wrap to the nearest representation so a car just behind the line reads as "not into it yet".
  if (into > trackLength / 2) into -= trackLength;
  else if (into < -trackLength / 2) into += trackLength;
  const frac = Math.min(1, Math.max(0, into / sectorLength));
  return count - 1 + frac;
}

export function totalSectors(laps: number, sectors: number): number {
  return laps * sectors;
}

export function isFinished(count: number, laps: number, sectors: number): boolean {
  return count >= totalSectors(laps, sectors) + 1;
}

/** 0..1 through the whole race. */
export function progressFraction(score: number, laps: number, sectors: number): number {
  return Math.min(1, Math.max(0, score / totalSectors(laps, sectors)));
}

/** Lap currently being driven, 1-based and capped at the race length. */
export function currentLap(count: number, laps: number, sectors: number): number {
  if (count <= 0) return 1;
  return Math.min(laps, Math.floor((count - 1) / sectors) + 1);
}

export interface Ranked {
  id: string;
  finished: boolean;
  /** Milliseconds from green light; only meaningful when finished. */
  finishTime: number;
  score: number;
}

/** Finishers by time, then everyone still running by how far they have got. Returns ids, leader first. */
export function rankPlayers(players: readonly Ranked[]): string[] {
  return [...players]
    .sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) return a.finishTime - b.finishTime || a.id.localeCompare(b.id);
      return b.score - a.score || a.id.localeCompare(b.id);
    })
    .map((p) => p.id);
}

export function formatRaceTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function ordinal(place: number): string {
  const rem100 = place % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${place}th`;
  switch (place % 10) {
    case 1:
      return `${place}st`;
    case 2:
      return `${place}nd`;
    case 3:
      return `${place}rd`;
    default:
      return `${place}th`;
  }
}
