// filesRepository 接线测试（R2-06b）：WsGateway.invoke 发送 → 响应解析 → 错误归一化
// - 用真实 WsGateway（注入捕获 send）+ 手工 dispatch 响应帧（result.<cmd> /
//   error，按 reqMsgId 回填，D3 §5.4 语义）；
// - 断言：发送帧 kind/body.command/params 与 filesCommands 构造一致；
//   成功响应解析通过生成面解析器；服务端错误码透传（F4 附录 B 映射在 UI 层）；
//   解析失败 → FilesCommandError('internal')。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { GatewayFilesRepository, FilesCommandError } from './filesRepository';

interface SentFrame {
  kind: string;
  msgId: string;
  body: { command: string; params: Record<string, unknown> };
}

function makeBridge() {
  const sent: SentFrame[] = [];
  const gateway = new WsGateway({
    send: (raw) => {
      const frame = JSON.parse(raw) as SentFrame;
      sent.push(frame);
    },
  });
  const repo = new GatewayFilesRepository(gateway);

  /** 以最近一帧 reqMsgId 回结果（kind = result.<command>，M6 §6.1 CommandResult 信封） */
  const respond = (command: string, result: unknown): void => {
    const req = sent[sent.length - 1]!;
    gateway.dispatchFrame({
      v: 1,
      kind: `result.${command}`,
      msgId: `resp-${sent.length}`,
      ts: Date.now(),
      from: 'desktop',
      to: 'mobile',
      body: { reqMsgId: req.msgId, ok: true, result },
    } as InboundEnvelope);
  };

  /** 以最近一帧 reqMsgId 回错误帧（D3 §6.2 错误码透传） */
  const respondError = (code: string, retryable = false): void => {
    const req = sent[sent.length - 1]!;
    gateway.dispatchFrame({
      v: 1,
      kind: 'error',
      msgId: `err-${sent.length}`,
      ts: Date.now(),
      from: 'desktop',
      to: 'mobile',
      body: { reqMsgId: req.msgId, code, message: `err:${code}`, retryable },
    } as InboundEnvelope);
  };

  return { repo, sent, respond, respondError };
}

describe('GatewayFilesRepository', () => {
  it('listDir：发送 remote.listDir + body.command=listDir + params；响应解析成功', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.listDir({ path: 'src', workspaceRoot: 'C:\\w' });
    expect(sent[0]!.kind).toBe('remote.listDir');
    expect(sent[0]!.body.command).toBe('listDir');
    expect(sent[0]!.body.params).toEqual({
      path: 'src',
      workspaceRoot: 'C:\\w',
    });
    respond('listDir', {
      entries: [
        { name: 'a.ts', isDir: false, size: 10, modified: '1000' },
        { name: 'dir', isDir: true },
      ],
    });
    const res = await promise;
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0]).toEqual({
      name: 'a.ts',
      isDir: false,
      size: 10,
      modified: '1000',
    });
  });

  it('readFile：发送 remote.readFile + maxLines 透传；sensitive 标记保留', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.readFile({ path: '.env', maxLines: 400 });
    expect(sent[0]!.kind).toBe('remote.readFile');
    expect(sent[0]!.body.params).toEqual({ path: '.env', maxLines: 400 });
    respond('readFile', {
      content: 'SECRET=1',
      lineCount: 1,
      truncated: false,
      sensitive: true,
    });
    const res = await promise;
    expect(res.sensitive).toBe(true);
    expect(res.content).toBe('SECRET=1');
  });

  it('listWorkspaces：发送 remote.listWorkspaces + 空 params', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.listWorkspaces();
    expect(sent[0]!.kind).toBe('remote.listWorkspaces');
    expect(sent[0]!.body.params).toEqual({});
    respond('listWorkspaces', {
      workspaces: [{ root: 'C:\\w', active: true }],
    });
    const res = await promise;
    expect(res.workspaces[0]!.root).toBe('C:\\w');
  });

  it('switchWorkspace：发送 remote.switchWorkspace + path 透传', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.switchWorkspace({ path: 'C:\\w' });
    expect(sent[0]!.kind).toBe('remote.switchWorkspace');
    expect(sent[0]!.body.params).toEqual({ path: 'C:\\w' });
    respond('switchWorkspace', { ok: true, activeRoot: 'C:\\w' });
    const res = await promise;
    expect(res.activeRoot).toBe('C:\\w');
  });

  it('服务端错误帧 → FilesCommandError 透传 code/retryable（F4 附录 B 映射在 UI 层）', async () => {
    const { repo, respondError } = makeBridge();
    const promise = repo.listDir({ path: 'x' });
    respondError('outside_workspace', true);
    await expect(promise).rejects.toMatchObject({
      code: 'outside_workspace',
      retryable: true,
    });
  });

  it('file_too_large 错误码透传（预览占位数据面，R2UX-06-02）', async () => {
    const { repo, respondError } = makeBridge();
    const promise = repo.readFile({ path: 'big.ts' });
    respondError('file_too_large');
    await expect(promise).rejects.toMatchObject({ code: 'file_too_large' });
  });

  it('响应形状非法（缺必填字段）→ FilesCommandError(internal)（生成面解析器拒绝）', async () => {
    const { repo, respond } = makeBridge();
    const promise = repo.listDir({ path: 'x' });
    respond('listDir', { entries: [{ name: 'no-isDir' }] });
    await expect(promise).rejects.toMatchObject({ code: 'internal' });
  });

  it('未接线网关（无 send）→ transport.closed（未连接错误态数据面）', async () => {
    const repo = new GatewayFilesRepository(new WsGateway());
    await expect(repo.listDir({ path: 'x' })).rejects.toMatchObject({
      code: 'transport.closed',
      retryable: true,
    });
  });

  it('传输层抛非 GatewayError 异常 → 归一为 FilesCommandError(internal)（未知错误兜底）', async () => {
    // send 抛普通异常：invoke 以原始错误 reject（非 GatewayError）→ 兜底 internal
    const gateway = new WsGateway({
      send: () => {
        throw new Error('发送异常');
      },
    });
    const repo = new GatewayFilesRepository(gateway);
    await expect(repo.listDir({ path: 'x' })).rejects.toMatchObject({
      code: 'internal',
      retryable: false,
    });
  });

  it('FilesCommandError instanceof 判定（VM errorCodeOf 依赖）', () => {
    const err = new FilesCommandError('path_not_found', 'x', false);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('path_not_found');
  });
});
