// WebSearchKeyManager：硬件隔离的多 Key 轮询与故障自愈状态机管理器
// 依据方案文档：docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §5
//
// 核心原则：
// 1. Zero-Leak 绝对铁律：API Key 统一走硬件加密存储 websearch.key.<providerId>，
//    绝不落盘 SQLite，也不进入全局状态快照；
// 2. 多 Key 轮询（Round-Robin）：支持逗号或换行分隔的多个 Key，按顺序轮流使用，分散配额压力；
// 3. 故障隔离与冷却自愈：遇到 429 限流冷却 5 分钟，遇到 401 鉴权失效冷却 30 分钟，
//    自动故障转移到可用备选 Key；全部冷却时兜底回退全量，并在调用成功后自动清除故障标记恢复健康。

import {
  expoSecureStoreDriver,
  type SecureStoreDriver,
} from '@/db/secureStore';

/** 搜索服务商在 SecureStore 中的槽位前缀 */
export const WEB_SEARCH_KEY_PREFIX = 'websearch.key.';

/** 获取指定服务商的 SecureStore 槽位名称 */
export function webSearchKeySlotFor(providerId: string): string {
  return `${WEB_SEARCH_KEY_PREFIX}${providerId}`;
}

/** 引用标识形态（与桌面 dpapi 保持一致格式） */
export function webSearchKeyRefFor(providerId: string): string {
  return `secure:${webSearchKeySlotFor(providerId)}`;
}

/** 密钥冷却时长定义（毫秒） */
export const KEY_COOL_DOWN_DURATIONS = {
  /** 429 限流隔离冷却：5 分钟 */
  RATE_LIMITED_429: 5 * 60 * 1000,
  /** 401 鉴权失效隔离冷却：30 分钟 */
  UNAUTHORIZED_401: 30 * 60 * 1000,
  /** 其他故障降级冷却：1 分钟 */
  DEFAULT_ERROR: 1 * 60 * 1000,
} as const;

/** 单个 Key 的内存态健康状态 */
export interface KeyHealthState {
  key: string;
  failedCount: number;
  lastFailedStatus?: number | string;
  coolDownUntilMs?: number; // 冷却截止时间戳（Date.now() + duration）
  lastErrorReason?: string;
}

export class WebSearchKeyManager {
  private static instance: WebSearchKeyManager | null = null;
  private secureDriver: SecureStoreDriver;
  /** 轮询索引记录：providerId -> lastUsedIndex */
  private readonly rotationIndex = new Map<string, number>();
  /** 内存态密钥健康字典：key -> KeyHealthState */
  private readonly healthMap = new Map<string, KeyHealthState>();

  private constructor(driver?: SecureStoreDriver) {
    this.secureDriver = driver ?? expoSecureStoreDriver();
  }

  /**
   * 获取单例实例；可按需注入/替换 SecureStoreDriver（尤其在测试环境下）
   */
  public static getInstance(driver?: SecureStoreDriver): WebSearchKeyManager {
    if (!this.instance) {
      this.instance = new WebSearchKeyManager(driver);
    } else if (driver) {
      this.instance.secureDriver = driver;
    }
    return this.instance;
  }

  /** 注入或切换安全存储驱动 */
  public setDriver(driver: SecureStoreDriver): void {
    this.secureDriver = driver;
  }

  /**
   * 从 SecureStore 加载并解析服务商的有效 Keys（支持逗号或换行分隔输入）
   */
  public async getAvailableKeys(providerId: string): Promise<string[]> {
    const raw = await this.secureDriver.getItem(
      webSearchKeySlotFor(providerId)
    );
    if (!raw) return [];
    return raw
      .split(/[\n,]/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0);
  }

  /**
   * 保存或更新某服务商的 Keys（支持传入数组或包含逗号/换行的长文本，安全落入 SecureStore）
   * 自动进行 trim、去重与非空过滤；若清空则自动从 SecureStore 移除槽位
   */
  public async saveKeys(
    providerId: string,
    keys: string[] | string
  ): Promise<void> {
    const rawList = Array.isArray(keys) ? keys : keys.split(/[\n,]/);
    const cleaned = Array.from(
      new Set(rawList.map((k) => k.trim()).filter((k) => k.length > 0))
    );
    const slot = webSearchKeySlotFor(providerId);

    if (cleaned.length === 0) {
      await this.secureDriver.deleteItem(slot);
      this.rotationIndex.delete(providerId);
    } else {
      await this.secureDriver.setItem(slot, cleaned.join('\n'));
    }
  }

