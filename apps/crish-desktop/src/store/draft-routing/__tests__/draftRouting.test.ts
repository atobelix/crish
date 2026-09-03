import { describe, it, expect, beforeEach, vi } from 'vitest';
import { draftFolderRegistry } from '../draftFolderRegistry';
import { resolveMostActiveProjectFolder } from '../draftProjectResolver';
import { useSessionStore } from '../../sessionStore';
import { GENERAL_FOLDER } from '../../../api/projectStore';

describe('draft-routing 模块分组与确定性项目绑定套件', () => {
  beforeEach(() => {
    draftFolderRegistry.clear();
    localStorage.clear();
    useSessionStore.setState({
      sessions: [],
      sessionsById: {},
      activeSessionId: null,
      draftFolder: GENERAL_FOLDER,
    });
  });

  describe('1. draftFolderRegistry 注册表', () => {
    it('支持按草稿 ID 确定性设置与读取绑定的项目 folder', () => {
      draftFolderRegistry.set('__pending_draft__:leaf-1', 'conex');
      draftFolderRegistry.set('__pending_draft__:leaf-2', GENERAL_FOLDER);

      expect(draftFolderRegistry.get('__pending_draft__:leaf-1')).toBe('conex');
      expect(draftFolderRegistry.get('__pending_draft__:leaf-2')).toBe(GENERAL_FOLDER);
      expect(draftFolderRegistry.get('non-existent')).toBeUndefined();
    });

    it('删除草稿后清空映射并支持单例 clear', () => {
      draftFolderRegistry.set('__pending_draft__:leaf-1', 'proj-alpha');
      draftFolderRegistry.delete('__pending_draft__:leaf-1');
      expect(draftFolderRegistry.get('__pending_draft__:leaf-1')).toBeUndefined();

      draftFolderRegistry.set('__pending_draft__:leaf-2', 'proj-beta');
      draftFolderRegistry.clear();
      expect(draftFolderRegistry.get('__pending_draft__:leaf-2')).toBeUndefined();
    });

    it('触发事件通知已订阅的外部 listener', () => {
      const listener = vi.fn();
      const unsub = draftFolderRegistry.subscribe(listener);

      draftFolderRegistry.set('__pending_draft__:leaf-1', 'conex');
      expect(listener).toHaveBeenCalledTimes(1);

      unsub();
      draftFolderRegistry.set('__pending_draft__:leaf-1', 'conex-next');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('2. draftProjectResolver 最近活跃项目纯逻辑解析', () => {
    it('优先返回当前处于活动状态的真实会话所属项目', () => {
      useSessionStore.setState({
        sessions: [
          {
            id: 'sess-active',
            title: '活跃会话',
            folder: 'conex',
            timestamp: new Date().toISOString(),
            isPinned: false,
            isArchived: false,
          },
          {
            id: 'sess-other',
            title: '其他会话',
            folder: 'other-proj',
            timestamp: new Date(Date.now() - 100000).toISOString(),
            isPinned: false,
            isArchived: false,
          },
        ],
        sessionsById: {
          'sess-active': {
            id: 'sess-active',
            title: '活跃会话',
            folder: 'conex',
            timestamp: new Date().toISOString(),
            isPinned: false,
            isArchived: false,
          },
        },
        activeSessionId: 'sess-active',
      });

      expect(resolveMostActiveProjectFolder()).toBe('conex');
    });

    it('当当前无活动会话时，按时间戳降序寻找最近活跃的项目', () => {
      const olderTime = new Date('2026-08-01T10:00:00Z').toISOString();
      const newerTime = new Date('2026-08-10T12:00:00Z').toISOString();

      useSessionStore.setState({
        sessions: [
          {
            id: 'sess-1',
            title: '较旧会话',
            folder: 'old-project',
            timestamp: olderTime,
            isPinned: false,
            isArchived: false,
          },
          {
            id: 'sess-2',
            title: '较新会话',
            folder: 'latest-project',
            timestamp: newerTime,
            isPinned: false,
            isArchived: false,
          },
        ],
        activeSessionId: null,
      });

      expect(resolveMostActiveProjectFolder()).toBe('latest-project');
    });

    it('当所有会话均无项目或列表为空时，兜底 GENERAL_FOLDER', () => {
      useSessionStore.setState({
        sessions: [],
        activeSessionId: null,
      });

      expect(resolveMostActiveProjectFolder()).toBe(GENERAL_FOLDER);
    });
  });
});
