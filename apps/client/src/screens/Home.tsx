import { useEffect, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  DEFAULT_LAPS,
  DEFAULT_MAX_PLAYERS,
  LAP_OPTIONS,
  MAX_PLAYERS_LIMIT,
  MIN_MAX_PLAYERS,
  NAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  ROOM_NAME_MAX_LENGTH,
  isRoomCode,
  normalizeRoomCode,
  sanitizeName,
  type RoomListing,
} from '@racing/shared';
import { createRoom, describeJoinError, joinRoom, listRooms, loadName, saveName, stashRoom } from '../net/client';
import { navigate } from '../router';

const ROOM_POLL_MS = 2000;

type Mode = 'host' | 'join' | 'solo';

const MODES: { id: Mode; label: string; note: string }[] = [
  { id: 'host', label: 'Host race', note: 'Open a room for your friends' },
  { id: 'join', label: 'Join race', note: 'Enter a code or pick an open room' },
  { id: 'solo', label: 'Solo practice', note: 'Learn the track on your own' },
];

export function Home() {
  const [mode, setMode] = useState<Mode>('host');
  const [name, setName] = useState(loadName);
  const [roomName, setRoomName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(DEFAULT_MAX_PLAYERS);
  const [laps, setLaps] = useState<number>(DEFAULT_LAPS);
  const [isPrivate, setIsPrivate] = useState(false);
  const [code, setCode] = useState('');
  const [rooms, setRooms] = useState<RoomListing[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Live list of open public rooms.
  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    const refresh = async () => {
      try {
        setRooms(await listRooms(controller.signal));
        setOffline(false);
      } catch {
        if (controller.signal.aborted) return;
        setOffline(true);
      }
      timer = window.setTimeout(refresh, ROOM_POLL_MS);
    };
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, []);

  const driver = () => {
    saveName(name);
    return sanitizeName(name);
  };

  const run = async (action: () => Promise<{ roomId: string }>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const room = await action();
      navigate(`/r/${room.roomId}`);
    } catch (cause) {
      setError(describeJoinError(cause));
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    const who = driver();
    void run(async () => {
      const room = await createRoom({
        role: 'player',
        name: who,
        roomName: roomName.trim() || `${who}'s race`,
        maxPlayers,
        laps,
        isPrivate,
      });
      stashRoom(room);
      return room;
    });
  };

  const join = (target: string) => {
    const who = driver();
    void run(async () => {
      const room = await joinRoom(target, who);
      stashRoom(room);
      return room;
    });
  };

  const joinByCode = (event: FormEvent) => {
    event.preventDefault();
    if (isRoomCode(code)) join(code);
    else setError(`Room codes are ${ROOM_CODE_LENGTH} letters.`);
  };

  const selectMode = (next: Mode, focus = false) => {
    setMode(next);
    setError('');
    if (focus) document.getElementById(`mode-${next}`)?.focus();
  };

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const index = MODES.findIndex((item) => item.id === mode);
    selectMode(MODES[(index + step + MODES.length) % MODES.length]!.id, true);
  };

  const openRooms = offline ? 0 : (rooms?.length ?? 0);
  const active = MODES.findIndex((item) => item.id === mode);

  return (
    <main className="home">
      <div className="home-backdrop" aria-hidden="true">
        <i className="home-streaks" />
        <i className="home-floor" />
      </div>

      <header className="home-bar">
        <span className={`home-status caps${offline ? ' home-status--down' : ''}`}>
          <i />
          {offline ? 'Server offline' : rooms === null ? 'Connecting…' : `Online · ${openRooms} open ${openRooms === 1 ? 'room' : 'rooms'}`}
        </span>
        <label className="plate">
          <span className="caps">Driver</span>
          <input
            value={name}
            maxLength={NAME_MAX_LENGTH}
            placeholder="Your name"
            autoComplete="nickname"
            aria-label="Your driver name"
            onChange={(event) => {
              setName(event.target.value);
              saveName(event.target.value);
            }}
          />
        </label>
      </header>

      <div className="home-center">
        <div className="home-logo">
          <div className="home-title">
            <span className="stripes">
              <i />
              <i />
            </span>
            <h1 className="caps">Tilt Rush</h1>
            <span className="stripes stripes--flip">
              <i />
              <i />
            </span>
          </div>
          <p className="home-tag caps">Your phone is the wheel. The big screen is the track.</p>
        </div>

        <div className="menu">
          <div className="menu-nav" role="tablist" aria-orientation="vertical" aria-label="Game mode" onKeyDown={onMenuKey}>
            {MODES.map((item, index) => (
              <button
                key={item.id}
                id={`mode-${item.id}`}
                type="button"
                role="tab"
                aria-selected={mode === item.id}
                aria-controls="mode-panel"
                tabIndex={mode === item.id ? 0 : -1}
                className={`menu-item${mode === item.id ? ' menu-item--active' : ''}`}
                onClick={() => selectMode(item.id)}
              >
                <span className="menu-index">0{index + 1}</span>
                <span className="menu-text">
                  <strong className="caps">{item.label}</strong>
                  <small>{item.note}</small>
                </span>
                {item.id === 'join' && openRooms > 0 && <span className="menu-badge caps">{openRooms}</span>}
              </button>
            ))}
          </div>

          <section className="menu-panel" id="mode-panel" role="tabpanel" aria-labelledby={`mode-${mode}`} key={mode}>
            <p className="menu-kicker caps">
              <span className="accent">0{active + 1}</span> / {MODES[active]!.label}
            </p>

            {mode === 'host' && (
              <form className="menu-form" onSubmit={create}>
                <h2 className="caps">Set up your race</h2>
                <label className="field">
                  <span>Room name</span>
                  <input
                    className="input"
                    value={roomName}
                    maxLength={ROOM_NAME_MAX_LENGTH}
                    placeholder={`${sanitizeName(name)}'s race`}
                    onChange={(event) => setRoomName(event.target.value)}
                  />
                </label>
                <div className="menu-row">
                  <div className="field">
                    <span>Max players</span>
                    <div className="stepper">
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-label="Fewer players"
                        disabled={maxPlayers <= MIN_MAX_PLAYERS}
                        onClick={() => setMaxPlayers((n) => n - 1)}
                      >
                        −
                      </button>
                      <output className="caps">{maxPlayers}</output>
                      <button
                        type="button"
                        className="btn btn--small"
                        aria-label="More players"
                        disabled={maxPlayers >= MAX_PLAYERS_LIMIT}
                        onClick={() => setMaxPlayers((n) => n + 1)}
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
                          type="button"
                          key={option}
                          className={`btn btn--small${laps === option ? ' btn--primary' : ''}`}
                          aria-pressed={laps === option}
                          onClick={() => setLaps(option)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="field">
                  <span>Visibility</span>
                  <div className="segmented">
                    <button
                      type="button"
                      className={`btn btn--small${!isPrivate ? ' btn--primary' : ''}`}
                      aria-pressed={!isPrivate}
                      onClick={() => setIsPrivate(false)}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      className={`btn btn--small${isPrivate ? ' btn--primary' : ''}`}
                      aria-pressed={isPrivate}
                      onClick={() => setIsPrivate(true)}
                    >
                      Private
                    </button>
                  </div>
                  <small className="muted">
                    {isPrivate ? 'Hidden from the list. Only people with the link or code can join.' : 'Listed for anyone to join.'}
                  </small>
                </div>
                <button className="btn btn--primary btn--wide btn--go" disabled={busy}>
                  {busy ? 'Opening…' : 'Create room'}
                </button>
              </form>
            )}

            {mode === 'join' && (
              <div className="menu-form">
                <h2 className="caps">Find a race</h2>
                <form className="join-code" onSubmit={joinByCode}>
                  <label className="field">
                    <span>Room code</span>
                    <input
                      className="input input--code"
                      value={code}
                      placeholder="ABCDE"
                      autoCapitalize="characters"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setCode(normalizeRoomCode(event.target.value))}
                    />
                  </label>
                  <button className="btn btn--primary" disabled={busy || code.length !== ROOM_CODE_LENGTH}>
                    Join
                  </button>
                </form>

                <h3 className="caps muted">Open rooms</h3>
                <ul className="room-list">
                  {offline && <li className="room-empty">Game server is not reachable.</li>}
                  {!offline && rooms === null && <li className="room-empty">Looking for rooms…</li>}
                  {!offline && rooms?.length === 0 && (
                    <li className="room-empty">
                      No public rooms yet.{' '}
                      <button type="button" className="link" onClick={() => selectMode('host', true)}>
                        Host one
                      </button>
                    </li>
                  )}
                  {!offline &&
                    rooms?.map((room) => (
                      <li key={room.code} className="room-row">
                        <div>
                          <strong className="caps">{room.roomName}</strong>
                          <small className="muted">
                            {room.players}/{room.maxPlayers} drivers · {room.laps} {room.laps === 1 ? 'lap' : 'laps'}
                          </small>
                        </div>
                        <button className="btn btn--small" disabled={busy} onClick={() => join(room.code)}>
                          Join
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {mode === 'solo' && (
              <div className="menu-form">
                <h2 className="caps">Learn the track</h2>
                <p className="muted pane-note">
                  No opponents and no clock pressure. Pair your phone on the next screen, or drive with the keyboard.
                </p>
                <dl className="keys">
                  <div>
                    <dt>
                      <kbd>W</kbd>
                      <kbd>A</kbd>
                      <kbd>S</kbd>
                      <kbd>D</kbd>
                    </dt>
                    <dd>Steer, throttle, brake (arrow keys work too)</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd className="kbd--wide">Space</kbd>
                    </dt>
                    <dd>Boost</dd>
                  </div>
                </dl>
                <button type="button" className="btn btn--primary btn--wide btn--go" onClick={() => navigate('/solo')}>
                  Start practice
                </button>
              </div>
            )}

            <p className="toast caps" role="alert">
              {error}
            </p>
          </section>
        </div>
      </div>

      <footer className="home-foot caps">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Select mode
        </span>
        <span>Scan the on-screen code to steer with your phone</span>
      </footer>
    </main>
  );
}
