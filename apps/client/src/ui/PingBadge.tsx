import { latencyQuality } from '../net/useLatency';

/** Small signal-strength pill showing the round trip to the game server. */
export function PingBadge({ ms, className = '' }: { ms: number | null; className?: string }) {
  const quality = latencyQuality(ms);
  const label = ms === null ? 'Measuring connection to server' : `${ms} milliseconds round trip to server`;
  return (
    <div className={`ping ping--${quality} caps ${className}`} role="status" aria-label={label} title="Round trip to the game server">
      <span className="ping-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <b>{ms === null ? '—' : ms}</b>
      <small>ms</small>
    </div>
  );
}
