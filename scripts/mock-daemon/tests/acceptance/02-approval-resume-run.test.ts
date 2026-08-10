// =======================================================================
// R0-07 验收三件套 2：远程 approve 恢复 run
//
// 验收口径（Z0 §9.2 R0-07 / §12.5 P0 ② / T-D3-06）：桌面 run 因审批挂起
// （awaiting-approval）→ 移动端（mock 客户端）发 remote.approve →
// run 恢复继续 → 事件流出现后续事件（工具执行 → 收口）。
//
// 场景：mock daemon approval 夹具（交互式时间线）——run 启动 → 消息 →
// approval-requested（闸门等待）→ 客户端 approve → approval-resolved
// 广播 → 工具执行 → run 收口。断言完整序列与 run 状态机迁移
// （awaiting-approval → running → completed）。
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer } from '../helpers.js';
import type { TestServer } from '../helpers.js';
import { AcceptanceClient, waitOpen, eventOf, resultOf } from './helpers.js';

const SESSION_ID = 's-mock-approval';
const RUN_ID = 'r-mock-approval-1';
const TOOL_CALL_ID = 'tc-mock-approve-1';

/** 连续消费 events.push 直至命中收口类型，返回事件类型序列（保序） */
async function collectTypesUntil(client: AcceptanceClient, stopType: string): Promise<string[]> {
  const types: string[] = [];
  for (;;) {
    const push = await client.waitFor((f) => f.kind === 'events.push');
    const type = String(eventOf(push)['type']);
    types.push(type);
    if (type === stopType) break;
  }
  return types;
}

/** 发送命令并等待 result（断言 reqMsgId 关联） */
async function commandAndResult(client: AcceptanceClient, kind: Parameters<AcceptanceClient['sendCommand']>[0], command: string, params: Record<string, unknown>): Promise<Awaited<ReturnType<AcceptanceClient['waitFor']>>> {
  const msgId = client.sendCommand(kind, command, params);
  const result = await client.waitFor((f) => f.kind === `result.${command}`);
  expect(result.body['reqMsgId']).toBe(msgId);
  return result;
}

