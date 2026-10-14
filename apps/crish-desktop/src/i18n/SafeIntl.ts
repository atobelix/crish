/**
 * apps/crish-desktop/src/i18n/SafeIntl.ts
 *
 * 高级格式化工具链与安全国际化引擎（SafeIntl）。
 *
 * 核心特性：
 * 1. BoundedFormatterCache: 容量上限 128，采用 LRU 淘汰策略，杜绝高频格式化引起的内存泄漏；
 * 2. 全面 try-catch 拦截：在系统环境不支持、传入非法 locale 或 ICU RangeError 时平滑降级，严禁白屏；
 * 3. 覆盖 formatNumber, formatDate, formatRelativeTime, formatList 核心格式化能力；
 * 4. 支持单例模式与函数式直接调用。
 */

import { DEFAULT_LANGUAGE, STORAGE_KEY_LOCALE } from './types';

/**
 * 具有容量上限与 LRU 淘汰特性的格式化器缓存池。
 */
export class BoundedFormatterCache<T> {
  private readonly maxCapacity: number;
  private readonly cache = new Map<string, T>();

  constructor(maxCapacity: number = 128) {
    this.maxCapacity = Math.max(1, maxCapacity);
  }

  public get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // LRU 命中：移至末尾代表最近访问
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  public set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCapacity) {
      // 淘汰最久未访问的首个键
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  public has(key: string): boolean {
    return this.cache.has(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }

  public getCapacity(): number {
    return this.maxCapacity;
  }
}

// 模块级缓存池实例（上限严格锁定 128）
const numberCache = new BoundedFormatterCache<Intl.NumberFormat>(128);
const dateCache = new BoundedFormatterCache<Intl.DateTimeFormat>(128);
const relativeTimeCache = new BoundedFormatterCache<Intl.RelativeTimeFormat>(
  128
);
const listCache = new BoundedFormatterCache<any>(128);

/**
 * 序列化格式化选项，确保键名排序一致
 */
function serializeOptions(options?: unknown): string {
  if (!options || typeof options !== 'object') return '';
  try {
    const keys = Object.keys(options as Record<string, unknown>).sort();
    const sortedObj: Record<string, unknown> = {};
    for (const key of keys) {
      sortedObj[key] = (options as Record<string, unknown>)[key];
    }
    return JSON.stringify(sortedObj);
  } catch {
    return '';
  }
}

/**
 * 获取当前安全有效的语言代码
 */
function getSafeLocale(locale?: string): string {
  if (locale && typeof locale === 'string' && locale.trim().length > 0) {
    return locale.trim();
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY_LOCALE);
      if (stored === 'zh-CN' || stored === 'en-US') {
        return stored;
      }
    } catch {
      /* swallow-ok */
    }
  }
  return DEFAULT_LANGUAGE;
}

/**
 * 安全格式化数字
 *
 * @param value 要格式化的数字
 * @param options Intl.NumberFormat 配置项
 * @param locale 可选语言标识
 */
export function formatNumber(
  value: number,
  options?: Intl.NumberFormatOptions,
  locale?: string
): string {
  const effectiveLocale = getSafeLocale(locale);
  const cacheKey = `${effectiveLocale}:${serializeOptions(options)}`;

  try {
    let formatter = numberCache.get(cacheKey);
    if (!formatter) {
      formatter = new Intl.NumberFormat(effectiveLocale, options);
      numberCache.set(cacheKey, formatter);
    }
    return formatter.format(value);
  } catch {
    // 一级降级：使用标准英文 locale 重试
    try {
      const fallbackKey = `en-US:${serializeOptions(options)}`;
      let fallbackFormatter = numberCache.get(fallbackKey);
      if (!fallbackFormatter) {
        fallbackFormatter = new Intl.NumberFormat('en-US', options);
        numberCache.set(fallbackKey, fallbackFormatter);
      }
      return fallbackFormatter.format(value);
    } catch {
      // 二级容灾降级：原生字符串转换，绝不抛出异常
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return 'NaN';
        if (!Number.isFinite(value))
          return value > 0 ? 'Infinity' : '-Infinity';
        return value.toString();
      }
      return String(value ?? '');
    }
  }
}

/**
 * 安全格式化日期时间
 *
 * @param date 日期对象、时间戳毫秒数或 ISO 字符串
 * @param options Intl.DateTimeFormat 配置项
 * @param locale 可选语言标识
 */
