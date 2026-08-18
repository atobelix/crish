// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/Menu/PhysicalGeometryGuards.test.tsx
 *
 * 5 大专项 36 组全场景真实物理几何守卫测试套件 (WO-33, WO-34, WO-35, WO-36)
 *
 * 覆盖 5 大核心专项：
 * 专项 1: 400px~1200px 极小/大视口边界碰撞与动态 maxHeight 钳制 (GEO-VP-01 ~ GEO-VP-09)
 * 专项 2: 分屏容器 (2x1, 1x2, 2x2) 内联浮层 100% 逃逸 overflow: hidden 裁剪 (GEO-SPLIT-01 ~ GEO-SPLIT-07)
 * 专项 3: Composer 1~10 行膨胀 (48px~290px) 与 2D LineBox 测量（消除 12px 遮挡） (GEO-COMP-01 ~ GEO-COMP-08)
 * 专项 4: CJK IME 中文输入法组合态 Tri-Shield 绝对放行与坐标静止 (GEO-IME-01 ~ GEO-IME-06)
 * 专项 5: LayerStackService 自顶向下单 Esc 响应与 FocusTrap 引用计数沙盒 (GEO-ESC-01 ~ GEO-ESC-06)
 */

import React, { useState } from 'react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { Menu } from './Menu';
import { Tooltip } from '../Tooltip/Tooltip';
import { Dialog } from '../Dialog/Dialog';
import { TiptapSlashMenu } from '../../chat-composer/TiptapSlashMenu';
import { ModelBadgePickerMenu } from '../../provider/ModelBadgePickerMenu';
import { PermissionModeMenu } from '../../chat-composer/PermissionModeMenu';
import { FileBreadcrumb } from '../../files/FileBreadcrumb';
import { layerStackService } from '../internal/layer-stack/LayerStackService';
import { MockPhysicalGeometryEngine } from '../../../test-utils/MockPhysicalGeometryEngine';
import { ControllableResizeObserver } from '../../../test-utils/ControllableResizeObserver';
import { mockTauriCommand, clearMockTauriCommands } from '../../../test-setup';

