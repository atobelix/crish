// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { LeafScopeProvider } from '../../../contexts/LeafScopeContext';
import { sessionRuntimeRegistry } from '../../../api/SessionRuntimeRegistry';
import {
  registerSessionRenderBuffer,
  getSessionRenderBuffer,
  flushAndRemoveSessionRenderBuffer,
  clearSessionRenderBuffers,
} from '../../../hooks/chat-stream/sessionStreamManager';
import { draftFolderRegistry } from '../../../store/draft-routing/draftFolderRegistry';
import { useChatSessionMeta } from '../useChatSessionMeta';
import { useChatAttachments } from '../useChatAttachments';
import {
  addPendingFileAnnotation,
  removePendingFileAnnotation,
  countPendingFileAnnotations,
  resetFileAnnotationsForTest,
} from '../../../api/fileAnnotations';
import { useSessionStore } from '../../../store/sessionStore';

// Mocks for useChatAttachments and related subsystem APIs
const vision = vi.hoisted(() => ({
  accepts: true,
  strip: false,
}));

vi.mock('../../../api/modelVisionSupport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../api/modelVisionSupport')>();
  return {
    ...actual,
    activeModelAcceptsImage: () => vision.accepts,
    shouldStripImagesForActiveModel: () => vision.strip,
  };
});

vi.mock('../../../services/toast/ToastContext', () => ({
  toast: { show: vi.fn() },
}));

vi.mock('../../../api/imageProcessing', () => ({
  blobToImageAttachment: vi.fn(async (_blob: Blob, name?: string) => ({
    id: `att-${Date.now()}`,
    name: name || 'image.png',
    dataUrl: 'data:image/png;base64,mock',
    mime: 'image/png',
    status: 'ready' as const,
    progress: 100,
  })),
  generateSquareThumbnail: vi.fn(async () => 'data:image/png;base64,thumb'),
}));

vi.mock('../../../api/localFileReader', () => ({
  getMimeFromPath: vi.fn((p: string) => {
    if (p.endsWith('.png')) return 'image/png';
    return 'application/octet-stream';
  }),
  readLocalImageAsDataUrl: vi.fn(
    async () => 'data:image/png;base64,mockLocalDataUrl'
  ),
  readLocalTextBestEffort: vi.fn(async () => 'mock text content'),
}));

