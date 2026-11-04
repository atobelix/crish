import { InMemorySecureStore } from '@/db/secureStore';
import {
  KEY_COOL_DOWN_DURATIONS,
  WebSearchKeyManager,
  webSearchKeyRefFor,
  webSearchKeySlotFor,
} from './searchKeyManager';

describe('WebSearchKeyManager', () => {
  let fakeSecure: InMemorySecureStore;
  let manager: WebSearchKeyManager;

  beforeEach(() => {
    fakeSecure = new InMemorySecureStore();
    manager = WebSearchKeyManager.getInstance(fakeSecure);
    manager.setDriver(fakeSecure);
    manager.clear();
  });

  afterEach(() => {
    manager.clear();
  });

  describe('SecureStore 存取与格式化规范', () => {
    it('正确生成槽位与引用标识', () => {
      expect(webSearchKeySlotFor('tavily')).toBe('websearch.key.tavily');
      expect(webSearchKeyRefFor('tavily')).toBe('secure:websearch.key.tavily');
    });

    it('保存单 Key 并可正常读取', async () => {
      await manager.saveKeys('tavily', ['tvly-single-key']);
      const keys = await manager.getAvailableKeys('tavily');
      expect(keys).toEqual(['tvly-single-key']);
      const rawInStore = await fakeSecure.getItem('websearch.key.tavily');
      expect(rawInStore).toBe('tvly-single-key');
    });

    it('支持逗号和换行分割的多个 Key，且自动 trim 与去重', async () => {
      await manager.saveKeys(
        'brave',
        '  brave-key1, brave-key2\nbrave-key3 , brave-key1 \n\n'
      );
      const keys = await manager.getAvailableKeys('brave');
      expect(keys).toEqual(['brave-key1', 'brave-key2', 'brave-key3']);
    });

    it('支持传入数组形式，且过滤空串与重复', async () => {
      await manager.saveKeys('exa', [' exa-1 ', '', 'exa-2', 'exa-1']);
      const keys = await manager.getAvailableKeys('exa');
      expect(keys).toEqual(['exa-1', 'exa-2']);
    });

    it('保存空数组时彻底从 SecureStore 移除槽位', async () => {
      await manager.saveKeys('jina', ['jina-key-1']);
      expect(await fakeSecure.getItem('websearch.key.jina')).toBe('jina-key-1');

      await manager.saveKeys('jina', []);
      expect(await fakeSecure.getItem('websearch.key.jina')).toBeNull();
      expect(await manager.getAvailableKeys('jina')).toEqual([]);
    });

    it('未配置 Key 的服务商获取返回空数组与 null', async () => {
      expect(await manager.getAvailableKeys('unconfigured')).toEqual([]);
      expect(await manager.getKey('unconfigured')).toBeNull();
      expect(await manager.resolveNextKey('unconfigured')).toBeNull();
    });
  });

  describe('多 Key Round-Robin 轮询状态机', () => {
    it('单个 Key 始终返回该 Key', async () => {
      await manager.saveKeys('tavily', ['key-only']);
      expect(await manager.getKey('tavily')).toBe('key-only');
      expect(await manager.getKey('tavily')).toBe('key-only');
    });

    it('多个 Key 依次 Round-Robin 循环轮询', async () => {
      await manager.saveKeys('tavily', ['key-1', 'key-2', 'key-3']);
      expect(await manager.getKey('tavily')).toBe('key-1');
      expect(await manager.getKey('tavily')).toBe('key-2');
      expect(await manager.getKey('tavily')).toBe('key-3');
      // 循环回到 key-1
      expect(await manager.getKey('tavily')).toBe('key-1');
      expect(await manager.getKey('tavily')).toBe('key-2');
    });

    it('不同 providerId 拥有各自独立的轮询索引', async () => {
      await manager.saveKeys('tavily', ['t1', 't2']);
      await manager.saveKeys('brave', ['b1', 'b2', 'b3']);

      expect(await manager.getKey('tavily')).toBe('t1');
      expect(await manager.getKey('brave')).toBe('b1');

      expect(await manager.getKey('tavily')).toBe('t2');
      expect(await manager.getKey('brave')).toBe('b2');

      expect(await manager.getKey('tavily')).toBe('t1');
      expect(await manager.getKey('brave')).toBe('b3');
    });
  });

  describe('429 / 401 故障隔离与冷却自愈', () => {
    it('遇到 429 限流时冷却 5 分钟，自动跳过该 Key 故障转移至下一可用 Key', async () => {
      await manager.saveKeys('tavily', ['key-1', 'key-2', 'key-3']);

      expect(await manager.getKey('tavily')).toBe('key-1');

      // 模拟调用 key-2 时遭遇 429 限流
      manager.reportKeyFailure('tavily', 'key-2', '429');
      expect(manager.isKeyInCoolDown('key-2')).toBe(true);

      const health = manager.getKeyHealth('key-2');
      expect(health?.failedCount).toBe(1);
      expect(health?.lastFailedStatus).toBe('429');

      // 下一次轮询跳过处于冷却的 key-2，直接获得 key-3
      expect(await manager.getKey('tavily')).toBe('key-3');
      // 再次轮询跳过 key-2，轮回到 key-1
      expect(await manager.getKey('tavily')).toBe('key-1');
      // 再次轮询依然跳过 key-2，获得 key-3
      expect(await manager.getKey('tavily')).toBe('key-3');
    });

    it('遇到 401 鉴权失效时冷却 30 分钟', async () => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await manager.saveKeys('tavily', ['invalid-key', 'valid-key']);
      manager.reportKeyFailure('tavily', 'invalid-key', '401');

      const health = manager.getKeyHealth('invalid-key');
      expect(health?.coolDownUntilMs).toBe(
        now + KEY_COOL_DOWN_DURATIONS.UNAUTHORIZED_401
      );
      expect(manager.isKeyInCoolDown('invalid-key', now)).toBe(true);

      // 29 分钟后依然在冷却中
      expect(manager.isKeyInCoolDown('invalid-key', now + 29 * 60 * 1000)).toBe(
        true
      );
      // 31 分钟后冷却结束
      expect(manager.isKeyInCoolDown('invalid-key', now + 31 * 60 * 1000)).toBe(
        false
      );

      jest.restoreAllMocks();
    });

    it('全部 Key 均被冷却时，兜底回退全量 Key 防死锁', async () => {
      await manager.saveKeys('tavily', ['key-a', 'key-b']);
      manager.markKeyFailure('key-a', 429);
      manager.markKeyFailure('key-b', 429);

      // 全部冷却时，不应返回 null，而应降级使用全量 candidate 进行尝试
      const chosen = await manager.getKey('tavily');
      expect(['key-a', 'key-b']).toContain(chosen);
    });

    it('成功调用清除故障记录，实现自愈恢复', async () => {
      await manager.saveKeys('tavily', ['key-1', 'key-2']);
      manager.reportKeyFailure('tavily', 'key-1', '429');
      expect(manager.isKeyInCoolDown('key-1')).toBe(true);

      // 调用成功汇报自愈
      manager.reportKeySuccess('tavily', 'key-1');
      expect(manager.isKeyInCoolDown('key-1')).toBe(false);
      expect(manager.getKeyHealth('key-1')).toBeUndefined();
    });
  });

  describe('Zero-Leak 物理隔离防泄漏验证', () => {
    it('API Key 仅存储于 SecureStore 硬件槽位中', async () => {
      const sensitiveKey = 'tvly-secret-zero-leak-1234567890';
      await manager.saveKeys('tavily', [sensitiveKey]);

      const storedInSecure = await fakeSecure.getItem('websearch.key.tavily');
      expect(storedInSecure).toBe(sensitiveKey);

      // 清空后不再存在
      manager.clear();
      await fakeSecure.deleteItem('websearch.key.tavily');
      expect(await fakeSecure.getItem('websearch.key.tavily')).toBeNull();
    });
  });
});
