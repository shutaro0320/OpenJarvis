/**
 * Sentence-by-sentence speech for voice conversation.
 *
 * Feed it the reply text as it streams in; each finished sentence is sent to
 * the TTS endpoint right away (synthesis runs ahead in parallel) and played
 * in order. The first sentence can start playing while the model is still
 * writing the rest, which is what makes the conversation feel immediate.
 */
import { synthesizeSpeech } from './api';
import { toSpeakableText } from './message-text';

// End of a sentence: Japanese/Chinese full stops, ! ?, or ". " in Latin text,
// or a line break.
const SENTENCE_END = /[。．！？!?]+["」』）)]*|\.(?=\s)|\n+/g;
const MIN_CHARS = 6;

export class SentenceSpeaker {
  private consumed = 0;
  private queue: Promise<Blob | null>[] = [];
  private pumping = false;
  private finished = false;
  private stopped = false;
  private started = false;
  private audio: HTMLAudioElement | null = null;
  private url: string | null = null;
  private controller = new AbortController();
  private idleResolve: (() => void) | null = null;
  readonly idle: Promise<void>;
  /** Text that was actually sent to speech (for echo detection). */
  spokenText = '';

  constructor(private readonly onStart?: () => void) {
    this.idle = new Promise((resolve) => {
      this.idleResolve = resolve;
    });
  }

  /** Pass the whole reply so far; new complete sentences are queued. */
  update(fullText: string): void {
    if (this.stopped) return;
    const pending = fullText.slice(this.consumed);
    let cut = 0;
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END.exec(pending)) !== null) {
      const end = m.index + m[0].length;
      // The very first sentence goes out even if short ("はい。"), so audio
      // starts as early as possible; later short ones merge with the next.
      const first = this.consumed === 0 && cut === 0;
      if (first || pending.slice(cut, end).trim().length >= MIN_CHARS) {
        this.say(pending.slice(cut, end));
        cut = end;
      }
    }
    this.consumed += cut;
  }

  /** The reply is complete: speak whatever is left, then resolve `idle`. */
  finish(fullText?: string): void {
    if (fullText !== undefined && !this.stopped) {
      this.update(fullText);
      const rest = fullText.slice(this.consumed);
      this.consumed = fullText.length;
      this.say(rest);
    }
    this.finished = true;
    this.maybeIdle();
  }

  /** Speak a standalone phrase (e.g. a greeting) and finish. */
  sayAndFinish(text: string): Promise<void> {
    this.say(text);
    this.finish();
    return this.idle;
  }

  /** Stop immediately (barge-in or mode off). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    this.queue = [];
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
      this.audio = null;
    }
    this.releaseUrl();
    this.finished = true;
    this.pumping = false;
    this.maybeIdle();
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private say(raw: string): void {
    const text = toSpeakableText(raw).trim();
    if (!text || this.stopped || !/[\p{L}\p{N}]/u.test(text)) return;
    this.spokenText += text;
    this.queue.push(
      synthesizeSpeech(text, { signal: this.controller.signal }).catch(() => null),
    );
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (this.queue.length && !this.stopped) {
      const blob = await this.queue.shift()!;
      if (!blob || this.stopped) continue;
      await this.play(blob);
    }
    this.pumping = false;
    this.maybeIdle();
  }

  private play(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      this.releaseUrl();
      this.url = URL.createObjectURL(blob);
      const el = new Audio(this.url);
      this.audio = el;
      const done = () => {
        el.onended = null;
        el.onerror = null;
        resolve();
      };
      el.onended = done;
      el.onerror = done;
      el.play().then(() => {
        if (!this.started) {
          this.started = true;
          this.onStart?.();
        }
      }, done);
    });
  }

  private releaseUrl(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  private maybeIdle(): void {
    if (this.finished && !this.pumping && this.queue.length === 0) {
      this.releaseUrl();
      this.idleResolve?.();
      this.idleResolve = null;
    }
  }
}

/**
 * True when a transcript is mostly the assistant's own voice picked up by the
 * microphone (speaker echo) rather than the user talking over it.
 */
export function looksLikeEcho(transcript: string, spoken: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const t = norm(transcript);
  const s = norm(spoken);
  if (t.length < 2 || !s) return t.length < 2;
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < t.length - 1; i++) if (grams.has(t.slice(i, i + 2))) hit++;
  return hit / Math.max(1, t.length - 1) > 0.6;
}
