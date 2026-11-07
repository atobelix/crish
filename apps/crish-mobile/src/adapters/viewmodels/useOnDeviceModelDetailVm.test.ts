// 本机模型详情 VM 测试（L2 / IA §3.6）：未知 id 诚实态、量化解析、
// 续传凭据判读、加载/释放转发、已加载删除先释放（失败中止）、
// 设为默认写 config.activeModel（唯一真源，不新增字段）。
// 注：注入的 manager/runtime 必须用稳定引用——renderHook 回调每次
// 渲染都会重跑，内联新建对象会让 hook 的 useMemo 依赖每帧变化、
// 挂载 effect 无限重跑（实测教训，日志曾达 217MB）。
import { sha256 } from '@noble/hashes/sha2.js';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import {
  OnDeviceModelManager,
  type OnDeviceModelStoreDeps,
  type OnDeviceResumableDownload,
} from '@/adapters/onDevice/onDeviceModelManager';
import type { OnDeviceModelSpec } from '@/adapters/onDevice/onDeviceModelCatalog';
import type { OnDeviceRuntime } from '@/adapters/onDevice/onDeviceChatClient';
import { localChatStore } from '@/domain/store/localChatStore';
import { useOnDeviceModelDetailVm } from './useOnDeviceModelDetailVm';

function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const CONTENT = 'detail-fake-gguf-bytes-0123456789abcd';
const SPEC: OnDeviceModelSpec = {
  id: 'test-model-q4_k_m',
  displayName: 'Test Model（Q4_K_M）',
  fileName: 'test-model-q4_k_m.gguf',
  size: utf8ToBytes(CONTENT).length,
  sha256: bytesToHex(sha256(utf8ToBytes(CONTENT))),
  urls: ['https://example.invalid/test-model-q4_k_m.gguf'],
  license: { id: 'Apache-2.0', label: 'Apache-2.0 开源许可' },
  inference: { contextSize: 2048 },
};

class DetailFakeResumable implements OnDeviceResumableDownload {
  constructor(
    private readonly store: DetailFakeStore,
    private readonly destPath: string,
    private readonly onProgress: (received: number, total: number) => void
  ) {}
  async run(): Promise<{ status: number }> {
    const bytes = utf8ToBytes(CONTENT);
    this.store.files.set(this.destPath, bytes);
    this.onProgress(bytes.length, bytes.length);
    return { status: 200 };
  }
  async cancel(): Promise<void> {}
  savable(): { url: string; fileUri: string; resumeData?: string } {
    return { url: SPEC.urls[0]!, fileUri: this.destPath, resumeData: '0' };
  }
}

