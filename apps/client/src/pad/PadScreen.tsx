import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  CAR_COLORS,
  JoinError,
  Msg,
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

type Stage = 'intro' | 'connecting' | 'live' | 'reconnecting' | 'failed';

interface PadInfo {
  name: string;
  color: string;
  phase: string;
  place: number;
  total: number;
}

const RETRY_MS = 1500;
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

/** The phone side: hold it like a wheel, tilt to steer, thumbs for the pedals. */
export function PadScreen({ code, token }: { code: string; token: string }) {
  const [stage, setStage] = useState<Stage>('intro');
  const [error, setError] = useState('');
  const [info, setInfo] = useState<PadInfo | null>(null);
  const [touchSteer, setTouchSteer] = useState(false);
  const [tiltAvailable, setTiltAvailable] = useState(true);

  const room = useRef<GameRoom | null>(null);
  const alive = useRef(true);
  const retryTimer = useRef(0);
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
    try {
      const joined = await joinAsPad(code, token);
      if (!alive.current) {
        void joined.leave();
        return;
      }
      room.current = joined;
      let playerId = '';
      const refresh = (state: RaceStateLike | undefined) => {
        const player = playerId ? state?.players?.get(playerId) : undefined;
        if (!state || !player) return;
        setInfo({
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
      joined.onLeave(() => {
        if (!alive.current || room.current !== joined) return;
        room.current = null;
        setStage('reconnecting');
        retryTimer.current = window.setTimeout(connect, RETRY_MS);
      });
      setError('');
      setStage('live');
    } catch (cause) {
      if (!alive.current) return;
      const failure = cause as { code?: number };
      if (failure.code === JoinError.BadPadToken) {
        // The player this link belonged to has gone. Nothing to retry.
        setError(describeJoinError(cause));
        setStage('failed');
        return;
      }
      // Seat still held by a dropped connection, or the network is down: keep trying.
      setError(describeJoinError(cause));
      setStage((current) => (current === 'connecting' ? 'connecting' : 'reconnecting'));
      retryTimer.current = window.setTimeout(connect, RETRY_MS);
    }
  }, [code, token]);

  // ---- sensors -------------------------------------------------------------

  const start = async () => {
    setStage('connecting');

    // iOS only hands out motion data after an explicit prompt, and only from a tap.
    let granted = true;
    const motion = window.DeviceMotionEvent as unknown as MotionPermission | undefined;
    if (motion?.requestPermission) {
      try {
        granted = (await motion.requestPermission()) === 'granted';
      } catch {
        granted = false;
      }
    }
    if (!granted || !window.DeviceMotionEvent) {
      setTiltAvailable(false);
      setTouchSteer(true);
    } else {
      window.addEventListener('devicemotion', onMotion);
      window.setTimeout(() => {
        if (alive.current && !roll.current.seen) {
          setTiltAvailable(false);
          setTouchSteer(true);
        }
      }, MOTION_TIMEOUT_MS);
    }

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
    const onVisible = () => {
      if (document.visibilityState === 'visible' && wakeLock.current) void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('devicemotion', onMotion);
      document.removeEventListener('visibilitychange', onVisible);
      void wakeLock.current?.release().catch(() => {});
      const active = room.current;
      room.current = null;
      void active?.leave().catch(() => {});
    };
  }, [onMotion]);

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

  if (stage === 'intro' || stage === 'failed' || stage === 'connecting') {
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
            <p className="toast caps">{error}</p>
            <p className="muted">Open the room on the big screen and scan its code again.</p>
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
            {touchSteer ? (tiltAvailable ? 'Drag to steer' : 'No motion sensor — drag to steer') : 'Tilt to steer'}
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