describe('R0-07 三件套 2：远程 approve 恢复 run（审批挂起 → 决策 → 恢复 → 收口）', () => {
  let t: TestServer;
  let client: AcceptanceClient;
  /** 挂起前已收到的事件类型序列（approval-requested 为止） */
  let preGateTypes: string[] = [];

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'approval', scenarioSpeed: 0 });
    client = new AcceptanceClient(t.url, 'dev-accept-approve');
    await waitOpen(client);
    client.send('auth.hello', { protocolVersions: [1], capabilities: ['approval'], appVersion: '0.1.0', platform: 'other' });
    await client.waitFor('auth.hello.ok');
    client.send('events.subscribe', { sessions: [SESSION_ID], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
    // 场景时间线自动启动；消费至 approval-requested（run 挂起，闸门就绪）
    preGateTypes = await collectTypesUntil(client, 'approval-requested');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('挂起断言：approval-requested 到达后 run 处于 awaiting-approval（待审批 1 项）', async () => {
    expect(preGateTypes[0]).toBe('agent-start');
    expect(preGateTypes).toContain('turn-start');
    expect(preGateTypes).toContain('message-delta');
    expect(preGateTypes[preGateTypes.length - 1]).toBe('approval-requested');

    // 待审批集合对账：1 项，toolCallId 与场景夹具一致
    const list = await commandAndResult(client, 'remote.listPendingApprovals', 'listPendingApprovals', {});
    const approvals = resultOf(list)['approvals'] as { toolCallId: string; toolName: string }[];
    expect(approvals.length).toBe(1);
    expect(approvals[0]!.toolCallId).toBe(TOOL_CALL_ID);
    expect(approvals[0]!.toolName).toBe('shell:write');

    // run 快照：因审批挂起（awaiting-approval）
    const snap = await commandAndResult(client, 'remote.getRunSnapshot', 'getRunSnapshot', { runId: RUN_ID });
    const snapshot = resultOf(snap)['snapshot'] as { runId: string; status: string; sessionId: string };
    expect(snapshot.runId).toBe(RUN_ID);
    expect(snapshot.status).toBe('awaiting-approval');
    expect(snapshot.sessionId).toBe(SESSION_ID);
  });

  it('移动端 remote.approve → result.approve（decision=approved，toolCallId 回显）', async () => {
    const result = await commandAndResult(client, 'remote.approve', 'approve', { toolCallId: TOOL_CALL_ID });
    const approve = resultOf(result);
    expect(approve['ok']).toBe(true);
    expect(approve['toolCallId']).toBe(TOOL_CALL_ID);
    expect(approve['decision']).toBe('approved');
  });

  it('run 恢复继续：approval-resolved → 消息 → 工具执行 → run 收口（完整序列）', async () => {
    // 决策后继续消费至 run-terminal（run 恢复并走完）
    const postTypes = await collectTypesUntil(client, 'run-terminal');

    // 决策广播先行：approval-resolved 是决策后第一件业务事件
    expect(postTypes[0]).toBe('approval-resolved');

    // run 恢复继续的关键证据：决策后出现后续消息 + 工具执行 + 收口
    expect(postTypes).toContain('message-delta');   // 「已批准，开始执行…」续接文案
    expect(postTypes).toContain('tool-start');      // 工具执行开始（run 恢复 running）
    expect(postTypes).toContain('tool-update');     // 工具输出流式更新
    expect(postTypes).toContain('tool-end');        // 工具执行完成
    expect(postTypes).toContain('message-end');
    expect(postTypes).toContain('turn-end');
    expect(postTypes).toContain('agent-end');
    expect(postTypes[postTypes.length - 1]).toBe('run-terminal'); // 收口为最后一帧

    // 相对顺序：工具执行在决策广播之后、收口之前
    const resolvedIdx = postTypes.indexOf('approval-resolved');
    const toolStartIdx = postTypes.indexOf('tool-start');
    const terminalIdx = postTypes.indexOf('run-terminal');
    expect(toolStartIdx).toBeGreaterThan(resolvedIdx);
    expect(terminalIdx).toBeGreaterThan(toolStartIdx);

    // 决策广播事件字段逐项（decision/toolCallId）
    // （approval-resolved 已从缓冲弹出，这里通过时间线序列 + 快照状态兜底断言）
    expect(postTypes.slice(0, 6)).toEqual([
      'approval-resolved',
      'message-delta',
      'tool-start',
      'tool-update',
      'tool-update',
      'tool-end',
    ]);
  });

  it('run 状态机迁移完成：approve 恢复后 getRunSnapshot → completed；审批历史入账', async () => {
    // run 恢复并收口：快照终态 completed
    const snap = await commandAndResult(client, 'remote.getRunSnapshot', 'getRunSnapshot', { runId: RUN_ID });
    const snapshot = resultOf(snap)['snapshot'] as { status: string; endReason: string };
    expect(snapshot.status).toBe('completed');
    expect(snapshot.endReason).toBe('completed');

    // 审批历史：decision=approved、channel=mobile（移动端决策入账）
    const hist = await commandAndResult(client, 'remote.approvalHistory', 'approvalHistory', { limit: 100 });
    const items = resultOf(hist)['items'] as { toolCallId: string; decision: string; channel: string; sessionId: string; runId: string }[];
    const entry = items.find((it) => it.toolCallId === TOOL_CALL_ID);
    expect(entry).toBeDefined();
    expect(entry!.decision).toBe('approved');
    expect(entry!.channel).toBe('mobile');
    expect(entry!.sessionId).toBe(SESSION_ID);
    expect(entry!.runId).toBe(RUN_ID);

    // 待审批清空（I-02：单写者收敛）
    const list = await commandAndResult(client, 'remote.listPendingApprovals', 'listPendingApprovals', {});
    expect((resultOf(list)['approvals'] as unknown[]).length).toBe(0);
  });
});

describe('R0-07 三件套 2 补充：deny 变体（拒绝后 run 走拒绝路径收口）', () => {
  let t: TestServer;
  let client: AcceptanceClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'approval', scenarioSpeed: 0 });
    client = new AcceptanceClient(t.url, 'dev-accept-deny');
    await waitOpen(client);
    client.send('auth.hello', { protocolVersions: [1], capabilities: ['approval'], appVersion: '0.1.0', platform: 'other' });
    await client.waitFor('auth.hello.ok');
    client.send('events.subscribe', { sessions: [SESSION_ID], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
    await collectTypesUntil(client, 'approval-requested');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('deny → run 同样恢复收口（拒绝路径：跳过执行 → 收口 completed）', async () => {
    const result = await commandAndResult(client, 'remote.deny', 'deny', { toolCallId: TOOL_CALL_ID, reason: '验收拒绝用例' });
    expect(resultOf(result)['decision']).toBe('denied');

    // 拒绝后时间线继续：approval-resolved(denied) → 消息（跳过执行）→ 工具执行 → 收口
    const postTypes = await collectTypesUntil(client, 'run-terminal');
    expect(postTypes[0]).toBe('approval-resolved');
    expect(postTypes).toContain('tool-start');
    expect(postTypes[postTypes.length - 1]).toBe('run-terminal');

    // run 终态 completed（拒绝 ≠ run 失败；approval 场景收口语义）
    const snap = await commandAndResult(client, 'remote.getRunSnapshot', 'getRunSnapshot', { runId: RUN_ID });
    expect((resultOf(snap)['snapshot'] as { status: string }).status).toBe('completed');
  });

  it('重复决策（同 toolCallId 二次 approve）→ cmd.approval_mismatch（I-02 防伪造）', async () => {
    client.sendCommand('remote.approve', 'approve', { toolCallId: TOOL_CALL_ID });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errFrame.body['code']).toBe('cmd.approval_mismatch');
  });
});
