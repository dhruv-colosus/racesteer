import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TransformMessage } from '@racing/shared';
import { Game } from '../game/Game';
import { InputManager } from '../game/input';
import { Banner } from './Banner';
import { Hud, type HudHandle } from './Hud';

export interface StageHandle {
  game: Game;
  input: InputManager;
}

interface RaceStageProps {
  trackId: string;
  laps: number;
  color: string;
  slot: number;
  /** performance.now() at green light; null holds the car on the grid. */
  goAt: number | null;
  place: number;
  total: number;
  /** Final race time once the local car is done, else null. */
  finalTimeMs: number | null;
  onReady?(handle: StageHandle): void;
  onNet?(transform: TransformMessage): void;
  onFinish?(): void;
  onImpact?(strength: number): void;
  onPause(): void;
  /** Overlays drawn above the HUD: results, pause menu. */
  children?: ReactNode;
}

/** The canvas, the game that draws into it, and the HUD on top. */
export function RaceStage(props: RaceStageProps) {
  const { trackId, laps, color, slot, goAt, place, total, finalTimeMs, onPause, children } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const hud = useRef<HudHandle>(null);
  const game = useRef<Game | null>(null);
  const [loading, setLoading] = useState(true);
  const [finished, setFinished] = useState(false);
  /** Bumped to throw the canvas and game away and build fresh ones. */
  const [build, setBuild] = useState(0);
  const [broken, setBroken] = useState(false);
  const rebuilds = useRef({ count: 0, at: 0 });

  // Always call the latest callbacks without rebuilding the game.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let disposed = false;
    const input = new InputManager();
    const element = canvas.current!;
    setLoading(true);
    setFinished(false);
    setBroken(false);

    /**
     * The 3D view failed (no WebGL, the GPU dropped the context, the simulation
     * keeps throwing). Rebuild it from scratch a couple of times on its own,
     * then stop and offer a button rather than loop forever.
     */
    const fail = (error: unknown) => {
      if (disposed) return;
      console.error('[stage] rebuilding after failure', error);
      const now = performance.now();
      const state = rebuilds.current;
      if (now - state.at > 30_000) state.count = 0;
      state.at = now;
      if (++state.count > 2) setBroken(true);
      else setBuild((n) => n + 1);
    };
    const onContextLost = (event: Event) => {
      event.preventDefault();
      fail(new Error('WebGL context lost'));
    };
    element.addEventListener('webglcontextlost', onContextLost);

    Game.create({
      canvas: element,
      trackId,
      laps,
      color,
      slot,
      input,
      onFrame: (frame) => hud.current?.frame(frame),
      onNet: (transform) => latest.current.onNet?.(transform),
      onFinish: () => {
        setFinished(true);
        latest.current.onFinish?.();
      },
      onImpact: (strength) => latest.current.onImpact?.(strength),
      onCrash: fail,
    }).then((created) => {
      if (disposed) {
        created.dispose();
        return;
      }
      game.current = created;
      created.goAt = latest.current.goAt ?? Infinity;
      hud.current?.setTrack(created.path);
      created.start();
      setLoading(false);
      latest.current.onReady?.({ game: created, input });
    }, fail);

    return () => {
      disposed = true;
      element.removeEventListener('webglcontextlost', onContextLost);
      input.dispose();
      game.current?.dispose();
      game.current = null;
    };
  }, [trackId, laps, color, slot, build]);

  useEffect(() => {
    if (game.current) game.current.goAt = goAt ?? Infinity;
  }, [goAt]);

  return (
    <div className="stage" onPointerDown={() => game.current?.enableAudio()}>
      {/* Keyed so a rebuild gets a brand-new canvas: a lost WebGL context cannot be reused. */}
      <canvas key={build} ref={canvas} />
      <Hud ref={hud} place={place} total={total} color={color} goAt={goAt} finalTimeMs={finalTimeMs} onPause={onPause} />
      <div className="hud">
        <Banner goAt={goAt} finished={finished} />
      </div>
      {loading && !broken && <div className="loading caps">Loading track…</div>}
      {broken && (
        <div className="overlay">
          <div className="card">
            <h2 className="caps">Graphics stopped</h2>
            <p className="muted">The 3D view could not be restarted automatically. Your place in the room is kept.</p>
            <div className="card-actions">
              <button
                className="btn btn--primary"
                onClick={() => {
                  rebuilds.current.count = 0;
                  setBuild((n) => n + 1);
                }}
              >
                Try again
              </button>
              <button className="btn" onClick={() => window.location.reload()}>
                Reload page
              </button>
            </div>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
