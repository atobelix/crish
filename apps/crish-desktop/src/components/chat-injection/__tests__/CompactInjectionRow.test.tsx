// @vitest-environment jsdom
/**
 * CompactInjectionRow 渲染与交互测试：卡片 Header、Token 徽标、折叠展开、
 * 失败态重试按钮与 aria 完整性。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { CompactInjectionRow } from '../CompactInjectionRow';
import { ContextInjectionCard } from '../ContextInjectionCard';
import type { MessageContextInjection } from '../../../store/types';

// 同步返回渲染 HTML，避免 Worker/Rust 异步链路进入 jsdom
vi.mock('../../../api/markdownRenderAsync', () => ({
  useAsyncMarkdownHtml: (markdown: string) => ({
    html: markdown ? `<p>${markdown}</p>` : '',
    loading: false,
    failed: false,
  }),
  parseMarkdownToHtmlAsync: vi.fn(async (m: string) => `<p>${m}</p>`),
}));

vi.mock('../../../store/storeAccess', () => ({
  useSettingsField: vi.fn(() => 2),
}));

function makeInjection(
  partial: Partial<MessageContextInjection> = {}
): MessageContextInjection {
  return {
    id: 'inj_test_1',
    kind: 'rule',
    title: '项目规则: Rust 规范',
    summary: '2 条规则',
    status: 'injected',
    source: 'rule_loader',
    content: '# Rust 规则\n1. 必须使用 UTF-8 无 BOM',
    tokenEstimate: 450,
    timestamp: Date.now(),
    ...partial,
  };
}

describe('CompactInjectionRow 渲染与交互', () => {
  it('正确渲染卡片 Header、标题、分类 Badge 与 Token 徽标', () => {
    render(
      <CompactInjectionRow
        injection={makeInjection()}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(screen.getByText('规则注入')).toBeInTheDocument();
    expect(screen.getByText('项目规则: Rust 规范')).toBeInTheDocument();
    expect(screen.getByText('450 t')).toBeInTheDocument();
    expect(screen.getByText('2 条规则')).toBeInTheDocument();
  });

  it('默认折叠（defaultFolded=true）：Markdown 正文不可见，点击 Header 展开可见', () => {
    const inj = makeInjection({ defaultFolded: true });
    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    // 折叠态：正文不可见
    expect(screen.queryByText(/必须使用 UTF-8 无 BOM/i)).not.toBeInTheDocument();

    // 点击整行 Header（role=button）展开
    const head = screen.getByRole('button', {
      name: /项目规则: Rust 规范/i,
    });
    fireEvent.click(head);
    // 正文经 mock html 注入后以纯文本可见
    expect(screen.getByText(/必须使用 UTF-8 无 BOM/i)).toBeInTheDocument();
  });

  it('受控折叠态优先于本地 state（expandedInjections=false 压制展开）', () => {
    const inj = makeInjection({ content: '短内容' });
    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
        expandedInjections={{ [inj.id]: false }}
      />
    );
    expect(screen.queryByText(/短内容/i)).not.toBeInTheDocument();
  });
  it('失败状态展示错误高亮与错误状态图标', () => {
    const { container } = render(
      <CompactInjectionRow
        injection={makeInjection({ status: 'failed' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    const row = container.querySelector('[data-injection-id="inj_test_1"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-injection-status', 'failed');
    expect(row?.className).toContain('isFailed');
    const failIcon = container.querySelector('svg.lucide-circle-alert');
    expect(failIcon).not.toBeNull();
  });

  it('pending 状态展示准备中图标脉冲（不展示失败态）', () => {
    const { container } = render(
      <CompactInjectionRow
        injection={makeInjection({ status: 'pending' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    const row = container.querySelector('[data-injection-id="inj_test_1"]');
    expect(row).toHaveAttribute('data-injection-status', 'pending');
    expect(row?.className).not.toContain('isFailed');
  });

  it('短内容且未声明 defaultFolded 时默认展开（正文直接可见）', () => {
    render(
      <CompactInjectionRow
        injection={makeInjection({ content: '简短纠偏指令' })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    expect(screen.getByText(/简短纠偏指令/i)).toBeInTheDocument();
  });

  it('aria 完整：data 属性承载 id/kind/status，展开态联动 aria-expanded', () => {
    const { container } = render(
      <CompactInjectionRow
        injection={makeInjection({ defaultFolded: true })}
        rowKey="test"
        activeSessionId="s1"
        msgId="m1"
      />
    );
    const row = container.querySelector('[data-injection-id="inj_test_1"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute('data-injection-kind', 'rule');
    expect(row).toHaveAttribute('data-injection-status', 'injected');
    const head = screen.getByRole('button', { name: /项目规则: Rust 规范/i });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head).toHaveAttribute('aria-controls', 'injection-body-inj_test_1');
  });

  it('状态切换提示：渲染为极简发丝微提示，结构化输出，无图标、无分类徽章、无展开卡片', () => {
    const inj = makeInjection({
      id: 'inj_state_switch',
      kind: 'workspace_env',
      title: '上下文状态切换',
      tokenEstimate: 37,
      metadata: {
        mode: 'context-state',
        model: 'muse-spark-1.2-contributor',
        permission: 'full',
      },
    });

    const { container } = render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test-state"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    // 1. 验证目标纯文字输出，格式必须为：系统 · 切换到 muse-spark-1.2-contributor (full)
    expect(
      screen.getByText('系统 · 切换到 muse-spark-1.2-contributor (full)')
    ).toBeInTheDocument();

    // 2. 验证去除了冗余标签与徽标
    expect(screen.queryByText('工作区环境')).not.toBeInTheDocument();
    expect(screen.queryByText('37 t')).not.toBeInTheDocument();

    // 3. 验证无可展开按钮（无 role="button"）与无 svg 图标
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelectorAll('svg')).toHaveLength(0);

    // 4. 验证具有 status 无障碍角色
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('状态切换格式化：支持带思考档位的结构化输出', () => {
    const inj = makeInjection({
      id: 'inj_state_thinking',
      kind: 'workspace_env',
      title: '上下文状态切换',
      metadata: {
        mode: 'context-state',
        model: 'deepseek-chat',
        permission: 'ask',
        thinking: 'high',
      },
    });

    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test-thinking"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    expect(
      screen.getByText(
        '系统 · 切换到 deepseek-chat (ask) · 思考 high'
      )
    ).toBeInTheDocument();
  });

  it('无结构化数据时：安全回落简短文本，绝不做侵入式正则替换', () => {
    const inj = makeInjection({
      id: 'inj_state_fallback',
      kind: 'workspace_env',
      title: '上下文状态切换',
      content: '',
      summary: '状态切换完成',
      metadata: {
        mode: 'context-state',
      },
    });

    render(
      <CompactInjectionRow
        injection={inj}
        rowKey="test-fallback"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    expect(screen.getByText('系统 · 状态切换完成')).toBeInTheDocument();
  });

  it('file_context 正常渲染且默认折叠（恢复正常功能，不返回 null）', () => {
    const fileInj = makeInjection({
      id: 'inj_file_1',
      kind: 'file_context',
      title: '📎 文件批注：a.ts',
      summary: '用户关注选区批注',
      content: 'const x = 42;',
      tokenEstimate: 120,
      targetPaths: ['src/a.ts'],
    });

    const { container } = render(
      <CompactInjectionRow
        injection={fileInj}
        rowKey="test-file-1"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    // 1. 验证没有被 return null 误杀，整行卡片正常在 DOM 中
    expect(
      container.querySelector('[data-injection-id="inj_file_1"]')
    ).toBeInTheDocument();
    // 2. 验证分类徽标为「文件上下文」
    expect(screen.getByText('文件上下文')).toBeInTheDocument();
    // 3. 验证标题、摘要与 Token 徽标
    expect(screen.getByText('📎 文件批注：a.ts')).toBeInTheDocument();
    expect(screen.getByText('用户关注选区批注')).toBeInTheDocument();
    expect(screen.getByText('120 t')).toBeInTheDocument();
    // 4. 验证默认折叠：正文不可见
    expect(screen.queryByText(/const x = 42;/)).not.toBeInTheDocument();
  });

  it('file_context 展开详情与路径/Diff 交互：支持 pathChip 与 header 快捷按钮触发', () => {
    const openPathFn = vi.fn();
    const openDiffFn = vi.fn();
    const mockDiff = {
      filePath: 'src/a.ts',
      originalContent: 'old',
      newContent: 'new',
      additions: 1,
      deletions: 1,
    };
    const fileInj = makeInjection({
      id: 'inj_file_2',
      kind: 'file_context',
      title: '📎 文件批注：a.ts',
      content: 'const foo = "bar";',
      targetPaths: ['src/a.ts'],
      diffs: [mockDiff],
      tokenEstimate: 50,
    });

    const { container } = render(
      <CompactInjectionRow
        injection={fileInj}
        rowKey="test-file-2"
        activeSessionId="s1"
        msgId="m1"
        onOpenPath={openPathFn}
        onOpenDiff={openDiffFn}
      />
    );

    // 1. Header 快捷按钮存在并可交互
    const openPathBtn = container.querySelector(
      '[data-injection-path-btn="true"]'
    );
    expect(openPathBtn).toBeInTheDocument();
    fireEvent.click(openPathBtn!);
    expect(openPathFn).toHaveBeenCalledWith('src/a.ts');

    const openDiffBtn = container.querySelector(
      '[data-injection-diff-btn="true"]'
    );
    expect(openDiffBtn).toBeInTheDocument();
    fireEvent.click(openDiffBtn!);
    expect(openDiffFn).toHaveBeenCalledWith(mockDiff);

    // 2. 点击 Header 展开卡片
    const head = screen.getByRole('button', { name: /📎 文件批注：a.ts/i });
    fireEvent.click(head);

    // 展开后正文可见
    expect(screen.getByText(/const foo = "bar";/)).toBeInTheDocument();

    // 3. Body 内部路径 Chip 按钮可点击
    const bodyPathChip = container.querySelector(
      '[data-injection-path="src/a.ts"]'
    );
    expect(bodyPathChip).toBeInTheDocument();
    fireEvent.click(bodyPathChip!);
    expect(openPathFn).toHaveBeenCalledTimes(2);

    // 4. Body 内部 Diff 按钮可点击
    const bodyDiffBtn = container.querySelector(
      '[data-injection-diff="src/a.ts"]'
    );
    expect(bodyDiffBtn).toBeInTheDocument();
    fireEvent.click(bodyDiffBtn!);
    expect(openDiffFn).toHaveBeenCalledTimes(2);
  });

  it('全景核查：全部 9 种 ContextInjectionKind 均具备合法标签与正常渲染', () => {
    const kinds: Array<{
      kind: MessageContextInjection['kind'];
      label: string;
    }> = [
      { kind: 'rule', label: '规则注入' },
      { kind: 'skill', label: '技能上下文' },
      { kind: 'file_context', label: '文件上下文' },
      { kind: 'git_status', label: 'Git 状态' },
      { kind: 'terminal_output', label: '终端上下文' },
      { kind: 'runtime_steering', label: '运行时纠偏' },
      { kind: 'schedule_trigger', label: '定时唤醒' },
      { kind: 'memory', label: '会话记忆' },
      { kind: 'workspace_env', label: '工作区环境' },
    ];

    for (const { kind, label } of kinds) {
      const inj = makeInjection({
        id: `inj_kind_${kind}`,
        kind,
        title: `标题: ${kind}`,
        content: `正文: ${kind}`,
      });
      const { container, unmount } = render(
        <CompactInjectionRow
          injection={inj}
          rowKey={`test-${kind}`}
          activeSessionId="s1"
          msgId="m1"
        />
      );
      // 绝不返回 null
      expect(
        container.querySelector(`[data-injection-id="inj_kind_${kind}"]`)
      ).toBeInTheDocument();
      // 标签正确
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  it('当为 context-state 注入时：渲染 20px 极简发丝微提示，杜绝 Header、折叠箭头与厚重胶囊，规范 A11y 与 Tooltip', () => {
    const stateInj: MessageContextInjection = {
      id: 'inj-state-test',
      kind: 'workspace_env',
      title: '上下文状态切换',
      status: 'injected',
      metadata: {
        mode: 'context-state',
        model: 'deepseek-reasoner',
        permission: 'ask',
      },
    };

    const { container } = render(
      <CompactInjectionRow
        injection={stateInj}
        rowKey="test-state"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    // 1. 极简发丝微提示容器：规范 A11y 单层 role="status"、aria-live="polite"、tabIndex={0}
    const notice = screen.getByRole('status');
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveAttribute('aria-live', 'polite');
    expect(notice).toHaveAttribute('tabindex', '0');
    expect(notice).toHaveAttribute('data-testid', 'context-state-notice-inj-state-test');
    expect(notice.className).toMatch(/contextStateNotice/);

    // 2. 纯文字微提示正文
    expect(screen.getByText('系统 · 切换到 deepseek-reasoner (ask)')).toBeInTheDocument();

    // 3. 杜绝普通卡片 Header、折叠箭头、分类胶囊与正文
    expect(container.querySelector('.injectionRow')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.querySelector('[data-injection-token-estimate]')).toBeNull();
  });

  it('file_context 支持带行号路径与相对路径转义，渲染行数徽标与文件格式图标', () => {
    const onOpenPath = vi.fn();
    const fileInj = makeInjection({
      id: 'inj_file_lines',
      kind: 'file_context',
      title: '📎 文件批注：main.ts',
      content: 'const a = 1;\nconst b = 2;',
      targetPaths: ['./src/feature%20a/main.ts'],
      metadata: {
        lineRange: 'L15-L60',
      },
      tokenEstimate: 80,
    });

    const { container } = render(
      <CompactInjectionRow
        injection={fileInj}
        rowKey="test-file-lines"
        activeSessionId="s1"
        msgId="m1"
        onOpenPath={onOpenPath}
      />
    );

    // 1. 验证行号选区胶囊展示
    expect(screen.getByText('L15-L60')).toBeInTheDocument();
    expect(screen.getByText('80 t')).toBeInTheDocument();

    // 2. 点击 Header 快捷打开文件按钮：转义 %20 并保留行号锚点
    const openBtn = container.querySelector('[data-injection-path-btn="true"]');
    expect(openBtn).toBeInTheDocument();
    fireEvent.click(openBtn!);
    expect(onOpenPath).toHaveBeenCalledWith('src/feature a/main.ts:15-60');
  });

  it('failed 状态支持 onRetryInjection 快捷重试', () => {
    const onRetry = vi.fn();
    const failedInj = makeInjection({
      id: 'inj_retry_test',
      kind: 'rule',
      title: '规则注入: security.md',
      status: 'failed',
      errorMessage: '网络超时',
    });

    const { container } = render(
      <CompactInjectionRow
        injection={failedInj}
        rowKey="test-failed"
        activeSessionId="s1"
        msgId="m1"
        onRetryInjection={onRetry}
      />
    );

    const retryBtn = container.querySelector('[data-injection-retry="true"]');
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn!);
    expect(onRetry).toHaveBeenCalledWith('inj_retry_test');
  });

  it('超大文件（>1000 行 / >50KB）启动分段截断保护，支持展开全量与恢复保护', () => {
    const onOpenPath = vi.fn();
    const largeLines = Array.from({ length: 1200 }, (_, i) => `export const val_${i} = ${i};`);
    const largeContent = largeLines.join('\n');

    const fileInj = makeInjection({
      id: 'inj_large_file',
      kind: 'file_context',
      title: '📎 超大配置文件: hugeConfig.ts',
      content: largeContent,
      targetPaths: ['src/hugeConfig.ts'],
    });

    const { container } = render(
      <CompactInjectionRow
        injection={fileInj}
        rowKey="test-large"
        activeSessionId="s1"
        msgId="m1"
        onOpenPath={onOpenPath}
      />
    );

    // 1. 点击展开卡片
    const head = screen.getByRole('button', { name: /📎 超大配置文件: hugeConfig.ts/i });
    fireEvent.click(head);

    // 2. 验证分段截断保护提示栏出现
    const notice = container.querySelector('[data-injection-large-file="true"]');
    expect(notice).toBeInTheDocument();
    expect(screen.getByText(/超大内容截断保护：已展示前 1000 行（共 1200 行/)).toBeInTheDocument();

    // 3. 点击「展开全量内容」
    const expandBtn = container.querySelector('[data-injection-expand-content="true"]');
    expect(expandBtn).toBeInTheDocument();
    fireEvent.click(expandBtn!);

    // 验证变为全量展示状态
    expect(screen.getByText(/全量内容展示中（共 1200 行/)).toBeInTheDocument();

    // 4. 点击「恢复截断保护」
    const restoreBtn = container.querySelector('[data-injection-restore-content="true"]');
    expect(restoreBtn).toBeInTheDocument();
    fireEvent.click(restoreBtn!);
    expect(screen.getByText(/超大内容截断保护：已展示前 1000 行（共 1200 行/)).toBeInTheDocument();

    // 5. 点击提示栏内的「在编辑器中打开」
    const openInEditorBtn = container.querySelector('[data-injection-open-in-editor="true"]');
    expect(openInEditorBtn).toBeInTheDocument();
    fireEvent.click(openInEditorBtn!);
    expect(onOpenPath).toHaveBeenCalledWith('src/hugeConfig.ts');
  });

  it('ContextInjectionCard 作为别名导出，功能与 CompactInjectionRow 完全对称', () => {
    const inj = makeInjection({
      id: 'inj_alias_test',
      kind: 'skill',
      title: '专家技能: test',
      content: 'skill content',
    });

    const { container } = render(
      <ContextInjectionCard
        injection={inj}
        rowKey="test-alias"
        activeSessionId="s1"
        msgId="m1"
      />
    );

    expect(container.querySelector('[data-injection-id="inj_alias_test"]')).toBeInTheDocument();
    expect(screen.getByText('技能上下文')).toBeInTheDocument();
    expect(screen.getByText('专家技能: test')).toBeInTheDocument();
  });
});
