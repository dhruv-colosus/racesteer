import { useEffect, useState } from 'react';

interface BannerProps {
  /** performance.now() at green light, or null when there is no countdown. */
  goAt: number | null;
  finished: boolean;
}

function labelFor(goAt: number | null, finished: boolean, now: number): string | null {
  if (finished) return 'FINISH';
  if (goAt === null) return null;
  const remaining = goAt - now;
  if (remaining > 3000) return 'GET READY';
  if (remaining > 0) return String(Math.ceil(remaining / 1000));
  if (remaining > -1400) return 'GO!';
  return null;
}

/** The centre-top headline: countdown, GO, FINISH. */
export function Banner({ goAt, finished }: BannerProps) {
  const [label, setLabel] = useState<string | null>(() => labelFor(goAt, finished, performance.now()));

  useEffect(() => {
    const tick = () => setLabel(labelFor(goAt, finished, performance.now()));
    tick();
    const id = window.setInterval(tick, 50);
    return () => window.clearInterval(id);
  }, [goAt, finished]);

  if (!label) return null;
  const hot = label === 'GO!' || label === 'FINISH';
  return (
    // Keyed by label so each change replays the pop-in.
    <div key={label} className={`banner${hot ? ' banner--go' : ''}`} role="status">
      <span className="stripes">
        <i />
        <i />
      </span>
      <div className="slab caps">{label}</div>
      <span className="stripes stripes--flip">
        <i />
        <i />
      </span>
    </div>
  );
}
