// @vitest-environment jsdom
/**
 * ModelBadgePickerMenu 测试（扁平单层菜单 · live catalog）
 *
 * 列表 / 能力只读 modelsCatalogStore（listLivePickerEntries + getLiveModel），
 * 刷新订 models-catalog-changed；思考档 = listThinkingOptions（yaml key）。
 */
import React, { useRef, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from '@testing-library/react';
import { ModelBadgePickerMenu } from './ModelBadgePickerMenu';
import { toggleExclusiveMenu, layerStackService } from '@/components/ui';
import { MockPhysicalGeometryEngine } from '../../test-utils/MockPhysicalGeometryEngine';
import { useSettingsStore } from '../../store/settingsStore';
import { useSessionStore } from '../../store/sessionStore';
import * as providerProfiles from '../../api/providerProfiles';
import {
  ensureModelsCatalogLoaded,
  resetModelsCatalogMirror,
} from '../../api/modelsCatalogStore';
import type { ModelSpec, ProviderSpec } from '../../api/modelsCatalogTypes';
import { mockTauriCommand } from '../../test-setup';
import { emitUiEvent } from '../../api/uiEvents';
import {
  getSessionThinkingTitle,
  sessionRuntimeRegistry,
} from '../../api/SessionRuntimeRegistry';

vi.mock('../../api/storeAccess', () => ({
  openSettings: vi.fn(),
}));

vi.mock('../../api/providerProfiles', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../api/providerProfiles')>();
  return {
    ...actual,
    activateProfileModel: vi.fn(async () => ({ ok: true, synced: true })),
  };
});

const SESSION_ID = 'sess-picker';
const CATALOG_PATH = 'C:\\tmp\\models.yaml';

function specProvider(
  displayName: string,
  models: ModelSpec[],
  patch?: Partial<ProviderSpec>
): ProviderSpec {
  return {
    displayName,
    baseUrl: 'https://example.com',
    // 可用供应商夹具：凭据状态由 seedCatalog 的 credentialStates 提供
    protocol: 'openai/chat',
    models,
    stream: true,
    enabled: true,
    ...patch,
  };
}

async function seedCatalog(
  providers: Record<string, ProviderSpec>,
  activeModel: { providerId: string; modelId: string } | null = null
): Promise<void> {
  mockTauriCommand('workbench_read_models_yaml', () => ({
    path: CATALOG_PATH,
    content: '',
    template: '',
    revision: 'revision-0',
    // 夹具供应商全部视为已配置凭据（hasKey），避免被可用性过滤隐藏
    credentialStates: Object.fromEntries(
      Object.keys(providers).map((id) => [id, { hasKey: true }])
    ),
    parseError: null,
    tree: { version: 2, activeModel, providers },
  }));
  const res = await ensureModelsCatalogLoaded(true);
  expect(res.ok).toBe(true);
}

async function seedDefaultCatalog(extra?: Partial<ModelSpec>): Promise<void> {
  await seedCatalog(
    {
      p1: specProvider('测试服务商', [
        { id: 'model-a', ...extra },
        { id: 'model-b' },
      ]),
    },
    { providerId: 'p1', modelId: 'model-a' }
  );
}

interface WrapperProps {
  onClose?: () => void;
  activeModel?: string | null;
  defaultOpen?: boolean;
}

function Wrapper({
  onClose,
  activeModel = 'model-a',
  defaultOpen = true,
}: WrapperProps) {
  const [open, setOpen] = useState(defaultOpen);
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button
        ref={anchorRef}
        type="button"
        data-testid="model-badge-trigger"
        onClick={() => toggleExclusiveMenu(open, setOpen, anchorRef.current)}
      >
        模型徽标
      </button>
      <ModelBadgePickerMenu
        activeModel={activeModel}
        open={open}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        onOpenChange={(next) => {
          if (!next) setOpen(false);
        }}
        anchor={anchorRef}
      />
    </div>
  );
}

const geoEngine = MockPhysicalGeometryEngine.getInstance();

beforeEach(() => {
  localStorage.clear();
  resetModelsCatalogMirror();
  sessionRuntimeRegistry.clearAll();
  useSessionStore.setState({ activeSessionId: SESSION_ID });
  useSettingsStore.getState().setAppSettings(null);
  geoEngine.reset();
  geoEngine.setViewport({ width: 1280, height: 800 });
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  geoEngine.reset();
  resetModelsCatalogMirror();
  sessionRuntimeRegistry.clearAll();
  vi.restoreAllMocks();
});

