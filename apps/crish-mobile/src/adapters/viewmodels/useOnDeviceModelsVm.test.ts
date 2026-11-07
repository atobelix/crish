// 本机模型管理视图模型 · 状态映射测试（O4）：管理器五态到管理面
// 文案/进行动词的投影钉死——下载中带百分比与进度文案、失败带原因
// 与可重试标记、3B 许可警示透传、推荐档仅 1.5B。
// L0（2026-11-07）追加：新磁盘形态文案（待校验/未完成）、占用大于 0
// 禁称未下载、VM 订阅与终态补齐、迟到 refresh 不覆盖新终态、
// refresh 自愈待校验行、同步失败可见。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  OnDeviceModelManager,
  formatBytes,
} from '@/adapters/onDevice/onDeviceModelManager';
import type {
  OnDeviceModelState,
  OnDeviceModelStoreDeps,
  OnDeviceResumableDownload,
} from '@/adapters/onDevice/onDeviceModelManager';
import {
  ON_DEVICE_MODEL_CATALOG,
  type OnDeviceModelSpec,
} from '@/adapters/onDevice/onDeviceModelCatalog';
import { localChatStore } from '@/domain/store/localChatStore';
import {
  onDeviceRowOf,
  onDeviceStatusText,
  useOnDeviceModelsVm,
} from './useOnDeviceModelsVm';

const M15 = 'qwen2.5-1.5b-instruct-q4_k_m';
const M3B = 'qwen2.5-3b-instruct-q4_k_m';

function specOf(id: string): OnDeviceModelSpec {
  const spec = ON_DEVICE_MODEL_CATALOG.find((s) => s.id === id);
  if (!spec) throw new Error(`catalog missing ${id}`);
  return spec;
}

describe('onDeviceStatusText', () => {
  it('五态 + 未查得映射', () => {
    expect(onDeviceStatusText(null)).toBe('读取中');
    expect(onDeviceStatusText({ kind: 'missing', modelId: M15 })).toBe(
      '未下载'
    );
    expect(
      onDeviceStatusText({
        kind: 'downloading',
        modelId: M15,
        fileName: 'f.gguf',
        fileIndex: 1,
        totalFiles: 1,
        receivedBytes: 42,
        totalBytes: 100,
        overallFraction: 0.42,
      })
    ).toBe('下载中 42%');
    expect(
      onDeviceStatusText({
        kind: 'verifying',
        modelId: M15,
        fileName: 'f.gguf',
        fileIndex: 1,
        totalFiles: 1,
        overallFraction: 1,
      })
    ).toBe('校验中');
    expect(
      onDeviceStatusText({
        kind: 'ready',
        modelId: M15,
        path: '/m.gguf',
        sizeBytes: 1,
      })
    ).toBe('已就绪');
    expect(
      onDeviceStatusText({
        kind: 'error',
        modelId: M15,
        message: 'x',
        canRetry: true,
      })
    ).toBe('下载失败');
  });
});

describe('onDeviceRowOf', () => {
  it('下载中：进度分数与进度文案透传', () => {
    const state: OnDeviceModelState = {
      kind: 'downloading',
      modelId: M15,
      fileName: 'f.gguf',
      fileIndex: 1,
      totalFiles: 1,
      receivedBytes: 42,
      totalBytes: 100,
      overallFraction: 0.42,
      progressText: '42 MB / 100 MB (42%)',
    };
    const row = onDeviceRowOf(specOf(M15), state, 42, true);
    expect(row.statusText).toBe('下载中 42%');
    expect(row.progressFraction).toBe(0.42);
    expect(row.progressText).toBe('42 MB / 100 MB (42%)');
    expect(row.busy).toBe(true);
    expect(row.usageBytes).toBe(42);
  });

  it('失败：原因与可重试标记透传', () => {
    const row = onDeviceRowOf(
      specOf(M15),
      {
        kind: 'error',
        modelId: M15,
        message: '设备可用空间不足',
        canRetry: true,
      },
      0,
      false
    );
    expect(row.errorText).toBe('设备可用空间不足');
    expect(row.canRetry).toBe(true);
  });

  it('许可：3B 带研究许可警示，其余四条无警示；推荐仅 1.5B', () => {
    const row3b = onDeviceRowOf(specOf(M3B), null, 0, false);
    expect(row3b.licenseLabel).toContain('Qwen');
    expect(row3b.licenseWarning).toContain('Qwen Research License');
    expect(row3b.licenseWarning).toContain('非商用');
    expect(row3b.recommended).toBe(false);
    for (const spec of ON_DEVICE_MODEL_CATALOG) {
      const row = onDeviceRowOf(spec, null, 0, false);
      if (spec.id !== M3B) {
        expect(row.licenseWarning).toBeUndefined();
      }
      expect(row.recommended).toBe(spec.id === M15);
      expect(row.sizeText).toBe(formatBytes(spec.size));
      expect(row.statusText).toBe('读取中');
    }
  });
});