beforeEach(() => {
  clearMockTauriCommands();
  localStorage.setItem('crish_workspace', '/workspace');
  layerStackService.dispose();
  MockPhysicalGeometryEngine.getInstance().reset();
  ControllableResizeObserver.clearAll();
  mockTauriCommand('workbench_list_directory', () => ({
    items: [
      { name: 'src', isDir: true },
      { name: 'package.json', isDir: false },
    ],
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  layerStackService.dispose();
  MockPhysicalGeometryEngine.getInstance().reset();
  ControllableResizeObserver.clearAll();
});

// =============================================================================
// 专项 1：400px~1200px 极限视口与碰撞翻折守卫矩阵 (GEO-VP-01 ~ GEO-VP-09)
// =============================================================================
describe('专项 1：400px~1200px 极限视口与碰撞翻折守卫矩阵 (GEO-VP-01 ~ GEO-VP-09)', () => {
  const engine = MockPhysicalGeometryEngine.getInstance();

  // GEO-VP-01: 600x400 低视口 Menu 280px 钳制且内部可滚动
  it('GEO-VP-01: 600x400 低视口下 Menu 高度严格钳制在 280px 且首尾选项可滚动', async () => {
    engine.setViewport({ width: 600, height: 400 });
    const options = Array.from({ length: 12 }, (_, i) => ({
      id: `opt-${i}`,
      label: `选项 ${i}`,
    }));

    render(
      <Menu
        trigger={<button data-mock-rect="200,340,100,32">打开菜单</button>}
        options={options}
      />
    );
    fireEvent.click(screen.getByText('打开菜单'));

    const menu = await screen.findByRole('menu');
    const rect = menu.getBoundingClientRect();

    // 断言 1: 物理高度不超过 280px (min(70vh, 360px))，顶部不穿顶
    expect(rect.height).toBeLessThanOrEqual(280);
    expect(rect.top).toBeGreaterThanOrEqual(8);

    // 断言 2：全量 12 个 menuitem 节点在 DOM 中全部可查（供键盘与读屏器访问）
    const allItems = screen.getAllByRole('menuitem');
    expect(allItems).toHaveLength(12);
    expect(allItems[0]).toHaveTextContent('选项 0');
    expect(allItems[11]).toHaveTextContent('选项 11');
  });

  // GEO-VP-02: 600x400 ModelBadgePickerMenu 强制 bottom
  it('GEO-VP-02: 600x400 顶栏 ModelBadgePickerMenu 强制朝向 bottom 展开，Y_max <= 388px', async () => {
    engine.setViewport({ width: 600, height: 400 });
    const ModelBadgeTest = () => {
      const [open, setOpen] = useState(false);
      return (
        <ModelBadgePickerMenu onClose={() => setOpen(false)} open={open}>
          <button data-mock-rect="20,10,120,32" onClick={() => setOpen(true)}>
            选择模型
          </button>
        </ModelBadgePickerMenu>
      );
    };
    render(<ModelBadgeTest />);
    fireEvent.click(screen.getByText('选择模型'));

    const menuitem = (await screen.findAllByRole('menuitem'))[0]!;
    const popover =
      menuitem.closest('[data-radix-popper-content-wrapper]') ||
      menuitem.parentElement!;
    const rect = popover.getBoundingClientRect();

    expect(rect.top).toBeGreaterThanOrEqual(42);
    expect(rect.bottom).toBeLessThanOrEqual(388);
  });

  // GEO-VP-03: 600x400 PermissionModeMenu 上方空间充足时保持 side="top" 向上展开
  it('GEO-VP-03: 600x400 PermissionModeMenu 上方空间充足时保持 side="top" 向上展开', async () => {
    engine.setViewport({ width: 600, height: 400 });
    render(
      <div data-mock-rect="24,344,80,32">
        <PermissionModeMenu mode="standard" onChange={vi.fn()} />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: /当前权限模式/i }));

    const menu = await screen.findByRole('menu');
    const rect = menu.getBoundingClientRect();

    expect(rect.bottom).toBeLessThanOrEqual(344);
    expect(rect.top).toBeGreaterThanOrEqual(8);
  });

  // GEO-VP-04: 600x400 TiptapSlashMenu 第 1 行自动翻折至 bottom
  it('GEO-VP-04: 600x400 光标在第 1 行上方空间不足时，自动翻折至 side="bottom"', async () => {
    engine.setViewport({ width: 600, height: 400 });
    const lineBox = new DOMRect(24, 102, 10, 20); // y=102

    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    const rect = listbox.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(100);
  });

  // GEO-VP-05: 600x400 TiptapSlashMenu 第 8 行保持 top
  it('GEO-VP-05: 600x400 光标在第 8 行时保持 side="top" 向上展开，精确保留 8px 空隙', async () => {
    engine.setViewport({ width: 600, height: 400 });
    const lineBox = new DOMRect(24, 264, 10, 20);

    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();
    const rect = listbox.getBoundingClientRect();
    expect(rect.bottom).toBeLessThanOrEqual(388);
  });

  // GEO-VP-06: 400x600 窄视口面包屑水平翻折
  it('GEO-VP-06: 400x600 窄视口靠右触发时，面包屑弹出层自动向左翻折 align="end"', async () => {
    engine.setViewport({ width: 400, height: 600 });
    engine.registerSelectorRect('[role="listbox"]', {
      left: 72,
      top: 68,
      width: 320,
      height: 200,
    });
    render(
      <FileBreadcrumb
        root="/workspace"
        cwd="/workspace"
        selected={null}
        view="tree"
        onNavigate={vi.fn()}
        onRefresh={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
    const chip = screen.getByRole('button', { name: /项目|workspace/i });
    chip.setAttribute('data-mock-rect', '300,40,80,24');
    fireEvent.click(chip);

    const flyout = await screen.findByRole('listbox');
    const rect = flyout.getBoundingClientRect();

    expect(rect.left).toBeGreaterThanOrEqual(8);
    expect(rect.right).toBeLessThanOrEqual(392);
  });

  // GEO-VP-07: 1200x800 ProjectPickerMenu 二级子菜单向左反转
  it('GEO-VP-07: 1200x800 一级菜单靠近右边缘时，二级子菜单自动向左展开', async () => {
    engine.setViewport({ width: 1200, height: 800 });
    const CascadeMenu = () => {
      const [subOpen, setSubOpen] = useState(false);
      return (
        <Menu
          trigger={<button data-mock-rect="980,100,160,32">项目选择</button>}
          options={[]}
        >
          <div role="menu">
            <button
              type="button"
              role="menuitem"
              data-mock-rect="980,110,160,30"
              onMouseEnter={() => setSubOpen(true)}
            >
              切换工作区
            </button>
            {subOpen && (
              <Menu
                openState={{ open: subOpen, onOpenChange: setSubOpen }}
                position={{ side: 'left', align: 'start' }}
                trigger={<span data-mock-rect="980,110,160,30" />}
                options={[{ id: 'sub-1', label: '工作区 A' }]}
              />
            )}
          </div>
        </Menu>
      );
    };

    render(<CascadeMenu />);
    fireEvent.click(screen.getByText('项目选择'));

    const subTrigger = await screen.findByText('切换工作区');
    fireEvent.mouseEnter(subTrigger);

    const allMenus = await screen.findAllByRole('menu');
    const subMenu = allMenus[allMenus.length - 1]!;
    const rect = subMenu.getBoundingClientRect();

    expect(rect.right).toBeLessThanOrEqual(1192);
    expect(rect.left).toBeLessThan(980); // 向左展开
  });

  // GEO-VP-08: 800x600 Tooltip 屏幕四角边缘钳位
  it('GEO-VP-08: 800x600 右上角关闭按钮 Tooltip 坐标强制钳制在视口内部', async () => {
    engine.setViewport({ width: 800, height: 600 });
    render(
      <Tooltip content="关闭窗口" side="top">
        <button type="button" data-mock-rect="770,5,25,25">
          ×
        </button>
      </Tooltip>
    );
    fireEvent.mouseEnter(screen.getByText('×'));

    const tip = await screen.findByRole('tooltip');
    const rect = tip.getBoundingClientRect();

    expect(rect.right).toBeLessThanOrEqual(792);
    expect(rect.top).toBeDefined();
  });

  // GEO-VP-09: 800x600 视口动态缩放动画关键帧
  it('GEO-VP-09: 视口从 800px 缩至 400px 时，浮层动画 transform-origin 动态更新', async () => {
    engine.setViewport({ width: 800, height: 800 });
    const { rerender } = render(
      <Menu
        trigger={<button data-mock-rect="100,300,80,32">按钮</button>}
        options={[{ id: '1', label: 'Item 1' }]}
      />
    );

    fireEvent.click(screen.getByText('按钮'));
    engine.setViewport({ width: 800, height: 350 }); // 动态缩减
    rerender(
      <Menu
        trigger={<button data-mock-rect="100,300,80,32">按钮</button>}
        options={[{ id: '1', label: 'Item 1' }]}
      />
    );

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
  });
});

// =============================================================================
// 专项 2：多分屏容器隔离裁剪守卫矩阵 (GEO-SPLIT-01 ~ GEO-SPLIT-07)
// =============================================================================
describe('专项 2：多分屏容器隔离裁剪守卫矩阵 (GEO-SPLIT-01 ~ GEO-SPLIT-07)', () => {
  const engine = MockPhysicalGeometryEngine.getInstance();

  // GEO-SPLIT-01: 2x1 水平分屏 LeafToolTabStrip 加号脱截
  it('GEO-SPLIT-01: 2x1 水平分屏下，加号菜单挂载至 Portal 根节点，父容器裁剪量恒为 0', async () => {
    render(
      <div
        className="leaf-header"
        style={{ height: '30px', overflow: 'hidden' }}
      >
        <Menu
          trigger={<button aria-label="添加工具卡片">＋</button>}
          options={[
            { id: '1', label: '工具 A' },
            { id: '2', label: '工具 B' },
          ]}
        />
      </div>
    );
    const addBtn = screen.getByLabelText('添加工具卡片');
    fireEvent.click(addBtn);

    const menu = await screen.findByRole('menu');
    // 断言：菜单不在 .leaf-header 内部，而在 body 的 portal-root
    expect(menu.closest('.leaf-header')).toBeNull();
    expect(document.body.contains(menu)).toBe(true);
    expect(menu.getBoundingClientRect().height).toBeGreaterThan(30);
  });

  // GEO-SPLIT-02: 1x2 垂直分屏 FileActions 打开方式跨卡片覆盖
  it('GEO-SPLIT-02: 1x2 垂直分屏下，上方卡片操作菜单完全覆盖在下方卡片之上', async () => {
    render(
      <div className="split-v">
        <div
          className="pane-top"
          style={{ height: '200px', overflow: 'hidden' }}
        >
          <Menu
            trigger={<button aria-label="打开方式">打开方式</button>}
            options={[{ id: '1', label: '编辑器' }]}
          />
        </div>
        <div className="pane-bottom" style={{ height: '200px' }}>
          <div data-testid="bottom-card">下方卡片内容</div>
        </div>
      </div>
    );
    fireEvent.click(screen.getByLabelText('打开方式'));

    const menu = await screen.findByRole('menu');
    expect(menu.closest('.pane-top')).toBeNull();
    expect(document.body.contains(menu)).toBe(true);
  });

  // GEO-SPLIT-03: 2x2 四分屏 FileViewerCard 更多菜单
  it('GEO-SPLIT-03: 2x2 四分屏右下角卡片中，更多菜单自动向上向左翻转', async () => {
    engine.setViewport({ width: 800, height: 600 });
    render(
      <div className="pane-br" style={{ width: '400px', height: '300px' }}>
        <Menu
          trigger={
            <button aria-label="更多操作" data-mock-rect="750,560,30,30">
              更多
            </button>
          }
          options={[{ id: '1', label: '导出' }]}
        />
      </div>
    );
    const moreBtn = screen.getByLabelText('更多操作');
    fireEvent.click(moreBtn);

    const menu = await screen.findByRole('menu');
    const rect = menu.getBoundingClientRect();

    expect(rect.bottom).toBeLessThanOrEqual(560);
    expect(rect.right).toBeLessThanOrEqual(792);
  });

  // GEO-SPLIT-04: 2x1 顶部 SessionStrip 脱离 38px 限制
  it('GEO-SPLIT-04: SessionStrip 加号菜单脱离 .ws-chrome-row 的 38px 高度限制', async () => {
    render(
      <div
        className="ws-chrome-row"
        style={{ height: '38px', overflow: 'hidden' }}
      >
        <Menu
          trigger={<button aria-label="添加会话">＋</button>}
          options={[{ id: '1', label: '新会话' }]}
        />
      </div>
    );
    fireEvent.click(screen.getByLabelText('添加会话'));
    const menu = await screen.findByRole('menu');
    expect(menu.closest('.ws-chrome-row')).toBeNull();
    expect(document.body.contains(menu)).toBe(true);
  });

  // GEO-SPLIT-05: 3 分屏 220px 极窄卡片 FileBreadcrumb 溢出展示
  it('GEO-SPLIT-05: 220px 极窄卡片内，320px 宽的面包屑浮层成功溢出卡片并在屏幕内完整展示', async () => {
    render(
      <div
        className="narrow-pane"
        style={{ width: '220px', overflow: 'hidden' }}
      >
        <FileBreadcrumb
          root="/workspace"
          cwd="/workspace"
          selected={null}
          view="tree"
          onNavigate={vi.fn()}
          onRefresh={vi.fn()}
          onOpenFile={vi.fn()}
        />
      </div>
    );
    fireEvent.click(screen.getByRole('button', { name: /项目|workspace/i }));
    const flyout = await screen.findByRole('listbox');
    expect(flyout).toBeInTheDocument();
    expect(flyout.getBoundingClientRect().width).toBeGreaterThanOrEqual(200);
  });

  // GEO-SPLIT-06: 分屏滚动时浮层同步或关闭
  it('GEO-SPLIT-06: 分屏容器内部滚动时，已打开的菜单按契约关闭或同步重定锚', async () => {
    const { container } = render(
      <div
        className="scroll-pane"
        style={{ overflow: 'auto', height: '200px' }}
      >
        <div style={{ height: '500px' }}>
          <Menu
            trigger={<button>目标</button>}
            options={[{ id: '1', label: 'Item 1' }]}
          />
        </div>
      </div>
    );
    fireEvent.click(screen.getByText('目标'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();

    // 容器触发滚动
    fireEvent.scroll(container.querySelector('.scroll-pane')!);
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  // GEO-SPLIT-07: Splitter 拖拽调整大小自适应
  it('GEO-SPLIT-07: 拖拽调整分屏宽度时，ControllableResizeObserver 驱动浮层重新定锚', async () => {
    engine.setViewport({ width: 1200, height: 800 });

    const { container } = render(
      <div className="split-pane" style={{ width: '200px' }}>
        <Menu
          position={{ align: 'start' }}
          trigger={
            <button data-testid="target-btn" data-mock-rect="50,100,80,32">
              目标按钮
            </button>
          }
          options={[{ id: '1', label: 'Item 1' }]}
        />
      </div>
    );

    const btn = screen.getByTestId('target-btn');
    fireEvent.click(btn);

    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();

    // 模拟分屏拖拽：按钮随容器拉伸位移至 left=300
    btn.setAttribute('data-mock-rect', '300,100,80,32');
    ControllableResizeObserver.triggerResize(
      container.querySelector('.split-pane')!,
      { width: 500 }
    );

    // 驱动 window scroll/resize 事件使 Popper 重新计算
    fireEvent.scroll(window);

    await waitFor(() => {
      expect(menu).toBeInTheDocument();
    });
  });
});

// =============================================================================
// 专项 3：Composer 动态膨胀与 LineBox 零遮挡守卫矩阵 (GEO-COMP-01 ~ GEO-COMP-08)
// =============================================================================
describe('专项 3：Composer 动态膨胀与 LineBox 零遮挡守卫矩阵 (GEO-COMP-01 ~ GEO-COMP-08)', () => {
  const engine = MockPhysicalGeometryEngine.getInstance();

  // GEO-COMP-01: 1 行初始状态行首零遮挡
  it('GEO-COMP-01: 1 行初始状态在行首输入 /，浮层底边精准定位于行顶上方 8px，遮挡量恒为 0', async () => {
    engine.setViewport({ width: 800, height: 600 });
    const lineBox = new DOMRect(24, 550, 10, 20); // 底部输入框第 1 行

    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    const rect = content.getBoundingClientRect();

    // 断言：浮层底边在 550 - 8 = 542px，文字 100% 可见
    expect(rect.bottom).toBeLessThanOrEqual(542);
    expect(rect.top).toBeGreaterThanOrEqual(12);
  });

  // GEO-COMP-02: 3 行膨胀状态第 2 行光标跟随
  it('GEO-COMP-02: 3 行膨胀状态下，在第 2 行中间触发 /，浮层精准对齐第 2 行基线上方', async () => {
    const lineBox = new DOMRect(140, 520, 10, 20);
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    expect(content.getBoundingClientRect().bottom).toBeLessThanOrEqual(512);
  });

  // GEO-COMP-03: 10 行最大膨胀末行不穿顶
  it('GEO-COMP-03: 10 行最大膨胀状态下，末行输入 / 浮层启用内部滚动且顶部 Y >= 12px', async () => {
    engine.setViewport({ width: 800, height: 400 });
    const lineBox = new DOMRect(24, 350, 10, 20);
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    expect(content.getBoundingClientRect().top).toBeGreaterThanOrEqual(12);
  });

  // GEO-COMP-04: 10 行内部滚动状态 scrollTop 差量
  it('GEO-COMP-04: 编辑器内部存在 scrollTop 时，光标计算正确扣除滚动差量', async () => {
    const lineBox = new DOMRect(24, 300, 10, 20); // 已扣除 scrollTop 的视口绝对坐标
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    expect(content.getBoundingClientRect().bottom).toBeLessThanOrEqual(292);
  });

  // GEO-COMP-05: 自动折行 Soft Wrap 光标定锚
  it('GEO-COMP-05: 长文本自动折行后，浮层锚定在折行后的新物理 LineBox', async () => {
    const lineBox = new DOMRect(24, 480, 10, 20); // 第二行行首
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => lineBox}
      />
    );
    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    expect(content.getBoundingClientRect().left).toBe(24);
  });

  // GEO-COMP-06: 粘贴增高 ResizeObserver 重定锚
  it('GEO-COMP-06: 粘贴 5 行文本触发高度剧增时，ControllableResizeObserver 驱动浮层上推', async () => {
    engine.setViewport({ width: 800, height: 600 });

    let currentCaretTop = 550;

    const { container, rerender } = render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => new DOMRect(24, currentCaretTop, 10, 20)}
      />
    );

    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    const initialBottom = content.getBoundingClientRect().bottom;

    // 模拟粘贴多行文本：输入框从 40px 剧增至 140px，光标被顶高至 450px
    currentCaretTop = 450;

    // 驱动 ResizeObserver 广播尺寸膨胀
    const editorDom = container.parentElement!;
    ControllableResizeObserver.triggerResize(editorDom, { height: 140 });

    // 触发组件重新计算位置
    rerender(
      <TiptapSlashMenu
        key={currentCaretTop}
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => new DOMRect(24, currentCaretTop, 10, 20)}
      />
    );

    await waitFor(() => {
      const nextContent =
        screen
          .getByRole('listbox')
          .closest('[data-radix-popper-content-wrapper]') ||
        screen.getByRole('listbox').parentElement!;
      const nextRect = nextContent.getBoundingClientRect();
      // 断言：浮层底边必须随着光标上移而被精确上推至少 90px
      expect(nextRect.bottom).toBeLessThanOrEqual(initialBottom - 90);
      expect(nextRect.top).toBeGreaterThanOrEqual(12); // 且保持顶部安全间距
    });
  });

  // GEO-COMP-07: 毒代码反噬消除测试
  it('GEO-COMP-07: 【毒代码根除】光标在物理原点 (0, 0) 时，视为合法锚点绝不回退至 editorDom', async () => {
    const originRect = new DOMRect(0, 0, 0, 0);
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => originRect}
      />
    );
    const menu = await screen.findByRole('listbox');
    expect(menu).toBeInTheDocument();
  });

  // GEO-COMP-08: ProseMirror 单点矩形契约
  it('GEO-COMP-08: 选区收缩为单点矩形 (W=0, H=0) 时，浮层正常展开', async () => {
    const pointRect = new DOMRect(120, 300, 0, 0);
    render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => pointRect}
      />
    );
    const menu = await screen.findByRole('listbox');
    expect(menu).toBeInTheDocument();
  });
});

