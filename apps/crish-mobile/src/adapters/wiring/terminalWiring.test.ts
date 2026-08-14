// terminalWiring 单测（R2-14 部分 3 接线层）：设备帧 → terminalStore 实时镜像
// - mapTerminalFrame（纯）：events.push 内 tool-update/task-output 文本 + runId →
//   terminal-ingest；run-terminal → terminal-run-end；缺 runId / 非终端事件 / 非
//   events.push 帧宽容跳过（MessageKind::Unknown 语义）；
// - dispatchTerminalActions（执行点）：ingestLines / resetRun 落点断言；
// - TerminalWiring 端到端（真实 WsGateway.dispatchFrame）：attach 后帧序列 →
//   terminalStore 状态（ingest / 多 run 隔离 / 收口释放 / clearAll / detach 退订）。
import type { InboundEnvelope } from '@/network/WsEnvelope';
import type { JsonValue } from '../../../../../packages/shared-types/src/primitive-types';
import { WsGateway } from '@/network/WsGateway';
import { terminalStore, linesOf } from '@/domain/store/terminalStore';
import { authStore } from '@/domain/store/authStore';
import {
  TerminalWiring,
  dispatchTerminalActions,
  mapTerminalFrame,
} from './terminalWiring';

function frame(kind: string, body: unknown): InboundEnvelope {
  return {
    v: 1,
    kind,
    msgId: `m-in-${Math.random().toString(36).slice(2)}`,
    ts: 1,
    from: 'desktop',
    to: 'mobile',
    body: body as JsonValue,
  };
}

/** 构造 events.push 帧（event 信封扁平字段；receivedAtMs 由 eventStore 附加，此处不需要） */
function pushFrame(
  event: Record<string, unknown>,
  preview = false
): InboundEnvelope {
  return frame('events.push', { event, ...(preview ? { preview: true } : {}) });
}

function toolUpdateEvent(
  text: string,
  runId = 'run-1',
  kind = 'tool-progress'
) {
  return {
    type: 'tool-update',
    sessionId: 's-1',
    runId,
    sequence: 1,
    update: { text, metadata: { kind } },
  };
}

function taskOutputEvent(line: string, runId = 'run-1') {
  return {
    type: 'task-output',
    sessionId: 's-1',
    runId,
    sequence: 2,
    line,
  };
}

function resetStores(): void {
  terminalStore.setState({ runs: {} });
  authStore.setState({ pairState: 'unpaired', host: null });
}

beforeEach(() => {
  resetStores();
});

describe('mapTerminalFrame（设备帧 → 终端动作，纯函数）', () => {
  it('tool-update tool-progress 文本 → terminal-ingest（runId 自信封派生）', () => {
    const actions = mapTerminalFrame({
      kind: 'events.push',
      body: pushFrame(toolUpdateEvent('build ok\n')).body,
    });
    expect(actions).toEqual([
      { kind: 'terminal-ingest', runId: 'run-1', text: 'build ok\n' },
    ]);
  });

  it('tool-args-delta 入参预览不进终端行（F3 §4.1 S1 协议）', () => {
    const actions = mapTerminalFrame({
      kind: 'events.push',
      body: pushFrame(
        toolUpdateEvent('{"path":"a.ts"}', 'run-1', 'tool-args-delta')
      ).body,
    });
    expect(actions).toEqual([]);
  });

  it('task-output line → terminal-ingest；chunk 兜底（F3 §4.2 复用同一行缓冲）', () => {
    const line = mapTerminalFrame({
      kind: 'events.push',
      body: pushFrame(taskOutputEvent('行输出')).body,
    });
    expect(line).toEqual([
      { kind: 'terminal-ingest', runId: 'run-1', text: '行输出' },
    ]);
    const chunk = mapTerminalFrame({
      kind: 'events.push',
      body: pushFrame({
        type: 'task-output',
        sessionId: 's-1',
        runId: 'run-1',
        chunk: '块输出',
      }).body,
    });
    expect(chunk).toEqual([
      { kind: 'terminal-ingest', runId: 'run-1', text: '块输出' },
    ]);
  });

  it('run-terminal → terminal-run-end（run 收口释放）', () => {
    const actions = mapTerminalFrame({
      kind: 'events.push',
      body: pushFrame({
        type: 'run-terminal',
        sessionId: 's-1',
        runId: 'run-1',
        terminal: 'completed',
      }).body,
    });
    expect(actions).toEqual([{ kind: 'terminal-run-end', runId: 'run-1' }]);
  });

  it('非 events.push 帧 / 缺 runId / 非终端事件 → 空列表宽容跳过', () => {
    expect(mapTerminalFrame({ kind: 'session.updated', body: {} })).toEqual([]);
    expect(
      mapTerminalFrame({
        kind: 'events.push',
        body: pushFrame({
          type: 'tool-update',
          sessionId: 's-1',
          update: { text: 'x\n', metadata: { kind: 'tool-progress' } },
        }).body,
      })
    ).toEqual([]);
    expect(
      mapTerminalFrame({
        kind: 'events.push',
        body: pushFrame({
          type: 'message-delta',
          sessionId: 's-1',
          runId: 'run-1',
          text: '正文',
        }).body,
      })
    ).toEqual([]);
  });

  it('events.push 信封解析失败（event 缺失）→ 空列表不崩溃', () => {
    expect(
      mapTerminalFrame({ kind: 'events.push', body: { noEvent: true } })
    ).toEqual([]);
  });
});

