/**
 * A tiny synthesised engine note: two detuned saws through a low-pass.
 * Browsers only allow audio after a user gesture, so this is created lazily
 * and stays silent until `resume()` succeeds.
 */
const MUTE_KEY = 'tiltrush.muted';

export class EngineAudio {
  private ctx: AudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private filter: BiquadFilterNode | null = null;
  private gain: GainNode | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* storage unavailable — default to sound on */
    }
  }

  private build() {
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return;
    const ctx = new AudioCtor();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain).connect(ctx.destination);
    for (const detune of [0, 9]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
      this.oscillators.push(osc);
    }
    this.ctx = ctx;
    this.filter = filter;
    this.gain = gain;
  }

  /** Safe to call often; does nothing until the browser allows audio. */
  resume() {
    if (!this.ctx) this.build();
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  /** @param rpm 0..1 @param load 0..1 how hard the engine is working */
  update(rpm: number, load: number) {
    if (!this.ctx || !this.gain || !this.filter || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const frequency = 55 + rpm * 190;
    for (const osc of this.oscillators) osc.frequency.setTargetAtTime(frequency, now, 0.04);
    this.filter.frequency.setTargetAtTime(380 + rpm * 1500 + load * 600, now, 0.05);
    this.gain.gain.setTargetAtTime(this.muted ? 0 : 0.035 + load * 0.035, now, 0.06);
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  dispose() {
    for (const osc of this.oscillators) osc.stop();
    this.oscillators = [];
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
