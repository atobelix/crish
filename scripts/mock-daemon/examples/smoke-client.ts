// =======================================================================
// mock daemon v0（R0-06）——验收冒烟客户端
//
// 验收路径（对齐 R0-06 出口判定）：
//   连接 →（配对模式）pair.hello/challenge/verify/ok/device.ready →
//   auth.hello → auth.hello.ok → events.subscribe → 收到 events.push →
//   remote.approve → result.approve 回执 + approval-resolved 广播。
//
// 运行：npm run smoke -- --port 8765 [--no-pair]
// 退出码：0 = 全链路通过；1 = 任一环节失败或超时。
// =======================================================================

import WebSocket from 'ws';
import { buildEnvelope, parseInbound } from '../src/envelope.js';
import { nextMsgId } from '../src/util.js';

interface SmokeArgs {
  host: string;
  port: number;
  pairMode: boolean;
  pairCode: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): SmokeArgs {
  const opts: SmokeArgs = { host: '127.0.0.1', port: 8765, pairMode: true, pairCode: 'CXN-7K4P-Q2MB-9XRT', timeoutMs: 30_000 };
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    const val = (): string => {
      if (inline !== undefined && inline !== '') return inline;
      const n = args[i + 1];
      if (n === undefined) throw new Error(`参数 ${name} 缺少值`);
      return n;
    };
    switch (name) {
      case '--host':
        opts.host = val();
        if (inline === undefined) i += 1;
        break;
      case '--port':
        opts.port = Number(val());
        if (inline === undefined) i += 1;
        break;
      case '--pair':
        opts.pairMode = true;
        break;
      case '--no-pair':
        opts.pairMode = false;
        break;
      case '--pair-code':
        opts.pairCode = val();
        if (inline === undefined) i += 1;
        break;
      case '--timeout-ms':
        opts.timeoutMs = Number(val());
        if (inline === undefined) i += 1;
        break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/** 简易等待器：按 kind 匹配入站帧（带缓冲，乱序到达不丢帧） */
interface SmokeFrame {
  kind: string;
  msgId: string;
  body: unknown;
}
type FramePredicate = (f: SmokeFrame) => boolean;

class FrameWaiter {
  private buffer: SmokeFrame[] = [];
  private waiters: { predicate: FramePredicate; resolve: (f: SmokeFrame) => void; timer: NodeJS.Timeout }[] = [];

  onFrame(frame: SmokeFrame): void {
    const idx = this.waiters.findIndex((w) => w.predicate(frame));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(frame);
      return;
    }
    this.buffer.push(frame);
  }

  next(predicate?: FramePredicate, timeoutMs = 30_000): Promise<SmokeFrame> {
    const match = predicate ?? ((): boolean => true);
    const idx = this.buffer.findIndex(match);
    if (idx >= 0) return Promise.resolve(this.buffer.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待入站帧超时')), timeoutMs);
      this.waiters.push({ predicate: match, resolve, timer });
    });
  }
}

