// 端侧模型管理器单测：内存假存储 + 假续传下载源，覆盖状态机迁移、
// sha256 校验通过/篡改拒绝、多源回退顺序、断点续传重建与不接受续传
// 时的整文件回退、空间预检拒绝、删除幂等与占用统计；目录清单另以
// 实查值逐条钉死（HF tree API，2026-11-06）。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  ON_DEVICE_MODEL_CATALOG,
  ON_DEVICE_MODEL_TOTAL_BYTES,
  findOnDeviceModel,
  type OnDeviceModelSpec,
} from './onDeviceModelCatalog';
import {
  OnDeviceModelManager,
  type OnDeviceModelState,
  type OnDeviceModelStoreDeps,
  type OnDeviceResumableDownload,
} from './onDeviceModelManager';
const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));
type FakeBehavior = 'ok' | 'error' | 'badContent' | 'resumeReject' | 'failAfterHalf';
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
class FakeResumable implements OnDeviceResumableDownload {
  private written = 0;
  constructor(
    private readonly store: FakeStore,
    private readonly url: string,
    private readonly destPath: string,
    private readonly resumeData: string | undefined,
    private readonly onProgress: (
      receivedBytes: number,
      totalBytes: number
    ) => void
  ) {}
  async run(): Promise<{ status: number }> {
    const behavior = this.store.behavior.get(this.url) ?? 'ok';
    if (behavior === 'error') {
      throw new Error(`network fail: ${this.url}`);
    }
    const content = this.store.contentBytes(this.url, behavior === 'badContent');
    let offset = 0;
    if (this.resumeData !== undefined) {
      if (behavior === 'resumeReject') {
        throw new Error('HTTP 416: Range Not Satisfiable');
      }
      offset = Number.parseInt(this.resumeData, 10) || 0;
    }
    this.written = offset;
    const failAt =
      behavior === 'failAfterHalf'
        ? Math.floor(content.length / 2)
        : this.store.failAtBytes.get(this.url);
    const chunk = Math.max(3, Math.floor(content.length / 16));
    while (offset < content.length) {
      offset = Math.min(content.length, offset + chunk);
      const hitFail = failAt !== undefined && offset >= failAt;
      if (hitFail) offset = failAt;
      this.written = offset;
      this.store.files.set(this.destPath, content.subarray(0, offset));
      this.onProgress(offset, content.length);
      if (hitFail) throw new Error('network dropped mid-download');
      if (this.store.chunkDelayMs > 0) await sleep(this.store.chunkDelayMs);
    }
    return { status: 200 };
  }
  savable(): { url: string; fileUri: string; resumeData?: string } {
    // 生产形开关：真实 DownloadResumable 在未 pauseAsync 前 savable()
    // 不带 resumeData；omitResumeData 时模拟这一形态。
    if (this.store.omitResumeData) {
      return { url: this.url, fileUri: this.destPath };
    }
    return {
      url: this.url,
      fileUri: this.destPath,
      resumeData: String(this.written),
    };
  }
}
class FakeStore implements OnDeviceModelStoreDeps {
  readonly rootDir = 'file:///docs/crish-llm-models/';
  readonly files = new Map<string, Uint8Array>();
  readonly kvData = new Map<string, string>();
  readonly kv = {
    get: async (key: string): Promise<string | null> =>
      this.kvData.get(key) ?? null,
    set: async (key: string, value: string): Promise<void> => {
      this.kvData.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      this.kvData.delete(key);
    },
  };
  /** fileName → 服务端内容（按文件名索引，两源同内容） */
  readonly contents = new Map<string, string>();
  readonly behavior = new Map<string, FakeBehavior>();
  readonly failAtBytes = new Map<string, number>();
  createCalls: {
    url: string;
    destPath: string;
    resumeData: string | undefined;
  }[] = [];
  sha256Calls: string[] = [];
  freeSpace: number | null = Number.MAX_SAFE_INTEGER;
  chunkDelayMs = 0;
  /** true 时假下载器的 savable() 不返回 resumeData（生产形态） */
  omitResumeData = false;
  /** 设置后：第一次读 .part 大小时挂起，释放后返回当时的旧观测（null） */
  partReadGate: Promise<void> | null = null;
  private partGateConsumed = false;
  contentBytes(url: string, bad: boolean): Uint8Array {
    const fileName = url.split('/').pop() ?? '';
    const bytes = utf8ToBytes(this.contents.get(fileName) ?? '');
    if (!bad) return bytes;
    const out = Uint8Array.from(bytes);
    if (out.length > 0) out[0] = (out[0] ?? 0) ^ 0xff;
    return out;
  }
  async ensureDir(): Promise<void> {}
  async fileSize(path: string): Promise<number | null> {
    if (
      this.partReadGate !== null &&
      !this.partGateConsumed &&
      path.endsWith('.part')
    ) {
      this.partGateConsumed = true;
      await this.partReadGate;
      return null;
    }
    const data = this.files.get(path);
    return data ? data.length : null;
  }
  async computeSha256(path: string): Promise<string | null> {
    this.sha256Calls.push(path);
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
  async freeDiskSpace(): Promise<number | null> {
    return this.freeSpace;
  }
  createResumableDownload(
    url: string,
    destPath: string,
    resumeData: string | undefined,
    onProgress: (receivedBytes: number, totalBytes: number) => void
  ): OnDeviceResumableDownload {
    this.createCalls.push({ url, destPath, resumeData });
    return new FakeResumable(this, url, destPath, resumeData, onProgress);
  }
  seedFile(path: string, content: string): void {
    this.files.set(path, utf8ToBytes(content));
  }
}
const CONTENT_A = 'fake-gguf-a-bytes-0123456789abcdef';
const CONTENT_B = 'fake-gguf-b-bytes-fedcba9876543210';
function specOf(id: string, content: string): OnDeviceModelSpec {
  const fileName = `${id}.gguf`;
  return {
    id,
    displayName: id,
    fileName,
    size: utf8ToBytes(content).length,
    sha256: hex(content),
    urls: [
      `https://hf-mirror.com/test/${fileName}`,
      `https://huggingface.co/test/${fileName}`,
    ],
    license: { id: 'Apache-2.0', label: 'Apache-2.0 开源许可' },
  };
}
const SPEC_A = specOf('model-a', CONTENT_A);
const SPEC_B = specOf('model-b', CONTENT_B);
function makeManager(store: FakeStore): OnDeviceModelManager {
  store.contents.set(SPEC_A.fileName, CONTENT_A);
  store.contents.set(SPEC_B.fileName, CONTENT_B);
  return new OnDeviceModelManager(store, [SPEC_A, SPEC_B]);
}
const dirOf = (store: FakeStore, spec: OnDeviceModelSpec): string =>
  store.rootDir + spec.id + '/';
const pathOf = (store: FakeStore, spec: OnDeviceModelSpec): string =>
  dirOf(store, spec) + spec.fileName;
describe('OnDeviceModelCatalog（实查值钉死）', () => {
  it('contains exactly the five investigated models with HF-verified size and sha256', () => {
    const expected: Record<
      string,
      { fileName: string; size: number; sha256: string; repo: string }
    > = {
      'qwen2.5-1.5b-instruct-q4_k_m': {
        fileName: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
        size: 1117320736,
        sha256:
          '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
        repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF',
      },
      'qwen3-1.7b-q4_k_m': {
        fileName: 'Qwen3-1.7B-Q4_K_M.gguf',
        size: 1107409472,
        sha256:
          'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
        repo: 'unsloth/Qwen3-1.7B-GGUF',
      },
      'smollm2-1.7b-instruct-q4_k_m': {
        fileName: 'smollm2-1.7b-instruct-q4_k_m.gguf',
        size: 1055609536,
        sha256:
          'decd2598bc2c8ed08c19adc3c8fdd461ee19ed5708679d1c54ef54a5a30d4f33',
        repo: 'HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF',
      },
      'llama-3.2-1b-instruct-q4_k_m': {
        fileName: 'Llama-3.2-1B-Instruct-Q4_K_M.gguf',
        size: 807694464,
        sha256:
          '6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83',
        repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF',
      },
      'qwen2.5-3b-instruct-q4_k_m': {
        fileName: 'qwen2.5-3b-instruct-q4_k_m.gguf',
        size: 2104932768,
        sha256:
          '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
        repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
      },
    };
    expect(ON_DEVICE_MODEL_CATALOG).toHaveLength(5);
    const ids = new Set<string>();
    for (const entry of ON_DEVICE_MODEL_CATALOG) {
      ids.add(entry.id);
      const want = expected[entry.id];
      expect(want).toBeDefined();
      expect(entry.fileName).toBe(want!.fileName);
      expect(entry.size).toBe(want!.size);
      expect(entry.sha256).toBe(want!.sha256);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      // 源序：hf-mirror 第一，huggingface.co 第二（同 ASR 先例）
      expect(entry.urls).toEqual([
        `https://hf-mirror.com/${want!.repo}/resolve/main/${want!.fileName}`,
        `https://huggingface.co/${want!.repo}/resolve/main/${want!.fileName}`,
      ]);
    }
    expect(ids.size).toBe(5);
    expect(ON_DEVICE_MODEL_TOTAL_BYTES).toBe(
      ON_DEVICE_MODEL_CATALOG.reduce((sum, m) => sum + m.size, 0)
    );
  });
  it('marks Qwen2.5-1.5B as the recommended default and only it', () => {
    const recommended = ON_DEVICE_MODEL_CATALOG.filter((m) => m.recommended);
    expect(recommended.map((m) => m.id)).toEqual([
      'qwen2.5-1.5b-instruct-q4_k_m',
    ]);
    expect(findOnDeviceModel('qwen2.5-1.5b-instruct-q4_k_m')?.license.id).toBe(
      'Apache-2.0'
    );
  });
  it('carries the Qwen Research License warning on the 3B entry only', () => {
    const threeB = findOnDeviceModel('qwen2.5-3b-instruct-q4_k_m');
    expect(threeB?.license.id).toBe('Qwen Research License');
    expect(threeB?.license.warning).toBeDefined();
    expect(threeB?.license.warning).toContain('非商用');
    for (const entry of ON_DEVICE_MODEL_CATALOG) {
      if (entry.id !== 'qwen2.5-3b-instruct-q4_k_m') {
        expect(entry.license.warning).toBeUndefined();
      }
    }
    expect(findOnDeviceModel('no-such-model')).toBeUndefined();
  });
});
describe('OnDeviceModelManager', () => {
  it('downloads with progress and becomes ready; ready path is a native path', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    expect((await manager.check(SPEC_A.id)).kind).toBe('missing');
    const states: OnDeviceModelState[] = [];
    const result = await manager.ensureReady(SPEC_A.id, (s) => states.push(s));
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      // 原生引擎只认真实路径：剥掉 file:// scheme（同 ASR 纪律）
      expect(result.path).toBe(
        '/docs/crish-llm-models/model-a/model-a.gguf'
      );
      expect(result.sizeBytes).toBe(SPEC_A.size);
    }
    const downloads = states.filter((s) => s.kind === 'downloading');
    expect(downloads.length).toBeGreaterThan(0);
    const first = downloads[0]!;
    if (first.kind === 'downloading') {
      expect(first.modelId).toBe(SPEC_A.id);
      expect(first.fileIndex).toBe(1);
      expect(first.totalFiles).toBe(1);
      expect(first.progressText).toMatch(/\(\d+%\)$/);
      expect(first.overallFraction).toBeGreaterThan(0);
      expect(first.overallFraction).toBeLessThanOrEqual(1);
    }
    expect(states.some((s) => s.kind === 'verifying')).toBe(true);
    expect(states[states.length - 1]?.kind).toBe('ready');
    // 存储侧仍按 URI 形态落盘在该模型自己的子目录
    expect(store.files.has(pathOf(store, SPEC_A))).toBe(true);
    expect(
      store.files.has(dirOf(store, SPEC_A) + 'verified.json')
    ).toBe(true);
  });
  it('fast check() after ready performs zero downloads and zero hashing', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    await manager.ensureReady(SPEC_A.id, () => undefined);
    store.createCalls = [];
    store.sha256Calls = [];
    const state = await manager.check(SPEC_A.id);
    expect(state.kind).toBe('ready');
    expect(store.createCalls).toHaveLength(0);
    expect(store.sha256Calls).toHaveLength(0);
    const all = await manager.checkAll();
    expect(all.map((s) => s.kind)).toEqual(['ready', 'missing']);
  });
  it('self-heals: an existing correct file without marker is verified, not re-downloaded', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    store.seedFile(pathOf(store, SPEC_A), CONTENT_A);
    const states: OnDeviceModelState[] = [];
    const result = await manager.ensureReady(SPEC_A.id, (s) => states.push(s));
    expect(result.kind).toBe('ready');
    expect(states.some((s) => s.kind === 'verifying')).toBe(true);
    expect(store.createCalls).toHaveLength(0);
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
  });
  it('re-downloads a tampered file (same size, wrong bytes, no marker)', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    const tampered = 'X' + CONTENT_A.slice(1);
    expect(tampered.length).toBe(CONTENT_A.length);
    store.seedFile(pathOf(store, SPEC_A), tampered);
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('ready');
    expect(store.createCalls.length).toBeGreaterThan(0);
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
  });
  it('rejects a tampered download: hash mismatch is an honest error and no formal file lands', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    for (const url of SPEC_A.urls) store.behavior.set(url, 'badContent');
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('哈希校验不匹配');
      expect(result.canRetry).toBe(true);
    }
    // 损坏件只留在 .part，绝不进入正式路径
    expect(store.files.has(pathOf(store, SPEC_A))).toBe(false);
    expect((await manager.check(SPEC_A.id)).kind).toBe('missing');
    store.behavior.clear();
    const retried = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(retried.kind).toBe('ready');
  });
  it('falls back to the second source in order when the mirror fails', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    store.behavior.set(SPEC_A.urls[0]!, 'error');
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('ready');
    expect(store.createCalls.map((c) => c.url)).toEqual([
      SPEC_A.urls[0],
      SPEC_A.urls[1],
    ]);
  });
  it('reports an honest error when every source fails, and retry can succeed', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    for (const url of SPEC_A.urls) store.behavior.set(url, 'error');
    const failed = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(failed.kind).toBe('error');
    if (failed.kind === 'error') expect(failed.canRetry).toBe(true);
    store.behavior.clear();
    const retried = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(retried.kind).toBe('ready');
  });
  it('persists a resume record on mid-download failure and a fresh manager resumes from it after restart', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    for (const url of SPEC_A.urls) store.behavior.set(url, 'failAfterHalf');
    const failed = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(failed.kind).toBe('error');
    // 失败后：.part 半成品计入占用，续传记录已落 kv
    const half = Math.floor(SPEC_A.size / 2);
    expect(await manager.usageBytes(SPEC_A.id)).toBe(half);
    const raw = store.kvData.get(`ondevice.resume.${SPEC_A.id}`);
    expect(raw).toBeDefined();
    const saved = JSON.parse(raw!) as { url: string; resumeData?: string };
    expect(saved.resumeData).toBe(String(half));
    // 模拟 App 重启：新管理器实例 + 同一存储；镜像源仍不可用、原站恢复
    store.behavior.set(SPEC_A.urls[0]!, 'error');
    store.behavior.set(SPEC_A.urls[1]!, 'ok');
    store.createCalls = [];
    const restarted = makeManager(store);
    const result = await restarted.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('ready');
    const resumeCall = store.createCalls.find(
      (c) => c.url === SPEC_A.urls[1] && c.resumeData !== undefined
    );
    expect(resumeCall).toBeDefined();
    expect(resumeCall!.resumeData).toBe(String(half));
    // 成功后续传记录清除，占用回到完整文件大小
    expect(store.kvData.has(`ondevice.resume.${SPEC_A.id}`)).toBe(false);
    expect(await restarted.usageBytes(SPEC_A.id)).toBe(SPEC_A.size);
  });
  it('falls back to a full re-download when the server rejects resumption', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    // 预置一份在案续传记录与对应 .part 前缀
    const partPath = pathOf(store, SPEC_A) + '.part';
    store.seedFile(partPath, CONTENT_A.slice(0, 10));
    store.kvData.set(
      `ondevice.resume.${SPEC_A.id}`,
      JSON.stringify({
        url: SPEC_A.urls[0],
        fileUri: partPath,
        resumeData: '10',
        savedAt: 1,
      })
    );
    store.behavior.set(SPEC_A.urls[0]!, 'resumeReject');
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('ready');
    // 先以 resumeData 试续传（被拒），随后同源整文件重下成功
    const calls = store.createCalls.filter((c) => c.url === SPEC_A.urls[0]);
    expect(calls.map((c) => c.resumeData)).toEqual(['10', undefined]);
    expect(store.kvData.has(`ondevice.resume.${SPEC_A.id}`)).toBe(false);
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
  });
  it('persists savable state mid-download (byte threshold) before a late failure', async () => {
    const store = new FakeStore();
    const bigContent = 'g'.repeat(5 * 1024 * 1024);
    const bigSpec = specOf('model-big', bigContent);
    store.contents.set(bigSpec.fileName, bigContent);
    const manager = new OnDeviceModelManager(store, [bigSpec]);
    // 在 4MiB 节流阈值之后、文件未完之前断网
    for (const url of bigSpec.urls) {
      store.failAtBytes.set(url, Math.floor(4.6 * 1024 * 1024));
    }
    const failed = await manager.ensureReady(bigSpec.id, () => undefined);
    expect(failed.kind).toBe('error');
    const raw = store.kvData.get(`ondevice.resume.${bigSpec.id}`);
    expect(raw).toBeDefined();
    const saved = JSON.parse(raw!) as { resumeData?: string };
    expect(Number(saved.resumeData)).toBeGreaterThanOrEqual(4 * 1024 * 1024);
  });
  it('refuses the download when free space is below size × 1.1, before any network call', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    store.freeSpace = Math.ceil(SPEC_A.size * 1.1) - 1;
    const states: OnDeviceModelState[] = [];
    const result = await manager.ensureReady(SPEC_A.id, (s) => states.push(s));
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('空间不足');
      expect(result.canRetry).toBe(true);
    }
    expect(store.createCalls).toHaveLength(0);
    // 空间探测不可用（null）时不虚假拦截，照常下载
    store.freeSpace = null;
    const ok = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(ok.kind).toBe('ready');
  });
  it('remove() clears file, .part, marker and resume record, and is idempotent', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    await manager.ensureReady(SPEC_A.id, () => undefined);
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
    store.seedFile(pathOf(store, SPEC_A) + '.part', 'partial');
    store.kvData.set(`ondevice.resume.${SPEC_A.id}`, '{"url":"x"}');
    await manager.remove(SPEC_A.id);
    expect((await manager.check(SPEC_A.id)).kind).toBe('missing');
    expect(store.files.has(pathOf(store, SPEC_A))).toBe(false);
    expect(store.files.has(pathOf(store, SPEC_A) + '.part')).toBe(false);
    expect(store.files.has(dirOf(store, SPEC_A) + 'verified.json')).toBe(
      false
    );
    expect(store.kvData.has(`ondevice.resume.${SPEC_A.id}`)).toBe(false);
    expect(await manager.usageBytes(SPEC_A.id)).toBe(0);
    // 幂等：对已删除/从未下载的模型重复删除不抛错
    await manager.remove(SPEC_A.id);
    await manager.remove(SPEC_B.id);
    await manager.remove('no-such-model');
    // 删除不是断头路：可重新下载回到就绪
    const again = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(again.kind).toBe('ready');
  });
  it('reports per-model and total usage across downloaded models', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    expect(await manager.totalUsageBytes()).toBe(0);
    await manager.ensureReady(SPEC_A.id, () => undefined);
    await manager.ensureReady(SPEC_B.id, () => undefined);
    expect(await manager.usageBytes(SPEC_A.id)).toBe(SPEC_A.size);
    expect(await manager.usageBytes(SPEC_B.id)).toBe(SPEC_B.size);
    expect(await manager.totalUsageBytes()).toBe(SPEC_A.size + SPEC_B.size);
    expect(await manager.usageBytes('no-such-model')).toBe(0);
  });
  it('dedupes concurrent ensureReady calls for the same model', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    const [r1, r2] = await Promise.all([
      manager.ensureReady(SPEC_A.id, () => undefined),
      manager.ensureReady(SPEC_A.id, () => undefined),
    ]);
    expect(r1.kind).toBe('ready');
    expect(r2.kind).toBe('ready');
    expect(
      store.createCalls.filter((c) => c.url === SPEC_A.urls[0])
    ).toHaveLength(1);
  });
  it('emits a numeric speed estimate on downloading states once samples accumulate', async () => {
    const store = new FakeStore();
    store.chunkDelayMs = 40;
    const manager = makeManager(store);
    const states: OnDeviceModelState[] = [];
    const result = await manager.ensureReady(SPEC_A.id, (s) => states.push(s));
    expect(result.kind).toBe('ready');
    const withSpeed = states.filter(
      (s) => s.kind === 'downloading' && typeof s.speedBytesPerSec === 'number'
    );
    expect(withSpeed.length).toBeGreaterThan(0);
  });
  it('handles unknown model ids honestly', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    expect((await manager.check('nope')).kind).toBe('missing');
    expect(manager.localPath('nope')).toBeNull();
    const result = await manager.ensureReady('nope', () => undefined);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.canRetry).toBe(false);
  });
});

