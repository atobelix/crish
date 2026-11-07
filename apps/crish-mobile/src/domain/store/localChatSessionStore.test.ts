// 本地对话会话 store 单测（CON-4/L2）：多线程形态的核心不变量——
// 线程创建/切换的运行时整表暂存恢复、流式回调按消息 id 落归属线程（隔离）、
// 持久化往返（重水化后线程与历史完整）、装配迟到时内存线程收编、
// 每线程模型选择保持、删除/清空的范围正确。
import {
  configureLocalChatSessionPersistence,
  deriveThreadTitle,
  localChatSessionStore,
  previewOfContent,
} from './localChatSessionStore';
import { MemorySqlDriver } from '@/db/driver';
import { migrateIfNeeded } from '@/db/db';
import {
  SqlLocalThreadsDao,
  type LocalThreadsDao,
} from '@/db/dao/localThreadsDao';
import { sessionStore } from './sessionStore';
import type { LocalChatMessage } from '../types/localChat';

function resetStore(): void {
  configureLocalChatSessionPersistence(null);
  localChatSessionStore.setState({
    threads: [],
    activeThreadId: null,
    inactive: {},
    hydrated: false,
    messages: [],
    streaming: false,
    error: null,
    completedAtByThread: {},
  });
}

async function freshDao(): Promise<LocalThreadsDao> {
  const driver = new MemorySqlDriver();
  await migrateIfNeeded(driver);
  return new SqlLocalThreadsDao(driver);
}

function userMsg(id: string, content: string): LocalChatMessage {
  return { id, role: 'user', content };
}

function assistantMsg(id: string): LocalChatMessage {
  return { id, role: 'assistant', content: '' };
}

/** 等一拍让尽力持久化的异步写入落定 */
function flushPersist(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  configureLocalChatSessionPersistence(null);
});

describe('localChatSessionStore truncateFrom（重新生成截断）', () => {
  it('自助手消息起（含）截断：提问保留、后续轮次全丢、持久化同步删除', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    const deleteFromSpy = jest.spyOn(dao, 'deleteMessagesFrom');

    const s = localChatSessionStore.getState();
    const threadId = s.createThread();
    s.appendUser(userMsg('a1', '锚点提问'));
    s.beginAssistant(assistantMsg('a2'));
    s.appendAssistantDelta('a2', '第一版回答');
    s.finishAssistant('a2');
    // 模拟后续 tool 轮次（截断必须连带丢弃）
    s.appendUser(userMsg('a3', 'tool 结果轮'), threadId);
    await flushPersist();
    deleteFromSpy.mockClear();

    s.truncateFrom('a2');

    const state = localChatSessionStore.getState();
    expect(state.messages.map((m) => m.id)).toEqual(['a1']);
    expect(state.messages[0]?.content).toBe('锚点提问');
    // 流式态复位（截断即终止任何进行中的生成标记）
    expect(state.streaming).toBe(false);
    // 持久化：seq >= 1（a2 的下标）全部删除
    expect(deleteFromSpy).toHaveBeenCalledWith(threadId, 1);
    // DAO 读回一致
    const persisted = await dao.listMessages(threadId);
    expect(persisted.map((m) => m.id)).toEqual(['a1']);
  });

  it('诚实 no-op：消息不存在 / 无线程时截断为空操作', () => {
    const s = localChatSessionStore.getState();
    s.createThread();
    s.appendUser(userMsg('a1', '唯一消息'));
    s.truncateFrom('不存在的消息');
    expect(localChatSessionStore.getState().messages.map((m) => m.id)).toEqual([
      'a1',
    ]);
    // 无线程 id（inactive 场景）不抛错
    expect(() => {
      localChatSessionStore.getState().truncateFrom('a1', 'lth-none');
    }).not.toThrow();
  });
});

