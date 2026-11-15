import { schema, t, type SchemaType } from '@colyseus/schema';

/** Synced to every client in the room. Field meanings are documented on PlayerState in @racing/shared. */
export const Player = schema(
  {
    name: t.string(),
    color: t.uint8(),
    ready: t.boolean(),
    pad: t.boolean(),
    connected: t.boolean(),
    slot: t.uint8(),
    x: t.float32(),
    y: t.float32(),
    z: t.float32(),
    qx: t.float32(),
    qy: t.float32(),
    qz: t.float32(),
    qw: t.float32(),
    speed: t.float32(),
    steer: t.float32(),
    count: t.uint16(),
    score: t.float32(),
    place: t.uint8(),
    finished: t.boolean(),
    finishTime: t.uint32(),
  },
  'Player',
);
export type Player = SchemaType<typeof Player>;

export const RaceState = schema(
  {
    phase: t.string(),
    practice: t.boolean(),
    roomName: t.string(),
    maxPlayers: t.uint8(),
    isPrivate: t.boolean(),
    laps: t.uint8(),
    trackId: t.string(),
    hostId: t.string(),
    players: t.map(Player),
  },
  'RaceState',
);
export type RaceState = SchemaType<typeof RaceState>;
