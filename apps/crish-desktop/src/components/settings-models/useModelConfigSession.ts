/**
 * useModelConfigSession：模型配置编辑会话子 hook（从 useModelProfilesState 拆出）。
 *
 * 职责：openConfigFor / closeConfig / saveConfig——围绕 cfgDraft 的打开、关闭、
 * 保存。打开草稿读 selectModel；保存按 yaml 写核正序 await updateModel（无 LS、无 debounce）。
 */
import { useRef, useCallback } from 'react';
import { editSessionConsumer } from '../../api/chat-bridge/editSessionConsumer';
import { type ConfigDraft } from './modelsIpcHelpers';
import { type ProviderProfile } from '../../api/providerProfiles';
import { settingsObjectId } from './modelProfilesHelpers';
import {
  modelsCatalogStore,
  selectModel,
  selectProvider,
} from '../../api/modelsCatalogStore';
import type { ModelSpec } from '../../api/modelsCatalogTypes';
import {
  draftToModelPatch,
  modelToConfigDraft,
  modelSpecRevision,
  type ModelConfigDraft,
} from '../../api/modelsDraftMap';
import { normalizeProtocol } from '../../api/modelsNormalize';
import {
  ensureLsImported,
  LS_IMPORT_FLAG_KEY,
  LS_IMPORT_FLAG_VERSION,
} from '../../api/modelsLsImport';

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

function loadErrorMessage(fallback: string): string {
  const msg = modelsCatalogStore.getState().lastError?.message;
  return msg && msg.trim() ? msg : fallback;
}

function writeErrorMessage(
  res: { ok: boolean; error?: string },
  fallback: string
): string {
  return res.error && res.error.trim() ? res.error : fallback;
}

/** 缺节点只带 id，不猜测 contextWindow / modalities。 */
function specOrId(providerId: string, modelId: string): ModelSpec {
  return selectModel(providerId, modelId) ?? { id: modelId };
}

/** 完成标记已在则可同步打开，避免 await 回填覆盖已编辑草稿。 */
function isLsImportDone(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(LS_IMPORT_FLAG_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return false;
    const rec = parsed as { done?: unknown; version?: unknown };
    return rec.done === true && rec.version === LS_IMPORT_FLAG_VERSION;
  } catch {
    return false;
  }
}

function toCfgDraft(d: ModelConfigDraft): ConfigDraft {
  const out: ConfigDraft = {
    displayName: d.displayName ?? '',
    contextLength: d.contextLength ?? '',
    caps: {
      tools: Boolean(d.caps?.tools),
      image: Boolean(d.caps?.image),
      video: Boolean(d.caps?.video),
      reasoning: Boolean(d.caps?.reasoning),
    },
  };
  if (d.maxOutputTokens !== undefined) out.maxOutputTokens = d.maxOutputTokens;
  if (d.thinkingLevel !== undefined) out.thinkingLevel = d.thinkingLevel;
  const protocol = normalizeProtocol(d.protocol);
  if (protocol) out.protocol = protocol;
  if (d.modalities) out.modalities = d.modalities;
  if (d.thinkingEnabled !== undefined) out.thinkingEnabled = d.thinkingEnabled;
  if (d.thinkingMap) out.thinkingMap = d.thinkingMap;
  if (d.pricing) out.pricing = d.pricing;
  return out;
}

