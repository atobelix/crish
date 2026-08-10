/**
 * 指示条状态机测试（P1-B2）：全表穷举 —— 4 状态 × 7 事件 = 28 条迁移，
 * 对齐 12 文档 §5.1 表与 T-12/U-9 裁决。
 */
import { describe, expect, it } from 'vitest';
import type { PanelStatus } from './browserPanelTypes';
import {
  nextPanelStatus,
  TOKEN_MIN_STABLE_WINDOW_MS,
  type PanelStatusEvent,
} from './panelStatusMachine';

const STATUSES: PanelStatus[] = ['idle', 'ai-busy', 'paused', 'user-taking-over'];
const EVENTS: PanelStatusEvent[] = [
  { type: 'AI_START' },
  { type: 'AI_END' },
  { type: 'USER_INPUT' },
  { type: 'PAUSE' },
  { type: 'RESUME' },
  { type: 'TAKEOVER_TIMEOUT' },
];

/** 期望迁移表（与 12 文档 §5.1 一致；行 = 状态，列 = 事件）。 */
const EXPECTED: Record<PanelStatus, Record<PanelStatusEvent['type'], PanelStatus>> = {
  idle: {
    AI_START: 'ai-busy',
    AI_END: 'idle',
    USER_INPUT: 'idle', // AI 空闲时用户自由操作，非接管（§5.1 表进入条件）
    PAUSE: 'idle', // 无在途动作可暂停
    RESUME: 'idle',
    TAKEOVER_TIMEOUT: 'idle',
  },
  'ai-busy': {
    AI_START: 'ai-busy',
    AI_END: 'idle', // 动作链结束
    USER_INPUT: 'user-taking-over', // 用户输入且 AI 在途 → 接管
    PAUSE: 'paused', // 用户点击暂停
    RESUME: 'ai-busy',
    TAKEOVER_TIMEOUT: 'ai-busy',
  },
  paused: {
    AI_START: 'ai-busy', // 12 §5.1：「用户点击恢复 → idle（或重新触发 AI）」
    AI_END: 'paused',
    USER_INPUT: 'paused', // 暂停期用户可操作页面（AI 队列已挂起）
    PAUSE: 'paused',
    RESUME: 'idle',
    TAKEOVER_TIMEOUT: 'paused',
  },
  'user-taking-over': {
    AI_START: 'user-taking-over', // 吊销期忽略 AI_START（U-9 稳定窗）
    AI_END: 'idle', // AI 已被吊销/结束 → 立即回 idle
    USER_INPUT: 'user-taking-over', // 保持（定时器由 hook 管理，不重启）
    PAUSE: 'paused', // 用户点击暂停
    RESUME: 'user-taking-over',
    TAKEOVER_TIMEOUT: 'idle', // T-12：800ms 过渡
  },
};

describe('指示条状态机（全表穷举）', () => {
  it('4 状态 × 7 事件 = 28 条迁移与设计表一致', () => {
    for (const status of STATUSES) {
      for (const evt of EVENTS) {
        const actual = nextPanelStatus(status, evt);
        const expected = EXPECTED[status][evt.type];
        expect(actual, `${status} + ${evt.type} 迁移`).toBe(expected);
      }
    }
  });

  it('接管过渡时长 = 维度 15 TOKEN_MIN_STABLE_WINDOW（T-12：800ms）', () => {
    expect(TOKEN_MIN_STABLE_WINDOW_MS).toBe(800);
  });

  it('主链闭环：idle → ai-busy → user-taking-over →（800ms）→ idle', () => {
    let s: PanelStatus = 'idle';
    s = nextPanelStatus(s, { type: 'AI_START' });
    expect(s).toBe('ai-busy');
    s = nextPanelStatus(s, { type: 'USER_INPUT' });
    expect(s).toBe('user-taking-over');
    s = nextPanelStatus(s, { type: 'TAKEOVER_TIMEOUT' });
    expect(s).toBe('idle');
  });

  it('暂停链闭环：ai-busy → paused →（恢复）→ idle', () => {
    let s: PanelStatus = nextPanelStatus('ai-busy', { type: 'PAUSE' });
    expect(s).toBe('paused');
    s = nextPanelStatus(s, { type: 'RESUME' });
    expect(s).toBe('idle');
  });
});