class DetailFakeStore implements OnDeviceModelStoreDeps {
  readonly rootDir = '/docs/crish-llm-models/';
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
  async ensureDir(): Promise<void> {}
  async fileSize(path: string): Promise<number | null> {
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
  async freeDiskSpace(): Promise<number | null> {
    return Number.MAX_SAFE_INTEGER;
  }
  createResumableDownload(
    _url: string,
    destPath: string,
    _resumeData: string | undefined,
    onProgress: (received: number, total: number) => void
  ): OnDeviceResumableDownload {
    return new DetailFakeResumable(this, destPath, onProgress);
  }
}

const formalPath = (store: DetailFakeStore): string =>
  store.rootDir + SPEC.id + '/' + SPEC.fileName;

function makeRuntime(loadedId: string | null = null) {
  const calls: string[] = [];
  let loaded = loadedId;
  const runtime: OnDeviceRuntime & { calls: string[] } = {
    calls,
    loadedModelId: () => loaded,
    isLoading: () => false,
    loadModel: async (modelId: string) => {
      calls.push(`load:${modelId}`);
      loaded = modelId;
    },
    releaseLoaded: async () => {
      calls.push('release');
      loaded = null;
    },
  };
  return runtime;
}

function resetStore(): void {
  localChatStore.setState({
    config: { version: 2, providers: {}, activeModel: null },
    hydrated: true,
    keyPresence: {},
  });
}

describe('useOnDeviceModelDetailVm（L2 / IA §3.6）', () => {
  beforeEach(resetStore);

  it('未知 id：found=false、无 spec（视图据此诚实说明，不给下载按钮）', async () => {
    const manager = new OnDeviceModelManager(new DetailFakeStore(), [SPEC]);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm('no-such-model', manager, runtime)
    );
    expect(vm.result.current.found).toBe(false);
    expect(vm.result.current.spec).toBeNull();
    vm.unmount();
  });

  it('目录事实投影：量化取自 id、上下文本取自目录 inference', async () => {
    const manager = new OnDeviceModelManager(new DetailFakeStore(), [SPEC]);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    expect(vm.result.current.found).toBe(true);
    expect(vm.result.current.quantLabel).toBe('Q4_K_M');
    expect(vm.result.current.contextSize).toBe(2048);
    vm.unmount();
  });

  it('续传凭据判读：无凭据 false；.part + 记录齐备 true', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.state?.kind).toBe('missing');
    });
    expect(vm.result.current.resumeAvailable).toBe(false);
    const partPath = formalPath(store) + '.part';
    store.files.set(partPath, utf8ToBytes(CONTENT.slice(0, 10)));
    store.kvData.set(
      `ondevice.resume.${SPEC.id}`,
      JSON.stringify({
        url: SPEC.urls[0],
        fileUri: partPath,
        resumeData: '10',
        savedAt: 1,
      })
    );
    await act(async () => {
      await vm.result.current.refresh();
    });
    expect(vm.result.current.state?.kind).toBe('partial');
    expect(vm.result.current.resumeAvailable).toBe(true);
    vm.unmount();
  });

  it('加载/释放转发运行时面，loaded 跟随运行时真源', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    await manager.ensureReady(SPEC.id, () => undefined);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.state?.kind).toBe('ready');
    });
    expect(vm.result.current.loaded).toBe(false);
    await act(async () => {
      await vm.result.current.load();
    });
    expect(runtime.calls).toEqual([`load:${SPEC.id}`]);
    expect(vm.result.current.loaded).toBe(true);
    await act(async () => {
      await vm.result.current.release();
    });
    expect(runtime.calls).toEqual([`load:${SPEC.id}`, 'release']);
    expect(vm.result.current.loaded).toBe(false);
    vm.unmount();
  });

  it('删除已加载模型：先释放再删文件', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    await manager.ensureReady(SPEC.id, () => undefined);
    const runtime = makeRuntime(SPEC.id);
    const order: string[] = [];
    const baseRelease = runtime.releaseLoaded;
    runtime.releaseLoaded = async () => {
      order.push('release');
      await baseRelease();
    };
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.loaded).toBe(true);
    });
    await act(async () => {
      await vm.result.current.removeModel();
    });
    expect(order).toEqual(['release']);
    expect(store.files.has(formalPath(store))).toBe(false);
    vm.unmount();
  });

  it('删除已加载模型时释放失败：中止删除、文件保留、错误可见', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    await manager.ensureReady(SPEC.id, () => undefined);
    const runtime = makeRuntime(SPEC.id);
    runtime.releaseLoaded = async () => {
      throw new Error('release boom');
    };
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.loaded).toBe(true);
    });
    await act(async () => {
      await vm.result.current.removeModel();
    });
    expect(store.files.has(formalPath(store))).toBe(true);
    expect(vm.result.current.actionErrorText).toContain('release boom');
    vm.unmount();
  });

  it('设为默认：写 config.activeModel（ondevice provider），isDefault 跟随', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    await manager.ensureReady(SPEC.id, () => undefined);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.state?.kind).toBe('ready');
    });
    expect(vm.result.current.isDefault).toBe(false);
    await act(async () => {
      vm.result.current.setAsDefault();
    });
    expect(localChatStore.getState().config.activeModel).toEqual({
      providerId: 'ondevice',
      modelId: SPEC.id,
    });
    expect(vm.result.current.isDefault).toBe(true);
    vm.unmount();
  });

  it('下载动作：missing → ready（走管理器 ensureReady）', async () => {
    const store = new DetailFakeStore();
    const manager = new OnDeviceModelManager(store, [SPEC]);
    const runtime = makeRuntime();
    const vm = await renderHook(() =>
      useOnDeviceModelDetailVm(SPEC.id, manager, runtime)
    );
    await waitFor(() => {
      expect(vm.result.current.state?.kind).toBe('missing');
    });
    await act(async () => {
      vm.result.current.download();
    });
    await waitFor(() => {
      expect(vm.result.current.state?.kind).toBe('ready');
    });
    vm.unmount();
  });
});