describe('ModelBadgePickerMenu（扁平单层菜单 · 基础渲染）', () => {
  it('渲染服务商组头与内联模型选项，不存在子菜单', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    expect(screen.getByText('测试服务商')).toBeInTheDocument();
    expect(screen.getByText('模型管理...')).toBeInTheDocument();
    expect(screen.getByTestId('profile-item-p1')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-b')).toBeInTheDocument();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('yaml 同展示名的两个供应商各自渲染一行（不再 LS 折叠）', async () => {
    await seedCatalog({
      'opencode-go': specProvider('OpenCode Go 订阅', [
        { id: 'deepseek-v4-flash' },
      ]),
      'custom-preset-copy': specProvider('OpenCode Go 订阅', [
        { id: 'copy-model' },
      ]),
    });
    render(<Wrapper activeModel={null} />);
    expect(screen.getAllByText('OpenCode Go 订阅')).toHaveLength(2);
    expect(screen.getByTestId('profile-item-opencode-go')).toBeInTheDocument();
    expect(
      screen.getByTestId('profile-item-custom-preset-copy')
    ).toBeInTheDocument();
  });

  it('点击「模型管理...」调用打开设置并关闭', async () => {
    await seedDefaultCatalog();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.click(screen.getByText('模型管理...'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('全部服务商停用 → 空态提示（不渲染组）', async () => {
    await seedCatalog({
      'p-disabled': specProvider('已停用服务商', [{ id: 'model-a' }], {
        enabled: false,
      }),
    });
    render(<Wrapper />);
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
    expect(
      screen.queryByTestId('profile-item-p-disabled')
    ).not.toBeInTheDocument();
  });

  it('服务商无模型 → 组不渲染', async () => {
    await seedCatalog({
      'p-empty': specProvider('无模型服务商', []),
    });
    render(<Wrapper />);
    expect(
      screen.queryByTestId('profile-item-p-empty')
    ).not.toBeInTheDocument();
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
  });

  it('live enabled=false 的模型被过滤：model-b 不渲染', async () => {
    await seedCatalog(
      {
        p1: specProvider('测试服务商', [
          { id: 'model-a' },
          { id: 'model-b', enabled: false },
        ]),
      },
      { providerId: 'p1', modelId: 'model-a' }
    );
    render(<Wrapper />);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(
      screen.queryByTestId('model-option-model-b')
    ).not.toBeInTheDocument();
  });

  it('未加载 catalog 不回落 LS 种子，显示空态', () => {
    render(<Wrapper />);
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-item-p1')).not.toBeInTheDocument();
  });

  it('展示名读 getLiveModel.displayName', async () => {
    await seedCatalog(
      {
        p1: specProvider('测试服务商', [
          { id: 'model-a', displayName: '模型甲' },
          { id: 'model-b' },
        ]),
      },
      { providerId: 'p1', modelId: 'model-a' }
    );
    render(<Wrapper />);
    expect(screen.getByText('模型甲')).toBeInTheDocument();
  });
});

describe('模型选择与搜索过滤', () => {
  it('点击模型选项：调用 activateProfileModel 并关闭全部菜单', async () => {
    await seedDefaultCatalog();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.click(screen.getByTestId('model-option-model-b'));
    await waitFor(() =>
      expect(providerProfiles.activateProfileModel).toHaveBeenCalledWith(
        'p1',
        'model-b'
      )
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('搜索关键词过滤模型，无匹配显示空态', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    fireEvent.change(screen.getByPlaceholderText('搜索模型或厂商...'), {
      target: { value: 'model-b' },
    });
    expect(
      screen.queryByTestId('model-option-model-a')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-b')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索模型或厂商...'), {
      target: { value: '不存在的模型' },
    });
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
  });

  it('搜索框保持形态④：只有 class searchInput，无内联边框', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    const input = screen.getByPlaceholderText('搜索模型或厂商...');
    expect(input.className).toMatch(/searchInput/);
    expect(input.getAttribute('style')).toBeNull();
  });
});

describe('catalog 刷新（models-catalog-changed）', () => {
  it('emit models-catalog-changed 后选项与新树一致', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();

    await act(async () => {
      await seedCatalog({
        p1: specProvider('测试服务商', [{ id: 'model-new' }]),
      });
    });

    await waitFor(() => {
      expect(
        screen.queryByTestId('model-option-model-a')
      ).not.toBeInTheDocument();
      expect(screen.getByTestId('model-option-model-new')).toBeInTheDocument();
    });
  });

  it('只 emit model-meta-changed 不足以更新列表', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();

    emitUiEvent('model-meta-changed', {
      profileId: 'p1',
      model: 'model-a',
      enabled: false,
    });

    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-b')).toBeInTheDocument();
  });
});

describe('高级选项（思考档位 = listThinkingOptions）', () => {
  it('展开高级选项渲染档位中文标签，无合成「默认」', async () => {
    await seedDefaultCatalog({
      thinking: { Low: 'low', High: 'high' },
    });
    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));

    expect(screen.getByText('思考强度')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '低' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '高' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '默认' })
    ).not.toBeInTheDocument();
  });

  it('点击档位写入会话 thinkingTitle，不写 defaultThinkingLevel', async () => {
    await seedDefaultCatalog({
      thinking: { Low: 'low', High: 'high' },
    });
    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.click(screen.getByRole('button', { name: '高' }));

    await waitFor(() =>
      expect(getSessionThinkingTitle(SESSION_ID)).toBe('High')
    );
    expect(
      useSettingsStore.getState().appSettings?.defaultThinkingLevel
    ).toBeUndefined();
  });

  it('thinking 缺省或空字典：高级区物理卸载', async () => {
    await seedDefaultCatalog();
    render(<Wrapper />);
    expect(screen.queryByText('高级选项')).not.toBeInTheDocument();
    expect(screen.queryByText('思考强度')).not.toBeInTheDocument();
  });

  it('原选档位不在当前模型声明中：显示引导、无错误选中态、不降级到其他档', async () => {
    await seedDefaultCatalog({
      thinking: { Low: 'low', Medium: 'medium', High: 'high' },
    });
    // 用户此前为 model-a 存档了 'XHigh'（该模型并未声明此档）
    localStorage.setItem('conex:model-thinking-pref:p1:model-a', 'XHigh');

    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));

    // 引导重选，而不是把 'XHigh' 静默降级成 'Low'/'High'
    // 布局自解释：所有档位按钮均非激活态（不再渲染 thinking-value 冗余副文本）
    for (const title of ['Low', 'Medium', 'High']) {
      expect(
        screen
          .getByTestId(`thinking-option-${title}`)
          .getAttribute('data-active')
      ).toBe('false');
    }
    // 档位存档不被解析结果反向覆写
    expect(localStorage.getItem('conex:model-thinking-pref:p1:model-a')).toBe(
      'XHigh'
    );
  });

  it('共同档位跨模型保留（精确命中才保留）', async () => {
    await seedDefaultCatalog({
      thinking: { Low: 'low', Medium: 'medium', High: 'high' },
    });
    localStorage.setItem('conex:model-thinking-pref:p1:model-a', 'High');

    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));

    // thinking-value text removed in favor of layout自解释 (active pill)
    expect(
      screen.getByTestId('thinking-option-High').getAttribute('data-active')
    ).toBe('true');
    expect(
      screen.getByTestId('thinking-option-Low').getAttribute('data-active')
    ).toBe('false');
  });
});

