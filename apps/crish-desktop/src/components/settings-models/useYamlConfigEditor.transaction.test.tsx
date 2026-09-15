// @vitest-environment jsdom
/** 文档编辑的事务边界：修订、冲突保稿、在途编辑和过期校验。 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockTauriCommand, mockTauriError } from '../../test-setup';
import type { ModelsCatalogSnapshot } from '../../api/modelsCatalogTypes';
import { ensureModelsCatalogLoaded } from '../../api/modelsCatalogStore';
import { useYamlConfigEditor } from './useYamlConfigEditor';

vi.mock('../../api/modelsCatalogStore', () => ({
  getModelsCatalogPath: () => 'C:/test/models.yaml',
  ensureModelsCatalogLoaded: vi.fn(async () => ({
    ok: true,
    path: 'C:/test/models.yaml',
  })),
}));
vi.mock('../../api/codeHighlight', () => ({
  highlightCode: (code: string) => code,
}));

const original = 'version: 2\nproviders: {}\nactiveModel: null\n';
function document(
  content = original,
  revision = 'read-revision'
): ModelsCatalogSnapshot {
  return {
    path: 'C:/test/models.yaml',
    content,
    revision,
    template: original,
    tree: { version: 2, activeModel: null, providers: {} },
    credentialStates: {},
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mockTauriCommand('workbench_read_models_yaml', () => document());
  mockTauriCommand('workbench_validate_models_yaml', () => ({ valid: true }));
});
afterEach(() => vi.useRealTimers());

async function editor() {
  const onSaved = vi.fn();
  const hook = renderHook(() =>
    useYamlConfigEditor({ open: true, onClose: vi.fn(), onSaved })
  );
  await act(async () => {});
  expect(hook.result.current.loading).toBe(false);
  return { ...hook, onSaved };
}

async function edit(hook: Awaited<ReturnType<typeof editor>>, code: string) {
  act(() => hook.result.current.setCode(code));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe('YAML 编辑事务', () => {
  it('读取失败时不宣称已与磁盘同步', async () => {
    mockTauriError('workbench_read_models_yaml', {
      code: 'CONFIG_IO',
      message: '配置文件无法读取',
    });
    const hook = await editor();
    expect(hook.result.current.dynamicStatus).toBe('error');
    expect(hook.result.current.dynamicStatusLabel).toBe('配置尚未同步');
    expect(hook.result.current.canSave).toBe(false);
  });

  it('提交读取时的修订，并以实际落盘原文更新编辑基准', async () => {
    const saved = document(original + '# 已保存\n', 'saved-revision');
    const invoke = vi.fn((_args: unknown) => saved);
    mockTauriCommand('workbench_save_models_yaml', invoke);
    const hook = await editor();
    const draft = original + '# 草稿\n';
    await edit(hook, draft);
    await act(async () => {
      await hook.result.current.handleSave();
    });
    expect(invoke).toHaveBeenCalledWith({
      content: draft,
      expectedRevision: 'read-revision',
    });
    expect(hook.result.current.code).toBe(saved.content);
    expect(hook.result.current.isDirty).toBe(false);
    expect(hook.onSaved).toHaveBeenCalledOnce();
    expect(ensureModelsCatalogLoaded).toHaveBeenCalledWith(true);
  });

  it('冲突保留草稿且不通知保存成功', async () => {
    mockTauriError('workbench_save_models_yaml', {
      code: 'REVISION_CONFLICT',
      message: '配置已被另一窗口修改',
      currentRevision: 'newer',
    });
    const hook = await editor();
    const draft = original + '# 未提交的编辑\n';
    await edit(hook, draft);
    await act(async () => {
      await hook.result.current.handleSave();
    });
    expect(hook.result.current.code).toBe(draft);
    expect(hook.result.current.isDirty).toBe(true);
    expect(hook.result.current.serviceError).toContain('另一窗口');
    expect(hook.onSaved).not.toHaveBeenCalled();
    expect(ensureModelsCatalogLoaded).not.toHaveBeenCalled();
  });

  it('保存途中继续输入，回执不能覆盖后续输入', async () => {
    let finish!: (snapshot: ModelsCatalogSnapshot) => void;
    mockTauriCommand(
      'workbench_save_models_yaml',
      () =>
        new Promise<ModelsCatalogSnapshot>((resolve) => {
          finish = resolve;
        })
    );
    const hook = await editor();
    const submitted = original + '# 首次编辑\n';
    await edit(hook, submitted);
    let saving!: Promise<void>;
    act(() => {
      saving = hook.result.current.handleSave();
    });
    await act(async () => {});
    const later = submitted + '# 后续编辑\n';
    act(() => hook.result.current.setCode(later));
    await act(async () => {
      finish(document(submitted, 'saved-revision'));
      await saving;
    });
    expect(hook.result.current.code).toBe(later);
    expect(hook.result.current.isDirty).toBe(true);
    expect(hook.result.current.saveSuccess).toBe(false);
  });

  it('错误原文可以读取修复，仍使用对应的磁盘修订', async () => {
    mockTauriCommand('workbench_read_models_yaml', () => ({
      ...document('bad: [', 'bad-revision'),
      tree: null,
      parseError: { message: '未闭合列表', line: 1 },
    }));
    const save = vi.fn((_args: unknown) => document());
    mockTauriCommand('workbench_save_models_yaml', save);
    const hook = await editor();
    expect(hook.result.current.code).toBe('bad: [');
    expect(hook.result.current.syntaxError?.message).toBe('未闭合列表');
    await edit(hook, original);
    await act(async () => {
      await hook.result.current.handleSave();
    });
    expect(save).toHaveBeenCalledWith({
      content: original,
      expectedRevision: 'bad-revision',
    });
  });

  it('旧校验的延迟回执不能污染后来已有效的内容', async () => {
    const pending: Array<
      (value: { valid: boolean; message?: string }) => void
    > = [];
    mockTauriCommand(
      'workbench_validate_models_yaml',
      () =>
        new Promise((resolve) => {
          pending.push(resolve);
        })
    );
    const hook = await editor();
    await edit(hook, original + '# 第一份\n');
    await edit(hook, original + '# 第二份\n');
    expect(pending).toHaveLength(2);
    await act(async () => {
      pending[1]({ valid: true });
    });
    await act(async () => {
      pending[0]({ valid: false, message: '旧内容的错误' });
    });
    expect(hook.result.current.syntaxError).toBeNull();
  });
});