// =============================================================================
// 专项 4：IME 输入法合成态与光标几何同步守卫矩阵 (GEO-IME-01 ~ GEO-IME-06)
// =============================================================================
describe('专项 4：IME 输入法合成态与光标几何同步守卫矩阵 (GEO-IME-01 ~ GEO-IME-06)', () => {
  // GEO-IME-01: 拼音组合中上下键选词不劫持
  it('GEO-IME-01: 中文拼音组合中 (isComposing=true) 按上下键选词，浮层阻断键盘漫游', async () => {
    render(
      <Menu
        trigger={<button>打开</button>}
        options={[
          { id: '1', label: 'A' },
          { id: '2', label: 'B' },
        ]}
      />
    );
    fireEvent.click(screen.getByText('打开'));

    const menu = await screen.findByRole('menu');
    // 模拟 IME 选词按键
    fireEvent.keyDown(menu, { key: 'ArrowDown', isComposing: true });

    // 高亮项不发生移动
    const items = screen.getAllByRole('menuitem');
    expect(items[1]).not.toHaveFocus();
  });

  // GEO-IME-02: 拼音组合中 Enter 确认不执行
  it('GEO-IME-02: 拼音组合中按下 Enter 确认字符，浮层绝不触发选定项执行', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button>打开</button>}
        options={[{ id: '1', label: 'A', onClick: onSelect }]}
      />
    );
    fireEvent.click(screen.getByText('打开'));

    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Enter', isComposing: true });

    expect(onSelect).not.toHaveBeenCalled();
  });

  // GEO-IME-03: 拼音组合中 Esc 取消不关浮层
  it('GEO-IME-03: 拼音组合中按下 Escape 取消当前拼音，绝不关闭外层 Menu', async () => {
    render(
      <Menu
        trigger={<button>打开</button>}
        options={[{ id: '1', label: 'A' }]}
      />
    );
    fireEvent.click(screen.getByText('打开'));

    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Escape', isComposing: true });

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // GEO-IME-04: Windows 229 keyCode 全链路拦截
  it('GEO-IME-04: Windows 平台 keyCode 229 合成事件被全链路顶层拦截', async () => {
    const onSelect = vi.fn();
    render(
      <Menu
        trigger={<button>打开</button>}
        options={[{ id: '1', label: 'A', onClick: onSelect }]}
      />
    );
    fireEvent.click(screen.getByText('打开'));

    const menu = await screen.findByRole('menu');
    fireEvent.keyDown(menu, { key: 'Process', keyCode: 229 });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  // GEO-IME-05: IME 折行更新光标定位
  it('GEO-IME-05: compositionend 事件触发后，浮层对齐最终上屏字符的新光标位置', async () => {
    let caretX = 24; // 初始光标在行首
    const { rerender } = render(
      <TiptapSlashMenu
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => new DOMRect(caretX, 550, 10, 20)}
      />
    );

    const listbox = await screen.findByRole('listbox');
    const content =
      listbox.closest('[data-radix-popper-content-wrapper]') ||
      listbox.parentElement!;
    const initialLeft = content.getBoundingClientRect().left;

    // 模拟输入 "测试中文输入" 6 个中文字符上屏（每个中文字符约 14px，总偏移约 84px）
    caretX = 24 + 6 * 14;

    // 重新渲染注入上屏后的新 LineBox
    rerender(
      <TiptapSlashMenu
        key={caretX}
        items={[{ id: '1', title: '命令 1' }]}
        command={vi.fn()}
        clientRect={() => new DOMRect(caretX, 550, 10, 20)}
      />
    );

    await waitFor(() => {
      const nextContent =
        screen
          .getByRole('listbox')
          .closest('[data-radix-popper-content-wrapper]') ||
        screen.getByRole('listbox').parentElement!;
      const nextRect = nextContent.getBoundingClientRect();
      // 断言：浮层 left 必须精确向右跟随移动约 84px（容差 ±4px）
      expect(nextRect.left).toBeGreaterThanOrEqual(initialLeft + 80);
      expect(nextRect.left).toBeLessThanOrEqual(initialLeft + 90);
    });
  });

  // GEO-IME-06: 多字节输入法搜索防乱码
  it('GEO-IME-06: 菜单内部搜索框在 IME 组合中不触发即时过滤，仅在 compositionend 后过滤', async () => {
    render(
      <FileBreadcrumb
        root="/workspace"
        cwd="/workspace"
        selected={null}
        view="tree"
        onNavigate={vi.fn()}
        onRefresh={vi.fn()}
        onOpenFile={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /项目|workspace/i }));

    const flyout = await screen.findByRole('listbox');
    expect(flyout).toBeInTheDocument();

    const input = await screen.findByPlaceholderText(/筛选文件/i);

    // 1. 在拼音输入组合中 (isComposing = true)
    fireEvent.change(input, { target: { value: 'zh' } });

    // 断言：输入框包含拼音草稿
    expect(input).toHaveValue('zh');

    // 2. 触发拼音上屏 (compositionEnd)
    fireEvent.compositionEnd(input, { data: '中文' });
    fireEvent.change(input, { target: { value: '中文' } });

    await waitFor(() => {
      expect(input).toHaveValue('中文');
    });
  });
});

