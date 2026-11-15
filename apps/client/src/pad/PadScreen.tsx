import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CAR_COLORS,
  JoinError,
  Msg,
  PAD_REPLACED,
  PAD_SEND_HZ,
  encodePadInput,
  ordinal,
  rollFromGravity,
  tiltToSteer,
  type DriveInput,
  type PadInputMessage,
  type RaceStateLike,
} from '@racing/shared';
import { describeJoinError, joinAsPad, type GameRoom } from '../net/client';
import './pad.css';

/**
 * intro: waiting for the first tap. connecting: first attempt. live: driving.
 * reconnecting: lost the room, retrying by itself. replaced: another phone took
 * this car. failed: gave up — the room or the link is gone.
 */
type Stage = 'intro' | 'connecting' | 'live' | 'reconnecting' | 'replaced' | 'failed';

interface PadInfo {
  practice: boolean;
  name: string;
  color: string;
  phase: string;
  place: number;
  total: number;
}

/** Retries start fast (a reload or a blip is back in well under a second) and slow down. */
const RETRY_MIN_MS = 300;
const RETRY_MAX_MS = 3000;
/** Long enough to ride out a server restart or a walk through a dead spot; after that, stop and ask. */
const GIVE_UP_MS = 90_000;
/** If no motion reading arrives this long after starting, fall back to touch steering. */
const MOTION_TIMEOUT_MS = 1500;
/** Resend unchanged input this often so the display knows the phone is still there. */
const KEEPALIVE_MS = 100;
/** How quickly the smoothed roll follows the raw reading, per motion event. */
const ROLL_SMOOTHING = 0.35;

interface MotionPermission {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

function statusLine(info: PadInfo | null): string {
  if (!info) return 'Connected';
  if (info.practice) return 'Practice — you are driving';
  switch (info.phase) {
    case 'lobby':
      return 'Waiting for the race to start';
    case 'countdown':
      return 'Get ready…';
    case 'racing':
      return info.place ? `${ordinal(info.place)} of ${info.total}` : 'Go!';
    case 'finished':
      return info.place ? `Finished ${ordinal(info.place)}` : 'Race over';
    default:
      return 'Connected';
  }
}

/** Remembers that this phone was already driving, so a reload goes straight back in without a tap. */
const resumeKey = (code: string, token: string) => `tiltrush.pad.${code}.${token}`;
function wasDriving(code: string, token: string): boolean {
  try {
    return sessionStorage.getItem(resumeKey(code, token)) === '1';
  } catch {
    return false;
  }
}
function rememberDriving(code: string, token: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(resumeKey(code, token), '1');
    else sessionStorage.removeItem(resumeKey(code, token));
  } catch {
    /* storage unavailable — a reload will just ask for a tap again */
  }
}

