import { Client, type Room } from '@colyseus/sdk';
import type { Server } from '@colyseus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JoinError,
  Msg,
  ROOM_NAME,
  TRACKS,
  buildTrackPath,
  isRoomCode,
  pointOnTrack,
  type PadInputMessage,
  type RaceStateLike,
  type RoomListing,
} from '@racing/shared';
import { startServer } from '../src/app';

/**
 * End-to-end over real WebSockets: a server on a spare port and SDK clients
 * standing in for displays and phones.
 */
const PORT = 25_000 + Math.floor(Math.random() * 5_000);
const URL = `http://localhost:${PORT}`;
type GameRoom = Room<any, RaceStateLike>;

let server: Server;
const open: GameRoom[] = [];

const sdk = () => new Client(URL);
const track = <T extends GameRoom>(room: T) => (open.push(room), room);
const create = async (name: string, settings: Record<string, unknown> = {}) =>
  track((await sdk().create(ROOM_NAME, { role: 'player', name, ...settings })) as GameRoom);
const join = async (code: string, name: string) => track((await sdk().joinById(code, { role: 'player', name })) as GameRoom);
const joinPad = async (code: string, token: string) => track((await sdk().joinById(code, { role: 'pad', token })) as GameRoom);
const listing = async () => (await (await fetch(`${URL}/api/rooms`)).json()) as RoomListing[];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/** Waits for the first state sync so `room.state` is populated. */
const synced = (room: GameRoom) => until(() => room.state?.players?.size > 0, 'first state');

function nextMessage<T>(room: GameRoom, type: string): Promise<T> {
  return new Promise((resolve) => {
    const off = room.onMessage(type, (payload: T) => {
      off();
      resolve(payload);
    });
  });
}

async function padToken(room: GameRoom): Promise<string> {
  const reply = nextMessage<{ token: string }>(room, Msg.PadToken);
  room.send(Msg.PadToken);
  return (await reply).token;
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: number; message?: string };
  }
  throw new Error('expected the join to be refused');
}

beforeAll(async () => {
  server = await startServer(PORT);
});

afterAll(async () => {
  await Promise.all(open.map((room) => room.leave().catch(() => {})));
  await server.gracefullyShutdown(false);
});

describe('rooms', () => {
  it('creates a room with a shareable code, the creator as host, and the chosen settings', async () => {
    const host = await create('Ada', { roomName: 'Friday night', maxPlayers: 3, laps: 5, isPrivate: false });
    await synced(host);
    expect(isRoomCode(host.roomId)).toBe(true);
    expect(host.state.hostId).toBe(host.sessionId);
    expect(host.state).toMatchObject({ phase: 'lobby', roomName: 'Friday night', maxPlayers: 3, laps: 5, isPrivate: false });
    expect(host.state.players.get(host.sessionId)).toMatchObject({ name: 'Ada', ready: false, pad: false });
  });

  it('lists public rooms live and keeps private ones reachable only by code', async () => {
    const open = await create('Pub', { roomName: 'Open house', maxPlayers: 4 });
    const secret = await create('Priv', { roomName: 'Invite only', isPrivate: true });
    await sleep(60);

    const codes = (await listing()).map((room) => room.code);
    expect(codes).toContain(open.roomId);
    expect(codes).not.toContain(secret.roomId);
    expect((await listing()).find((room) => room.code === open.roomId)).toMatchObject({
      roomName: 'Open house',
      players: 1,
      maxPlayers: 4,
    });

    const guest = await join(secret.roomId, 'Guest');
    await synced(guest);
    expect(guest.state.players.size).toBe(2);
    expect(guest.state.roomName).toBe('Invite only');

    // Going private takes a public room off the list straight away.
    open.send(Msg.Settings, { isPrivate: true });
    await until(() => open.state.isPrivate === true, 'room to go private');
    await sleep(60);
    expect((await listing()).map((room) => room.code)).not.toContain(open.roomId);
  });

  it('refuses players beyond the limit and drops full rooms from the list', async () => {
    const host = await create('One', { maxPlayers: 2 });
    await join(host.roomId, 'Two');
    await until(() => host.state.players.size === 2, 'second player');
    await sleep(60);
    expect((await listing()).map((room) => room.code)).not.toContain(host.roomId);

    const refused = await rejection(sdk().joinById(host.roomId, { role: 'player', name: 'Three' }));
    expect(refused.code).toBe(JoinError.RoomFull);
    expect(host.state.players.size).toBe(2);
  });

  it('gives each player a different car colour and cleans up names', async () => {
    const host = await create('  Ada\u0007  ');
    const guest = await join(host.roomId, 'x'.repeat(60));
    await until(() => host.state.players.size === 2, 'second player');
    const a = host.state.players.get(host.sessionId)!;
    const b = host.state.players.get(guest.sessionId)!;
    expect(a.name).toBe('Ada');
    expect(b.name).toHaveLength(16);
    expect(a.color).not.toBe(b.color);
  });

  it('lets only the host change settings, and never below the current head count', async () => {
    const host = await create('Host', { maxPlayers: 4, laps: 3 });
    const guest = await join(host.roomId, 'Guest');
    const third = await join(host.roomId, 'Third');
    await until(() => host.state.players.size === 3, 'three players');

    guest.send(Msg.Settings, { laps: 1, maxPlayers: 8 });
    await sleep(120);
    expect(host.state.laps).toBe(3);
    expect(host.state.maxPlayers).toBe(4);

    host.send(Msg.Settings, { laps: 2, maxPlayers: 2, roomName: 'Renamed' });
    await until(() => host.state.laps === 2, 'laps to change');
    expect(host.state.maxPlayers).toBe(3); // three people are already in
    expect(third.state.roomName).toBe('Renamed');
  });

  it('hands the room to someone else when the host leaves', async () => {
    const host = await create('Host');
    const guest = await join(host.roomId, 'Guest');
    await until(() => guest.state.players?.size === 2, 'both players');
    await host.leave();
    await until(() => guest.state.hostId === guest.sessionId, 'host migration');
    expect(guest.state.players.size).toBe(1);
  });
});

