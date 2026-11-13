/**
 * Hands-free listening: record from the microphone until the speaker pauses.
 *
 * A tiny energy-based voice-activity detector: the first ~400 ms calibrate the
 * room's noise floor, speech is anything well above it, and a pause longer
 * than `silenceMs` after speech ends the take. Works in any browser with
 * MediaRecorder + Web Audio (Chrome, Edge, Safari, Firefox).
 */

export interface ListenOptions {
  signal?: AbortSignal;
  /** Pause length that ends an utterance. */
  silenceMs?: number;
  /** Give up (resolve null) if nobody speaks for this long. */
  noSpeechMs?: number;
  /** Hard cap on one utterance. */
  maxMs?: number;
  /** Optional 0..1 input level callback, for a meter. */
  onLevel?: (level: number) => void;
}

const TICK_MS = 50;
const CALIBRATE_MS = 400;
const MIN_SPEECH_MS = 250;

export async function listenOnce(opts: ListenOptions = {}): Promise<Blob | null> {
  const { signal, silenceMs = 1200, noSpeechMs = 15000, maxMs = 60000, onLevel } = opts;
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone not supported in this browser');
  }
  if (signal?.aborted) return null;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);

  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);

  return new Promise<Blob | null>((resolve) => {
    const start = performance.now();
    let floorSum = 0;
    let floorN = 0;
    let threshold = 0.02;
    let voicedMs = 0;
    let speaking = false;
    let lastVoice = start;
    let finished = false;

    const finish = (keep: boolean) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      signal?.removeEventListener('abort', onAbort);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        onLevel?.(0);
        resolve(keep && speaking && chunks.length
          ? new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          : null);
      };
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop(new Event('stop'));
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort);

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      onLevel?.(Math.min(1, rms * 10));
      const now = performance.now();
      const elapsed = now - start;

      if (elapsed < CALIBRATE_MS) {
        floorSum += rms;
        floorN += 1;
        return;
      }
      if (floorN) {
        threshold = Math.max(0.012, (floorSum / floorN) * 2.5);
        floorN = 0;
      }

      if (rms > threshold) {
        voicedMs += TICK_MS;
        if (voicedMs >= MIN_SPEECH_MS) speaking = true;
        lastVoice = now;
      } else if (!speaking) {
        voicedMs = Math.max(0, voicedMs - TICK_MS);
      }

      if (speaking && now - lastVoice > silenceMs) finish(true);
      else if (!speaking && elapsed > noSpeechMs) finish(false);
      else if (elapsed > maxMs) finish(true);
    }, TICK_MS);
  });
}

/** Two-letter language hint for speech recognition, from the browser locale. */
export function speechLanguage(): string | undefined {
  const lang = (navigator.language || '').split('-')[0].toLowerCase();
  return /^[a-z]{2}$/.test(lang) ? lang : undefined;
}