export function formatDate(
  date: Date | number | string,
  options?: Intl.DateTimeFormatOptions,
  locale?: string
): string {
  const effectiveLocale = getSafeLocale(locale);
  const cacheKey = `${effectiveLocale}:${serializeOptions(options)}`;

  let d: Date;
  if (date instanceof Date) {
    d = date;
  } else if (typeof date === 'number' || typeof date === 'string') {
    d = new Date(date);
  } else {
    return '-';
  }

  if (Number.isNaN(d.getTime())) {
    return '-';
  }

  try {
    let formatter = dateCache.get(cacheKey);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat(effectiveLocale, options);
      dateCache.set(cacheKey, formatter);
    }
    return formatter.format(d);
  } catch {
    // 一级降级：使用标准英文 locale 重试
    try {
      const fallbackKey = `en-US:${serializeOptions(options)}`;
      let fallbackFormatter = dateCache.get(fallbackKey);
      if (!fallbackFormatter) {
        fallbackFormatter = new Intl.DateTimeFormat('en-US', options);
        dateCache.set(fallbackKey, fallbackFormatter);
      }
      return fallbackFormatter.format(d);
    } catch {
      // 二级容灾降级：ISO 8601 或本地时间字符串
      try {
        return d.toISOString();
      } catch {
        return d.toString() || '-';
      }
    }
  }
}

/**
 * 安全格式化相对时间
 *
 * @param value 相对数值（如 -1, 5）
 * @param unit 时间单位（如 'day', 'hour', 'minute', 'second'）
 * @param options Intl.RelativeTimeFormat 配置项
 * @param locale 可选语言标识
 */
export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  options?: Intl.RelativeTimeFormatOptions,
  locale?: string
): string {
  const effectiveLocale = getSafeLocale(locale);
  const cacheKey = `${effectiveLocale}:${unit}:${serializeOptions(options)}`;

  try {
    if (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat) {
      let formatter = relativeTimeCache.get(cacheKey);
      if (!formatter) {
        formatter = new Intl.RelativeTimeFormat(effectiveLocale, options);
        relativeTimeCache.set(cacheKey, formatter);
      }
      return formatter.format(value, unit);
    }
  } catch {
    // 一级降级：尝试使用 en-US
    try {
      const fallbackKey = `en-US:${unit}:${serializeOptions(options)}`;
      let fallbackFormatter = relativeTimeCache.get(fallbackKey);
      if (!fallbackFormatter) {
        fallbackFormatter = new Intl.RelativeTimeFormat('en-US', options);
        relativeTimeCache.set(fallbackKey, fallbackFormatter);
      }
      return fallbackFormatter.format(value, unit);
    } catch {
      /* swallow-ok */
    }
  }

  // 二级容灾降级：通用英文相对描述
  if (value === 0) return 'now';
  const abs = Math.abs(value);
  const isPast = value < 0;
  return isPast ? `${abs} ${unit} ago` : `in ${abs} ${unit}`;
}

/**
 * 安全格式化列表（如 ["A", "B", "C"] -> "A、B 和 C" 或 "A, B, and C"）
 *
 * @param list 待格式化项的可迭代集合
 * @param options Intl.ListFormat 配置项
 * @param locale 可选语言标识
 */
export function formatList(
  list: Iterable<string>,
  options?: any,
  locale?: string
): string {
  const effectiveLocale = getSafeLocale(locale);
  const cacheKey = `${effectiveLocale}:${serializeOptions(options)}`;

  const items = Array.isArray(list) ? list : Array.from(list || []);

  try {
    if (typeof Intl !== 'undefined' && (Intl as any).ListFormat) {
      let formatter = listCache.get(cacheKey);
      if (!formatter) {
        formatter = new (Intl as any).ListFormat(effectiveLocale, options);
        listCache.set(cacheKey, formatter);
      }
      return formatter.format(items);
    }
  } catch {
    // 一级降级：尝试使用 en-US
    try {
      const fallbackKey = `en-US:${serializeOptions(options)}`;
      let fallbackFormatter = listCache.get(fallbackKey);
      if (!fallbackFormatter) {
        fallbackFormatter = new (Intl as any).ListFormat('en-US', options);
        listCache.set(fallbackKey, fallbackFormatter);
      }
      return fallbackFormatter.format(items);
    } catch {
      /* swallow-ok */
    }
  }

  // 二级容灾降级：使用逗号连接
  return items.join(', ');
}

/**
 * SafeIntl 静态命名空间
 */
export class SafeIntl {
  public static formatNumber = formatNumber;
  public static formatDate = formatDate;
  public static formatRelativeTime = formatRelativeTime;
  public static formatList = formatList;

  public static getNumberCacheSize(): number {
    return numberCache.size();
  }

  public static getDateCacheSize(): number {
    return dateCache.size();
  }

  public static getRelativeTimeCacheSize(): number {
    return relativeTimeCache.size();
  }

  public static getListCacheSize(): number {
    return listCache.size();
  }

  public static clearCaches(): void {
    numberCache.clear();
    dateCache.clear();
    relativeTimeCache.clear();
    listCache.clear();
  }
}

export default SafeIntl;
