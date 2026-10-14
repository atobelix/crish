import { describe, it, expect, beforeEach } from 'vitest';
import {
  SafeIntl,
  formatNumber,
  formatDate,
  formatRelativeTime,
  formatList,
  BoundedFormatterCache,
} from '../SafeIntl';

describe('SafeIntl 高级格式化工具链测试套件', () => {
  beforeEach(() => {
    SafeIntl.clearCaches();
  });

  describe('1. BoundedFormatterCache 缓存与 LRU 淘汰机制', () => {
    it('基本存取与容量感知正常', () => {
      const cache = new BoundedFormatterCache<string>(5);
      expect(cache.size()).toBe(0);
      expect(cache.getCapacity()).toBe(5);

      cache.set('a', 'alpha');
      cache.set('b', 'beta');
      expect(cache.size()).toBe(2);
      expect(cache.get('a')).toBe('alpha');
      expect(cache.get('b')).toBe('beta');
      expect(cache.get('c')).toBeUndefined();
    });

    it('超出容量上限时严格淘汰最久未访问的项 (LRU)', () => {
      const cache = new BoundedFormatterCache<number>(3);
      cache.set('k1', 1);
      cache.set('k2', 2);
      cache.set('k3', 3);
      expect(cache.size()).toBe(3);

      // 访问 k1，使 k1 成为最近使用的项，最久未使用的变为 k2
      cache.get('k1');

      // 写入 k4，应淘汰 k2
      cache.set('k4', 4);
      expect(cache.size()).toBe(3);
      expect(cache.has('k2')).toBe(false);
      expect(cache.get('k1')).toBe(1);
      expect(cache.get('k3')).toBe(3);
      expect(cache.get('k4')).toBe(4);
    });

    it('连续写入 150 个不同项，容量稳定锁定在 128 上限以内', () => {
      const cache = new BoundedFormatterCache<number>(128);
      for (let i = 0; i < 150; i++) {
        cache.set(`key_${i}`, i);
      }
      expect(cache.size()).toBe(128);
      // 前 22 个键已被依序淘汰
      expect(cache.has('key_0')).toBe(false);
      expect(cache.has('key_21')).toBe(false);
      expect(cache.has('key_22')).toBe(true);
      expect(cache.has('key_149')).toBe(true);
    });
  });

  describe('2. 数字格式化 (formatNumber)', () => {
    it('支持标准数字、千分位及多语言 locale', () => {
      const formattedZh = formatNumber(
        1234567.89,
        { minimumFractionDigits: 2 },
        'zh-CN'
      );
      expect(formattedZh).toContain('1,234,567.89');

      const formattedEn = formatNumber(
        1234567.89,
        { minimumFractionDigits: 2 },
        'en-US'
      );
      expect(formattedEn).toContain('1,234,567.89');
    });

    it('支持货币与百分比格式化', () => {
      const currency = formatNumber(
        99.5,
        { style: 'currency', currency: 'USD' },
        'en-US'
      );
      expect(currency).toContain('$99.50');

      const percent = formatNumber(
        0.856,
        { style: 'percent', maximumFractionDigits: 1 },
        'en-US'
      );
      expect(percent).toContain('85.6%');
    });

    it('极端异常数值安全容灾：NaN、Infinity、极端非法选项不崩溃', () => {
      expect(formatNumber(NaN)).toBe('NaN');
      expect(formatNumber(Infinity)).toMatch(/∞|Infinity/);
      expect(formatNumber(-Infinity)).toMatch(/-∞|-Infinity/);

      // 传入非法的格式化 options（如 minimumFractionDigits 超出标准 21）
      expect(() => {
        const res = formatNumber(42, { minimumFractionDigits: 999 } as any);
        expect(typeof res).toBe('string');
      }).not.toThrow();
    });

    it('传入畸形 locale 时平滑降级，绝不抛出 RangeError', () => {
      expect(() => {
        const res = formatNumber(1000, undefined, 'invalid-locale-XYZ-999');
        expect(res).toContain('1,000');
      }).not.toThrow();
    });
  });

  describe('3. 日期时间格式化 (formatDate)', () => {
    const fixedTimestamp = 1776144000000; // 2026-04-14 UTC
    const fixedDate = new Date(fixedTimestamp);

    it('正确格式化 Date 对象、时间戳与 ISO 字符串', () => {
      const resDate = formatDate(
        fixedDate,
        { year: 'numeric', month: 'numeric' },
        'zh-CN'
      );
      expect(resDate).toContain('2026');

      const resTs = formatDate(fixedTimestamp, { year: 'numeric' }, 'en-US');
      expect(resTs).toContain('2026');

      const resIso = formatDate(
        '2026-04-14T00:00:00Z',
        { year: 'numeric' },
        'en-US'
      );
      expect(resIso).toContain('2026');
    });

    it('遇到非法日期输入时平滑返回 "-"，不抛出异常', () => {
      expect(formatDate('invalid-date-string')).toBe('-');
      expect(formatDate(NaN)).toBe('-');
      expect(formatDate(null as any)).toBe('-');
      expect(formatDate(undefined as any)).toBe('-');
    });

    it('传入非法 locale 或极端 options 时平滑降级，绝不白屏', () => {
      expect(() => {
        const res = formatDate(fixedDate, undefined, 'invalid-locale-XYZ');
        expect(typeof res).toBe('string');
        expect(res.length).toBeGreaterThan(0);
      }).not.toThrow();

      expect(() => {
        const res = formatDate(fixedDate, {
          timeZone: 'Invalid/Non_Existent_Zone',
        } as any);
        expect(typeof res).toBe('string');
      }).not.toThrow();
    });
  });

  describe('4. 相对时间格式化 (formatRelativeTime)', () => {
    it('支持过去与未来的相对时间格式化', () => {
      const pastEn = formatRelativeTime(-1, 'day', undefined, 'en-US');
      expect(pastEn).toMatch(/1 day ago|yesterday/i);

      const futureEn = formatRelativeTime(2, 'hour', undefined, 'en-US');
      expect(futureEn).toMatch(/in 2 hours/i);

      const pastZh = formatRelativeTime(-1, 'day', undefined, 'zh-CN');
      expect(pastZh).toMatch(/1天前|昨天/);
    });

    it('当前时刻 (0) 格式化正常', () => {
      const res = formatRelativeTime(0, 'second', undefined, 'en-US');
      expect(res).toBeDefined();
    });

    it('传入非法 locale 时平滑降级，不抛出异常', () => {
      expect(() => {
        const res = formatRelativeTime(
          -5,
          'minute',
          undefined,
          'invalid-locale-ABC'
        );
        expect(typeof res).toBe('string');
      }).not.toThrow();
    });
  });

  describe('5. 列表格式化 (formatList)', () => {
    it('正确格式化多项列表为本地化连词格式', () => {
      const listZh = formatList(
        ['项目A', '项目B', '项目C'],
        undefined,
        'zh-CN'
      );
      expect(listZh).toMatch(/项目A[、, ]+项目B/);

      const listEn = formatList(
        ['Apple', 'Banana', 'Orange'],
        undefined,
        'en-US'
      );
      expect(listEn).toMatch(/Apple, Banana,( and)? Orange/);
    });

    it('单项或空列表格式化正常', () => {
      expect(formatList(['Single'])).toBe('Single');
      expect(formatList([])).toBe('');
    });

    it('传入非法 locale 或格式化失败时安全回退为逗号连接', () => {
      expect(() => {
        const res = formatList(['One', 'Two'], undefined, 'invalid-locale-XYZ');
        expect(res).toContain('One');
        expect(res).toContain('Two');
      }).not.toThrow();
    });
  });

  describe('6. 整体格式化缓存池上限联动验证', () => {
    it('SafeIntl 内部格式化器数量严格受控于 128 上限以内', () => {
      // 连续调用 150 次不同 options 的 formatNumber
      for (let i = 0; i < 150; i++) {
        formatNumber(100, { minimumIntegerDigits: (i % 10) + 1 }, `zh-CN-${i}`);
      }
      expect(SafeIntl.getNumberCacheSize()).toBeLessThanOrEqual(128);

      // 连续调用 150 次不同 options 的 formatDate
      for (let i = 0; i < 150; i++) {
        formatDate(new Date(), { hour12: i % 2 === 0 }, `en-US-${i}`);
      }
      expect(SafeIntl.getDateCacheSize()).toBeLessThanOrEqual(128);

      // 清理缓存后归零
      SafeIntl.clearCaches();
      expect(SafeIntl.getNumberCacheSize()).toBe(0);
      expect(SafeIntl.getDateCacheSize()).toBe(0);
    });
  });
});
