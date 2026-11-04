// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/SplitResizer/SplitResizer.test.tsx
 *
 * ui/SplitResizer 契约测试：
 * - 渲染与无障碍基线（role / aria-value* / i18n 文案走真实词典）；
 * - rest 两态、聚焦浮现、键盘提交、拖拽全链路（live 变量 + 引擎喂数）；
 * - 样式源码棘轮：中性灰口径（无 accent 令牌 / 无辉光）、--z-resizer、热区 8px。
 * 测头自钉：源码棘轮 ≠ CSSOM 已进产品视口 ≠ 实机观感验收（迁移波次以截图为准）。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SplitResizer, type SplitResizerProps } from './SplitResizer';
import styles from './SplitResizer.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));
const CSS_SRC = readFileSync(join(DIR, 'SplitResizer.module.css'), 'utf8');
const TSX_SRC = readFileSync(join(DIR, 'SplitResizer.tsx'), 'utf8');
const ENGINE_SRC = readFileSync(join(DIR, 'elasticHandle.ts'), 'utf8');

let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafSeq = 0;
let nowMs = 0;

function flushFrames(count: number, stepMs = 16) {
  for (let i = 0; i < count; i += 1) {
    nowMs += stepMs;
    const pending = rafQueue;
    rafQueue = [];
    pending.forEach(({ cb }) => cb(nowMs));
    if (rafQueue.length === 0 && pending.length === 0) break;
  }
}

