// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { ToolCallInputPane } from '../ToolCallInputPane';

describe('ToolCallInputPane', () => {
  it('终端命令（execute_command）单行极简渲染，不拆分输入标题行', () => {
    const { container } = render(
      <ToolCallInputPane
        toolId="t-shell-1"
        name="execute_command"
        argumentsStr={JSON.stringify({
          CommandLine: 'npm test',
          Cwd: 'c:/Software/conex',
        })}
      />
    );

    // 单行终端命令包含 $ 提示符与命令文本
    expect(container.textContent).toContain('$');
    expect(container.textContent).toContain('npm test');
    expect(container.textContent).toContain('(c:/Software/conex)');
    // 不应有独立的多行「输入」徽标标题行
    expect(container.querySelector('header')).toBeNull();
  });

  it('普通工具调用（如 grep）渲染结构化入参并使用右上角悬浮操作，切除整行 header', () => {
    const { container } = render(
      <ToolCallInputPane
        toolId="t-grep-1"
        name="grep_search"
        argumentsStr={JSON.stringify({ Query: 'hello' })}
      />
    );

    // 切除无意义且占整行的 header，顶格平铺
    expect(container.querySelector('header')).toBeNull();
    // 快捷操作挂载在 toolFloatingActions 中
    expect(
      container.querySelector('[class*="toolFloatingActions"]')
    ).not.toBeNull();
    expect(container.textContent).toContain('Query');
  });
});

describe('Tool Card Layout & Border Contracts', () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, '../ChatToolCallBlock.module.css'),
    'utf-8'
  );

  it('统一水平 18px 内边距系统：.toolSectionShellSingleLine 为 padding: 6px 18px', () => {
    expect(css).toMatch(
      /\.toolSectionShellSingleLine\s*\{[^}]*padding:\s*6px\s+18px;/
    );
  });

  it('外层卡片微描边：.toolResultBody 包含 border: 1px solid var(--border-subtle)', () => {
    expect(css).toMatch(
      /\.toolResultBody\s*\{[^}]*border:\s*1px\s+solid\s+var\(--border-subtle\);/
    );
  });

  it('输入与输出贯穿发丝分割线：.toolSectionOutput 有 border-top，单卡模式下切除', () => {
    expect(css).toMatch(
      /\.toolSectionOutput\s*\{[^}]*border-top:\s*1px\s+solid\s+var\(--border-subtle\);/
    );
    expect(css).toMatch(
      /\.toolResultBodySingle\s+\.toolSectionOutput\s*\{[^}]*border-top:\s*none;/
    );
  });

  it('浮动操作区右边距规范化：.toolFloatingActions right 为 18px', () => {
    expect(css).toMatch(/\.toolFloatingActions\s*\{[^}]*right:\s*18px;/);
  });

  it('容器定位：.toolSection 包含 position: relative 以支撑悬浮操作定位', () => {
    expect(css).toMatch(/\.toolSection\s*\{[^}]*position:\s*relative;/);
  });

  it('防止高度暴走：组内工具输出严禁取消限高（max-height: none 规则已彻底清除）', () => {
    expect(css).not.toMatch(
      /:global\(\.tool-group-scroll-host\)\s+\.toolSectionContent\s*\{[^}]*max-height:\s*none/
    );
  });
});
