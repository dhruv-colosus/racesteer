import QRCode from 'qrcode';
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
  type TransformMessage,
} from '@racing/shared';
import { describeJoinError, joinRoom, loadName, saveName, takeRoom, type GameRoom } from '../net/client';
import { padLink, publicOrigin, roomLink } from '../net/links';
import { navigate } from '../router';
import { RaceStage, type StageHandle } from '../ui/RaceStage';

interface Driver {
  id: string;
  name: string;
  color: string;
  ready: boolean;
  pad: boolean;
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

export function RoomScreen({ code }: { code: string }) {
  const [room, setRoom] = useState<GameRoom | null>(() => takeRoom(code));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [padToken, setPadToken] = useState<string | null>(null);
  const [goAt, setGoAt] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const stage = useRef<StageHandle | null>(null);
  const leaving = useRef(false);
  const lastHaptic = useRef(0);

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
    let lastJson = '';
    const sync = (state: RaceStateLike) => {
      feedRemotes(state);
      const next = snapshotOf(state);
      if (!next) return;
      const json = JSON.stringify(next);
      if (json === lastJson) return;
      lastJson = json;
      setSnapshot(next);
    };
    room.onStateChange(sync);
    if (room.state) sync(room.state);

    const offToken = room.onMessage(Msg.PadToken, (message: { token: string }) => setPadToken(message.token));
    const offCountdown = room.onMessage(Msg.Countdown, (message: { ms: number }) => setGoAt(performance.now() + message.ms));
    const offPad = room.onMessage(Msg.PadInput, (message: unknown) => {
      const input = decodePadInput(message);
      if (input) stage.current?.input.setPadInput(input);
    });
    room.onLeave((closeCode) => {
      if (!leaving.current) setGone(closeCode === 4000 ? 'You left the room.' : 'Connection to the room was lost.');
    });
    room.send(Msg.PadToken);

    return () => {
      offToken();
      offCountdown();
      offPad();
      leaving.current = true;
      void room.leave().catch(() => {});
    };
  }, [room, feedRemotes]);

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
            <button className="btn btn--primary" onClick={leave}>
              Back to menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!room) return <JoinGate code={code} onJoined={setRoom} />;
  if (!snapshot) return <div className="center-screen caps">Joining {code}…</div>;

  const me = snapshot.drivers.find((driver) => driver.id === room.sessionId);
  if (!me) return <div className="center-screen caps">Joining {code}…</div>;
  const isHost = snapshot.hostId === room.sessionId;

  if (snapshot.phase === 'lobby') {
    return <Lobby room={room} code={code} snapshot={snapshot} me={me} isHost={isHost} padToken={padToken} onLeave={leave} />;
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
      }}
      onNet={(transform: TransformMessage) => room.send(Msg.Transform, transform)}
      onImpact={(strength) => {
        const now = performance.now();
        if (!me.pad || now - lastHaptic.current < 250) return;
        lastHaptic.current = now;
        room.send(Msg.Haptic, { ms: 30 + strength * 90 });
      }}
      onPause={() => setMenu(true)}
    >
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

/** Shown when someone arrives by link: pick a name, then join. */
function JoinGate({ code, onJoined }: { code: string; onJoined(room: GameRoom): void }) {
  const [name, setName] = useState(loadName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const clean = sanitizeName(name);
    saveName(clean);
    try {
      onJoined(await joinRoom(code, clean));
    } catch (cause) {
      setError(describeJoinError(cause));
      setBusy(false);
    }
  };

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
  onLeave(): void;
}

function Lobby({ room, code, snapshot, me, isHost, padToken, onLeave }: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const link = padToken ? padLink(code, padToken) : null;
  const usingLanDevOrigin = publicOrigin() !== window.location.origin;

  useEffect(() => {
    let cancelled = false;
    setQr(null);
    if (!link) return;
    QRCode.toDataURL(link, { margin: 1, width: 336, errorCorrectionLevel: 'M' }).then(
      (url) => !cancelled && setQr(url),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roomLink(code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt('Copy this link', roomLink(code));
    }
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
          <div className="slab slab--accent caps" aria-label={`Room code ${code}`}>
            {code}
          </div>
          <button className="btn" onClick={copy}>
            {copied ? 'Copied!' : 'Copy invite link'}
          </button>
        </div>
      </header>

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
                <span className="driver-name caps">{driver.name}</span>
                {driver.id === me.id && <span className="tag">You</span>}
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
            <div className="phone">
              {!me.pad && (qr ? <img src={qr} alt="QR code that opens the controller on your phone" /> : <div style={{ width: 168, height: 168 }} />)}
              <div className="phone-text">
                {me.pad ? (
                  <p>Hold it sideways like a steering wheel. Tilt to steer, right thumb for gas, left thumb for brake.</p>
                ) : (
                  <>
                    <p>Scan with your phone camera. It becomes your steering wheel: tilt to steer, thumbs for gas and brake.</p>
                    {link && <span className="phone-link">{link}</span>}
                    {usingLanDevOrigin && (
                      <p className="muted">
                        Dev build: the phone must be on the same Wi-Fi, and will show a certificate warning once — choose to
                        proceed.
                      </p>
                    )}
                    <p className="muted">No phone? Drive with WASD or the arrow keys.</p>
                  </>
                )}
              </div>
            </div>
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