  /**
   * 获取下一个可用的 API Key（支持 Round-Robin 轮询与 429/401 故障自愈隔离）
   */
  public async getKey(providerId: string): Promise<string | null> {
    return this.resolveNextKey(providerId);
  }

  /**
   * 获取下一个可用的 API Key（对齐方案文档 §5.3 方法名）
   */
  public async resolveNextKey(providerId: string): Promise<string | null> {
    const keys = await this.getAvailableKeys(providerId);
    if (keys.length === 0) return null;
    if (keys.length === 1) {
      // 只有一个 key 时直接返回
      return keys[0] ?? null;
    }

    const now = Date.now();
    // 过滤掉当前处于冷却中的 Key
    const candidates = keys.filter((k) => {
      const health = this.healthMap.get(k);
      return !health?.coolDownUntilMs || health.coolDownUntilMs <= now;
    });

    // 全部冷却时兜底回退全量 keys，防止死锁无 Key 可用
    const activePool = candidates.length > 0 ? candidates : keys;
    const lastIndex = this.rotationIndex.get(providerId) ?? -1;
    const nextIndex = (lastIndex + 1) % activePool.length;
    const chosenKey = activePool[nextIndex] ?? null;

    this.rotationIndex.set(providerId, nextIndex);
    return chosenKey;
  }

  /**
   * 标记 Key 执行失败并启动隔离冷却
   * @param providerId 服务商标识
   * @param key 出错的密钥
   * @param reason 失败原因或状态码（如 '429', '401', 429, 401 等）
   */
  public reportKeyFailure(
    _providerId: string,
    key: string,
    reason: '429' | '401' | string | number
  ): void {
    this.markKeyFailure(key, reason);
  }

  /**
   * 标记 Key 执行失败（对齐方案文档 §5.3 方法名）
   */
  public markKeyFailure(
    key: string,
    statusCodeOrReason?: number | string
  ): void {
    const state = this.healthMap.get(key) ?? { key, failedCount: 0 };
    state.failedCount += 1;
    state.lastFailedStatus = statusCodeOrReason;
    state.lastErrorReason = String(statusCodeOrReason ?? '');

    let coolDownMs: number = KEY_COOL_DOWN_DURATIONS.DEFAULT_ERROR;
    const statusStr = String(statusCodeOrReason ?? '');
    if (statusStr.includes('429')) {
      coolDownMs = KEY_COOL_DOWN_DURATIONS.RATE_LIMITED_429;
    } else if (statusStr.includes('401')) {
      coolDownMs = KEY_COOL_DOWN_DURATIONS.UNAUTHORIZED_401;
    }

    state.coolDownUntilMs = Date.now() + coolDownMs;
    this.healthMap.set(key, state);
  }

  /**
   * 标记 Key 执行成功，清除健康故障记录（自愈）
   */
  public reportKeySuccess(_providerId: string, key: string): void {
    this.markKeySuccess(key);
  }

  /**
   * 标记 Key 执行成功（对齐方案文档 §5.3 方法名）
   */
  public markKeySuccess(key: string): void {
    this.healthMap.delete(key);
  }

  /**
   * 查询指定 Key 当前是否正处于隔离冷却中
   */
  public isKeyInCoolDown(key: string, now: number = Date.now()): boolean {
    const health = this.healthMap.get(key);
    if (!health?.coolDownUntilMs) return false;
    return health.coolDownUntilMs > now;
  }

  /**
   * 获取指定 Key 的健康状况
   */
  public getKeyHealth(key: string): KeyHealthState | undefined {
    return this.healthMap.get(key);
  }

  /** 清空内存状态（登出或测试重置用） */
  public clear(): void {
    this.rotationIndex.clear();
    this.healthMap.clear();
  }

  /** 测试隔离专用重置 */
  public resetForTest(): void {
    this.clear();
  }
}

/** 默认导出的单例 KeyManager */
export const searchKeyManager = WebSearchKeyManager.getInstance();
