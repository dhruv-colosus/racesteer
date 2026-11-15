import { useCallback, useRef, useState } from 'react';
import { CAR_COLORS, COUNTDOWN_MS, DEFAULT_LAPS, TRACKS, formatRaceTime } from '@racing/shared';
import { navigate } from '../router';
import { RaceStage } from '../ui/RaceStage';

/** Practice on your own — no server involved. */
export function Solo() {
  // Bumping the run number remounts the stage for a clean restart.
  const [run, setRun] = useState(0);
  const [goAt, setGoAt] = useState<number | null>(null);
  const [finalTime, setFinalTime] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const goAtRef = useRef<number | null>(null);

  const onReady = useCallback(() => {
    const at = performance.now() + COUNTDOWN_MS;
    goAtRef.current = at;
    setGoAt(at);
  }, []);

  const onFinish = useCallback(() => {
    if (goAtRef.current !== null) setFinalTime(performance.now() - goAtRef.current);
  }, []);

  const restart = () => {
    goAtRef.current = null;
    setGoAt(null);
    setFinalTime(null);
    setPaused(false);
    setRun((n) => n + 1);
  };

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
      onPause={() => setPaused(true)}
    >
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
      {paused && finalTime === null && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">Menu</h2>
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
