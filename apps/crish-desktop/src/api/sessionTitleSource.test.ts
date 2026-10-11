import { describe, expect, it } from 'vitest';
import {
  effectiveTitleSource,
  firstTitleSentence,
  isTrivialTitleSource,
  parseSessionTitleSource,
  pickAutoTitle,
  pickAutoTitleText,
} from './sessionTitleSource';

describe('titleSource migration', () => {
  it('缺字段按 auto，非法值丢弃', () => {
    expect(effectiveTitleSource(undefined)).toBe('auto');
    expect(effectiveTitleSource(null)).toBe('auto');
    expect(effectiveTitleSource('auto')).toBe('auto');
    expect(effectiveTitleSource('auto-trivial')).toBe('auto-trivial');
    expect(effectiveTitleSource('user')).toBe('user');
    expect(parseSessionTitleSource(undefined)).toBeUndefined();
    expect(parseSessionTitleSource('manual')).toBeUndefined();
    expect(parseSessionTitleSource('user')).toBe('user');
  });
});

describe('isTrivialTitleSource', () => {
  it('整句等于平凡问候才算平凡', () => {
    for (const text of ['你好', '你好啊', 'hi', 'Hi', 'HELLO', '在吗', 'test', 'Test']) {
      expect(isTrivialTitleSource(text)).toBe(true);
    }
    expect(isTrivialTitleSource('你好。')).toBe(true);
    expect(isTrivialTitleSource('  Hello! ')).toBe(true);
    expect(isTrivialTitleSource('「你好」')).toBe(true);
  });

  it('更长的句子或平凡句后还有正文时不算平凡', () => {
    expect(isTrivialTitleSource('')).toBe(false);
    expect(isTrivialTitleSource('hello world')).toBe(false);
    expect(isTrivialTitleSource('你好，帮我看登录')).toBe(false);
    expect(isTrivialTitleSource('你好啊，在吗')).toBe(false);
    expect(isTrivialTitleSource('你好。请帮我看代码')).toBe(false);
    expect(isTrivialTitleSource('testing')).toBe(false);
    expect(isTrivialTitleSource('在吗？看下这个报错')).toBe(false);
  });
});

describe('pickAutoTitle', () => {
  it('跳到下一条有信息量的用户消息', () => {
    expect(
      pickAutoTitle([
        { sender: 'user', text: '你好' },
        { sender: 'user', text: '帮我看登录' },
      ])
    ).toEqual({ text: '帮我看登录', origin: 'auto' });
  });

  it('没有更好的用户消息时用助手首句', () => {
    expect(
      pickAutoTitle([
        { sender: 'user', text: '在吗' },
        { sender: 'assistant', text: '登录接口返回 500。请重试' },
      ])
    ).toEqual({ text: '登录接口返回 500', origin: 'auto' });
  });

  it('只有平凡原文时保留它', () => {
    expect(pickAutoTitle([{ sender: 'user', text: 'hi' }])).toEqual({
      text: 'hi',
      origin: 'auto-trivial',
    });
    expect(pickAutoTitleText([{ sender: 'user', text: '你好啊' }])).toBe('你好啊');
  });

  it('纯 slash 命令跳过，不挡住后面的正文', () => {
    expect(
      pickAutoTitle([
        { sender: 'user', text: '/help' },
        { sender: 'user', text: '帮我看登录' },
      ])
    ).toEqual({ text: '帮我看登录', origin: 'auto' });
    expect(pickAutoTitle([{ sender: 'user', text: '/help' }])).toBeNull();
    expect(pickAutoTitle([])).toBeNull();
    expect(pickAutoTitle(undefined)).toBeNull();
  });

  it('助手只取首句；首句平凡则标记 auto-trivial', () => {
    expect(
      pickAutoTitle([
        { sender: 'user', text: 'test' },
        { sender: 'assistant', text: 'Hello! 后面还有字' },
      ])
    ).toEqual({ text: 'Hello', origin: 'auto-trivial' });
    expect(
      pickAutoTitle([
        { sender: 'user', text: 'test' },
        { sender: 'assistant', text: 'Hello!' },
      ])
    ).toEqual({ text: 'Hello', origin: 'auto-trivial' });
  });

  it('firstTitleSentence 在句号、问号、换行处切开', () => {
    expect(firstTitleSentence('第一句。第二句')).toBe('第一句');
    expect(firstTitleSentence('第一句？第二句')).toBe('第一句');
    expect(firstTitleSentence('第一句\n第二句')).toBe('第一句');
    expect(firstTitleSentence('  ')).toBe('');
  });
});
