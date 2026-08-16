// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PluginRegistry,
  DisposableBag,
  usePluginStore,
  MarkdownEditorPlugin,
  BrowserPlugin,
  ComputerUsePlugin,
  FollowUpPlugin,
  type CrishPlugin,
} from './index';

describe('PluginRegistry 插件基座与生命周期调度测试 (DIM-06, RUL-06)', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('插件正常注册、查询与注销', async () => {
    const mockPlugin: CrishPlugin = {
      manifest: {
        id: 'test-plugin',
        name: 'Test Plugin',
        version: '1.0.0',
        permissions: ['fs:access'],
      },
      activate: vi.fn(),
      deactivate: vi.fn(),
    };

    registry.register(mockPlugin);
    expect(registry.getPlugin('test-plugin')).toBe(mockPlugin);
    expect(registry.getPluginStatus('test-plugin')).toBe('registered');

    await registry.unregister('test-plugin');
    expect(registry.getPlugin('test-plugin')).toBeUndefined();
  });

  it('插件激活并装配 DisposableBag 与 Context', async () => {
    let capturedCtx: any;
    const mockPlugin: CrishPlugin = {
      manifest: {
        id: 'lifecycle-plugin',
        name: 'Lifecycle Plugin',
        version: '1.0.0',
      },
      activate: vi.fn((ctx) => {
        capturedCtx = ctx;
      }),
      deactivate: vi.fn(),
    };

    registry.register(mockPlugin);
    await registry.activate('lifecycle-plugin', { customVal: 42 });

    expect(mockPlugin.activate).toHaveBeenCalledTimes(1);
    expect(registry.isPluginActive('lifecycle-plugin')).toBe(true);
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx.config.customVal).toBe(42);
    expect(capturedCtx.subscriptions).toBeInstanceOf(DisposableBag);
  });

  it('插件停用时 100% 释放 DisposableBag 中的资源', async () => {
    const disposedFn = vi.fn();
    const mockPlugin: CrishPlugin = {
      manifest: {
        id: 'disposable-plugin',
        name: 'Disposable Plugin',
        version: '1.0.0',
      },
      activate: vi.fn((ctx) => {
        ctx.subscriptions.add(disposedFn);
      }),
      deactivate: vi.fn(),
    };

    registry.register(mockPlugin);
    await registry.activate('disposable-plugin');
    expect(disposedFn).not.toHaveBeenCalled();

    await registry.deactivate('disposable-plugin');
    expect(mockPlugin.deactivate).toHaveBeenCalled();
    expect(disposedFn).toHaveBeenCalledTimes(1);
    expect(registry.isPluginActive('disposable-plugin')).toBe(false);
  });

  it('IPC 权限白名单前置拦截与校验', async () => {
    const hostIpc = vi.fn().mockResolvedValue({ success: true });
    registry.setHostIpc(hostIpc);

    let capturedCtx: any;
    const mockPlugin: CrishPlugin = {
      manifest: {
        id: 'security-plugin',
        name: 'Security Plugin',
        version: '1.0.0',
        permissions: ['fs:access'], // 仅声明 fs 权限
      },
      activate: (ctx) => {
        capturedCtx = ctx;
      },
    };

    registry.register(mockPlugin);
    await registry.activate('security-plugin');

    // 1. 已声明权限通道：放行
    const fsResult = await capturedCtx.invokeIpc('fs:read', { path: '/test' });
    expect(fsResult).toEqual({ success: true });
    expect(hostIpc).toHaveBeenCalledWith('fs:read', { path: '/test' });

    // 2. 未声明权限通道：严厉拦截抛错
    await expect(
      capturedCtx.invokeIpc('browser:navigate', { url: 'https://example.com' })
    ).rejects.toThrowError(
      /\[PluginSecurityError\] Plugin 'security-plugin' lacks permission 'browser:control'/
    );

    // 3. 🚨 未知未映射通道：Default-Deny 默认拒绝
    await expect(
      capturedCtx.invokeIpc('unknown:dangerous_channel', { data: 123 })
    ).rejects.toThrowError(
      /\[PluginSecurityError\] Channel 'unknown:dangerous_channel' is not permitted or unknown in IPC whitelist \(Default-Deny\)/
    );

    // 4. 系统无害通道：直接放行
    const appResult = await capturedCtx.invokeIpc('app:get_version');
    expect(appResult).toEqual({ success: true });
  });

  it('插件激活失败时原子回滚并释放已挂载的 DisposableBag 资源', async () => {
    const cleanupFn = vi.fn();
    const failingPlugin: CrishPlugin = {
      manifest: {
        id: 'failing-plugin',
        name: 'Failing Plugin',
        version: '1.0.0',
      },
      activate: (ctx) => {
        ctx.subscriptions.add(cleanupFn);
        throw new Error('Boom in activate!');
      },
    };

    registry.register(failingPlugin);
    await expect(registry.activate('failing-plugin')).rejects.toThrow(
      'Boom in activate!'
    );
    expect(registry.getPluginStatus('failing-plugin')).toBe('error');
    expect(registry.getPluginContext('failing-plugin')).toBeUndefined();
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });
});