describe('L0 状态文案：新形态与「有占用不称未下载」', () => {
  it('unverified → 待校验；partial → 未完成', () => {
    expect(
      onDeviceStatusText({ kind: 'unverified', modelId: M15, sizeBytes: 10 })
    ).toBe('待校验');
    expect(
      onDeviceStatusText({ kind: 'partial', modelId: M15, receivedBytes: 5 })
    ).toBe('未完成');
  });

  it('missing 但占用大于 0 → 未完成；占用为 0 才称未下载', () => {
    const spec = specOf(M15);
    const withBytes = onDeviceRowOf(
      spec,
      { kind: 'missing', modelId: M15 },
      128,
      false
    );
    expect(withBytes.statusText).toBe('未完成');
    const empty = onDeviceRowOf(
      spec,
      { kind: 'missing', modelId: M15 },
      0,
      false
    );
    expect(empty.statusText).toBe('未下载');
  });

  it('下载中：实测速度透传到行投影', () => {
    const state: OnDeviceModelState = {
      kind: 'downloading',
      modelId: M15,
      fileName: 'f.gguf',
      fileIndex: 1,
      totalFiles: 1,
      receivedBytes: 42,
      totalBytes: 100,
      overallFraction: 0.42,
      speedBytesPerSec: 2048,
    };
    const row = onDeviceRowOf(specOf(M15), state, 42, true);
    expect(row.speedBytesPerSec).toBe(2048);
  });
});

