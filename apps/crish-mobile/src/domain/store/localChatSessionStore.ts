// 本地对话会话 store（CON-4/L2 多线程形态，2026-11-02 用户裁决）：
// 本地对话与普通对话同级——多线程、历史落盘（SQLite local_threads /
// local_messages，经注入的 LocalThreadsDao）、与远程会话完全分开（不进
// 远程会话列表、不经 RelaySocket；远程按设备分区，本地是手机自身分区）。
// 配置面与凭据纪律不变（localChatStore：配置 kv 持久化、key 只进 SecureStore，
// 本 store 与 DAO 都不接触任何密钥材料）。
//
// 状态形态（活动缓冲模型）：
// - threads：线程元数据（updatedAt 降序），是列表呈现与 hub 同列的数据面；
// - 活动线程的运行时（messages/streaming/error）即顶层同名字段——既有消费面
//   （旧 VM 形态、测试 setState）零改动兼容；
// - 非活动线程的运行时收在 inactive 表：切走时整表暂存、切回时整表恢复，
//   生成中的线程切走再切回状态不丢失（流式回调按消息 id 定位归属线程写入，
//   与当前活动线程无关——多线程上下文严格隔离）；
// - 持久化为尽力而为（注入缺失/写入失败不阻断交互，内存态即时生效，与
//   localChatStore 的 writeConfig 同口径）；线程元数据懒落盘（首条消息
//   落盘时连带 upsert，空线程不进库，避免「新建即污染历史」）。
import { createStore, type StoreApi } from 'zustand/vanilla';
import { immer } from 'zustand/middleware/immer';
import type {
  LocalChatError,
  LocalChatMessage,
  LocalModelRef,
  LocalThreadMeta,
  LocalThreadTitleSource,
} from '../types/localChat';
import { nextId } from '../pure/id';
import { markdownPreviewText } from '../pure/markdown/plainText';
import type { LocalThreadsDao } from '@/db/dao/localThreadsDao';

/** 单线程运行时（活动线程用顶层投影字段，非活动线程收进 inactive 表） */
export interface LocalThreadRuntime {
  messages: LocalChatMessage[];
  streaming: boolean;
  error: LocalChatError | null;
}

/** 空线程占位标题（首条用户消息到达时被 deriveThreadTitle 替换） */
export const LOCAL_THREAD_PLACEHOLDER_TITLE = '新对话';

/**
 * 标题来源阶梯序（U4）：自动机制只升不降——与桌面 sessionTitle.ts 的
 * 纪律对齐（其 autoTitleAssignment 在 titleSource='user' 时直接返回 null，
 * 用户改名永不被自动标题覆盖）。本阶梯是该纪律在四值来源上的推广：
 * user 封顶；ai 只许覆盖 placeholder/derived；derived 只许覆盖 placeholder。
 */
export const TITLE_SOURCE_RANK: Record<LocalThreadTitleSource, number> = {
  placeholder: 0,
  derived: 1,
  ai: 2,
  user: 3,
};

export interface LocalChatSessionState {
  /** 线程元数据（updatedAt 降序） */
  threads: LocalThreadMeta[];
  /** 活动线程 id（null = 尚无线程；此时顶层投影即无线程运行时） */
  activeThreadId: string | null;
  /** 非活动线程运行时（按线程 id 索引） */
  inactive: Record<string, LocalThreadRuntime>;
  /** 历史水合完成标志（DB 装配迟到时 UI 先以内存态呈现） */
  hydrated: boolean;
  /**
   * 线程完成打点（进程内，不落盘）：threadId → 最近一次生成完成时刻 ms。
   * 主界面状态板本地「刚完成」资格面——本地对话没有「连接」概念，以「本进程内
   * 完成」为界（进程重启即清零，历史线程不进状态板，与远端口径一致）。
   * finishAssistant 打点；beginAssistant（新一轮生成）/删线程/清线程时清除。
   */
  completedAtByThread: Record<string, number>;

  /** 活动线程消息（投影：活动线程的运行时本体） */
  messages: LocalChatMessage[];
  /** 活动线程生成中 */
  streaming: boolean;
  /** 活动线程最近一次失败（横幅呈现；下一次发送时清除） */
  error: LocalChatError | null;

