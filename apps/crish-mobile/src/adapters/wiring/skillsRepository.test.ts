// skillsRepository 接线测试（G7）：WsGateway.invoke 发送 → 响应解析 → 错误归一化
// 模式同 modelsRepository.test：真实 WsGateway（注入捕获 send）+ 手工 dispatch
// 响应帧（result.<cmd> / error，按 reqMsgId 回填）。
import { WsGateway } from '@/network/WsGateway';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import {
  GatewaySkillsRepository,
  SkillsCommandError,
} from './skillsRepository';

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
  const repo = new GatewaySkillsRepository(gateway);

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

describe('GatewaySkillsRepository', () => {
  it('listSkills：发送 remote.listSkills + 空 params；响应解析成功', async () => {
    const { repo, sent, respond } = makeBridge();
    const promise = repo.listSkills();
    expect(sent[0]!.kind).toBe('remote.listSkills');
    expect(sent[0]!.body.command).toBe('listSkills');
    expect(sent[0]!.body.params).toEqual({});
    respond('listSkills', {
      skills: [
        {
          id: 'skill_95cfb221d00f',
          name: 'my-skill',
          description: '演示技能',
          scope: 'project',
          system: false,
        },
      ],
    });
    const res = await promise;
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0]!.name).toBe('my-skill');
  });

  it('服务端错误码透传为 SkillsCommandError', async () => {
    const { repo, respondError } = makeBridge();
    const promise = repo.listSkills();
    respondError('internal');
    await expect(promise).rejects.toMatchObject({
      name: 'SkillsCommandError',
      code: 'internal',
      retryable: false,
    });
  });

  it('响应解析失败 → SkillsCommandError(internal)', async () => {
    const { repo, respond } = makeBridge();
    const promise = repo.listSkills();
    respond('listSkills', { skills: [{ id: 'skill_x' }] });
    await expect(promise).rejects.toBeInstanceOf(SkillsCommandError);
    await expect(promise).rejects.toMatchObject({ code: 'internal' });
  });
});