/* ── L0 钩子测试用假存储（与管理器测试同形，独立一份） ── */

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));
const CONTENT_A = 'vm-fake-gguf-a-bytes-0123456789';
const SPEC_A: OnDeviceModelSpec = {
  id: 'vm-model-a',
  displayName: 'VM Model A',
  fileName: 'vm-model-a.gguf',
  size: utf8ToBytes(CONTENT_A).length,
  sha256: hex(CONTENT_A),
  urls: ['https://hf-mirror.com/test/vm-model-a.gguf'],
  license: { id: 'Apache-2.0', label: 'Apache-2.0 开源许可' },
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class VmFakeResumable implements OnDeviceResumableDownload {
  private cancelledFlag = false;
  constructor(
    private readonly store: VmFakeStore,
    private readonly url: string,
    private readonly destPath: string,
    private readonly onProgress: (received: number, total: number) => void
  ) {}
  async run(): Promise<{ status: number }> {
    const bytes = utf8ToBytes(this.store.contents.get('vm-model-a.gguf') ?? '');
    if (this.store.chunkDelayMs > 0) {
      const chunk = Math.max(1, Math.floor(bytes.length / 4));
      let offset = 0;
      while (offset < bytes.length) {
        if (this.cancelledFlag) throw new Error('download cancelled');
        offset = Math.min(bytes.length, offset + chunk);
        this.store.files.set(this.destPath, bytes.subarray(0, offset));
        this.onProgress(offset, bytes.length);
        await sleep(this.store.chunkDelayMs);
      }
    } else {
      this.store.files.set(this.destPath, bytes);
      this.onProgress(bytes.length, bytes.length);
    }
    return { status: 200 };
  }
  async cancel(): Promise<void> {
    this.cancelledFlag = true;
  }
  savable(): { url: string; fileUri: string; resumeData?: string } {
    return { url: this.url, fileUri: this.destPath, resumeData: '0' };
  }
}

class VmFakeStore implements OnDeviceModelStoreDeps {
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
  readonly contents = new Map<string, string>([
    ['vm-model-a.gguf', CONTENT_A],
  ]);
  createCalls = 0;
  chunkDelayMs = 0;
  partReadGate: Promise<void> | null = null;
  private partGateConsumed = false;
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
    const data = this.files.get(path);
    return data ? bytesToHex(sha256(data)) : null;
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
  freeSpaceValue: number | null = Number.MAX_SAFE_INTEGER;
  async freeDiskSpace(): Promise<number | null> {
    return this.freeSpaceValue;
  }
  createResumableDownload(
    url: string,
    destPath: string,
    _resumeData: string | undefined,
    onProgress: (received: number, total: number) => void
  ): OnDeviceResumableDownload {
    this.createCalls += 1;
    return new VmFakeResumable(this, url, destPath, onProgress);
  }
}

const formalPathOf = (store: VmFakeStore): string =>
  store.rootDir + SPEC_A.id + '/' + SPEC_A.fileName;

function makeVmManager(store: VmFakeStore): OnDeviceModelManager {
  return new OnDeviceModelManager(store, [SPEC_A]);
}

describe('useOnDeviceModelsVm · L0 订阅/补齐/自愈/同步错误', () => {
  beforeEach(() => {
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: true,
      keyPresence: {},
    });
  });

  it('页面离开期间下载完成：新挂载 VM 从管理器保留态补齐 ready，不停在未下载', async () => {
    const store = new VmFakeStore();
    const manager = makeVmManager(store);
    const first = await renderHook(() => useOnDeviceModelsVm(manager));
    first.unmount();
    // 无 VM 挂载时下载完成（管理器单例继续跑完并保留终态）
    await manager.ensureReady(SPEC_A.id, () => undefined);
    const second = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      const row = second.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('已就绪');
    });
    second.unmount();
  });

  it('迟到的 refresh 旧观测不得覆盖订阅先到的 ready', async () => {
    const store = new VmFakeStore();
    const manager = makeVmManager(store);
    let release!: () => void;
    store.partReadGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    // 挂载 refresh 的 checkAll 已挂起在旧观测上；期间下载完成
    await act(async () => {
      await manager.ensureReady(SPEC_A.id, () => undefined);
    });
    release();
    await waitFor(() => {
      const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('已就绪');
    });
    // 再多等一拍，确保迟到的 missing 没有把 ready 盖回去
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
    expect(row?.statusText).toBe('已就绪');
    vm.unmount();
  });

  it('refresh 自愈：无标记的好文件刷新后变 ready 并补标记，不触发下载', async () => {
    const store = new VmFakeStore();
    store.files.set(formalPathOf(store), utf8ToBytes(CONTENT_A));
    const manager = makeVmManager(store);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('已就绪');
    });
    expect(store.createCalls).toBe(0);
    expect(
      store.files.has(store.rootDir + SPEC_A.id + '/verified.json')
    ).toBe(true);
    vm.unmount();
  });

  it('refresh 自愈：被篡改的无标记文件变诚实失败，不自动重下载', async () => {
    const store = new VmFakeStore();
    store.files.set(
      formalPathOf(store),
      utf8ToBytes('X' + CONTENT_A.slice(1))
    );
    const manager = makeVmManager(store);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('下载失败');
      expect(row?.errorText).toContain('哈希');
    });
    expect(store.createCalls).toBe(0);
    vm.unmount();
  });

  it('同步失败进入可见错误，不再被空 catch 吞掉', async () => {
    const store = new VmFakeStore();
    class SyncFlakyManager extends OnDeviceModelManager {
      checkAllCalls = 0;
      async checkAll(): Promise<OnDeviceModelState[]> {
        this.checkAllCalls += 1;
        // 第 1 次是 VM refresh 自查；第 2 次是同步内部核对 → 抛错
        if (this.checkAllCalls >= 2) throw new Error('sync boom');
        return super.checkAll();
      }
    }
    const manager = new SyncFlakyManager(store, [SPEC_A]);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      expect(vm.result.current.syncErrorText).toBe('sync boom');
    });
    vm.unmount();
  });
});

