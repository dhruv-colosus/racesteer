import { useEffect, useState } from 'react';
import type { GameRoom } from './client';

/** How often to measure. Each ping is one byte each way, so this costs nothing. */
const PING_EVERY_MS = 2000;
/** No answer this long after a ping means the link is stalled, even if the socket has not noticed yet. */
const STALE_AFTER_MS = 5000;
/** Samples kept; the median of these is shown so one slow packet does not make the number jump. */
const WINDOW = 5;

/**
 * Round-trip time between this screen and the game server, in milliseconds.
 * Uses the Colyseus protocol-level ping, which the server answers straight
 * from its socket handler: it rides the same WebSocket as the car updates, so
 * it is the delay those updates actually see. Null until the first answer,
 * and again whenever the server stops answering.
 */
export function useLatency(room: GameRoom | null, live: boolean): number | null {
  const [latency, setLatency] = useState<number | null>(null);

  useEffect(() => {
    setLatency(null);
    if (!room || !live) return;
    const samples: number[] = [];
    let lastAnswer = performance.now();
    let stopped = false;

    const measure = () => {
      if (performance.now() - lastAnswer > STALE_AFTER_MS) {
        samples.length = 0;
        setLatency(null);
      }
      room.ping((ms) => {
        if (stopped) return;
        lastAnswer = performance.now();
        samples.push(ms);
        if (samples.length > WINDOW) samples.shift();
        const sorted = [...samples].sort((a, b) => a - b);
        setLatency(sorted[Math.floor(sorted.length / 2)]!);
      });
    };

    measure();
    const timer = window.setInterval(measure, PING_EVERY_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [room, live]);

  return latency;
}

export type LatencyQuality = 'good' | 'fair' | 'poor' | 'none';

export function latencyQuality(ms: number | null): LatencyQuality {
  if (ms === null) return 'none';
  if (ms < 80) return 'good';
  if (ms < 160) return 'fair';
  return 'poor';
}
