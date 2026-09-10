import { describe, it, expect } from 'vitest';
import {
  formatBytes,
  formatTimestamp,
  parseFileStatOutput,
  parseReadFileOutput,
  parseGrepSearchOutput,
  parseListDirOutput,
  formatJsonIfApplicable,
} from '../toolOutputParser';

describe('toolOutputParser 工具输出结构化解析器测试套件', () => {
  describe('1. 格式化工具 formatBytes & formatTimestamp', () => {
    it('应正确格式化不同级别的字节数', () => {
      expect(formatBytes(0)).toBe('0 字节');
      expect(formatBytes(512)).toBe('512 字节');
      expect(formatBytes(8251)).toBe('8.1 KB (8,251 字节)');
      expect(formatBytes(1048576)).toBe('1.00 MB (1,048,576 字节)');
    });

    it('应正确格式化时间戳', () => {
      expect(formatTimestamp(0)).toBe('-');
      const str = formatTimestamp(1785676954141);
      expect(str).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('2. parseFileStatOutput 文件信息解析', () => {
    it('应成功解析 Rust file_stat 标准信封', () => {
      const raw = 'README.md: file\nsize: 8251 bytes\nmtime: 1785676954141 ms\nreadonly: false';
      const res = parseFileStatOutput(raw);
      expect(res).not.toBeNull();
      expect(res?.path).toBe('README.md');
      expect(res?.kind).toBe('file');
      expect(res?.kindZh).toBe('文件');
      expect(res?.size).toBe(8251);
      expect(res?.sizeStr).toContain('8.1 KB');
      expect(res?.readonly).toBe(false);
    });

    it('解析非匹配文本应返回 null', () => {
      expect(parseFileStatOutput('random text')).toBeNull();
      expect(parseFileStatOutput('')).toBeNull();
    });
  });

  describe('3. parseReadFileOutput 文件读取解析与信封剥除', () => {
    it('应剥除 Rust read_file 头部并保留纯净代码', () => {
      const raw = [
        'path: README.md',
        'snapshotTag: a5a3e51aa4ae',
        'encoding: utf-8',
        'lines: 125',
        'startLine: 1, endLine: 36',
        'content_truncated: true (nextContentOffset: 36, 89 lines remaining)',
        '---',
        '# Crish - 桌面 AI Agent 工作台',
        '欢迎使用 Crish',
      ].join('\n');

      const res = parseReadFileOutput(raw, 'read_file');
      expect(res).not.toBeNull();
      expect(res?.path).toBe('README.md');
      expect(res?.encoding).toBe('utf-8');
      expect(res?.totalLines).toBe(125);
      expect(res?.startLine).toBe(1);
      expect(res?.endLine).toBe(36);
      expect(res?.remainingLines).toBe(89);
      expect(res?.code).toBe('# Crish - 桌面 AI Agent 工作台\n欢迎使用 Crish');
    });

    it('应自动清洗 code 中可能混入的引擎 trailing lines remaining 截断信息', () => {
      const raw = [
        'path: README.md',
        '---',
        'line 1',
        'line 2',
        '... 93 lines remaining, use contentOffset to continue ...',
      ].join('\n');

      const res = parseReadFileOutput(raw, 'read_file');
      expect(res?.code).toBe('line 1\nline 2');
      expect(res?.remainingLines).toBe(93);
    });
  });

  describe('4. parseGrepSearchOutput 检索结果解析', () => {
    it('应成功解析无匹配空态', () => {
      const res = parseGrepSearchOutput('(no matches)', 'grep_search');
      expect(res).not.toBeNull();
      expect(res?.isEmpty).toBe(true);
      expect(res?.matches).toHaveLength(0);
    });

    it('应剥除 query/root 头部并将匹配项解析为行记录', () => {
      const raw = [
        'query: test',
        'root: .',
        'matches: 2',
        'visitedFiles: 10',
        '---',
        'src/App.tsx:15:3: const test = true;',
        'src/index.ts:42: import { test } from "./App";',
      ].join('\n');

      const res = parseGrepSearchOutput(raw, 'grep_search');
      expect(res).not.toBeNull();
      expect(res?.query).toBe('test');
      expect(res?.matchCount).toBe(2);
      expect(res?.visitedFiles).toBe(10);
      expect(res?.matches).toHaveLength(2);
      expect(res?.matches[0]).toEqual({
        filePath: 'src/App.tsx',
        line: 15,
        column: 3,
        text: 'const test = true;',
      });
      expect(res?.matches[1]).toEqual({
        filePath: 'src/index.ts',
        line: 42,
        column: undefined,
        text: 'import { test } from "./App";',
      });
    });
  });

  describe('5. parseListDirOutput 目录列表解析', () => {
    it('应成功解析空目录', () => {
      const res = parseListDirOutput('(empty directory)', 'list_dir');
      expect(res).not.toBeNull();
      expect(res?.isEmpty).toBe(true);
    });

    it('应解析目录与文件条目', () => {
      const raw = '/src\n/docs\n package.json\n README.md';
      const res = parseListDirOutput(raw, 'list_dir');
      expect(res).not.toBeNull();
      expect(res?.items).toHaveLength(4);
      expect(res?.items[0]).toEqual({ name: 'src', isDir: true });
      expect(res?.items[2]).toEqual({ name: 'package.json', isDir: false });
    });
  });

  describe('6. formatJsonIfApplicable JSON 格式化', () => {
    it('应将单行压缩 JSON 格式化为多行缩进文本', () => {
      const singleLine = '{"json":{"ok":true,"tabs":[{"tabId":1,"title":"Home"}]}}';
      const formatted = formatJsonIfApplicable(singleLine);
      expect(formatted).toContain('  "json": {');
      expect(formatted).toContain('    "ok": true,');
      expect(formatted).toContain('      "tabId": 1');
    });

    it('非 JSON 纯文本应保持原样', () => {
      const text = 'Compilation completed with 0 errors.';
      expect(formatJsonIfApplicable(text)).toBe(text);
    });
  });
});
