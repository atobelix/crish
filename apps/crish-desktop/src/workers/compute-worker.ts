import type { WorkerRequest, WorkerResponse } from './types';
import { ComputationCache } from './computation-cache';

const sha256Cache = new ComputationCache(200, 4 * 1024 * 1024);
const diffCache = new ComputationCache(50, 4 * 1024 * 1024);

async function sha256(data: ArrayBuffer | string): Promise<string> {
  const key = typeof data === 'string' ? data : `buf:${data.byteLength}`;
  const cached = sha256Cache.get<string>(key);
  if (cached) return cached;

  const source = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', source);
  const hash = Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');

  sha256Cache.set(key, hash, source.byteLength);
  return hash;
}

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = new Uint8Array([0xff, 0xfe]);
const UTF16BE_BOM = new Uint8Array([0xfe, 0xff]);

function startsWith(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < b.length) return false;
  return b.every((v, i) => a[i] === v);
}

function detectEncoding(bytes: Uint8Array): { encoding: string; hasBom: boolean; text: string } {
  if (startsWith(bytes, UTF8_BOM)) {
    return { encoding: 'utf-8-bom', hasBom: true, text: new TextDecoder('utf-8').decode(bytes.slice(UTF8_BOM.length)) };
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    return { encoding: 'utf-16le', hasBom: true, text: new TextDecoder('utf-16le').decode(bytes.slice(UTF16LE_BOM.length)) };
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    return { encoding: 'utf-16be', hasBom: true, text: new TextDecoder('utf-16be').decode(bytes.slice(UTF16BE_BOM.length)) };
  }

  const nullRatio = bytes.filter((b) => b === 0).length / Math.max(1, bytes.length);
  if (nullRatio > 0.1) {
    return { encoding: 'binary', hasBom: false, text: '' };
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf-8', hasBom: false, text };
  } catch {
    try {
      const text = new TextDecoder('gbk').decode(bytes);
      return { encoding: 'gb18030', hasBom: false, text };
    } catch {
      return { encoding: 'binary', hasBom: false, text: '' };
    }
  }
}

function externalizeBlobs(output: string, options?: { textCharThreshold?: number }): { text: string; references: Array<{ uri: string; sha256: string; byteLength: number }> } {
  const threshold = options?.textCharThreshold ?? 24000;
  if (output.length <= threshold) {
    return { text: output, references: [] };
  }
  const headRatio = 0.4;
  const headChars = Math.floor(threshold * headRatio);
  const tailChars = threshold - headChars;
  const omitted = output.length - headChars - tailChars;
  const marker = `\n\n[... ${omitted.toLocaleString('en-US')} characters omitted from ${output.length.toLocaleString('en-US')} total ...]\n\n`;
  return {
    text: `${output.slice(0, headChars)}${marker}${output.slice(-tailChars)}`,
    references: [],
  };
}

function parseDiff(text: string, offset?: number, limit?: number): Array<{ filePath: string; additions: number; deletions: number; changes: Array<{ type: string; content: string }> }> {
  if (!text || !text.includes('\n')) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startIdx = offset ?? 0;
  const maxLines = limit ?? lines.length;

  const files: Array<{ filePath: string; additions: number; deletions: number; changes: Array<{ type: string; content: string }> }> = [];
  let currentPath = '';
  let changes: Array<{ type: string; content: string }> = [];
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let lineCount = 0;

  const flush = () => {
    if (currentPath && changes.length > 0) {
      files.push({ filePath: currentPath, additions, deletions, changes: changes.slice(0, 400) });
    }
    currentPath = '';
    changes = [];
    additions = 0;
    deletions = 0;
    inHunk = false;
  };

  for (let i = startIdx; i < Math.min(lines.length, startIdx + maxLines); i++) {
    const line = lines[i];
    lineCount++;

    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) { flush(); currentPath = gitHeader[2] || gitHeader[1]; continue; }

    const plusFile = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusFile && plusFile[1] !== '/dev/null') { if (!currentPath) currentPath = plusFile[1]; else if (currentPath.startsWith('a/')) currentPath = plusFile[1]; continue; }

    const minusFile = line.match(/^--- (?:a\/)?(.+)$/);
    if (minusFile && !currentPath && minusFile[1] !== '/dev/null') { currentPath = minusFile[1]; continue; }

    if (line.startsWith('@@')) { inHunk = true; changes.push({ type: 'normal', content: line }); continue; }
    if (!currentPath && !inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) { additions++; changes.push({ type: 'addition', content: line.slice(1) }); inHunk = true; }
    else if (line.startsWith('-') && !line.startsWith('---')) { deletions++; changes.push({ type: 'deletion', content: line.slice(1) }); inHunk = true; }
    else if (inHunk && (line.startsWith(' ') || line === '')) { changes.push({ type: 'normal', content: line.startsWith(' ') ? line.slice(1) : line }); }
  }
  flush();
  return files;
}

