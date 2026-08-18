/**
 * useModelConfigSession：模型配置编辑会话子 hook（从 useModelProfilesState 拆出）。
 *
 * 职责：openConfigFor / closeConfig / saveConfig——围绕 cfgDraft 的打开、关闭、
 * 保存，含 CT-01 rev 核对（拒绝陈旧覆盖）与 editSessionConsumer 编辑会话生命周期
 * （open / commit / invalidate）。
 *
 * 依赖项由主 hub 注入（selected / 草稿状态 / setter / refresh / notify /
 * runAsLocalMutation），保持纯结构性拆分、无重复状态源。
 */
import { useRef, useCallback } from 'react';
import { editSessionConsumer } from '../../api/chat-bridge/editSessionConsumer';
import { getModelMeta } from '../../api/modelCatalog';
import { applyMetaForModel, type ConfigDraft } from './modelsIpcHelpers';
import { type ProviderProfile } from '../../api/providerProfiles';
import { modelMetaRevision, settingsObjectId } from './modelProfilesHelpers';

export interface ModelConfigSessionArgs {
  selected: ProviderProfile | null;
  configOpenId: string | null;
  cfgDraft: ConfigDraft | null;
  setConfigOpenId: (id: string | null) => void;
  setCfgDraft: (draft: ConfigDraft | null) => void;
  setManualOpen: (open: boolean) => void;
  refresh: () => void;
  notify: (ok: boolean, msg: string) => void;
  runAsLocalMutation: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

export function useModelConfigSession(args: ModelConfigSessionArgs) {
  const {
    selected,
    configOpenId,
    cfgDraft,
    setConfigOpenId,
    setCfgDraft,
    setManualOpen,
    refresh,
    notify,
    runAsLocalMutation,
  } = args;

  // CT-01 本地 rev 记账：objectId → 打开时快照 rev（保存前比对）
  const cfgRevRef = useRef<Map<string, string>>(new Map());

  const openConfigFor = useCallback(
    (model: string) => {
      if (!selected) return;
      const meta = getModelMeta(selected.id, model);
      const objectId = settingsObjectId(selected.id, model);
      const rev = modelMetaRevision(selected.id, model);
      // R2-a ④：cfgDraft 挂编辑会话（open；设置 rev 为本地签名，不进会话数值 rev）
      cfgRevRef.current.set(objectId, rev);
      editSessionConsumer.open(objectId);
      setManualOpen(false);
      setConfigOpenId(model);
      setCfgDraft({
        displayName: meta.displayName || '',
        contextLength:
          meta.contextLength != null ? String(meta.contextLength) : '',
        caps: {
          tools: Boolean(meta.capabilities?.tools),
          vision: Boolean(meta.capabilities?.vision),
          reasoning: Boolean(meta.capabilities?.reasoning),
        },
      });
    },
    [selected, setManualOpen, setConfigOpenId, setCfgDraft],
  );

  const closeConfig = useCallback(() => {
    if (selected && configOpenId) {
      const objectId = settingsObjectId(selected.id, configOpenId);
      // 用户取消：关闭编辑会话（'external' 失效广播）+ 清本地 rev 记账
      editSessionConsumer.invalidate(objectId, 'external');
      cfgRevRef.current.delete(objectId);
    }
    setConfigOpenId(null);
    setCfgDraft(null);
  }, [selected, configOpenId, setConfigOpenId, setCfgDraft]);

  const saveConfig = useCallback(() => {
    if (!selected || !configOpenId || !cfgDraft) return;
    const objectId = settingsObjectId(selected.id, configOpenId);
    const draft = cfgDraft;
    // CT-01 rev 核对（对齐 review §11 缓存失效 + analysis/15 §2.4）：
    // 保存前比对「打开时快照 rev」与「当前 meta rev」，外部已变更 →
    // 拒绝陈旧覆盖（不静默 LWW），与 persistence.rs Conflict 语义同构。
    const expectRev = cfgRevRef.current.get(objectId);
    const currentRev = modelMetaRevision(selected.id, configOpenId);
    if (expectRev !== undefined && expectRev !== currentRev) {
      notify(false, '配置已被外部修改，保存已取消，请重新确认');
      editSessionConsumer.invalidate(objectId, 'external');
      return;
    }
    void runAsLocalMutation(() => {
      applyMetaForModel(selected.id, configOpenId, draft);
      refresh();
      // 提交并关闭编辑会话（推进 rev，广播失效）
      editSessionConsumer.commit(objectId);
      cfgRevRef.current.delete(objectId);
      openConfigFor(configOpenId);
    });
  }, [
    selected,
    configOpenId,
    cfgDraft,
    notify,
    runAsLocalMutation,
    refresh,
    openConfigFor,
  ]);

  return { openConfigFor, closeConfig, saveConfig };
}
