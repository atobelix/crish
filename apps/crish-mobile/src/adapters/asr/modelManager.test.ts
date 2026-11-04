// 模型管理器单测：内存假存储 + 假下载源，覆盖缺失→下载→校验→就绪、
// 损坏文件重下、多源回退与失败诚实报错。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AsrModelManager,
  ASR_MODEL_FILES,
  formatBytes,
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
  readonly dir: string;

  constructor(dir = 'file:///docs/crish-asr-models/') {
    this.dir = dir;
  }
  readonly files = new Map<string, Uint8Array>();
  downloadCalls: string[] = [];
  sha256Calls: string[] = [];
  /** 按 URL 注入行为：缺省返回 FILES 中对应内容；可指定抛错 */
  behavior = new Map<string, 'ok' | 'error'>();
  /** 允许指定特定路径的 SHA256 返回值或行为 */
  hashOverride = new Map<string, string>();

  async ensureDir(): Promise<void> {}
  async fileSize(path: string): Promise<number | null> {
    const data = this.files.get(path);
    return data ? data.length : null;
  }
  async computeSha256(path: string): Promise<string | null> {
    this.sha256Calls.push(path);
    if (this.hashOverride.has(path)) {
      return this.hashOverride.get(path)!;
    }
    const data = this.files.get(path);
    if (!data) return null;
    return bytesToHex(sha256(data));
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
        '/docs/crish-asr-models/model.int8.onnx'
      );
    }
    // 就绪后 check 走快速路径且不再下载
    store.downloadCalls = [];
    expect((await manager.check()).kind).toBe('ready');
    expect(store.downloadCalls).toHaveLength(0);
  });

  it('exposes native filesystem paths (no file:// scheme) for the engine', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    const result = await manager.ensureReady(() => undefined);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      // 原生引擎只认真实路径：file:// 形态曾让真机建引擎必挂
      expect(result.paths.dir).toBe('/docs/crish-asr-models/');
      expect(result.paths.modelPath).toBe(
        '/docs/crish-asr-models/model.int8.onnx'
      );
      expect(result.paths.tokensPath).toBe('/docs/crish-asr-models/tokens.txt');
      expect(result.paths.vadModelPath).toBe(
        '/docs/crish-asr-models/silero_vad.onnx'
      );
    }
    // 存储侧仍按 URI 形态落盘（pathOf 不受剥 scheme 影响）
    expect(
      store.files.has('file:///docs/crish-asr-models/model.int8.onnx')
    ).toBe(true);
  });

  it('passes through a scheme-less store dir unchanged', () => {
    const manager = new AsrModelManager(
      new FakeStore('/plain/crish-asr-models/'),
      SPECS
    );
    expect(manager.paths().dir).toBe('/plain/crish-asr-models/');
    expect(manager.paths().modelPath).toBe(
      '/plain/crish-asr-models/model.int8.onnx'
    );
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

  it('removeAll deletes model files, marker and .part leftovers; check returns to missing', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    await manager.ensureReady(() => undefined);
    expect((await manager.check()).kind).toBe('ready');
    // 残留半成品也应一并清掉
    store.seed('tokens.txt.part', 'partial');

    await manager.removeAll();
    expect((await manager.check()).kind).toBe('missing');
    expect(store.files.size).toBe(0);

    // 删除后可重新下载回到就绪（管理入口不是断头路）
    const again = await manager.ensureReady(() => undefined);
    expect(again.kind).toBe('ready');
  });

  it('emits quantized progress with fileIndex, totalFiles, and progressText during download and verifying', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    const progressStates: AsrModelState[] = [];
    const result = await manager.ensureReady((s) => progressStates.push(s));
    expect(result.kind).toBe('ready');

    const downloadStates = progressStates.filter(
      (s): s is Extract<AsrModelState, { kind: 'downloading' }> =>
        s.kind === 'downloading'
    );
    expect(downloadStates.length).toBeGreaterThan(0);
    const firstDownload = downloadStates[0]!;
    expect(firstDownload.fileIndex).toBe(1);
    expect(firstDownload.totalFiles).toBe(SPECS.length);
    expect(firstDownload.progressText).toBeDefined();
    expect(typeof firstDownload.progressText).toBe('string');
    expect(firstDownload.receivedBytes).toBeGreaterThanOrEqual(0);
    expect(firstDownload.totalBytes).toBeGreaterThan(0);

    const verifyStates = progressStates.filter(
      (s): s is Extract<AsrModelState, { kind: 'verifying' }> =>
        s.kind === 'verifying'
    );
    expect(verifyStates.length).toBeGreaterThan(0);
    expect(verifyStates[0]!.fileIndex).toBe(1);
    expect(verifyStates[0]!.totalFiles).toBe(SPECS.length);
  });

  it('prioritizes computeSha256 native method and invokes it for part files', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    await manager.ensureReady(() => undefined);
    expect(store.sha256Calls.length).toBe(SPECS.length);
    expect(store.sha256Calls.every((path) => path.endsWith('.part'))).toBe(
      true
    );
  });

  it('persists verified.json incrementally after each verified file', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);
    let intermediateMarkerWritten = false;

    // 监听状态，并在第一个文件校验完成后检查 marker
    await manager.ensureReady((state) => {
      if (
        state.kind === 'downloading' &&
        state.fileIndex === 2 &&
        !intermediateMarkerWritten
      ) {
        const markerRaw = store.files.get(
          'file:///docs/crish-asr-models/verified.json'
        );
        if (markerRaw) {
          const parsed = JSON.parse(new TextDecoder().decode(markerRaw));
          if (parsed['model.int8.onnx']) {
            intermediateMarkerWritten = true;
          }
        }
      }
    });

    expect(intermediateMarkerWritten).toBe(true);
  });

  it('performs non-destructive check: preserves existing valid model when new part download fails verification', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);

    // 预先存好一个正确的 model.int8.onnx
    store.seed('model.int8.onnx', FILES['model.int8.onnx'] ?? '');
    store.seed('tokens.txt', FILES['tokens.txt'] ?? '');

    // 让 silero_vad.onnx.part 哈希校验不匹配
    store.hashOverride.set(
      'file:///docs/crish-asr-models/silero_vad.onnx.part',
      'invalid-bad-hash'
    );

    const result = await manager.ensureReady(() => undefined);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('模型文件哈希校验不匹配');
      expect(result.canRetry).toBe(true);
    }

    // 核心安全红线断言：既有正常模型文件绝对不能被惩罚性删除
    expect(
      store.files.has('file:///docs/crish-asr-models/model.int8.onnx')
    ).toBe(true);
    expect(store.files.has('file:///docs/crish-asr-models/tokens.txt')).toBe(
      true
    );
  });

  it('supports breakpoint recovery: skips already verified files in verified.json', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);

    // 预置前两个文件已存在且 verified.json 在案
    store.seed('model.int8.onnx', FILES['model.int8.onnx'] ?? '');
    store.seed('tokens.txt', FILES['tokens.txt'] ?? '');
    const marker = {
      'model.int8.onnx': hex(FILES['model.int8.onnx'] ?? ''),
      'tokens.txt': hex(FILES['tokens.txt'] ?? ''),
    };
    await store.writeTextFile(
      'file:///docs/crish-asr-models/verified.json',
      JSON.stringify(marker)
    );

    store.downloadCalls = [];
    store.sha256Calls = [];

    const result = await manager.ensureReady(() => undefined);
    expect(result.kind).toBe('ready');

    // 仅下载了缺失的第三个文件
    expect(store.downloadCalls).toEqual(['https://a.example/silero_vad.onnx']);
    // 且前两项无需重新校验哈希
    expect(store.sha256Calls).toEqual([
      'file:///docs/crish-asr-models/silero_vad.onnx.part',
    ]);
  });

  it('fast check() requires zero sha256 and zero download IO when verified', async () => {
    const store = new FakeStore();
    const manager = new AsrModelManager(store, SPECS);

    // 正常拉取到就绪
    await manager.ensureReady(() => undefined);
    store.downloadCalls = [];
    store.sha256Calls = [];

    // 执行快速检查
    const state = await manager.check();
    expect(state.kind).toBe('ready');
    // 零 IO 穿透
    expect(store.downloadCalls).toHaveLength(0);
    expect(store.sha256Calls).toHaveLength(0);
  });

  it('uses domestic mirror https://hf-mirror.com as first priority URL in ASR_MODEL_FILES', () => {
    expect(ASR_MODEL_FILES[0]!.urls[0]).toMatch(/^https:\/\/hf-mirror\.com\//);
    expect(ASR_MODEL_FILES[1]!.urls[0]).toMatch(/^https:\/\/hf-mirror\.com\//);
    expect(ASR_MODEL_FILES[2]!.urls[0]).toContain('silero_vad.onnx');
  });

  it('formatBytes formats bytes accurately', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('1 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(239233841)).toBe('228.2 MB');
  });
});
