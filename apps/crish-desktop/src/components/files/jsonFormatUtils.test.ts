import { describe, expect, it } from 'vitest';
import {
  formatJsonSafe,
  isCompactOrSingleLineJson,
  isJsonFileOrContent,
  stripJsoncComments,
} from './jsonFormatUtils';

describe('jsonFormatUtils 纯逻辑测试套件', () => {
  describe('isJsonFileOrContent', () => {
    it('应根据常见 JSON 文件名后缀正确识别', () => {
      expect(isJsonFileOrContent('report.json')).toBe(true);
      expect(isJsonFileOrContent('tsconfig.jsonc')).toBe(true);
      expect(isJsonFileOrContent('logs.jsonl')).toBe(true);
      expect(isJsonFileOrContent('data.geojson')).toBe(true);
      expect(isJsonFileOrContent('bundle.js.map')).toBe(true);
      expect(isJsonFileOrContent('network.har')).toBe(true);
      expect(isJsonFileOrContent('main.ts')).toBe(false);
      expect(isJsonFileOrContent('index.html')).toBe(false);
    });

    it('当文件无后缀或为未知类型时，根据文本内容探测 JSON 特征', () => {
      expect(isJsonFileOrContent(null, '{"key": "value"}')).toBe(true);
      expect(isJsonFileOrContent(null, '  [1, 2, 3]  ')).toBe(true);
      expect(isJsonFileOrContent(null, 'plain text string')).toBe(false);
      expect(isJsonFileOrContent(null, '')).toBe(false);
    });
  });

  describe('isCompactOrSingleLineJson', () => {
    it('正确识别单行紧凑内容', () => {
      expect(isCompactOrSingleLineJson('{"a":1,"b":2}')).toBe(true);
      expect(
        isCompactOrSingleLineJson('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}')
      ).toBe(false);
    });

    it('对空内容或常规换行内容安全回退', () => {
      expect(isCompactOrSingleLineJson('')).toBe(false);
    });
  });

  describe('formatJsonSafe', () => {
    it('成功将单行紧凑 JSON 格式化为指定缩进的多行文本', () => {
      const input = '{"name":"conex","version":"1.0.0","tags":["editor","desktop"]}';
      const res = formatJsonSafe(input, 2);
      expect(res.success).toBe(true);
      expect(res.formatted).toBe(JSON.stringify(JSON.parse(input), null, 2));
      expect(res.error).toBeUndefined();
    });

    it('针对畸形 JSON 安全返回原始文本并携带错误详情', () => {
      const invalid = '{"unclosed": "brace"';
      const res = formatJsonSafe(invalid);
      expect(res.success).toBe(false);
      expect(res.formatted).toBe(invalid);
      expect(res.error).toBeTruthy();
    });

    it('对空文本返回成功与空结果', () => {
      expect(formatJsonSafe('').success).toBe(true);
      expect(formatJsonSafe('').formatted).toBe('');
    });
  });

  describe('jsonc / jsonl 真解析', () => {
    it('stripJsoncComments 保留字符串内斜杠', () => {
      expect(stripJsoncComments('{"u":"http://x"}')).toBe('{"u":"http://x"}');
    });

    it('jsonc：剥离注释后格式化成功', () => {
      const raw = "{\n  // comment\n  \"a\": 1, /* b */\n  \"b\": 2\n}";
      const res = formatJsonSafe(raw, 2, 'tsconfig.jsonc');
      expect(res.success).toBe(true);
      expect(JSON.parse(res.formatted)).toEqual({ a: 1, b: 2 });
    });

    it('jsonl：逐行解析并保持一行一记录', () => {
      const raw = "{\"a\":1}\n{\"b\":2}\n";
      const res = formatJsonSafe(raw, 2, 'logs.jsonl');
      expect(res.success).toBe(true);
      expect(res.formatted.trim().split(/\n/)).toEqual(['{"a":1}', '{"b":2}']);
    });

    it('jsonl 坏行硬失败且不假绿', () => {
      const raw = "{\"a\":1}\n{bad}\n";
      const res = formatJsonSafe(raw, 2, 'logs.jsonl');
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/第 2 行/);
    });
  });
});