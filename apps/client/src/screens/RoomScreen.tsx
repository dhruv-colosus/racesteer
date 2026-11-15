import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  CAR_COLORS,
  LAP_OPTIONS,
  MAX_PLAYERS_LIMIT,
  MIN_MAX_PLAYERS,
  Msg,
  NAME_MAX_LENGTH,
  decodePadInput,
  formatRaceTime,
  ordinal,
  sanitizeName,
  type Phase,
  type RaceStateLike,
  type RoomSettings,
  type SyncMessage,
  type TransformMessage,
} from '@racing/shared';
import { describeJoinError, joinRoom, loadName, saveName, takeRoom, type GameRoom } from '../net/client';
import { CloseCode } from '@colyseus/sdk';
import { RejoinRefused, clearSession, forgetToken, isCrashing, loadSession, rejoin, saveSession } from '../net/session';
import { lanRoomLink, onTunnel, roomLink } from '../net/links';
import { useLatency } from '../net/useLatency';
import { navigate } from '../router';
import { PhoneCard } from '../ui/PhoneCard';
import { PingBadge } from '../ui/PingBadge';
import { RaceStage, type StageHandle } from '../ui/RaceStage';

interface Driver {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  pad: boolean;
  connected: boolean;
  slot: number;
  place: number;
  finished: boolean;
  finishTime: number;
}

/** The slow-changing part of room state. React re-renders only when this changes, not on every car movement. */
interface Snapshot {
  phase: Phase;
  roomName: string;
  maxPlayers: number;
  isPrivate: boolean;
  laps: number;
  trackId: string;
  hostId: string;
  drivers: Driver[];
}

function snapshotOf(state: RaceStateLike | undefined): Snapshot | null {
  if (!state?.phase || !state.players) return null;
  const drivers: Driver[] = [];
  state.players.forEach((player, id) => {
    drivers.push({
      id,
      name: player.name,
      color: CAR_COLORS[player.color] ?? CAR_COLORS[0],
      ready: player.ready,
      pad: player.pad,
      connected: player.connected !== false,
      slot: player.slot,
      place: player.place,
      finished: player.finished,
      finishTime: player.finishTime,
    });
  });
  return {
    phase: state.phase as Phase,
    roomName: state.roomName,
    maxPlayers: state.maxPlayers,
    isPrivate: state.isPrivate,
    laps: state.laps,
    trackId: state.trackId,
    hostId: state.hostId,
    drivers,
  };
}

type Link = 'live' | 'dropped' | 'recovering';