describe('DisposableBag 统一资源回收机制', () => {
  it('能够统一注销 addEventListener、Timer 与清理函数', async () => {
    const bag = new DisposableBag();
    const target = new EventTarget();
    const listener = vi.fn();

    bag.addEventListener(target, 'test-event', listener);
    const customCleanup = vi.fn();
    bag.add(customCleanup);

    target.dispatchEvent(new Event('test-event'));
    expect(listener).toHaveBeenCalledTimes(1);

    await bag.dispose();
    expect(bag.disposed).toBe(true);
    expect(customCleanup).toHaveBeenCalledTimes(1);

    // dispose 后事件监听器已解绑
    target.dispatchEvent(new Event('test-event'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose 之后再添加的资源会立即执行释放', async () => {
    const bag = new DisposableBag();
    await bag.dispose();

    const lateCleanup = vi.fn();
    bag.add(lateCleanup);
    expect(lateCleanup).toHaveBeenCalledTimes(1);
  });
});

describe('官方四大 TS 独立插件契约与规范', () => {
  it('MarkdownEditorPlugin 满足官方富文本编辑器契约', () => {
    expect(MarkdownEditorPlugin.manifest.id).toBe(
      '@crish/plugin-markdown-editor'
    );
    expect(MarkdownEditorPlugin.manifest.permissions).toContain('fs:access');
    expect(MarkdownEditorPlugin.manifest.permissions).toContain(
      'markdown:render'
    );
    expect(MarkdownEditorPlugin.manifest.category).toBe('editor');
  });

  it('BrowserPlugin 满足受管 AI 浏览器契约', () => {
    expect(BrowserPlugin.manifest.id).toBe('@crish/plugin-browser');
    expect(BrowserPlugin.manifest.permissions).toContain('browser:control');
    expect(BrowserPlugin.manifest.permissions).toContain('network:access');
    expect(BrowserPlugin.manifest.category).toBe('browser');
  });

  it('ComputerUsePlugin 满足系统级桌面自动化契约', () => {
    expect(ComputerUsePlugin.manifest.id).toBe('@crish/plugin-computer-use');
    expect(ComputerUsePlugin.manifest.permissions).toContain(
      'computer:control'
    );
    expect(ComputerUsePlugin.manifest.permissions).toContain('screen:capture');
    expect(ComputerUsePlugin.manifest.category).toBe('automation');
  });

  it('FollowUpPlugin 满足智能行动建议契约', () => {
    expect(FollowUpPlugin.manifest.id).toBe('@crish/plugin-follow-up');
    expect(FollowUpPlugin.manifest.permissions).toContain(
      'assistant:suggestions'
    );
    expect(FollowUpPlugin.manifest.category).toBe('assistant');
  });
});

describe('FollowUpPlugin 子 Agent (Subagent) 四重硬阻断隔离测试 (RUL-06)', () => {
  it('🚨 子 Agent (isSubagent: true) 100% 物理阻断，返回空数组，0 Token 消耗', () => {
    const suggestions = FollowUpPlugin.generateSuggestions({
      sessionId: 'subagent-session-123',
      messageId: 'msg-1',
      isSubagent: true, // 标记为子 Agent 会话
      toolCalls: [
        { name: 'read_file', status: 'success' },
        { name: 'run_command', status: 'error' },
      ],
    });

    expect(suggestions).toEqual([]);
    expect(
      FollowUpPlugin.getSuggestions('subagent-session-123', 'msg-1')
    ).toEqual([]);
  });

  it('主会话 (isSubagent: false) 正常派发并按 sessionId 隔离缓存建议', () => {
    const suggestions = FollowUpPlugin.generateSuggestions({
      sessionId: 'main-session-456',
      messageId: 'msg-2',
      isSubagent: false,
      toolCalls: [
        { name: 'run_command', status: 'error', output: 'Syntax error' },
      ],
    });

    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].id).toBe('diagnose-error');
    expect(FollowUpPlugin.getSuggestions('main-session-456', 'msg-2')).toEqual(
      suggestions
    );

    // 清理会话
    FollowUpPlugin.clearSession('main-session-456');
    expect(FollowUpPlugin.getSuggestions('main-session-456', 'msg-2')).toEqual(
      []
    );
  });
});

describe('usePluginStore Zustand 状态管理与响应式测试', () => {
  it('支持注册、激活与切换状态', async () => {
    const dummyPlugin: CrishPlugin = {
      manifest: {
        id: 'store-dummy-plugin',
        name: 'Store Dummy',
        version: '1.0.0',
      },
      activate: vi.fn(),
      deactivate: vi.fn(),
    };

    usePluginStore.getState().registerPlugin(dummyPlugin);
    expect(
      usePluginStore.getState().plugins['store-dummy-plugin']
    ).toBeDefined();

    await usePluginStore.getState().activatePlugin('store-dummy-plugin');
    expect(usePluginStore.getState().plugins['store-dummy-plugin'].status).toBe(
      'active'
    );
    expect(usePluginStore.getState().activePluginIds).toContain(
      'store-dummy-plugin'
    );

    await usePluginStore.getState().deactivatePlugin('store-dummy-plugin');
    expect(usePluginStore.getState().plugins['store-dummy-plugin'].status).toBe(
      'inactive'
    );
  });
});