describe('localChatSessionStore 多线程', () => {
  it('createThread：新建即激活；活动空线程复用不堆积', () => {
    const s = localChatSessionStore.getState();
    const first = s.createThread({ providerId: 'p1', modelId: 'm1' });
    expect(localChatSessionStore.getState().activeThreadId).toBe(first);
    // 活动线程仍为空 → 再次 create 返回同一 id（且可改模型快照）
    const again = localChatSessionStore.getState().createThread(null);
    expect(again).toBe(first);
    expect(localChatSessionStore.getState().threads).toHaveLength(1);
    expect(localChatSessionStore.getState().threads[0]?.modelRef).toBeNull();
  });

  it('appendUser 无线程时自动建线程；首条消息生成标题与摘要', () => {
    const s = localChatSessionStore.getState();
    s.appendUser(userMsg('u1', '  帮我 写一首 关于秋天的 诗 '));
    const state = localChatSessionStore.getState();
    expect(state.activeThreadId).not.toBeNull();
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]?.title).toBe('帮我 写一首 关于秋天的 诗');
    expect(state.threads[0]?.preview).toBe('帮我 写一首 关于秋天的 诗');
    expect(state.messages.map((m) => m.id)).toEqual(['u1']);
    // 第二条消息不改标题
    state.appendUser(userMsg('u2', '再来一首'));
    expect(localChatSessionStore.getState().threads[0]?.title).toBe(
      '帮我 写一首 关于秋天的 诗'
    );
  });

  it('切换线程：运行时整表暂存/恢复，各线程消息互不可见', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('a1', '线程甲的问题'));
    const b = localChatSessionStore.getState().createThread();
    expect(b).not.toBe(a);
    localChatSessionStore.getState().appendUser(userMsg('b1', '线程乙的问题'));
    expect(localChatSessionStore.getState().messages.map((m) => m.id)).toEqual([
      'b1',
    ]);
    localChatSessionStore.getState().openThread(a);
    const back = localChatSessionStore.getState();
    expect(back.activeThreadId).toBe(a);
    expect(back.messages.map((m) => m.id)).toEqual(['a1']);
    expect(back.threads.map((t) => t.id)).toContain(b);
  });

  it('流式隔离：甲线程生成中切到乙，增量与收尾仍落甲；乙可独立发送', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('a1', '甲问'));
    s.beginAssistant(assistantMsg('a2'));
    localChatSessionStore.getState().createThread();
    const s2 = localChatSessionStore.getState();
    // 甲被暂存且仍标记生成中
    expect(s2.inactive[a]?.streaming).toBe(true);
    s2.appendUser(userMsg('b1', '乙问'));
    s2.beginAssistant(assistantMsg('b2'));
    // 甲的增量在乙活动时到达 → 落甲不落乙
    s2.appendAssistantDelta('a2', '甲的回答');
    expect(
      localChatSessionStore.getState().messages.find((m) => m.id === 'b2')
        ?.content
    ).toBe('');
    expect(
      localChatSessionStore.getState().inactive[a]?.messages[1]?.content
    ).toBe('甲的回答');
    // 甲收尾只清甲的生成态，乙仍在生成
    localChatSessionStore.getState().finishAssistant('a2');
    const after = localChatSessionStore.getState();
    expect(after.inactive[a]?.streaming).toBe(false);
    expect(after.streaming).toBe(true);
    // 乙的历史组装只含乙的消息（上下文隔离的直接证据）
    expect(after.messages.map((m) => m.id)).toEqual(['b1', 'b2']);
  });

  it('deleteThread：活动线程被删激活最近线程；非活动线程被删不扰动当前', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('a1', '甲'));
    const b = localChatSessionStore.getState().createThread();
    localChatSessionStore.getState().appendUser(userMsg('b1', '乙'));
    localChatSessionStore.getState().deleteThread(a);
    let state = localChatSessionStore.getState();
    expect(state.activeThreadId).toBe(b);
    expect(state.messages.map((m) => m.id)).toEqual(['b1']);
    localChatSessionStore.getState().deleteThread(b);
    state = localChatSessionStore.getState();
    expect(state.activeThreadId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.threads).toEqual([]);
  });

  it('clearThread 只清目标线程消息，标题回占位，他线程不动', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('a1', '甲问'));
    localChatSessionStore.getState().createThread();
    localChatSessionStore.getState().appendUser(userMsg('b1', '乙问'));
    localChatSessionStore.getState().clearThread(a);
    const state = localChatSessionStore.getState();
    expect(state.inactive[a]?.messages).toEqual([]);
    expect(state.threads.find((t) => t.id === a)?.title).toBe('新对话');
    expect(state.messages.map((m) => m.id)).toEqual(['b1']);
  });
});