describe('OnDeviceModelManager · L0 磁盘形态区分（check 不再把有字节说成未下载）', () => {
  it('五种形态：无字节 missing / 只有 .part 为 partial / 正式文件无标记 unverified / 尺寸不符的正式文件 partial / 已标记 ready', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    // 无字节 → missing
    expect((await manager.check(SPEC_A.id)).kind).toBe('missing');
    // 只有完整 .part → partial（未完成），占用仍在
    store.seedFile(pathOf(store, SPEC_A) + '.part', CONTENT_A);
    const partial = await manager.check(SPEC_A.id);
    expect(partial.kind).toBe('partial');
    if (partial.kind === 'partial') {
      expect(partial.receivedBytes).toBe(SPEC_A.size);
    }
    expect(await manager.usageBytes(SPEC_A.id)).toBe(SPEC_A.size);
    // 正式文件在、尺寸正确、无标记 → unverified（待校验）
    store.files.delete(pathOf(store, SPEC_A) + '.part');
    store.seedFile(pathOf(store, SPEC_A), CONTENT_A);
    const unverified = await manager.check(SPEC_A.id);
    expect(unverified.kind).toBe('unverified');
    if (unverified.kind === 'unverified') {
      expect(unverified.sizeBytes).toBe(SPEC_A.size);
    }
    // 正式文件尺寸不符（被截断）且无 .part → partial，不是 missing
    store.seedFile(pathOf(store, SPEC_A), CONTENT_A.slice(0, 7));
    const truncated = await manager.check(SPEC_A.id);
    expect(truncated.kind).toBe('partial');
    if (truncated.kind === 'partial') {
      expect(truncated.receivedBytes).toBe(7);
    }
    // 标记在案 → ready（走 ensureReady 落盘后复核）
    store.files.delete(pathOf(store, SPEC_A));
    await manager.ensureReady(SPEC_A.id, () => undefined);
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
  });

  it('verifyExisting：无标记的好文件只校验补标记、不下载，终态 ready', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    store.seedFile(pathOf(store, SPEC_A), CONTENT_A);
    const states: OnDeviceModelState[] = [];
    const result = await manager.verifyExisting(SPEC_A.id, (s) =>
      states.push(s)
    );
    expect(result.kind).toBe('ready');
    expect(store.createCalls).toHaveLength(0);
    expect(states.map((s) => s.kind)).toEqual(['verifying', 'ready']);
    expect(store.files.has(dirOf(store, SPEC_A) + 'verified.json')).toBe(
      true
    );
    expect((await manager.check(SPEC_A.id)).kind).toBe('ready');
  });

  it('verifyExisting：内容被篡改 → 诚实 error，不下载、不删既有文件', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    const tampered = 'X' + CONTENT_A.slice(1);
    store.seedFile(pathOf(store, SPEC_A), tampered);
    const result = await manager.verifyExisting(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('哈希');
      expect(result.canRetry).toBe(true);
    }
    expect(store.createCalls).toHaveLength(0);
    // 非破坏性：既有正式文件原样保留，check 仍如实报 unverified
    expect(store.files.has(pathOf(store, SPEC_A))).toBe(true);
    expect((await manager.check(SPEC_A.id)).kind).toBe('unverified');
  });

  it('verifyExisting：missing / ready 时是无副作用的直查', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    expect((await manager.verifyExisting(SPEC_A.id, () => undefined)).kind)
      .toBe('missing');
    await manager.ensureReady(SPEC_A.id, () => undefined);
    store.sha256Calls = [];
    expect((await manager.verifyExisting(SPEC_A.id, () => undefined)).kind)
      .toBe('ready');
    expect(store.sha256Calls).toHaveLength(0);
  });

  it('下载内容哈希不符：.part 与续传记录一并清除（错误字节不得成为续传前缀）', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    for (const url of SPEC_A.urls) store.behavior.set(url, 'badContent');
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('error');
    expect(store.files.has(pathOf(store, SPEC_A) + '.part')).toBe(false);
    expect(store.kvData.has(`ondevice.resume.${SPEC_A.id}`)).toBe(false);
    expect(await manager.usageBytes(SPEC_A.id)).toBe(0);
    expect((await manager.check(SPEC_A.id)).kind).toBe('missing');
  });
});

