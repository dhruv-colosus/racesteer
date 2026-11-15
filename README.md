# Tilt Rush

Multiplayer 3D arcade racer for the browser. The big screen shows the race; your phone is the steering wheel.

"Tilt Rush" is a working title — it appears in `apps/client/index.html` and `apps/client/src/screens/Home.tsx`.

## Run it

```bash
pnpm install
```

```bash
pnpm dev
```

That starts three things:

| What | Where | For |
|---|---|---|
| Game server (rooms) | `localhost:2567` | Colyseus; the two web servers proxy to it under `/colyseus` |
| Display | `http://localhost:5173` | Open this on the computer or TV |
| Phone / LAN | `https://<your-ip>:5174` | What phones and other players on your Wi-Fi open |

Open `http://localhost:5173`, create a room, and scan the QR code in the lobby with your phone.

**First time on a phone:** the LAN server uses a self-signed certificate (motion sensors only work over HTTPS), so the phone shows a warning once — choose to proceed. On iPhone, tap **Tap to connect** and allow motion access when asked. The phone must be on the same Wi-Fi as the computer.

No phone handy: WASD or arrow keys drive, Shift or Space boosts, R resets the car, M mutes.

## Checks

```bash
pnpm test
```

```bash
pnpm typecheck
```

`pnpm test` covers the shared lap/track/tilt logic and runs the room server end to end over real WebSockets (create/join, public/private, player limit, phone pairing, a full race and rematch).

## Layout

```
apps/client     Vite + React + Three.js
  src/game      engine: loop, Rapier car physics, track scene, camera, remote-car interpolation
  src/ui        HUD, banner, race stage
  src/screens   home, lobby/race/results, solo practice
  src/pad       phone controller page
apps/server     Colyseus room server
  src/rooms     RaceRoom (phases, lap validation, positions, pad relay) and its state schema
packages/shared track data + path maths, lap rules, tilt mapping, message protocol
```

## How it fits together

- Each display simulates **its own car** (no input lag) and reports its transform 20 times a second. Other cars are drawn 100 ms in the past, blended between snapshots.
- The server decides everything that affects the result: phases, lap validation by sector order, live positions, finish times.
- A phone joins the same room as a **pad**, bound to one player by a token in the QR link. Its input is forwarded straight to that player's display. One phone per car; if it drops it can reconnect with the same link.
- A track is data (`packages/shared/src/track.ts`): control points and a width. Road, kerbs, barriers, colliders, sectors, start grid and minimap are all generated from it.
- Handling numbers live in `apps/client/src/game/config.ts`.

## Not built yet

- Blender/glTF car models and scenery (cars are box placeholders: `apps/client/src/game/carMesh.ts`)
- More tracks, elevation
- Direct phone↔display WebRTC input (currently relayed through the server)
- Production deployment (static client + a long-running Node host for the room server)