beforeEach(() => {
  rafQueue = [];
  rafSeq = 0;
  nowMs = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafSeq += 1;
    rafQueue.push({ id: rafSeq, cb });
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    rafQueue = rafQueue.filter((entry) => entry.id !== id);
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function Fixture({
  onCommit,
  ...extra
}: { onCommit: (v: number) => void } & Partial<SplitResizerProps>) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  return (
    <div ref={wrapRef} style={{ display: 'flex' }}>
      <div data-testid="panel" style={{ width: 260 }} />
      <SplitResizer
        value={260}
        min={160}
        max={480}
        onCommit={onCommit}
        liveVarTargetRef={wrapRef}
        {...extra}
      />
    </div>
  );
}

describe('ui/SplitResizer 渲染与无障碍基线', () => {
  it('role=separator + aria 全套，文案走真实 i18n 词典', () => {
    const onCommit = vi.fn();
    render(<Fixture onCommit={onCommit} />);
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'vertical');
    expect(sep).toHaveAttribute('aria-valuemin', '160');
    expect(sep).toHaveAttribute('aria-valuemax', '480');
    expect(sep).toHaveAttribute('aria-valuenow', '260');
    expect(sep).toHaveAttribute('aria-label', '调整分栏尺寸');
    expect(sep).toHaveAttribute('aria-valuetext', '当前 260 像素');
    expect(sep).toHaveAttribute('tabIndex', '0');
  });

  it("rest='hidden'（默认）不渲染常显线；'hairline' 渲染 --border-subtle 发丝线节点", () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(<Fixture onCommit={onCommit} />);
    expect(container.querySelector(`.${styles.hairline}`)).toBeNull();
    rerender(<Fixture onCommit={onCommit} rest="hairline" />);
    expect(container.querySelector(`.${styles.hairline}`)).not.toBeNull();
  });

  it('horizontal 方向：aria-orientation 与 viewBox 随向切换', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Fixture onCommit={onCommit} orientation="horizontal" />
    );
    const sep = screen.getByRole('separator');
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal');
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '-70 -60 140 120'
    );
  });

  it('键盘步进经 hook 提交（方向键 +10）', () => {
    const onCommit = vi.fn();
    render(<Fixture onCommit={onCommit} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledWith(270);
  });

  it('聚焦后手柄浮现：推进帧后 path opacity 大于 0', () => {
    const onCommit = vi.fn();
    const { container } = render(<Fixture onCommit={onCommit} />);
    const sep = screen.getByRole('separator');
    const path = container.querySelector('path');
    expect(path?.getAttribute('opacity')).toBe('0');
    fireEvent.focus(sep);
    flushFrames(40);
    expect(Number(path?.getAttribute('opacity'))).toBeGreaterThan(0.9);
    fireEvent.blur(sep);
    flushFrames(80);
    expect(Number(path?.getAttribute('opacity'))).toBeLessThan(0.1);
  });

  it('去阻尼与手柄动效契约：拖拽中宽度即时到达 1:1 跟手，手柄同帧推进', () => {
    const onCommit = vi.fn();
    const { container } = render(<Fixture onCommit={onCommit} />);
    const sep = screen.getByRole('separator');
    const wrap = container.firstElementChild as HTMLElement;
    const path = container.querySelector('path');

    fireEvent.pointerDown(sep, { button: 0, pointerId: 37, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 37, clientX: 340 });
    // 仅推进 3 帧（48ms）：去尺寸阻尼后宽度即时等于 300，零滞后
    flushFrames(3);
    const midLive = parseFloat(
      wrap.style.getPropertyValue('--split-resizer-live')
    );
    expect(midLive).toBe(300);
    // 同帧手柄已被同一时钟推进（不透明度离开 0）
    expect(Number(path?.getAttribute('opacity'))).toBeGreaterThan(0);
    // 给足时间后收敛到提交值
    flushFrames(90);
    expect(
      parseFloat(wrap.style.getPropertyValue('--split-resizer-live'))
    ).toBeCloseTo(300, 0);
    fireEvent.pointerUp(window, { pointerId: 37, clientX: 340 });
    expect(onCommit).toHaveBeenCalledWith(300);
  });

  it('拖拽全链路：live 变量随呈现值写入父元素，松手提交并最终撤下变量', () => {
    const onCommit = vi.fn();
    const { container } = render(<Fixture onCommit={onCommit} />);
    const sep = screen.getByRole('separator');
    const wrap = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(sep, { button: 0, pointerId: 31, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 31, clientX: 340 });
    flushFrames(30);
    const live = wrap.style.getPropertyValue('--split-resizer-live');
    expect(live).not.toBe('');
    expect(parseFloat(live)).toBeGreaterThan(290);

    fireEvent.pointerUp(window, { pointerId: 31, clientX: 340 });
    expect(onCommit).toHaveBeenCalledWith(300);
    flushFrames(120);
    expect(wrap.style.getPropertyValue('--split-resizer-live')).toBe('');
  });

  it('liveCollapse：拖过阈值未松手，live 变量已由弹簧收至近 0（当场收起）；拖回阈值之上恢复，松手按宽度提交', () => {
    const onCommit = vi.fn();
    const onCollapse = vi.fn();
    const { container } = render(
      <Fixture
        onCommit={onCommit}
        collapseBelow={120}
        liveCollapse
        onCollapse={onCollapse}
      />
    );
    const sep = screen.getByRole('separator');
    const wrap = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(sep, { button: 0, pointerId: 43, clientX: 300 });
    // raw = 260 - 200 = 60 < 120：进入折叠区，呈现目标归 0
    fireEvent.pointerMove(window, { pointerId: 43, clientX: 100 });
    flushFrames(90);
    const collapsedLive = parseFloat(
      wrap.style.getPropertyValue('--split-resizer-live')
    );
    expect(collapsedLive).toBeGreaterThanOrEqual(0);
    expect(collapsedLive).toBeLessThan(30);
    // 折叠提交尚未落定：onCollapse 只在松手时触发
    expect(onCollapse).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    // 拖回：raw = 260 + 40 = 300 ≥ 120 + 24（退出线）→ 呈现恢复
    fireEvent.pointerMove(window, { pointerId: 43, clientX: 340 });
    flushFrames(90);
    expect(
      parseFloat(wrap.style.getPropertyValue('--split-resizer-live'))
    ).toBeCloseTo(300, 0);
    fireEvent.pointerUp(window, { pointerId: 43, clientX: 340 });
    expect(onCommit).toHaveBeenCalledWith(300);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('liveCollapse：折叠区内松手走 onCollapse 而非 onCommit', () => {
    const onCommit = vi.fn();
    const onCollapse = vi.fn();
    render(
      <Fixture
        onCommit={onCommit}
        collapseBelow={120}
        liveCollapse
        onCollapse={onCollapse}
      />
    );
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { button: 0, pointerId: 47, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 47, clientX: 100 });
    flushFrames(10);
    fireEvent.pointerUp(window, { pointerId: 47, clientX: 100 });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('拖拽中按住不动至弹簧静止：live 变量保留在弹簧值上，不回落到旧状态宽度', () => {
    const onCommit = vi.fn();
    const { container } = render(<Fixture onCommit={onCommit} />);
    const sep = screen.getByRole('separator');
    const wrap = container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(sep, { button: 0, pointerId: 41, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 41, clientX: 340 });
    // 推进到全部弹簧静止（仍按住不放）：变量必须保留 300px 而非被撤下
    flushFrames(150);
    expect(wrap.style.getPropertyValue('--split-resizer-live')).toBe('300px');
    // 再次移动可重新驱动弹簧
    fireEvent.pointerMove(window, { pointerId: 41, clientX: 320 });
    flushFrames(90);
    expect(wrap.style.getPropertyValue('--split-resizer-live')).toBe('280px');
    fireEvent.pointerUp(window, { pointerId: 41, clientX: 320 });
    expect(onCommit).toHaveBeenCalledWith(280);
  });

  it('onDragStateChange 透传：按下 true / 松手 false，与引擎状态机同点', () => {
    const onCommit = vi.fn();
    const onDragStateChange = vi.fn();
    render(
      <Fixture onCommit={onCommit} onDragStateChange={onDragStateChange} />
    );
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { button: 0, pointerId: 51, clientX: 300 });
    expect(onDragStateChange).toHaveBeenCalledTimes(1);
    expect(onDragStateChange).toHaveBeenLastCalledWith(true);
    fireEvent.pointerMove(window, { pointerId: 51, clientX: 340 });
    fireEvent.pointerUp(window, { pointerId: 51, clientX: 340 });
    expect(onDragStateChange).toHaveBeenCalledTimes(2);
    expect(onDragStateChange).toHaveBeenLastCalledWith(false);
  });

  it('onRest：拖拽回弹收尾至静止后触发（触发时 live 变量已撤下）', () => {
    const onCommit = vi.fn();
    const onRest = vi.fn();
    const { container } = render(
      <Fixture onCommit={onCommit} onRest={onRest} />
    );
    const sep = screen.getByRole('separator');
    const wrap = container.firstElementChild as HTMLElement;
    // 挂载后首帧即有一次「呈现停转」通知（文档语义），先清零再测拖拽收尾
    flushFrames(5);
    onRest.mockClear();

    fireEvent.pointerDown(sep, { button: 0, pointerId: 53, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 53, clientX: 340 });
    fireEvent.pointerUp(window, { pointerId: 53, clientX: 340 });
    expect(onCommit).toHaveBeenCalledWith(300);
    // 松手瞬间弹簧仍在回弹收尾，onRest 不得提前触发
    expect(onRest).not.toHaveBeenCalled();
    flushFrames(150);
    expect(onRest).toHaveBeenCalled();
    expect(wrap.style.getPropertyValue('--split-resizer-live')).toBe('');
  });

  it('reducedMotion 覆盖：手柄一步到位（单帧即达目标不透明度）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <Fixture onCommit={onCommit} reducedMotion={true} />
    );
    const sep = screen.getByRole('separator');
    const path = container.querySelector('path');
    fireEvent.focus(sep);
    flushFrames(1);
    expect(Number(path?.getAttribute('opacity'))).toBe(1);
  });
});

