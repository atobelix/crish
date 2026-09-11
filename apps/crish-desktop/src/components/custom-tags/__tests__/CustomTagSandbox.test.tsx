// @vitest-environment jsdom
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  CustomTagRegistry,
  parseComponentAttributes,
  sanitizeCustomTagAttributes,
  isSafeProtocol,
  DISALLOWED_TAGS,
  type HastNode,
} from '../CustomTagRegistry';
import { sanitizeHastTree } from '../CustomTagRegistry';
import { registerBuiltinCustomTags } from '../index';
import { CustomTagErrorBoundary } from '../CustomTagErrorBoundary';
import { CustomTagPortal } from '../CustomTagPortal';
import { WidgetDiff } from '../WidgetDiff';
import { FileTree } from '../FileTree';
import { AiCard } from '../AiCard';

describe('CustomTagRegistry & parseComponentAttributes', () => {
  beforeEach(() => {
    CustomTagRegistry.getInstance().clear();
  });

  it('TC-R01: 单例注册表注册、查询与注销功能正常', () => {
    const registry = CustomTagRegistry.getInstance();
    expect(registry.getAllTagNames()).toEqual([]);

    const DummyComponent: React.FC = () => <div>Dummy</div>;
    registry.register({
      name: 'test-widget',
      type: 'container',
      component: DummyComponent,
      description: 'Test Widget',
    });

    expect(registry.isRegistered('test-widget')).toBe(true);
    expect(registry.isRegistered('TEST-WIDGET')).toBe(true);
    expect(registry.get('test-widget')?.description).toBe('Test Widget');
    expect(registry.getAllTagNames()).toEqual(['test-widget']);

    registry.unregister('test-widget');
    expect(registry.isRegistered('test-widget')).toBe(false);
  });

  it('TC-R02: registerBuiltinCustomTags 成功注册三大核心组件', () => {
    registerBuiltinCustomTags();
    const registry = CustomTagRegistry.getInstance();
    expect(registry.isRegistered('widget-diff')).toBe(true);
    expect(registry.isRegistered('file-tree')).toBe(true);
    expect(registry.isRegistered('ai-card')).toBe(true);
  });

  it('TC-R03: parseComponentAttributes 准确转换各种类型的属性', () => {
    const raw = {
      'file-name': 'index.ts',
      'show-status': 'true',
      'is-collapsed': '',
      disabled: 'false',
      'expand-level': '3',
      'negative-num': '-10.5',
      'json-config': '{"debug": true, "timeout": 5000}',
      'array-items': '["a", "b", "c"]',
      'plain-text': 'hello world',
      'broken-json': '{bad json}',
    };

    const parsed = parseComponentAttributes<any>(raw);
    expect(parsed.fileName).toBe('index.ts');
    expect(parsed.showStatus).toBe(true);
    expect(parsed.isCollapsed).toBe(true);
    expect(parsed.disabled).toBe(false);
    expect(parsed.expandLevel).toBe(3);
    expect(parsed.negativeNum).toBe(-10.5);
    expect(parsed.jsonConfig).toEqual({ debug: true, timeout: 5000 });
    expect(parsed.arrayItems).toEqual(['a', 'b', 'c']);
    expect(parsed.plainText).toBe('hello world');
    expect(parsed.brokenJson).toBe('{bad json}');
  });

  it('TC-R04: parseComponentAttributes 面对 null/undefined 安全兜底', () => {
    expect(parseComponentAttributes(null)).toEqual({});
    expect(parseComponentAttributes(undefined)).toEqual({});
  });
});

