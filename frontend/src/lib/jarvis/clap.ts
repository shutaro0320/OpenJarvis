/**
 * Double-clap detector.
 *
 * A clap is a very sharp, loud transient that dies away within ~100 ms --
 * unlike speech, which stays loud for hundreds of milliseconds. Two claps
 * 150-800 ms apart trigger `onDoubleClap`. Runs on its own microphone stream
 * with the browser's noise suppression / AGC turned off (they flatten claps).
 *
 * It also exposes the mic's analyser so the HUD can draw the live input.
 */

export interface ClapDetectorOptions {
  onDoubleClap: () => void;
  /** 0..1, higher = needs louder claps. */
  sensitivity?: number;
}

const FRAME_MS = 16;
const DECAY_CHECK_MS = 110;
const MIN_GAP_MS = 150;
const MAX_GAP_MS = 800;
const COOLDOWN_MS = 1500;

/**
 * Pure detection logic: feed it successive audio frames (time-domain samples)
 * with timestamps; returns true on a double clap. Separate from the mic so it
 * can be tested with synthetic audio.
 */
export class ClapCore {
  private background = 0.01;
  private prevRms = 0;
  private pending: { at: number; rms: number } | null = null;
  private lastClap = 0;
  private cooldownUntil = 0;

  constructor(private readonly sensitivity = 0.5) {}

  feed(frame: Float32Array, now: number, enabled = true): boolean {
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sum += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / frame.length);
    const minPeak = 0.18 + this.sensitivity * 0.3;
    let fired = false;

    // Confirm a pending clap: it must have decayed quickly (speech does not).
    if (this.pending && now - this.pending.at >= DECAY_CHECK_MS) {
      if (rms < this.pending.rms * 0.3) fired = this.registerClap(this.pending.at);
      this.pending = null;
    }

    const onset =
      peak > minPeak
      && rms > this.background * 6
      && rms > this.prevRms * 2.5
      && !this.pending;
    if (onset && enabled && now > this.cooldownUntil) {
      this.pending = { at: now, rms };
    }

    // Slow background tracking, ignoring loud frames.
    if (rms < this.background * 3) this.background = this.background * 0.97 + rms * 0.03;
    this.background = Math.max(0.002, this.background);
    this.prevRms = rms;
    return fired;
  }

  private registerClap(at: number): boolean {
    const gap = at - this.lastClap;
    if (gap >= MIN_GAP_MS && gap <= MAX_GAP_MS) {
      this.lastClap = 0;
      this.cooldownUntil = at + COOLDOWN_MS;
      return true;
    }
    this.lastClap = at;
    return false;
  }
}

export class ClapDetector {
  readonly analyser: AnalyserNode;
  private stream: MediaStream;
  private timer: ReturnType<typeof setInterval> | null = null;
  private buf: Float32Array<ArrayBuffer>;
  private core: ClapCore;
  enabled = true;

  private constructor(ctx: AudioContext, stream: MediaStream, private opts: ClapDetectorOptions) {
    this.stream = stream;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.6;
    ctx.createMediaStreamSource(stream).connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.core = new ClapCore(opts.sensitivity);
  }

  static async start(ctx: AudioContext, opts: ClapDetectorOptions): Promise<ClapDetector> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const d = new ClapDetector(ctx, stream, opts);
    d.timer = setInterval(() => d.tick(), FRAME_MS);
    return d;
  }

  private tick(): void {
    this.analyser.getFloatTimeDomainData(this.buf);
    if (this.core.feed(this.buf, performance.now(), this.enabled)) this.opts.onDoubleClap();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream.getTracks().forEach((t) => t.stop());
  }
}
