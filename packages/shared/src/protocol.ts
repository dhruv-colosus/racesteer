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
} as const;

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
}

export type JoinOptions = { role: 'player'; name: string } | { role: 'pad'; token: string };

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