  /** 启动水合：从 DAO 读齐线程+历史；内存中已有内容（装配迟到）时收编落盘 */
  hydrate: (dao?: LocalThreadsDao) => Promise<void>;
  /** 新建线程并激活（modelRef = 创建时模型快照，null = 跟随全局）；返回线程 id。
   *  活动线程为空且未生成时复用之（不堆积空线程）。 */
  createThread: (modelRef?: LocalModelRef | null) => string;
  /** 切换活动线程（运行时整表暂存/恢复） */
  openThread: (threadId: string) => void;
  /** 删除线程（连带历史；活动线程被删则激活最近线程或回到无线程态） */
  deleteThread: (threadId: string) => void;
  /** 设某线程的模型选择（持久化） */
  setThreadModel: (threadId: string, modelRef: LocalModelRef | null) => void;
  /**
   * 写线程标题（来源阶梯守卫：只升不降，见 TITLE_SOURCE_RANK；空标题与
   * 同级/降级写入一律拒绝）。AI 生成走 source='ai'，用户改名走 'user'。
   * @returns 是否真正写入（迟到结果撞上更高来源时返回 false 并丢弃）
   */
  setThreadTitle: (
    threadId: string,
    title: string,
    source: LocalThreadTitleSource
  ) => boolean;

  appendUser: (message: LocalChatMessage, threadId?: string) => void;
  beginAssistant: (message: LocalChatMessage, threadId?: string) => void;
  appendAssistantDelta: (id: string, delta: string) => void;
  finishAssistant: (id: string, patch?: Partial<LocalChatMessage>) => void;
  setError: (error: LocalChatError | null, threadId?: string) => void;
  setStreaming: (streaming: boolean, threadId?: string) => void;
  clearThread: (threadId?: string) => void;
}

/** 默认持久化注入（persistBootstrap 装配时注入；测试按 hydrate 参数优先） */
let defaultDao: LocalThreadsDao | null = null;

export function configureLocalChatSessionPersistence(
  dao: LocalThreadsDao | null
): void {
  defaultDao = dao;
}

function daoOf(dao?: LocalThreadsDao): LocalThreadsDao | null {
  return dao ?? defaultDao;
}

/**
 * 线程 meta 的落盘快照（深拷贝 modelRef）：set 内的 meta 是 immer draft，
 * 浅展开会把 modelRef 子 draft 一并带出，producer 结束后 draft 被回收，
 * 异步落盘读字段会抛 revoked proxy —— 快照必须在 producer 内完成深拷贝。
 */
function snapshotMeta(meta: LocalThreadMeta): LocalThreadMeta {
  return {
    ...meta,
    modelRef: meta.modelRef ? { ...meta.modelRef } : null,
  };
}

/** 尽力持久化（失败静默：内存态已生效，不阻断交互） */
function persist(fn: (dao: LocalThreadsDao) => Promise<void>): void {
  const dao = defaultDao;
  if (!dao) return;
  void fn(dao).catch(() => {
    // 写入失败静默（同 writeConfig 口径）
  });
}

/** 标题派生：首条用户消息 → markdown 纯文本摘取 → 单行、截断 24 字（MD3 列表面纪律：标记不进标题） */
export function deriveThreadTitle(content: string): string {
  const oneLine = markdownPreviewText(content).replace(/\s+/g, ' ').trim();
  if (oneLine === '') return LOCAL_THREAD_PLACEHOLDER_TITLE;
  return oneLine.length > 24 ? `${oneLine.slice(0, 24)}…` : oneLine;
}

