import { Client, type Room } from '@colyseus/sdk';
import {
  JoinError,
  ROOM_NAME,
  type CreateOptions,
  type JoinOptions,
  type RaceStateLike,
  type RoomListing,
} from '@racing/shared';

/** The game server is always reached through the page's own origin, under /colyseus. */
const SERVER_PATH = '/colyseus';

export type GameRoom = Room<any, RaceStateLike>;

let client: Client | null = null;
const getClient = () => (client ??= new Client(`${window.location.origin}${SERVER_PATH}`));

export function createRoom(options: CreateOptions): Promise<GameRoom> {
  return getClient().create(ROOM_NAME, options) as Promise<GameRoom>;
}

export function joinRoom(code: string, name: string): Promise<GameRoom> {
  const options: JoinOptions = { role: 'player', name };
  return getClient().joinById(code, options) as Promise<GameRoom>;
}

export function joinAsPad(code: string, token: string): Promise<GameRoom> {
  const options: JoinOptions = { role: 'pad', token };
  return getClient().joinById(code, options) as Promise<GameRoom>;
}

export async function listRooms(signal?: AbortSignal): Promise<RoomListing[]> {
  const response = await fetch(`${SERVER_PATH}/api/rooms`, { signal });
  if (!response.ok) throw new Error(`Room list failed (${response.status})`);
  return (await response.json()) as RoomListing[];
}

/** Turns a failed create/join into something worth showing a player. */
export function describeJoinError(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: number; message?: string };
  switch (code) {
    case JoinError.RoomFull:
      return 'That room is full.';
    case JoinError.RaceInProgress:
      return 'That race has already started. Try again when it finishes.';
    case JoinError.BadPadToken:
      return 'This controller link has expired. Scan the code on the screen again.';
    case JoinError.PadAlreadyConnected:
      return 'Another phone is already controlling this car.';
  }
  if (message && /not found/i.test(message)) return 'No room with that code.';
  if (message && /locked/i.test(message)) return 'That room is full.';
  if (error instanceof TypeError || (message && /fetch|network|ECONN/i.test(message))) {
    return 'Cannot reach the game server.';
  }
  return message || 'Something went wrong. Try again.';
}

/**
 * A room that was just created or joined on one screen and is about to be
 * picked up by the room screen, so the connection survives the navigation.
 */
let stashed: GameRoom | null = null;
export function stashRoom(room: GameRoom) {
  stashed = room;
}
export function takeRoom(code: string): GameRoom | null {
  const room = stashed && stashed.roomId === code ? stashed : null;
  stashed = null;
  return room;
}

const NAME_KEY = 'tiltrush.name';
export function loadName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}
export function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode — the name just will not be remembered */
  }
}
