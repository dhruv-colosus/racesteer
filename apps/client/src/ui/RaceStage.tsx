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

  // Always call the latest callbacks without rebuilding the game.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let disposed = false;
    const input = new InputManager();
    setLoading(true);
    setFinished(false);

    Game.create({
      canvas: canvas.current!,
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
    });

    return () => {
      disposed = true;
      input.dispose();
      game.current?.dispose();
      game.current = null;
    };
  }, [trackId, laps, color, slot]);

  useEffect(() => {
    if (game.current) game.current.goAt = goAt ?? Infinity;
  }, [goAt]);

  return (
    <div className="stage" onPointerDown={() => game.current?.enableAudio()}>
      <canvas ref={canvas} />
      <Hud ref={hud} place={place} total={total} color={color} goAt={goAt} finalTimeMs={finalTimeMs} onPause={onPause} />
      <div className="hud">
        <Banner goAt={goAt} finished={finished} />
      </div>
      {loading && <div className="loading caps">Loading track…</div>}
      {children}
    </div>
  );
}
