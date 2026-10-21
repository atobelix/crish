// @vitest-environment jsdom
/**
 * apps/crish-desktop/src/components/ui/SegmentedControl/SegmentedControl.test.tsx
 *
 * SegmentedControl 自动化单元测试套件 (v2.0 灰度防穿透与 14px SmartPanel 同心大圆角专项验证)
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';
import styles from './SegmentedControl.module.css';

const DIR = dirname(fileURLToPath(import.meta.url));
const CSS_SRC = readFileSync(join(DIR, 'SegmentedControl.module.css'), 'utf8');
const TSX_SRC = readFileSync(join(DIR, 'SegmentedControl.tsx'), 'utf8');

/**
 * 选择器断言用的「排版无关」视图：去掉注释，删除紧贴括号内侧的空白，其余连续空白折叠为单空格。
 * 括号内侧空白在 CSS 选择器语义中无意义（`:not( [x] )` ≡ `:not([x])`），而后代组合符等
 * 有意义的空白只被折叠、不被删除。这样 prettier 对长选择器折行（d6e2ac8fd）不会让断言假红，
 * 真正改动选择器语义时仍会失败。
 */
const CSS_SELECTOR_VIEW = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')')
  .replace(/\s+/g, ' ');

describe('ui/SegmentedControl 现代化测试套件', () => {
  const defaultOptions = [
    { value: 'default', label: '浅色' },
    { value: 'dark', label: '深色' },
  ];

  it('[SC-01] 正确渲染 RadioGroup 语义与默认激活状态', () => {
    render(
      <SegmentedControl
        aria-label="主题切换"
        options={defaultOptions}
        defaultValue="default"
      />
    );

    const group = screen.getByRole('radiogroup', { name: '主题切换' });
    expect(group).toBeInTheDocument();

    const lightRadio = screen.getByRole('radio', { name: '浅色' });
    const darkRadio = screen.getByRole('radio', { name: '深色' });

    expect(lightRadio).toHaveAttribute('aria-checked', 'true');
    expect(lightRadio).toHaveAttribute('tabIndex', '0');
    expect(lightRadio).toHaveAttribute('data-active', 'true');

    expect(darkRadio).toHaveAttribute('aria-checked', 'false');
    expect(darkRadio).toHaveAttribute('tabIndex', '-1');
    expect(darkRadio).toHaveAttribute('data-active', 'false');
  });

  it('[SC-02] 激活项严格隔离：data-active="true" 且滑块处于渲染树中', () => {
    const { container } = render(
      <SegmentedControl options={defaultOptions} value="default" />
    );

    const activeItem = container.querySelector('[data-active="true"]');
    expect(activeItem).toBeInTheDocument();
    expect(activeItem).toHaveTextContent('浅色');

    const slider = container.querySelector(`.${styles.activeSlider}`);
    expect(slider).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-hidden', 'true');
  });

  it('[SC-03] 灰度防穿透：CSS 具有严格互斥选择器与 !important 门锁', () => {
    // 1. 验证仅未激活项在 Hover 时激活动画遮罩
    expect(CSS_SELECTOR_VIEW).toContain(
      ".item:hover:not(:disabled):not([data-active='true']):not([aria-checked='true']):not(.itemActive)::before { opacity: 1;"
    );

    // 2. 验证已激活项绝对强制关闭伪元素遮罩，杜绝 Double Alpha Stacking
    expect(CSS_SELECTOR_VIEW).toContain(
      ".item[data-active='true']::before, .item[aria-checked='true']::before, .item.itemActive::before { opacity: 0; display: none;"
    );

    // 3. 验证容器声明 isolation: isolate 建立局部独立层叠上下文
    expect(CSS_SRC).toContain('isolation: isolate;');

    // 4. 验证滑块锁定实体纯色卡底 var(--seg-slider-bg)
    expect(CSS_SRC).toContain('background-color: var(--seg-slider-bg');
  });

  it('[SC-04] 同心大圆角体系：size="panel" 正确应用 containerPanel 类名与几何属性', () => {
    const { container, rerender } = render(
      <SegmentedControl
        size="panel"
        options={defaultOptions}
        defaultValue="default"
      />
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain(styles.containerPanel);
    expect(root).toHaveAttribute('data-size', 'panel');

    // 验证各尺寸档位类名与属性
    rerender(<SegmentedControl size="xs" options={defaultOptions} />);
    expect(root.className).toContain(styles.containerXs);
    expect(root).toHaveAttribute('data-size', 'xs');

    rerender(<SegmentedControl size="sm" options={defaultOptions} />);
    expect(root.className).toContain(styles.containerSm);
    expect(root).toHaveAttribute('data-size', 'sm');

    rerender(<SegmentedControl size="md" options={defaultOptions} />);
    expect(root.className).toContain(styles.containerMd);
    expect(root).toHaveAttribute('data-size', 'md');

    rerender(<SegmentedControl size="lg" options={defaultOptions} />);
    expect(root.className).toContain(styles.containerLg);
    expect(root).toHaveAttribute('data-size', 'lg');
  });

  it('[SC-05] 图标与徽标：正确渲染自定义前置图标与尾部徽标', () => {
    const optionsWithExtra = [
      {
        value: 'enter',
        label: 'Enter 发送',
        icon: <span data-testid="enter-icon">⏎</span>,
        badge: 'Kbd',
      },
      {
        value: 'ctrlEnter',
        label: 'Ctrl+Enter 发送',
        icon: <span data-testid="ctrl-icon">⌃⏎</span>,
      },
    ];

    render(
      <SegmentedControl options={optionsWithExtra} defaultValue="enter" />
    );

    expect(screen.getByTestId('enter-icon')).toBeInTheDocument();
    expect(screen.getByText('Kbd')).toBeInTheDocument();
    expect(screen.getByTestId('ctrl-icon')).toBeInTheDocument();
  });

  it('[SC-06] 受控模式：外部 value 变更驱动选中态更新并触发 onChange', () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        options={defaultOptions}
        value="default"
        onChange={handleChange}
      />
    );

    const lightRadio = screen.getByRole('radio', { name: '浅色' });
    const darkRadio = screen.getByRole('radio', { name: '深色' });

    expect(lightRadio).toHaveAttribute('aria-checked', 'true');
    expect(darkRadio).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(darkRadio);
    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('dark');

    // 外部受控重新渲染
    rerender(
      <SegmentedControl
        options={defaultOptions}
        value="dark"
        onChange={handleChange}
      />
    );
    expect(lightRadio).toHaveAttribute('aria-checked', 'false');
    expect(darkRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('[SC-07] 非受控模式：用户点击正确更新内部选中态并触发 onChange 回调', () => {
    const handleChange = vi.fn();
    render(
      <SegmentedControl
        options={defaultOptions}
        defaultValue="default"
        onChange={handleChange}
      />
    );

    const darkRadio = screen.getByRole('radio', { name: '深色' });
    fireEvent.click(darkRadio);

    expect(handleChange).toHaveBeenCalledTimes(1);
    expect(handleChange).toHaveBeenCalledWith('dark');
    expect(darkRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('[SC-08] 键盘导航：Arrow/Home/End 正确实现焦点循环漫游与跳转', () => {
    const handleChange = vi.fn();
    render(
      <SegmentedControl
        options={[
          { value: 'small', label: '紧凑' },
          { value: 'medium', label: '默认' },
          { value: 'large', label: '宽松' },
        ]}
        defaultValue="small"
        onChange={handleChange}
      />
    );

    const group = screen.getByRole('radiogroup');
    const smallBtn = screen.getByRole('radio', { name: '紧凑' });
    smallBtn.focus();

    // 1. 按右方向键切换到「默认」
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(handleChange).toHaveBeenCalledWith('medium');

    // 2. 再次按右方向键切换到「宽松」
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(handleChange).toHaveBeenCalledWith('large');

    // 3. 再次按右方向键循环回到「紧凑」
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(handleChange).toHaveBeenCalledWith('small');

    // 4. 按左方向键向前循环到「宽松」
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(handleChange).toHaveBeenCalledWith('large');

    // 5. 按 Home 键跳到第一项「紧凑」
    fireEvent.keyDown(group, { key: 'Home' });
    expect(handleChange).toHaveBeenCalledWith('small');

    // 6. 按 End 键跳到最后一项「宽松」
    fireEvent.keyDown(group, { key: 'End' });
    expect(handleChange).toHaveBeenCalledWith('large');
  });

  it('[SC-09] 禁用保护：禁用单项与整组禁用拦截所有点击与键盘事件', () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <SegmentedControl
        options={[
          { value: 'opt1', label: '选项一' },
          { value: 'opt2', label: '选项二', disabled: true },
          { value: 'opt3', label: '选项三' },
        ]}
        defaultValue="opt1"
        onChange={handleChange}
      />
    );

    const disabledBtn = screen.getByRole('radio', { name: '选项二' });
    expect(disabledBtn).toBeDisabled();

    fireEvent.click(disabledBtn);
    expect(handleChange).not.toHaveBeenCalled();

    // 键盘导航跳过禁用项
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(handleChange).toHaveBeenCalledWith('opt3');

    // 整组禁用
    rerender(
      <SegmentedControl
        options={[
          { value: 'opt1', label: '选项一' },
          { value: 'opt2', label: '选项二' },
        ]}
        disabled
        onChange={handleChange}
      />
    );
    fireEvent.click(screen.getByRole('radio', { name: '选项一' }));
    expect(handleChange).toHaveBeenCalledTimes(1); // 未增加调用
  });

  it('[SC-10] 通栏布局与纯字符串 options 支持', () => {
    const { container } = render(
      <SegmentedControl
        block
        options={['Day', 'Week', 'Month']}
        defaultValue="Week"
      />
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain(styles.containerBlock);
    expect(screen.getByRole('radio', { name: 'Week' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  describe('CI 门禁与反过度设计静态守卫断言', () => {
    it('[SC-11] CSS 文件不得包含裸写硬编码 HEX 颜色或 rgba', () => {
      // 允许 var() 内的 HSL fallback，严禁裸写 HEX
      const rawHexMatches = CSS_SRC.match(
        /(?<!var\([^)]*)#[0-9a-fA-F]{3,8}\b/g
      );
      expect(rawHexMatches).toBeNull();

      // 严禁旧式 rgba()
      expect(CSS_SRC).not.toMatch(/rgba\(/);
    });

    it('[SC-12] 单文件行数严格满足 RL-03 门禁 (物理行 <= 300 行)', () => {
      const tsxLines = TSX_SRC.split(/\r?\n/).length;
      const cssLines = CSS_SRC.split(/\r?\n/).length;

      expect(tsxLines).toBeLessThanOrEqual(300);
      expect(cssLines).toBeLessThanOrEqual(300);
    });

    it('[SC-13] 零外部 npm 组件库依赖断言', () => {
      expect(TSX_SRC).not.toMatch(/from\s+['"]@radix-ui/);
      expect(TSX_SRC).not.toMatch(/from\s+['"]@base-ui/);
      expect(TSX_SRC).not.toMatch(/from\s+['"]framer-motion/);
      expect(TSX_SRC).not.toMatch(/from\s+['"]lucide-react/);
    });

    it('[SC-14] 动画曲线无过冲安全合规 (避免 y > 1.0 破出外框)', () => {
      // 严禁 1.5 等过冲贝塞尔
      expect(CSS_SRC).not.toMatch(/1\.5\)/);
      expect(CSS_SRC).toContain('cubic-bezier(0.2, 0, 0, 1)');
    });
  });
});