describe('ui/SplitResizer 样式与源码棘轮', () => {
  it('测头自钉：源码棘轮 ≠ CSSOM 已进产品视口 ≠ 实机观感验收', () => {
    const self = readFileSync(join(DIR, 'SplitResizer.test.tsx'), 'utf8');
    expect(self).toMatch(/源码棘轮 ≠ CSSOM 已进产品视口 ≠ 实机观感验收/);
  });

  it('CSS：z-index 走 --z-resizer、发丝线走 --border-subtle、热区默认 8px', () => {
    expect(CSS_SRC).toMatch(/z-index:\s*var\(--z-resizer\)/);
    expect(CSS_SRC).toMatch(/background:\s*var\(--border-subtle\)/);
    expect(CSS_SRC).toMatch(/--sr-hit,\s*8px/);
    expect(CSS_SRC).toMatch(/cursor:\s*col-resize/);
    expect(CSS_SRC).toMatch(/cursor:\s*row-resize/);
  });

  it('中性灰口径：CSS 与 TSX 均不得出现三款 accent 绿令牌与辉光', () => {
    const combined = `${CSS_SRC}\n${TSX_SRC}\n${ENGINE_SRC}`;
    expect(combined).not.toMatch(/--accent-green/);
    expect(combined).not.toMatch(/--accent-primary/);
    expect(combined).not.toMatch(/--accent-color/);
    expect(combined).not.toMatch(/#10b981/i);
    expect(CSS_SRC).not.toMatch(/box-shadow/);
  });

  it('呈现红线：帧循环直写 path 属性（setAttribute），手柄本体无 CSS transition 冒充弹簧', () => {
    expect(TSX_SRC).toMatch(/setAttribute\('d'/);
    expect(TSX_SRC).toMatch(/requestAnimationFrame/);
    expect(CSS_SRC).not.toMatch(/transition/);
  });

  it('单时钟源码棘轮：宽度只能由引擎弹簧值绘制，禁止双轨', () => {
    // live 变量的唯一绘制点必须是 paintLiveVar(engine.displayValue)——
    // displayValue 即位置弹簧当前值，与手柄形态同出一个 engine.step()
    expect(TSX_SRC).toMatch(/paintLiveVar\(engine\.displayValue\)/);
    // 组件不得启用 hook 的 liveCssVar 目标值直写通道（那是给非弹性消费者的
    // 独立能力）；在本组件内出现即意味着宽度与手柄分属两套时钟
    expect(TSX_SRC).not.toMatch(/liveCssVar/);
    // 引擎是唯一时钟源：path 与宽度在同一 paintFrame 内写出
    expect(TSX_SRC).toMatch(/engine\.step\(/);
  });

  it('引擎源码钉住演示弹簧预设关键值（340/320/290）', () => {
    expect(ENGINE_SRC).toMatch(/position:\s*\{\s*stiffness:\s*340/);
    expect(ENGINE_SRC).toMatch(/offsetX:\s*\{\s*stiffness:\s*320/);
    expect(ENGINE_SRC).toMatch(/bend:\s*\{\s*stiffness:\s*290/);
  });
});
