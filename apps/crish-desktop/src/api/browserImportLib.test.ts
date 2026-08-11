/**
 * browserImportLib 纯逻辑测试（U6）：storage_state 预览解析 / 时间格式化 /
 * 文件名 / 可提交判定。无 React 依赖。
 */
import { describe, expect, it } from 'vitest';
import {
  BROWSER_IMPORT_MAX_BYTES,
  formatUnixSecTime,
  isUsableJsonText,
  parseStorageStatePreview,
  storageStateExportFilename,
} from './browserImportLib';

describe('parseStorageStatePreview', () => {
  it('合法 JSON：提取去重域名清单（排序）与条数，不含 value', () => {
    const json = JSON.stringify({
      cookies: [
        { name: 'a', value: 'secret', domain: '.b.com' },
        { name: 'b', value: 'x', domain: '.a.com' },
        { name: 'c', value: 'y', domain: '.b.com' },
        { name: 'd', value: 'z' },
      ],
      origins: [{ origin: 'https://a.com' }],
    });
    const preview = parseStorageStatePreview(json);
    expect(preview.cookieCount).toBe(4);
    expect(preview.domains).toEqual(['.a.com', '.b.com']);
    expect(preview.origins).toBe(1);
    expect(JSON.stringify(preview)).not.toContain('secret');
  });

  it('非法 JSON / 非对象 → 空预览（不抛出）', () => {
    expect(parseStorageStatePreview('{ not json')).toEqual({
      cookieCount: 0,
      domains: [],
      origins: 0,
    });
    expect(parseStorageStatePreview('42')).toEqual({
      cookieCount: 0,
      domains: [],
      origins: 0,
    });
    expect(parseStorageStatePreview('null')).toEqual({
      cookieCount: 0,
      domains: [],
      origins: 0,
    });
  });

  it('cookies 非数组 / domain 非字符串 → 容错跳过', () => {
    const preview = parseStorageStatePreview(
      '{"cookies": {"x": 1}, "origins": "nope"}'
    );
    expect(preview.cookieCount).toBe(0);
    expect(preview.domains).toEqual([]);
    expect(preview.origins).toBe(0);
  });
});

describe('formatUnixSecTime', () => {
  it('unix 秒 → YYYY-MM-DD HH:mm 本地时间', () => {
    // 1750000000 = 2025-06-15 14:06:40 UTC（本地时区换算由 new Date 承担）
    const out = formatUnixSecTime(1750000000);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('非法值 → 原文占位（不抛出）', () => {
    expect(formatUnixSecTime(0)).toBe('0');
    expect(formatUnixSecTime(-5)).toBe('-5');
    expect(formatUnixSecTime(Number.NaN)).toBe('NaN');
    expect(formatUnixSecTime(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('storageStateExportFilename', () => {
  it('固定时间 → 含日期时间戳的 .json 文件名', () => {
    const name = storageStateExportFilename(new Date(1750000000000));
    expect(name).toMatch(/^browser-storage-state-\d{8}-\d{6}\.json$/);
  });
});

describe('isUsableJsonText', () => {
  it('trim 后非空才可提交', () => {
    expect(isUsableJsonText('  {}  ')).toBe(true);
    expect(isUsableJsonText('')).toBe(false);
    expect(isUsableJsonText('   ')).toBe(false);
  });
});

describe('BROWSER_IMPORT_MAX_BYTES', () => {
  it('上限 10MB（对齐命令面）', () => {
    expect(BROWSER_IMPORT_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