export function RoomScreen({ code }: { code: string }) {
  const [room, setRoom] = useState<GameRoom | null>(() => takeRoom(code));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  /** live: connected. dropped: the socket died and is being re-established. recovering: rejoining from scratch. */
  const [link, setLink] = useState<Link>(() => (room === null && loadSession(code) ? 'recovering' : 'live'));
  const [gone, setGone] = useState<string | null>(null);
  const [padToken, setPadToken] = useState<string | null>(null);
  const [goAt, setGoAt] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const stage = useRef<StageHandle | null>(null);
  const lastHaptic = useRef(0);
  const alive = useRef(true);
  const recovering = useRef(false);
  /** The game was just (re)built and has not yet been told where the race stands. */
  const freshStage = useRef(false);
  const latency = useLatency(room, link === 'live');
  /** Hold our transforms back until the server's answer has put the car in the right place. */
  const awaitingSync = useRef(false);

  /**
   * Gets back into the room after the connection is properly gone: a reload,
   * a crash, a long network outage or a server restart. Reclaims the old seat
   * if the server still holds it, otherwise rejoins, otherwise recreates the room.
   */
  const recover = useCallback(async () => {
    if (recovering.current) return;
    recovering.current = true;
    setGone(null);
    setLink('recovering');
    try {
      const next = await rejoin(() => loadSession(code), { cancelled: () => !alive.current });
      setRoom(next);
      setLink('live');
    } catch (cause) {
      if (!alive.current) return;
      setGone(
        cause instanceof RejoinRefused
          ? cause.message
          : 'Could not get back to the room. Check your connection and that the game server is running.',
      );
    } finally {
      recovering.current = false;
    }
  }, [code]);

  useEffect(() => {
    alive.current = true;
    // A saved session but no live room means this page was reloaded mid-session: go straight back in.
    if (!room && loadSession(code)) void recover();
    return () => {
      alive.current = false;
      // Leaving on purpose forgets the seat. A crash-reload keeps it.
      if (!isCrashing()) clearSession(code);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  /** Pushes everyone else's latest transform into the running game. */
  const feedRemotes = useCallback(
    (state: RaceStateLike | undefined) => {
      const game = stage.current?.game;
      if (!game || !room || !state?.players) return;
      const now = performance.now();
      const seen = new Set<string>();
      state.players.forEach((player, id) => {
        if (id === room.sessionId) return;
        seen.add(id);
        game.pushRemote(id, player.name, CAR_COLORS[player.color] ?? CAR_COLORS[0], now, player);
      });
      for (const id of game.remoteIds()) if (!seen.has(id)) game.removeRemote(id);
    },
    [room],
  );

  useEffect(() => {
    if (!room) return;
    let closed = false;
    saveSession(code, { code, token: room.reconnectionToken });

    let lastJson = '';
    const sync = (state: RaceStateLike) => {
      feedRemotes(state);
      const next = snapshotOf(state);
      if (!next) return;
      const json = JSON.stringify(next);
      if (json === lastJson) return;
      lastJson = json;
      setSnapshot(next);
      const me = next.drivers.find((driver) => driver.id === room.sessionId);
      if (me) {
        const { roomName, maxPlayers, isPrivate, laps } = next;
        saveSession(code, { code, name: me.name, settings: { roomName, maxPlayers, isPrivate, laps } });
      }
    };
    room.onStateChange(sync);
    if (room.state) sync(room.state);

    const offToken = room.onMessage(Msg.PadToken, (message: { token: string }) => {
      setPadToken(message.token);
      saveSession(code, { code, padToken: message.token });
    });
    const offCountdown = room.onMessage(Msg.Countdown, (message: { ms: number }) => setGoAt(performance.now() + message.ms));
    const offSync = room.onMessage(Msg.Sync, (message: SyncMessage) => {
      awaitingSync.current = false;
      if (message.goInMs === null) return;
      // Same clock the countdown message sets; only move it if it is actually off (we missed the countdown).
      const at = performance.now() + message.goInMs;
      setGoAt((current) => (current !== null && Math.abs(current - at) < 250 ? current : at));
      if (freshStage.current && stage.current && message.phase === 'racing') {
        stage.current.game.resume(message.x, message.z, message.count, message.finished);
      }
      freshStage.current = false;
    });
    const offPad = room.onMessage(Msg.PadInput, (message: unknown) => {
      const input = decodePadInput(message);
      if (input) stage.current?.input.setPadInput(input);
    });

    // The socket died. The SDK re-establishes it by itself; just say so meanwhile.
    room.onDrop(() => {
      if (!closed) setLink('dropped');
    });
    room.onReconnect(() => {
      if (closed) return;
      saveSession(code, { code, token: room.reconnectionToken });
      setLink('live');
      room.send(Msg.Sync);
    });
    // The SDK gave up, or the server ended the connection.
    room.onLeave((closeCode) => {
      if (closed) return;
      if (closeCode === 4000) {
        clearSession(code);
        setGone('The room was closed.');
      } else {
        // The SDK's own retries were refused (or ran past any hold): the seat is gone, so go straight to rejoining.
        if (closeCode === CloseCode.FAILED_TO_RECONNECT) forgetToken(room.reconnectionToken);
        void recover();
      }
    });
    room.send(Msg.PadToken);
    room.send(Msg.Sync);

    return () => {
      closed = true;
      offToken();
      offCountdown();
      offSync();
      offPad();
      if (!isCrashing()) void room.leave().catch(() => {});
    };
  }, [room, code, feedRemotes, recover]);

  const phase = snapshot?.phase;
  useEffect(() => {
    if (phase === 'lobby') {
      setGoAt(null);
      setMenu(false);
      stage.current = null;
    }
  }, [phase]);

  const leave = () => navigate('/');

  if (gone) {
    return (
      <div className="center-screen">
        <div className="card">
          <h2 className="caps">Disconnected</h2>
          <p className="muted">{gone}</p>
          <div className="card-actions">
            {loadSession(code) && (
              <button className="btn btn--primary" onClick={() => void recover()}>
                Try again
              </button>
            )}
            <button className="btn" onClick={leave}>
              Back to menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!room) {
    if (link === 'recovering') return <div className="center-screen caps">Reconnecting to {code}…</div>;
    return <JoinGate code={code} onJoined={setRoom} />;
  }
  if (!snapshot) return <div className="center-screen caps">Joining {code}…</div>;

  const me = snapshot.drivers.find((driver) => driver.id === room.sessionId);
  if (!me) return <div className="center-screen caps">Joining {code}…</div>;
  const isHost = snapshot.hostId === room.sessionId;
  const netBanner = link !== 'live' && (
    <div className="net-banner caps" role="status">
      Connection lost — reconnecting…
    </div>
  );

  if (snapshot.phase === 'lobby') {
    return (
      <>
        <Lobby
          room={room}
          code={code}
          snapshot={snapshot}
          me={me}
          isHost={isHost}
          padToken={padToken}
          latency={latency}
          onLeave={leave}
        />
        {netBanner}
      </>
    );
  }

  const showResults = snapshot.phase === 'finished' || me.finished;
  return (
    <RaceStage
      trackId={snapshot.trackId}
      laps={snapshot.laps}
      color={me.color}
      slot={me.slot}
      goAt={goAt}
      place={me.place || me.slot + 1}
      total={snapshot.drivers.length}
      finalTimeMs={me.finished ? me.finishTime : null}
      onReady={(handle) => {
        stage.current = handle;
        feedRemotes(room.state);
        // Ask where the race stands: if it is already under way (reload, rebuilt stage) the car is put back in it.
        freshStage.current = true;
        awaitingSync.current = true;
        room.send(Msg.Sync);
      }}
      onNet={(transform: TransformMessage) => {
        if (!awaitingSync.current) room.send(Msg.Transform, transform);
      }}
      onImpact={(strength) => {
        const now = performance.now();
        if (!me.pad || now - lastHaptic.current < 250) return;
        lastHaptic.current = now;
        room.send(Msg.Haptic, { ms: 30 + strength * 90 });
      }}
      onPause={() => setMenu(true)}
    >
      <PingBadge ms={latency} className="ping--hud" />
      {netBanner}
      {showResults && (
        <Results
          snapshot={snapshot}
          meId={room.sessionId}
          isHost={isHost}
          onRematch={() => room.send(Msg.Rematch)}
          onLeave={leave}
        />
      )}
      {menu && !showResults && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">Menu</h2>
            <p className="muted">The race keeps running while this is open.</p>
            <div className="card-actions">
              <button className="btn btn--primary" onClick={() => setMenu(false)}>
                Resume
              </button>
              <button className="btn" onClick={leave}>
                Leave race
              </button>
            </div>
          </div>
        </div>
      )}
    </RaceStage>
  );
}

/**
 * Shown when someone arrives by link. With a name saved from before it joins
 * straight away; otherwise (or if that join fails) it asks for a name first.
 */
function JoinGate({ code, onJoined }: { code: string; onJoined(room: GameRoom): void }) {
  const [name, setName] = useState(loadName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Joining on our own with the saved name; the form stays hidden meanwhile. */
  const [auto, setAuto] = useState(() => loadName() !== '');
  const tried = useRef(false);

  const join = useCallback(
    async (who: string) => {
      setBusy(true);
      setError('');
      saveName(who);
      try {
        onJoined(await joinRoom(code, sanitizeName(who)));
      } catch (cause) {
        setError(describeJoinError(cause));
        setBusy(false);
        setAuto(false);
      }
    },
    [code, onJoined],
  );

  useEffect(() => {
    if (!auto || tried.current) return;
    tried.current = true;
    void join(loadName());
  }, [auto, join]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy) void join(name);
  };

  if (auto) return <div className="center-screen caps">Joining {code}…</div>;

  return (
    <div className="center-screen">
      <form className="card" onSubmit={submit}>
        <h2 className="caps">
          Join <span className="accent">{code}</span>
        </h2>
        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Driver"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <p className="toast caps" role="alert">
          {error}
        </p>
        <div className="card-actions">
          <button className="btn btn--primary" disabled={busy}>
            {busy ? 'Joining…' : 'Join race'}
          </button>
          <button type="button" className="btn" onClick={() => navigate('/')}>
            Back
          </button>
        </div>
      </form>
    </div>
  );
}

interface LobbyProps {
  room: GameRoom;
  code: string;
  snapshot: Snapshot;
  me: Driver;
  isHost: boolean;
  padToken: string | null;
  latency: number | null;
  onLeave(): void;
}

function Lobby({ room, code, snapshot, me, isHost, padToken, latency, onLeave }: LobbyProps) {
  const [copied, setCopied] = useState<'invite' | 'lan' | null>(null);
  const copy = async (which: 'invite' | 'lan', link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      window.prompt('Copy this link', link);
    }
  };
  // With `pnpm dev:tunnel` running, a laptop on the host's Wi-Fi is far better off
  // talking to the host directly than going out to Cloudflare and back.
  const lanLink = lanRoomLink(code);
  const switchToLan = () => {
    if (!lanLink) return;
    clearSession(code);
    window.location.assign(lanLink);
    // Give the seat up now, rather than leaving a "Reconnecting…" ghost in everyone's lobby.
    // Alone in the room, leaving would close it; dropping instead keeps it for the lobby hold.
    if (snapshot.drivers.length > 1) void room.leave().catch(() => {});
  };

  const change = (settings: Partial<RoomSettings>) => room.send(Msg.Settings, settings);
  const others = snapshot.drivers.filter((driver) => driver.id !== snapshot.hostId);
  const waitingOn = others.filter((driver) => !driver.ready).length;
  const openSeats = Math.max(0, snapshot.maxPlayers - snapshot.drivers.length);

  return (
    <main className="lobby">
      <header className="lobby-head">
        <div>
          <div className="caps muted">{snapshot.isPrivate ? 'Private room' : 'Public room'}</div>
          <h1 className="caps">{snapshot.roomName}</h1>
        </div>
        <div className="lobby-code">
          <PingBadge ms={latency} />
          <div className="slab slab--accent caps" aria-label={`Room code ${code}`}>
            {code}
          </div>
          {lanLink && (
            <button className="btn" onClick={() => void copy('lan', lanLink)} title={lanLink}>
              {copied === 'lan' ? 'Copied!' : 'Copy same Wi-Fi link'}
            </button>
          )}
          <button className="btn" onClick={() => void copy('invite', roomLink(code))} title={roomLink(code)}>
            {copied === 'invite' ? 'Copied!' : lanLink ? 'Copy any-network link' : 'Copy invite link'}
          </button>
        </div>
      </header>

      {lanLink && onTunnel() && (
        <div className="lan-hint" role="note">
          <p>
            <b className="caps">Same Wi-Fi as the host?</b> You came in through the internet tunnel, so every update
            travels out to Cloudflare and back. Switch to the direct link for a much lower ping.
          </p>
          <button className="btn btn--small" onClick={switchToLan} title={lanLink}>
            Switch to direct link
          </button>
        </div>
      )}

      <div className="lobby-grid">
        <section className="pane">
          <h2 className="caps">
            Drivers{' '}
            <span className="muted">
              {snapshot.drivers.length}/{snapshot.maxPlayers}
            </span>
          </h2>
          <ul className="driver-list">
            {snapshot.drivers.map((driver) => (
              <li className="driver" key={driver.id}>
                <span className="driver-swatch" style={{ background: driver.color }} />
                {driver.id === me.id ? (
                  <NameEditor name={driver.name} onRename={(name) => room.send(Msg.Rename, { name })} />
                ) : (
                  <span className="driver-name caps">{driver.name}</span>
                )}
                {driver.id === me.id && <span className="tag">You</span>}
                {!driver.connected && <span className="tag tag--warn">Reconnecting…</span>}
                {driver.pad && <span className="tag tag--cyan">Phone</span>}
                {driver.id === snapshot.hostId ? (
                  <span className="tag tag--accent">Host</span>
                ) : (
                  <span className={`tag${driver.ready ? ' tag--good' : ''}`}>{driver.ready ? 'Ready' : 'Not ready'}</span>
                )}
              </li>
            ))}
            {Array.from({ length: openSeats }, (_, i) => (
              <li className="driver driver--empty caps" key={`open-${i}`}>
                Open seat
              </li>
            ))}
          </ul>

          <div className="lobby-actions">
            {isHost ? (
              <button className="btn btn--primary" disabled={waitingOn > 0} onClick={() => room.send(Msg.Start)}>
                {waitingOn > 0 ? `Waiting on ${waitingOn}` : 'Start race'}
              </button>
            ) : (
              <button className={`btn${me.ready ? '' : ' btn--primary'}`} onClick={() => room.send(Msg.Ready)}>
                {me.ready ? 'Not ready' : 'Ready up'}
              </button>
            )}
            <button className="btn" onClick={onLeave}>
              Leave
            </button>
            {!isHost && <span className="muted">{me.ready ? 'Waiting for the host to start…' : 'Tell the host you are ready.'}</span>}
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <section className={`pane${me.pad ? ' phone--connected' : ''}`}>
            <h2 className="caps">{me.pad ? 'Phone connected' : 'Connect your phone'}</h2>
            <PhoneCard code={code} token={padToken} connected={me.pad} />
          </section>

          <section className="pane">
            <h2 className="caps">Race settings</h2>
            {isHost ? (
              <div className="settings">
                <div className="field">
                  <span>Max players</span>
                  <div className="stepper">
                    <button
                      className="btn btn--small"
                      aria-label="Fewer players"
                      disabled={snapshot.maxPlayers <= Math.max(MIN_MAX_PLAYERS, snapshot.drivers.length)}
                      onClick={() => change({ maxPlayers: snapshot.maxPlayers - 1 })}
                    >
                      −
                    </button>
                    <output className="caps">{snapshot.maxPlayers}</output>
                    <button
                      className="btn btn--small"
                      aria-label="More players"
                      disabled={snapshot.maxPlayers >= MAX_PLAYERS_LIMIT}
                      onClick={() => change({ maxPlayers: snapshot.maxPlayers + 1 })}
                    >
                      +
                    </button>
                  </div>
                </div>
                <div className="field">
                  <span>Laps</span>
                  <div className="segmented">
                    {LAP_OPTIONS.map((option) => (
                      <button
                        key={option}
                        className={`btn btn--small${snapshot.laps === option ? ' btn--primary' : ''}`}
                        aria-pressed={snapshot.laps === option}
                        onClick={() => change({ laps: option })}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>Visibility</span>
                  <div className="segmented">
                    <button
                      className={`btn btn--small${!snapshot.isPrivate ? ' btn--primary' : ''}`}
                      aria-pressed={!snapshot.isPrivate}
                      onClick={() => change({ isPrivate: false })}
                    >
                      Public
                    </button>
                    <button
                      className={`btn btn--small${snapshot.isPrivate ? ' btn--primary' : ''}`}
                      aria-pressed={snapshot.isPrivate}
                      onClick={() => change({ isPrivate: true })}
                    >
                      Private
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="settings">
                <div className="field">
                  <span>Max players</span>
                  <div className="setting-value caps">{snapshot.maxPlayers}</div>
                </div>
                <div className="field">
                  <span>Laps</span>
                  <div className="setting-value caps">{snapshot.laps}</div>
                </div>
                <div className="field">
                  <span>Visibility</span>
                  <div className="setting-value caps">{snapshot.isPrivate ? 'Private' : 'Public'}</div>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/** Your own name in the lobby list: click it (or the pencil) to change it. */
function NameEditor({ name, onRename }: { name: string; onRename(name: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const open = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const clean = draft.trim();
    if (!clean || clean === name) return;
    saveName(clean);
    onRename(clean);
  };

  if (editing) {
    return (
      <form
        className="driver-name"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
      >
        <input
          className="input input--name"
          value={draft}
          maxLength={NAME_MAX_LENGTH}
          aria-label="Your driver name"
          autoFocus
          onFocus={(event) => event.target.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
      </form>
    );
  }
  return (
    <button type="button" className="driver-name driver-name--edit caps" onClick={open} title="Change your name">
      {name} <span className="driver-name-pencil" aria-hidden="true">✎</span>
    </button>
  );
}

interface ResultsProps {
  snapshot: Snapshot;
  meId: string;
  isHost: boolean;
  onRematch(): void;
  onLeave(): void;
}

function Results({ snapshot, meId, isHost, onRematch, onLeave }: ResultsProps) {
  const over = snapshot.phase === 'finished';
  const rows = [...snapshot.drivers].sort((a, b) => (a.place || 99) - (b.place || 99));
  return (
    <div className="overlay">
      <div className="card">
        <h2 className="caps">{over ? 'Results' : 'You finished!'}</h2>
        <table className="results">
          <tbody>
            {rows.map((driver) => (
              <tr key={driver.id} className={driver.id === meId ? 'me' : undefined}>
                <td>{driver.place ? ordinal(driver.place) : '–'}</td>
                <td className="caps">
                  <span style={{ color: driver.color }}>■ </span>
                  {driver.name}
                </td>
                <td>{driver.finished ? formatRaceTime(driver.finishTime) : over ? 'DNF' : 'Racing…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!over && <p className="muted">Waiting for the others. The race closes 30 seconds after the winner.</p>}
        <div className="card-actions">
          {isHost ? (
            <button className="btn btn--primary" disabled={!over} onClick={onRematch}>
              Race again
            </button>
          ) : (
            over && <span className="muted">Waiting for the host to start the next race…</span>
          )}
          <button className="btn" onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>
    </div>
  );
}
