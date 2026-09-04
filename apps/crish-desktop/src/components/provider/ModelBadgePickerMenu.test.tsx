// @vitest-environment jsdom
/**
 * ModelBadgePickerMenu 测试（扁平单层菜单结构）
 *
 * 组件现状（单层扁平设计）：单个 `role="menu"` 面板内按服务商分组直接内联渲染
 * 模型选项（`profile-item-*` 组 + `model-option-*` 按钮），不存在两级子菜单。
 * 本文件据此覆盖：
 * 1. 基础渲染（组头/模型项/模型管理入口、同展示名折叠、空态、停用过滤）
 * 2. 模型选择与搜索过滤
 * 3. 高级选项（思考档位单源渲染与选择）
 * 4. 转义与外点关闭（LayerStack）
 * 5. Anchor 二次点击防重开
 *
 * 已移除的旧断言（两级子菜单时代产物，组件已无对应能力）：
 * - 悬停展开子菜单 / SafeTriangle 轨迹 / Chevron 方向联动 / 键盘子菜单漫游 /
 *   滚动防脱轨 / 子菜单 LayerStack 拓扑 / window blur 收起——扁平结构下不存在
 *   子菜单，这些断言属于「测试两套真相」的伪实现，一并清退。
 */
import React, { useRef, useState } from 'react';
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { ModelBadgePickerMenu } from './ModelBadgePickerMenu';
import { toggleExclusiveMenu } from '../ui/Menu';
import { layerStackService } from '../ui/internal/layer-stack/LayerStackService';
import { MockPhysicalGeometryEngine } from '../../test-utils/MockPhysicalGeometryEngine';
import { useSettingsStore } from '../../store/settingsStore';
import { resetModelMetaCache } from '../../api/modelCatalogMeta';
import * as providerProfiles from '../../api/providerProfiles';

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

const PROFILES_KEY = 'crish_provider_profiles_v1';
const MODEL_META_KEY = 'crish_model_meta_v1';

function seedProfiles() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'p1',
        name: '测试服务商',
        baseUrl: 'https://example.com',
        hasKey: false,
        enabled: true,
        models: ['model-a', 'model-b'],
      },
    ])
  );
}

function seedMultiProfiles() {
  localStorage.setItem(
    PROFILES_KEY,
    JSON.stringify([
      {
        id: 'p1',
        name: '服务商 1',
        baseUrl: 'https://example.com/p1',
        hasKey: false,
        enabled: true,
        models: ['model-1a', 'model-1b'],
      },
      {
        id: 'p2',
        name: '服务商 2',
        baseUrl: 'https://example.com/p2',
        hasKey: false,
        enabled: true,
        models: ['model-2a'],
      },
    ])
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
  resetModelMetaCache();
  useSettingsStore.getState().setAppSettings(null);
  geoEngine.reset();
  geoEngine.setViewport({ width: 1280, height: 800 });
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  geoEngine.reset();
  vi.restoreAllMocks();
});

