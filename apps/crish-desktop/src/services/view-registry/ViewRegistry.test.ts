// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import type React from 'react';
import { viewRegistry } from './ViewRegistry';
import { registerBuiltInViews, type ViewFactoryMap } from './registerBuiltInViews';
import type { ViewRenderContext } from './ViewTypes';

// 维度 3 步骤 1 / 3-E：registerBuiltInViews 改为接收 factory 参数注入。
// 测试无需真实 lazy 组件——用 stub component 即可验证注册完备性与路由解析。
const stubComponent: React.FC<ViewRenderContext> = () => null;
const stubFactory = () => stubComponent;
const testFactories: ViewFactoryMap = {
  chat: stubFactory,
  terminal: stubFactory,
  preview: stubFactory,
  overview: stubFactory,
  files: stubFactory,
  diff: stubFactory,
  runtime: stubFactory,
  agent: stubFactory,
  'flow-dag': stubFactory,
  'file-viewer': stubFactory,
};

describe('ViewRegistry 视图注册中心与路由解析', () => {
  beforeEach(() => {
    registerBuiltInViews(testFactories);
  });

  it('内置 10 大视图 + file-viewer 完备注册', () => {
    const views = viewRegistry.getAllViews();
    const ids = views.map((v) => v.id);

    expect(ids).toContain('chat');
    expect(ids).toContain('terminal');
    expect(ids).toContain('preview');
    expect(ids).toContain('overview');
    expect(ids).toContain('files');
    expect(ids).toContain('diff');
    expect(ids).toContain('runtime');
    expect(ids).toContain('agent');
    expect(ids).toContain('flow-dag');
    expect(ids).toContain('file-viewer');
  });

  it('category 分类正确划分', () => {
    expect(viewRegistry.isPrimary('chat')).toBe(true);
    expect(viewRegistry.isPrimary('terminal')).toBe(false);
    expect(viewRegistry.isPrimary('preview')).toBe(false);

    const toolViews = viewRegistry.getToolViews();
    const toolIds = toolViews.map((v) => v.id);
    expect(toolIds).toContain('terminal');
    expect(toolIds).toContain('preview');
    expect(toolIds).toContain('flow-dag');
    expect(toolIds).not.toContain('chat');
    expect(toolIds).not.toContain('file-viewer');
  });

  it('URI 解析器正确解析 file-viewer 前缀与动态参数', () => {
    const resolved = viewRegistry.resolveView('file-viewer:src/index.ts');
    expect(resolved.definition?.id).toBe('file-viewer');
    expect(resolved.params).toEqual({
      filePath: 'src/index.ts',
      initialMode: 'plain',
      line: undefined,
    });

    // 支持 query 参数解析与 URL 解码
    const resolvedWithQuery = viewRegistry.resolveView(
      'file-viewer:src%2Fmy%20file.ts?mode=diff&line=42'
    );
    expect(resolvedWithQuery.definition?.id).toBe('file-viewer');
    expect(resolvedWithQuery.params).toEqual({
      filePath: 'src/my file.ts',
      initialMode: 'diff',
      line: 42,
    });

    // 支持 Hash 锚点剥离与行号自动提取
    const resolvedWithHash = viewRegistry.resolveView(
      'file-viewer:README.md#architecture'
    );
    expect(resolvedWithHash.params?.filePath).toBe('README.md');

    const resolvedWithHashLine = viewRegistry.resolveView(
      'file-viewer:src/main.tsx#L20-L40'
    );
    expect(resolvedWithHashLine.params?.filePath).toBe('src/main.tsx');
    expect(resolvedWithHashLine.params?.line).toBe(20);
  });

  it('isPrimary 正确支持草稿态及参数化会话 URI', () => {
    expect(viewRegistry.isPrimary('chat')).toBe(true);
    expect(viewRegistry.isPrimary('chat?session=PENDING_DRAFT')).toBe(true);
    expect(viewRegistry.isPrimary('chat:__draft__')).toBe(true);
    expect(viewRegistry.isPrimary('__pending_draft__')).toBe(true);
    expect(viewRegistry.isPrimary('pending:new-session')).toBe(true);
    expect(viewRegistry.isPrimary('terminal')).toBe(false);
    expect(viewRegistry.isPrimary('')).toBe(false);
  });

  it('getTitle 正确返回静态或动态计算标题及 Fallback', () => {
    expect(viewRegistry.getTitle('chat')).toBe('对话');
    expect(viewRegistry.getTitle('files')).toBe('文件');
    expect(viewRegistry.getTitle('terminal')).toBe('终端');
    expect(viewRegistry.getTitle('preview')).toBe('浏览器');
    expect(viewRegistry.getTitle('flow-dag')).toBe('编排图');

    // file-viewer 动态标题提取文件名 (包含 Windows 反斜杠)
    expect(
      viewRegistry.getTitle('file-viewer:C:/Software/conex/src/App.tsx')
    ).toBe('App.tsx');
    expect(
      viewRegistry.getTitle('file-viewer:C:\\Software\\conex\\src\\App.tsx')
    ).toBe('App.tsx');

    // 动态未知 URI 友好 fallback
    expect(viewRegistry.getTitle('extension:git-graph-viewer/main')).toBe('main');
  });

  it('clear() 仅清空自身视图且保护内置解析器', () => {
    viewRegistry.clear();
    expect(viewRegistry.getAllViews()).toHaveLength(0);

    // 二次注册内置视图正常恢复
    registerBuiltInViews(testFactories);
    expect(viewRegistry.getAllViews().length).toBeGreaterThan(0);
  });

  it('URI 解析器正确解析 preview: 与 browser: 前缀支持无限浏览器标签', () => {
    const resolvedPreview2 = viewRegistry.resolveView('preview:2');
    expect(resolvedPreview2.definition?.id).toBe('preview');
    expect(resolvedPreview2.params).toEqual({
      target: '2',
      instanceId: 'preview:2',
    });

    const resolvedBrowser3 = viewRegistry.resolveView('browser:3');
    expect(resolvedBrowser3.definition?.id).toBe('preview');
    expect(resolvedBrowser3.params).toEqual({
      target: '3',
      instanceId: 'browser:3',
    });

    expect(viewRegistry.getTitle('preview:2')).toBe('浏览器 2');
    expect(viewRegistry.getTitle('preview:3')).toBe('浏览器 3');
    expect(viewRegistry.getTitle('browser:2')).toBe('浏览器 2');
    expect(viewRegistry.getTitle('preview:http://localhost:5173')).toBe(
      '浏览器 (http://localhost:5173)'
    );
  });
});