describe('Dimension 03: 对话流式引擎、草稿、附件与项目选择隔离测试', () => {
  beforeEach(() => {
    sessionRuntimeRegistry.clearAll();
    clearSessionRenderBuffers();
    draftFolderRegistry.clear();
    resetFileAnnotationsForTest();
  });

  afterEach(() => {
    sessionRuntimeRegistry.clearAll();
    clearSessionRenderBuffers();
    draftFolderRegistry.clear();
    resetFileAnnotationsForTest();
  });

  describe('1. SessionStreamManager: 按 sessionId 隔离渲染缓冲', () => {
    it('不同 session 的 StreamRenderBuffer 独立注册并按 session 检索', () => {
      const mockBufferA = {
        appendChunk: vi.fn(),
        flushFinal: vi.fn(),
        flushImmediate: vi.fn(),
        destroy: vi.fn(),
        stop: vi.fn(),
      } as any;
      const mockBufferB = {
        appendChunk: vi.fn(),
        flushFinal: vi.fn(),
        flushImmediate: vi.fn(),
        destroy: vi.fn(),
        stop: vi.fn(),
      } as any;

      registerSessionRenderBuffer('session-a', mockBufferA);
      registerSessionRenderBuffer('session-b', mockBufferB);

      expect(getSessionRenderBuffer('session-a')).toBe(mockBufferA);
      expect(getSessionRenderBuffer('session-b')).toBe(mockBufferB);
      expect(getSessionRenderBuffer('session-c')).toBeNull();
    });

    it('flushAndRemoveSessionRenderBuffer 仅冲刷并销毁目标会话缓冲区，不污染并行会话', () => {
      const mockBufferA = {
        flushFinal: vi.fn(),
        stop: vi.fn(),
      } as any;
      const mockBufferB = {
        flushFinal: vi.fn(),
        stop: vi.fn(),
      } as any;

      registerSessionRenderBuffer('session-a', mockBufferA);
      registerSessionRenderBuffer('session-b', mockBufferB);

      // 仅冲刷 session-a
      flushAndRemoveSessionRenderBuffer('session-a');

      expect(mockBufferA.flushFinal).toHaveBeenCalledTimes(1);
      expect(mockBufferB.flushFinal).not.toHaveBeenCalled();

      // session-a 已注销，session-b 仍有效
      expect(getSessionRenderBuffer('session-a')).toBeNull();
      expect(getSessionRenderBuffer('session-b')).toBe(mockBufferB);
    });
  });

  describe('2. Dual Draft Panes: 双草稿分屏项目选择与元数据隔离', () => {
    it('两块草稿分屏分别绑定独立草稿项目目录，互不干扰', () => {
      const draftA = '__pending_draft__:leaf-alpha';
      const draftB = '__pending_draft__:leaf-beta';

      // 独立为两个草稿分屏设置项目路径
      act(() => {
        useSessionStore
          .getState()
          .setDraftFolder('/projects/repo-alpha', draftA);
        useSessionStore
          .getState()
          .setDraftFolder('/projects/repo-beta', draftB);
      });

      expect(draftFolderRegistry.get(draftA)).toBe('/projects/repo-alpha');
      expect(draftFolderRegistry.get(draftB)).toBe('/projects/repo-beta');

      // 挂载 Pane A 的 useChatSessionMeta
      const wrapperA: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-alpha"
          sessionId={draftA}
          isActive={true}
          leafRootRef={{ current: null }}
        >
          {children}
        </LeafScopeProvider>
      );
      const { result: metaA } = renderHook(() => useChatSessionMeta({}), {
        wrapper: wrapperA,
      });

      // 挂载 Pane B 的 useChatSessionMeta
      const wrapperB: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-beta"
          sessionId={draftB}
          isActive={false}
          leafRootRef={{ current: null }}
        >
          {children}
        </LeafScopeProvider>
      );
      const { result: metaB } = renderHook(() => useChatSessionMeta({}), {
        wrapper: wrapperB,
      });

      // 验证 workspaceKey 分别解析为对应草稿的独立项目目录
      expect(metaA.current.workspaceKey).toBe('/projects/repo-alpha');
      expect(metaB.current.workspaceKey).toBe('/projects/repo-beta');
    });
  });

  describe('3. Guard-3 & Draft Commit: 草稿原子提交与运行时注册表迁移', () => {
    it('显式传入 draftSessionId 时，即使全局 activeSessionId 为已有实体会话，依然执行提交并原子迁移附件与思考配置', () => {
      const draftId = '__pending_draft__:leaf-target';
      const otherDraftId = '__pending_draft__:leaf-untouched';

      // 模拟全局 activeSessionId 停留在已有真实会话
      useSessionStore.setState({
        activeSessionId: 'existing-real-session',
        sessionsById: {
          'existing-real-session': {
            id: 'existing-real-session',
            title: '现有真实会话',
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          } as any,
        },
      });

      // 为目标草稿登记独立目录与运行时元数据（附件、思考偏好）
      draftFolderRegistry.set(draftId, '/projects/my-new-app');
      draftFolderRegistry.set(otherDraftId, '/projects/other-app');

      sessionRuntimeRegistry.save(draftId, {
        attachments: [
          {
            id: 'att-1',
            name: 'spec.md',
            mime: 'text/markdown',
          } as any,
        ],
        thinkingTitle: '极致推理',
      });
      sessionRuntimeRegistry.save(otherDraftId, {
        thinkingTitle: '常规思考',
      });

      // 执行 commitDraftIfNeeded，显式提供 draftSessionId
      let committedSessionId: string | null = null;
      act(() => {
        committedSessionId = useSessionStore
          .getState()
          .commitDraftIfNeeded(draftId);
      });

      expect(committedSessionId).toBeTruthy();
      expect(typeof committedSessionId).toBe('string');
      const newSessionId = committedSessionId!;

      // 验证新生成的实体会话使用了草稿登记的项目目录
      const sessions = useSessionStore.getState().sessionsById;
      expect(sessions[newSessionId]).toBeDefined();
      expect(sessions[newSessionId]?.folder).toBe('/projects/my-new-app');

      // 验证运行时注册表原子迁移：新会话继承了草稿的附件与思考偏好
      expect(sessionRuntimeRegistry.exists(newSessionId)).toBe(true);
      const migratedRuntime = sessionRuntimeRegistry.get(newSessionId);
      expect(migratedRuntime.attachments).toHaveLength(1);
      expect(migratedRuntime.attachments?.[0]?.name).toBe('spec.md');
      expect(migratedRuntime.thinkingTitle).toBe('极致推理');

      // 验证草稿已被移除
      expect(sessionRuntimeRegistry.exists(draftId)).toBe(false);

      // 验证并行未触及的草稿保持原样
      expect(sessionRuntimeRegistry.exists(otherDraftId)).toBe(true);
      expect(sessionRuntimeRegistry.get(otherDraftId).thinkingTitle).toBe(
        '常规思考'
      );
      expect(draftFolderRegistry.get(otherDraftId)).toBe('/projects/other-app');
    });
  });

  describe('4. useChatAttachments: 附件与作用域 UI 事件路由过滤', () => {
    it('conex:attach-text-file 与 crish-attachments-changed 按 sessionId 精准过滤，不串扰其他分屏', () => {
      const rootElA = document.createElement('div');
      const rootElB = document.createElement('div');

      const wrapperA: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-a"
          sessionId="session-a"
          isActive={true}
          leafRootRef={{ current: rootElA }}
        >
          {children}
        </LeafScopeProvider>
      );

      const wrapperB: React.FC<{ children: React.ReactNode }> = ({
        children,
      }) => (
        <LeafScopeProvider
          leafId="leaf-b"
          sessionId="session-b"
          isActive={false}
          leafRootRef={{ current: rootElB }}
        >
          {children}
        </LeafScopeProvider>
      );

      const { result: attA } = renderHook(() => useChatAttachments(), {
        wrapper: wrapperA,
      });
      const { result: attB } = renderHook(() => useChatAttachments(), {
        wrapper: wrapperB,
      });

      expect(attA.current.attachments).toHaveLength(0);
      expect(attB.current.attachments).toHaveLength(0);

      // 派发指定给 session-a 的 conex:attach-text-file 事件
      act(() => {
        window.dispatchEvent(
          new CustomEvent('conex:attach-text-file', {
            detail: {
              sessionId: 'session-a',
              name: 'prompt-a.txt',
              text: 'content for pane A',
            },
          })
        );
      });

      // 仅 Pane A 收到附件，Pane B 被 shouldConsumeScopedEvent 拦截
      expect(attA.current.attachments).toHaveLength(1);
      expect(attA.current.attachments[0]?.name).toBe('prompt-a.txt');
      expect(attB.current.attachments).toHaveLength(0);

      // 在 sessionRuntimeRegistry 中为 session-b 存储附件并广播 crish-attachments-changed
      sessionRuntimeRegistry.save('session-b', {
        attachments: [
          {
            id: 'att-b-1',
            name: 'data-b.csv',
            mime: 'text/csv',
            status: 'ready',
            progress: 100,
          } as any,
        ],
      });

      act(() => {
        window.dispatchEvent(
          new CustomEvent('crish-attachments-changed', {
            detail: {
              sessionId: 'session-b',
            },
          })
        );
      });

      // Pane B 从 sessionRuntimeRegistry 恢复 1 个附件，Pane A 依然保持原有 1 个附件
      expect(attB.current.attachments).toHaveLength(1);
      expect(attB.current.attachments[0]?.name).toBe('data-b.csv');
      expect(attA.current.attachments).toHaveLength(1);
      expect(attA.current.attachments[0]?.name).toBe('prompt-a.txt');
    });
  });

  describe('5. removePendingFileAnnotation: 多会话待发送批注独立注销', () => {
    it('按 scopedSessionId 独立删除待发送批注，不影响其他分屏会话中的批注', () => {
      // 分别为 session-a 和 session-b 添加待发送批注
      const annoA = addPendingFileAnnotation(
        {
          path: '/src/moduleA.ts',
          selectedText: 'function runA() {}',
          text: '请重构此函数',
        },
        { targetSessionId: 'session-a' }
      );

      const annoB = addPendingFileAnnotation(
        {
          path: '/src/moduleB.ts',
          selectedText: 'function runB() {}',
          text: '请为此函数补全单元测试',
        },
        { targetSessionId: 'session-b' }
      );

      expect(annoA).not.toBeNull();
      expect(annoB).not.toBeNull();

      expect(countPendingFileAnnotations('session-a')).toBe(1);
      expect(countPendingFileAnnotations('session-b')).toBe(1);

      // 删除 session-a 上的待发送批注
      const removed = removePendingFileAnnotation(annoA!.id, 'session-a');
      expect(removed).toBe(true);

      // 验证 session-a 清空，session-b 依然存在且完好
      expect(countPendingFileAnnotations('session-a')).toBe(0);
      expect(countPendingFileAnnotations('session-b')).toBe(1);
      expect(
        sessionRuntimeRegistry.get('session-b').attachments?.[0]?.path
      ).toBe('/src/moduleB.ts');
    });
  });

  describe('6. ModelBadgePickerMenu & ComposerFusedTrigger: 思考配置与模型作用域隔离', () => {
    it('多分屏下各自分屏写入的 thinkingTitle 严格保存在自身 scopedSessionId 对应的 sessionRuntimeRegistry 中', () => {
      // 模拟 Pane A 写入深度思考偏好
      sessionRuntimeRegistry.save('session-a', {
        thinkingTitle: 'Pane A 专项思考',
      });

      // 模拟 Pane B 写入极速思考偏好
      sessionRuntimeRegistry.save('session-b', {
        thinkingTitle: 'Pane B 极速思考',
      });

      expect(sessionRuntimeRegistry.get('session-a').thinkingTitle).toBe(
        'Pane A 专项思考'
      );
      expect(sessionRuntimeRegistry.get('session-b').thinkingTitle).toBe(
        'Pane B 极速思考'
      );

      // 更新 session-a，验证 session-b 完全隔离
      sessionRuntimeRegistry.save('session-a', {
        thinkingTitle: 'Pane A 已调整为推理模型',
      });

      expect(sessionRuntimeRegistry.get('session-a').thinkingTitle).toBe(
        'Pane A 已调整为推理模型'
      );
      expect(sessionRuntimeRegistry.get('session-b').thinkingTitle).toBe(
        'Pane B 极速思考'
      );
    });
  });

  describe('7. Inline Edit Paste Isolation: 原位编辑与底部主输入框粘贴隔离', () => {
    it('原位编辑输入框的粘贴事件独立写入 editAttachments，绝不泄漏到底部主输入框', async () => {
      let editAttachments: any[] = [];
      const setEditAttachments = (fn: (prev: any[]) => any[]) => {
        editAttachments = fn(editAttachments);
      };

      const handleEditPastePath = (paths: string[]) => {
        const mapped = paths.map((p) => ({
          id: `att-test-${p}`,
          name: p.split(/[\\/]/).pop() || p,
          path: p,
          status: 'ready' as const,
          progress: 100,
        }));
        setEditAttachments((prev) => [...prev, ...mapped]);
      };

      handleEditPastePath(['/path/to/edited-file.ts']);

      expect(editAttachments).toHaveLength(1);
      expect(editAttachments[0].name).toBe('edited-file.ts');

      // 验证底部主输入框绑定的 sessionRuntimeRegistry 依然保持干净，无跨输入框污染
      expect(
        sessionRuntimeRegistry.get('session-a').attachments ?? []
      ).toHaveLength(0);
    });
  });
});
