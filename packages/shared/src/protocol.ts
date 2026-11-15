import {
  DEFAULT_LAPS,
  DEFAULT_MAX_PLAYERS,
  LAP_OPTIONS,
  MAX_PLAYERS_LIMIT,
  MIN_MAX_PLAYERS,
  NAME_MAX_LENGTH,
  ROOM_NAME_MAX_LENGTH,
} from './constants';

/** Message type names. Short ones are the high-frequency messages. */
export const Msg = {
  /** display → server: TransformMessage, NET_SEND_HZ times a second */
  Transform: 't',
  /** pad → server → paired display: PadInputMessage */
  PadInput: 'pi',
  /** display → server: toggle ready */
  Ready: 'ready',
  /** host → server: Partial<RoomSettings> */
  Settings: 'settings',
  /** host → server */
  Start: 'start',
  /** host → server, from the results screen */
  Rematch: 'rematch',
  /** server → display: { token } — what the phone needs to pair */
  PadToken: 'padToken',
  /** server → pad: { playerId } once bound */
  PadBound: 'padBound',
  /** server → everyone: { ms } until green light */
  Countdown: 'countdown',
  /** display → server → paired pad: { ms } vibration */
  Haptic: 'haptic',
  /** display → server: { name } — change your driver name while in the lobby */
  Rename: 'rename',
  /** display → server (no payload), server → display: SyncMessage — where the race stands, for a display that just (re)joined */
  Sync: 'sync',
} as const;

/** What a display needs to pick a race back up after a reload or reconnect. */
export interface SyncMessage {
  phase: string;
  /** Milliseconds until green light; negative once the race is running. Null outside a race. */
  goInMs: number | null;
  /** The server's lap progress for this car. */
  count: number;
  finished: boolean;
  /** Last position the server heard from this car. */
  x: number;
  z: number;
}

/** [x, y, z, qx, qy, qz, qw, speed, steer] */
export type TransformMessage = [number, number, number, number, number, number, number, number, number];

export interface RoomSettings {
  roomName: string;
  maxPlayers: number;
  isPrivate: boolean;
  laps: number;
}

export interface CreateOptions extends Partial<RoomSettings> {
  role: 'player';
  name: string;
  /**
   * A one-driver room behind solo practice. It never races; it exists so a
   * phone can pair with the display and have its input relayed.
   */
  practice?: boolean;
  /**
   * Ask for a specific room code. Used to bring a room back under the code
   * everyone already has after the server restarted. Refused if it is taken.
   */
  code?: string;
  /** See JoinOptions. */
  padToken?: string;
}

export type JoinOptions =
  | {
      role: 'player';
      name: string;
      /**
       * Pairing token this display used before. If it is free the server keeps
       * it, so a phone that is already paired finds its way back on its own.
       */
      padToken?: string;
    }
  | { role: 'pad'; token: string };

/** Shape of a pad pairing token. */
export const PAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{12}$/;

/** Listing entry returned by GET /api/rooms. */
export interface RoomListing {
  code: string;
  roomName: string;
  players: number;
  maxPlayers: number;
  laps: number;
}

/** Metadata the room publishes to the matchmaker. */
export interface RoomMetadata {
  roomName: string;
  players: number;
  maxPlayers: number;
  laps: number;
  phase: string;
}

export function sanitizeName(value: unknown, fallback = 'Driver'): string {
  if (typeof value !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LENGTH);
  return cleaned || fallback;
}

/**
 * Makes a name unique among the names already taken, so two drivers never show
 * up the same: "Driver", "Driver 2", "Driver 3"…
 */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, NAME_MAX_LENGTH - suffix.length).trimEnd() + suffix;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** Applies untrusted settings on top of known-good ones, clamping everything. */
export function sanitizeSettings(input: unknown, base?: RoomSettings): RoomSettings {
  const src = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const current: RoomSettings = base ?? {
    roomName: 'Race',
    maxPlayers: DEFAULT_MAX_PLAYERS,
    isPrivate: false,
    laps: DEFAULT_LAPS,
  };
  const out: RoomSettings = { ...current };

  if (typeof src.roomName === 'string') {
    // eslint-disable-next-line no-control-regex
    const cleaned = src.roomName.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, ROOM_NAME_MAX_LENGTH);
    if (cleaned) out.roomName = cleaned;
  }
  if (typeof src.maxPlayers === 'number' && Number.isFinite(src.maxPlayers)) {
    out.maxPlayers = Math.min(MAX_PLAYERS_LIMIT, Math.max(MIN_MAX_PLAYERS, Math.round(src.maxPlayers)));
  }
  if (typeof src.isPrivate === 'boolean') out.isPrivate = src.isPrivate;
  if (typeof src.laps === 'number' && (LAP_OPTIONS as readonly number[]).includes(src.laps)) out.laps = src.laps;
  return out;
}

/** A player as the server publishes it in room state. Mirrors the server schema. */
export interface PlayerState {
  name: string;
  /** Index into CAR_COLORS. */
  color: number;
  ready: boolean;
  /** A phone is paired and connected. */
  pad: boolean;
  /** False while this display's connection is down and its seat is being held. */
  connected: boolean;
  /** Start-grid slot for the current race. */
  slot: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  speed: number;
  steer: number;
  /** Sectors entered in order — see race.ts. */
  count: number;
  score: number;
  /** 1-based race position; 0 before the race. */
  place: number;
  finished: boolean;
  /** Milliseconds from green light. */
  finishTime: number;
}

/** Room state as clients see it. */
export interface RaceStateLike {
  phase: string;
  /** True for the hidden one-driver room behind solo practice. */
  practice: boolean;
  roomName: string;
  maxPlayers: number;
  isPrivate: boolean;
  laps: number;
  trackId: string;
  hostId: string;
  players: {
    readonly size: number;
    get(id: string): PlayerState | undefined;
    forEach(callback: (player: PlayerState, id: string) => void): void;
  };
}