async function main(): Promise<number> {
  let opts: SmokeArgs;
  try {
    opts = parseArgs(process.argv);
  } catch (e) {
    console.error(`[smoke] 参数错误：${String((e as Error).message)}`);
    return 1;
  }

  const ws = new WebSocket(`ws://${opts.host}:${opts.port}`);
  const waiter = new FrameWaiter();
  const received: string[] = [];
  const step = (name: string): void => console.log(`[smoke] ✓ ${name}`);

  const timeout = setTimeout(() => {
    console.error(`[smoke] ✗ 全链路超时（已收到：${received.join(', ')}）`);
    ws.close();
    process.exit(1);
  }, opts.timeoutMs);

  const waitOpen = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', (e) => reject(new Error(`连接失败：${String(e)}`)));
  });

  ws.on('message', (data) => {
    const raw = data.toString('utf8');
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      console.error(`[smoke] ✗ 出站帧解析失败：${parsed.error.message}`);
      return;
    }
    received.push(parsed.frame.kind);
    waiter.onFrame({ kind: parsed.frame.kind, msgId: parsed.frame.msgId, body: parsed.frame.body });
  });

  // 发送帧：body 携带 msgId 时同步到信封（请求-响应关联键，M6 §3.3）
  const send = (kind: Parameters<typeof buildEnvelope>[0], body: Record<string, unknown>): void => {
    const frame = buildEnvelope(kind, body, 'dev-smoke-client');
    if (typeof body['msgId'] === 'string') frame.msgId = body['msgId'];
    ws.send(JSON.stringify(frame));
  };

  try {
    await waitOpen;
    step('WS 连接建立');

    if (opts.pairMode) {
      // 配对：pair.hello → challenge → verify → ok + device.ready
      send('pair.hello', {
        code: opts.pairCode,
        deviceId: 'dev-smoke-client',
        mobilePub: 'mock-mobile-pub',
        mobileLongPub: 'mock-mobile-long-pub',
        deviceName: '冒烟客户端',
        platform: 'other',
      });
      const challenge = await waiter.next((f) => f.kind === 'pair.challenge');
      step(`pair.challenge（desktopId=${(challenge.body as { desktopId?: string }).desktopId ?? ''}）`);
      send('pair.verify', { challengeSig: 'mock-sig', devicePubSig: 'mock-sig' });
      await waiter.next((f) => f.kind === 'pair.ok');
      step('pair.ok');
      await waiter.next((f) => f.kind === 'device.ready');
      step('device.ready');
    }

    // 握手：auth.hello → auth.hello.ok
    send('auth.hello', {
      protocolVersions: [1],
      capabilities: ['fileRead', 'approval'],
      appVersion: '0.1.0',
      platform: 'other',
    });
    const helloOk = await waiter.next((f) => f.kind === 'auth.hello.ok');
    step(`auth.hello.ok（协议版本 ${(helloOk.body as { protocolVersion?: number }).protocolVersion ?? '?'}，manifest ${(helloOk.body as { manifest?: { contractVersion?: string } }).manifest?.contractVersion ?? '?'}）`);

    // 订阅审批场景会话 → 场景时间线启动 → 等待 approval-requested
    send('events.subscribe', { sessions: ['s-mock-approval'], lastSequences: {} });
    await waiter.next((f) => f.kind === 'events.subscribe.ok');
    step('events.subscribe.ok');
    const approvalFrame = await waiter.next((f) => f.kind === 'events.push' && ((f.body as { event?: { type?: string } }).event?.type === 'approval-requested'));
    const ev = (approvalFrame.body as { event: { toolCallId?: string; request?: { toolCallId?: string } } }).event;
    const toolCallId = ev.request?.toolCallId ?? ev.toolCallId ?? 'tc-mock-approve-1';
    step(`events.push approval-requested（toolCallId=${toolCallId}）`);

    // 命令回执：remote.approve → result.approve（响应关联键 reqMsgId = 请求 msgId）
    const approveMsgId = nextMsgId('m');
    send('remote.approve', { command: 'approve', params: { toolCallId }, msgId: approveMsgId });
    const approveResult = await waiter.next(
      (f) => f.kind === 'result.approve' && (f.body as { reqMsgId?: string })['reqMsgId'] === approveMsgId,
    );
    step(`result.approve（decision=${(approveResult.body as { result?: { decision?: string } }).result?.decision ?? '?'}）`);

    // 决策广播：approval-resolved
    await waiter.next((f) => f.kind === 'events.push' && ((f.body as { event?: { type?: string } }).event?.type === 'approval-resolved'));
    step('events.push approval-resolved');

    // 心跳回执
    send('heartbeat', { ts: Date.now(), deviceTimeMs: Date.now() });
    await waiter.next((f) => f.kind === 'heartbeat.ok');
    step('heartbeat.ok');

    clearTimeout(timeout);
    console.log('[smoke] 验收路径全链路通过：hello → subscribe → 事件推送 → approve 回执 → approval-resolved');
    ws.close();
    return 0;
  } catch (e) {
    clearTimeout(timeout);
    console.error(`[smoke] ✗ 失败：${String((e as Error).message)}（已收到：${received.join(', ')}）`);
    ws.close();
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[smoke] 致命错误：${String(e)}`);
    process.exit(1);
  });