describe('dispatchTerminalActions（terminalStore 动作执行点）', () => {
  it('terminal-ingest → ingestLines（行缓冲可见）', () => {
    dispatchTerminalActions([
      { kind: 'terminal-ingest', runId: 'run-1', text: 'a\nb\n' },
    ]);
    expect(linesOf('run-1')!.lines).toEqual(['a', 'b']);
  });

  it('terminal-run-end → resetRun 释放（linesOf 回 null；再 ingest 重建）', () => {
    dispatchTerminalActions([
      { kind: 'terminal-ingest', runId: 'run-1', text: 'x\n' },
    ]);
    dispatchTerminalActions([{ kind: 'terminal-run-end', runId: 'run-1' }]);
    expect(linesOf('run-1')).toBeNull();
    dispatchTerminalActions([
      { kind: 'terminal-ingest', runId: 'run-1', text: 'y\n' },
    ]);
    expect(linesOf('run-1')!.lines).toEqual(['y']);
  });

  it('混合动作顺序执行（不吞错）', () => {
    expect(() =>
      dispatchTerminalActions([
        { kind: 'terminal-ingest', runId: 'run-a', text: '1\n' },
        { kind: 'terminal-ingest', runId: 'run-b', text: '2\n' },
        { kind: 'terminal-run-end', runId: 'run-a' },
      ])
    ).not.toThrow();
    expect(linesOf('run-a')).toBeNull();
    expect(linesOf('run-b')!.lines).toEqual(['2']);
  });
});

describe('TerminalWiring 端到端（网关帧 → terminalStore 状态）', () => {
  it('attach 后 tool-update / task-output 帧 → 实时镜像 ingest', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('build ok\n')));
    gateway.dispatchFrame(pushFrame(taskOutputEvent('任务行输出')));
    expect(linesOf('run-1')!.lines).toEqual(['build ok', '任务行输出']);
    expect(linesOf('run-1')!.cursor).toBe(2);
    wiring.detach();
  });

  it('多 run 隔离（帧序列 runId 各异互不污染）', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('alpha\n', 'run-a')));
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('beta\nbeta2\n', 'run-b')));
    gateway.dispatchFrame(pushFrame(taskOutputEvent('alpha2', 'run-a')));
    expect(linesOf('run-a')!.lines).toEqual(['alpha', 'alpha2']);
    expect(linesOf('run-b')!.lines).toEqual(['beta', 'beta2']);
    expect(linesOf('run-a')!.cursor).toBe(2);
    wiring.detach();
  });

  it('run-terminal 帧 → 收口释放（缓冲释放；再 ingest 重建）', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('x\n')));
    gateway.dispatchFrame(
      pushFrame({
        type: 'run-terminal',
        sessionId: 's-1',
        runId: 'run-1',
        terminal: 'completed',
      })
    );
    expect(linesOf('run-1')).toBeNull();
    gateway.dispatchFrame(pushFrame(taskOutputEvent('y')));
    expect(linesOf('run-1')!.lines).toEqual(['y']);
    wiring.detach();
  });

  it('非 events.push 帧（session.updated 等）不影响 terminalStore', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    gateway.dispatchFrame(frame('session.updated', { session: { id: 's-1' } }));
    gateway.dispatchFrame(frame('events.resume.page', { sessionId: 's-1' }));
    expect(terminalStore.getState().runs).toEqual({});
    wiring.detach();
  });

  it('detach 退订：帧不再写入 terminalStore（幂等：重复 attach 先 detach）', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('first\n')));
    wiring.detach();
    wiring.detach(); // 幂等
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('second\n')));
    expect(linesOf('run-1')!.lines).toEqual(['first']);
    wiring.attach();
    gateway.dispatchFrame(pushFrame(taskOutputEvent('third')));
    expect(linesOf('run-1')!.lines).toEqual(['first', 'third']);
    wiring.detach();
  });

  it('authStore 离开 paired（unpair/移除本机/令牌过期）→ clearAll 全清', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    authStore.setState({ pairState: 'paired' });
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('a\n', 'run-a')));
    gateway.dispatchFrame(pushFrame(toolUpdateEvent('b\n', 'run-b')));
    expect(Object.keys(terminalStore.getState().runs)).toHaveLength(2);
    // 非 paired 转移（unpaired / token_expired 均落「离开 paired」面）
    authStore.setState({ pairState: 'unpaired' });
    expect(terminalStore.getState().runs).toEqual({});
    wiring.detach();
  });

  it('进入 paired（配对成功/水合恢复）不清缓冲（内存镜像从零开始）', () => {
    const gateway = new WsGateway();
    const wiring = new TerminalWiring({ gateway });
    wiring.attach();
    authStore.setState({ pairState: 'paired' });
    expect(terminalStore.getState().runs).toEqual({});
    wiring.detach();
  });
});
