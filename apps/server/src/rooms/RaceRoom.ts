import { randomBytes } from 'node:crypto';
import { Room, ServerError, matchMaker, type Client, type Delayed } from '@colyseus/core';
import {
  COUNTDOWN_MS,
  CAR_COLORS,
  FINISH_GRACE_MS,
  JoinError,
  LOBBY_HOLD_SECONDS,
  MAX_PLAYERS_LIMIT,
  Msg,
  PAD_REPLACED,
  PAD_TOKEN_PATTERN,
  PATCH_RATE_MS,
  RACE_HOLD_SECONDS,
  TRACKS,
  advanceProgress,
  buildTrackPath,
  decodePadInput,
  encodePadInput,
  generateRoomCode,
  gridSlot,
  isFinished,
  isRoomCode,
  newProgress,
  projectOnTrack,
  raceScore,
  rankPlayers,
  sanitizeName,
  sanitizeSettings,
  uniqueName,
  sectorOf,
  type JoinOptions,
  type Phase,
  type RaceProgress,
  type RoomMetadata,
  type RoomSettings,
  type SyncMessage,
  type TrackPath,
} from '@racing/shared';
import { Player, RaceState } from './schema';

/** Ride height the cars sit at on the grid — only cosmetic until the first real transform arrives. */
const GRID_HEIGHT = 0.66;

interface Tracking {
  progress: RaceProgress;
  hint: number;
  s: number;
}

/**
 * One race room. Each display simulates its own car and reports where it is;
 * the room relays that to everyone else and decides everything that affects
 * the result: phases, lap validation, positions and finish times.
 *
 * Phones join the same room as "pads". They are not players: a pad is bound
 * to one player by a token and its input is forwarded straight to that
 * player's display.
 */
export class RaceRoom extends Room<{ state: RaceState; metadata: RoomMetadata }> {
  private path!: TrackPath;
  private readonly tracking = new Map<string, Tracking>();
  /** pad token → player session */
  private readonly padTokens = new Map<string, string>();
  /** player session → its pad token */
  private readonly tokenOf = new Map<string, string>();
  /** player session → connected pad */
  private readonly padOf = new Map<string, Client>();
  /** pad session → player session */
  private readonly playerOfPad = new Map<string, string>();
  private startedAt = 0;
  private countdownAt = 0;
  private startTimer?: Delayed;
  private graceTimer?: Delayed;

  async onCreate(options: unknown) {
    // Pads share the room with players, so the transport limit is twice the player limit.
    this.maxClients = MAX_PLAYERS_LIMIT * 2;
    this.patchRate = PATCH_RATE_MS;
    this.roomId = await this.claimCode((options as { code?: unknown } | null)?.code);

    const settings = sanitizeSettings(options);
    const practice = (options as { practice?: unknown } | null)?.practice === true;
    if (practice) {
      // Solo practice: one seat, never listed. The room only pairs and relays a phone.
      settings.isPrivate = true;
      settings.maxPlayers = 1;
    }
    const track = TRACKS[0]!;
    this.path = buildTrackPath(track);
    this.state = new RaceState().assign({
      phase: 'lobby',
      practice,
      roomName: settings.roomName,
      maxPlayers: settings.maxPlayers,
      isPrivate: settings.isPrivate,
      laps: settings.laps,
      trackId: track.id,
      hostId: '',
    });
    await this.setPrivate(settings.isPrivate);
    this.publish();

    this.onMessage(Msg.Transform, (client, message) => this.onTransform(client, message));
    this.onMessage(Msg.PadInput, (client, message) => this.onPadInput(client, message));
    this.onMessage(Msg.PadToken, (client) => this.sendPadToken(client));
    this.onMessage(Msg.Haptic, (client, message) => this.onHaptic(client, message));
    this.onMessage(Msg.Ready, (client) => this.onReady(client));
    this.onMessage(Msg.Rename, (client, message) => this.onRename(client, message));
    this.onMessage(Msg.Settings, (client, message) => this.onSettings(client, message));
    this.onMessage(Msg.Start, (client) => this.onStart(client));
    this.onMessage(Msg.Rematch, (client) => this.onRematch(client));
    this.onMessage(Msg.Sync, (client) => this.sendSync(client));

    this.clock.setInterval(() => {
      if (this.state.phase === 'racing') this.updatePlaces();
    }, 250);
  }