describe('useOnDeviceModelsVm · L1 取消', () => {
  beforeEach(() => {
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: true,
      keyPresence: {},
    });
  });

  it('cancelling → 取消中；cancelled → 已取消', () => {
    expect(onDeviceStatusText({ kind: 'cancelling', modelId: M15 })).toBe(
      '取消中'
    );
    expect(onDeviceStatusText({ kind: 'cancelled', modelId: M15 })).toBe(
      '已取消'
    );
  });

  it('下载中调用 VM cancelDownload：行变已取消、.part 已清理', async () => {
    const store = new VmFakeStore();
    store.chunkDelayMs = 50;
    const manager = makeVmManager(store);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('未下载');
    });
    // 注：RNTL v14 的 act 恒为异步，未 await 的 act 作用域会悬空、
    // 后续状态更新被排队永不冲刷——本仓所有 act 调用必须 await
    await act(async () => {
      vm.result.current.download(SPEC_A.id);
    });
    // act 内推进时间：分块进度事件在 act 作用域内冲刷进行投影
    await act(async () => {
      await sleep(110);
    });
    const midRow = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
    expect(midRow?.statusText).toMatch(/^下载中/);
    await act(async () => {
      await vm.result.current.cancelDownload(SPEC_A.id);
    });
    await act(async () => {
      await sleep(20);
    });
    const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
    expect(row?.statusText).toBe('已取消');
    expect(
      store.files.has(
        store.rootDir + SPEC_A.id + '/' + SPEC_A.fileName + '.part'
      )
    ).toBe(false);
    vm.unmount();
  });
});

describe('useOnDeviceModelsVm · L2 首页/存储支撑', () => {
  beforeEach(() => {
    localChatStore.setState({
      config: { version: 2, providers: {}, activeModel: null },
      hydrated: true,
      keyPresence: {},
    });
  });

  it('核对磁盘失败 → loadErrorText 可见，不假装空列表', async () => {
    class BrokenManager extends OnDeviceModelManager {
      async checkAll(): Promise<OnDeviceModelState[]> {
        throw new Error('disk gone');
      }
    }
    const manager = new BrokenManager(new VmFakeStore(), [SPEC_A]);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      expect(vm.result.current.loadErrorText).toBe('disk gone');
    });
    vm.unmount();
  });

  it('freeDiskSpaceBytes 为实测透传，读不到时为 null', async () => {
    const store = new VmFakeStore();
    store.freeSpaceValue = 987654;
    const manager = makeVmManager(store);
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      expect(vm.result.current.freeDiskSpaceBytes).toBe(987654);
    });
    store.freeSpaceValue = null;
    await act(async () => {
      await vm.result.current.refresh();
    });
    expect(vm.result.current.freeDiskSpaceBytes).toBeNull();
    vm.unmount();
  });

  it('incompleteCount：未完成计入，ready/missing 不计', async () => {
    const store = new VmFakeStore();
    const manager = makeVmManager(store);
    store.files.set(
      formalPathOf(store) + '.part',
      utf8ToBytes(CONTENT_A.slice(0, 9))
    );
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      expect(vm.result.current.incompleteCount).toBe(1);
    });
    await act(async () => {
      await manager.ensureReady(SPEC_A.id, () => undefined);
      await vm.result.current.refresh();
    });
    expect(vm.result.current.incompleteCount).toBe(0);
    vm.unmount();
  });

  it('loadedModelId 来自运行时只读面（不写 store）', async () => {
    const store = new VmFakeStore();
    const manager = makeVmManager(store);
    const runtime = {
      loadedModelId: () => SPEC_A.id,
      isLoading: () => false,
      loadModel: async () => undefined,
      releaseLoaded: async () => undefined,
    };
    const vm = await renderHook(() => useOnDeviceModelsVm(manager, runtime));
    await waitFor(() => {
      expect(vm.result.current.loadedModelId).toBe(SPEC_A.id);
    });
    expect(localChatStore.getState().config.activeModel).toBeNull();
    vm.unmount();
  });

  it('removeIncomplete 清半成品：占用归零、行回未下载', async () => {
    const store = new VmFakeStore();
    const manager = makeVmManager(store);
    store.files.set(
      formalPathOf(store) + '.part',
      utf8ToBytes(CONTENT_A.slice(0, 9))
    );
    const vm = await renderHook(() => useOnDeviceModelsVm(manager));
    await waitFor(() => {
      const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
      expect(row?.statusText).toBe('未完成');
    });
    await act(async () => {
      await vm.result.current.removeIncomplete(SPEC_A.id);
    });
    const row = vm.result.current.rows.find((r) => r.id === SPEC_A.id);
    expect(row?.statusText).toBe('未下载');
    expect(vm.result.current.totalUsageText).toBe('0 B');
    vm.unmount();
  });
});
