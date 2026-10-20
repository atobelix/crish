// @vitest-environment jsdom
/**
 * ui/Input & ui/Textarea 基础测试：渲染/交互/a11y/IME 组合输入锁
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from './Input';
import { Textarea } from './Textarea';

/** 受控包装：模拟业务侧受控 value 持有 */
function ControlledInput(props: React.ComponentProps<typeof Input>) {
  const [value, setValue] = useState('');
  return (
    <Input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      {...props}
    />
  );
}

describe('ui/Input', () => {
  it('渲染基础文本框并透传属性', () => {
    render(<Input placeholder="输入内容" aria-label="测试输入" />);
    const input = screen.getByRole('textbox', { name: '测试输入' });
    expect(input).toHaveAttribute('placeholder', '输入内容');
    expect(input).toHaveAttribute('type', 'text');
  });

  it('label 渲染并关联 input（label htmlFor ↔ input id）', () => {
    render(<Input label="模型名称" />);
    const label = screen.getByText('模型名称');
    expect(label.tagName).toBe('LABEL');
    const forAttr = label.getAttribute('for');
    expect(forAttr).toBeTruthy();
    const input = document.getElementById(forAttr as string);
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('id', forAttr);
  });

  it('error 文案：aria-invalid + aria-describedby 关联', () => {
    render(<Input label="密钥" error="密钥不能为空" />);
    const input = screen.getByLabelText('密钥');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const errorId = input.getAttribute('aria-describedby');
    expect(errorId).toBeTruthy();
    const errorText = document.getElementById(errorId!);
    expect(errorText).toHaveTextContent('密钥不能为空');
  });

  it('hint 文案关联 aria-describedby', () => {
    render(<Input label="提示" hint="仅本机保存" />);
    const input = screen.getByLabelText('提示');
    const hintId = input.getAttribute('aria-describedby');
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId!)).toHaveTextContent('仅本机保存');
  });

  it('search 型：role=searchbox，不走原生 type=search 皮', () => {
    render(<Input variant="search" aria-label="搜索" />);
    const input = screen.getByRole('searchbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'text');
    expect(input).not.toHaveAttribute('type', 'search');
  });

  it('search 型：传入 type=search 仍被压成 text（防 WebView2 原生白框）', () => {
    render(<Input variant="search" type="search" aria-label="防原生搜索" />);
    const input = screen.getByRole('searchbox', { name: '防原生搜索' });
    expect(input).toHaveAttribute('type', 'text');
  });

  it('search 皮：appearance 抹平 + 圆角契约 + 无原生 search 装饰 + 无厚阴影', () => {
    // 不用 new URL('./*.module.css')：vitest 会把 CSS module 改写成非 file URL
    const cssDir = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(cssDir, 'Input.module.css'), 'utf8');
    expect(css).toContain('appearance: none');
    expect(css).toContain('-webkit-appearance: none');
    // 兜底清零（B6-T18）后契约升级：消费面零字面量兜底，圆角真值由 tokens.css 单点提供
    expect(css).toContain('border-radius: var(--button-radius);');
    expect(css).not.toMatch(/var\(--(?:button-radius|radius-lg),\s*[78]px\)/);
    expect(css).toContain('::-webkit-search-decoration');
    expect(css).toContain('::-webkit-search-cancel-button');
    expect(css).toContain('box-shadow: none');
    expect(css).not.toMatch(/box-shadow:\s*0\s+[2-9]px/);
  });

  it('password 型：默认密文，点击切换明文并还原', () => {
    render(<Input variant="password" aria-label="密码" />);
    const input = screen.getByLabelText('密码');
    expect(input).toHaveAttribute('type', 'password');
    const toggle = screen.getByRole('button', { name: '显示密码' });
    fireEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.click(screen.getByRole('button', { name: '隐藏密码' }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('clearable：受控有值时出现清空按钮，点击触发 onChange 清空', () => {
    render(<ControlledInput clearable label="搜索" />);
    const input = screen.getByLabelText('搜索');
    fireEvent.change(input, { target: { value: 'abc' } });
    const clear = screen.getByRole('button', { name: '清空输入' });
    fireEvent.click(clear);
    expect(input).toHaveValue('');
  });

  it('clearable：空值时不显示清空按钮', () => {
    render(<Input clearable value="" aria-label="空" onChange={() => {}} />);
    expect(
      screen.queryByRole('button', { name: '清空输入' })
    ).not.toBeInTheDocument();
  });

  it('disabled 时隐藏清空与密码切换动作', () => {
    render(
      <Input
        disabled
        clearable
        variant="password"
        value="x"
        aria-label="禁用"
        onChange={() => {}}
      />
    );
    expect(
      screen.queryByRole('button', { name: '清空输入' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '显示密码' })
    ).not.toBeInTheDocument();
  });

  it('suffix 插槽渲染', () => {
    render(<Input suffix={<span>单位</span>} aria-label="数值" />);
    expect(screen.getByText('单位')).toBeInTheDocument();
  });

  it('clearable 非受控（defaultValue 或用户输入）正确显示并执行清空', () => {
    const onClear = vi.fn();
    render(
      <Input
        clearable
        defaultValue="预填"
        onClear={onClear}
        aria-label="非受控"
      />
    );
    const clearBtn = screen.getByRole('button', { name: '清空输入' });
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('button', { name: '清空输入' })
    ).not.toBeInTheDocument();
  });

  it('断言 1 (IME 组合输入防护)：isComposing 期间按下 Enter 绝对不触发 onEnter', () => {
    const onEnter = vi.fn();
    render(
      <Input onEnter={onEnter} aria-label="IME测试" defaultValue="nihao" />
    );
    const input = screen.getByLabelText('IME测试');

    // 1. 触发 compositionstart 进入输入法合成态
    fireEvent.compositionStart(input);

    // 2. 在合成态期间按下 3 次 Enter 确认候选词
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229 });

    expect(onEnter).toHaveBeenCalledTimes(0);

    // 3. 触发 compositionend 结束合成态
    fireEvent.compositionEnd(input);

    // 4. 用户正式按下 Enter 提交
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith('nihao');
  });
});

