// 命令域网关换代存活回归（H1 陈旧捕获根治）：
// - 背景：六命令域 context 单例曾在首次装配时捕获当时一代的 WsGateway 并
//   永久持有（单例工厂内 wiring.client.gateway）。观测接线在目标切换 /
//   资格软丢失 / 桌面 presence 抖动时 dispose 并重建（换代），旧 gateway
//   的发送闭包指向已 disconnect 的 client（this.ws=null）静默吞帧，
//   pending 无人 abort → invoke 恰好满 10s 以 cmd.timeout 失败且进程内
//   永不自愈（模型 C38 / 技能 C44 列表长期不可用的根因；推送/订阅面随代
//   在 startObservationWiring 内重建，故一直存活——一死一生与症状吻合）。
// - 修复口径：仓储只持 resolveCommandGateway 解析函数，每次 invoke 现取
//   当代网关（接线存在且 client 相位 open 才返回）；无当代网关立即以
//   transport.closed 快速失败；cmd.timeout 路径留 warn 日志。
// - 本套件以真实 observationWiring + 双代注入 gateway/捕获型 mock socket
//   复现换代（context 单例全程不复位——正是生产中毒场景），逐项钉死：
//   换代后同一 context 的 invoke 落到新代并 resolve；旧代 dispose 后零
//   新帧；无接线 / 未 open 快速失败；其余四域 + monitor 的帧路由同理；
//   超时 warn 日志含命令名与错误码。
import { WsGateway } from '@/network/WsGateway';
import type { WsSocket } from '@/network/ReconnectingWsClient';
import type { InboundEnvelope } from '@/network/WsEnvelope';
import { configureLoggerForTest } from '@/adapters/platform/logger';
import { authStore } from '@/domain/store/authStore';
import {
  ensureObservationWiring,
  resetObservationWiringForTest,
} from './observationWiring';
import { getModelsContext, resetModelsContextForTest } from './modelsWiring';
import { getSkillsContext, resetSkillsContextForTest } from './skillsWiring';
import { getFilesContext, resetFilesContextForTest } from './filesWiring';
import {
  getSessionOpsContext,
  resetSessionOpsContextForTest,
} from './sessionOpsWiring';
import { GatewayModelsRepository } from './modelsRepository';
import {
  getQuickRunContext,
  resetQuickRunContextForTest,
} from '@/adapters/quickRunWiring';
import {
  getRunControlContext,
  resetRunControlContextForTest,
} from '@/adapters/runControlWiring';

interface SentFrame {
  kind: string;
  msgId: string;
  body: { command?: string; params?: Record<string, unknown> };
}

interface Generation {
  gateway: WsGateway;
  /** 触发本代 socket onopen（client 相位 → open，网关 attachSend 接线） */
  open: () => void;
  /** 本代已发帧中指定 kind 的帧（过滤 FeedBridge 的订阅/对账帧） */
  framesOf: (kind: string) => SentFrame[];
  /** 以指定 kind 最后一帧的 reqMsgId 回成功结果（CommandResult 信封） */
  respondOk: (kind: string, result: unknown) => void;
}