describe('localChatSessionStore 持久化', () => {
  it('往返：写入 → 重置 → hydrate 后线程与历史完整、模型选择保持', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    const s = localChatSessionStore.getState();
    const a = s.createThread({ providerId: 'p1', modelId: 'm1' });
    s.appendUser(userMsg('a1', '持久化问题'));
    s.beginAssistant(assistantMsg('a2'));
    s.appendAssistantDelta('a2', '持久化回答');
    s.finishAssistant('a2');
    // 拉开时间戳距离，保证 updatedAt 排序确定性（活动线程 = 最近更新）
    await new Promise((resolve) => setTimeout(resolve, 3));
    const b = localChatSessionStore.getState().createThread({
      providerId: 'p2',
      modelId: 'm2',
    });
    localChatSessionStore.getState().appendUser(userMsg('b1', '第二线程'));
    await flushPersist();

    // 模拟冷启动：store 全量重置后从同一 DAO 水合
    resetStore();
    configureLocalChatSessionPersistence(dao);
    await localChatSessionStore.getState().hydrate();
    const state = localChatSessionStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.threads.map((t) => t.id).sort()).toEqual([a, b].sort());
    expect(state.threads.find((t) => t.id === a)?.modelRef).toEqual({
      providerId: 'p1',
      modelId: 'm1',
    });
    // 活动 = 最近更新线程（b），其历史完整
    expect(state.activeThreadId).toBe(b);
    expect(state.messages.map((m) => m.content)).toEqual(['第二线程']);
    // 甲线程历史在 inactive 中完整（含收尾后的助手全文）
    expect(state.inactive[a]?.messages.map((m) => m.content)).toEqual([
      '持久化问题',
      '持久化回答',
    ]);
    expect(state.inactive[a]?.messages[1]?.streaming).toBeUndefined();
  });

  it('收编：hydrate 前内存已有消息（装配迟到）→ 收编为已存线程并落盘', async () => {
    const dao = await freshDao();
    // DAO 未注入时先聊（DB 装配迟到）：纯内存线程
    const s = localChatSessionStore.getState();
    s.appendUser(userMsg('u1', '先聊起来'));
    s.beginAssistant(assistantMsg('u2'));
    s.appendAssistantDelta('u2', '内存回答');
    s.finishAssistant('u2');

    configureLocalChatSessionPersistence(dao);
    await localChatSessionStore.getState().hydrate();
    const state = localChatSessionStore.getState();
    expect(state.threads).toHaveLength(1);
    expect(state.messages.map((m) => m.content)).toEqual([
      '先聊起来',
      '内存回答',
    ]);
    // 已落盘：DAO 直读可见
    const persisted = await dao.listThreads();
    expect(persisted).toHaveLength(1);
    expect(await dao.listMessages(persisted[0]!.id)).toHaveLength(2);
  });

  it('无 DAO（DB 降级）：hydrate 只置位，内存形态照常工作', async () => {
    await localChatSessionStore.getState().hydrate();
    const s = localChatSessionStore.getState();
    expect(s.hydrated).toBe(true);
    s.appendUser(userMsg('u1', '离线也能聊'));
    expect(localChatSessionStore.getState().messages).toHaveLength(1);
  });

  it('设备分区独立性：远程 sessionStore 整体重置不影响本地线程', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    const s = localChatSessionStore.getState();
    s.appendUser(userMsg('u1', '本地问题'));
    await flushPersist();
    const before = localChatSessionStore.getState().threads;
    // 模拟切换设备时远程面整表替换/清空（解绑/换机的 reset 动作）
    sessionStore.getState().reset();
    expect(localChatSessionStore.getState().threads).toEqual(before);
    expect(localChatSessionStore.getState().messages).toHaveLength(1);
  });
});

describe('标题 / 摘要纯文本纪律（MD3：列表面不泄漏 markdown 标记）', () => {
  it('deriveThreadTitle：行内标记只留文本，标题标记不进标题', () => {
    expect(deriveThreadTitle('**重点** 讨论 `方案`')).toBe('重点 讨论 方案');
    expect(deriveThreadTitle('# 周报标题')).toBe('周报标题');
    expect(deriveThreadTitle('')).toBe('新对话');
  });

  it('previewOfContent：表格与代码围栏只留文本内容', () => {
    const table = previewOfContent(
      '| 列甲 | 列乙 |\n| --- | --- |\n| 甲一 | 乙一 |'
    );
    expect(table).toBe('列甲 列乙 甲一 乙一');
    expect(table).not.toContain('|');
    const code = previewOfContent('```ts\nconst a = 1;\n```');
    expect(code).toContain('const a = 1;');
    expect(code).not.toContain('```');
  });

  it('线程全程：首条用户消息带标记时，落盘 meta 标题已是纯文本', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    const s = localChatSessionStore.getState();
    s.appendUser(userMsg('u1', '帮我看看 **这段** 代码'));
    const meta = localChatSessionStore.getState().threads[0]!;
    expect(meta.title).toBe('帮我看看 这段 代码');
    await flushPersist();
    const persisted = await dao.listThreads();
    expect(persisted[0]!.title).toBe('帮我看看 这段 代码');
  });
});

