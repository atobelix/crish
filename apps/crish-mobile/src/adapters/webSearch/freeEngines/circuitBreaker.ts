/**
 * apps/crish-mobile/src/adapters/webSearch/freeEngines/circuitBreaker.ts
 *
 * 端侧免 Key 开放引擎反爬防污染熔断器 (Anti-Scraping Circuit Breaker)
 *
 * 核心安全红线：
 * 1. 拦截 HTTP 202, 403, 429 等反爬状态码；
 * 2. 识别 HTML 响应中的反爬/人机验证码特征指纹；
 * 3. 触发特征即记录该引擎进入熔断冷却状态（默认 15 分钟），抛出显式 AntiScrapingBlockedError；
 * 4. 【核心红线】绝对禁止将验证码页面、拦截跳转页面内容返回作为搜索结果！
 *
 * 依据文档：docs/mobile-web-search-and-sandbox/02-分维-客户端多源搜索引擎与免Key瀑布流架构方案.md §3.1, §5.5
 */

/** 默认熔断冷却时间：15 分钟 */
export const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/** 触发立即熔断的 HTTP 状态码列表 */
export const ANTI_BOT_STATUS_CODES = [202, 403, 429] as const;

/**
 * 反爬与人机验证码特征指纹黑名单库
 */
export const ANTI_BOT_FINGERPRINTS = [
  // 百度人机与安全拦截
  'wappass.baidu.com',
  'security.baidu.com',
  '百度安全验证',
  '网络不给力，请稍后重试',

  // 搜狗 / 微信验证
  'sec.sogou.com',
  'antispam',

  // Cloudflare / DDG / Google 盾与人机拦截
  'cf-chl-bypass',
  'cf-browser-verification',
  'Attention Required! | Cloudflare',
  "Please show you're not a robot",
  'Please show you&#39;re not a robot',
  'Our systems have detected unusual traffic',
  'robot_checker',
  'g-recaptcha',
  'hcaptcha.com',
  'recaptcha',
  'captcha',
  'Security Check',
  '人机验证',
  '输入验证码',
] as const;

/**
 * 反爬阻断错误类型
 */
export class AntiScrapingBlockedError extends Error {
  readonly engineId: string;
  readonly reason: string;
  readonly statusCode?: number;
  readonly cooldownUntil: number;

  constructor(
    engineId: string,
    reason: string,
    cooldownUntil: number,
    statusCode?: number
  ) {
    super(
      `[AntiScrapingBlocked] Engine '${engineId}' is blocked: ${reason}. Cooldown until ${new Date(cooldownUntil).toISOString()}`
    );
    this.name = 'AntiScrapingBlockedError';
    this.engineId = engineId;
    this.reason = reason;
    this.cooldownUntil = cooldownUntil;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 熔断记录项
 */
export interface CircuitBreakerRecord {
  engineId: string;
  blockedAt: number;
  cooldownUntil: number;
  reason: string;
  statusCode?: number;
}

/**
 * 检测 HTML 响应是否包含反爬/验证码指纹污染
 * @param html 待检测的 HTML 文本
 */
export function detectAntiBotPollution(html: string): boolean {
  if (!html || typeof html !== 'string') return false;
  // 取前 8000 个字符进行快速模式检测，保障性能
  const sample = html.slice(0, 8000).toLowerCase();

  return ANTI_BOT_FINGERPRINTS.some((fingerprint) =>
    sample.includes(fingerprint.toLowerCase())
  );
}

/**
 * 免 Key 开放引擎反爬熔断器
 */
export class FreeEngineCircuitBreaker {
  private readonly records = new Map<string, CircuitBreakerRecord>();
  private readonly defaultCooldownMs: number;

  constructor(defaultCooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.defaultCooldownMs = defaultCooldownMs;
  }

  /**
   * 检查指定引擎是否处于熔断冷却中
   */
  isBlocked(engineId: string, now: number = Date.now()): boolean {
    const record = this.records.get(engineId);
    if (!record) return false;
    if (now >= record.cooldownUntil) {
      // 冷却时间已过，自动解除熔断
      this.records.delete(engineId);
      return false;
    }
    return true;
  }

  /**
   * 获取指定引擎的剩余冷却时间（毫秒）
   */
  getCooldownRemainingMs(engineId: string, now: number = Date.now()): number {
    const record = this.records.get(engineId);
    if (!record) return 0;
    const remaining = record.cooldownUntil - now;
    return remaining > 0 ? remaining : 0;
  }

  /**
   * 记录引擎熔断状态并设置冷却期
   */
  recordBlock(
    engineId: string,
    reason: string,
    durationMs?: number,
    statusCode?: number
  ): CircuitBreakerRecord {
    const now = Date.now();
    const duration = durationMs ?? this.defaultCooldownMs;
    const cooldownUntil = now + duration;
    const record: CircuitBreakerRecord = {
      engineId,
      blockedAt: now,
      cooldownUntil,
      reason,
      statusCode,
    };
    this.records.set(engineId, record);
    return record;
  }

  /**
   * 前置断言：若引擎已在熔断中，立即抛出 AntiScrapingBlockedError，阻止后续网络发包
   */
  assertNotBlocked(engineId: string, now: number = Date.now()): void {
    if (this.isBlocked(engineId, now)) {
      const record = this.records.get(engineId)!;
      throw new AntiScrapingBlockedError(
        engineId,
        `Circuit is OPEN (cooldown remaining: ${Math.ceil(
          (record.cooldownUntil - now) / 1000
        )}s). Reason: ${record.reason}`,
        record.cooldownUntil,
        record.statusCode
      );
    }
  }

  /**
   * 响应后校验：检验 HTTP 状态码与响应体是否命中反爬/验证码特征
   * 一旦命中，立即持久化熔断冷却并抛出异常，杜绝污染搜索结果！
   */
  checkResponse(
    engineId: string,
    status: number,
    bodyHtml: string,
    cooldownMs?: number
  ): void {
    // 1. 检查特定反爬状态码 (202, 403, 429)
    if (ANTI_BOT_STATUS_CODES.includes(status as any)) {
      const reason = `Blocked by HTTP status code ${status}`;
      const record = this.recordBlock(engineId, reason, cooldownMs, status);
      throw new AntiScrapingBlockedError(
        engineId,
        reason,
        record.cooldownUntil,
        status
      );
    }

    // 2. 检查响应体中的验证码/反爬指纹
    if (detectAntiBotPollution(bodyHtml)) {
      const reason =
        'Detected anti-bot / captcha challenge fingerprint in response body';
      const record = this.recordBlock(engineId, reason, cooldownMs, status);
      throw new AntiScrapingBlockedError(
        engineId,
        reason,
        record.cooldownUntil,
        status
      );
    }
  }

  /**
   * 重置熔断状态（传入 engineId 重置单个，缺省重置全部）
   */
  reset(engineId?: string): void {
    if (engineId) {
      this.records.delete(engineId);
    } else {
      this.records.clear();
    }
  }
}

/** 全局共享的免 Key 引擎熔断器单例 */
export const circuitBreaker = new FreeEngineCircuitBreaker();
