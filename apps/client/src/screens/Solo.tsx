import { useCallback, useEffect, useRef, useState } from 'react';
import { CAR_COLORS, COUNTDOWN_MS, DEFAULT_LAPS, TRACKS, formatRaceTime, type DriveInput } from '@racing/shared';
import { usePracticePhone } from '../net/usePracticePhone';
import { navigate } from '../router';
import { PhoneCard } from '../ui/PhoneCard';
import { RaceStage, type StageHandle } from '../ui/RaceStage';

/** Practice on your own. The race itself needs no server; the server is only used to pair a phone. */
export function Solo() {
  // Bumping the run number remounts the stage for a clean restart.
  const [run, setRun] = useState(0);
  /** The driver has pressed Start once; later restarts go straight to the countdown. */
  const [started, setStarted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [goAt, setGoAt] = useState<number | null>(null);
  const [finalTime, setFinalTime] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const goAtRef = useRef<number | null>(null);
  const stage = useRef<StageHandle | null>(null);
  const lastHaptic = useRef(0);

  const phone = usePracticePhone(useCallback((input: DriveInput) => stage.current?.input.setPadInput(input), []));

  const onReady = useCallback((handle: StageHandle) => {
    stage.current = handle;
    setLoaded(true);
  }, []);

  // Lights start once the track is loaded and the driver has said go.
  useEffect(() => {
    if (!started || !loaded || goAtRef.current !== null) return;
    const at = performance.now() + COUNTDOWN_MS;
    goAtRef.current = at;
    setGoAt(at);
  }, [started, loaded]);

  const onFinish = useCallback(() => {
    if (goAtRef.current !== null) setFinalTime(performance.now() - goAtRef.current);
  }, []);

  const restart = () => {
    goAtRef.current = null;
    stage.current = null;
    setGoAt(null);
    setFinalTime(null);
    setPaused(false);
    setLoaded(false);
    setRun((n) => n + 1);
  };

  const phonePanel = phone.code || phone.offline ? (
    <PhoneCard code={phone.code} token={phone.token} connected={phone.connected} offline={phone.offline} />
  ) : (
    <p className="muted">Setting up phone pairing…</p>
  );

  return (
    <RaceStage
      key={run}
      trackId={TRACKS[0]!.id}
      laps={DEFAULT_LAPS}
      color={CAR_COLORS[0]}
      slot={0}
      goAt={goAt}
      place={1}
      total={1}
      finalTimeMs={finalTime}
      onReady={onReady}
      onFinish={onFinish}
      onImpact={(strength) => {
        const now = performance.now();
        if (!phone.connected || now - lastHaptic.current < 250) return;
        lastHaptic.current = now;
        phone.haptic(30 + strength * 90);
      }}
      onPause={() => setPaused(true)}
    >
      {!started && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">{phone.connected ? 'Phone connected' : 'Practice'}</h2>
            {phonePanel}
            <div className="card-actions">
              <button className="btn btn--primary" onClick={() => setStarted(true)}>
                Start
              </button>
              <button className="btn" onClick={() => navigate('/')}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}
      {finalTime !== null && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">Practice complete</h2>
            <p className="caps" style={{ fontSize: '2rem', margin: 0 }}>
              <span className="muted">Time </span>
              {formatRaceTime(finalTime)}
            </p>
            <div className="card-actions">
              <button className="btn btn--primary" onClick={restart}>
                Race again
              </button>
              <button className="btn" onClick={() => navigate('/')}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}
      {paused && started && finalTime === null && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">Menu</h2>
            {phonePanel}
            <div className="card-actions">
              <button className="btn btn--primary" onClick={() => setPaused(false)}>
                Resume
              </button>
              <button className="btn" onClick={restart}>
                Restart
              </button>
              <button className="btn" onClick={() => navigate('/')}>
                Quit
              </button>
            </div>
          </div>
        </div>
      )}
    </RaceStage>
  );
}
