// @vitest-environment jsdom
/**
 * 环境声明：本套件断言 localStorage 的配额（QuotaExceededError）行为，
 * 依赖真实 `Storage` 构造器与 `localStorage` 实例（`vi.spyOn(Storage.prototype, ...)`）。
 * 根 `vitest.config.ts` 的 unit 项目默认 `environment: 'node'`（无 `Storage` 全局）
 * ⇒ 必须显式声明 jsdom，与同域 `modelCatalogMeta.test.ts` 同款口径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearFontScanCache,
  FONT_CACHE_EXPIRY_MS,
  getRuntimeCache,
  pruneExpiredRuntimeCache,
  readEmergencyDraft,
  readFirstRunWizardDone,
  readFontScanCache,
  readMcpServersCache,
  readPluginEnabledIds,
  readSkillKnownIds,
  readSkillsCache,
  readWorkflowRunsCache,
  readWorkflowsCache,
  removeEmergencyDraft,
  removeRuntimeCache,
  RUNTIME_CACHE_KEYS,
  setRuntimeCache,
  writeEmergencyDraft,
  writeFirstRunWizardDone,
  writeFontScanCache,
  writeMcpServersCache,
  writePluginEnabledIds,
  writeSkillKnownIds,
  writeSkillsCache,
  writeWorkflowRunsCache,
  writeWorkflowsCache,
} from './runtimeCache';

describe('runtimeCache architecture & lifecycle suite', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('1. 通用运行时缓存与生命周期', () => {
    it('写入并读取带 TTL 缓存，未过期时命中', () => {
      setRuntimeCache('test_key', { message: 'hello' }, { ttlMs: 5000 });
      const val = getRuntimeCache('test_key', { message: 'fallback' });
      expect(val).toEqual({ message: 'hello' });
    });

    it('带 TTL 缓存过期后自动清除并返回 fallback', () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      setRuntimeCache('test_expire_key', 'fresh_data', { ttlMs: 1000 });

      // 推进时间到过期后
      vi.spyOn(Date, 'now').mockReturnValue(now + 2000);

      const val = getRuntimeCache('test_expire_key', 'fallback_data');
      expect(val).toBe('fallback_data');
      // 验证 key 已被物理清理
      expect(localStorage.getItem('test_expire_key')).toBeNull();
    });

    it('向下兼容未包装 envelope 的原始 JSON 数据', () => {
      localStorage.setItem('raw_json_key', JSON.stringify({ raw: true }));
      const val = getRuntimeCache('raw_json_key', { raw: false });
      expect(val).toEqual({ raw: true });
    });

    it('removeRuntimeCache 能准确删除条目', () => {
      setRuntimeCache('remove_me', 'some_val');
      expect(getRuntimeCache('remove_me', '')).toBe('some_val');
      removeRuntimeCache('remove_me');
      expect(getRuntimeCache('remove_me', '')).toBe('');
    });

    it('pruneExpiredRuntimeCache 批量清理过期缓存项', () => {
      const now = 2_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // 设置 1 个过期条目，1 个有效条目
      setRuntimeCache('crish_cache_expired', 'stale', { ttlMs: 500 });
      setRuntimeCache('crish_cache_valid', 'fresh', { ttlMs: 10_000 });

      // 推进时间
      vi.spyOn(Date, 'now').mockReturnValue(now + 1000);

      pruneExpiredRuntimeCache();

      expect(localStorage.getItem('crish_cache_expired')).toBeNull();
      expect(localStorage.getItem('crish_cache_valid')).not.toBeNull();
    });

    it('写入 QuotaExceededError 时主动触发清理并重试', () => {
      const originalSetItem = localStorage.setItem.bind(localStorage);
      let setItemCalls = 0;

      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
        this: Storage,
        k: string,
        v: string
      ) {
        setItemCalls++;
        if (setItemCalls === 1) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        return originalSetItem(k, v);
      });

      setRuntimeCache('retry_key', 'safe_data');
      expect(setItemCalls).toBe(2);
      expect(getRuntimeCache('retry_key', '')).toBe('safe_data');
    });
  });

  describe('2. 字体扫描瘦身缓存 (Font Scan Cache)', () => {
    it('写入并读取系统字体扫描瘦身缓存', () => {
      writeFontScanCache([{ family: 'Segoe UI' }, { family: 'Consolas' }]);
      const cached = readFontScanCache();
      expect(cached).toEqual([{ family: 'Segoe UI' }, { family: 'Consolas' }]);
    });

    it('超过 7 天 TTL 后自动清除字体缓存', () => {
      const now = 5_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      writeFontScanCache([{ family: 'Microsoft YaHei' }]);
      expect(readFontScanCache()).not.toBeNull();

      // 推进 8 天
      vi.spyOn(Date, 'now').mockReturnValue(now + FONT_CACHE_EXPIRY_MS + 1000);

      expect(readFontScanCache()).toBeNull();
      expect(localStorage.getItem(RUNTIME_CACHE_KEYS.FONT_SCAN)).toBeNull();
    });

    it('clearFontScanCache 显式清空字体缓存', () => {
      writeFontScanCache([{ family: 'Arial' }]);
      clearFontScanCache();
      expect(readFontScanCache()).toBeNull();
    });
  });

  describe('3. 工作流缓存 (Workflows & Runs Cache)', () => {
    it('读取空缓存时默认返回空数组', () => {
      expect(readWorkflowsCache()).toEqual([]);
      expect(readWorkflowRunsCache()).toEqual([]);
    });

    it('保存与读取工作流列表及运行记录', () => {
      const mockWf = [
        {
          id: 'wf-1',
          name: '每日构建',
          prompt: 'run build',
          schedule: { kind: 'cron', expr: '0 0 * * *' },
        },
      ] as any;
      const mockRuns = [
        {
          id: 'run-1',
          workflowId: 'wf-1',
          status: 'success',
          startTime: 1000,
        },
      ] as any;

      writeWorkflowsCache(mockWf);
      writeWorkflowRunsCache(mockRuns);

      expect(readWorkflowsCache()).toEqual(mockWf);
      expect(readWorkflowRunsCache()).toEqual(mockRuns);
    });
  });

  describe('4. MCP 与 Skills 离线缓存', () => {
    it('读取与保存 MCP 列表', () => {
      expect(readMcpServersCache()).toEqual([]);
      const servers = [{ name: 'filesystem', status: 'connected' }] as any;
      writeMcpServersCache(servers);
      expect(readMcpServersCache()).toEqual(servers);
    });

    it('读取与保存 Skills 列表', () => {
      expect(readSkillsCache()).toEqual([]);
      const skills = [{ id: 'skill-git', name: 'Git Master' }] as any;
      writeSkillsCache(skills);
      expect(readSkillsCache()).toEqual(skills);
    });
  });

  describe('5. 向导状态与扩展启停/已知技能集合', () => {
    it('首次运行向导未完成时返回 false，完成写入后返回 true', () => {
      expect(readFirstRunWizardDone()).toBe(false);
      writeFirstRunWizardDone();
      expect(readFirstRunWizardDone()).toBe(true);
    });

    it('插件启停集合管理', () => {
      expect(readPluginEnabledIds()).toEqual(new Set());
      writePluginEnabledIds(new Set(['plugin-a', 'plugin-b']));
      const loaded = readPluginEnabledIds();
      expect(loaded.has('plugin-a')).toBe(true);
      expect(loaded.has('plugin-b')).toBe(true);
      expect(loaded.has('plugin-c')).toBe(false);
    });

    it('已知技能 ID 集合管理', () => {
      expect(readSkillKnownIds()).toEqual(new Set());
      writeSkillKnownIds(new Set(['sk-1', 'sk-2']));
      const ids = readSkillKnownIds();
      expect(ids.has('sk-1')).toBe(true);
      expect(ids.has('sk-2')).toBe(true);
    });
  });

  describe('6. 笔记应急草稿抢救暂存', () => {
    it('写入草稿并带时间戳读取', () => {
      writeEmergencyDraft('doc-101', { block1: '救急内容' });
      const drafts = readEmergencyDraft('doc-101');
      expect(drafts).toEqual({ block1: '救急内容' });
    });

    it('空草稿写入时自动删除对应 key', () => {
      writeEmergencyDraft('doc-102', { b1: 'draft' });
      expect(readEmergencyDraft('doc-102')).not.toBeNull();
      writeEmergencyDraft('doc-102', {});
      expect(readEmergencyDraft('doc-102')).toBeNull();
    });

    it('removeEmergencyDraft 彻底清除草稿', () => {
      writeEmergencyDraft('doc-103', { b1: 'draft' });
      removeEmergencyDraft('doc-103');
      expect(readEmergencyDraft('doc-103')).toBeNull();
    });
  });
});