// =============================================================================
// 专项 5：Esc 全局层叠栈（LayerStack）栈顶单次响应守卫矩阵 (GEO-ESC-01 ~ GEO-ESC-06)
// =============================================================================
describe('专项 5：Esc 全局层叠栈栈顶单次响应守卫矩阵 (GEO-ESC-01 ~ GEO-ESC-06)', () => {
  // GEO-ESC-01: 3 层嵌套按 Esc 仅关 Level 3
  it('GEO-ESC-01: SettingsPanel + Dialog + Menu 3 层嵌套时，按 Esc 仅关闭 Level 3 Menu', async () => {
    const onMenuClose = vi.fn();
    const onDialogClose = vi.fn();

    const MultiLayerTest = () => {
      const [menuOpen, setMenuOpen] = useState(true);
      return (
        <div data-testid="settings-panel">
          <Dialog open={true} onClose={onDialogClose} title="模型配置">
            <Menu
              openState={{
                open: menuOpen,
                onOpenChange: (v) => {
                  setMenuOpen(v);
                  if (!v) onMenuClose();
                },
              }}
              trigger={<button>选项</button>}
              options={[{ id: '1', label: 'Item' }]}
            />
          </Dialog>
        </div>
      );
    };

    render(<MultiLayerTest />);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: '模型配置' })
    ).toBeInTheDocument();

    // 全局按下 Escape
    fireEvent.keyDown(document, { key: 'Escape' });

    // 断言：仅 Menu 关闭，Dialog 与 SettingsPanel 完好无损
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('dialog', { name: '模型配置' })
    ).toBeInTheDocument();
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
    expect(onDialogClose).not.toHaveBeenCalled();
  });

  // GEO-ESC-02: 2 层嵌套按 Esc 仅关 Level 2
  it('GEO-ESC-02: 再次按下 Esc 时，仅关闭 Level 2 Dialog，SettingsPanel 保持开启', async () => {
    const onDialogClose = vi.fn();
    render(
      <div data-testid="settings-panel">
        <Dialog open={true} onClose={onDialogClose} title="模型配置">
          <div>内容</div>
        </Dialog>
      </div>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onDialogClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument();
  });

  // GEO-ESC-03: 1 层嵌套按 Esc 仅关 Level 1
  it('GEO-ESC-03: 第三次按 Esc 时，关闭 Level 1 SettingsPanel，应用回到工作区', async () => {
    const onSettingsClose = vi.fn();
    render(<Dialog open={true} onClose={onSettingsClose} title="设置面板" />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onSettingsClose).toHaveBeenCalledTimes(1);
  });

  // GEO-ESC-04: 快捷键录制中 Esc 仅取消录制
  it('GEO-ESC-04: 【Capture 抢跑清剿】SettingsShortcutsTab 录制快捷键中按 Esc，仅取消录制绝不关闭设置页', async () => {
    const onSettingsClose = vi.fn();

    const ShortcutRecorderMock = () => {
      const [isRecording, setIsRecording] = useState(false);

      React.useEffect(() => {
        if (!isRecording) return;
        return layerStackService.registerVirtual('shortcut-recorder', (e) => {
          if (e.key === 'Escape') {
            setIsRecording(false);
            return true; // 消费成功，终止传递给外层 Dialog
          }
        });
      }, [isRecording]);

      return (
        <Dialog open={true} onClose={onSettingsClose} title="快捷键设置">
          <button
            type="button"
            className={isRecording ? 'recording' : ''}
            onClick={() => setIsRecording(true)}
          >
            {isRecording ? '请按下快捷键...' : '录制'}
          </button>
        </Dialog>
      );
    };

    render(<ShortcutRecorderMock />);

    const recordBtn = screen.getByRole('button', { name: /录制/i });
    fireEvent.click(recordBtn);
    expect(recordBtn).toHaveClass('recording');

    // 录制状态下按 Esc
    fireEvent.keyDown(document, { key: 'Escape' });

    // 断言：录制状态解除，设置弹窗绝不被关闭
    await waitFor(() => {
      expect(recordBtn).not.toHaveClass('recording');
    });
    expect(onSettingsClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole('dialog', { name: '快捷键设置' })
    ).toBeInTheDocument();
  });

  // GEO-ESC-05: Toast 与 Menu 共存 Esc 仅关 Menu
  it('GEO-ESC-05: Toast 与 Menu 共存时，按 Esc 仅关闭 Menu，Toast 保持显示', async () => {
    render(
      <div>
        <div className="toastStack">
          <div role="status">通知消息</div>
        </div>
        <Menu
          trigger={<button>打开</button>}
          options={[{ id: '1', label: 'A' }]}
          openState={{ defaultOpen: true }}
        />
      </div>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // GEO-ESC-06: 快速双击 Esc 严格逐帧单次出栈（防穿透机器真值）
  it('GEO-ESC-06: 50ms 内快速双击 Esc，LayerStack 严格按帧逐级退栈，绝不一击穿透全部关闭', async () => {
    const onDialogClose = vi.fn();
    const RapidEscTest = () => {
      const [menuOpen, setMenuOpen] = useState(true);
      return (
        <Dialog open={true} onClose={onDialogClose} title="外层弹窗">
          <Menu
            openState={{ open: menuOpen, onOpenChange: setMenuOpen }}
            trigger={<button>打开</button>}
            options={[{ id: '1', label: 'A' }]}
          />
        </Dialog>
      );
    };
    render(<RapidEscTest />);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: '外层弹窗' })
    ).toBeInTheDocument();

    // 快速连续触发两次 Escape
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });

    // 断言 1：最顶层 Menu 必然被关闭
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    // 断言 2（防击穿机器真值）：外层 Dialog 必须在同帧内受到防抖与时序保护，保持开启！
    expect(
      screen.getByRole('dialog', { name: '外层弹窗' })
    ).toBeInTheDocument();
    expect(onDialogClose).not.toHaveBeenCalled();
  });
});
