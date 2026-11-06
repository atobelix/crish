// 本机模型管理视图模型 · 状态映射测试（O4）：管理器五态到管理面
// 文案/进行动词的投影钉死——下载中带百分比与进度文案、失败带原因
// 与可重试标记、3B 许可警示透传、推荐档仅 1.5B。
import { formatBytes } from '@/adapters/onDevice/onDeviceModelManager';
import type { OnDeviceModelState } from '@/adapters/onDevice/onDeviceModelManager';
import {
  ON_DEVICE_MODEL_CATALOG,
  type OnDeviceModelSpec,
} from '@/adapters/onDevice/onDeviceModelCatalog';
import { onDeviceRowOf, onDeviceStatusText } from './useOnDeviceModelsVm';

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
