/**
 * apps/crish-mobile/src/adapters/sync/pairingConfigSync.test.ts
 *
 * 跨端配对态加密配置与搜索 Key 安全同步协议全维度单元测试。
 * 覆盖：信令构造、防重放检验、AES-256-GCM 篡改拦截、密钥安全落盘与安全抹除。
 */

import { InMemorySecureStore } from '@/db/secureStore';
import { localChatStore } from '@/domain/store/localChatStore';
import {
  applySyncedSecretsToDevice,
  buildRequestSecretsSyncPayload,
  clearSyncedSecretsFromDevice,
  decryptAndVerifySecretsSyncPayload,
  encryptSecretsSyncPayload,
  generateClientNonce,
  getSyncedSearchKey,
  normalizeSessionKey,
  SyncDecryptionError,
  type SyncedSecretsPayload,
} from './index';

describe('pairingConfigSync 跨端密钥同步协议', () => {
  const TEST_SESSION_KEY = 'crish-session-secret-key-32bytes-ecdh!';
  const RAW_32_BYTES_KEY = new Uint8Array(32).fill(7);

  describe('1. 信令构造与请求格式 (buildRequestSecretsSyncPayload)', () => {
    it('默认请求范围应为 ["websearch", "models"] 且生成高熵 clientNonce', () => {
      const payload = buildRequestSecretsSyncPayload();

      expect(payload.kind).toBe('config.request_secrets_sync');
      expect(payload.scopes).toEqual(['websearch', 'models']);
      expect(payload.body.scopes).toEqual(['websearch', 'models']);
      expect(typeof payload.clientNonce).toBe('string');
      expect(payload.clientNonce.length).toBe(32); // 16 字节 Hex = 32 字符
      expect(payload.body.clientNonce).toBe(payload.clientNonce);
    });

    it('连续调用应生成不同的客户端随机数（杜绝重放）', () => {
      const p1 = buildRequestSecretsSyncPayload();
      const p2 = buildRequestSecretsSyncPayload();
      expect(p1.clientNonce).not.toBe(p2.clientNonce);
    });

    it('支持显式指定请求作用域与确定性随机数（测试与断言友好）', () => {
      const fixedNonce = '0123456789abcdef0123456789abcdef';
      const payload = buildRequestSecretsSyncPayload(['websearch'], fixedNonce);

      expect(payload.scopes).toEqual(['websearch']);
      expect(payload.clientNonce).toBe(fixedNonce);
      expect(payload.body.clientNonce).toBe(fixedNonce);
    });

    it('generateClientNonce 应支持指定字节长度', () => {
      const nonce16 = generateClientNonce(16);
      expect(nonce16.length).toBe(32);
      const nonce32 = generateClientNonce(32);
      expect(nonce32.length).toBe(64);
    });
  });

  describe('2. 密钥归一化算法 (normalizeSessionKey)', () => {
    it('32 字节 Uint8Array 应原样返回', () => {
      const key = new Uint8Array(32).fill(99);
      expect(normalizeSessionKey(key)).toBe(key);
    });

    it('64 字符 Hex 字符串应准确解析为 32 字节', () => {
      const hex = '00'.repeat(31) + 'ff';
      const normalized = normalizeSessionKey(hex);
      expect(normalized.length).toBe(32);
      expect(normalized[31]).toBe(255);
    });

    it('44 字符 Base64 字符串能还原为 32 字节材料', () => {
      const base64Key = Buffer.from(new Uint8Array(32).fill(42)).toString(
        'base64'
      );
      const normalized = normalizeSessionKey(base64Key);
      expect(normalized.length).toBe(32);
      expect(normalized[0]).toBe(42);
    });

    it('普通字符串应安全经 SHA-256 派生出 32 字节密钥', () => {
      const normalized = normalizeSessionKey('my-short-passphrase');
      expect(normalized.length).toBe(32);
      // 两次派生结果完全幂等
      expect(normalizeSessionKey('my-short-passphrase')).toEqual(normalized);
    });
  });

  describe('3. 桌面端加密 -> 手机端解密完整闭环 (End-to-End Crypto Roundtrip)', () => {
    const mockSecrets: SyncedSecretsPayload = {
      clientNonce: 'client-nonce-001',
      serverNonce: 'server-nonce-xyz',
      timestamp: 1730700000000,
      webSearchKeys: {
        tavily: 'tvly-secret-123456789',
        brave: 'BSA-secret-abcdef',
        exa: 'exa-key-987654321',
        serpapi: 'serpapi-live-token',
      },
      websearch: {
        providers: {
          bocha: { apiKey: 'bocha-api-token-777' },
          jina: { apiKey: 'jina-reader-key-888' },
        },
      },
      models: {
        providers: {
          deepseek: {
            apiKey: 'sk-deepseek-sync-token',
            spec: {
              displayName: 'DeepSeek 官方',
              baseUrl: 'https://api.deepseek.com/v1',
            },
          },
        },
      },
    };

    it('应成功使用会话密钥完成加密并无损解密全部载荷', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        mockSecrets,
        TEST_SESSION_KEY
      );

      expect(typeof encrypted.cipherText).toBe('string');
      expect(typeof encrypted.iv).toBe('string');
      expect(typeof encrypted.tag).toBe('string');
      expect(encrypted.clientNonce).toBe(mockSecrets.clientNonce);

      const decrypted = await decryptAndVerifySecretsSyncPayload(
        encrypted,
        TEST_SESSION_KEY,
        mockSecrets.clientNonce
      );

      expect(decrypted.clientNonce).toBe(mockSecrets.clientNonce);
      expect(decrypted.webSearchKeys?.tavily).toBe('tvly-secret-123456789');
      expect(decrypted.webSearchKeys?.brave).toBe('BSA-secret-abcdef');
      expect(decrypted.webSearchKeys?.exa).toBe('exa-key-987654321');
      expect(decrypted.webSearchKeys?.serpapi).toBe('serpapi-live-token');
      expect(decrypted.websearch?.providers?.bocha?.apiKey).toBe(
        'bocha-api-token-777'
      );
      expect(decrypted.models?.providers?.deepseek?.apiKey).toBe(
        'sk-deepseek-sync-token'
      );
    });

    it('支持原始 32 字节 Uint8Array 会话密钥进行加解密', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        mockSecrets,
        RAW_32_BYTES_KEY
      );
      const decrypted = await decryptAndVerifySecretsSyncPayload(
        encrypted,
        RAW_32_BYTES_KEY,
        mockSecrets.clientNonce
      );
      expect(decrypted.webSearchKeys?.tavily).toBe('tvly-secret-123456789');
    });

    it('支持信封结构作为入参传入解密函数', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        mockSecrets,
        TEST_SESSION_KEY
      );
      const envelope = {
        kind: 'result.config.secrets_sync',
        body: encrypted,
      };

      const decrypted = await decryptAndVerifySecretsSyncPayload(
        envelope,
        TEST_SESSION_KEY,
        mockSecrets.clientNonce
      );
      expect(decrypted.webSearchKeys?.tavily).toBe('tvly-secret-123456789');
    });
  });

  describe('4. 防重放检验 (Anti-Replay Verification)', () => {
    it('外层 clientNonce 与 expectedClientNonce 不一致时坚决抛出 SyncDecryptionError', async () => {
      const payload: SyncedSecretsPayload = {
        clientNonce: 'correct-nonce-aaa',
        webSearchKeys: { tavily: 'tvly-test' },
      };
      const encrypted = await encryptSecretsSyncPayload(
        payload,
        TEST_SESSION_KEY
      );

      await expect(
        decryptAndVerifySecretsSyncPayload(
          { ...encrypted, clientNonce: 'tampered-nonce-bbb' },
          TEST_SESSION_KEY,
          'correct-nonce-aaa'
        )
      ).rejects.toThrow(SyncDecryptionError);
    });

    it('内层载荷中的 clientNonce 与 expectedClientNonce 不一致时拒绝接受', async () => {
      const payload: SyncedSecretsPayload = {
        clientNonce: 'replay-old-nonce',
        webSearchKeys: { tavily: 'tvly-test' },
      };
      const encrypted = await encryptSecretsSyncPayload(
        payload,
        TEST_SESSION_KEY
      );

      await expect(
        decryptAndVerifySecretsSyncPayload(
          { ...encrypted, clientNonce: undefined },
          TEST_SESSION_KEY,
          'fresh-client-nonce-2026'
        )
      ).rejects.toThrow(SyncDecryptionError);
    });
  });

  describe('5. AES-256-GCM 篡改与伪造坚决拦截 (Fail-Closed Integrity)', () => {
    const validPayload: SyncedSecretsPayload = {
      clientNonce: 'safe-nonce-123',
      webSearchKeys: { tavily: 'tvly-secret' },
    };

    it('密文 cipherText 被篡改时解密失败抛错', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        validPayload,
        TEST_SESSION_KEY
      );
      // 篡改密文 Base64 字符
      const corruptedCipher =
        encrypted.cipherText.slice(0, -2) +
        (encrypted.cipherText.endsWith('A') ? 'B' : 'A') +
        '=';

      await expect(
        decryptAndVerifySecretsSyncPayload(
          { ...encrypted, cipherText: corruptedCipher },
          TEST_SESSION_KEY,
          validPayload.clientNonce
        )
      ).rejects.toThrow(SyncDecryptionError);
    });

    it('认证标签 tag 被篡改时验签失败抛错', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        validPayload,
        TEST_SESSION_KEY
      );
      const corruptedTag =
        encrypted.tag.slice(0, -2) +
        (encrypted.tag.endsWith('A') ? 'B' : 'A') +
        '=';

      await expect(
        decryptAndVerifySecretsSyncPayload(
          { ...encrypted, tag: corruptedTag },
          TEST_SESSION_KEY,
          validPayload.clientNonce
        )
      ).rejects.toThrow(SyncDecryptionError);
    });

    it('初始向量 iv 被篡改时验签失败抛错', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        validPayload,
        TEST_SESSION_KEY
      );
      const corruptedIv =
        encrypted.iv.slice(0, -2) +
        (encrypted.iv.endsWith('A') ? 'B' : 'A') +
        '=';

      await expect(
        decryptAndVerifySecretsSyncPayload(
          { ...encrypted, iv: corruptedIv },
          TEST_SESSION_KEY,
          validPayload.clientNonce
        )
      ).rejects.toThrow(SyncDecryptionError);
    });

    it('使用错误的会话密钥解密坚决失败', async () => {
      const encrypted = await encryptSecretsSyncPayload(
        validPayload,
        TEST_SESSION_KEY
      );
      const wrongKey = 'completely-wrong-attacker-session-key!!';

      await expect(
        decryptAndVerifySecretsSyncPayload(
          encrypted,
          wrongKey,
          validPayload.clientNonce
        )
      ).rejects.toThrow(SyncDecryptionError);
    });

    it('缺失必填字段时拒绝处理', async () => {
      await expect(
        decryptAndVerifySecretsSyncPayload(
          {
            cipherText: '',
            iv: 'abc',
            tag: 'def',
            serverNonce: '123',
          },
          TEST_SESSION_KEY
        )
      ).rejects.toThrow(SyncDecryptionError);
    });
  });

  describe('6. 硬件安全落盘与安全合并 (applySyncedSecretsToDevice)', () => {
    let mockSecureStore: InMemorySecureStore;

    beforeEach(() => {
      mockSecureStore = new InMemorySecureStore();
    });

    it('成功将多搜索服务商密钥落盘至硬件安全存储槽位', async () => {
      const payload: SyncedSecretsPayload = {
        webSearchKeys: {
          tavily: 'tvly-live-abc123',
          brave: 'BSA-live-xyz456',
          exa: 'exa-token-789',
          serpapi: 'serpapi-tok-111',
        },
        websearch: {
          providers: {
            bocha: { apiKey: 'bocha-key-222' },
          },
        },
      };

      const result = await applySyncedSecretsToDevice(payload, {
        secureStore: mockSecureStore,
      });

      expect(result.syncedSearchKeys).toContain('tavily');
      expect(result.syncedSearchKeys).toContain('brave');
      expect(result.syncedSearchKeys).toContain('exa');
      expect(result.syncedSearchKeys).toContain('serpapi');
      expect(result.syncedSearchKeys).toContain('bocha');

      // 验证硬件存储键规范：websearch.provider.<id>.api_key
      expect(
        await mockSecureStore.getItem('websearch.provider.tavily.api_key')
      ).toBe('tvly-live-abc123');
      expect(
        await mockSecureStore.getItem('websearch.provider.brave.api_key')
      ).toBe('BSA-live-xyz456');
      expect(
        await mockSecureStore.getItem('websearch.provider.exa.api_key')
      ).toBe('exa-token-789');
      expect(
        await mockSecureStore.getItem('websearch.provider.serpapi.api_key')
      ).toBe('serpapi-tok-111');
      expect(
        await mockSecureStore.getItem('websearch.provider.bocha.api_key')
      ).toBe('bocha-key-222');
    });

    it('兼容支持 setItemAsync 风格的安全存储驱动接口', async () => {
      const storeMap = new Map<string, string>();
      const customAsyncStore = {
        async setItemAsync(k: string, v: string) {
          storeMap.set(k, v);
        },
        async getItemAsync(k: string) {
          return storeMap.get(k) ?? null;
        },
        async deleteItemAsync(k: string) {
          storeMap.delete(k);
        },
      };

      await applySyncedSecretsToDevice(
        {
          webSearchKeys: {
            tavily: 'tvly-async-compat',
          },
        },
        { secureStore: customAsyncStore }
      );

      expect(storeMap.get('websearch.provider.tavily.api_key')).toBe(
        'tvly-async-compat'
      );
    });

    it('包含模型供应商配置时安全合并入 localChatStore', async () => {
      const payload: SyncedSecretsPayload = {
        models: {
          providers: {
            deepseek: {
              apiKey: 'sk-deepseek-synced-key',
              spec: {
                displayName: 'DeepSeek 同步配置',
                baseUrl: 'https://api.deepseek.com',
                models: [
                  {
                    id: 'deepseek-chat',
                    displayName: 'DeepSeek-V3',
                    enabled: true,
                  },
                ],
              },
            },
          },
        },
      };

      const result = await applySyncedSecretsToDevice(payload, {
        secureStore: mockSecureStore,
        chatStore: localChatStore,
      });

      expect(result.syncedModelProviders).toContain('deepseek');
      const provider = localChatStore.getState().config.providers.deepseek;
      expect(provider).toBeDefined();
      expect(provider?.displayName).toBe('DeepSeek 同步配置');
      expect(provider?.baseUrl).toBe('https://api.deepseek.com');
      expect(provider?.models[0]?.id).toBe('deepseek-chat');
    });
  });

  describe('7. 安全读取与安全抹除 (getSyncedSearchKey & clearSyncedSecretsFromDevice)', () => {
    let mockSecureStore: InMemorySecureStore;

    beforeEach(() => {
      mockSecureStore = new InMemorySecureStore();
    });

    it('getSyncedSearchKey 能准确读取已存的提供商 Key，未存返回 null', async () => {
      await mockSecureStore.setItem(
        'websearch.provider.tavily.api_key',
        'tvly-my-key'
      );

      expect(await getSyncedSearchKey('tavily', mockSecureStore)).toBe(
        'tvly-my-key'
      );
      expect(await getSyncedSearchKey('TAVILY', mockSecureStore)).toBe(
        'tvly-my-key'
      );
      expect(await getSyncedSearchKey('brave', mockSecureStore)).toBeNull();
    });

    it('clearSyncedSecretsFromDevice 能安全抹除全部或指定提供商 Key', async () => {
      await mockSecureStore.setItem(
        'websearch.provider.tavily.api_key',
        'tvly-key'
      );
      await mockSecureStore.setItem(
        'websearch.provider.brave.api_key',
        'brave-key'
      );
      await mockSecureStore.setItem(
        'websearch.provider.exa.api_key',
        'exa-key'
      );

      // 仅抹除指定提供商
      await clearSyncedSecretsFromDevice({
        secureStore: mockSecureStore,
        providerIds: ['tavily'],
      });
      expect(await getSyncedSearchKey('tavily', mockSecureStore)).toBeNull();
      expect(await getSyncedSearchKey('brave', mockSecureStore)).toBe(
        'brave-key'
      );

      // 全量抹除
      await clearSyncedSecretsFromDevice({ secureStore: mockSecureStore });
      expect(await getSyncedSearchKey('brave', mockSecureStore)).toBeNull();
      expect(await getSyncedSearchKey('exa', mockSecureStore)).toBeNull();
    });
  });
});
