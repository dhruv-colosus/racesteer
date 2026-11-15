import { JoinError, type RoomSettings } from '@racing/shared';
import { createRoom, describeJoinError, joinRoom, reconnectRoom, type GameRoom } from './client';

/**
 * What a display remembers about the room it is in, so it can get back after
 * a reload, a crash, a dead network or a server restart. Kept per tab
 * (sessionStorage) so two tabs in the same room never share a seat.
 */
export interface SavedSession {
  code: string;
  /** Colyseus reconnection token: reclaims the exact seat while the server still holds it. */
  token: string;
  name: string;
  /** Phone pairing token, re-requested on rejoin so a paired phone stays paired. */
  padToken: string | null;
  /** Enough to recreate the room if the server lost it. */
  settings?: RoomSettings;
  practice?: boolean;
}

const key = (slot: string) => `tiltrush.session.${slot}`;

export function loadSession(slot: string): SavedSession | null {
  try {
    const raw = sessionStorage.getItem(key(slot));
    const parsed = raw ? (JSON.parse(raw) as SavedSession) : null;
    return parsed && typeof parsed.code === 'string' && typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveSession(slot: string, patch: Partial<SavedSession> & { code: string }) {
  try {
    const current = loadSession(slot);
    const base: SavedSession = current && current.code === patch.code ? current : { code: patch.code, token: '', name: 'Driver', padToken: null };
    sessionStorage.setItem(key(slot), JSON.stringify({ ...base, ...patch }));
  } catch {
    /* storage unavailable — recovery after a reload just will not be possible */
  }
}

export function clearSession(slot: string) {
  try {
    sessionStorage.removeItem(key(slot));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Set when the UI has crashed and the page is about to reload itself. Screens
 * tearing down in that state must keep their seat and saved session, not
 * leave the room as they would on a normal exit.
 */
let crashing = false;
export const markCrashing = () => {
  crashing = true;
};
export const isCrashing = () => crashing;

/**
 * Reconnection tokens the server has already refused. A token is tied to one
 * connection and never becomes valid again, so offering it twice only costs a
 * round trip (and a "token invalid" line in the server log).
 */
const deadTokens = new Set<string>();
export const forgetToken = (token: string | undefined) => {
  if (token) deadTokens.add(token);
};

/** The room exists but will not have us back; retrying cannot help. */
export class RejoinRefused extends Error {}

const isNetworkError = (error: unknown) => error instanceof TypeError || /fetch|network|ECONN|timeout/i.test(String((error as Error)?.message));
const isNotFound = (error: unknown) => {
  const { code, message } = (error ?? {}) as { code?: number; message?: string };
  return code === 522 || /not found|invalid room/i.test(message ?? '');
};

/**
 * One attempt to get back into a room, best option first:
 *  1. reclaim the held seat (same car, same race position),
 *  2. join the room again as a new arrival,
 *  3. the room is gone (server restarted): recreate it under the same code.
 */
async function rejoinOnce(session: SavedSession): Promise<GameRoom> {
  if (session.token && !deadTokens.has(session.token)) {
    try {
      return await reconnectRoom(session.token);
    } catch (error) {
      if (isNetworkError(error)) throw error;
      // Seat no longer held (hold ran out, or the server restarted) — fall through to a fresh join.
      forgetToken(session.token);
    }
  }
  const padToken = session.padToken ?? undefined;
  try {
    return await joinRoom(session.code, session.name, padToken);
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === JoinError.RoomFull || code === JoinError.RaceInProgress) throw new RejoinRefused(describeJoinError(error));
    if (!isNotFound(error)) throw error;
  }
  return createRoom({
    ...session.settings,
    role: 'player',
    name: session.name,
    practice: session.practice,
    code: session.code,
    padToken,
  });
}

interface RejoinOptions {
  /** Give up after this long. Infinity keeps trying for as long as the page is open. */
  giveUpAfterMs?: number;
  cancelled(): boolean;
  onAttempt?(attempt: number): void;
}

/** Keeps trying to get back into a room, backing off, until it works, is refused, or time runs out. */
export async function rejoin(read: () => SavedSession | null, options: RejoinOptions): Promise<GameRoom> {
  const deadline = Date.now() + (options.giveUpAfterMs ?? 60_000);
  let lastError: unknown = new Error('No saved session.');
  for (let attempt = 1; ; attempt++) {
    const session = read();
    if (!session) throw lastError;
    options.onAttempt?.(attempt);
    try {
      const room = await rejoinOnce(session);
      if (options.cancelled()) {
        void room.leave().catch(() => {});
        throw new Error('cancelled');
      }
      return room;
    } catch (error) {
      if (error instanceof RejoinRefused || options.cancelled()) throw error;
      lastError = error;
    }
    if (Date.now() > deadline) throw lastError;
    // 0.4 s, 0.8 s, 1.6 s … capped at 4 s, with jitter so a whole room does not retry in step.
    const delay = Math.min(4000, 400 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (options.cancelled()) throw new Error('cancelled');
  }
}
