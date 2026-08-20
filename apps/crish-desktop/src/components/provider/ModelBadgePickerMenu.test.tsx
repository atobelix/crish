// @vitest-environment jsdom
/**
 * ModelBadgePickerMenu 全量测试与红方 5 大魔鬼用例（Devil Test Cases）矩阵：
 *
 * 覆盖矩阵：
 * 1. 【魔鬼用例 1】Hover 展开不抢焦（Modality-Aware 纯视觉展开与 80ms 延迟）
 * 2. 【魔鬼用例 2】SafeTriangle 轨迹保护（300ms 宽限期、斜向掠过相邻行防抖、出区/超时接管）
 * 3. 【魔鬼用例 3】低视口/极端靠左自适应 Flip Right 与 Chevron 动态联动（600x400 视口、刚性钳位）
 * 4. 【魔鬼用例 4】键盘操作显式聚焦与漫游（Enter/ArrowLeft 展开聚焦、↑↓/Home/End 漫游、反向键/Esc 精确归还焦点）
 * 5. 【魔鬼用例 5】滚动防脱轨收起（主菜单滚动容器触发 scroll 自动收起子菜单与自愈）
 * 6. 点击选择模型（调用 activateProfileModel 并全部关闭）
 * 7. Esc 逐级退栈与外点关闭（第一击 Esc 关子菜单归还焦点，第二击 Esc 关主菜单；外点关闭整体）
 * 8. DialogOverlay 容器挂载（DialogOverlayContext 存在时 Portal 逃逸并挂载至该容器）
 * 9. window.blur / visibilitychange RAII 全生命周期自愈
 * 10. Anchor 模式与二次点击防重开（Double Toggle 免疫）
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
import { DialogOverlayContext } from '../ui/Dialog/dialogOverlayContext';
import { MockPhysicalGeometryEngine } from '../../test-utils/MockPhysicalGeometryEngine';
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
  geoEngine.reset();
  geoEngine.setViewport({ width: 1280, height: 800 });
});

afterEach(() => {
  cleanup();
  layerStackService.dispose();
  geoEngine.reset();
  vi.restoreAllMocks();
});

describe('ModelBadgePickerMenu（基础与选项渲染）', () => {
  it('渲染服务商行与模型管理入口', async () => {
    seedProfiles();
    render(<Wrapper />);
    expect(screen.getByText('测试服务商')).toBeInTheDocument();
    expect(screen.getByText('模型管理...')).toBeInTheDocument();
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

  it('无服务商时显示空态（全部禁用）', () => {
    localStorage.setItem(
      PROFILES_KEY,
      JSON.stringify([
        {
          id: 'p-disabled',
          name: '已停用服务商',
          baseUrl: '',
          hasKey: false,
          enabled: false,
          models: [],
        },
      ])
    );
    render(<Wrapper />);
    expect(screen.getByText('暂无可用服务商')).toBeInTheDocument();
  });

  it('服务商无模型时，不显示 Chevron 图标且点击/键盘无法展开子菜单', () => {
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
    const row = screen.getByTestId('profile-item-p-empty');
    expect(row).not.toHaveAttribute('aria-expanded');
    expect(row.querySelector('svg')).toBeNull();

    // 点击行按钮不展开
    fireEvent.click(row);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // 键盘 Enter 不展开
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('模型启用状态过滤：子菜单中自动过滤已停用的模型', async () => {
    seedProfiles();
    localStorage.setItem(
      MODEL_META_KEY,
      JSON.stringify({
        'p1::model-b': { profileId: 'p1', model: 'model-b', enabled: false },
      })
    );
    render(<Wrapper />);
    fireEvent.click(screen.getByTestId('profile-item-p1'));

    await waitFor(() =>
      expect(
        screen.getByRole('menu', { name: '测试服务商 模型列表' })
      ).toBeInTheDocument()
    );
    expect(screen.getByTestId('model-option-model-a')).toBeInTheDocument();
    expect(screen.queryByTestId('model-option-model-b')).not.toBeInTheDocument();
  });
});

describe('【魔鬼用例 1】Hover 展开不抢焦（Modality-Aware 纯视觉展开）', () => {
  it('悬停服务商行 80ms 展开子菜单，触发源保持焦点，绝不被子菜单首项抢焦', async () => {
    seedProfiles();
    render(<Wrapper />);
    const trigger = screen.getByTestId('model-badge-trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();

    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    // 80ms 后子菜单在 Portal 中挂载渲染
    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    expect(submenu).toBeInTheDocument();

    // 刚性断言：焦点牢牢保留在触发源，子菜单首项绝不夺焦
    expect(trigger).toHaveFocus();
    expect(screen.getByTestId('model-option-model-a')).not.toHaveFocus();
  });

  it('行按钮聚焦时，Hover 展开子菜单绝不夺焦，焦点依然留在原行按钮', async () => {
    seedMultiProfiles();
    render(<Wrapper />);

    const rowP1 = screen.getByTestId('profile-item-p1');
    const rowP2 = screen.getByTestId('profile-item-p2');

    // 聚焦在 rowP2
    rowP2.focus();
    expect(rowP2).toHaveFocus();

    // 鼠标 hover 在 rowP1 上
    fireEvent.mouseEnter(rowP1);

    await screen.findByRole('menu', { name: '服务商 1 模型列表' });

    // 断言：焦点依然停留在 rowP2，绝不被 rowP1 子菜单项夺焦
    expect(rowP2).toHaveFocus();
    expect(screen.getByTestId('model-option-model-1a')).not.toHaveFocus();
  });

  it('鼠标移出服务商行，在 150ms 宽限期后平滑收起子菜单', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.mouseEnter(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    // 移出服务商行
    fireEvent.mouseLeave(row);

    // 150ms 宽限期后子菜单平滑销毁
    await waitFor(
      () => expect(screen.queryByRole('menu')).not.toBeInTheDocument(),
      { timeout: 1000 }
    );
  });
});

describe('【魔鬼用例 2】SafeTriangle 轨迹保护（三角区几何防抖与 Grace Timer 状态机）', () => {
  it('鼠标从服务商行斜向掠过相邻行滑向子菜单时，处于 300ms 宽限期内不被相邻行销毁', async () => {
    seedMultiProfiles();
    render(<Wrapper />);

    const rowP1 = screen.getByTestId('profile-item-p1');
    const rowP2 = screen.getByTestId('profile-item-p2');

    // 1. 悬停展开 p1 子菜单
    fireEvent.mouseEnter(rowP1);
    const submenu = await screen.findByRole('menu', {
      name: '服务商 1 模型列表',
    });
    expect(submenu).toBeInTheDocument();

    // 2. 模拟真实几何布局：向右展开 (side === 'right')
    // rowP1 在 (100, 100, w:170, h:36)，submenu 在右侧 (274, 96, w:190, h:280)
    // rowP2 在 rowP1 正下方 (100, 136, w:170, h:36)
    vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
      left: 274,
      right: 464,
      top: 96,
      bottom: 376,
      width: 190,
      height: 280,
      x: 274,
      y: 96,
      toJSON: () => {},
    } as DOMRect);

    // 3. 鼠标从 rowP1 右边缘离开，指向子菜单 (clientX: 270, clientY: 118)
    fireEvent.mouseLeave(rowP1, { clientX: 270, clientY: 118 });

    // 4. 鼠标斜向移动，掠过相邻服务商 rowP2 (clientX: 272, clientY: 140) —— 严格处于 SafeTriangle 区域内
    fireEvent.mouseEnter(rowP2, { clientX: 272, clientY: 140 });

    // 5. 验证：p1 子菜单依然存在，且 p2 的子菜单绝未被触发替换！
    expect(
      screen.getByRole('menu', { name: '服务商 1 模型列表' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('menu', { name: '服务商 2 模型列表' })
    ).not.toBeInTheDocument();

    // 6. 鼠标成功滑入子菜单内部，触发 reach() 常驻保持
    fireEvent.mouseEnter(submenu);

    expect(
      screen.getByRole('menu', { name: '服务商 1 模型列表' })
    ).toBeInTheDocument();
  });

  it('鼠标移出 SafeTriangle 安全三角区后，相邻服务商能够正常接管展开', async () => {
    seedMultiProfiles();
    render(<Wrapper />);

    const rowP1 = screen.getByTestId('profile-item-p1');
    const rowP2 = screen.getByTestId('profile-item-p2');

    // 悬停展开 p1 子菜单
    fireEvent.mouseEnter(rowP1);
    const submenu = await screen.findByRole('menu', {
      name: '服务商 1 模型列表',
    });

    vi.spyOn(submenu, 'getBoundingClientRect').mockReturnValue({
      left: 274,
      right: 464,
      top: 96,
      bottom: 376,
      width: 190,
      height: 280,
      x: 274,
      y: 96,
      toJSON: () => {},
    } as DOMRect);

    // 鼠标从 rowP1 移出
    fireEvent.mouseLeave(rowP1, { clientX: 270, clientY: 118 });

    // 鼠标移至完全脱离安全三角区的位置 (clientX: 800, clientY: 500) 并进入 rowP2
    fireEvent.mouseEnter(rowP2, { clientX: 800, clientY: 500 });

    // 80ms 后成功切换展开 p2 子菜单
    await waitFor(() =>
      expect(
        screen.getByRole('menu', { name: '服务商 2 模型列表' })
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByRole('menu', { name: '服务商 1 模型列表' })
    ).not.toBeInTheDocument();
  });
});

describe('【魔鬼用例 3】低视口/极端靠左自适应 Flip Right 与 Chevron 动态联动', () => {
  it('在 600x400 低视口且靠左场景下展开：正确判定 side === right，坐标刚性钳位且渲染 ChevronRight', async () => {
    seedProfiles();
    geoEngine.setViewport({ width: 600, height: 400 });

    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');

    // 模拟行元素靠左 (left: 50, right: 220, top: 100, bottom: 136)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      right: 220,
      top: 100,
      bottom: 136,
      width: 170,
      height: 36,
      x: 50,
      y: 100,
      toJSON: () => {},
    } as DOMRect);

    // 点击展开
    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    expect(submenu).toBeInTheDocument();

    // 坐标判定：向右展开 targetX = 220 + 4 = 224px, targetY = 100 - 4 = 96px
    expect(submenu.style.left).toBe('224px');
    expect(submenu.style.top).toBe('96px');
    expect(submenu.style.transformOrigin).toBe('top left');

    // Chevron 联动：向右展开时必须动态渲染为 ChevronRight
    const chevron = row.querySelector('svg');
    expect(chevron).toBeInTheDocument();
    expect(chevron?.classList.contains('lucide-chevron-right')).toBe(true);
    expect(chevron?.classList.contains('lucide-chevron-left')).toBe(false);
  });

  it('在标准视口左侧空间充足时：默认向左展开 (side === left)，Chevron 渲染为 ChevronLeft', async () => {
    seedProfiles();
    geoEngine.setViewport({ width: 1280, height: 800 });

    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');

    // 模拟行元素位于中央靠右 (left: 600, right: 770, top: 300, bottom: 336)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      left: 600,
      right: 770,
      top: 300,
      bottom: 336,
      width: 170,
      height: 36,
      x: 600,
      y: 300,
      toJSON: () => {},
    } as DOMRect);

    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    expect(submenu).toBeInTheDocument();

    // 坐标判定：向左展开 targetX = 600 - 190 - 4 = 406px
    expect(submenu.style.left).toBe('406px');
    expect(submenu.style.top).toBe('296px');
    expect(submenu.style.transformOrigin).toBe('top right');

    // Chevron 联动：向左展开时动态渲染为 ChevronLeft
    const chevron = row.querySelector('svg');
    expect(chevron).toBeInTheDocument();
    expect(chevron?.classList.contains('lucide-chevron-left')).toBe(true);
    expect(chevron?.classList.contains('lucide-chevron-right')).toBe(false);
  });
});

describe('【魔鬼用例 4】键盘操作显式聚焦与漫游（Keyboard Roaming & Focus Return）', () => {
  it('在服务商行按 Enter 展开，焦点受控转移至子菜单首项/选中项', async () => {
    seedProfiles();
    render(<Wrapper activeModel="model-a" />);
    const row = screen.getByTestId('profile-item-p1');
    row.focus();
    expect(row).toHaveFocus();

    // 按 Enter 显式展开
    fireEvent.keyDown(row, { key: 'Enter' });

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    // 焦点受控转移至子菜单选中项
    await waitFor(() =>
      expect(screen.getByTestId('model-option-model-a')).toHaveFocus()
    );
  });

  it('在服务商行按方向键 ArrowLeft 展开（向左展开模式），焦点受控转移', async () => {
    seedProfiles();
    render(<Wrapper activeModel="model-b" />);
    const row = screen.getByTestId('profile-item-p1');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      left: 600,
      right: 770,
      top: 300,
      bottom: 336,
      width: 170,
      height: 36,
      x: 600,
      y: 300,
      toJSON: () => {},
    } as DOMRect);
    row.focus();

    // 在默认向左侧展开时按 ArrowLeft 键盘展开
    fireEvent.keyDown(row, { key: 'ArrowLeft' });

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });
    await waitFor(() =>
      expect(screen.getByTestId('model-option-model-b')).toHaveFocus()
    );
  });

  it('子菜单内 ↑/↓ 循环漫游与 Home/End 直达', async () => {
    seedProfiles();
    render(<Wrapper activeModel="model-a" />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    await waitFor(() =>
      expect(screen.getByTestId('model-option-model-a')).toHaveFocus()
    );

    // 按 ArrowDown 移至下一项
    fireEvent.keyDown(submenu, { key: 'ArrowDown' });
    expect(screen.getByTestId('model-option-model-b')).toHaveFocus();

    // 再按 ArrowDown 循环回到首项
    fireEvent.keyDown(submenu, { key: 'ArrowDown' });
    expect(screen.getByTestId('model-option-model-a')).toHaveFocus();

    // 按 ArrowUp 循环移至尾项
    fireEvent.keyDown(submenu, { key: 'ArrowUp' });
    expect(screen.getByTestId('model-option-model-b')).toHaveFocus();

    // 按 Home 直达首项
    fireEvent.keyDown(submenu, { key: 'Home' });
    expect(screen.getByTestId('model-option-model-a')).toHaveFocus();

    // 按 End 直达尾项
    fireEvent.keyDown(submenu, { key: 'End' });
    expect(screen.getByTestId('model-option-model-b')).toHaveFocus();
  });

  it('向左展开子菜单按反向键 ArrowRight 关闭子菜单，并将焦点精确归还父服务商行', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      left: 600,
      right: 770,
      top: 300,
      bottom: 336,
      width: 170,
      height: 36,
      x: 600,
      y: 300,
      toJSON: () => {},
    } as DOMRect);

    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    await waitFor(() =>
      expect(screen.getByTestId('model-option-model-a')).toHaveFocus()
    );

    // 在向左展开时，按反向键 ArrowRight 收起子菜单
    fireEvent.keyDown(submenu, { key: 'ArrowRight' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // 刚性断言：焦点精确归还给父行
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('向右展开子菜单按反向键 ArrowLeft 关闭子菜单，并将焦点精确归还父服务商行', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    // 靠左布局 -> side === 'right'
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
      left: 50,
      right: 220,
      top: 100,
      bottom: 136,
      width: 170,
      height: 36,
      x: 50,
      y: 100,
      toJSON: () => {},
    } as DOMRect);

    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    await waitFor(() =>
      expect(screen.getByTestId('model-option-model-a')).toHaveFocus()
    );

    // 在向右展开时，按反向键 ArrowLeft 收起子菜单
    fireEvent.keyDown(submenu, { key: 'ArrowLeft' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe('【魔鬼用例 5】滚动防脱轨收起（Scroll Auto-Dismiss & Self-Healing）', () => {
  it('主菜单容器触发滚动时，子菜单自动收起防脱轨悬空，并具备自愈恢复能力', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });
    expect(submenu).toBeInTheDocument();

    // 获取外层列表滚动容器 listContainerRef.current (row 的父节点的父节点)
    const listContainer = row.parentElement?.parentElement;
    expect(listContainer).toBeInTheDocument();

    // 触发滚动事件
    fireEvent.scroll(listContainer!);

    // 刚性断言：子菜单立即收起，防止脱轨
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // 自愈能力验证：再次点击行按钮，子菜单能够正常恢复展开
    fireEvent.click(row);
    expect(
      await screen.findByRole('menu', { name: '测试服务商 模型列表' })
    ).toBeInTheDocument();
  });
});

describe('点击选择模型与全量退出', () => {
  it('点击子菜单中的模型项：调用 activateProfileModel 并关闭全部菜单', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);

    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    const modelOptionB = screen.getByTestId('model-option-model-b');
    fireEvent.click(modelOptionB);

    // 验证调用了激活 API
    await waitFor(() =>
      expect(providerProfiles.activateProfileModel).toHaveBeenCalledWith(
        'p1',
        'model-b'
      )
    );

    // 验证全部菜单收起
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('Esc 逐级退栈与外点关闭（LayerStack 拓扑协作）', () => {
  it('第一击 Esc 关子菜单并归还焦点，第二击 Esc 关主菜单', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });

    // 第一击 Esc：子菜单收起，主菜单不关闭，焦点精确归还父行
    fireEvent.keyDown(submenu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await waitFor(() => expect(row).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();

    // 第二击 Esc：主菜单（Popover Dialog）响应关闭
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('外点关闭：点击菜单与子菜单外部区域，整体全部关闭', async () => {
    seedProfiles();
    const onClose = vi.fn();
    render(<Wrapper onClose={onClose} />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    const outside = document.createElement('button');
    outside.textContent = '外部空白区';
    document.body.appendChild(outside);

    fireEvent.pointerDown(outside);
    fireEvent.click(outside);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    outside.remove();
  });

  it('子菜单在 LayerStack 拓扑中正确注册为 cascade-submenu 且绑定 parentId', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    const layers = layerStackService.getLayers();
    const subLayer = layers.find((l) => l.type === 'cascade-submenu');
    const mainLayer = layers.find((l) => l.type === 'dropdown-menu');

    expect(subLayer).toBeDefined();
    expect(mainLayer).toBeDefined();
    expect(subLayer?.parentId).toBe(mainLayer?.id);
  });
});

describe('DialogOverlay 容器挂载与全屏模态穿透', () => {
  it('在 DialogOverlayContext 存在时，子菜单 Portal 精确挂载至该自定义容器', async () => {
    seedProfiles();
    const customOverlay = document.createElement('div');
    customOverlay.setAttribute('data-testid', 'custom-overlay-container');
    document.body.appendChild(customOverlay);

    render(
      <DialogOverlayContext.Provider value={customOverlay}>
        <Wrapper />
      </DialogOverlayContext.Provider>
    );

    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    const submenu = await screen.findByRole('menu', {
      name: '测试服务商 模型列表',
    });

    // 刚性断言：子菜单 Portal 挂载在 customOverlay 内部，而不是 document.body 顶层
    expect(customOverlay.contains(submenu)).toBe(true);

    customOverlay.remove();
  });
});

describe('window.blur / visibilitychange RAII 全生命周期自愈', () => {
  it('触发 window blur 时，子菜单自动收起并重置状态', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    // 触发 window blur
    fireEvent.blur(window);

    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });

  it('触发 document visibilitychange 时，子菜单自动收起', async () => {
    seedProfiles();
    render(<Wrapper />);
    const row = screen.getByTestId('profile-item-p1');
    fireEvent.click(row);

    await screen.findByRole('menu', { name: '测试服务商 模型列表' });

    // 触发 visibilitychange
    fireEvent(document, new Event('visibilitychange'));

    await waitFor(() =>
      expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    );
  });
});

describe('Anchor 模式与二次点击防重开（Double Toggle 免疫）', () => {
  it('点击徽标打开，再次 pointerdown+click 关闭且不触发重开', async () => {
    seedProfiles();
    render(<Wrapper />);
    expect(screen.getByText('测试服务商')).toBeInTheDocument();

    const trigger = screen.getByTestId('model-badge-trigger');
    fireEvent.pointerDown(trigger);
    fireEvent.pointerUp(trigger);
    fireEvent.click(trigger);

    await waitFor(() =>
      expect(screen.queryByText('测试服务商')).not.toBeInTheDocument()
    );
    expect(screen.queryByText('模型管理...')).not.toBeInTheDocument();
  });
});