describe('localChatSessionStore 完成打点（状态板本地「刚完成」资格面）', () => {
  it('finishAssistant 打点；新一轮 beginAssistant 清点；deleteThread 删点', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('a1', '问题'));
    s.beginAssistant(assistantMsg('a2'));
    expect(
      localChatSessionStore.getState().completedAtByThread[a]
    ).toBeUndefined();
    s.finishAssistant('a2');
    expect(typeof localChatSessionStore.getState().completedAtByThread[a]).toBe(
      'number'
    );
    // 新一轮生成开始 → 回到运行中口径，打点清除
    localChatSessionStore.getState().beginAssistant(assistantMsg('a3'));
    expect(
      localChatSessionStore.getState().completedAtByThread[a]
    ).toBeUndefined();
    localChatSessionStore.getState().finishAssistant('a3');
    expect(
      localChatSessionStore.getState().completedAtByThread[a]
    ).toBeDefined();
    localChatSessionStore.getState().deleteThread(a);
    expect(
      localChatSessionStore.getState().completedAtByThread[a]
    ).toBeUndefined();
  });
});

describe('标题来源阶梯（U4：只升不降，user 封顶）', () => {
  it('建线程 placeholder → 首条消息 derived（成对推进）', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    expect(localChatSessionStore.getState().threads[0]?.titleSource).toBe(
      'placeholder'
    );
    s.appendUser(userMsg('u1', '第一个问题'));
    const meta = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === a);
    expect(meta?.title).toBe('第一个问题');
    expect(meta?.titleSource).toBe('derived');
  });

  it('setThreadTitle：ai 覆盖 derived；同级/降级一律拒绝；user 封顶后 AI 迟到结果被丢弃', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('u1', '原始问题'));
    const st = () => localChatSessionStore.getState();
    // ai 升 derived → 写入
    expect(st().setThreadTitle(a, 'AI 起的标题', 'ai')).toBe(true);
    expect(st().threads[0]?.title).toBe('AI 起的标题');
    expect(st().threads[0]?.titleSource).toBe('ai');
    // 同级 ai 再写 → 拒绝；derived 降级 → 拒绝
    expect(st().setThreadTitle(a, '另一个 AI 标题', 'ai')).toBe(false);
    expect(st().setThreadTitle(a, '降级标题', 'derived')).toBe(false);
    expect(st().threads[0]?.title).toBe('AI 起的标题');
    // user 升 ai → 写入（用户改名）
    expect(st().setThreadTitle(a, '用户改名', 'user')).toBe(true);
    expect(st().threads[0]?.titleSource).toBe('user');
    // 用户改名后到达的 AI 迟到结果 → 丢弃（桌面 sessionTitle 同纪律）
    expect(st().setThreadTitle(a, '迟到的 AI 标题', 'ai')).toBe(false);
    expect(st().threads[0]?.title).toBe('用户改名');
    // 空标题与未知线程 → 拒绝
    expect(st().setThreadTitle(a, '   ', 'user')).toBe(false);
    expect(st().setThreadTitle('missing', '标题', 'user')).toBe(false);
  });

  it('clearThread：标题与来源成对重置，新一轮可重新派生与 AI 升级', () => {
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('u1', '旧问题'));
    expect(
      localChatSessionStore.getState().setThreadTitle(a, '用户题', 'user')
    ).toBe(true);
    localChatSessionStore.getState().clearThread(a);
    const cleared = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === a);
    expect(cleared?.title).toBe('新对话');
    expect(cleared?.titleSource).toBe('placeholder');
    // 清空后重聊：首条消息重新派生（旧 user 来源不再压制）
    localChatSessionStore.getState().appendUser(userMsg('u2', '新问题'));
    const again = localChatSessionStore
      .getState()
      .threads.find((t) => t.id === a);
    expect(again?.title).toBe('新问题');
    expect(again?.titleSource).toBe('derived');
  });

  it('AI 标题落盘：setThreadTitle 后 DAO 读回标题与来源', async () => {
    const dao = await freshDao();
    configureLocalChatSessionPersistence(dao);
    const s = localChatSessionStore.getState();
    const a = s.createThread();
    s.appendUser(userMsg('u1', '落盘问题'));
    await flushPersist();
    expect(
      localChatSessionStore.getState().setThreadTitle(a, '落盘 AI 标题', 'ai')
    ).toBe(true);
    await flushPersist();
    const persisted = await dao.listThreads();
    expect(persisted.find((t) => t.id === a)).toMatchObject({
      title: '落盘 AI 标题',
      titleSource: 'ai',
    });
  });
});

