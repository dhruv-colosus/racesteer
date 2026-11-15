import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME, type RoomListing, type RoomMetadata } from '@racing/shared';
import { RaceRoom } from './rooms/RaceRoom';

/** Public rooms that can still be joined: in the lobby, with a free seat. */
export async function openRooms(): Promise<RoomListing[]> {
  const rooms = await matchMaker.query({ name: ROOM_NAME, private: false });
  const listings: RoomListing[] = [];
  for (const room of rooms) {
    const meta = room.metadata as RoomMetadata | undefined;
    if (!meta || meta.phase !== 'lobby' || meta.players >= meta.maxPlayers) continue;
    listings.push({
      code: room.roomId,
      roomName: meta.roomName,
      players: meta.players,
      maxPlayers: meta.maxPlayers,
      laps: meta.laps,
    });
  }
  return listings;
}

export async function startServer(port: number): Promise<Server> {
  const server = new Server({
    greet: false,
    transport: new WebSocketTransport(),
    express: (app) => {
      app.get('/api/rooms', async (_request, response) => {
        try {
          response.json(await openRooms());
        } catch {
          response.status(500).json({ error: 'could not list rooms' });
        }
      });
      app.get('/api/health', (_request, response) => {
        response.json({ ok: true });
      });
    },
  });
  server.define(ROOM_NAME, RaceRoom);
  await server.listen(port);
  return server;
}