describe('转义与外点关闭（LayerStack 协作）', () => {
  it('Escape 关闭菜单并触发 onClose', async () => {
    await seedDefaultCatalog();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('外点关闭：点击面板外部整体关闭', async () => {
    await seedDefaultCatalog();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('Anchor 模式与二次点击防重开（Double Toggle 免疫）', () => {
  it('点击徽标打开，再次 pointerdown+click 关闭且不触发重开', async () => {
    await seedDefaultCatalog();
    render(<Wrapper defaultOpen={false} />);
    const trigger = screen.getByTestId('model-badge-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(
        screen.queryByTestId('model-option-model-a')
      ).not.toBeInTheDocument()
    );
  });
});

describe('源码形状（旧岛读路径清零）', () => {
  it('TSX / data 不引用 listPickerProfiles / getModelMeta / thinkingGear / useModelMetaTick', () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const tsx = fs.readFileSync(
      path.join(dir, 'ModelBadgePickerMenu.tsx'),
      'utf8'
    );
    const data = fs.readFileSync(
      path.join(dir, 'ModelBadgePickerMenu.data.ts'),
      'utf8'
    );
    const availability = fs.readFileSync(
      path.resolve(dir, '../../api/modelPickerAvailability.ts'),
      'utf8'
    );
    const blob = `${tsx}\n${data}\n${availability}`;
    expect(blob).not.toMatch(/listPickerProfiles/);
    expect(blob).not.toMatch(/loadProfiles\(/);
    expect(blob).not.toMatch(/getModelMeta\(/);
    expect(blob).not.toMatch(/useModelMetaTick/);
    expect(blob).not.toMatch(/thinkingGear/);
    expect(blob).not.toMatch(/THINKING_LEVEL_LABELS/);
    expect(blob).not.toMatch(/resolveCatalogEfforts/);
    expect(blob).not.toMatch(/defaultThinkingLevel/);
    expect(tsx).toMatch(/listAvailableModelPickerEntries/);
    expect(availability).toMatch(/listLivePickerEntries/);
    expect(availability).toMatch(/providerHasKey/);
    // 单轨收口：密钥可用性只读树 credentialStates，LS 岛读路径已清退
    expect(availability).not.toMatch(/profileHasConfiguredKey/);
    expect(tsx).toMatch(/getLiveModel/);
    expect(tsx).toMatch(/useModelsCatalogVersion/);
    expect(tsx).toMatch(/listThinkingOptions/);
  });
});
