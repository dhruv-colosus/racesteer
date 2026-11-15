import { useEffect, useState, type FormEvent } from 'react';
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

export function Home() {
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
    const clean = sanitizeName(name);
    saveName(clean);
    return clean;
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

  return (
    <main className="home">
      <header className="home-title">
        <span className="stripes">
          <i />
          <i />
        </span>
        <h1 className="caps">Tilt Rush</h1>
        <span className="stripes stripes--flip">
          <i />
          <i />
        </span>
      </header>
      <p className="home-tag caps">Your phone is the wheel. The big screen is the track.</p>

      <div className="home-grid">
        <section className="pane">
          <h2 className="caps">Driver</h2>
          <label className="field">
            <span>Your name</span>
            <input
              className="input"
              value={name}
              maxLength={NAME_MAX_LENGTH}
              placeholder="Driver"
              autoComplete="nickname"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button className="btn btn--wide" onClick={() => navigate('/solo')}>
            Practice solo
          </button>
          <p className="muted pane-note">
            Create or join a room, then scan the code on screen to turn your phone into the steering wheel. No phone?
            The keyboard works too.
          </p>
        </section>

        <form className="pane" onSubmit={create}>
          <h2 className="caps">Create room</h2>
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
          <button className="btn btn--primary btn--wide" disabled={busy}>
            Create room
          </button>
        </form>

        <section className="pane">
          <h2 className="caps">Join</h2>
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
            {!offline && rooms?.length === 0 && <li className="room-empty">No public rooms yet — create one.</li>}
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
        </section>
      </div>

      <p className="toast caps" role="alert">
        {error}
      </p>
    </main>
  );
}
