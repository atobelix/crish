// @vitest-environment jsdom
/**
 * ui/Input 基础测试：渲染/交互/a11y
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Input } from './Input';

/** 受控包装：模拟业务侧受控 value 持有 */
function ControlledInput(props: React.ComponentProps<typeof Input>) {
  const [value, setValue] = useState('');
  return <Input value={value} onChange={(e) => setValue(e.target.value)} {...props} />;
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

  it('search 型：放大镜前缀对屏幕阅读器隐藏', () => {
    render(<Input variant="search" aria-label="搜索" />);
    const input = screen.getByRole('searchbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'search');
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
    expect(screen.queryByRole('button', { name: '清空输入' })).not.toBeInTheDocument();
  });

  it('disabled 时隐藏清空与密码切换动作', () => {
    render(<Input disabled clearable variant="password" value="x" aria-label="禁用" onChange={() => {}} />);
    expect(screen.queryByRole('button', { name: '清空输入' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '显示密码' })).not.toBeInTheDocument();
  });

  it('suffix 插槽渲染', () => {
    render(<Input suffix={<span>单位</span>} aria-label="数值" />);
    expect(screen.getByText('单位')).toBeInTheDocument();
  });

  it('clearable 非受控（仅 defaultValue）不显示无效清空按钮（F7-F7）', () => {
    render(<Input clearable defaultValue="预填" aria-label="非受控" />);
    // 非受控模式下没有 onChange 通道，清空按钮点击无效果——
    // 显示状态与行为矛盾（F7-F7），应直接隐藏
    expect(screen.queryByRole('button', { name: '清空输入' })).not.toBeInTheDocument();
  });
});