describe('phone pad', () => {
  it('pairs by token and forwards input only to that player’s display', async () => {
    const ada = await create('Ada');
    const bob = await join(ada.roomId, 'Bob');
    await until(() => ada.state.players.size === 2, 'both players');

    const token = await padToken(ada);
    expect(token.length).toBeGreaterThanOrEqual(12);
    expect(await padToken(bob)).not.toBe(token);

    const pad = await joinPad(ada.roomId, token);
    const bound = await nextMessage<{ playerId: string }>(pad, Msg.PadBound);
    expect(bound.playerId).toBe(ada.sessionId);
    await until(() => ada.state.players.get(ada.sessionId)!.pad === true, 'pad flag');
    expect(ada.state.players.size).toBe(2); // a pad is not a player
    expect(bob.state.players.get(bob.sessionId)!.pad).toBe(false);

    const toAda: PadInputMessage[] = [];
    const toBob: PadInputMessage[] = [];
    ada.onMessage(Msg.PadInput, (message: PadInputMessage) => toAda.push(message));
    bob.onMessage(Msg.PadInput, (message: PadInputMessage) => toBob.push(message));

    pad.send(Msg.PadInput, [0.5, 1, 0, 1]);
    pad.send(Msg.PadInput, [9, -4, 2, 0]); // out of range → clamped
    pad.send(Msg.PadInput, ['left', 1, 0, 0]); // junk → dropped
    pad.send(Msg.PadInput, { steer: 1 }); // junk → dropped
    await until(() => toAda.length >= 2, 'forwarded input');
    await sleep(80);
    expect(toAda).toEqual([
      [0.5, 1, 0, 1],
      [1, 0, 1, 0],
    ]);
    expect(toBob).toEqual([]);

    // A display cannot pose as a pad.
    bob.send(Msg.PadInput, [1, 1, 0, 0]);
    await sleep(80);
    expect(toAda).toHaveLength(2);

    // Haptics travel the other way, to the paired phone only.
    const buzz = nextMessage<{ ms: number }>(pad, Msg.Haptic);
    ada.send(Msg.Haptic, { ms: 5000 });
    expect((await buzz).ms).toBe(200);
  });

  it('allows one phone per car, rejects bad links, and lets the phone come back', async () => {
    const ada = await create('Ada');
    const token = await padToken(ada);

    expect((await rejection(sdk().joinById(ada.roomId, { role: 'pad', token: 'nope' }))).code).toBe(JoinError.BadPadToken);

    const pad = await joinPad(ada.roomId, token);
    await until(() => ada.state.players.get(ada.sessionId)!.pad === true, 'pad flag');
    expect((await rejection(sdk().joinById(ada.roomId, { role: 'pad', token }))).code).toBe(JoinError.PadAlreadyConnected);

    await pad.leave();
    await until(() => ada.state.players.get(ada.sessionId)!.pad === false, 'pad to unbind');
    const again = await joinPad(ada.roomId, token);
    await until(() => ada.state.players.get(ada.sessionId)!.pad === true, 'pad to rebind');

    // When the player goes, their phone is disconnected too.
    const kicked = new Promise<void>((resolve) => again.onLeave(() => resolve()));
    await ada.leave();
    await kicked;
  });
});

