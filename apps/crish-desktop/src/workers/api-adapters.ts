import { getWorkerPool, Priority } from './index';

export async function parseMarkdownToHtmlWorker(raw: string, priority: Priority = Priority.High): Promise<string> {
  if (!raw || !raw.trim()) return '';
  return getWorkerPool().schedule<string>('render', 'markdown.render', { raw }, priority);
}

export async function highlightCodeWorker(code: string, language?: string, priority: Priority = Priority.Normal): Promise<{ html: string; language: string }> {
  return getWorkerPool().schedule<{ html: string; language: string }>('render', 'highlight.code', { code, language }, priority);
}

export async function highlightBatchWorker(items: Array<{ id: string; code: string; language?: string }>, priority: Priority = Priority.Normal): Promise<Array<{ id: string; html: string }>> {
  const result = await getWorkerPool().schedule<{ results: Array<{ id: string; html: string }> }>('render', 'highlight.batch', { items }, priority);
  return result.results;
}

export async function sha256Worker(data: ArrayBuffer | string, priority: Priority = Priority.Normal): Promise<string> {
  return getWorkerPool().schedule<string>('compute', 'sha256', { data }, priority);
}

export async function detectEncodingWorker(bytes: Uint8Array, priority: Priority = Priority.Normal): Promise<{ encoding: string; hasBom: boolean; text: string }> {
  const transferables: Transferable[] = [bytes.buffer as ArrayBuffer];
  return getWorkerPool().schedule<{ encoding: string; hasBom: boolean; text: string }>(
    'compute', 'encoding.detect', { bytes: bytes.buffer as ArrayBuffer }, priority, { transferables },
  );
}

export async function parseDiffWorker(unified: string, offset?: number, limit?: number, priority: Priority = Priority.High): Promise<Array<{ filePath: string; additions: number; deletions: number; changes: Array<{ type: string; content: string }> }>> {
  return getWorkerPool().schedule('compute', 'diff.parse', { unified, offset, limit }, priority);
}

export async function externalizeBlobsWorker(output: string, options?: { textCharThreshold?: number }, priority: Priority = Priority.Normal): Promise<{ text: string; references: Array<{ uri: string; sha256: string; byteLength: number }> }> {
  return getWorkerPool().schedule('compute', 'externalize.blobs', { output, options }, priority);
}

export async function budgetTextWorker(text: string, maxChars: number, priority: Priority = Priority.High): Promise<{ text: string; truncated: boolean; originalChars: number }> {
  return getWorkerPool().schedule('compute', 'budget.text', { text, maxChars }, priority);
}

export async function jsonStringifyWorker(obj: unknown, priority: Priority = Priority.Normal): Promise<string> {
  return getWorkerPool().schedule<string>('compute', 'json.stringify', { obj }, priority);
}

export async function jsonParseWorker<T>(json: string, priority: Priority = Priority.Normal): Promise<T> {
  return getWorkerPool().schedule<T>('compute', 'json.parse', { json }, priority);
}

export async function base64EncodeWorker(data: ArrayBuffer | string, priority: Priority = Priority.Normal): Promise<string> {
  return getWorkerPool().schedule<string>('compute', 'base64.encode', { data }, priority);
}

export async function base64DecodeWorker(data: string, priority: Priority = Priority.Normal): Promise<Uint8Array> {
  const buffer = await getWorkerPool().schedule<ArrayBuffer>('compute', 'base64.decode', { data }, priority);
  return new Uint8Array(buffer);
}

export async function messagesToJsonlWorker(messages: unknown[], priority: Priority = Priority.Low): Promise<string> {
  return getWorkerPool().schedule<string>('io', 'messages.to-jsonl', { messages }, priority);
}

export async function jsonlToMessagesWorker(text: string, priority: Priority = Priority.Low): Promise<unknown[]> {
  return getWorkerPool().schedule<unknown[]>('io', 'jsonl.to-messages', { text }, priority);
}

export async function decodeTextBufferWorker(bytes: ArrayBuffer, encoding?: string, priority: Priority = Priority.Normal): Promise<string> {
  const transferables: Transferable[] = [bytes];
  return getWorkerPool().schedule<string>('io', 'text.decode', { bytes, encoding }, priority, { transferables });
}