/** 启动一代观测接线：注入独立 gateway + 捕获型 mock socket（不自动 open） */
function startGeneration(): Generation {
  const sent: SentFrame[] = [];
  let socket: WsSocket | null = null;
  const gateway = new WsGateway();
  const factory = (): WsSocket => {
    socket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (raw: string) => {
        sent.push(JSON.parse(raw) as SentFrame);
      },
      close: () => {},
    };
    return socket;
  };
  ensureObservationWiring({ gateway, factory });
  const framesOf = (kind: string): SentFrame[] =>
    sent.filter((f) => f.kind === kind);
  return {
    gateway,
    open: () => {
      socket?.onopen?.();
    },
    framesOf,
    respondOk: (kind, result) => {
      const frames = framesOf(kind);
      const req = frames[frames.length - 1]!;
      gateway.dispatchFrame({
        v: 1,
        kind: `result.${req.body.command ?? ''}`,
        msgId: `resp-${frames.length}-${Date.now()}`,
        ts: Date.now(),
        from: 'desktop',
        to: 'mobile',
        body: { reqMsgId: req.msgId, ok: true, result },
      } as InboundEnvelope);
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const MODELS_RESULT = {
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
};

const SKILLS_RESULT = {
  skills: [
    {
      id: 'skill_95cfb221d00f',
      name: 'my-skill',
      description: '演示技能',
      scope: 'project',
      system: false,
    },
  ],
};

beforeEach(() => {
  resetModelsContextForTest();
  resetSkillsContextForTest();
  resetFilesContextForTest();
  resetSessionOpsContextForTest();
  resetQuickRunContextForTest();
  resetRunControlContextForTest();
  resetObservationWiringForTest();
  // ensureObservationWiring 经 authStore.host 解析端点（host 为空 → 不启动）
  authStore.setState({ host: '192.168.1.100', pairState: 'paired' });
});

afterEach(() => {
  // 收口未打开的连接（握手看门狗/心跳句柄），杜绝 jest worker 强退告警
  resetObservationWiringForTest();
});

describe('命令域网关换代存活（H1 回归）', () => {
  it('models：同一 context 换代后 listModels 落到新代并 resolve，旧代零新帧', async () => {
    const gen1 = startGeneration();
    gen1.open();
    const ctx = getModelsContext();
    expect(ctx).not.toBeNull();

    const first = ctx!.repository.listModels();
    await tick();
    expect(gen1.framesOf('remote.listModels')).toHaveLength(1);
    gen1.respondOk('remote.listModels', MODELS_RESULT);
    await expect(first).resolves.toMatchObject({
      activeModel: { modelId: 'claude-sonnet' },
    });

    // 换代：dispose 旧接线并以全新 gateway/socket 重建。context 单例不
    // 复位——正是生产中毒场景（单例自首次装配后从未 reset）。
    resetObservationWiringForTest();
    const gen2 = startGeneration();
    gen2.open();

    const second = ctx!.repository.listModels();
    await tick();
    expect(gen1.framesOf('remote.listModels')).toHaveLength(1); // 旧代零新帧
    expect(gen2.framesOf('remote.listModels')).toHaveLength(1);
    gen2.respondOk('remote.listModels', MODELS_RESULT);
    await expect(second).resolves.toMatchObject({
      activeModel: { modelId: 'claude-sonnet' },
    });
    // 旧代挂起表已由 disconnect 清空（无悬挂 pending 残留）
    expect(gen1.gateway.pendingCount()).toBe(0);
  });

  it('skills：同一 context 换代后 listSkills 落到新代并 resolve，旧代零新帧', async () => {
    const gen1 = startGeneration();
    gen1.open();
    const ctx = getSkillsContext();
    expect(ctx).not.toBeNull();

    const first = ctx!.repository.listSkills();
    await tick();
    expect(gen1.framesOf('remote.listSkills')).toHaveLength(1);
    gen1.respondOk('remote.listSkills', SKILLS_RESULT);
    await expect(first).resolves.toMatchObject({
      skills: [{ name: 'my-skill' }],
    });

    resetObservationWiringForTest();
    const gen2 = startGeneration();
    gen2.open();

    const second = ctx!.repository.listSkills();
    await tick();
    expect(gen1.framesOf('remote.listSkills')).toHaveLength(1);
    expect(gen2.framesOf('remote.listSkills')).toHaveLength(1);
    gen2.respondOk('remote.listSkills', SKILLS_RESULT);
    await expect(second).resolves.toMatchObject({
      skills: [{ name: 'my-skill' }],
    });
    expect(gen1.gateway.pendingCount()).toBe(0);
  });

  it('其余四域 + monitor：换代后帧一律落到新代，旧代零新帧；拆线以 cmd.cancelled 结算', async () => {
    const gen1 = startGeneration();
    gen1.open();
    const files = getFilesContext();
    const ops = getSessionOpsContext();
    const quick = getQuickRunContext();
    const control = getRunControlContext();
    expect(files).not.toBeNull();
    expect(ops).not.toBeNull();
    expect(quick).not.toBeNull();
    expect(control).not.toBeNull();

    resetObservationWiringForTest();
    const gen2 = startGeneration();
    gen2.open();
    await tick(); // 等新代 FeedBridge 对账帧落定，取 listSessions 双代基线
    const gen1SessionsBase = gen1.framesOf('remote.listSessions').length;
    const gen2SessionsBase = gen2.framesOf('remote.listSessions').length;

    const settled: Promise<unknown>[] = [
      files!.repository.listWorkspaces().catch((e: unknown) => e),
      ops!.repository
        .renameSession({ sessionId: 's-1', title: '改名' })
        .catch((e: unknown) => e),
      ops!.monitor.listSessions({}).catch((e: unknown) => e),
      quick!.repository.runTask({ prompt: 'hi' }).catch((e: unknown) => e),
      control!.repository
        .runControl({ level: 'continue', runId: 'r-1', sessionId: 's-1' })
        .catch((e: unknown) => e),
    ];
    await tick();

    // 新代各命令帧恰一帧（listSessions 须在 FeedBridge 对账基线之上 +1）
    expect(gen2.framesOf('remote.listWorkspaces')).toHaveLength(1);
    expect(gen2.framesOf('remote.renameSession')).toHaveLength(1);
    expect(gen2.framesOf('remote.listSessions')).toHaveLength(
      gen2SessionsBase + 1
    );
    expect(gen2.framesOf('remote.runTask')).toHaveLength(1);
    expect(gen2.framesOf('remote.runControl')).toHaveLength(1);
    // 旧代零新帧（各 kind 与换代前基线一致）
    expect(gen1.framesOf('remote.listWorkspaces')).toHaveLength(0);
    expect(gen1.framesOf('remote.renameSession')).toHaveLength(0);
    expect(gen1.framesOf('remote.listSessions')).toHaveLength(gen1SessionsBase);
    expect(gen1.framesOf('remote.runTask')).toHaveLength(0);
    expect(gen1.framesOf('remote.runControl')).toHaveLength(0);

    // 收口：拆线使在途请求以 cmd.cancelled 结算（不悬挂到 10s 超时）
    resetObservationWiringForTest();
    for (const s of await Promise.all(settled)) {
      expect(s).toMatchObject({ code: 'cmd.cancelled' });
    }
  });

  it('无接线时 invoke 立即以 transport.closed 失败（不等 10s）', async () => {
    const gen1 = startGeneration();
    gen1.open();
    const ctx = getModelsContext();
    expect(ctx).not.toBeNull();

    resetObservationWiringForTest(); // 接线彻底拆除（无新代接管）
    const startedAt = Date.now();
    await expect(ctx!.repository.listModels()).rejects.toMatchObject({
      name: 'ModelsCommandError',
      code: 'transport.closed',
      retryable: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('接线存在但未 open（connecting）时同样立即 transport.closed', async () => {
    const gen1 = startGeneration();
    gen1.open();
    const ctx = getSkillsContext();
    expect(ctx).not.toBeNull();

    resetObservationWiringForTest();
    startGeneration(); // 新代已建但 socket 未 open（相位 connecting）
    const startedAt = Date.now();
    await expect(ctx!.repository.listSkills()).rejects.toMatchObject({
      name: 'SkillsCommandError',
      code: 'transport.closed',
      retryable: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('cmd.timeout 路径留 warn 日志（含命令名与错误码）', async () => {
    jest.useFakeTimers();
    const warnLines: string[] = [];
    configureLoggerForTest({
      sink: (level, line) => {
        if (level === 'warn') warnLines.push(line);
      },
    });
    try {
      // 收帧但永不回应的网关 → invoke 满 10s 超时（超时值本身不在本批改动）
      const gateway = new WsGateway({ send: () => {} });
      const repo = new GatewayModelsRepository(gateway);
      const pending = repo.listModels();
      const assertion = expect(pending).rejects.toMatchObject({
        code: 'cmd.timeout',
      });
      jest.advanceTimersByTime(10_000);
      await assertion;
      expect(
        warnLines.some(
          (l) => l.includes('listModels') && l.includes('cmd.timeout')
        )
      ).toBe(true);
    } finally {
      configureLoggerForTest();
      jest.useRealTimers();
    }
  });
});
