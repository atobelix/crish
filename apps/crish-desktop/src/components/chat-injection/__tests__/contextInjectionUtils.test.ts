// @vitest-environment jsdom
/**
 * contextInjectionUtils.test.ts —— 纯逻辑工具库单测
 * 覆盖 9 类图标、中文文案、语义色调、Token 格式化、路径规整与超大文件截断保护。
 */
import { describe, expect, it } from 'vitest';
import type { ContextInjectionKind } from '../../../store/types';
import {
  formatLineInfo,
  formatTokenCount,
  getInjectionIcon,
  getInjectionKindLabel,
  getInjectionStatusLabel,
  getInjectionToneClass,
  getTruncatedContent,
  normalizeTargetPath,
  sanitizeInjectionTitle,
} from '../contextInjectionUtils';

describe('contextInjectionUtils 纯逻辑验证', () => {
  const allKinds: ContextInjectionKind[] = [
    'rule',
    'skill',
    'file_context',
    'git_status',
    'terminal_output',
    'runtime_steering',
    'schedule_trigger',
    'memory',
    'workspace_env',
  ];

  it('断言 1.1: 传入全部 9 种 ContextInjectionKind，getInjectionIcon 返回合法 React 组件', () => {
    for (const kind of allKinds) {
      const Icon = getInjectionIcon(kind);
      expect(Icon).toBeDefined();
      expect(typeof Icon).toBe('object'); // Lucide components are React ForwardRef objects/functions
    }
    // 兜底未知类型
    const fallback = getInjectionIcon('unknown' as ContextInjectionKind);
    expect(fallback).toBeDefined();
  });

  it('断言 1.2: 传入全部 9 种 ContextInjectionKind，getInjectionKindLabel 返回对应规范文案', () => {
    const expectedLabels: Record<ContextInjectionKind, string> = {
      rule: '规则注入',
      skill: '技能上下文',
      file_context: '文件上下文',
      git_status: 'Git 状态',
      terminal_output: '终端上下文',
      runtime_steering: '运行时纠偏',
      schedule_trigger: '定时唤醒',
      memory: '会话记忆',
      workspace_env: '工作区环境',
    };

    for (const kind of allKinds) {
      expect(getInjectionKindLabel(kind)).toBe(expectedLabels[kind]);
    }
    expect(getInjectionKindLabel('unknown' as ContextInjectionKind)).toBe('系统注入');
  });

  it('断言 1.3: 验证 getInjectionStatusLabel 状态文案', () => {
    expect(getInjectionStatusLabel('pending')).toBe('准备中');
    expect(getInjectionStatusLabel('injected')).toBe('已注入');
    expect(getInjectionStatusLabel('active')).toBe('持续生效');
    expect(getInjectionStatusLabel('expired')).toBe('已过期');
    expect(getInjectionStatusLabel('failed')).toBe('注入失败');
    expect(getInjectionStatusLabel('other' as any)).toBe('未知状态');
  });

  it('断言 1.4: 传入全部 9 种 ContextInjectionKind，getInjectionToneClass 映射正确的 CSS Module 类名', () => {
    const mockStyles: Record<string, string> = {
      toneRule: 'mock_tone_rule',
      toneSkill: 'mock_tone_skill',
      toneFile: 'mock_tone_file',
      toneGit: 'mock_tone_git',
      toneTerminal: 'mock_tone_terminal',
      toneSteering: 'mock_tone_steering',
      toneSchedule: 'mock_tone_schedule',
      toneMemory: 'mock_tone_memory',
      toneWorkspace: 'mock_tone_workspace',
      toneDefault: 'mock_tone_default',
    };

    expect(getInjectionToneClass('rule', mockStyles)).toBe('mock_tone_rule');
    expect(getInjectionToneClass('skill', mockStyles)).toBe('mock_tone_skill');
    expect(getInjectionToneClass('file_context', mockStyles)).toBe('mock_tone_file');
    expect(getInjectionToneClass('git_status', mockStyles)).toBe('mock_tone_git');
    expect(getInjectionToneClass('terminal_output', mockStyles)).toBe('mock_tone_terminal');
    expect(getInjectionToneClass('runtime_steering', mockStyles)).toBe('mock_tone_steering');
    expect(getInjectionToneClass('schedule_trigger', mockStyles)).toBe('mock_tone_schedule');
    expect(getInjectionToneClass('memory', mockStyles)).toBe('mock_tone_memory');
    expect(getInjectionToneClass('workspace_env', mockStyles)).toBe('mock_tone_workspace');
    expect(getInjectionToneClass('unknown' as any, mockStyles)).toBe('mock_tone_default');
  });

  it('断言 1.5: formatTokenCount 边界与格式化', () => {
    expect(formatTokenCount(0)).toBe('0 t');
    expect(formatTokenCount(999)).toBe('999 t');
    expect(formatTokenCount(1000)).toBe('1.0k t');
    expect(formatTokenCount(1560)).toBe('1.6k t');
    expect(formatTokenCount(25000)).toBe('25.0k t');
    expect(formatTokenCount(NaN)).toBe('');
    expect(formatTokenCount(Infinity)).toBe('');
    expect(formatTokenCount(-10)).toBe('');
    expect(formatTokenCount('abc' as any)).toBe('');
  });

  it('断言 1.6: sanitizeInjectionTitle 控制字符过滤', () => {
    expect(sanitizeInjectionTitle('Hello\nWorld\t!')).toBe('Hello World !');
    expect(sanitizeInjectionTitle('  Line \u0000 1   ')).toBe('Line 1');
  });

  it('断言 1.7: normalizeTargetPath 支持带行号、URI 转义与相对路径规整', () => {
    expect(normalizeTargetPath('src/a.ts')).toBe('src/a.ts');
    expect(normalizeTargetPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeTargetPath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizeTargetPath('src%20test/app.ts')).toBe('src test/app.ts');
    expect(normalizeTargetPath('file:///C:/project/src/a.ts')).toBe('C:/project/src/a.ts');
    expect(normalizeTargetPath('src/a.ts:42')).toBe('src/a.ts:42');
    expect(normalizeTargetPath('src/a.ts', 'L12-L45')).toBe('src/a.ts:12-45');
    expect(normalizeTargetPath('src/a.ts', '50')).toBe('src/a.ts:50');
    expect(normalizeTargetPath('src/a.ts:10', '20')).toBe('src/a.ts:10'); // 已有行号时不重复追加
  });

  it('断言 1.8: formatLineInfo 格式化选区和行数', () => {
    expect(formatLineInfo('L12-L45')).toBe('L12-L45');
    expect(formatLineInfo('12-45')).toBe('L12-45');
    expect(formatLineInfo(undefined, 100)).toBe('100 行');
    expect(formatLineInfo(undefined, 0)).toBeUndefined();
    expect(formatLineInfo(undefined, undefined)).toBeUndefined();
  });

  it('断言 1.9: getTruncatedContent 超大正文分段截断保护', () => {
    // 1. 普通短文本：不截断
    const shortText = 'const x = 1;\nconst y = 2;';
    const resShort = getTruncatedContent(shortText);
    expect(resShort.isTruncated).toBe(false);
    expect(resShort.displayText).toBe(shortText);
    expect(resShort.totalLines).toBe(2);

    // 2. 超大文本 (>1000 行)：分段截断为 1000 行
    const longLines = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`);
    const longText = longLines.join('\n');
    const resLong = getTruncatedContent(longText, 1000);
    expect(resLong.isTruncated).toBe(true);
    expect(resLong.totalLines).toBe(1200);
    expect(resLong.shownLines).toBe(1000);
    expect(resLong.displayText.split('\n')).toHaveLength(1000);

    // 3. 代码栅格修复：如果截断处处于未闭合代码块内部，自动补全闭合栅格
    const codeBlockLines = ['```typescript', ...Array.from({ length: 1100 }, (_, i) => `  const item${i} = ${i};`), '```'];
    const codeText = codeBlockLines.join('\n');
    const resCode = getTruncatedContent(codeText, 1000);
    expect(resCode.isTruncated).toBe(true);
    // 必须闭合代码块
    const backtickMatches = resCode.displayText.match(/```/g);
    expect(backtickMatches).not.toBeNull();
    expect(backtickMatches!.length % 2).toBe(0);
  });
});
