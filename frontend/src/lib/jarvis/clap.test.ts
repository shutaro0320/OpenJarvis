import { describe, expect, it } from 'vitest';
import { ClapCore } from './clap';

const RATE = 48000;
const FRAME = 1024; // analyser window
const HOP_MS = 16; // detector tick

/** Synthesise mono audio, then run the detector over it like the real loop. */
function run(signal: (t: number) => number, durationMs: number): number[] {
  const total = Math.ceil((durationMs / 1000) * RATE);
  const audio = new Float32Array(total);
  for (let i = 0; i < total; i++) audio[i] = signal(i / RATE);
  const core = new ClapCore();
  const fires: number[] = [];
  for (let ms = 0; ms < durationMs; ms += HOP_MS) {
    const end = Math.floor((ms / 1000) * RATE);
    const frame = new Float32Array(FRAME);
    for (let j = 0; j < FRAME; j++) {
      const idx = end - FRAME + j;
      frame[j] = idx >= 0 ? audio[idx] : 0;
    }
    if (core.feed(frame, ms)) fires.push(ms);
  }
  return fires;
}

// Deterministic pseudo-noise.
const noise = (t: number) => Math.sin(t * 12345.678) * Math.sin(t * 9876.543 + 1.3);
const hiss = (t: number) => 0.004 * noise(t * 3.1);

/** A clap: loud broadband burst decaying in ~15 ms. */
const clapAt = (t0: number) => (t: number) =>
  t >= t0 && t < t0 + 0.08 ? 0.9 * noise(t) * Math.exp(-(t - t0) / 0.015) : 0;

describe('ClapCore', () => {
  it('fires on two claps ~0.4s apart', () => {
    const c1 = clapAt(1.0);
    const c2 = clapAt(1.4);
    const fires = run((t) => hiss(t) + c1(t) + c2(t), 2500);
    expect(fires.length).toBe(1);
  });

  it('ignores a single clap', () => {
    const c1 = clapAt(1.0);
    expect(run((t) => hiss(t) + c1(t), 2500)).toEqual([]);
  });

  it('ignores claps too far apart', () => {
    const c1 = clapAt(1.0);
    const c2 = clapAt(2.5);
    expect(run((t) => hiss(t) + c1(t) + c2(t), 3500)).toEqual([]);
  });

  it('ignores loud sustained speech-like sound', () => {
    // Two loud 300 ms "syllables" with a fast attack, 400 ms apart.
    const syllable = (t0: number) => (t: number) =>
      t >= t0 && t < t0 + 0.3
        ? 0.7 * Math.min(1, (t - t0) / 0.005) * Math.sin(2 * Math.PI * 180 * t) * (1 + 0.3 * Math.sin(2 * Math.PI * 900 * t))
        : 0;
    const s1 = syllable(1.0);
    const s2 = syllable(1.4);
    expect(run((t) => hiss(t) + s1(t) + s2(t), 2500)).toEqual([]);
  });
});
