// @vitest-environment jsdom
/**
 * ui/Button & ui/IconButton 基础测试：渲染/交互/a11y/尺寸变体正交
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import styles from './Button.module.css';

describe('ui/Button', () => {
  it('渲染默认 secondary/md 形态并透传属性', () => {
    render(<Button data-testid="btn">确定</Button>);
    const btn = screen.getByTestId('btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn.className).toContain(styles.button);
    expect(btn.className).toContain(styles.buttonSecondary);
    expect(btn.className).toContain(styles.buttonMd);
    expect(btn).toHaveAttribute('data-size', 'md');
    expect(btn).toHaveAttribute('data-variant', 'secondary');
    expect(screen.getByText('确定')).toBeInTheDocument();
  });

  it('变体与尺寸类名映射正确', () => {
    const { rerender } = render(
      <Button variant="secondary" size="sm">
        次操作
      </Button>
    );
    expect(screen.getByRole('button', { name: '次操作' })).toHaveClass(
      styles.buttonSecondary,
      styles.buttonSm
    );
    expect(screen.getByRole('button', { name: '次操作' })).toHaveAttribute(
      'data-size',
      'sm'
    );
    expect(screen.getByRole('button', { name: '次操作' })).toHaveAttribute(
      'data-variant',
      'secondary'
    );

    rerender(
      <Button variant="ghost" size="xs">
        轻量
      </Button>
    );
    expect(screen.getByRole('button', { name: '轻量' })).toHaveClass(
      styles.buttonGhost,
      styles.buttonXs
    );
    expect(screen.getByRole('button', { name: '轻量' })).toHaveAttribute(
      'data-size',
      'xs'
    );

    rerender(
      <Button variant="plain" size="lg">
        纯文本
      </Button>
    );
    expect(screen.getByRole('button', { name: '纯文本' })).toHaveClass(
      styles.buttonPlain,
      styles.buttonLg
    );
    expect(screen.getByRole('button', { name: '纯文本' })).toHaveAttribute(
      'data-size',
      'lg'
    );

    rerender(<Button variant="danger">危险</Button>);
    expect(screen.getByRole('button', { name: '危险' })).toHaveClass(
      styles.buttonDanger
    );
  });

  it('active 状态正确渲染', () => {
    render(
      <Button active data-testid="act-btn">
        激活项
      </Button>
    );
    const btn = screen.getByTestId('act-btn');
    expect(btn).toHaveClass(styles.buttonActive);
    expect(btn).toHaveAttribute('data-active', 'true');
  });

  it('loading 态：自动 disabled + aria-busy + 旋转指示前置，文案保留', () => {
    const { rerender } = render(<Button loading>保存中</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveClass(styles.buttonLoading);
    expect(btn.querySelector(`.${styles.spinner}`)).not.toBeNull();
    // 文案保留：loading 不吞掉标签，仅在前置旋转指示
    expect(screen.getByText('保存中')).toBeInTheDocument();
    rerender(<Button>普通</Button>);
    expect(screen.getByRole('button')).not.toBeDisabled();
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });

  it('loading 优先于显式 disabled 语义', () => {
    render(
      <Button disabled loading>
        加载
      </Button>
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('icon 位渲染且对屏幕阅读器隐藏，支持 left/right 位置', () => {
    const { rerender } = render(
      <Button icon={<svg data-testid="ico-left" />} iconPosition="left">
        图标左
      </Button>
    );
    const iconWrap = screen.getByTestId('ico-left').parentElement;
    expect(iconWrap).toHaveAttribute('aria-hidden', 'true');

    rerender(
      <Button icon={<svg data-testid="ico-right" />} iconPosition="right">
        图标右
      </Button>
    );
    const rightIconWrap = screen.getByTestId('ico-right').parentElement;
    expect(rightIconWrap).toHaveAttribute('aria-hidden', 'true');
  });

  it('block 形态追加通栏类', () => {
    render(<Button block>通栏</Button>);
    expect(screen.getByRole('button')).toHaveClass(styles.buttonBlock);
  });

  it('点击回调透传且触发禁用保护', () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>可点</Button>);
    fireEvent.click(screen.getByText('可点'));
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button onClick={onClick} disabled>
        禁用
      </Button>
    );
    fireEvent.click(screen.getByText('禁用'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('Secondary 变体应渲染实体白卡属性并支持点击和禁用态', () => {
    const handleClick = vi.fn();
    const { rerender } = render(
      <Button variant="secondary" onClick={handleClick}>
        重建索引
      </Button>
    );
    const btn = screen.getByRole('button', { name: '重建索引' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('data-variant', 'secondary');
    expect(btn).toHaveClass(styles.buttonSecondary);

    fireEvent.click(btn);
    expect(handleClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button variant="secondary" disabled onClick={handleClick}>
        重建索引
      </Button>
    );
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('align="start" 属性正确透传 data-align="start"', () => {
    render(
      <Button align="start" data-testid="align-start-btn">
        靠左对齐
      </Button>
    );
    const btn = screen.getByTestId('align-start-btn');
    expect(btn).toHaveAttribute('data-align', 'start');
  });

  it('align="center" 属性正确透传 data-align="center"', () => {
    render(
      <Button align="center" data-testid="align-center-btn">
        居中对齐
      </Button>
    );
    const btn = screen.getByTestId('align-center-btn');
    expect(btn).toHaveAttribute('data-align', 'center');
  });

  it('未指定 align 时 data-align 缺省（不渲染属性）', () => {
    render(<Button data-testid="align-default-btn">默认对齐</Button>);
    const btn = screen.getByTestId('align-default-btn');
    expect(btn).not.toHaveAttribute('data-align');
  });

  it('static={true} 属性正确透传 data-static="true"', () => {
    render(
      <Button static data-testid="static-btn">
        静态按钮
      </Button>
    );
    const btn = screen.getByTestId('static-btn');
    expect(btn).toHaveAttribute('data-static', 'true');
  });

  it('static={false} 或未指定 static 时 data-static 缺省', () => {
    const { rerender } = render(
      <Button data-testid="non-static-btn">普通按钮</Button>
    );
    const btn = screen.getByTestId('non-static-btn');
    expect(btn).not.toHaveAttribute('data-static');

    rerender(
      <Button static={false} data-testid="non-static-btn">
        普通按钮
      </Button>
    );
    expect(btn).not.toHaveAttribute('data-static');
  });

  it('bare 模式原生单节点透传 align 与 static 且不渲染内部包裹层', () => {
    render(
      <Button
        bare
        align="start"
        static
        className="custom-bare"
        data-testid="bare-btn"
      >
        <span>自定义内容</span>
      </Button>
    );
    const btn = screen.getByTestId('bare-btn');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('data-align', 'start');
    expect(btn).toHaveAttribute('data-static', 'true');
    expect(btn).toHaveClass('custom-bare');
    expect(btn.querySelector(`.${styles.buttonLabel}`)).toBeNull();
    expect(screen.getByText('自定义内容')).toBeInTheDocument();
  });

  it('纯图标按钮无 children 时不产生 .buttonLabel 节点（杜绝误触发偏心）', () => {
    render(
      <Button
        icon={<span data-testid="only-icon">icon</span>}
        data-testid="icon-only-btn"
      />
    );
    const btn = screen.getByTestId('icon-only-btn');
    expect(btn.querySelector(`.${styles.buttonIcon}`)).not.toBeNull();
    expect(btn.querySelector(`.${styles.buttonLabel}`)).toBeNull();
  });

  it('前置图标与 label 正确生成相应结构供纯 CSS 光学微调命中', () => {
    render(
      <Button
        icon={<span data-testid="leading-ico">icon</span>}
        iconPosition="left"
        data-testid="optics-leading-btn"
      >
        文件夹
      </Button>
    );
    const btn = screen.getByTestId('optics-leading-btn');
    const firstChild = btn.firstElementChild;
    expect(firstChild).toHaveClass(styles.buttonIcon);
    expect(btn.querySelector(`.${styles.buttonLabel}`)).toBeInTheDocument();
  });

  it('后置图标与 label 正确生成相应结构供纯 CSS 光学微调命中', () => {
    render(
      <Button
        icon={<span data-testid="trailing-ico">➜</span>}
        iconPosition="right"
        data-testid="optics-trailing-btn"
      >
        下一步
      </Button>
    );
    const btn = screen.getByTestId('optics-trailing-btn');
    const lastChild = btn.lastElementChild;
    expect(lastChild).toHaveClass(styles.buttonIcon);
    expect(btn.querySelector(`.${styles.buttonLabel}`)).toBeInTheDocument();
  });

  it('loading 态前置 spinner 与 label 正确共存供纯 CSS 光学微调命中', () => {
    render(
      <Button loading data-testid="optics-loading-btn">
        提交中
      </Button>
    );
    const btn = screen.getByTestId('optics-loading-btn');
    const firstChild = btn.firstElementChild;
    expect(firstChild).toHaveClass(styles.spinner);
    expect(btn.querySelector(`.${styles.buttonLabel}`)).toBeInTheDocument();
  });
});

describe('ui/IconButton', () => {
  it('渲染具有强制 aria-label 的图标按钮', () => {
    render(
      <IconButton
        icon={<span data-testid="gear-icon">icon</span>}
        aria-label="设置"
        size="sm"
        variant="ghost"
      />
    );
    const btn = screen.getByRole('button', { name: '设置' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveClass(styles.iconButton);
    expect(btn).toHaveAttribute('data-size', 'sm');
    expect(btn).toHaveAttribute('data-variant', 'ghost');
    expect(screen.getByTestId('gear-icon')).toBeInTheDocument();
  });

  it('支持带有 Tooltip 的 IconButton 渲染', () => {
    render(
      <IconButton
        icon={<span>icon</span>}
        aria-label="搜索"
        tooltip="快捷搜索 (⌘K)"
      />
    );
    const btn = screen.getByRole('button', { name: '搜索' });
    expect(btn).toBeInTheDocument();
  });

  it('支持带有 Tooltip 和 shortcut 的 IconButton 渲染并透传快捷键', () => {
    render(
      <IconButton
        icon={<span>icon</span>}
        aria-label="快捷键与帮助"
        tooltip="快捷键与帮助"
        shortcut="?"
      />
    );
    const btn = screen.getByRole('button', { name: '快捷键与帮助' });
    expect(btn).toBeInTheDocument();
  });

  it('IconButton 支持透传 align 与 static 属性', () => {
    render(
      <IconButton
        icon={<span>icon</span>}
        aria-label="设置"
        align="start"
        static
        data-testid="icon-btn-props"
      />
    );
    const btn = screen.getByTestId('icon-btn-props');
    expect(btn).toHaveAttribute('data-align', 'start');
    expect(btn).toHaveAttribute('data-static', 'true');
  });

  it('IconButton 支持传入 touchExpand 样式类', () => {
    render(
      <IconButton
        icon={<span>✕</span>}
        aria-label="关闭"
        className={styles.touchExpand}
        data-testid="icon-btn-expand"
      />
    );
    const btn = screen.getByTestId('icon-btn-expand');
    expect(btn).toHaveClass(styles.touchExpand);
  });
});

describe('ui/Button 样式与物理动效契约 (Button.module.css)', () => {
  const cssPath = path.resolve(__dirname, './Button.module.css');
  const cssContent = fs.readFileSync(cssPath, 'utf-8');

  it('钉死 7px（用户裁决 U1）：消费面零兜底，真值单点在 tokens.css，禁 8px 漂移', () => {
    // 契约升级（兜底清零 B6-T18 / 提交 45a9dce56）：消费面只写 var(--button-radius)，
    // 不再就地重复声明默认值——同一真值两处声明即为真源分裂。
    // 7px 的权威定义收敛到 tokens.css 的 --radius-btn → --button-radius 单点。
    expect(cssContent).toContain('--btn-radius: var(--button-radius)');
    expect(cssContent).not.toMatch(/--btn-radius:\s*var\(--button-radius\s*,/);
    expect(cssContent).not.toContain('var(--button-radius, 8px)');

    // 真源侧钉死：7px 只能来自 --radius-btn，禁 8px / radius-lg 顶替
    const tokensPath = path.resolve(__dirname, '../../../styles/tokens.css');
    const tokensContent = fs.readFileSync(tokensPath, 'utf-8');
    expect(tokensContent).toContain('--radius-btn: 7px');
    expect(tokensContent).toContain('--button-radius: var(--radius-btn)');
    expect(tokensContent).not.toMatch(/--button-radius:\s*(?:8px|var\(--radius-lg\))/);
  });

  it('彻底去除点击果冻弹性缩放 scale，保持平稳扎实交互', () => {
    expect(cssContent).not.toMatch(/\.button:active[^{]*\{[^}]*scale:/);
    expect(cssContent).not.toContain('scale: 0.96;');
    expect(cssContent).not.toContain('scale 140ms');
  });

  it('无冗余 scale 过渡与强制 scale 声明', () => {
    expect(cssContent).not.toMatch(/\.button:disabled[\s\S]*?scale:/);
  });

  it('纯 CSS 光学微调规则完整性覆盖图标与 Spinner', () => {
    expect(cssContent).toContain(
      '.button:has(> :is(.buttonIcon, .spinner):first-child):has(> .buttonLabel)'
    );
    expect(cssContent).toContain(
      '.button:has(> .buttonLabel):has(> :is(.buttonIcon, .spinner):last-child)'
    );
    expect(cssContent).toContain('padding-inline-start: max(0px, calc(var(--btn-px) - 2px));');
    expect(cssContent).toContain('padding-inline-end: max(0px, calc(var(--btn-px) - 2px));');
  });

  it("[data-align='start'] 靠左排版对齐规则", () => {
    expect(cssContent).toContain("[data-align='start']");
    expect(cssContent).toContain('justify-content: flex-start;');
    expect(cssContent).toContain('text-align: left;');
  });

  it('触控热区安全管理：常规紧凑按钮采用 inset: -2px 0，touchExpand 支持 40×40px', () => {
    expect(cssContent).toContain('.buttonXs::after');
    expect(cssContent).toContain('.buttonSm::after');
    expect(cssContent).toContain('inset: -2px 0;');
    expect(cssContent).toContain('.iconButton.touchExpand::after');
    expect(cssContent).toContain('min-width: 40px;');
    expect(cssContent).toContain('min-height: 40px;');
  });

  it('按钮激活态清退硬编码黑框、深黑边与厚重阴影，统一接入 var(--tint-active) 微背景', () => {
    expect(cssContent).toContain('--btn-bg: var(--tint-active);');
    expect(cssContent).toMatch(/\.buttonActive,\s*\.button\[data-active='true'\]\s*\{[^}]*--btn-bg:\s*var\(--tint-active\);/);
    expect(cssContent).toMatch(/\.buttonActive,\s*\.button\[data-active='true'\]\s*\{[^}]*border-color:\s*transparent;/);
    expect(cssContent).toMatch(/\.buttonActive,\s*\.button\[data-active='true'\]\s*\{[^}]*box-shadow:\s*none;/);
  });

  it('S1.1 内容模型自适应：字符串/数字包裹 buttonLabel span；元素/数组直接渲染', () => {
    // 1. 纯文本子节点 → 包裹 buttonLabel span
    const { rerender } = render(<Button data-testid="btn-text">点击保存</Button>);
    const textBtn = screen.getByTestId('btn-text');
    const labelSpan = textBtn.querySelector(`.${styles.buttonLabel}`);
    expect(labelSpan).not.toBeNull();
    expect(labelSpan?.textContent).toBe('点击保存');

    // 2. 纯数字子节点 → 包裹 buttonLabel span
    rerender(<Button data-testid="btn-text">{42}</Button>);
    expect(textBtn.querySelector(`.${styles.buttonLabel}`)?.textContent).toBe('42');

    // 3. 元素子节点 → 直接渲染，不被 buttonLabel span 截断/包裹
    render(
      <Button data-testid="btn-element">
        <span data-testid="custom-child" style={{ marginLeft: 'auto' }}>
          右对齐
        </span>
      </Button>
    );
    const elemBtn = screen.getByTestId('btn-element');
    expect(elemBtn.querySelector(`.${styles.buttonLabel}`)).toBeNull();
    const customChild = screen.getByTestId('custom-child');
    expect(customChild.parentElement).toBe(elemBtn);
  });
});
