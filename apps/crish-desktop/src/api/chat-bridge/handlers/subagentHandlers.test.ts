/**
 * subagent 域三 handler 行为测试（I5-M7：C8 事件契约信封对齐）。
 *
 * Rust 契约（crates/conex-types/src/events.rs + contracts/engine-events.json）：
 * - subagent-started：subagentId/subagentRunId/role/capabilityMode/startedAt
 *   （必填）+ description/mode/parentToolCallId（可选）；runId 由信封注入 = 父 run；
 * - subagent-event：event 为结构化负载 { kind: progress/message/tool, payload? }，
 *   handler 整体透传；
 * - subagent-ended：status 规范值 completed/failed/cancelled（前端正则映射
 *   stopped/failed/completed）+ summary（可选）/endedAt。
 */
import { describe, expect, it } from 'vitest';
import { onSubagentEnded, onSubagentEvent, onSubagentStarted } from './subagentHandlers';
import type { LegacyEnvelope } from './eventParser';
import type { HandlerEnv } from './handlerEnv';

const env = { runId: 'run-parent' } as HandlerEnv;

function legacy(type: string, raw: Record<string, unknown>): LegacyEnvelope {
  return { kind: 'legacy', type: type as LegacyEnvelope['type'], raw };
}

describe('onSubagentStarted（I5-M7 信封对齐：Rust 契约字段逐一消费）', () => {
  it('完整信封：subagentId/subagentRunId/parentRunId/parentToolCallId/description/mode 透传', () => {
    let captured: unknown;
    onSubagentStarted(
      {
        ...env,
        callbacks: {
          onSubagentStarted: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-started', {
        type: 'subagent-started',
        runId: 'run-parent',
        sessionId: 's1',
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        role: 'researcher',
        capabilityMode: 'readonly',
        startedAt: '2026-08-03T08:00:00.000Z',
        description: '调研子代理',
        mode: 'research',
        parentToolCallId: 'tc-9',
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      parentRunId: 'run-parent',
      parentToolCallId: 'tc-9',
      description: '调研子代理',
      mode: 'research',
    });
  });

  it('缺省兜底：runId 缺省取 env.runId、description/mode 兜底、parentToolCallId 缺省 undefined', () => {
    let captured: unknown;
    onSubagentStarted(
      {
        ...env,
        callbacks: {
          onSubagentStarted: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-started', {
        type: 'subagent-started',
        subagentId: 'sa-2',
        subagentRunId: 'sr-2',
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-2',
      subagentRunId: 'sr-2',
      parentRunId: 'run-parent',
      parentToolCallId: undefined,
      description: '协作 agent',
      mode: 'research',
    });
  });
});

describe('onSubagentEvent（I5-M7：event 结构化负载整体透传）', () => {
  it('progress 类事件：event 对象原样透传（kind + payload）', () => {
    let captured: unknown;
    onSubagentEvent(
      {
        ...env,
        callbacks: {
          onSubagentEvent: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-event', {
        type: 'subagent-event',
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        event: { kind: 'progress', payload: { percent: 40, step: 'reading' } },
      })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: 'sr-1',
      event: { kind: 'progress', payload: { percent: 40, step: 'reading' } },
    });
  });

  it('缺省 event / 非对象 event 兜底为空对象（不抛错）', () => {
    let captured: unknown;
    const cb = (info: unknown) => {
      captured = info;
    };
    onSubagentEvent(
      { ...env, callbacks: { onSubagentEvent: cb } } as unknown as HandlerEnv,
      legacy('subagent-event', { type: 'subagent-event', subagentId: 'sa-1' })
    );
    expect(captured).toEqual({ subagentId: 'sa-1', subagentRunId: '', event: {} });
  });
});

describe('onSubagentEnded（I5-M7：status 正则映射 + summary/endedAt 透传）', () => {
  it('Rust 规范值映射：completed→completed、failed→failed、cancelled→stopped', () => {
    const cases: Array<[string, 'completed' | 'failed' | 'stopped']> = [
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'stopped'],
    ];
    for (const [wire, expected] of cases) {
      let captured: unknown;
      onSubagentEnded(
        {
          ...env,
          callbacks: {
            onSubagentEnded: (info: unknown) => {
              captured = info;
            },
          },
        } as unknown as HandlerEnv,
        legacy('subagent-ended', {
          type: 'subagent-ended',
          subagentId: 'sa-1',
          subagentRunId: 'sr-1',
          status: wire,
          summary: '收尾摘要',
          endedAt: '2026-08-03T08:00:00.000Z',
        })
      );
      expect(captured).toEqual({
        subagentId: 'sa-1',
        subagentRunId: 'sr-1',
        status: expected,
        summary: '收尾摘要',
      });
    }
  });

  it('兼容宽松值：aborted/stopped 正则映射 stopped、error 映射 failed、stop 单字不命中', () => {
    // 前端解析器正则 /cancel|stopp?ed|abort/i（subagentHandlers.ts:52）：
    // stopped 需带 ed 后缀才命中，Rust 规范值 cancelled 走 cancel 分支
    const cases: Array<[string, 'completed' | 'failed' | 'stopped']> = [
      ['aborted', 'stopped'],
      ['stopped', 'stopped'],
      ['stop', 'completed'],
      ['error', 'failed'],
    ];
    for (const [wire, expected] of cases) {
      let captured: unknown;
      onSubagentEnded(
        {
          ...env,
          callbacks: {
            onSubagentEnded: (info: unknown) => {
              captured = info;
            },
          },
        } as unknown as HandlerEnv,
        legacy('subagent-ended', {
          type: 'subagent-ended',
          subagentId: 'sa-1',
          subagentRunId: 'sr-1',
          status: wire,
        })
      );
      expect(captured).toMatchObject({ status: expected });
    }
  });

  it('缺省 summary 兜底 undefined、未知 status 兜底 completed', () => {
    let captured: unknown;
    onSubagentEnded(
      {
        ...env,
        callbacks: {
          onSubagentEnded: (info: unknown) => {
            captured = info;
          },
        },
      } as unknown as HandlerEnv,
      legacy('subagent-ended', { type: 'subagent-ended', subagentId: 'sa-1', status: 'weird' })
    );
    expect(captured).toEqual({
      subagentId: 'sa-1',
      subagentRunId: '',
      status: 'completed',
      summary: undefined,
    });
  });
});