describe('localChatSessionStore 槽位隔离与重置 (维度 1)', () => {
  it('resetActiveThread：存在消息的活动线程归入 inactive 表，前台运行时彻底清空', () => {
    const s = localChatSessionStore.getState();
    const threadId = s.createThread();
    s.appendUser(userMsg('u1', '会话一内容'));
    s.beginAssistant(assistantMsg('a1'));
    s.appendAssistantDelta('a1', '助手回复一');

    expect(localChatSessionStore.getState().activeThreadId).toBe(threadId);
    expect(localChatSessionStore.getState().messages).toHaveLength(2);

    // 执行槽位重置
    localChatSessionStore.getState().resetActiveThread();

    const state = localChatSessionStore.getState();
    expect(state.activeThreadId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.streaming).toBe(false);
    expect(state.error).toBeNull();

    // 历史完整保留在 inactive 表中
    expect(state.inactive[threadId]?.messages).toHaveLength(2);
    expect(state.inactive[threadId]?.messages[0]?.content).toBe('会话一内容');
  });

  it('resetActiveThread：未产生任何消息的空白空线程被物理剔除，防止堆积幽灵线程', () => {
    const s = localChatSessionStore.getState();
    const emptyId = s.createThread();
    expect(
      localChatSessionStore.getState().threads.some((t) => t.id === emptyId)
    ).toBe(true);

    // 未发送任何消息即执行重置
    localChatSessionStore.getState().resetActiveThread();

    const state = localChatSessionStore.getState();
    expect(state.activeThreadId).toBeNull();
    // threads 中已被彻底清理
    expect(state.threads.some((t) => t.id === emptyId)).toBe(false);
    expect(state.inactive[emptyId]).toBeUndefined();
  });

  it('后台流式生成中执行 resetActiveThread，后续 delta 仍能精准追加进 inactive 表', () => {
    const s = localChatSessionStore.getState();
    const threadId = s.createThread();
    s.appendUser(userMsg('u1', '正在生成的任务'));
    s.beginAssistant(assistantMsg('a1'));

    // 切走重置
    s.resetActiveThread();
    expect(localChatSessionStore.getState().activeThreadId).toBeNull();

    // 后台收到流式数据
    localChatSessionStore
      .getState()
      .appendAssistantDelta('a1', '后台追加的内容');
    localChatSessionStore.getState().finishAssistant('a1');

    const state = localChatSessionStore.getState();
    const saved = state.inactive[threadId]?.messages[1];
    expect(saved?.content).toBe('后台追加的内容');
    expect(state.inactive[threadId]?.streaming).toBe(false);
  });

  it('切走空线程（openThread / createThread）：未产生任何消息的空白空线程同样被物理剔除', () => {
    const s = localChatSessionStore.getState();
    const nonEmpty = s.createThread();
    s.appendUser(userMsg('u1', '已有消息'));
    const empty = localChatSessionStore.getState().createThread();
    expect(
      localChatSessionStore.getState().threads.some((t) => t.id === empty)
    ).toBe(true);

    // 此时 empty 为活动空线程；切回 nonEmpty 时，empty 应被物理剔除
    localChatSessionStore.getState().openThread(nonEmpty);
    expect(
      localChatSessionStore.getState().threads.some((t) => t.id === empty)
    ).toBe(false);
    expect(localChatSessionStore.getState().inactive[empty]).toBeUndefined();
  });
});