describe('OnDeviceModelManager · L0 状态订阅与终态保留', () => {
  it('订阅者收到与 onState 相同的状态流；终态保留可供新订阅方读取', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    const seen: OnDeviceModelState[] = [];
    const unsubscribe = manager.subscribe((s) => seen.push(s));
    const result = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(result.kind).toBe('ready');
    expect(seen.some((s) => s.kind === 'downloading')).toBe(true);
    expect(seen[seen.length - 1]?.kind).toBe('ready');
    expect(manager.lastKnownState(SPEC_A.id)?.kind).toBe('ready');
    expect(
      manager.lastKnownStates().map((s) => s.modelId)
    ).toContain(SPEC_A.id);
    // 退订后不再收到；remove 的 missing 终态仍被保留
    unsubscribe();
    const seenCount = seen.length;
    await manager.remove(SPEC_A.id);
    expect(seen.length).toBe(seenCount);
    expect(manager.lastKnownState(SPEC_A.id)?.kind).toBe('missing');
  });

  it('先开始的 check 迟到返回旧观测时，不得覆盖已保留的 ready 终态', async () => {
    const store = new FakeStore();
    const manager = makeManager(store);
    let release!: () => void;
    store.partReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // check 先行：正式文件为空后，读 .part 大小时被挂起（旧观测尚未返回）
    const checking = manager.check(SPEC_A.id);
    // 期间下载完整完成，ready 终态经订阅通道保留
    const ready = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(ready.kind).toBe('ready');
    release();
    const stale = await checking;
    // 查询本身如实返回它观测到的旧真值（当时确无文件）
    expect(stale.kind).toBe('missing');
    // 但保留态不被旧结果覆盖
    expect(manager.lastKnownState(SPEC_A.id)?.kind).toBe('ready');
  });
});