describe('ui/Input · 条件 Hook 回归（RUN-01）', () => {
  it('同一实例 bare=false→true→false 重渲染：Hook 调用数量稳定，不抛错', () => {
    const { rerender } = render(<Input bare={false} aria-label="裸模式切换" />);
    expect(
      screen.getByLabelText('裸模式切换').closest('[data-size]')
    ).not.toBeNull();

    // false → true：bare 分支只改变渲染输出，不得改变 Hook 调用顺序
    expect(() =>
      rerender(<Input bare aria-label="裸模式切换" />)
    ).not.toThrow();
    const bareInput = screen.getByLabelText('裸模式切换');
    expect(bareInput.tagName).toBe('INPUT');
    expect(bareInput.closest('[data-size]')).toBeNull();

    // true → false：切回包装结构同样不得抛错
    expect(() =>
      rerender(<Input bare={false} aria-label="裸模式切换" />)
    ).not.toThrow();
    expect(
      screen.getByLabelText('裸模式切换').closest('[data-size]')
    ).not.toBeNull();
  });

  it('同一实例 bare=true→false 后 useState 取值仍对位（密码明文切换可用）', () => {
    const { rerender } = render(
      <Input bare variant="password" aria-label="裸起始密码" />
    );

    expect(() =>
      rerender(<Input variant="password" aria-label="裸起始密码" />)
    ).not.toThrow();
    expect(screen.getByLabelText('裸起始密码')).toHaveAttribute(
      'type',
      'password'
    );

    fireEvent.click(screen.getByRole('button', { name: '显示密码' }));
    expect(screen.getByLabelText('裸起始密码')).toHaveAttribute('type', 'text');
  });
});

describe('ui/Textarea', () => {
  it('渲染多行文本框并支持 label / hint / error', () => {
    render(<Textarea label="备注" hint="最多200字" error="必填项" />);
    const textarea = screen.getByRole('textbox', { name: '备注' });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(screen.getByText('备注')).toBeInTheDocument();
    expect(screen.getByText('最多200字')).toBeInTheDocument();
    expect(screen.getByText('必填项')).toBeInTheDocument();
  });

  it('Textarea 装配 IME 组合输入锁与 onEnter 回车提交', () => {
    const onEnter = vi.fn();
    render(
      <Textarea onEnter={onEnter} defaultValue="文本内容" aria-label="多行" />
    );
    const textarea = screen.getByLabelText('多行');

    // IME 合成态中按下 Enter
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onEnter).toHaveBeenCalledTimes(0);

    fireEvent.compositionEnd(textarea);

    // Shift + Enter 换行，不触发 onEnter
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onEnter).toHaveBeenCalledTimes(0);

    // Enter 提交
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(onEnter).toHaveBeenCalledTimes(1);
    expect(onEnter).toHaveBeenCalledWith('文本内容');
  });
});
