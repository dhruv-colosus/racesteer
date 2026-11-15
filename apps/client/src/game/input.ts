import { NEUTRAL_INPUT, PAD_STALE_MS, type DriveInput } from '@racing/shared';

/**
 * Merges the two ways of driving. A paired phone wins while its input is
 * fresh; otherwise the keyboard drives.
 */
export class InputManager {
  private readonly keys = new Set<string>();
  private pad: DriveInput = { ...NEUTRAL_INPUT };
  private padAt = -Infinity;
  /** Keyboard steering is eased so a tap does not snap to full lock. */
  private keySteer = 0;
  private lastSample = performance.now();
  onKey?: (code: string) => void;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.code.startsWith('Arrow') || event.code === 'Space') event.preventDefault();
    if (!event.repeat) this.onKey?.(event.code);
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private onBlur = () => {
    this.keys.clear();
  };

  private down(...codes: string[]) {
    return codes.some((code) => this.keys.has(code));
  }

  setPadInput(input: DriveInput, now = performance.now()) {
    this.pad = input;
    this.padAt = now;
  }

  get padActive() {
    return performance.now() - this.padAt < PAD_STALE_MS;
  }

  sample(now = performance.now()): DriveInput {
    const dt = Math.min(0.1, (now - this.lastSample) / 1000);
    this.lastSample = now;

    const target = (this.down('ArrowRight', 'KeyD') ? 1 : 0) - (this.down('ArrowLeft', 'KeyA') ? 1 : 0);
    // Full lock in about a tenth of a second: quick enough to feel direct, slow enough for small corrections.
    const rate = target === 0 ? 16 : 10;
    const delta = target - this.keySteer;
    this.keySteer += Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);

    if (now - this.padAt < PAD_STALE_MS) return this.pad;
    return {
      steer: this.keySteer,
      throttle: this.down('ArrowUp', 'KeyW') ? 1 : 0,
      brake: this.down('ArrowDown', 'KeyS') ? 1 : 0,
      boost: this.down('ShiftLeft', 'ShiftRight', 'Space'),
    };
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }
}
