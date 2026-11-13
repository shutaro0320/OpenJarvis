/**
 * JARVIS -- full-screen holographic voice interface.
 *
 * Always on: after one click to grant the microphone, it waits in standby
 * until it hears a double clap or its name, then converses hands-free and
 * returns to standby when things go quiet. The "brain" is pluggable (see
 * server/jarvis_routes.py): OpenJarvis models, Hermes Agent, OpenClaw, or any
 * OpenAI-compatible endpoint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Maximize2, Minimize2, Settings2, X, LogOut, Power } from 'lucide-react';
import { Hologram, type HoloState } from '../components/jarvis/Hologram';
import { ClapDetector } from '../lib/jarvis/clap';
import {
  fetchJarvisConfig,
  saveJarvisConfig,
  streamBrain,
  type ChatTurn,
  type JarvisConfig,
} from '../lib/jarvis/api';
import { listenOnce, speechLanguage } from '../lib/voice-listen';
import { SentenceSpeaker, looksLikeEcho } from '../lib/voice-speaker';
import { transcribeAudio } from '../lib/api';

const STATUS: Record<HoloState, string> = {
  offline: 'OFFLINE',
  standby: 'STANDBY',
  listening: 'LISTENING',
  transcribing: 'PROCESSING',
  thinking: 'THINKING',
  speaking: 'SPEAKING',
  error: 'ERROR',
};

const STATUS_JA: Record<HoloState, string> = {
  offline: 'クリックして起動',
  standby: '待機中 ― 手を2回叩くか「ジャービス」と呼んでください',
  listening: 'お話しください',
  transcribing: '聞き取り中…',
  thinking: '考えています…',
  speaking: '応答中（話しかけると止まります）',
  error: 'エラー',
};

const BASE_WAKE = /(ジャ[ー〜]?[ビヴ][ィイ]?[スズ]|じゃ[ー〜]?[びゔ]い?す|ジャーベス|ジャービー|jarvis)/i;
const END_PHRASE = /^(おやすみ(なさい)?|終わり|おわり|終了|以上|さようなら|もう大丈夫|ストップ)(です)?$/;
const ACTIVE_TIMEOUT_MS = 20000;
const PUNCT = /[\s、。,.!！?？]/g;

function wakeRegex(words: string[]): RegExp {
  const extra = words
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return extra.length
    ? new RegExp(`${BASE_WAKE.source}|${extra.join('|')}`, 'i')
    : BASE_WAKE;
}

export function JarvisPage() {
  const [phase, setPhase] = useState<HoloState>('offline');
  const [userText, setUserText] = useState('');
  const [replyText, setReplyText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [config, setConfig] = useState<JarvisConfig | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [clock, setClock] = useState(() => new Date());

  const runningRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const clapRef = useRef<ClapDetector | null>(null);
  const outAnalyserRef = useRef<AnalyserNode | null>(null);
  const speakerRef = useRef<SentenceSpeaker | null>(null);
  const listenAbortRef = useRef<AbortController | null>(null);
  const brainAbortRef = useRef<AbortController | null>(null);
  const stageRef = useRef<'standby' | 'active'>('standby');
  const clapWakeRef = useRef(false);
  const phaseRef = useRef<HoloState>('offline');
  const configRef = useRef<JarvisConfig | null>(null);
  const historyRef = useRef<ChatTurn[]>([]);
  const bandBuf = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const bandOut = useRef<Float32Array | null>(null);

  const setP = useCallback((p: HoloState) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  useEffect(() => {
    fetchJarvisConfig()
      .then((c) => {
        setConfig(c);
        configRef.current = c;
      })
      .catch((e) => setErrorText(`設定を読み込めません: ${e instanceof Error ? e.message : e}`));
    const t = setInterval(() => setClock(new Date()), 1000);
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      clearInterval(t);
      document.removeEventListener('fullscreenchange', onFs);
    };
  }, []);

  // Live audio for the hologram: JARVIS's voice while speaking, else the mic.
  const getBands = useCallback((): Float32Array | null => {
    const speaking = phaseRef.current === 'speaking';
    const analyser = speaking ? outAnalyserRef.current : clapRef.current?.analyser;
    if (!analyser) return null;
    const n = analyser.frequencyBinCount;
    if (!bandBuf.current || bandBuf.current.length !== n) {
      bandBuf.current = new Uint8Array(n);
      bandOut.current = new Float32Array(n);
    }
    analyser.getByteFrequencyData(bandBuf.current);
    const out = bandOut.current!;
    const gain = speaking ? 1 : 1.6;
    for (let i = 0; i < n; i++) out[i] = Math.min(1, (bandBuf.current[i] / 255) * gain);
    return out;
  }, []);

  const newSpeaker = useCallback(
    (onStart?: () => void) =>
      new SentenceSpeaker(
        () => {
          setP('speaking');
          onStart?.();
        },
        (el) => {
          const ctx = ctxRef.current;
          const out = outAnalyserRef.current;
          if (!ctx || !out) return;
          try {
            ctx.createMediaElementSource(el).connect(out);
          } catch {
            // Visualisation only; playback continues regardless.
          }
        },
      ),
    [setP],
  );

  const say = useCallback(
    async (phrase: string) => {
      const sp = newSpeaker();
      speakerRef.current = sp;
      setReplyText(phrase);
      await sp.sayAndFinish(phrase);
      speakerRef.current = null;
    },
    [newSpeaker],
  );

  const runLoop = useCallback(async () => {
    let pending: Blob | null = null;
    let echoOf = '';

    const listen = (opts: Parameters<typeof listenOnce>[0]) => {
      const ac = new AbortController();
      listenAbortRef.current = ac;
      return listenOnce({ signal: ac.signal, ...opts });
    };

    while (runningRef.current) {
      const cfg = configRef.current;
      const wakeWord = cfg?.wake.word ?? true;

      // Woken by a double clap while in standby.
      if (clapWakeRef.current) {
        clapWakeRef.current = false;
        stageRef.current = 'active';
        await say('はい、お呼びでしょうか。');
        continue;
      }

      let blob: Blob | null = pending;
      pending = null;
      const echoCheck = echoOf;
      echoOf = '';
      if (!blob) {
        const standby = stageRef.current === 'standby';
        setP(standby ? 'standby' : 'listening');
        if (standby && !wakeWord) {
          // Clap-only mode: idle until a clap flips the flag.
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        try {
          blob = await listen(standby
            ? { noSpeechMs: 60000, silenceMs: 900 }
            : { noSpeechMs: ACTIVE_TIMEOUT_MS });
        } catch (e) {
          setErrorText(e instanceof Error ? e.message : 'マイクを使えません');
          setP('error');
          runningRef.current = false;
          break;
        }
        if (!runningRef.current) break;
        if (!blob) {
          if (!clapWakeRef.current && stageRef.current === 'active') {
            stageRef.current = 'standby';
            setUserText('');
          }
          continue;
        }
      }

      setP('transcribing');
      let text = '';
      try {
        text = (await transcribeAudio(blob, 'voice.webm', speechLanguage())).text.trim();
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : '音声認識に失敗しました');
        continue;
      }
      if (!runningRef.current) break;
      if (!text || (echoCheck && looksLikeEcho(text, echoCheck))) continue;

      if (stageRef.current === 'standby') {
        const m = wakeRegex(cfg?.wake.words ?? []).exec(text);
        if (!m) continue;
        stageRef.current = 'active';
        const rest = text.slice(m.index + m[0].length).replace(/^[\s、。,.!！?？]+/, '');
        if (rest.replace(PUNCT, '').length < 2) {
          await say('はい、お呼びでしょうか。');
          continue;
        }
        text = rest;
      }
      setUserText(text);
      if (END_PHRASE.test(text.replace(PUNCT, ''))) {
        await say('かしこまりました。また何かあればお呼びください。');
        stageRef.current = 'standby';
        continue;
      }

      // ---- One turn with the brain.
      setP('thinking');
      setReplyText('');
      setErrorText('');
      const barge: { hit: boolean; promise: Promise<Blob | null> | null } = { hit: false, promise: null };
      const bargeAc = new AbortController();
      const brainAc = new AbortController();
      brainAbortRef.current = brainAc;
      const speaker: SentenceSpeaker = newSpeaker(() => {
        barge.promise = listenOnce({
          signal: bargeAc.signal,
          minSpeechMs: 400,
          thresholdFactor: 3,
          noSpeechMs: 10 * 60 * 1000,
          onSpeechStart: () => {
            barge.hit = true;
            speaker.stop();
            brainAc.abort();
            setP('listening');
          },
        }).catch(() => null);
      });
      speakerRef.current = speaker;

      const turns = Math.max(0, cfg?.history_turns ?? 10) * 2;
      const history = historyRef.current.slice(-turns);
      let full = '';
      try {
        for await (const delta of streamBrain([...history, { role: 'user', content: text }], brainAc.signal)) {
          full += delta;
          setReplyText(full);
          speaker.update(full);
        }
      } catch (e) {
        if (!barge.hit && !(e instanceof DOMException && e.name === 'AbortError')) {
          const msg = e instanceof Error ? e.message : String(e);
          setErrorText(msg);
          setP('error');
          full = '';
          speaker.finish('申し訳ありません。頭脳に接続できませんでした。');
        }
      }
      if (full) {
        historyRef.current = [
          ...historyRef.current,
          { role: 'user' as const, content: text },
          { role: 'assistant' as const, content: full },
        ].slice(-40);
      }
      if (!barge.hit) speaker.finish(full || undefined);
      await speaker.idle;
      speakerRef.current = null;
      brainAbortRef.current = null;
      if (barge.hit && barge.promise) {
        pending = await barge.promise;
        echoOf = speaker.spokenText;
      } else {
        bargeAc.abort();
        if (barge.promise) await barge.promise;
      }
    }
  }, [newSpeaker, say, setP]);

  const boot = useCallback(async () => {
    if (runningRef.current) return;
    setErrorText('');
    try {
      const Ctx: typeof AudioContext =
        window.AudioContext
        ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = ctxRef.current ?? new Ctx();
      ctxRef.current = ctx;
      await ctx.resume();
      if (!outAnalyserRef.current) {
        const out = ctx.createAnalyser();
        out.fftSize = 512;
        out.smoothingTimeConstant = 0.7;
        out.connect(ctx.destination);
        outAnalyserRef.current = out;
      }
      clapRef.current = await ClapDetector.start(ctx, {
        onDoubleClap: () => {
          const st = phaseRef.current;
          if (st === 'speaking') {
            speakerRef.current?.stop(); // clap to cut JARVIS short
          } else if (stageRef.current === 'standby' && (configRef.current?.wake.clap ?? true)) {
            clapWakeRef.current = true;
            listenAbortRef.current?.abort();
          }
        },
      });
    } catch (e) {
      setErrorText(`マイクを使えません: ${e instanceof Error ? e.message : e}`);
      setP('error');
      return;
    }
    try {
      await (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<unknown> } })
        .wakeLock?.request('screen');
    } catch {
      // Optional: keeps the screen on where supported.
    }
    runningRef.current = true;
    stageRef.current = 'standby';
    void (async () => {
      await say('システム起動。待機します。');
      setReplyText('');
      await runLoop();
    })();
  }, [runLoop, say, setP]);

  const shutdown = useCallback(() => {
    runningRef.current = false;
    listenAbortRef.current?.abort();
    brainAbortRef.current?.abort();
    speakerRef.current?.stop();
    clapRef.current?.stop();
    clapRef.current = null;
    setP('offline');
    setUserText('');
    setReplyText('');
  }, [setP]);

  useEffect(() => () => shutdown(), [shutdown]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (showSettings) return;
      if (e.key === 'f' || e.key === 'F') toggleFullscreen();
      if (e.key === ' ' && phaseRef.current === 'offline') {
        e.preventDefault();
        void boot();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boot, showSettings]);

  const brainLabel = config
    ? `${config.presets[config.brain.preset]?.label ?? config.brain.preset} · ${config.brain.model || '—'}`
    : '';

  return (
    <div
      className="fixed inset-0 overflow-hidden select-none"
      style={{
        background: 'radial-gradient(ellipse at center, #06202e 0%, #020b12 55%, #000 100%)',
        color: '#9fe9ff',
        fontFamily: "'Rajdhani', 'Orbitron', 'Segoe UI', 'Hiragino Sans', system-ui, sans-serif",
      }}
    >
      {/* Grid + scanlines */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'linear-gradient(rgba(80,200,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(80,200,255,0.06) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 75%)',
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)',
        }}
      />

      <Hologram state={phase} getBands={getBands} />

      {/* Top-left: identity */}
      <div className="absolute top-5 left-6 text-xs tracking-[0.3em] leading-relaxed" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="text-lg tracking-[0.5em]" style={{ color: '#d9fbff', textShadow: '0 0 12px #2fd0ff' }}>
          J.A.R.V.I.S
        </div>
        <div style={{ opacity: 0.7 }}>VOICE INTERFACE</div>
        <div className="mt-2 normal-case tracking-normal" style={{ opacity: 0.6 }}>{brainLabel}</div>
      </div>

      {/* Top-right: clock + controls */}
      <div className="absolute top-5 right-6 flex flex-col items-end gap-2" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="text-2xl tabular-nums tracking-widest" style={{ color: '#d9fbff', textShadow: '0 0 10px #2fd0ff' }}>
          {clock.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </div>
        <div className="text-xs tracking-widest" style={{ opacity: 0.6 }}>
          {clock.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })}
        </div>
        <div className="flex gap-1 mt-1">
          <HudButton title="設定" onClick={() => setShowSettings(true)}><Settings2 size={16} /></HudButton>
          <HudButton title="全画面（F）" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </HudButton>
          {phase !== 'offline' && (
            <HudButton title="停止" onClick={shutdown}><Power size={16} /></HudButton>
          )}
          <Link to="/" title="チャット画面へ" className="p-2 rounded-md" style={{ border: '1px solid rgba(80,200,255,0.3)', color: '#9fe9ff' }}>
            <LogOut size={16} />
          </Link>
        </div>
      </div>

      {/* Status */}
      <div className="absolute left-0 right-0 text-center" style={{ top: '9%' }}>
        <div className="text-sm tracking-[0.6em]" style={{ color: phase === 'thinking' ? '#ffd27a' : phase === 'error' ? '#ff8a7a' : '#7ff3ff', textShadow: '0 0 10px currentColor' }}>
          {STATUS[phase]}
        </div>
        <div className="mt-1 text-xs" style={{ opacity: 0.65 }}>{STATUS_JA[phase]}</div>
      </div>

      {/* Boot */}
      {phase === 'offline' && (
        <button
          type="button"
          onClick={() => void boot()}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full cursor-pointer"
          style={{ width: '22vmin', height: '22vmin', background: 'transparent', border: 'none' }}
          aria-label="ジャービスを起動"
        />
      )}

      {/* Subtitles */}
      <div className="absolute left-0 right-0 px-6 text-center" style={{ bottom: 'calc(6% + env(safe-area-inset-bottom, 0px))' }}>
        {userText && (
          <div className="text-sm mb-2" style={{ opacity: 0.6 }}>
            ▸ {userText}
          </div>
        )}
        {replyText && (
          <div
            className="mx-auto max-w-3xl text-lg leading-relaxed"
            style={{ color: '#e6fdff', textShadow: '0 0 12px rgba(47,208,255,0.8)' }}
          >
            {replyText}
          </div>
        )}
        {errorText && (
          <div className="mt-2 text-xs" style={{ color: '#ff9c8f' }}>{errorText}</div>
        )}
      </div>

      {showSettings && config && (
        <SettingsPanel
          config={config}
          onClose={() => setShowSettings(false)}
          onSaved={(c) => {
            setConfig(c);
            configRef.current = c;
            historyRef.current = [];
          }}
        />
      )}
    </div>
  );
}

