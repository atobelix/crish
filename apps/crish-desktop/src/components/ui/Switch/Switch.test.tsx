// @vitest-environment jsdom
/**
 * ui/Switch 完备单元测试 (v2.0.0 架构升级版)
 *
 * 覆盖：
 * - 基础渲染、WAI-ARIA 与 data-* 属性
 * - 受控 / 非受控双模驱动与状态派生
 * - 键盘导航（Space / Enter 与 IME isComposing 防御）
 * - Disabled 禁用与 Loading 锁定态
 * - 3 档尺寸（sm, md, lg）与 2px 四向对称留白
 * - Label 关联与 labelPlacement 排版
 * - Mount 状态锁（hasInteracted 防首屏误触与 Zero-FOUC 保证）
 * - CSS 物理动效、中轴对称定位与 Tokens 规范静态断言
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from '@testing-library/react';
import { Switch } from './Switch';
import styles from './Switch.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ui/Switch (v2.0.0 纯白流体胶囊与中轴对称版)', () => {
  describe('1. 基础渲染与 ARIA 规范', () => {
    it('渲染 role=switch 且 aria-checked 与 data-state 反映受控值', () => {
      const { rerender } = render(<Switch checked data-testid="sw" />);
      const sw = screen.getByRole('switch');
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).toHaveAttribute('data-state', 'checked');

      rerender(<Switch checked={false} data-testid="sw" />);
      expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(sw).toHaveAttribute('data-state', 'unchecked');
    });

    it('aria-label 替代命名：无 label 时播报自定义名称', () => {
      render(<Switch checked aria-label="暂停工作流" />);
      expect(
        screen.getByRole('switch', { name: '暂停工作流' })
      ).toBeInTheDocument();
    });

    it('转发自定义 className 与 HTML button 原生属性', () => {
      render(
        <Switch
          checked
          className="custom-switch-class"
          data-testid="my-switch"
          name="auto-sync"
        />
      );
      const sw = screen.getByTestId('my-switch');
      expect(sw.className).toContain('custom-switch-class');
      expect(sw).toHaveAttribute('name', 'auto-sync');
    });
  });

  describe('2. 受控与非受控模式', () => {
    it('受控模式：点击上报 onCheckedChange 且状态由外部持有', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <Switch checked={false} onCheckedChange={onChange} />
      );
      const sw = screen.getByRole('switch');

      fireEvent.click(sw);
      expect(onChange).toHaveBeenCalledWith(true);
      expect(sw).toHaveAttribute('aria-checked', 'true');

      rerender(<Switch checked={true} onCheckedChange={onChange} />);
      expect(sw).toHaveAttribute('aria-checked', 'true');
    });

    it('受控包装组件端到端联动', () => {
      function ControlledWrapper() {
        const [checked, setChecked] = useState(false);
        return (
          <Switch
            checked={checked}
            onCheckedChange={setChecked}
            label={checked ? '已开启' : '已关闭'}
          />
        );
      }
      render(<ControlledWrapper />);
      const sw = screen.getByRole('switch');
      expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(screen.getByText('已关闭')).toBeInTheDocument();

      fireEvent.click(sw);
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByText('已开启')).toBeInTheDocument();
    });

    it('非受控模式：defaultChecked 为初始值，点击后内部自管并上报', () => {
      const onChange = vi.fn();
      render(<Switch defaultChecked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');
      expect(sw).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(sw);
      expect(onChange).toHaveBeenCalledWith(true);
      expect(sw).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(sw);
      expect(onChange).toHaveBeenCalledWith(false);
      expect(sw).toHaveAttribute('aria-checked', 'false');
    });

    it('非受控模式：defaultChecked=true 时初始状态为开启', () => {
      render(<Switch defaultChecked={true} />);
      expect(screen.getByRole('switch')).toHaveAttribute(
        'aria-checked',
        'true'
      );
    });
  });

  describe('2.1 0ms 乐观响应状态机与异常回滚防死锁', () => {
    it('OPT-01: 受控模式下点击产生 0ms 乐观翻转，无需等待外部 rerender', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      // 点击前：unchecked
      expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(sw).toHaveAttribute('data-state', 'unchecked');

      // 0ms 点击发生
      fireEvent.click(sw);

      // 断言：回调已发出，且 DOM 在当前帧 0ms 立即翻转并激活动态类名
      expect(onChange).toHaveBeenCalledWith(true);
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).toHaveAttribute('data-state', 'checked');
      expect(sw.className).toContain(styles.hasInteracted);
    });

    it('OPT-02: 外部受控真源确认到达后，乐观标记平滑收敛且无视觉跳变', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <Switch checked={false} onCheckedChange={onChange} />
      );
      const sw = screen.getByRole('switch');

      fireEvent.click(sw);
      expect(sw).toHaveAttribute('aria-checked', 'true');

      // 模拟上层状态更新完成并重新传入 checked=true
      rerender(<Switch checked={true} onCheckedChange={onChange} />);

      // 依然维持 true，平滑过渡
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).toHaveAttribute('data-state', 'checked');
    });

    it('OPT-03: Devil-01 极速连续点击 5 次，状态交替反转并最终收敛', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      // 连续极速点击 5 次
      fireEvent.click(sw); // 1 -> true (opt)
      expect(sw).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(sw); // 2 -> false (back to external)
      expect(sw).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(sw); // 3 -> true (opt)
      expect(sw).toHaveAttribute('aria-checked', 'true');

      fireEvent.click(sw); // 4 -> false (back to external)
      expect(sw).toHaveAttribute('aria-checked', 'false');

      fireEvent.click(sw); // 5 -> true (opt)
      expect(sw).toHaveAttribute('aria-checked', 'true');

      expect(onChange).toHaveBeenCalledTimes(5);
      expect(onChange).toHaveBeenLastCalledWith(true);
    });

    it('OPT-04: 同步回调抛错时，乐观状态立即捕获并瞬时回滚', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const buggyOnChange = vi.fn(() => {
        throw new Error('Sync storage explosion');
      });

      render(<Switch checked={false} onCheckedChange={buggyOnChange} />);
      const sw = screen.getByRole('switch');

      // 点击触发异常
      fireEvent.click(sw);

      // 必须安全回滚回 false，不发生死锁
      expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(sw).toHaveAttribute('data-state', 'unchecked');
      errorSpy.mockRestore();
    });

    it('OPT-05: 异步 Promise Rejection 时，微任务捕获并自动回滚', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let rejectHandler!: (err: Error) => void;
      const asyncOnChange = vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectHandler = reject;
          })
      );

      render(<Switch checked={false} onCheckedChange={asyncOnChange} />);
      const sw = screen.getByRole('switch');

      fireEvent.click(sw);
      // 0ms 阶段处于乐观 true
      expect(sw).toHaveAttribute('aria-checked', 'true');

      // 模拟异步失败 Reject
      await act(async () => {
        rejectHandler(new Error('IPC network error'));
      });

      // 断言：已被微任务捕获并安全回滚回 false
      expect(sw).toHaveAttribute('aria-checked', 'false');
      expect(sw).toHaveAttribute('data-state', 'unchecked');
      errorSpy.mockRestore();
    });

    it('OPT-06: 超时防死锁机制，外部悬空 5000ms 时自动恢复真源', () => {
      vi.useFakeTimers();
      const onChange = vi.fn();
      render(
        <Switch
          checked={false}
          optimisticTimeout={1000}
          onCheckedChange={onChange}
        />
      );
      const sw = screen.getByRole('switch');

      fireEvent.click(sw);
      expect(sw).toHaveAttribute('aria-checked', 'true');

      // 时间推移 999ms，依然乐观
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(sw).toHaveAttribute('aria-checked', 'true');

      // 达到 1000ms 超时窗口，防死锁回滚生效
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(sw).toHaveAttribute('aria-checked', 'false');
      vi.useRealTimers();
    });

    it('OPT-07: optimistic=false 时禁用乐观响应，维持纯受控降级行为', () => {
      const onChange = vi.fn();
      const { rerender } = render(
        <Switch checked={false} optimistic={false} onCheckedChange={onChange} />
      );
      const sw = screen.getByRole('switch');

      fireEvent.click(sw);
      expect(onChange).toHaveBeenCalledWith(true);
      // 禁用乐观时，点击后 DOM 依然保持 false
      expect(sw).toHaveAttribute('aria-checked', 'false');

      rerender(
        <Switch checked={true} optimistic={false} onCheckedChange={onChange} />
      );
      expect(sw).toHaveAttribute('aria-checked', 'true');
    });

    it('OPT-08: 键盘 Space / Enter 触发 0ms 乐观响应', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      fireEvent.keyDown(sw, { key: ' ' });
      expect(onChange).toHaveBeenCalledWith(true);
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).toHaveAttribute('data-state', 'checked');
    });
  });

  describe('3. 键盘交互与 IME 输入法防御', () => {
    it('键盘 Space 与 Enter 均触发切换并阻止默认滚动行为', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      const spaceEvent = fireEvent.keyDown(sw, { key: ' ' });
      expect(onChange).toHaveBeenCalledWith(true);
      expect(spaceEvent).toBe(false);

      const enterEvent = fireEvent.keyDown(sw, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith(true);
      expect(enterEvent).toBe(false);
    });

    it('输入法组合态（isComposing=true）时按下空格不触发翻转', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      fireEvent.keyDown(sw, { key: ' ', isComposing: true });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('其它按键（如 Tab, ArrowDown）不触发切换', () => {
      const onChange = vi.fn();
      render(<Switch checked={false} onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      fireEvent.keyDown(sw, { key: 'Tab' });
      fireEvent.keyDown(sw, { key: 'ArrowDown' });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('透传并响应外部 onKeyDown 回调，若外部 preventDefault 则阻止内部切换', () => {
      const onKeyDown = vi.fn((e: React.KeyboardEvent<HTMLButtonElement>) => {
        e.preventDefault();
      });
      const onChange = vi.fn();
      render(
        <Switch
          checked={false}
          onKeyDown={onKeyDown}
          onCheckedChange={onChange}
        />
      );
      const sw = screen.getByRole('switch');

      fireEvent.keyDown(sw, { key: ' ' });
      expect(onKeyDown).toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('4. Disabled 与 Loading 状态', () => {
    it('disabled 态：禁用按钮、阻止点击与键盘事件、注入 aria-disabled', () => {
      const onChange = vi.fn();
      render(<Switch checked disabled onCheckedChange={onChange} />);
      const sw = screen.getByRole('switch');

      expect(sw).toBeDisabled();
      expect(sw).toHaveAttribute('aria-disabled', 'true');

      fireEvent.click(sw);
      fireEvent.keyDown(sw, { key: ' ' });
      fireEvent.keyDown(sw, { key: 'Enter' });
      expect(onChange).not.toHaveBeenCalled();
    });

    it('disabled 态下带 label 容器具有 data-disabled 属性', () => {
      const { container } = render(<Switch disabled label="网络代理" />);
      const wrap = container.querySelector(`.${styles.container}`);
      expect(wrap).toHaveAttribute('data-disabled', 'true');
    });

    it('loading 态：展示 Spinner、锁定交互、设置 aria-busy="true"，且无 checkmark 图标', () => {
      const onChange = vi.fn();
      const { container } = render(
        <Switch checked loading onCheckedChange={onChange} />
      );
      const sw = screen.getByRole('switch');

      expect(sw).toHaveAttribute('aria-busy', 'true');
      expect(sw.className).toContain(styles.loading);
      expect(container.querySelector(`.${styles.spinner}`)).toBeInTheDocument();
      // 验证 Checkmark 图标已被彻底移除
      expect(container.querySelector('.checkIcon')).toBeNull();

      fireEvent.click(sw);
      fireEvent.keyDown(sw, { key: ' ' });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('5. 尺寸（sm, md, lg）与数据属性', () => {
    it('默认尺寸为 md', () => {
      render(<Switch />);
      const sw = screen.getByRole('switch');
      expect(sw.className).toContain(styles['size-md']);
      expect(sw).toHaveAttribute('data-size', 'md');
    });

    it('支持 sm 与 lg 尺寸档位', () => {
      const { rerender } = render(<Switch size="sm" />);
      const sw = screen.getByRole('switch');
      expect(sw.className).toContain(styles['size-sm']);
      expect(sw).toHaveAttribute('data-size', 'sm');

      rerender(<Switch size="lg" />);
      expect(sw.className).toContain(styles['size-lg']);
      expect(sw).toHaveAttribute('data-size', 'lg');
    });
  });

  describe('6. Label 关联与布局位置', () => {
    it('默认 labelPlacement="start"：Label 位于开关左侧并通过 htmlFor 关联', () => {
      const onChange = vi.fn();
      render(
        <Switch checked={false} label="开启代理" onCheckedChange={onChange} />
      );
      const label = screen.getByText('开启代理');
      const sw = screen.getByRole('switch');

      expect(label).toHaveAttribute('for', sw.id);
      fireEvent.click(label);
      expect(onChange).toHaveBeenCalledWith(true);
    });

    it('支持 labelPlacement="end" 布局', () => {
      const { container } = render(
        <Switch label="后缀文案" labelPlacement="end" />
      );
      const wrap = container.querySelector(`.${styles.container}`);
      expect(wrap?.className).toContain(styles['align-end']);
      expect(screen.getByText('后缀文案')).toBeInTheDocument();
    });

    it('外部独立 label 可通过自定义 id 关联', () => {
      render(
        <>
          <label htmlFor="custom-switch-id">全局深色模式</label>
          <Switch id="custom-switch-id" checked />
        </>
      );
      const sw = screen.getByRole('switch');
      expect(sw.id).toBe('custom-switch-id');
    });
  });

  describe('7. Mount 状态锁与 Zero-FOUC 保证', () => {
    it('首屏初次挂载时不附加 hasInteracted 类名（防止首屏动效闪烁）', () => {
      render(<Switch defaultChecked={true} />);
      const sw = screen.getByRole('switch');
      expect(sw.className).not.toContain(styles.hasInteracted);
    });

    it('用户交互点击后立即注入 hasInteracted 激活动态拉伸动画', () => {
      render(<Switch defaultChecked={false} />);
      const sw = screen.getByRole('switch');
      expect(sw.className).not.toContain(styles.hasInteracted);

      fireEvent.click(sw);
      expect(sw.className).toContain(styles.hasInteracted);
    });

    it('挂载后外部受控 prop 发生变更时激活 hasInteracted', () => {
      const { rerender } = render(<Switch checked={false} />);
      const sw = screen.getByRole('switch');
      expect(sw.className).not.toContain(styles.hasInteracted);

      rerender(<Switch checked={true} />);
      expect(sw.className).toContain(styles.hasInteracted);
    });
  });

  describe('8. CSS Modules 物理动效与 Design Tokens 规范静态断言', () => {
    const css = readFileSync(join(DIR, 'Switch.module.css'), 'utf8');

    it('包含流体果冻拉伸关键帧：thumb-stretch-on 与 thumb-stretch-off', () => {
      expect(css).toMatch(/@keyframes thumb-stretch-on/);
      expect(css).toMatch(/@keyframes thumb-stretch-off/);
    });

    it('彻底移除对勾图标以保证视觉纯净度（无 checkmark-draw 与 checkIcon）', () => {
      expect(css).not.toMatch(/@keyframes checkmark-draw/);
      expect(css).not.toMatch(/\.checkIcon/);
    });

    it('滑块采用 top: 50% 与 translateY(-50%) 确保绝对垂直中轴对称', () => {
      expect(css).toMatch(/top:\s*50%/);
      expect(css).toMatch(/transform:\s*translateY\(-50%\)\s*translateX\(0\)/);
    });

    it('包含 0.5px 微发丝收边与漫反射阴影定义', () => {
      expect(css).toMatch(/0\s+0\s+0\s+0\.5px/);
      expect(css).toMatch(/var\(\s*--switch-thumb-shadow/);
    });

    it('全尺寸规格（sm, md, lg）均具备严格 2px 对称留白（--thumb-pad: 2px）', () => {
      const smMatch = css.match(/\.size-sm\s*\{([^}]+)\}/);
      const mdMatch = css.match(/\.size-md\s*\{([^}]+)\}/);
      const lgMatch = css.match(/\.size-lg\s*\{([^}]+)\}/);
      expect(smMatch?.[1]).toMatch(/--thumb-pad:\s*2px/);
      expect(mdMatch?.[1]).toMatch(/--thumb-pad:\s*2px/);
      expect(lgMatch?.[1]).toMatch(/--thumb-pad:\s*2px/);
    });

    it('包含微型 Spinner 旋转关键帧：switch-spin', () => {
      expect(css).toMatch(/@keyframes switch-spin/);
    });

    it('消费项目 Design Tokens（--brand, --border-subtle, --bg-card）且杜绝 --brand-deep 墨黑边', () => {
      expect(css).toMatch(/var\(--brand/);
      expect(css).not.toMatch(/var\(--brand-deep/);
      expect(css).toMatch(/var\(--border-subtle\)/);
      expect(css).toMatch(/var\(--bg-card/);
    });

    it('严格遵守 AGENTS.md §13 软性焦点环规范（3%~10% 克制柔和灰色）', () => {
      expect(css).toMatch(/:focus-visible/);
      expect(css).toMatch(
        /box-shadow:\s*0 0 0 1\.5px\s+color-mix\(\s*in srgb,\s*var\(--border-color\) 94%,\s*var\(--text-primary\) 6%\s*\)/
      );
      expect(css).toMatch(
        /border-color:\s*color-mix\(\s*in srgb,\s*var\(--border-color\) 90%,\s*var\(--text-primary\) 10%\s*\)/
      );
    });

    it('动效无 y>1 过冲贝塞尔，符合反过度设计规范', () => {
      expect(css).not.toMatch(/1\.51/);
      expect(css).not.toMatch(/cubic-bezier\([^)]*[1-9]\.\d{2,}/);
    });

    it('包含减弱动态偏好（prefers-reduced-motion: reduce）与 Eco Tier 完备降级适配', () => {
      expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
      expect(css).toMatch(/html\[data-perf-tier='eco'\]/);
      expect(css).toMatch(/animation:\s*none/);
      expect(css).toMatch(/transition-duration:\s*0ms/);
    });
  });
});