/** The phone side: hold it like a wheel, tilt to steer, thumbs for the pedals. */
export function PadScreen({ code, token }: { code: string; token: string }) {
  const [stage, setStage] = useState<Stage>(() => (wasDriving(code, token) ? 'reconnecting' : 'intro'));
  const [error, setError] = useState('');
  const [info, setInfo] = useState<PadInfo | null>(null);
  const [touchSteer, setTouchSteer] = useState(false);
  const [tiltAvailable, setTiltAvailable] = useState(true);
  /** Motion access needs a tap (iOS after a reload); until then the phone steers by touch. */
  const [tiltNeedsTap, setTiltNeedsTap] = useState(false);

  const room = useRef<GameRoom | null>(null);
  const alive = useRef(true);
  const retryTimer = useRef(0);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  /** A join is in flight; never start a second one, or the two would take the car from each other. */
  const joining = useRef(false);
  const retry = useRef({ delay: RETRY_MIN_MS, since: 0 });
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null);

  // Live control state lives in refs: it changes 60 times a second and never needs a React render.
  const controls = useRef({ throttle: 0, brake: 0, boost: false, touchSteer: 0 });
  const roll = useRef({ value: 0, center: 0, seen: false });
  const touchSteerRef = useRef(touchSteer);
  touchSteerRef.current = touchSteer;
  const marker = useRef<HTMLDivElement>(null);

  // ---- connection ----------------------------------------------------------

  const connect = useCallback(async () => {
    window.clearTimeout(retryTimer.current);
    if (joining.current || room.current || !alive.current) return;
    joining.current = true;
    if (!retry.current.since) retry.current.since = Date.now();
    try {
      const joined = await joinAsPad(code, token);
      if (!alive.current) {
        void joined.leave();
        return;
      }
      // Reconnecting is handled here, by rejoining with the link: it is quicker than the SDK's seat-based retry.
      joined.reconnection.enabled = false;
      room.current = joined;
      retry.current = { delay: RETRY_MIN_MS, since: 0 };
      let playerId = '';
      const refresh = (state: RaceStateLike | undefined) => {
        const player = playerId ? state?.players?.get(playerId) : undefined;
        if (!state || !player) return;
        setInfo({
          practice: state.practice === true,
          name: player.name,
          color: CAR_COLORS[player.color] ?? CAR_COLORS[0],
          phase: state.phase,
          place: player.place,
          total: state.players.size,
        });
      };
      joined.onMessage(Msg.PadBound, (message: { playerId: string }) => {
        playerId = message.playerId;
        refresh(joined.state);
      });
      joined.onMessage(Msg.Haptic, (message: { ms: number }) => navigator.vibrate?.(message.ms));
      joined.onStateChange(refresh);
      joined.onLeave((closeCode) => {
        if (!alive.current || room.current !== joined) return;
        room.current = null;
        if (closeCode === PAD_REPLACED) {
          // Another phone opened this link. Do not fight it for the car.
          rememberDriving(code, token, false);
          setStage('replaced');
          return;
        }
        setStage('reconnecting');
        retryTimer.current = window.setTimeout(connect, RETRY_MIN_MS);
      });
      rememberDriving(code, token, true);
      setError('');
      setStage('live');
    } catch (cause) {
      if (!alive.current) return;
      const failure = cause as { code?: number };
      setError(describeJoinError(cause));
      // On a first connect a bad token is final: the link is stale. After that, the room or the
      // driver may simply not be back yet (server restarting, display reloading), so keep trying for a while.
      const staleLink = failure.code === JoinError.BadPadToken && stageRef.current === 'connecting';
      if (staleLink || Date.now() - retry.current.since > GIVE_UP_MS) {
        retry.current = { delay: RETRY_MIN_MS, since: 0 };
        rememberDriving(code, token, false);
        setStage('failed');
        return;
      }
      setStage((current) => (current === 'connecting' ? 'connecting' : 'reconnecting'));
      retryTimer.current = window.setTimeout(connect, retry.current.delay);
      retry.current.delay = Math.min(RETRY_MAX_MS, retry.current.delay * 1.6);
    } finally {
      joining.current = false;
    }
  }, [code, token]);

  /** Manual retry from the failed / replaced screens. */
  const reconnectNow = () => {
    retry.current = { delay: RETRY_MIN_MS, since: 0 };
    setError('');
    setStage('reconnecting');
    void connect();
  };

  // ---- sensors -------------------------------------------------------------

  /**
   * Turns tilt steering on. iOS only hands out motion data after a prompt,
   * and only from a tap, so `fromTap` says whether this call is allowed to ask.
   */
  const enableTilt = async (fromTap: boolean) => {
    const motion = window.DeviceMotionEvent as unknown as MotionPermission | undefined;
    if (!window.DeviceMotionEvent) {
      setTiltAvailable(false);
      setTouchSteer(true);
      return;
    }
    if (motion?.requestPermission) {
      let granted = false;
      let refused = false;
      try {
        const answer = await motion.requestPermission();
        granted = answer === 'granted';
        refused = !granted;
      } catch {
        // Asked without a tap (after a reload). Steer by touch and offer a button to ask properly.
      }
      if (!granted) {
        setTouchSteer(true);
        if (refused || fromTap) setTiltAvailable(false);
        else setTiltNeedsTap(true);
        return;
      }
    }
    setTiltNeedsTap(false);
    setTiltAvailable(true);
    setTouchSteer(false);
    window.removeEventListener('devicemotion', onMotion);
    window.addEventListener('devicemotion', onMotion);
    window.setTimeout(() => {
      if (alive.current && !roll.current.seen) {
        setTiltAvailable(false);
        setTouchSteer(true);
      }
    }, MOTION_TIMEOUT_MS);
  };

  const start = async () => {
    setStage('connecting');
    await enableTilt(true);

    void acquireWakeLock();
    // Best effort: Android honours these, iOS ignores them.
    document.documentElement
      .requestFullscreen?.()
      .then(() => (screen.orientation as unknown as { lock?(o: string): Promise<void> }).lock?.('landscape'))
      .catch(() => {});

    void connect();
  };

  const onMotion = useCallback((event: DeviceMotionEvent) => {
    const gravity = event.accelerationIncludingGravity;
    if (!gravity || gravity.x === null || gravity.y === null) return;
    const angle = screen.orientation?.angle ?? Number((window as unknown as { orientation?: number }).orientation ?? 0);
    const reading = rollFromGravity(gravity.x, gravity.y, angle);
    if (reading === null) return; // phone is lying flat — keep the last good value
    const state = roll.current;
    state.value = state.seen ? state.value + (reading - state.value) * ROLL_SMOOTHING : reading;
    state.seen = true;
  }, []);

  const acquireWakeLock = async () => {
    try {
      const api = (navigator as unknown as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      wakeLock.current = (await api?.request('screen')) ?? null;
    } catch {
      /* not supported or not allowed — the screen may dim */
    }
  };

  const recenter = () => {
    // Whatever angle the phone is at right now becomes "straight ahead", within reason.
    roll.current.center = Math.max(-25, Math.min(25, roll.current.value));
    navigator.vibrate?.(20);
  };

  // ---- send loop -----------------------------------------------------------

  useEffect(() => {
    let last: PadInputMessage = [0, 0, 0, 0];
    let lastSent = 0;
    const timer = window.setInterval(() => {
      const c = controls.current;
      const steer = touchSteerRef.current ? c.touchSteer : tiltToSteer(roll.current.value, roll.current.center);
      if (marker.current) marker.current.style.transform = `translateX(${(steer * 50).toFixed(1)}%)`;

      const active = room.current;
      if (!active) return;
      const input: DriveInput = { steer, throttle: c.throttle, brake: c.brake, boost: c.boost };
      const message = encodePadInput(input);
      const now = performance.now();
      const changed = message.some((value, i) => value !== last[i]);
      if (!changed && now - lastSent < KEEPALIVE_MS) return;
      last = message;
      lastSent = now;
      active.send(Msg.PadInput, message);
    }, 1000 / PAD_SEND_HZ);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    alive.current = true;

    // This phone was already driving before the page reloaded: go straight back in, no tap needed.
    if (stageRef.current === 'reconnecting') {
      void enableTilt(false);
      void acquireWakeLock();
      void connect();
    }

    // Coming back from the lock screen, another app, or a dead spot: do not wait out the retry timer.
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      if (wakeLock.current || stageRef.current === 'live') void acquireWakeLock();
      if (stageRef.current === 'reconnecting' || stageRef.current === 'connecting') {
        retry.current.delay = RETRY_MIN_MS;
        void connect();
      }
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('pageshow', wake);
    return () => {
      alive.current = false;
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('devicemotion', onMotion);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('pageshow', wake);
      void wakeLock.current?.release().catch(() => {});
      const active = room.current;
      room.current = null;
      void active?.leave().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onMotion, connect]);

  // ---- touch controls ------------------------------------------------------

  /** Keeps a touch bound to its control even if the thumb slides off it. */
  const capture = (event: ReactPointerEvent<HTMLElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already gone — the control still works, it just will not track outside its bounds */
    }
  };

  /** Press-and-hold handlers for a pedal or button. */
  const hold = (set: (down: boolean) => void) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      capture(event);
      event.currentTarget.classList.add('is-down');
      set(true);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.classList.remove('is-down');
      set(false);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      event.currentTarget.classList.remove('is-down');
      set(false);
    },
    onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
  });

  const dragSteer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!touchSteerRef.current || event.buttons === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    controls.current.touchSteer = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1));
  };

  // ---- render --------------------------------------------------------------

  if (stage === 'intro' || stage === 'failed' || stage === 'replaced' || stage === 'connecting') {
    return (
      <main className="pad-intro">
        <div className="pad-intro-title">
          <span className="stripes">
            <i />
            <i />
          </span>
          <h1 className="caps">Controller</h1>
        </div>
        <p className="caps muted">Room {code}</p>
        {stage === 'failed' ? (
          <>
            <p className="toast caps">{error || 'Lost the connection to the game.'}</p>
            <button className="btn btn--primary pad-connect" onClick={reconnectNow}>
              Try again
            </button>
            <p className="muted">If that does not work, open the room on the big screen and scan its code again.</p>
          </>
        ) : stage === 'replaced' ? (
          <>
            <p className="toast caps">Another phone took over this car.</p>
            <button className="btn btn--primary pad-connect" onClick={reconnectNow}>
              Use this phone
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--primary pad-connect" disabled={stage === 'connecting'} onClick={start}>
              {stage === 'connecting' ? 'Connecting…' : 'Tap to connect'}
            </button>
            <p className="muted">
              Turn the phone sideways and hold it like a steering wheel. Your browser will ask for motion access — allow it
              so you can steer by tilting.
            </p>
            {error && <p className="toast caps">{error}</p>}
          </>
        )}
      </main>
    );
  }

  const accent = info?.color ?? CAR_COLORS[0];
  return (
    <main className="pad" style={{ ['--car' as string]: accent }}>
      <header className="pad-top">
        <div className="slab caps pad-name">{info?.name ?? 'Driver'}</div>
        <div className="caps pad-status">{stage === 'reconnecting' ? 'Reconnecting…' : statusLine(info)}</div>
        <div className="pad-tools">
          {!touchSteer && (
            <button className="btn btn--small" onClick={recenter}>
              Re-centre
            </button>
          )}
          {tiltNeedsTap ? (
            <button className="btn btn--small btn--primary" onClick={() => void enableTilt(true)}>
              Enable tilt
            </button>
          ) : (
            <button
              className="btn btn--small"
              disabled={!tiltAvailable}
              onClick={() => {
                controls.current.touchSteer = 0;
                setTouchSteer((on) => !on);
              }}
            >
              {touchSteer ? 'Touch steer' : 'Tilt steer'}
            </button>
          )}
        </div>
      </header>

      <button className="pad-pedal pad-brake caps" aria-label="Brake" {...hold((down) => (controls.current.brake = down ? 1 : 0))}>
        Brake
      </button>

      <div className="pad-mid">
        <div
          className={`pad-steer${touchSteer ? ' pad-steer--touch' : ''}`}
          onPointerDown={(event) => {
            capture(event);
            dragSteer(event);
          }}
          onPointerMove={dragSteer}
          onPointerUp={() => (controls.current.touchSteer = 0)}
          onPointerCancel={() => (controls.current.touchSteer = 0)}
        >
          <div className="pad-steer-track">
            <div className="pad-steer-marker" ref={marker}>
              <i />
            </div>
          </div>
          <span className="caps muted">
            {touchSteer
              ? tiltNeedsTap
                ? 'Drag to steer — or tap Enable tilt'
                : tiltAvailable
                  ? 'Drag to steer'
                  : 'No motion sensor — drag to steer'
              : 'Tilt to steer'}
          </span>
        </div>
        <button className="pad-boost caps" aria-label="Boost" {...hold((down) => (controls.current.boost = down))}>
          Boost
        </button>
      </div>

      <button className="pad-pedal pad-gas caps" aria-label="Gas" {...hold((down) => (controls.current.throttle = down ? 1 : 0))}>
        Gas
      </button>

      <div className="pad-rotate caps">
        <span>Turn your phone sideways</span>
      </div>
    </main>
  );
}