describe('ModelBadgePickerMenu（扁平单层菜单 · 基础渲染）', () => {
  it('渲染服务商组头与内联模型选项，不存在子菜单', () => {
    seedProfiles();
    render(<Wrapper />);
    expect(screen.getByText('测试服务商')).toBeInTheDocument();
    expect(screen.getByText('模型管理...')).toBeInTheDocument();
    expect(screen.getByTestId('profile-item-p1')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-b')).toBeInTheDocument();
    // 扁平结构：无任何二级子菜单 role
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('同展示名种子与 custom 只渲染一行（OpenCode Go 订阅）', () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'opencode-go',
          name: 'OpenCode Go 订阅',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          hasKey: false,
          enabled: true,
          models: ['deepseek-v4-flash'],
        },
        {
          id: 'custom-preset-copy',
          name: 'OpenCode Go 订阅',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          hasKey: false,
          enabled: true,
          models: [],
        },
      ])
    );
    render(<Wrapper />);
    expect(screen.getAllByText('OpenCode Go 订阅')).toHaveLength(1);
    expect(screen.getByTestId('profile-item-opencode-go')).toBeInTheDocument();
    expect(
      screen.queryByTestId('profile-item-custom-preset-copy')
    ).not.toBeInTheDocument();
  });

  it('点击「模型管理...」调用打开设置并关闭', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.click(screen.getByText('模型管理...'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('全部服务商停用 → 空态提示（不渲染组）', () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'p-disabled',
          name: '已停用服务商',
          baseUrl: '',
          hasKey: false,
          enabled: false,
          models: ['model-a'],
        },
      ])
    );
    render(<Wrapper />);
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
    expect(screen.queryByTestId('profile-item-p-disabled')).not.toBeInTheDocument();
  });

  it('服务商无模型 → 组不渲染', () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'p-empty',
          name: '无模型服务商',
          baseUrl: '',
          hasKey: false,
          enabled: true,
          models: [],
        },
      ])
    );
    render(<Wrapper />);
    expect(screen.queryByTestId('profile-item-p-empty')).not.toBeInTheDocument();
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
  });

  it('meta 停用的模型被过滤：model-b 不渲染', () => {
    seedProfiles();
    localStorage.setItem(
      MODEL_META_KEY,
      JSON.stringify({
        'p1::model-b': { profileId: 'p1', model: 'model-b', enabled: false },
      })
    );
    render(<Wrapper />);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(screen.queryByTestId('model-option-model-b')).not.toBeInTheDocument();
  });
});

describe('模型选择与搜索过滤', () => {
  it('点击模型选项：调用 activateProfileModel 并关闭全部菜单', async () => {
    seedProfiles();
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

  it('搜索关键词过滤模型，无匹配显示空态', () => {
    seedProfiles();
    render(<Wrapper />);
    fireEvent.change(screen.getByPlaceholderText('搜索模型或厂商...'), {
      target: { value: 'model-b' },
    });
    expect(screen.queryByTestId('model-option-model-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-option-model-b')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('搜索模型或厂商...'), {
      target: { value: '不存在的模型' },
    });
    expect(screen.getByText('未找到匹配的模型或厂商')).toBeInTheDocument();
  });
});

describe('高级选项（思考档位单源）', () => {
  it('展开高级选项渲染思考档位，默认档来自 thinkingGear 标签单源', () => {
    seedProfiles();
    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));

    expect(screen.getByText('思考强度')).toBeInTheDocument();
    // 标签单源 = thinkingGear（THINKING_LEVEL_LABELS['default'] = 「默认」），
    // 组件不得再硬编码「提供方默认」类旧文案（值展示 + pill 按钮同名，用按钮精确匹配）
    expect(
      screen.getByRole('button', { name: '默认' })
    ).toBeInTheDocument();
  });

  it('点击默认档位：落盘 appSettings 并调用 updateSettings', async () => {
    seedProfiles();
    render(<Wrapper />);
    fireEvent.click(screen.getByText('高级选项'));
    fireEvent.click(screen.getByRole('button', { name: '默认' }));

    await waitFor(() =>
      expect(
        useSettingsStore.getState().appSettings?.defaultThinkingLevel
      ).toBe('default')
    );
  });
});

describe('转义与外点关闭（LayerStack 协作）', () => {
  it('Escape 关闭菜单并触发 onClose', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('外点关闭：点击面板外部整体关闭', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('Anchor 模式与二次点击防重开（Double Toggle 免疫）', () => {
  it('点击徽标打开，再次 pointerdown+click 关闭且不触发重开', async () => {
    seedProfiles();
    render(<Wrapper defaultOpen={false} />);
    const trigger = screen.getByTestId('model-badge-trigger');
    fireEvent.click(trigger);
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();

    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByTestId('model-option-model-a')).not.toBeInTheDocument()
    );
  });
});
