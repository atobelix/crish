// 模型管理器单测：内存假存储 + 假下载源，覆盖缺失→下载→校验→就绪、
// 损坏文件重下、多源回退与失败诚实报错。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AsrModelManager,
  type AsrModelFileSpec,
  type AsrModelState,
  type ModelStoreDeps,
} from './modelManager';

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

function specOf(name: string, content: string): AsrModelFileSpec {
  return {
    name,
    size: utf8ToBytes(content).length,
    sha256: hex(content),
    urls: [`https://a.example/${name}`, `https://b.example/${name}`],
  };
}

const FILES: Record<string, string> = {
  'model.int8.onnx': 'fake-model-bytes',
  'tokens.txt': 'fake-tokens',
  'silero_vad.onnx': 'fake-vad',
};
const SPECS = Object.entries(FILES).map(([name, content]) =>
  specOf(name, content)
);

class FakeStore implements ModelStoreDeps {
  readonly dir = 'file:///docs/crish-asr-models/';
  readonly files = new Map<string, Uint8Array>();
  downloadCalls: string[] = [];
  /** 按 URL 注入行为：缺省返回 FILES 中对应内容；可指定抛错 */
  behavior = new Map<string, 'ok' | 'error'>();

  async ensureDir(): Promise<void> {}
  async fileSize(path: string): Promise<number | null> {
    const data = this.files.get(path);
    return data ? data.length : null;
  }
  async readChunk(
    path: string,
    position: number,
    length: number
  ): Promise<Uint8Array> {
    const data = this.files.get(path);
    if (!data) return new Uint8Array(0);
    return data.subarray(position, position + length);
  }
  async writeTextFile(path: string, content: string): Promise<void> {
    this.files.set(path, utf8ToBytes(content));
  }
  async readTextFile(path: string): Promise<string | null> {
    const data = this.files.get(path);
    return data ? new TextDecoder().decode(data) : null;
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async move(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data) {
      this.files.set(to, data);
      this.files.delete(from);
    }
  }
  async downloadToFile(
    url: string,
    destPath: string,
    onProgress: (received: number, total: number) => void
  ): Promise<void> {
    this.downloadCalls.push(url);
    if (this.behavior.get(url) === 'error') {
      throw new Error(`network fail: ${url}`);
    }
    const name = url.split('/').pop() ?? '';
    const data = utf8ToBytes(FILES[name] ?? '');
    onProgress(data.length, data.length);
    this.files.set(destPath, data);
  }
  seed(name: string, content: string): void {
    this.files.set(this.dir + name, utf8ToBytes(content));
  }
}

describe('AsrModelManager', () => {
  it('downloads all files with progress and becomes ready', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    expect((await manager.check()).kind).toBe('missing');

    const states: AsrModelState[] = [];
    const result = await manager.ensureReady((s) => states.push(s));
    expect(result.kind).toBe('ready');
    expect(states.some((s) => s.kind === 'downloading')).toBe(true);
    expect(states[states.length - 1]?.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect(result.paths.modelPath).toBe(
        'file:///docs/crish-asr-models/model.int8.onnx'
      );
    }
    // 就绪后 check 走快速路径且不再下载
    store.downloadCalls = [];
    expect((await manager.check()).kind).toBe('ready');
    expect(store.downloadCalls).toHaveLength(0);
  });

  it('re-downloads a corrupted file (same size, wrong hash)', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    // 预置：两个好文件 + 一个同长损坏文件
    store.seed('model.int8.onnx', FILES['model.int8.onnx'] ?? '');
    store.seed('tokens.txt', FILES['tokens.txt'] ?? '');
    store.seed('silero_vad.onnx', 'fake-vax'); // 同长度、内容错
    const result = await manager.ensureReady(() => undefined);
    expect(result.kind).toBe('ready');
    expect(store.downloadCalls).toEqual(['https://a.example/silero_vad.onnx']);
  });

  it('falls back to the second source when the first fails', async () => {
    const store = new FakeStore();
    store.behavior.set('https://a.example/tokens.txt', 'error');
    const manager = new AsrModelManager(store, SPECS);
    const result = await manager.ensureReady(() => undefined);
    expect(result.kind).toBe('ready');
    expect(store.downloadCalls).toContain('https://b.example/tokens.txt');
  });

  it('reports an honest error when every source fails, and retry can succeed', async () => {
    const store = new FakeStore();
    for (const spec of SPECS) {
      for (const url of spec.urls) store.behavior.set(url, 'error');
    }
    const manager = new AsrModelManager(store, SPECS);
    const failed = await manager.ensureReady(() => undefined);
    expect(failed.kind).toBe('error');

    store.behavior.clear();
    const retried = await manager.ensureReady(() => undefined);
    expect(retried.kind).toBe('ready');
  });
});
