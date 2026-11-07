// 会话草稿键控持久化（批 C 01-4/②）：草稿按会话键存储——远端会话
// `remote:<sessionId>` / 本地线程 `local:<threadId>`（与阅读锚点
// anchorKey 同一键形），切会话不串稿、进程被杀后恢复。
// 形态与 scrollAnchorStore 同构：内存 Map 为同步读面（composer 挂载
// 首帧即取），kv settings 表经 configure 注入为持久面（装配点
// persistBootstrap）；未注入 / DB 降级时退化为进程内 Map（会话内
// 隔离仍成立，跨启动不保留——诚实降级，同锚点口径）。
// 草稿是用户未发送的原文：写入失败不阻断输入（内存副本恒同步），
// 读取失败视为无草稿，绝不抛进交互路径。
// 非空稿按键合并 400ms 后落盘；空稿取消等待并立刻删除。
// flushComposerDraft 供发送、切键、失焦、卸载、进后台立刻写最新值。

/** 草稿持久接口（SqlSettingsDao 的 get/set/delete 与之同形） */
export interface ComposerDraftPersist {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

const KEY_PREFIX = 'chat.draft.';

/** 草稿 kv 键（draftKey 由引擎以 `${kind}:${id}` 构成） */
export function composerDraftKey(draftKey: string): string {
  return `${KEY_PREFIX}${draftKey}`;
}

/** 默认持久化实现（接线层启动时注入一次，同 scrollAnchorStore 模式） */
let defaultPersist: ComposerDraftPersist | null = null;

/** 非空稿合并落盘的等待（毫秒）。空稿与立即刷盘不走这段等待。 */
const PERSIST_DELAY_MS = 400;

/** 内存读面（同步真源：挂载首帧与切换会话时直接命中） */
const memoryDrafts = new Map<string, string>();

/** 本进程内用户已经写过的键。清空也算写过，迟到回填不得恢复旧稿。 */
const touchedKeys = new Set<string>();

interface PersistSlot {
  timer: ReturnType<typeof setTimeout> | null;
  writing: boolean;
  dirty: boolean;
  inflight: Promise<void> | null;
}

const persistSlots = new Map<string, PersistSlot>();

/** 测试复位后，进行中的落盘不得再写回新一轮状态。 */
let isolationEpoch = 0;

/** 接线层注入默认持久化（persistBootstrap 装配；传 null 复位为内存形态） */
export function configureComposerDraftPersistence(
  persist: ComposerDraftPersist | null
): void {
  defaultPersist = persist;
}

/** 同步读草稿（仅内存面；持久面回填经 loadComposerDraft） */
export function peekComposerDraft(draftKey: string): string {
  return memoryDrafts.get(draftKey) ?? '';
}

/**
 * 从持久面回填一条草稿到内存面并返回最终值。用户已经写过该键
 * （包括清空）或内存里已有稿时，迟到的回填不得覆盖。持久面读失败
 * 时保持内存值，不报错。
 */
export async function loadComposerDraft(draftKey: string): Promise<string> {
  const persist = defaultPersist;
  if (!persist) return peekComposerDraft(draftKey);
  try {
    const raw = await persist.get(composerDraftKey(draftKey));
    if (
      raw !== null &&
      raw !== '' &&
      !touchedKeys.has(draftKey) &&
      !memoryDrafts.has(draftKey)
    ) {
      memoryDrafts.set(draftKey, raw);
    }
  } catch {
    // 草稿回填失败静默降级为内存值（同锚点读失败口径）
  }
  return peekComposerDraft(draftKey);
}

function slotOf(draftKey: string): PersistSlot {
  const existing = persistSlots.get(draftKey);
  if (existing) return existing;
  const created: PersistSlot = {
    timer: null,
    writing: false,
    dirty: false,
    inflight: null,
  };
  persistSlots.set(draftKey, created);
  return created;
}

function cancelTimer(slot: PersistSlot): void {
  if (slot.timer === null) return;
  clearTimeout(slot.timer);
  slot.timer = null;
}

function armTimer(draftKey: string): void {
  const slot = slotOf(draftKey);
  cancelTimer(slot);
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void persistLatest(draftKey);
  }, PERSIST_DELAY_MS);
}

function writeMemory(draftKey: string, text: string): void {
  touchedKeys.add(draftKey);
  if (text === '') memoryDrafts.delete(draftKey);
  else memoryDrafts.set(draftKey, text);
}

/**
 * 写草稿。内存同步更新；非空稿按键合并，400ms 内只把最终文本交给持久面。
 * 空串取消该键尚未到期的写入，并立刻删除持久稿。
 */
export function saveComposerDraft(draftKey: string, text: string): void {
  const slot = slotOf(draftKey);
  writeMemory(draftKey, text);
  cancelTimer(slot);
  slot.dirty = true;
  if (text === '') {
    void persistLatest(draftKey);
    return;
  }
  if (slot.writing) return;
  armTimer(draftKey);
}

/**
 * 把该键的最新内存稿立刻交给持久面，并取消尚未到期的合并计时。
 * 发送、切键、失焦、卸载、进后台应由调用方在这些边界上调用。
 * 从未写入过的键不做删除，避免把尚未回填的落盘稿清掉。
 */
export function flushComposerDraft(draftKey: string): Promise<void> {
  const slot = slotOf(draftKey);
  cancelTimer(slot);
  if (!touchedKeys.has(draftKey) && !memoryDrafts.has(draftKey)) {
    return Promise.resolve();
  }
  if (slot.writing && slot.inflight) {
    slot.dirty = true;
    return slot.inflight;
  }
  return persistLatest(draftKey);
}

function persistLatest(draftKey: string): Promise<void> {
  const slot = slotOf(draftKey);
  if (slot.writing && slot.inflight) {
    slot.dirty = true;
    return slot.inflight;
  }
  const epoch = isolationEpoch;
  const persist = defaultPersist;
  if (!persist) {
    slot.dirty = false;
    return Promise.resolve();
  }
  const text = memoryDrafts.get(draftKey) ?? '';
  const key = composerDraftKey(draftKey);
  slot.writing = true;
  slot.dirty = false;
  const run = (async () => {
    let failed = false;
    try {
      if (text === '') {
        if (persist.delete) await persist.delete(key);
        else await persist.set(key, '');
      } else {
        await persist.set(key, text);
      }
    } catch {
      // 写入失败不阻断输入，内存副本仍是真源。
      failed = true;
      slot.dirty = true;
    }
    slot.writing = false;
    slot.inflight = null;
    if (epoch !== isolationEpoch) return;
    const latest = memoryDrafts.get(draftKey) ?? '';
    if (failed) {
      if (latest !== text) armTimer(draftKey);
      return;
    }
    if (slot.dirty || latest !== text) await persistLatest(draftKey);
  })();
  slot.inflight = run;
  return run;
}

/** 测试隔离：清空内存面、合并计时与注入（仅测试调用） */
export function resetComposerDraftsForTest(): void {
  isolationEpoch += 1;
  for (const slot of persistSlots.values()) cancelTimer(slot);
  persistSlots.clear();
  touchedKeys.clear();
  memoryDrafts.clear();
  defaultPersist = null;
}
