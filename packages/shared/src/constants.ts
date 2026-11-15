/** Colyseus room type name. */
export const ROOM_NAME = 'race';

export const MIN_MAX_PLAYERS = 2;
export const MAX_PLAYERS_LIMIT = 8;
export const DEFAULT_MAX_PLAYERS = 4;

export const LAP_OPTIONS = [1, 2, 3, 5] as const;
export const DEFAULT_LAPS = 3;

/** How often a display sends its car transform, and how often the server patches state. */
export const NET_SEND_HZ = 20;
export const PATCH_RATE_MS = 1000 / NET_SEND_HZ;

/** Remote cars are drawn this far in the past so there is always a snapshot to blend toward. */
export const INTERP_DELAY_MS = 100;

/** READY (1 s) then 3, 2, 1 — the race is live when this has elapsed. */
export const COUNTDOWN_MS = 4000;

/** After the first car finishes, the rest get this long before the race is closed. */
export const FINISH_GRACE_MS = 30_000;

/** Phone pad sends at most this often. */
export const PAD_SEND_HZ = 60;
/** Pad input older than this is ignored and the keyboard takes over. */
export const PAD_STALE_MS = 600;

export const NAME_MAX_LENGTH = 16;
export const ROOM_NAME_MAX_LENGTH = 24;

export const CAR_COLORS = [
  '#ff2d78', // magenta
  '#22d3ee', // cyan
  '#facc15', // yellow
  '#4ade80', // green
  '#fb923c', // orange
  '#a78bfa', // violet
  '#f8fafc', // white
  '#ef4444', // red
] as const;

export type Phase = 'lobby' | 'countdown' | 'racing' | 'finished';

/** Close/error codes the server uses when it refuses a join. */
export const JoinError = {
  RoomFull: 4101,
  RaceInProgress: 4102,
  BadPadToken: 4103,
  /** Creating a room with a requested code that is already in use. */
  CodeTaken: 4104,
} as const;

/** Close code a phone gets when another phone takes over the same car. It must not fight to get it back. */
export const PAD_REPLACED = 4105;

/** How long a dropped display keeps its seat: short in the lobby, longer once a race is on. */
export const LOBBY_HOLD_SECONDS = 20;
export const RACE_HOLD_SECONDS = 45;
