// modelsRepository 接线测试（G2/W-B）：WsGateway.invoke 发送 → 响应解析 → 错误归一化
// 模式同 filesRepository.test：真实 WsGateway（注入捕获 send）+ 手工 dispatch
// 响应帧（result.<cmd> / error，按 reqMsgId 回填）。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import {
  GatewayModelsRepository,
  ModelsCommandError,
} from './modelsRepository';

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
  const repo = new GatewayModelsRepository(gateway);

  /** 以最近一帧 reqMsgId 回结果（kind = result.<command>，CommandResult 信封） */
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

  /** 以最近一帧 reqMsgId 回错误帧（错误码透传） */
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

describe('GatewayModelsRepository', () => {
  it('listModels：发送 remote.listModels + 空 params；响应解析成功', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.listModels();
    expect(sent[0]!.kind).toBe('remote.listModels');
    expect(sent[0]!.body.command).toBe('listModels');
    expect(sent[0]!.body.params).toEqual({});
    respond('listModels', {
      models: [
        {
          providerId: 'anthropic',
          modelId: 'claude-sonnet',
          displayName: 'Claude Sonnet',
          active: true,
        },
      ],
      activeModel: {
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
        displayName: 'Claude Sonnet',
      },
    });
    const res = await promise;
    expect(res.models).toHaveLength(1);
    expect(res.activeModel?.modelId).toBe('claude-sonnet');
  });

  it('setActiveModel：发送 (providerId, modelId)；回传切换后的全局默认', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.setActiveModel({
      providerId: 'openai',
      modelId: 'gpt-x',
    });
    expect(sent[0]!.kind).toBe('remote.setActiveModel');
    expect(sent[0]!.body.command).toBe('setActiveModel');
    expect(sent[0]!.body.params).toEqual({
      providerId: 'openai',
      modelId: 'gpt-x',
    });
    respond('setActiveModel', {
      ok: true,
      activeModel: {
        providerId: 'openai',
        modelId: 'gpt-x',
        displayName: 'GPT X',
      },
    });
    const res = await promise;
    expect(res.ok).toBe(true);
    expect(res.activeModel.displayName).toBe('GPT X');
  });

  it('服务端错误码透传为 ModelsCommandError（cmd.invalid 不重试）', async () => {
    const { repo, respondError } = makeBridge();
    const promise = repo.setActiveModel({ providerId: 'p', modelId: 'm' });
    respondError('cmd.invalid');
    await expect(promise).rejects.toMatchObject({
      name: 'ModelsCommandError',
      code: 'cmd.invalid',
      retryable: false,
    });
  });

  it('响应解析失败 → ModelsCommandError(internal)', async () => {
    const { repo, respond } = makeBridge();
    const promise = repo.listModels();
    respond('listModels', { models: [{ providerId: 'p' }] });
    await expect(promise).rejects.toBeInstanceOf(ModelsCommandError);
    await expect(promise).rejects.toMatchObject({ code: 'internal' });
  });
});
