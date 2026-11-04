// 会话草稿键控持久化（批 C 01-4/②）：草稿按会话键存储——远端会话
// `remote:<sessionId>` / 本地线程 `local:<threadId>`（与阅读锚点
// anchorKey 同一键形），切会话不串稿、进程被杀后恢复。
// 形态与 scrollAnchorStore 同构：内存 Map 为同步读面（composer 挂载
// 首帧即取），kv settings 表经 configure 注入为持久面（装配点
// persistBootstrap）；未注入 / DB 降级时退化为进程内 Map（会话内
// 隔离仍成立，跨启动不保留——诚实降级，同锚点口径）。
// 草稿是用户未发送的原文：写入失败不阻断输入（内存副本恒同步），
// 读取失败视为无草稿，绝不抛进交互路径。

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

/** 内存读面（同步真源：挂载首帧与切换会话时直接命中） */
const memoryDrafts = new Map<string, string>();

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
 * 从持久面回填一条草稿到内存面并返回最终值：内存已有更新的输入时
 * 以内存为准（用户已在本会话键入，不许迟到的回填覆盖）；持久面读
 * 失败 = 保持内存值，不报错。
 */
export async function loadComposerDraft(draftKey: string): Promise<string> {
  const persist = defaultPersist;
  if (!persist) return peekComposerDraft(draftKey);
  try {
    const raw = await persist.get(composerDraftKey(draftKey));
    if (raw !== null && raw !== '' && !memoryDrafts.has(draftKey)) {
      memoryDrafts.set(draftKey, raw);
    }
  } catch {
    // 草稿回填失败静默降级为内存值（同锚点读失败口径）
  }
  return peekComposerDraft(draftKey);
}

/** 写草稿（内存同步更新 + 尽力持久化；空串 = 删除该会话草稿） */
export function saveComposerDraft(draftKey: string, text: string): void {
  if (text === '') {
    memoryDrafts.delete(draftKey);
  } else {
    memoryDrafts.set(draftKey, text);
  }
  const persist = defaultPersist;
  if (!persist) return;
  const key = composerDraftKey(draftKey);
  if (text === '') {
    if (persist.delete) {
      void persist.delete(key).catch(() => undefined);
    } else {
      void persist.set(key, '').catch(() => undefined);
    }
  } else {
    void persist.set(key, text).catch(() => {
      // 草稿是可重建的输入态：写入失败不阻断输入（内存副本仍在）
    });
  }
}

/** 测试隔离：清空内存面与注入（仅测试调用） */
export function resetComposerDraftsForTest(): void {
  memoryDrafts.clear();
  defaultPersist = null;
}