export function useModelConfigSession(args: ModelConfigSessionArgs) {
  const {
    selected,
    configOpenId,
    cfgDraft,
    setConfigOpenId,
    setCfgDraft,
    setManualOpen,
    notify,
    runAsLocalMutation,
  } = args;

  // CT-01 本地 rev 记账：objectId → 打开时 modelSpecRevision(selectModel)
  const cfgRevRef = useRef<Map<string, string>>(new Map());

  const openConfigFor = useCallback(
    async (model: string) => {
      if (!selected) return;
      const providerId = selected.id.trim().toLowerCase();
      const modelId = model;

      const fillFromStore = () => {
        const spec = specOrId(providerId, modelId);
        const provider = selectProvider(providerId);
        const objectId = settingsObjectId(selected.id, modelId);
        cfgRevRef.current.set(objectId, modelSpecRevision(spec));
        editSessionConsumer.open(objectId);
        setManualOpen(false);
        setConfigOpenId(modelId);
        setCfgDraft(toCfgDraft(modelToConfigDraft(spec, provider)));
      };

      // 导入已完成且 store 已加载：同步填草稿（禁止回落 getModelMeta）
      if (isLsImportDone() && modelsCatalogStore.getState().loaded) {
        fillFromStore();
        return;
      }

      try {
        const imported = await ensureLsImported();
        const loaded = await modelsCatalogStore.ensureLoaded();
        if (!loaded) {
          notify(
            false,
            !imported.ok
              ? writeErrorMessage(imported, '模型目录尚未加载，无法打开配置')
              : loadErrorMessage('模型目录尚未加载，无法打开配置')
          );
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(false, msg.trim() || '模型目录尚未加载，无法打开配置');
        return;
      }

      fillFromStore();
    },
    [selected, setManualOpen, setConfigOpenId, setCfgDraft, notify]
  );

  const closeConfig = useCallback(() => {
    if (selected && configOpenId) {
      const objectId = settingsObjectId(selected.id, configOpenId);
      editSessionConsumer.invalidate(objectId, 'external');
      cfgRevRef.current.delete(objectId);
    }
    setConfigOpenId(null);
    setCfgDraft(null);
  }, [selected, configOpenId, setConfigOpenId, setCfgDraft]);

  const saveConfig = useCallback(async () => {
    if (!selected || !configOpenId || !cfgDraft) return;
    const objectId = settingsObjectId(selected.id, configOpenId);
    const draft = cfgDraft;

    await runAsLocalMutation(async () => {
      try {
        const imported = await ensureLsImported();
        if (!imported.ok) {
          notify(false, writeErrorMessage(imported, '本地配置导入未完成，拒绝保存'));
          return;
        }

        const loaded = await modelsCatalogStore.ensureLoaded();
        if (!loaded) {
          notify(false, loadErrorMessage('模型目录尚未加载，拒绝保存'));
          return;
        }

        const providerId = selected.id.trim().toLowerCase();
        const modelId = configOpenId;

        if (!selectProvider(providerId)) {
          const addProv = await modelsCatalogStore.addProvider(providerId, {
            displayName: selected.name,
            baseUrl: selected.baseUrl,
            protocol: normalizeProtocol(selected.protocol) ?? 'openai/chat',
            models: [],
          });
          if (!addProv.ok) {
            notify(false, writeErrorMessage(addProv, '创建供应商失败'));
            return;
          }
        }

        // 手填未落盘残态：无节点则 addModel，不得静默 no-op
        const modelExisted = Boolean(selectModel(providerId, modelId));
        if (!modelExisted) {
          const addMod = await modelsCatalogStore.addModel(providerId, {
            id: modelId,
          });
          if (!addMod.ok) {
            notify(false, writeErrorMessage(addMod, '创建模型失败'));
            return;
          }
        }

        const currentSpec = specOrId(providerId, modelId);
        const expectRev = cfgRevRef.current.get(objectId);
        const currentRev = modelSpecRevision(currentSpec);
        // 刚 addModel 的残态无打开时节点，跳过与自身写入的签名比对
        if (
          modelExisted &&
          expectRev !== undefined &&
          expectRev !== currentRev
        ) {
          notify(false, '配置已被外部修改，保存已取消，请重新确认');
          editSessionConsumer.invalidate(objectId, 'external');
          return;
        }

        const patch = draftToModelPatch(draft);
        const res = await modelsCatalogStore.updateModel(
          providerId,
          modelId,
          patch
        );
        if (!res.ok) {
          notify(false, writeErrorMessage(res, '保存失败'));
          return;
        }

        editSessionConsumer.commit(objectId);
        cfgRevRef.current.delete(objectId);
        await openConfigFor(configOpenId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notify(false, msg.trim() || '保存失败');
      }
    });
  }, [
    selected,
    configOpenId,
    cfgDraft,
    notify,
    runAsLocalMutation,
    openConfigFor,
  ]);

  return { openConfigFor, closeConfig, saveConfig };
}