describe('OnDeviceModelManager · L0 生产形 savable（无 resumeData 不写可恢复记录）', () => {
  it('savable 不带 resumeData 时：失败后 kv 无续传记录、界面无从声称可继续，重试是整文件新下载', async () => {
    const store = new FakeStore();
    store.omitResumeData = true;
    const manager = makeManager(store);
    for (const url of SPEC_A.urls) store.behavior.set(url, 'failAfterHalf');
    const failed = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(failed.kind).toBe('error');
    // .part 半成品还在（占用如实），但没有任何可恢复记录被写入
    expect(await manager.usageBytes(SPEC_A.id)).toBe(
      Math.floor(SPEC_A.size / 2)
    );
    expect(store.kvData.has(`ondevice.resume.${SPEC_A.id}`)).toBe(false);
    expect((await manager.check(SPEC_A.id)).kind).toBe('partial');
    // 重试：全部 attempt 都不带 resumeData（整文件从零下载）
    store.behavior.clear();
    store.createCalls = [];
    const retried = await manager.ensureReady(SPEC_A.id, () => undefined);
    expect(retried.kind).toBe('ready');
    expect(store.createCalls.length).toBeGreaterThan(0);
    expect(
      store.createCalls.every((c) => c.resumeData === undefined)
    ).toBe(true);
  });
});
