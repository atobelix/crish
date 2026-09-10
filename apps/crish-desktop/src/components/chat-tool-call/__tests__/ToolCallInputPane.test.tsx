// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { ToolCallInputPane } from '../ToolCallInputPane';

describe('ToolCallInputPane', () => {
  it('终端命令（execute_command）单行极简渲染，不拆分输入标题行', () => {
    const { container } = render(
      <ToolCallInputPane
        toolId="t-shell-1"
        name="execute_command"
        argumentsStr={JSON.stringify({ CommandLine: 'npm test', Cwd: 'c:/Software/conex' })}
      />
    );

    // 单行终端命令包含 $ 提示符与命令文本
    expect(container.textContent).toContain('$');
    expect(container.textContent).toContain('npm test');
    expect(container.textContent).toContain('(c:/Software/conex)');
    // 不应有独立的多行「输入」徽标标题行
    expect(container.querySelector('header')).toBeNull();
  });

  it('普通工具调用（如 grep）渲染结构化输入徽标与内容', () => {
    const { container } = render(
      <ToolCallInputPane
        toolId="t-grep-1"
        name="grep_search"
        argumentsStr={JSON.stringify({ Query: 'hello' })}
      />
    );

    // 普通工具调用保留「输入」徽章
    expect(container.querySelector('header')).not.toBeNull();
    expect(container.textContent).toContain('输入');
    expect(container.textContent).toContain('Query');
  });
});
