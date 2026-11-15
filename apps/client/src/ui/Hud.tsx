import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from 'react';
import { formatRaceTime, type TrackPath } from '@racing/shared';
import type { HudFrame } from '../game/Game';

export interface HudHandle {
  /** Called every rendered frame. Writes straight to the DOM — no React render. */
  frame(frame: HudFrame): void;
  /** Give the minimap its track outline. */
  setTrack(path: TrackPath): void;
}

interface HudProps {
  ref: Ref<HudHandle>;
  place: number;
  total: number;
  color: string;
  /** performance.now() when the race went/goes live, or null before a countdown exists. */
  goAt: number | null;
  /** Race time to freeze on once the local car has finished. */
  finalTimeMs: number | null;
  onPause(): void;
}

const DIAL_START = -135;
const DIAL_SWEEP = 270;
const MAP_SIZE = 176;

function polar(angleDeg: number, radius: number) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: 100 + Math.cos(a) * radius, y: 100 + Math.sin(a) * radius };
}

export function Hud({ ref, place, total, color, goAt, finalTimeMs, onPause }: HudProps) {
  const speed = useRef<HTMLSpanElement>(null);
  const needle = useRef<SVGGElement>(null);
  const gear = useRef<SVGTextElement>(null);
  const progress = useRef<HTMLElement>(null);
  const lap = useRef<HTMLElement>(null);
  const time = useRef<HTMLElement>(null);
  const boost = useRef<HTMLDivElement>(null);
  const boostFill = useRef<HTMLDivElement>(null);
  const warning = useRef<HTMLDivElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const map = useRef<HTMLCanvasElement>(null);
  const mapBase = useRef<{ image: HTMLCanvasElement; project(x: number, z: number): [number, number] } | null>(null);
  const timing = useRef({ goAt, finalTimeMs });
  timing.current = { goAt, finalTimeMs };
  const colorRef = useRef(color);
  colorRef.current = color;

  // Only touch the DOM when the text actually changes.
  const last = useRef<Record<string, string>>({});
  const setText = (key: string, node: { textContent: string | null } | null, value: string) => {
    if (!node || last.current[key] === value) return;
    last.current[key] = value;
    node.textContent = value;
  };

  useImperativeHandle(ref, () => ({
    setTrack(path) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const size = MAP_SIZE * dpr;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < path.n; i++) {
        minX = Math.min(minX, path.x[i]!);
        maxX = Math.max(maxX, path.x[i]!);
        minZ = Math.min(minZ, path.z[i]!);
        maxZ = Math.max(maxZ, path.z[i]!);
      }
      const scale = (size * 0.72) / Math.max(maxX - minX, maxZ - minZ);
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const project = (x: number, z: number): [number, number] => [size / 2 + (x - cx) * scale, size / 2 + (z - cz) * scale];

      const image = document.createElement('canvas');
      image.width = image.height = size;
      const ctx = image.getContext('2d')!;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= path.n; i++) {
        const [px, py] = project(path.x[i % path.n]!, path.z[i % path.n]!);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(248, 250, 252, 0.95)';
      ctx.lineWidth = 7 * dpr;
      ctx.stroke();
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 4 * dpr;
      ctx.stroke();
      // Start line tick
      const [sx, sy] = project(path.x[0]!, path.z[0]!);
      ctx.fillStyle = '#ff2d78';
      ctx.fillRect(sx - 2 * dpr, sy - 6 * dpr, 4 * dpr, 12 * dpr);

      mapBase.current = { image, project };
      if (map.current) map.current.width = map.current.height = size;
    },

    frame(f) {
      setText('speed', speed.current, String(Math.round(f.speedKmh)));
      setText('gear', gear.current, String(f.gear));
      setText('progress', progress.current, `${Math.floor(f.progress * 100)}%`);
      setText('lap', lap.current, `${f.lap}/${f.laps}`);

      const { goAt: go, finalTimeMs: final } = timing.current;
      const elapsed = final ?? (go === null ? 0 : Math.max(0, performance.now() - go));
      setText('time', time.current, formatRaceTime(elapsed).slice(0, -1));

      needle.current?.setAttribute('transform', `rotate(${DIAL_START + f.rpm * DIAL_SWEEP} 100 100)`);
      if (boostFill.current) boostFill.current.style.transform = `scaleY(${f.boost.toFixed(3)})`;
      boost.current?.classList.toggle('boost--active', f.boosting);
      if (warning.current) warning.current.hidden = !f.wrongWay;
      setText('hint', hint.current, f.padActive ? 'PHONE CONNECTED — TILT TO STEER' : 'WASD / ARROWS · SHIFT BOOST · R RESET · M MUTE');

      const base = mapBase.current;
      const canvas = map.current;
      if (base && canvas) {
        const ctx = canvas.getContext('2d')!;
        const dpr = canvas.width / MAP_SIZE;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(base.image, 0, 0);
        for (const other of f.others) {
          const [x, y] = base.project(other.x, other.z);
          ctx.beginPath();
          ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
          ctx.fillStyle = other.color;
          ctx.fill();
        }
        const [x, y] = base.project(f.x, f.z);
        ctx.beginPath();
        ctx.arc(x, y, 6.5 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = colorRef.current;
        ctx.fill();
        ctx.lineWidth = 2.5 * dpr;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    },
  }));

  useEffect(() => {
    last.current = {};
  }, []);

  const ticks = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => {
        const angle = DIAL_START + (i / 9) * DIAL_SWEEP;
        const outer = polar(angle, 88);
        const inner = polar(angle, 76);
        const label = polar(angle, 62);
        return { i, outer, inner, label };
      }),
    [],
  );

  return (
    <div className="hud">
      <button className="hud-pause" onClick={onPause} aria-label="Pause menu">
        <i />
        <i />
      </button>

      <div className="hud-chips">
        <div className="slab chip">
          <span>Progress</span>
          <b ref={progress}>0%</b>
        </div>
        <div className="slab chip">
          <span>Position</span>
          <b>
            <span className="accent">{place || '–'}</span>/{total}
          </b>
        </div>
        <div className="slab chip chip--small">
          <span>Lap</span>
          <b ref={lap}>1/1</b>
        </div>
        <div className="slab chip chip--small">
          <span>Time</span>
          <b ref={time}>0:00.00</b>
        </div>
      </div>

      <div className="hud-warning caps" ref={warning} hidden>
        Wrong way
      </div>

      <div className="hud-left">
        <canvas className="minimap" ref={map} width={MAP_SIZE} height={MAP_SIZE} />
        <div className="boost caps" ref={boost}>
          <div className="boost-track">
            <div className="boost-fill" ref={boostFill} />
          </div>
          Boost
        </div>
      </div>

      <div className="slab hud-hint caps" ref={hint} />

      <div className="speedo">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <path
            d={`M ${polar(DIAL_START, 88).x} ${polar(DIAL_START, 88).y} A 88 88 0 1 1 ${polar(DIAL_START + DIAL_SWEEP, 88).x} ${polar(DIAL_START + DIAL_SWEEP, 88).y}`}
            fill="rgba(30,41,59,0.55)"
            stroke="#f8fafc"
            strokeWidth="3"
          />
          <path
            d={`M ${polar(DIAL_START + 0.8 * DIAL_SWEEP, 88).x} ${polar(DIAL_START + 0.8 * DIAL_SWEEP, 88).y} A 88 88 0 0 1 ${polar(DIAL_START + DIAL_SWEEP, 88).x} ${polar(DIAL_START + DIAL_SWEEP, 88).y}`}
            fill="none"
            stroke="#ff2d78"
            strokeWidth="5"
          />
          {ticks.map(({ i, outer, inner, label }) => (
            <g key={i}>
              <line x1={outer.x} y1={outer.y} x2={inner.x} y2={inner.y} stroke="#f8fafc" strokeWidth="3" />
              <text
                x={label.x}
                y={label.y}
                fill="#f8fafc"
                fontSize="17"
                fontWeight="700"
                fontStyle="italic"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {i}
              </text>
            </g>
          ))}
          <text ref={gear} x="100" y="100" fill="#f8fafc" fontSize="30" fontWeight="800" fontStyle="italic" textAnchor="middle" dominantBaseline="central">
            1
          </text>
          <g ref={needle} transform={`rotate(${DIAL_START} 100 100)`}>
            <line x1="100" y1="78" x2="100" y2="16" stroke="#ff2d78" strokeWidth="4" strokeLinecap="round" />
          </g>
        </svg>
        <div className="speedo-value">
          <span ref={speed}>0</span>
          <small className="caps">km/h</small>
        </div>
      </div>
    </div>
  );
}