function HudButton({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="p-2 rounded-md cursor-pointer transition-colors"
      style={{ border: '1px solid rgba(80,200,255,0.3)', color: '#9fe9ff', background: 'rgba(0,30,45,0.4)' }}
    >
      {children}
    </button>
  );
}

function SettingsPanel({
  config,
  onClose,
  onSaved,
}: {
  config: JarvisConfig;
  onClose: () => void;
  onSaved: (c: JarvisConfig) => void;
}) {
  const [preset, setPreset] = useState(config.brain.preset);
  const [baseUrl, setBaseUrl] = useState(config.brain.base_url);
  const [model, setModel] = useState(config.brain.model);
  const [apiKey, setApiKey] = useState('');
  const [extra, setExtra] = useState(JSON.stringify(config.brain.extra_body ?? {}));
  const [sendPersona, setSendPersona] = useState(config.brain.send_persona);
  const [persona, setPersona] = useState(config.persona);
  const [clap, setClap] = useState(config.wake.clap);
  const [word, setWord] = useState(config.wake.word);
  const [words, setWords] = useState(config.wake.words.join(', '));
  const [status, setStatus] = useState('');

  const applyPreset = (key: string) => {
    setPreset(key);
    const p = config.presets[key];
    if (p) {
      setBaseUrl(p.base_url);
      setModel(p.model);
      setExtra(JSON.stringify(p.extra_body ?? {}));
    }
  };

  const save = async () => {
    let extraBody: Record<string, unknown>;
    try {
      extraBody = extra.trim() ? JSON.parse(extra) : {};
    } catch {
      setStatus('追加パラメータ（JSON）の形式が正しくありません');
      return;
    }
    try {
      const saved = await saveJarvisConfig({
        brain: {
          preset,
          base_url: baseUrl.trim(),
          model: model.trim(),
          extra_body: extraBody,
          send_persona: sendPersona,
          ...(apiKey ? { api_key: apiKey } : {}),
        },
        persona,
        wake: {
          clap,
          word,
          words: words.split(/[,、]/).map((w) => w.trim()).filter(Boolean),
        },
      });
      onSaved(saved);
      setApiKey('');
      setStatus('保存しました');
    } catch (e) {
      setStatus(`保存できません: ${e instanceof Error ? e.message : e}`);
    }
  };

  const field = 'w-full rounded-md px-3 py-2 text-sm outline-none';
  const fieldStyle = { background: 'rgba(0,25,38,0.9)', border: '1px solid rgba(80,200,255,0.35)', color: '#d9fbff' };
  const label = 'block text-xs tracking-widest mb-1 mt-4';

  return (
    <div className="absolute inset-0 flex justify-end" style={{ background: 'rgba(0,0,0,0.45)' }} onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto px-6 py-6"
        style={{ background: 'rgba(2,16,24,0.96)', borderLeft: '1px solid rgba(80,200,255,0.3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="tracking-[0.4em] text-sm" style={{ color: '#d9fbff' }}>SETTINGS</div>
          <button type="button" onClick={onClose} className="p-1 cursor-pointer" style={{ color: '#9fe9ff' }} aria-label="閉じる">
            <X size={18} />
          </button>
        </div>

        <div className="mt-4 text-xs" style={{ opacity: 0.7 }}>頭脳（会話を考えるAI）</div>
        <label className={label}>種類</label>
        <select className={field} style={fieldStyle} value={preset} onChange={(e) => applyPreset(e.target.value)}>
          {Object.entries(config.presets).map(([key, p]) => (
            <option key={key} value={key}>{p.label}</option>
          ))}
        </select>
        <label className={label}>URL（空欄＝このPCのOpenJarvis）</label>
        <input className={field} style={fieldStyle} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:8642/v1" />
        <label className={label}>モデル</label>
        <input className={field} style={fieldStyle} value={model} onChange={(e) => setModel(e.target.value)} />
        <label className={label}>APIキー／トークン</label>
        <input
          className={field}
          style={fieldStyle}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={config.brain.has_api_key ? '設定済み（変更する場合のみ入力）' : '不要なら空欄'}
          autoComplete="off"
        />
        <label className={label}>追加パラメータ（JSON）</label>
        <input className={field} style={fieldStyle} value={extra} onChange={(e) => setExtra(e.target.value)} />
        <label className="flex items-center gap-2 mt-4 text-sm">
          <input type="checkbox" checked={sendPersona} onChange={(e) => setSendPersona(e.target.checked)} />
          ジャービスの人格・話し方を頭脳に伝える
        </label>

        <div className="mt-6 text-xs" style={{ opacity: 0.7 }}>起動方法</div>
        <label className="flex items-center gap-2 mt-3 text-sm">
          <input type="checkbox" checked={clap} onChange={(e) => setClap(e.target.checked)} />
          手を2回叩いて起動
        </label>
        <label className="flex items-center gap-2 mt-2 text-sm">
          <input type="checkbox" checked={word} onChange={(e) => setWord(e.target.checked)} />
          名前を呼んで起動
        </label>
        <label className={label}>呼び名（カンマ区切り）</label>
        <input className={field} style={fieldStyle} value={words} onChange={(e) => setWords(e.target.value)} />

        <label className={label}>人格・話し方</label>
        <textarea className={field} style={fieldStyle} rows={6} value={persona} onChange={(e) => setPersona(e.target.value)} />

        <button
          type="button"
          onClick={() => void save()}
          className="mt-6 w-full rounded-md py-2 text-sm tracking-widest cursor-pointer"
          style={{ background: 'rgba(47,208,255,0.2)', border: '1px solid #2fd0ff', color: '#e6fdff' }}
        >
          保存
        </button>
        {status && <div className="mt-2 text-xs" style={{ color: status.startsWith('保存しました') ? '#7ff3ff' : '#ff9c8f' }}>{status}</div>}

        <div className="mt-6 text-xs leading-relaxed" style={{ opacity: 0.6 }}>
          Hermes Agent：~/.hermes/.env に API_SERVER_ENABLED=true と API_SERVER_KEY を設定し、URL は http://127.0.0.1:8642/v1。<br />
          OpenClaw：設定で gateway.http.endpoints.chatCompletions.enabled を true にし、URL は http://（Mac miniのIP）:18789/v1、トークンは gateway.auth.token。
        </div>
      </div>
    </div>
  );
}
