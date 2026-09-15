/** 模型编辑只从确认镜像打开，以完整修订提交；目标消失时拒绝保存。 */
import { useCallback, useEffect, useRef } from 'react';
import { editSessionConsumer } from '../../api/chat-bridge/editSessionConsumer';
import { modelRefKey, normalizeModelRef } from '../../api/modelsCatalogTypes';
import { modelsCatalogStore, selectModel } from '../../api/modelsCatalogStore';
import {
  draftToModelPatch,
  modelSpecRevision,
  modelToConfigDraft,
} from '../../api/modelsDraftMap';
import type { ConfigDraft } from './modelsIpcHelpers';

export interface ModelConfigSessionArgs {
  selected: { id: string } | null;
  configOpenId: string | null;
  cfgDraft: ConfigDraft | null;
  setConfigOpenId: (id: string | null) => void;
  setCfgDraft: (draft: ConfigDraft | null) => void;
  setManualOpen: (open: boolean) => void;
  notify: (ok: boolean, message: string) => void;
  runAsLocalMutation: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

export function useModelConfigSession({
  selected,
  configOpenId,
  cfgDraft,
  setConfigOpenId,
  setCfgDraft,
  setManualOpen,
  notify,
  runAsLocalMutation,
}: ModelConfigSessionArgs) {
  const editBase = useRef(
    new Map<string, { modelRevision: string; fileRevision: string }>()
  );
  const currentObject = useRef<string | null>(null);
  const openRequest = useRef(0);
  const currentDraft = useRef(cfgDraft);
  currentDraft.current = cfgDraft;

  useEffect(
    () => () => {
      openRequest.current += 1;
      if (currentObject.current)
        editSessionConsumer.invalidate(currentObject.current, 'external');
      currentObject.current = null;
    },
    [selected?.id]
  );

  const openConfigFor = useCallback(
    async (modelId: string) => {
      if (!selected) return;
      const request = ++openRequest.current;
      try {
        const ref = normalizeModelRef({ providerId: selected.id, modelId });
        if (!modelsCatalogStore.getState().loaded) {
          const loaded = await modelsCatalogStore.ensureLoaded();
          if (!loaded)
            throw new Error(
              modelsCatalogStore.getState().lastError?.message ||
                '模型目录尚未加载'
            );
        }
        if (request !== openRequest.current) return;
        const model = selectModel(ref.providerId, ref.modelId);
        if (!model) throw new Error('模型已不存在，请重新选择');
        const key = modelRefKey(ref);
        if (currentObject.current && currentObject.current !== key) {
          editSessionConsumer.invalidate(currentObject.current, 'external');
          editBase.current.delete(currentObject.current);
        }
        currentObject.current = key;
        editBase.current.set(key, {
          modelRevision: modelSpecRevision(model),
          fileRevision: modelsCatalogStore.getState().revision,
        });
        editSessionConsumer.open(key);
        setManualOpen(false);
        setConfigOpenId(ref.modelId);
        setCfgDraft(modelToConfigDraft(model));
      } catch (error) {
        if (request === openRequest.current)
          notify(false, error instanceof Error ? error.message : String(error));
      }
    },
    [selected, notify, setManualOpen, setConfigOpenId, setCfgDraft]
  );

  const closeConfig = useCallback(() => {
    openRequest.current += 1;
    if (currentObject.current) {
      editSessionConsumer.invalidate(currentObject.current, 'external');
      editBase.current.delete(currentObject.current);
    }
    currentObject.current = null;
    setConfigOpenId(null);
    setCfgDraft(null);
  }, [setConfigOpenId, setCfgDraft]);

  const saveConfig = useCallback(async () => {
    if (!selected || !configOpenId || !cfgDraft) return;
    const ref = normalizeModelRef({
      providerId: selected.id,
      modelId: configOpenId,
    });
    const key = modelRefKey(ref);
    const draft = cfgDraft;
    const base = editBase.current.get(key);
    try {
      if (!base || currentObject.current !== key)
        throw new Error('编辑会话已失效，请重新打开模型');
      const model = selectModel(ref.providerId, ref.modelId);
      if (!model) throw new Error('模型已不存在，保存已取消');
      if (base.modelRevision !== modelSpecRevision(model)) {
        editSessionConsumer.invalidate(key, 'external');
        throw new Error('配置已被外部修改，保存已取消，请重新确认');
      }
      const patch = draftToModelPatch(draft);
      await runAsLocalMutation(async () => {
        const result = await modelsCatalogStore.updateModel(
          ref.providerId,
          ref.modelId,
          patch,
          base.fileRevision
        );
        if (!result.ok) throw new Error(result.error);
        editSessionConsumer.commit(key);
        if (currentObject.current !== key) return;
        const accepted = selectModel(ref.providerId, ref.modelId);
        if (!accepted) throw new Error('保存回执缺少目标模型，请重新加载配置');
        editBase.current.set(key, {
          modelRevision: modelSpecRevision(accepted),
          fileRevision: modelsCatalogStore.getState().revision,
        });
        // 保存期间用户新输入的内容保留，不能被这次回执覆盖。
        if (currentDraft.current === draft)
          setCfgDraft(modelToConfigDraft(accepted));
      });
    } catch (error) {
      notify(false, error instanceof Error ? error.message : String(error));
    }
  }, [
    selected,
    configOpenId,
    cfgDraft,
    notify,
    runAsLocalMutation,
    setCfgDraft,
  ]);

  return { openConfigFor, closeConfig, saveConfig };
}