function budgetText(text: string, maxChars: number): { text: string; truncated: boolean; originalChars: number } {
  const originalChars = text?.length ?? 0;
  if (!text || originalChars <= maxChars) {
    return { text: text || '', truncated: false, originalChars };
  }
  return { text: text.slice(0, maxChars) + '\n...(truncated)', truncated: true, originalChars };
}

function base64Encode(data: ArrayBuffer | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64Decode(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function sessionSearch(query: string, messages: Array<{ sender: string; text?: string; toolCalls?: Array<{ name?: string; output?: string }> }>): Array<{ score: number; snippets: string[] }> {
  if (!query?.trim()) return [];
  const q = query.toLowerCase();
  const results: Array<{ score: number; snippets: string[] }> = [];

  for (const msg of messages) {
    let score = 0;
    const snippets: string[] = [];
    const text = msg.text || '';
    if (text.toLowerCase().includes(q)) {
      score += 10;
      const idx = text.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 28);
      const end = Math.min(text.length, idx + q.length + 28);
      snippets.push((start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : ''));
    }
    for (const tc of msg.toolCalls || []) {
      if (tc.name?.toLowerCase().includes(q)) score += 4;
      if (tc.output?.toLowerCase().includes(q)) { score += 4; if (snippets.length < 3) snippets.push(tc.output.slice(0, 80)); }
    }
    if (score > 0) results.push({ score, snippets });
  }

  return results.sort((a, b) => b.score - a.score);
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { id, type, payload, transferables } = e.data;
  const t0 = performance.now();

  try {
    switch (type) {
      case 'sha256': {
        const { data } = payload as { data: ArrayBuffer | string };
        const hash = await sha256(data);
        self.postMessage({ id, type: 'success', payload: hash, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: hash.length } } as WorkerResponse);
        break;
      }

      case 'encoding.detect': {
        const { bytes } = payload as { bytes: ArrayBuffer };
        const result = detectEncoding(new Uint8Array(bytes));
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: bytes.byteLength } } as WorkerResponse);
        break;
      }

      case 'diff.parse': {
        const { unified, offset, limit } = payload as { unified: string; offset?: number; limit?: number };
        const files = parseDiff(unified, offset, limit);
        self.postMessage({ id, type: 'success', payload: files, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: unified.length } } as WorkerResponse);
        break;
      }

      case 'externalize.blobs': {
        const { output, options } = payload as { output: string; options?: { textCharThreshold?: number } };
        const result = externalizeBlobs(output, options);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: output.length } } as WorkerResponse);
        break;
      }

      case 'budget.text': {
        const { text, maxChars } = payload as { text: string; maxChars: number };
        const result = budgetText(text, maxChars);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: text.length } } as WorkerResponse);
        break;
      }

      case 'base64.encode': {
        const { data } = payload as { data: ArrayBuffer | string };
        const result = base64Encode(data);
        self.postMessage({ id, type: 'success', payload: result, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: result.length } } as WorkerResponse);
        break;
      }

      case 'base64.decode': {
        const { data } = payload as { data: string };
        const result = base64Decode(data);
        self.postMessage({ id, type: 'success', payload: result.buffer, transferables: [result.buffer] } as any);
        break;
      }

      case 'json.stringify': {
        const { obj } = payload as { obj: unknown };
        const json = JSON.stringify(obj);
        self.postMessage({ id, type: 'success', payload: json, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'json.parse': {
        const { json } = payload as { json: string };
        const obj = JSON.parse(json);
        self.postMessage({ id, type: 'success', payload: obj, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: json.length } } as WorkerResponse);
        break;
      }

      case 'session.search': {
        const { query, messages } = payload as any;
        const results = sessionSearch(query, messages);
        self.postMessage({ id, type: 'success', payload: results, metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      case 'ping': {
        self.postMessage({ id, type: 'success', payload: 'pong', metrics: { wallTime: performance.now() - t0, cpuTime: 0, transferredBytes: 0 } } as WorkerResponse);
        break;
      }

      case 'clear-cache': {
        sha256Cache.clear();
        diffCache.clear();
        self.postMessage({ id, type: 'success', payload: { sha256Cache: sha256Cache.getStats(), diffCache: diffCache.getStats() } } as WorkerResponse);
        break;
      }

      default: {
        self.postMessage({ id, type: 'error', payload: `Unknown compute task type: ${type}` } as WorkerResponse);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    self.postMessage({ id, type: 'error', payload: msg } as WorkerResponse);
  }
};
