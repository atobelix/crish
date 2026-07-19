import type { WorkerRequest, WorkerResponse } from './types';
import { ComputationCache } from './computation-cache';

const decodeCache = new ComputationCache(100, 1 * 1024 * 1024);

function messagesToJsonl(messages: unknown[]): string {
  if (!messages?.length) return '';
  return messages.map((m) => JSON.stringify(m)).join('\n');
}

function jsonlToMessages(text: string): unknown[] {
  if (!text?.trim()) return [];
  const s = text.trim();
  if (s.startsWith('[')) {
    try { return JSON.parse(s); } catch { return []; }
  }
  const out: unknown[] = [];
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip bad lines */ }
  }
  return out;
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'messages.to-jsonl': {
        const { messages } = payload as { messages: unknown[] };
        const result = messagesToJsonl(messages);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: result.length } } as WorkerResponse);
        break;
      }

      case 'jsonl.to-messages': {
        const { text } = payload as { text: string };
        const result = jsonlToMessages(text);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: text.length } } as WorkerResponse);
        break;
      }

      case 'json.parse': {
        const { json } = payload as { json: string };
        const obj = safeJsonParse(json, null);
        self.postMessage({ id, type: 'success', payload: obj, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'text.decode': {
        const { bytes, encoding } = payload as { bytes: ArrayBuffer; encoding?: string };
        const label = encoding || 'utf-8';
        const cacheKey = `${label}:${bytes.byteLength}`;
        const cached = decodeCache.get<string>(cacheKey);
        if (cached) {
          self.postMessage({ id, type: 'success', payload: cached, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: bytes.byteLength } } as WorkerResponse);
          break;
        }
        const decoder = new TextDecoder(label);
        const text = decoder.decode(bytes);
        decodeCache.set(cacheKey, text, bytes.byteLength);
        self.postMessage({ id, type: 'success', payload: text, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: bytes.byteLength } } as WorkerResponse);
        break;
      }

      case 'text.encode': {
        const { text, encoding } = payload as { text: string; encoding?: string };
        const encoder = new TextEncoder();
        const bytes = encoder.encode(text).buffer;
        self.postMessage({ id, type: 'success', payload: bytes, transferables: [bytes] } as any);
        break;
      }

      case 'ping': {
        self.postMessage({ id, type: 'success', payload: 'pong', metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({ id, type: 'error', payload: `Unknown io task type: ${type}` } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