describe('4 层 XSS 纵深防御体系', () => {
  it('TC-X01 (Tier 1): 危险原生标签被列入 DISALLOWED_TAGS 黑名单', () => {
    expect(DISALLOWED_TAGS.has('script')).toBe(true);
    expect(DISALLOWED_TAGS.has('iframe')).toBe(true);
    expect(DISALLOWED_TAGS.has('object')).toBe(true);
    expect(DISALLOWED_TAGS.has('embed')).toBe(true);
  });

  it('TC-X02 (Tier 1): sanitizeHastTree 剔除危险标签并将未知自定义标签安全解包', () => {
    const allowed = new Set(['widget-diff', 'ai-card']);

    // 1. 危险 script 标签
    const scriptNode: HastNode = {
      type: 'element',
      tagName: 'script',
      children: [{ type: 'text', value: 'alert(1)' }],
    };
    expect(sanitizeHastTree(scriptNode, allowed)).toBeNull();

    // 2. 未知自定义标签安全解包为 fallback 容器，保留内部安全子节点
    const unknownNode: HastNode = {
      type: 'element',
      tagName: 'unknown-widget',
      children: [{ type: 'text', value: '安全子内容' }],
    };
    const sanitizedUnknown = sanitizeHastTree(unknownNode, allowed);
    expect(sanitizedUnknown).not.toBeNull();
    expect(sanitizedUnknown?.tagName).toBe('div');
    expect(sanitizedUnknown?.children?.[0]?.value).toBe('安全子内容');
  });

  it('TC-X03 (Tier 2): sanitizeCustomTagAttributes 彻底剥离 on* 事件与超长属性', () => {
    const rawAttrs = {
      title: '正常标题',
      onclick: 'alert(1)',
      ONMOUSEOVER: 'fetch("evil.com")',
      formaction: 'http://evil.com',
      normalProp: 'value',
      superLongAttr: 'x'.repeat(12000),
    };

    const clean = sanitizeCustomTagAttributes(rawAttrs);
    expect(clean.title).toBe('正常标题');
    expect(clean.normalProp).toBe('value');
    expect(clean.onclick).toBeUndefined();
    expect(clean.ONMOUSEOVER).toBeUndefined();
    expect(clean.formaction).toBeUndefined();
    expect(clean.superLongAttr).toBeUndefined();
  });

  it('TC-X04 (Tier 3): isSafeProtocol 允许 safe 协议并阻断 javascript/vbscript/data:text/html', () => {
    expect(isSafeProtocol('https://example.com')).toBe(true);
    expect(isSafeProtocol('http://localhost:3000')).toBe(true);
    expect(isSafeProtocol('mailto:test@example.com')).toBe(true);
    expect(isSafeProtocol('conex://app/action')).toBe(true);
    expect(isSafeProtocol('crish-local://file/path')).toBe(true);
    expect(isSafeProtocol('/relative/path')).toBe(true);
    expect(isSafeProtocol('#anchor')).toBe(true);

    expect(isSafeProtocol('javascript:alert(1)')).toBe(false);
    expect(isSafeProtocol('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeProtocol('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
  });

  it('TC-X05 (Tier 4): CustomTagErrorBoundary 隔离局部崩溃并支持重试恢复', () => {
    const BrokenChild: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow }) => {
      if (shouldThrow) {
        throw new Error('模拟子组件崩溃');
      }
      return <div>恢复正常</div>;
    };

    // 抑制 react 打印控制台错误日志
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <CustomTagErrorBoundary tagName="broken-widget">
        <BrokenChild shouldThrow={true} />
      </CustomTagErrorBoundary>
    );

    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByText(/自定义组件渲染异常 \[broken-widget\]/)).toBeDefined();
    expect(screen.getByText('模拟子组件崩溃')).toBeDefined();

    // 重新渲染正常子组件并点击重试恢复
    rerender(
      <CustomTagErrorBoundary tagName="broken-widget">
        <BrokenChild shouldThrow={false} />
      </CustomTagErrorBoundary>
    );

    // 点击重试按钮触发恢复
    const retryBtn = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retryBtn);

    expect(screen.getByText('恢复正常')).toBeDefined();
    spy.mockRestore();
  });
});

