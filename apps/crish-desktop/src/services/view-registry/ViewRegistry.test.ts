// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { viewRegistry } from './ViewRegistry';
import { registerBuiltInViews } from './registerBuiltInViews';

describe('ViewRegistry 视图注册中心与路由解析', () => {
  beforeEach(() => {
    registerBuiltInViews();
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
    expect(ids).toContain('browser');
    expect(ids).toContain('flow-dag');
    expect(ids).toContain('file-viewer');
  });

  it('category 分类正确划分', () => {
    expect(viewRegistry.isPrimary('chat')).toBe(true);
    expect(viewRegistry.isPrimary('terminal')).toBe(false);
    expect(viewRegistry.isPrimary('browser')).toBe(false);

    const toolViews = viewRegistry.getToolViews();
    const toolIds = toolViews.map((v) => v.id);
    expect(toolIds).toContain('terminal');
    expect(toolIds).toContain('browser');
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
  });

  it('isPrimary 正确支持草稿态及参数化会话 URI', () => {
    expect(viewRegistry.isPrimary('chat')).toBe(true);
    expect(viewRegistry.isPrimary('chat?session=PENDING_DRAFT')).toBe(true);
    expect(viewRegistry.isPrimary('chat:__draft__')).toBe(true);
    expect(viewRegistry.isPrimary('terminal')).toBe(false);
    expect(viewRegistry.isPrimary('')).toBe(false);
  });

  it('getTitle 正确返回静态或动态计算标题及 Fallback', () => {
    expect(viewRegistry.getTitle('chat')).toBe('对话');
    expect(viewRegistry.getTitle('terminal')).toBe('终端');
    expect(viewRegistry.getTitle('browser')).toBe('AI 浏览器');
    expect(viewRegistry.getTitle('flow-dag')).toBe('编排图');

    // file-viewer 动态标题提取文件名
    expect(
      viewRegistry.getTitle('file-viewer:C:/Software/conex/src/App.tsx')
    ).toBe('App.tsx');

    // 动态未知 URI 友好 fallback
    expect(viewRegistry.getTitle('extension:git-graph-viewer/main')).toBe('main');
  });

  it('clear() 仅清空自身视图且保护内置解析器', () => {
    viewRegistry.clear();
    expect(viewRegistry.getAllViews()).toHaveLength(0);

    // 二次注册内置视图正常恢复
    registerBuiltInViews();
    expect(viewRegistry.getAllViews().length).toBeGreaterThan(0);
  });
});