describe('localChatSessionStore 思考链与状态机 (Reasoning)', () => {
  it('appendAssistantReasoningDelta：正确累加 reasoning，并将 isThinking 设为 true', () => {
    const s = localChatSessionStore.getState();
    s.createThread();
    s.appendUser(userMsg('u1', '请分析这个问题'));
    s.beginAssistant(assistantMsg('a1'));

    // 初始状态
    let msg = localChatSessionStore
      .getState()
      .messages.find((m) => m.id === 'a1');
    expect(msg?.reasoning).toBeUndefined();
    expect(msg?.isThinking).toBeUndefined();

    // 第一次思考增量
    localChatSessionStore
      .getState()
      .appendAssistantReasoningDelta('a1', '正在分析题目条件...');
    msg = localChatSessionStore.getState().messages.find((m) => m.id === 'a1');
    expect(msg?.reasoning).toBe('正在分析题目条件...');
    expect(msg?.isThinking).toBe(true);

    // 第二次思考增量：继续累加，isThinking 保持 true
    localChatSessionStore
      .getState()
      .appendAssistantReasoningDelta('a1', '条件满足，开始推导。');
    msg = localChatSessionStore.getState().messages.find((m) => m.id === 'a1');
    expect(msg?.reasoning).toBe('正在分析题目条件...条件满足，开始推导。');
    expect(msg?.isThinking).toBe(true);

    // 正文增量到达：保持正文与思考链独立，reasoning 不被破坏
    localChatSessionStore
      .getState()
      .appendAssistantDelta('a1', '推导结果如下：');
    msg = localChatSessionStore.getState().messages.find((m) => m.id === 'a1');
    expect(msg?.content).toBe('推导结果如下：');
    expect(msg?.reasoning).toBe('正在分析题目条件...条件满足，开始推导。');
    expect(msg?.isThinking).toBe(true);
  });

  it('appendAssistantReasoningDelta 支持非活动后台线程定位写入', () => {
    const s = localChatSessionStore.getState();
    const threadA = s.createThread();
    s.appendUser(userMsg('u1', '线程 A'));
    s.beginAssistant(assistantMsg('a1'));

    // 切换到新线程 B
    const threadB = localChatSessionStore.getState().createThread();
    localChatSessionStore.getState().appendUser(userMsg('u2', '线程 B'));

    // 此时后台收到 A 的思考增量
    localChatSessionStore
      .getState()
      .appendAssistantReasoningDelta('a1', '线程 A 后台思考中');

    const state = localChatSessionStore.getState();
    expect(state.activeThreadId).toBe(threadB);
    const backgroundMsg = state.inactive[threadA]?.messages.find(
      (m) => m.id === 'a1'
    );
    expect(backgroundMsg?.reasoning).toBe('线程 A 后台思考中');
    expect(backgroundMsg?.isThinking).toBe(true);
  });

  it('finishAssistant：将 isThinking 设为 false，并正确持久化包含 reasoning 的消息', async () => {
    const dao = await freshDao();
    const saveMessageSpy = jest.spyOn(dao, 'saveMessage');
    configureLocalChatSessionPersistence(dao);

    const s = localChatSessionStore.getState();
    const threadId = s.createThread();
    s.appendUser(userMsg('u1', '求证结论'));
    s.beginAssistant(assistantMsg('a1'));

    // 流式注入思考链
    localChatSessionStore
      .getState()
      .appendAssistantReasoningDelta('a1', '第一步反证法...得出矛盾。');
    const currentMsg = localChatSessionStore
      .getState()
      .messages.find((m) => m.id === 'a1');
    expect(currentMsg?.isThinking).toBe(true);
    expect(currentMsg?.reasoning).toBe('第一步反证法...得出矛盾。');

    // 正文注入
    localChatSessionStore.getState().appendAssistantDelta('a1', '结论得证。');

    // finishAssistant 收尾，并传入额外 patch 字段验证合并
    localChatSessionStore.getState().finishAssistant('a1', { stopped: false });
    await flushPersist();

    const finalMsg = localChatSessionStore
      .getState()
      .messages.find((m) => m.id === 'a1');
    expect(finalMsg?.streaming).toBe(false);
    expect(finalMsg?.isThinking).toBe(false);
    expect(finalMsg?.stopped).toBe(false);
    expect(finalMsg?.content).toBe('结论得证。');
    expect(finalMsg?.reasoning).toBe('第一步反证法...得出矛盾。');

    // 验证 DAO 持久化调用携带了完整 reasoning 与 isThinking: false
    expect(saveMessageSpy).toHaveBeenCalledWith(
      threadId,
      expect.any(Number),
      expect.objectContaining({
        id: 'a1',
        content: '结论得证。',
        reasoning: '第一步反证法...得出矛盾。',
        isThinking: false,
        streaming: false,
      })
    );
  });
});
