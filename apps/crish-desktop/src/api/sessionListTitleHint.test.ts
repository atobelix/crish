import { describe, expect, it } from 'vitest';
import type { SessionState } from '../store/types';
import {
  buildSectionTitleHints,
  sessionTitleDisambiguationSuffix,
} from './sessionListTitleHint';

function sess(
  partial: Partial<SessionState> & { id: string; title: string }
): SessionState {
  return {
    folder: '对话',
    isPinned: false,
    isArchived: false,
    timestamp: new Date(0).toISOString(),
    messages: [],
    ...partial,
  };
}

function at(ms: number, sender: 'user' | 'assistant', text: string) {
  return { id: `${sender}-${ms}`, sender, text, timestamp: ms };
}

describe('sessionTitleDisambiguationSuffix', () => {
  it('标题不同或只有一条时没有后缀', () => {
    const a = sess({ id: 'a', title: '登录' });
    const b = sess({ id: 'b', title: '部署' });
    expect(sessionTitleDisambiguationSuffix(a, [a, b])).toBe('');
    expect(sessionTitleDisambiguationSuffix(a, [a])).toBe('');
  });

  it('同分区同名、日期不同、助手首句也没有时不加后缀（不用日期，避免与时间列重复）', () => {
    const day1 = Date.UTC(2026, 7, 1, 4, 0, 0);
    const day2 = Date.UTC(2026, 7, 3, 4, 0, 0);
    const a = sess({
      id: 'a',
      title: '重复主题',
      messages: [at(day1, 'user', '重复主题')],
    });
    const b = sess({
      id: 'b',
      title: '重复主题',
      messages: [at(day2, 'user', '重复主题')],
    });
    const peers = [a, b];
    expect(sessionTitleDisambiguationSuffix(a, peers)).toBe('');
    expect(sessionTitleDisambiguationSuffix(b, peers)).toBe('');
  });

  it('同名时用助手首句的前几个字区分', () => {
    const ms = Date.UTC(2026, 7, 1, 4, 0, 0);
    const a = sess({
      id: 'a',
      title: '重复主题',
      messages: [
        at(ms, 'user', '重复主题'),
        at(ms + 1, 'assistant', '登录接口超时，请重试'),
      ],
    });
    const b = sess({
      id: 'b',
      title: '重复主题',
      messages: [
        at(ms, 'user', '重复主题'),
        at(ms + 1, 'assistant', '部署脚本缺环境变量'),
      ],
    });
    expect(sessionTitleDisambiguationSuffix(a, [a, b])).toBe('登录接口超时');
    expect(sessionTitleDisambiguationSuffix(b, [a, b])).toBe('部署脚本缺环');
  });

  it('助手摘要与标题重复或彼此相同时不加后缀（不退回日期）', () => {
    const ms = Date.UTC(2026, 7, 1, 4, 0, 0);
    const a = sess({
      id: 'a',
      title: '登录问题',
      messages: [at(ms, 'user', 'x'), at(ms + 1, 'assistant', '登录问题')],
    });
    const b = sess({
      id: 'b',
      title: '登录问题',
      messages: [
        at(ms, 'user', 'y'),
        at(ms + 2, 'assistant', '部署脚本缺环境变量'),
      ],
    });
    expect(sessionTitleDisambiguationSuffix(a, [a, b])).toBe('');
    expect(sessionTitleDisambiguationSuffix(b, [a, b])).toBe('部署脚本缺环');

    const c = sess({
      id: 'c',
      title: '登录问题',
      messages: [at(ms, 'user', 'z'), at(ms + 3, 'assistant', '登录')],
    });
    expect(sessionTitleDisambiguationSuffix(a, [a, c])).toBe('');
    expect(sessionTitleDisambiguationSuffix(c, [a, c])).toBe('');
  });
});

describe('buildSectionTitleHints', () => {
  it('不同分区的同名会话互不加后缀', () => {
    const pinned = sess({ id: 'p', title: '重复主题' });
    const general = sess({ id: 'g', title: '重复主题' });
    const hints = buildSectionTitleHints([[pinned], [general]]);
    expect(hints.size).toBe(0);
  });

  it('只给同一分区里的重名会话写 hint', () => {
    const day1 = Date.UTC(2026, 7, 1, 4, 0, 0);
    const a = sess({
      id: 'a',
      title: '重复主题',
      messages: [at(day1, 'user', '重复主题'), at(day1 + 1, 'assistant', '登录接口超时')],
    });
    const b = sess({
      id: 'b',
      title: '重复主题',
      messages: [at(day1, 'user', '重复主题'), at(day1 + 1, 'assistant', '部署脚本缺环境变量')],
    });
    const other = sess({ id: 'c', title: '别的' });
    const hints = buildSectionTitleHints([[a, b, other], []]);
    expect(hints.has('c')).toBe(false);
    expect(hints.get('a')).toBe('登录接口超时');
    expect(hints.get('b')).toBe('部署脚本缺环');
  });

  it('hint 永远不是日期 / 时间文案（时间只由行尾时间列显示一次）', () => {
    const base = Date.UTC(2026, 6, 20, 4, 0, 0);
    const group = Array.from({ length: 6 }, (_, i) =>
      sess({
        id: `s${i}`,
        title: '你好啊，你是什么模型',
        messages: [at(base + i * 86_400_000, 'user', '你好啊，你是什么模型')],
      })
    );
    const hints = buildSectionTitleHints([group]);
    expect(hints.size).toBe(0);
    for (const v of hints.values()) {
      expect(v).not.toMatch(/\d+月\d+日|\d+\/\d+|刚刚|\d+(分|时|天|小时|分钟)/);
    }
  });
});