describe('race', () => {
  const path = buildTrackPath(TRACKS[0]!);

  /** Reports a car driving the centre line from `from` to `to` metres, 3 m per update. */
  async function drive(room: GameRoom, from: number, to: number) {
    for (let d = from; d <= to; d += 3) {
      const p = pointOnTrack(path, d);
      room.send(Msg.Transform, [p.x, 0.66, p.z, 0, Math.sin(p.heading / 2), 0, Math.cos(p.heading / 2), 40, 0]);
      if (Math.round(d) % 90 === 0) await sleep(2);
    }
    await sleep(40);
  }

  it('runs lobby → countdown → race → results → rematch with server-decided positions', async () => {
    const ada = await create('Ada', { laps: 1, maxPlayers: 3 });
    const bob = await join(ada.roomId, 'Bob');
    await until(() => ada.state.players.size === 2, 'both players');
    const me = (room: GameRoom) => room.state.players.get(room.sessionId)!;

    // Not everyone is ready: start is ignored. A guest cannot start at all.
    ada.send(Msg.Start);
    bob.send(Msg.Start);
    await sleep(120);
    expect(ada.state.phase).toBe('lobby');

    bob.send(Msg.Ready);
    await until(() => me(bob).ready, 'bob ready');
    const countdown = nextMessage<{ ms: number }>(bob, Msg.Countdown);
    ada.send(Msg.Start);
    expect((await countdown).ms).toBe(4000);
    await until(() => ada.state.phase === 'countdown', 'countdown');

    // Grid: different slots, placed behind the line.
    expect(me(ada).slot).not.toBe(me(bob).slot);
    expect(Math.hypot(me(ada).x - me(bob).x, me(ada).z - me(bob).z)).toBeGreaterThan(3);

    // Nobody can walk in once it has started, and the room is no longer listed.
    expect((await rejection(sdk().joinById(ada.roomId, { role: 'player', name: 'Late' }))).code).toBe(JoinError.RaceInProgress);
    expect((await listing()).map((room) => room.code)).not.toContain(ada.roomId);

    // Jumping the start earns nothing.
    await drive(ada, -10, 60);
    expect(me(ada).count).toBe(0);

    await until(() => ada.state.phase === 'racing', 'green light', 6000);

    // Bob gets half a lap ahead; positions follow.
    await drive(ada, -10, 200);
    await drive(bob, -10, 600);
    await until(() => me(bob).place === 1 && me(ada).place === 2, 'bob to lead');

    // Ada cuts straight to the finish straight: no credit, still second.
    await drive(ada, path.length - 40, path.length + 5);
    await sleep(300);
    expect(me(ada).finished).toBe(false);
    expect(me(ada).place).toBe(2);

    // Bob completes the lap properly and wins; the race stays open for Ada.
    await drive(bob, 600, path.length + 5);
    await until(() => me(bob).finished, 'bob to finish');
    expect(me(bob).place).toBe(1);
    expect(me(bob).finishTime).toBeGreaterThan(0);
    expect(ada.state.phase).toBe('racing');

    // Ada drives the lap for real.
    await drive(ada, 200, path.length + 5);
    await until(() => ada.state.phase === 'finished', 'race to end');
    expect(me(ada).finished).toBe(true);
    expect(me(ada).place).toBe(2);
    expect(me(ada).finishTime).toBeGreaterThanOrEqual(me(bob).finishTime);

    // Only the host can call a rematch; it returns everyone to a clean lobby.
    bob.send(Msg.Rematch);
    await sleep(120);
    expect(ada.state.phase).toBe('finished');
    ada.send(Msg.Rematch);
    await until(() => bob.state.phase === 'lobby', 'lobby again');
    expect(me(bob)).toMatchObject({ finished: false, place: 0, ready: false, count: 0 });
  }, 30_000);

  it('ends the race if the only driver still out there leaves', async () => {
    const ada = await create('Ada', { laps: 1 });
    const bob = await join(ada.roomId, 'Bob');
    await until(() => ada.state.players.size === 2, 'both players');
    bob.send(Msg.Ready);
    await until(() => ada.state.players.get(bob.sessionId)!.ready, 'bob ready');
    ada.send(Msg.Start);
    await until(() => ada.state.phase === 'racing', 'green light', 6000);
    await drive(ada, -10, path.length + 5);
    await until(() => ada.state.players.get(ada.sessionId)!.finished, 'ada to finish');
    expect(ada.state.phase).toBe('racing');
    await bob.leave();
    await until(() => ada.state.phase === 'finished', 'race to end');
  }, 30_000);
});
