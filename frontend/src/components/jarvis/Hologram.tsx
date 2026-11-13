import { useEffect, useRef } from 'react';

export type HoloState =
  | 'offline'
  | 'standby'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

interface HologramProps {
  state: HoloState;
  /** Returns 0..1 magnitudes (any length) for the live audio, or null. */
  getBands: () => Float32Array | null;
}

const PALETTE: Record<HoloState, { core: string; ring: string; glow: string }> = {
  offline: { core: '#5b7a8c', ring: '#2c4a5a', glow: 'rgba(80,140,170,0.25)' },
  standby: { core: '#4fd8ff', ring: '#1d7fa6', glow: 'rgba(40,190,255,0.35)' },
  listening: { core: '#7ff3ff', ring: '#2fd0ff', glow: 'rgba(80,230,255,0.6)' },
  transcribing: { core: '#9fe9ff', ring: '#39b8f0', glow: 'rgba(90,200,255,0.5)' },
  thinking: { core: '#ffd27a', ring: '#e0a23c', glow: 'rgba(255,190,90,0.55)' },
  speaking: { core: '#d9fbff', ring: '#4ae3ff', glow: 'rgba(120,240,255,0.75)' },
  error: { core: '#ff8a7a', ring: '#c4473a', glow: 'rgba(255,100,90,0.5)' },
};

const SPIN: Record<HoloState, number> = {
  offline: 0.05,
  standby: 0.15,
  listening: 0.35,
  transcribing: 0.6,
  thinking: 1.4,
  speaking: 0.5,
  error: 0.1,
};

const BARS = 96;

export function Hologram({ state, getBands }: HologramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  const bandsRef = useRef(getBands);
  stateRef.current = state;
  bandsRef.current = getBands;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let angle = 0;
    let last = performance.now();
    let level = 0;
    const smooth = new Float32Array(BARS);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const st = stateRef.current;
      const pal = PALETTE[st];
      angle += dt * SPIN[st];

      // Audio bands -> smoothed ring + overall level.
      const raw = bandsRef.current();
      let sum = 0;
      for (let i = 0; i < BARS; i++) {
        let v = 0;
        if (raw && raw.length) {
          // Mirror so the ring is symmetric left/right.
          const k = i < BARS / 2 ? i : BARS - 1 - i;
          v = raw[Math.floor((k / (BARS / 2)) * raw.length * 0.7)] ?? 0;
        }
        smooth[i] += (v - smooth[i]) * 0.35;
        sum += smooth[i];
      }
      const target = sum / BARS;
      level += (target - level) * 0.2;
      const breathe = st === 'standby' || st === 'offline' ? 0.5 + 0.5 * Math.sin(now / 900) : 0;

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.32;

      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalCompositeOperation = 'lighter';

      // Soft halo.
      const halo = ctx.createRadialGradient(0, 0, R * 0.1, 0, 0, R * 1.6);
      halo.addColorStop(0, pal.glow);
      halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo;
      ctx.globalAlpha = 0.35 + level * 0.8 + breathe * 0.15;
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.shadowColor = pal.glow;
      ctx.shadowBlur = 14;
      ctx.strokeStyle = pal.ring;

      // Outer tick ring (counter-rotating).
      ctx.save();
      ctx.rotate(-angle * 0.4);
      for (let i = 0; i < 180; i++) {
        const a = (i / 180) * Math.PI * 2;
        const long = i % 15 === 0;
        const r1 = R * 1.22;
        const r2 = r1 + (long ? R * 0.06 : R * 0.025);
        ctx.globalAlpha = long ? 0.9 : 0.45;
        ctx.lineWidth = long ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.restore();

      // Broken arc ring.
      ctx.save();
      ctx.rotate(angle);
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.85;
      for (let i = 0; i < 3; i++) {
        const start = (i / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 1.1, start, start + Math.PI * 0.5);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([R * 0.04, R * 0.03]);
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.03, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Inner segmented ring (faster).
      ctx.save();
      ctx.rotate(-angle * 1.8);
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.6;
      for (let i = 0; i < 12; i++) {
        const start = (i / 12) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.62, start, start + Math.PI / 12);
        ctx.stroke();
      }
      ctx.restore();

      // Thinking: orbiting comet.
      if (st === 'thinking' || st === 'transcribing') {
        const a = angle * 4;
        for (let t = 0; t < 24; t++) {
          const aa = a - t * 0.04;
          ctx.globalAlpha = (1 - t / 24) * 0.9;
          ctx.fillStyle = pal.core;
          ctx.beginPath();
          ctx.arc(Math.cos(aa) * R * 0.85, Math.sin(aa) * R * 0.85, 4 - t * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Voice-reactive radial bars.
      ctx.strokeStyle = pal.core;
      ctx.lineCap = 'round';
      for (let i = 0; i < BARS; i++) {
        const a = (i / BARS) * Math.PI * 2 - Math.PI / 2;
        const v = Math.min(1, smooth[i] * 1.6);
        const len = R * (0.02 + v * 0.32) + breathe * R * 0.01;
        const r1 = R * 0.72;
        ctx.globalAlpha = 0.35 + v * 0.65;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * (r1 + len), Math.sin(a) * (r1 + len));
        ctx.stroke();
      }

      // Core.
      const coreR = R * (0.34 + level * 0.18 + breathe * 0.02);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
      core.addColorStop(0, '#ffffff');
      core.addColorStop(0.25, pal.core);
      core.addColorStop(0.7, pal.glow);
      core.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = st === 'offline' ? 0.45 : 0.95;
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, coreR, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = pal.core;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.48, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" aria-hidden />;
}