/** 摘要派生：末条消息 → markdown 纯文本摘取 → 单行、截断 80 字（MD3 列表面纪律：标记不进摘要） */
export function previewOfContent(content: string): string {
  const oneLine = markdownPreviewText(content).replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** 线程排序：updatedAt 降序 → createdAt 降序 → id 升序（确定性兜底） */
export function sortThreadMetas(
  metas: readonly LocalThreadMeta[]
): LocalThreadMeta[] {
  return [...metas].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * 取某线程的运行时草稿（活动线程 = state 本人：其 messages/streaming/error
 * 字段与 LocalThreadRuntime 同名同义，强转即投影本体，immer 下读写直达）。
 */
function runtimeFor(
  state: LocalChatSessionState,
  threadId: string | null
): LocalThreadRuntime | null {
  if (threadId === null || threadId === state.activeThreadId) {
    return state as unknown as LocalThreadRuntime;
  }
  return state.inactive[threadId] ?? null;
}

/** 触碰线程元数据（更新时间 + 可选摘要）并维持排序；返回最新元数据 */
function touchMeta(
  state: LocalChatSessionState,
  threadId: string,
  now: number,
  preview?: string
): LocalThreadMeta | null {
  const meta = state.threads.find((t) => t.id === threadId);
  if (!meta) return null;
  meta.updatedAt = now;
  if (preview !== undefined) meta.preview = preview;
  state.threads = sortThreadMetas(state.threads);
  return meta;
}

/** 定位消息归属线程（流式回调按消息 id 写入，与活动线程无关 → 隔离的根基） */
function locateMessage(
  state: LocalChatSessionState,
  messageId: string
): {
  threadId: string | null;
  runtime: LocalThreadRuntime;
  index: number;
} | null {
  const activeIndex = state.messages.findIndex((m) => m.id === messageId);
  if (activeIndex >= 0) {
    return {
      threadId: state.activeThreadId,
      runtime: state as unknown as LocalThreadRuntime,
      index: activeIndex,
    };
  }
  for (const [threadId, runtime] of Object.entries(state.inactive)) {
    const index = runtime.messages.findIndex((m) => m.id === messageId);
    if (index >= 0) return { threadId, runtime, index };
  }
  return null;
}

/** 线程运行时只读快照（引擎发送前读历史/生成态；未知线程 → null） */
export function threadRuntimeSnapshot(
  threadId: string
): { messages: readonly LocalChatMessage[]; streaming: boolean } | null {
  const state = localChatSessionStore.getState();
  if (!state.threads.some((t) => t.id === threadId)) return null;
  if (state.activeThreadId === threadId) {
    return { messages: state.messages, streaming: state.streaming };
  }
  const runtime = state.inactive[threadId];
  return runtime
    ? { messages: runtime.messages, streaming: runtime.streaming }
    : { messages: [], streaming: false };
}

export const localChatSessionStore: StoreApi<LocalChatSessionState> =
  createStore<LocalChatSessionState>()(
    immer((set, get) => ({
      threads: [],
      activeThreadId: null,
      inactive: {},
      hydrated: false,
      completedAtByThread: {},
      messages: [],
      streaming: false,
      error: null,

      hydrate: async (dao) => {
        if (get().hydrated) return;
        const d = daoOf(dao);
        const pre = get();
        // 收编快照：DB 装配迟到时内存里可能已有线程与消息（内存态先行），
        // 它们不在库中 → 整线程收编为已存线程（「首次持久化时收编」口径）。
        const memoryThreads: {
          meta: LocalThreadMeta;
          messages: LocalChatMessage[];
          wasActive: boolean;
        }[] = [];
        for (const meta of pre.threads) {
          const runtime =
            meta.id === pre.activeThreadId
              ? { messages: pre.messages }
              : pre.inactive[meta.id];
          memoryThreads.push({
            meta,
            messages: [...(runtime?.messages ?? [])],
            wasActive: meta.id === pre.activeThreadId,
          });
        }
        if (pre.activeThreadId === null && pre.messages.length > 0) {
          // 无线程时代的散装消息（旧形态兼容）：收编为第一条已存线程
          const now = Date.now();
          const firstUser = pre.messages.find((m) => m.role === 'user');
          const last = pre.messages[pre.messages.length - 1];
          memoryThreads.push({
            meta: {
              id: nextId('lth'),
              title: deriveThreadTitle(firstUser?.content ?? ''),
              titleSource: 'derived',
              preview: previewOfContent(last?.content ?? ''),
              modelRef: null,
              createdAt: now,
              updatedAt: now,
            },
            messages: [...pre.messages],
            wasActive: true,
          });
        }

        let loaded: { meta: LocalThreadMeta; messages: LocalChatMessage[] }[] =
          [];
        if (d) {
          try {
            const metas = await d.listThreads();
            const all = await d.listAllMessages();
            const byThread = new Map<string, LocalChatMessage[]>();
            for (const row of all) {
              const bucket = byThread.get(row.threadId) ?? [];
              bucket.push(row.message);
              byThread.set(row.threadId, bucket);
            }
            loaded = metas.map((meta) => ({
              meta,
              messages: byThread.get(meta.id) ?? [],
            }));
          } catch {
            loaded = [];
          }
        }
        const loadedIds = new Set(loaded.map((t) => t.meta.id));
        const adopted = memoryThreads.filter((t) => !loadedIds.has(t.meta.id));
        if (d && adopted.length > 0) {
          for (const t of adopted) {
            try {
              await d.upsertThread(t.meta);
              for (const [seq, message] of t.messages.entries()) {
                await d.saveMessage(t.meta.id, seq, message);
              }
            } catch {
              // 收编落盘失败不阻断水合（内存态完整，诚实降级为本次会话内有效）
            }
          }
        }
        const merged = sortThreadMetas([
          ...loaded.map((t) => t.meta),
          ...adopted.map((t) => t.meta),
        ]);
        const messagesOf = new Map<string, LocalChatMessage[]>();
        for (const t of loaded) messagesOf.set(t.meta.id, t.messages);
        for (const t of adopted) messagesOf.set(t.meta.id, t.messages);
        // 活动线程选择：用户水合前正在用的收编线程优先，其次水合前的活动
        // 线程（若在合并集内），最后取最近更新线程。
        const activeId =
          adopted.find((t) => t.wasActive)?.meta.id ??
          (pre.activeThreadId !== null &&
          merged.some((t) => t.id === pre.activeThreadId)
            ? pre.activeThreadId
            : null) ??
          merged[0]?.id ??
          null;
        set((s) => {
          s.threads = merged;
          s.activeThreadId = activeId;
          s.inactive = {};
          for (const meta of merged) {
            if (meta.id === activeId) continue;
            s.inactive[meta.id] = {
              messages: messagesOf.get(meta.id) ?? [],
              streaming: false,
              error: null,
            };
          }
          const activeMessages =
            activeId !== null ? (messagesOf.get(activeId) ?? []) : [];
          // 水合前正在生成的活动线程（收编且仍在流式）保留其生成态标记
          const wasStreaming =
            activeId !== null &&
            adopted.some((t) => t.meta.id === activeId && t.wasActive)
              ? pre.streaming
              : false;
          s.messages = activeMessages;
          s.streaming = wasStreaming;
          s.error = null;
          s.hydrated = true;
        });
      },

      createThread: (modelRef) => {
        const state = get();
        // 活动线程为空且未生成 → 复用（避免连续点「新建」堆积空线程）
        if (
          state.activeThreadId !== null &&
          state.messages.length === 0 &&
          !state.streaming
        ) {
          const existingId = state.activeThreadId;
          if (modelRef !== undefined) {
            get().setThreadModel(existingId, modelRef);
          }
          return existingId;
        }
        const id = nextId('lth');
        const now = Date.now();
        const meta: LocalThreadMeta = {
          id,
          title: LOCAL_THREAD_PLACEHOLDER_TITLE,
          titleSource: 'placeholder',
          preview: '',
          modelRef: modelRef ?? null,
          createdAt: now,
          updatedAt: now,
        };
        set((s) => {
          if (s.activeThreadId !== null) {
            s.inactive[s.activeThreadId] = {
              messages: s.messages,
              streaming: s.streaming,
              error: s.error,
            };
          }
          s.threads = sortThreadMetas([meta, ...s.threads]);
          s.activeThreadId = id;
          s.messages = [];
          s.streaming = false;
          s.error = null;
        });
        // 元数据懒落盘：首条消息落盘时连带 upsert（见 appendUser）
        return id;
      },

      openThread: (threadId) => {
        set((s) => {
          if (threadId === s.activeThreadId) return;
          if (!s.threads.some((t) => t.id === threadId)) return;
          if (s.activeThreadId !== null) {
            s.inactive[s.activeThreadId] = {
              messages: s.messages,
              streaming: s.streaming,
              error: s.error,
            };
          }
          const next = s.inactive[threadId] ?? {
            messages: [],
            streaming: false,
            error: null,
          };
          delete s.inactive[threadId];
          s.messages = next.messages;
          s.streaming = next.streaming;
          s.error = next.error;
          s.activeThreadId = threadId;
        });
      },

      deleteThread: (threadId) => {
        set((s) => {
          s.threads = s.threads.filter((t) => t.id !== threadId);
          delete s.inactive[threadId];
          delete s.completedAtByThread[threadId];
          if (s.activeThreadId === threadId) {
            const nextId = s.threads[0]?.id ?? null;
            if (nextId !== null) {
              const next = s.inactive[nextId] ?? {
                messages: [],
                streaming: false,
                error: null,
              };
              delete s.inactive[nextId];
              s.messages = next.messages;
              s.streaming = next.streaming;
              s.error = next.error;
            } else {
              s.messages = [];
              s.streaming = false;
              s.error = null;
            }
            s.activeThreadId = nextId;
          }
        });
        persist((d) => d.deleteThread(threadId));
      },

      setThreadModel: (threadId, modelRef) => {
        let saved: LocalThreadMeta | null = null;
        set((s) => {
          const meta = s.threads.find((t) => t.id === threadId);
          if (!meta) return;
          meta.modelRef = modelRef;
          saved = snapshotMeta(meta);
        });
        if (saved) {
          const metaToSave: LocalThreadMeta = saved;
          persist((d) => d.upsertThread(metaToSave));
        }
      },

      setThreadTitle: (threadId, title, source) => {
        const next = title.trim();
        if (next === '') return false;
        let saved: LocalThreadMeta | null = null;
        set((s) => {
          const meta = s.threads.find((t) => t.id === threadId);
          if (!meta) return;
          // 来源阶梯守卫：只升不降——用户改名后到达的 AI 迟到结果、重复的
          // AI 写入、同级改写一律在此丢弃（标题不更新 updatedAt，不扰动列表序）
          if (
            TITLE_SOURCE_RANK[source] <= TITLE_SOURCE_RANK[meta.titleSource]
          ) {
            return;
          }
          meta.title = next;
          meta.titleSource = source;
          saved = snapshotMeta(meta);
        });
        if (!saved) return false;
        const metaToSave: LocalThreadMeta = saved;
        persist((d) => d.upsertThread(metaToSave));
        return true;
      },

      appendUser: (message, threadId) => {
        // 无线程时先建线程（发送即建线程：主页分发/线程页共用此不变量）
        let targetId = threadId ?? get().activeThreadId;
        if (targetId === null || targetId === undefined) {
          targetId = get().createThread();
        }
        let savedMeta: LocalThreadMeta | null = null;
        let seq = -1;
        set((s) => {
          const runtime = runtimeFor(s, targetId);
          if (!runtime) return;
          const isFirstUser = !runtime.messages.some((m) => m.role === 'user');
          runtime.messages.push(message);
          runtime.error = null;
          seq = runtime.messages.length - 1;
          const meta = touchMeta(
            s,
            targetId,
            Date.now(),
            previewOfContent(message.content)
          );
          if (
            meta &&
            isFirstUser &&
            TITLE_SOURCE_RANK[meta.titleSource] < TITLE_SOURCE_RANK.derived
          ) {
            // 首条消息即时派生（列表永不空白、AI 失败有底）；来源同步升到
            // derived——若标题已被 AI/用户接管（清空后重聊等），派生不许降级覆盖
            meta.title = deriveThreadTitle(message.content);
            meta.titleSource = 'derived';
          }
          if (meta) savedMeta = snapshotMeta(meta);
        });
        if (savedMeta && seq >= 0) {
          const metaToSave: LocalThreadMeta = savedMeta;
          const target = targetId;
          persist(async (d) => {
            await d.upsertThread(metaToSave);
            await d.saveMessage(target, seq, message);
          });
        }
      },

      beginAssistant: (message, threadId) => {
        const targetId = threadId ?? get().activeThreadId;
        set((s) => {
          const runtime = runtimeFor(s, targetId);
          if (!runtime) return;
          runtime.messages.push({ ...message, streaming: true });
          runtime.streaming = true;
          // 新一轮生成开始：该线程回到「运行中」，完成打点清除
          if (targetId !== null) delete s.completedAtByThread[targetId];
        });
        // 占位消息不落盘：收尾（finishAssistant）时以最终形态落盘；
        // 进程中途死亡则该轮只保留用户消息（诚实的历史，不留空占位）。
      },

      appendAssistantDelta: (id, delta) => {
        set((s) => {
          const located = locateMessage(s, id);
          if (!located) return;
          const target = located.runtime.messages[located.index];
          if (target) target.content += delta;
        });
      },

      finishAssistant: (id, patch) => {
        let saved: {
          threadId: string;
          seq: number;
          message: LocalChatMessage;
        } | null = null;
        let savedMeta: LocalThreadMeta | null = null;
        set((s) => {
          const located = locateMessage(s, id);
          if (!located) return;
          const target = located.runtime.messages[located.index];
          if (!target) return;
          target.streaming = false;
          if (patch) Object.assign(target, patch);
          located.runtime.streaming = false;
          if (located.threadId !== null) {
            const nowMs = Date.now();
            // 完成打点（状态板本地「刚完成」资格；与 meta 更新同一时刻）
            s.completedAtByThread[located.threadId] = nowMs;
            const meta = touchMeta(
              s,
              located.threadId,
              nowMs,
              previewOfContent(target.content)
            );
            if (meta) savedMeta = snapshotMeta(meta);
            saved = {
              threadId: located.threadId,
              seq: located.index,
              message: { ...target },
            };
          }
        });
        if (saved) {
          const toSave: {
            threadId: string;
            seq: number;
            message: LocalChatMessage;
          } = saved;
          const metaToSave = savedMeta;
          persist(async (d) => {
            if (metaToSave) await d.upsertThread(metaToSave);
            await d.saveMessage(toSave.threadId, toSave.seq, toSave.message);
          });
        }
      },

      setError: (error, threadId) => {
        const targetId = threadId ?? get().activeThreadId;
        set((s) => {
          const runtime = runtimeFor(s, targetId);
          if (!runtime) return;
          runtime.error = error;
        });
      },

      setStreaming: (streaming, threadId) => {
        const targetId = threadId ?? get().activeThreadId;
        set((s) => {
          const runtime = runtimeFor(s, targetId);
          if (!runtime) return;
          runtime.streaming = streaming;
        });
      },

      clearThread: (threadId) => {
        const targetId = threadId ?? get().activeThreadId;
        let savedMeta: LocalThreadMeta | null = null;
        set((s) => {
          const runtime = runtimeFor(s, targetId);
          if (!runtime) return;
          runtime.messages = [];
          runtime.error = null;
          runtime.streaming = false;
          if (targetId !== null && targetId !== undefined) {
            delete s.completedAtByThread[targetId];
          }
          if (targetId !== null && targetId !== undefined) {
            const meta = touchMeta(s, targetId, Date.now(), '');
            if (meta) {
              // 标题与来源成对重置：清空 = 回到无消息状态，下一轮首条消息
              // 重新派生、AI 可再升（不保留旧 user/ai 来源压制新一轮）
              meta.title = LOCAL_THREAD_PLACEHOLDER_TITLE;
              meta.titleSource = 'placeholder';
              savedMeta = snapshotMeta(meta);
            }
          }
        });
        if (targetId !== null && targetId !== undefined) {
          const target = targetId;
          const metaToSave = savedMeta;
          persist(async (d) => {
            await d.deleteThreadMessages(target);
            if (metaToSave) await d.upsertThread(metaToSave);
          });
        }
      },
    }))
  );