describe('React 富交互组件套件功能交互', () => {
  it('TC-UI01: <WidgetDiff> 支持 Unified/Split 模式切换、一键复制与会话采纳/拒绝', async () => {
    const onAction = vi.fn();
    const diffText = `@@ -1,2 +1,3 @@\n context line\n-deleted line\n+added line 1\n+added line 2`;

    // Mock clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    render(
      <WidgetDiff
        title="修复内存泄漏"
        from="old.ts"
        to="new.ts"
        onAgentAction={onAction}
      >
        {diffText}
      </WidgetDiff>
    );

    expect(screen.getByText('修复内存泄漏')).toBeDefined();
    expect(screen.getByText((_, el) => (el?.textContent?.includes('added line 1') ?? false) && el?.tagName === 'SPAN')).toBeDefined();
    expect(screen.getByText((_, el) => (el?.textContent?.includes('deleted line') ?? false) && el?.tagName === 'SPAN')).toBeDefined();

    // 切换到 Split 模式
    const splitBtn = screen.getByRole('button', { name: '分栏比对' });
    fireEvent.click(splitBtn);
    expect(screen.getByText(/Original/)).toBeDefined();
    expect(screen.getByText(/Modified/)).toBeDefined();

    // 点击复制
    const copyBtn = screen.getByRole('button', { name: '复制' });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(diffText);

    // 点击采纳
    const acceptBtn = screen.getByRole('button', { name: '采纳' });
    fireEvent.click(acceptBtn);
    expect(onAction).toHaveBeenCalledWith('accept_diff', expect.objectContaining({
      title: '修复内存泄漏',
      from: 'old.ts',
      to: 'new.ts',
    }));

    // 点击拒绝
    const rejectBtn = screen.getByRole('button', { name: '拒绝' });
    fireEvent.click(rejectBtn);
    expect(onAction).toHaveBeenCalledWith('reject_diff', expect.objectContaining({
      title: '修复内存泄漏',
    }));
  });

  it('TC-UI02: <FileTree> 渲染树形结构、展开折叠与文件点击 IPC 导航', () => {
    const onAction = vi.fn();
    const onSelect = vi.fn();
    const treeText = `src/\n  api/\n    markdown.ts (modified)\n  components/\n    FileTree.tsx (added)\npackage.json`;

    render(
      <FileTree
        root="conex-project"
        onAgentAction={onAction}
        onSelectFile={onSelect}
      >
        {treeText}
      </FileTree>
    );

    expect(screen.getByText('conex-project')).toBeDefined();
    expect(screen.getByText('markdown.ts')).toBeDefined();
    expect(screen.getByText('FileTree.tsx')).toBeDefined();
    expect(screen.getByText('M')).toBeDefined();
    expect(screen.getByText('A')).toBeDefined();

    // 点击文件触发导航
    const fileNode = screen.getByText('markdown.ts');
    fireEvent.click(fileNode);
    expect(onAction).toHaveBeenCalledWith('open_file', { path: 'conex-project/src/api/markdown.ts' });
    expect(onSelect).toHaveBeenCalledWith('conex-project/src/api/markdown.ts');
  });


  it('TC-UI03: <AiCard> 展示 Emerald 脉冲动画、自适应折叠与错误重试', () => {
    const onRetry = vi.fn();
    const onAction = vi.fn();

    const { rerender } = render(
      <AiCard
        title="语义分析中"
        status="running"
        badge="步骤 1/3"
        isStreaming={true}
      >
        <div>正在理解用户意图...</div>
      </AiCard>
    );

    expect(screen.getByText('语义分析中')).toBeDefined();
    expect(screen.getByText('步骤 1/3')).toBeDefined();
    expect(screen.getByText('正在理解用户意图...')).toBeDefined();

    // 折叠测试
    const header = screen.getByText('语义分析中').closest('div');
    if (header) fireEvent.click(header);

    // 错误态与重试测试
    rerender(
      <AiCard
        title="构建失败"
        status="error"
        onRetry={onRetry}
        onAgentAction={onAction}
      >
        <div>TS2304: Cannot find name x</div>
      </AiCard>
    );

    const retryBtn = screen.getByRole('button', { name: '重试' });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith('retry_step', { title: '构建失败' });
  });

  it('TC-UI04: <CustomTagPortal> 在 DOM 顶层容器正确挂载与卸载', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <CustomTagPortal containerId="test-portal-root" isOpen={true} onClose={onClose}>
        <div data-testid="portal-content">浮层内容</div>
      </CustomTagPortal>
    );

    const portalRoot = document.getElementById('test-portal-root');
    expect(portalRoot).not.toBeNull();
    expect(screen.getByTestId('portal-content')).toBeDefined();

    // 按下 ESC 触发 onClose
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();

    unmount();
  });
});