  /** A fault in one handler must not take the room, or the server, down with it. */
  onUncaughtException(error: Error, method: string) {
    console.error(`[room ${this.roomId}] error in ${method}:`, error);
  }

  /** A client bringing a room back after a server restart asks for the code everyone already has. */
  private async claimCode(requested: unknown): Promise<string> {
    if (typeof requested !== 'string' || !isRoomCode(requested)) return this.uniqueCode();
    if ((await matchMaker.query({ roomId: requested })).length > 0) {
      throw new ServerError(JoinError.CodeTaken, 'room code is in use');
    }
    return requested;
  }

  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = generateRoomCode();
      if ((await matchMaker.query({ roomId: code })).length === 0) return code;
    }
    throw new ServerError(500, 'could not allocate a room code');
  }

  private get phase(): Phase {
    return this.state.phase as Phase;
  }

  private settings(): RoomSettings {
    const { roomName, maxPlayers, isPrivate, laps } = this.state;
    return { roomName, maxPlayers, isPrivate, laps };
  }

  /** Tells the matchmaker what the public room list should show. */
  private publish() {
    const { roomName, maxPlayers, laps, phase, players } = this.state;
    void this.setMetadata({ roomName, players: players.size, maxPlayers, laps, phase }).catch(() => {});
  }

  // ---- joining and leaving -------------------------------------------------

  onJoin(client: Client, options?: JoinOptions) {
    if (options?.role === 'pad') {
      this.joinPad(client, String(options.token ?? ''));
      return;
    }

    if (this.phase !== 'lobby') throw new ServerError(JoinError.RaceInProgress, 'race in progress');
    if (this.state.players.size >= this.state.maxPlayers) throw new ServerError(JoinError.RoomFull, 'room is full');

    const taken = new Set<number>();
    this.state.players.forEach((player) => taken.add(player.color));
    let color = 0;
    while (taken.has(color) && color < CAR_COLORS.length - 1) color++;

    this.state.players.set(
      client.sessionId,
      new Player().assign({
        name: this.freeName(sanitizeName(options?.name)),
        color,
        ready: false,
        pad: false,
        connected: true,
        slot: 0,
        x: 0,
        y: GRID_HEIGHT,
        z: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        speed: 0,
        steer: 0,
        count: 0,
        score: 0,
        place: 0,
        finished: false,
        finishTime: 0,
      }),
    );
    if (!this.state.hostId) this.state.hostId = client.sessionId;

    // Keep the token this display had before if it can, so its phone stays paired.
    const wanted = options?.padToken;
    const token =
      typeof wanted === 'string' && PAD_TOKEN_PATTERN.test(wanted) && !this.padTokens.has(wanted)
        ? wanted
        : randomBytes(9).toString('base64url');
    this.padTokens.set(token, client.sessionId);
    this.tokenOf.set(client.sessionId, token);
    this.publish();
  }

  private joinPad(client: Client, token: string) {
    const playerId = this.padTokens.get(token);
    if (!playerId || !this.state.players.has(playerId)) {
      throw new ServerError(JoinError.BadPadToken, 'controller link is not valid');
    }
    // The link is the key, so the newest phone to use it wins. This is what lets a
    // phone that reloaded or lost signal walk straight back in, even if the server
    // has not yet noticed its old connection is dead.
    const previous = this.padOf.get(playerId);
    if (previous) {
      this.playerOfPad.delete(previous.sessionId);
      previous.leave(PAD_REPLACED);
    }
    this.padOf.set(playerId, client);
    this.playerOfPad.set(client.sessionId, playerId);
    this.state.players.get(playerId)!.pad = true;
    client.send(Msg.PadBound, { playerId });
  }

  /** A connection dropped without saying goodbye: hold the seat for a moment in case it comes back. */
  onDrop(client: Client) {
    // A join we refused also arrives here; it never had a seat to hold.
    // Phones are not held either: they rejoin with their link, which is quicker than waiting out a hold.
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    try {
      const hold = this.phase === 'lobby' ? LOBBY_HOLD_SECONDS : RACE_HOLD_SECONDS;
      // Rejects when the hold runs out; onLeave then clears the seat.
      this.allowReconnection(client, hold).catch(() => {});
      player.connected = false;
    } catch {
      // Not eligible (never fully joined): onLeave runs straight away instead.
    }
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (player) player.connected = true;
  }

  onLeave(client: Client) {
    const padPlayer = this.playerOfPad.get(client.sessionId);
    if (padPlayer !== undefined) {
      this.playerOfPad.delete(client.sessionId);
      // Only unbind if this is still the pad on record for that player.
      if (this.padOf.get(padPlayer) === client) {
        this.padOf.delete(padPlayer);
        const player = this.state.players.get(padPlayer);
        if (player) player.pad = false;
      }
      return;
    }

    if (!this.state.players.has(client.sessionId)) return;
    this.state.players.delete(client.sessionId);
    this.tracking.delete(client.sessionId);

    const token = this.tokenOf.get(client.sessionId);
    if (token) this.padTokens.delete(token);
    this.tokenOf.delete(client.sessionId);
    const pad = this.padOf.get(client.sessionId);
    if (pad) {
      this.padOf.delete(client.sessionId);
      this.playerOfPad.delete(pad.sessionId);
      pad.leave();
    }

    if (this.state.hostId === client.sessionId) {
      this.state.hostId = this.state.players.keys().next().value ?? '';
    }
    if (this.state.players.size === 0) {
      // Nobody left to race; the room disposes itself once the last connection is gone.
      this.startTimer?.clear();
      this.graceTimer?.clear();
      return;
    }
    if (this.phase === 'racing') this.checkRaceOver();
    this.publish();
  }

  // ---- lobby ---------------------------------------------------------------

  private isHost(client: Client) {
    return client.sessionId === this.state.hostId;
  }

  private onReady(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.phase !== 'lobby') return;
    player.ready = !player.ready;
  }

  /** Names in use by everyone except `except`. */
  private freeName(name: string, except?: string): string {
    const taken: string[] = [];
    this.state.players.forEach((player, id) => {
      if (id !== except) taken.push(player.name);
    });
    return uniqueName(name, taken);
  }

  private onRename(client: Client, message: unknown) {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.phase !== 'lobby') return;
    const raw = (message as { name?: unknown } | null)?.name;
    if (typeof raw !== 'string' || !raw.trim()) return;
    player.name = this.freeName(sanitizeName(raw), client.sessionId);
  }

  private onSettings(client: Client, message: unknown) {
    if (!this.isHost(client) || this.phase !== 'lobby' || this.state.practice) return;
    const next = sanitizeSettings(message, this.settings());
    // Never shrink the room below the people already in it.
    next.maxPlayers = Math.max(next.maxPlayers, this.state.players.size);
    const visibilityChanged = next.isPrivate !== this.state.isPrivate;
    this.state.assign(next);
    if (visibilityChanged) void this.setPrivate(next.isPrivate).catch(() => {});
    this.publish();
  }

  private onStart(client: Client) {
    if (!this.isHost(client) || this.phase !== 'lobby' || this.state.practice) return;
    let everyoneReady = true;
    this.state.players.forEach((player, id) => {
      if (id !== this.state.hostId && !player.ready) everyoneReady = false;
    });
    if (!everyoneReady) return;
    this.startRace();
  }

  private onRematch(client: Client) {
    if (!this.isHost(client) || this.phase !== 'finished') return;
    this.state.players.forEach((player) => {
      player.assign({ ready: false, place: 0, finished: false, finishTime: 0, count: 0, score: 0, speed: 0 });
    });
    this.tracking.clear();
    this.state.phase = 'lobby';
    this.publish();
  }

  // ---- pads ----------------------------------------------------------------

  private sendPadToken(client: Client) {
    const token = this.tokenOf.get(client.sessionId);
    if (token) client.send(Msg.PadToken, { token });
  }

  /** Tells a display that has just (re)joined where the race stands, so it can pick it back up. */
  private sendSync(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const now = Date.now();
    const goInMs =
      this.phase === 'countdown' ? this.countdownAt + COUNTDOWN_MS - now : this.phase === 'racing' ? this.startedAt - now : null;
    const sync: SyncMessage = {
      phase: this.phase,
      goInMs,
      count: this.tracking.get(client.sessionId)?.progress.count ?? 0,
      finished: player.finished,
      x: player.x,
      z: player.z,
    };
    client.send(Msg.Sync, sync);
  }

  private onPadInput(client: Client, message: unknown) {
    const playerId = this.playerOfPad.get(client.sessionId);
    if (playerId === undefined) return;
    const input = decodePadInput(message);
    if (!input) return;
    this.clients.get(playerId)?.send(Msg.PadInput, encodePadInput(input));
  }

  private onHaptic(client: Client, message: unknown) {
    const pad = this.padOf.get(client.sessionId);
    const ms = Number((message as { ms?: unknown } | null)?.ms);
    if (!pad || !Number.isFinite(ms)) return;
    pad.send(Msg.Haptic, { ms: Math.min(200, Math.max(10, Math.round(ms))) });
  }

  // ---- racing --------------------------------------------------------------

  private startRace() {
    let slot = 0;
    this.tracking.clear();
    this.state.players.forEach((player, id) => {
      const grid = gridSlot(this.path, slot);
      player.assign({
        slot,
        ready: false,
        x: grid.x,
        y: grid.y + GRID_HEIGHT,
        z: grid.z,
        qx: 0,
        qy: Math.sin(grid.heading / 2),
        qz: 0,
        qw: Math.cos(grid.heading / 2),
        speed: 0,
        steer: 0,
        count: 0,
        score: 0,
        place: 0,
        finished: false,
        finishTime: 0,
      });
      this.tracking.set(id, { progress: newProgress(), hint: -1, s: 0 });
      slot++;
    });

    this.state.phase = 'countdown';
    this.countdownAt = Date.now();
    this.broadcast(Msg.Countdown, { ms: COUNTDOWN_MS });
    this.startTimer?.clear();
    this.graceTimer?.clear();
    this.graceTimer = undefined;
    this.startTimer = this.clock.setTimeout(() => {
      this.startedAt = Date.now();
      this.state.phase = 'racing';
      this.publish();
    }, COUNTDOWN_MS);
    this.publish();
  }

  private onTransform(client: Client, message: unknown) {
    const player = this.state.players.get(client.sessionId);
    if (!player || this.phase === 'lobby') return;
    if (!Array.isArray(message) || message.length !== 9) return;
    for (const value of message) if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const [x, y, z, qx, qy, qz, qw, speed, steer] = message as number[];
    player.assign({ x, y, z, qx, qy, qz, qw, speed, steer });

    const tracked = this.tracking.get(client.sessionId);
    if (this.phase !== 'racing' || player.finished || !tracked) return;

    const sectors = this.path.def.sectors;
    const projection = projectOnTrack(this.path, x!, z!, tracked.hint);
    tracked.hint = projection.index;
    tracked.s = projection.s;
    advanceProgress(tracked.progress, sectorOf(projection.s, this.path.length, sectors), sectors);
    player.count = tracked.progress.count;
    player.score = raceScore(tracked.progress.count, projection.s, this.path.length, sectors);

    if (isFinished(tracked.progress.count, this.state.laps, sectors)) {
      player.finished = true;
      player.finishTime = Date.now() - this.startedAt;
      this.updatePlaces();
      this.checkRaceOver();
    }
  }

  private updatePlaces() {
    const entries: { id: string; finished: boolean; finishTime: number; score: number }[] = [];
    this.state.players.forEach((player, id) => {
      entries.push({ id, finished: player.finished, finishTime: player.finishTime, score: player.score });
    });
    rankPlayers(entries).forEach((id, index) => {
      const player = this.state.players.get(id)!;
      if (player.place !== index + 1) player.place = index + 1;
    });
  }

  /** Ends the race when everyone is home, or starts the clock on the stragglers once the first car is. */
  private checkRaceOver() {
    let finished = 0;
    this.state.players.forEach((player) => {
      if (player.finished) finished++;
    });
    if (finished === 0) return;
    if (finished >= this.state.players.size) {
      this.endRace();
    } else if (!this.graceTimer) {
      this.graceTimer = this.clock.setTimeout(() => this.endRace(), FINISH_GRACE_MS);
    }
  }

  private endRace() {
    if (this.phase !== 'racing') return;
    this.graceTimer?.clear();
    this.graceTimer = undefined;
    this.updatePlaces();
    this.state.phase = 'finished';
    this.publish();
  }
}
