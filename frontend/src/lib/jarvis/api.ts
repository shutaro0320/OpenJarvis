/**
 * JARVIS HUD <-> server: brain configuration and the chat relay.
 *
 * The brain is any OpenAI-compatible endpoint (OpenJarvis, Hermes Agent,
 * OpenClaw, ...). The server relays to it, so this file only ever talks to
 * the local OpenJarvis server.
 */
import { apiFetch, authHeaders, getBase } from '../api';

export interface BrainConfig {
  preset: string;
  base_url: string;
  model: string;
  extra_body: Record<string, unknown>;
  send_persona: boolean;
  has_api_key: boolean;
}

export interface BrainPreset {
  label: string;
  base_url: string;
  model: string;
  extra_body: Record<string, unknown>;
}

export interface JarvisConfig {
  brain: BrainConfig;
  persona: string;
  wake: { clap: boolean; word: boolean; words: string[] };
  history_turns: number;
  presets: Record<string, BrainPreset>;
}

export type JarvisConfigUpdate = {
  brain?: Partial<Omit<BrainConfig, 'has_api_key'>> & { api_key?: string };
  persona?: string;
  wake?: Partial<JarvisConfig['wake']>;
  history_turns?: number;
};

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

async function errorDetail(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body.detail === 'string') return body.detail;
  } catch {
    // fall through
  }
  return `HTTP ${res.status}`;
}

export async function fetchJarvisConfig(): Promise<JarvisConfig> {
  const res = await apiFetch('/v1/jarvis/config');
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

export async function saveJarvisConfig(update: JarvisConfigUpdate): Promise<JarvisConfig> {
  const res = await apiFetch('/v1/jarvis/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(await errorDetail(res));
  return res.json();
}

/** Stream the brain's reply as text deltas (OpenAI chat-completions SSE). */
export async function* streamBrain(
  messages: ChatTurn[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(`${getBase()}/v1/jarvis/chat`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await errorDetail(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
        const err = json?.error?.message;
        if (typeof err === 'string') throw new Error(err);
      } catch (e) {
        if (e instanceof SyntaxError) continue;
        throw e;
      }
    }
  }
}
