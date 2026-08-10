// =======================================================================
// mock daemon v0（R0-06）——命令回执测试（approve/deny/查询面）
// =======================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, TestClient, waitOpen, eventOf, resultOf, errorOf } from './helpers.js';
import type { TestServer } from './helpers.js';

async function connectAndHello(t: TestServer, deviceId: string): Promise<TestClient> {
  const c = new TestClient(t.url, deviceId);
  await waitOpen(c);
  c.send('auth.hello', { protocolVersions: [1], capabilities: ['approval'], appVersion: '0.1.0', platform: 'other' });
  await c.waitFor('auth.hello.ok');
  return c;
}

describe('命令回执（approve/deny 成功路径）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'approval', scenarioSpeed: 0 });
    client = await connectAndHello(t, 'dev-cmd-1');
    client.send('events.subscribe', { sessions: ['s-mock-approval'], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
    // 消费时间线直至 approval-requested（闸门就绪）
    for (;;) {
      const push = await client.waitFor((f) => f.kind === 'events.push');
      if (String(eventOf(push)['type']) === 'approval-requested') break;
    }
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('approve → result.approve（decision=approved）+ approval-resolved 广播', async () => {
    client.sendCommand('remote.approve', 'approve', { toolCallId: 'tc-mock-approve-1' });
    const result = await client.waitFor('result.approve');
    expect(resultOf(result)['toolCallId']).toBe('tc-mock-approve-1');
    expect(resultOf(result)['decision']).toBe('approved');

    const resolved = await client.waitFor((f) => f.kind === 'events.push' && String(eventOf(f)['type']) === 'approval-resolved');
    expect(eventOf(resolved)['decision']).toBe('approved');
    expect(eventOf(resolved)['toolCallId']).toBe('tc-mock-approve-1');
  });

  it('重复决策同一 toolCallId → cmd.approval_mismatch（I-02 语义）', async () => {
    client.sendCommand('remote.approve', 'approve', { toolCallId: 'tc-mock-approve-1' });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('cmd.approval_mismatch');
  });

  it('同 msgId 重发 → 幂等回显首次结果（不重复执行）', async () => {
    // 先登记一个新待审批（手动注册，绕过场景）
    const toolCallId = 'tc-manual-1';
    t.server.state.registerPendingApproval(
      { requestId: 'req-manual-1', toolCallId, toolName: 'shell:write', summary: '手动审批项', sessionId: 's-manual', runId: 'r-manual', arbiter: 'user', requestedAt: Date.now(), expiresAt: Date.now() + 60000, dangerLevel: 1 },
      null,
    );
    const msgId = client.sendCommand('remote.approve', 'approve', { toolCallId });
    const first = await client.waitFor('result.approve');
    expect(resultOf(first)['decision']).toBe('approved');
    // 重发同 msgId：回显首次结果
    client.send('remote.approve', { command: 'approve', params: { toolCallId }, msgId });
    const replay = await client.waitFor((f) => f.kind === 'result.approve');
    expect(replay.body['reqMsgId']).toBe(msgId);
    expect(resultOf(replay)['decision']).toBe('approved');
  });

  it('listPendingApprovals → 剩余待审批集合（已决策项移除）', async () => {
    client.sendCommand('remote.listPendingApprovals', 'listPendingApprovals', {});
    const frame = await client.waitFor('result.listPendingApprovals');
    const approvals = frame.body['result'] as { approvals: { toolCallId: string }[] };
    expect(approvals.approvals.length).toBe(0); // 场景审批项 + 手动项均已决策
  });

  it('approvalHistory → 决策历史（含 channel=mobile）', async () => {
    client.sendCommand('remote.approvalHistory', 'approvalHistory', { limit: 100 });
    const frame = await client.waitFor('result.approvalHistory');
    const items = (frame.body['result'] as { items: { toolCallId: string; decision: string; channel: string }[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.some((it) => it.toolCallId === 'tc-mock-approve-1' && it.decision === 'approved' && it.channel === 'mobile')).toBe(true);
  });
});

describe('命令回执（deny 与错误路径）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer({ scenario: 'approval', scenarioSpeed: 0 });
    client = await connectAndHello(t, 'dev-cmd-2');
    client.send('events.subscribe', { sessions: ['s-mock-approval'], lastSequences: {} });
    await client.waitFor('events.subscribe.ok');
    // 等新一轮场景启动（上一条 describe 的 server 已关闭，这里重新触发）
    for (;;) {
      const push = await client.waitFor((f) => f.kind === 'events.push');
      if (String(eventOf(push)['type']) === 'approval-requested') break;
    }
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('deny → result.deny（decision=denied，reason 透传）+ 事件广播', async () => {
    client.sendCommand('remote.deny', 'deny', { toolCallId: 'tc-mock-approve-1', reason: '风险过高' });
    const result = await client.waitFor('result.deny');
    expect(resultOf(result)['decision']).toBe('denied');
    const resolved = await client.waitFor((f) => f.kind === 'events.push' && String(eventOf(f)['type']) === 'approval-resolved');
    expect(eventOf(resolved)['decision']).toBe('denied');
  });

  it('未知 toolCallId → cmd.approval_mismatch', async () => {
    client.sendCommand('remote.approve', 'approve', { toolCallId: 'tc-not-exist' });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('cmd.approval_mismatch');
  });

  it('未实现命令 → cmd.unknown（诚实拒绝，retryable=false）', async () => {
    client.sendCommand('remote.runTask', 'runTask', { prompt: '测试' });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('cmd.unknown');
    expect(errFrame.body['retryable']).toBe(false);
  });
});

describe('查询面夹具（监控/设置/设备域）', () => {
  let t: TestServer;
  let client: TestClient;

  beforeAll(async () => {
    t = await startTestServer();
    client = await connectAndHello(t, 'dev-cmd-3');
  });

  afterAll(async () => {
    client.close();
    await t.server.close();
  });

  it('getStatus → 状态卡夹具（activeRuns 反映待审批）', async () => {
    t.server.state.registerPendingApproval(
      { requestId: 'req-q1', toolCallId: 'tc-q1', toolName: 'shell:write', summary: '查询面审批项', sessionId: 's-q1', runId: 'r-q1', arbiter: 'user', requestedAt: Date.now(), expiresAt: Date.now() + 60000, dangerLevel: 2 },
      null,
    );
    client.sendCommand('remote.getStatus', 'getStatus', {});
    const frame = await client.waitFor('result.getStatus');
    const status = frame.body['result'] as { engineReady: boolean; activeRuns: { status: string }[] };
    expect(status.engineReady).toBe(true);
    expect(status.activeRuns.some((r) => r.status === 'awaiting-approval')).toBe(true);
  });

  it('listCommands → manifest 夹具（contractVersion 1.0.0，含 approve）', async () => {
    client.sendCommand('remote.listCommands', 'listCommands', {});
    const frame = await client.waitFor('result.listCommands');
    const body = frame.body['result'] as { contractVersion: string; commands: { name: string }[] };
    expect(body.contractVersion).toBe('1.0.0');
    expect(body.commands.some((c) => c.name === 'approve')).toBe(true);
  });

  it('checkCommand → shell:* 需审批 / 只读命令放行', async () => {
    client.sendCommand('remote.checkCommand', 'checkCommand', { command: 'shell:write', params: { script: 'npm test' } });
    const f1 = await client.waitFor('result.checkCommand');
    expect((f1.body['result'] as { decision: string }).decision).toBe('requires-approval');

    client.sendCommand('remote.checkCommand', 'checkCommand', { command: 'core_get_status' });
    const f2 = await client.waitFor('result.checkCommand');
    expect((f2.body['result'] as { decision: string }).decision).toBe('allowed');
  });

  it('getRunSnapshot：未知 run → cmd.not_found', async () => {
    client.sendCommand('remote.getRunSnapshot', 'getRunSnapshot', { runId: 'r-不存在' });
    const errFrame = await client.waitFor((f) => f.kind === 'error');
    expect(errorOf(errFrame).code).toBe('cmd.not_found');
  });

  it('readSessionEvents：空会话 → 空分页（EventPage 契约）', async () => {
    client.sendCommand('remote.readSessionEvents', 'readSessionEvents', { sessionId: 's-empty', afterSequence: 0 });
    const frame = await client.waitFor('result.readSessionEvents');
    const page = frame.body['result'] as { events: unknown[]; nextAfterSequence: number; hasMore: boolean };
    expect(page.events).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('queryPresence → 桌面在场夹具', async () => {
    client.sendCommand('remote.queryPresence', 'queryPresence', {});
    const frame = await client.waitFor('result.queryPresence');
    expect((frame.body['result'] as { desktopOnline: boolean }).desktopOnline).toBe(true);
  });
});
