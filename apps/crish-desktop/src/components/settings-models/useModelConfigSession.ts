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
import { resolveModelPrice } from '../../api/pricingStore';
import {
  findAutofillModel,
  getAutofillModelSpec,
} from '../../services/modelsAutofillBaseline';

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

      const autofill =
        getAutofillModelSpec(model, selected.id) || findAutofillModel(model);
      const existingPrice = meta.pricing || resolveModelPrice(model);

      // 默认多模态配置 (用户最高指示：modalities: input: ["text", "image"], output: ["text"] 必须有)
      const modalities = meta.modalities ||
        autofill?.modalities || {
          input: ['text', 'image'],
          output: ['text'],
        };

      // 拍平思考配置
      let thinkingEnabled = false;
      let thinkingMap: Record<string, string> = {
        Low: 'low',
        Medium: 'medium',
        High: 'high',
      };
      if (meta.thinking && Object.keys(meta.thinking).length > 0) {
        thinkingEnabled = true;
        thinkingMap = { ...meta.thinking };
      } else if (
        autofill?.thinking &&
        Object.keys(autofill.thinking).length > 0
      ) {
        thinkingEnabled = true;
        thinkingMap = { ...autofill.thinking };
      } else if (meta.capabilities?.reasoning) {
        thinkingEnabled = true;
      }

      // 四维选填价格 (100% 选填，留空优雅静默)
      const currency =
        existingPrice?.currency || autofill?.pricing?.currency || 'USD';
      const pricing = existingPrice
        ? {
            currency: (existingPrice.currency || 'USD') as 'USD' | 'CNY',
            input:
              (existingPrice as any).input !== undefined
                ? String((existingPrice as any).input)
                : (existingPrice as any).inputPerMTok !== undefined
                  ? String((existingPrice as any).inputPerMTok)
                  : '',
            output:
              (existingPrice as any).output !== undefined
                ? String((existingPrice as any).output)
                : (existingPrice as any).outputPerMTok !== undefined
                  ? String((existingPrice as any).outputPerMTok)
                  : '',
            cacheRead:
              (existingPrice as any).cacheRead !== undefined
                ? String((existingPrice as any).cacheRead)
                : (existingPrice as any).cacheReadPerMTok !== undefined
                  ? String((existingPrice as any).cacheReadPerMTok)
                  : '',
            cacheWrite:
              (existingPrice as any).cacheWrite !== undefined
                ? String((existingPrice as any).cacheWrite)
                : (existingPrice as any).cacheWritePerMTok !== undefined
                  ? String((existingPrice as any).cacheWritePerMTok)
                  : '',
          }
        : {
            currency: currency as 'USD' | 'CNY',
            input: '',
            output: '',
            cacheRead: '',
            cacheWrite: '',
          };

      setCfgDraft({
        displayName: meta.displayName || '',
        contextLength:
          meta.contextLength != null ? String(meta.contextLength) : '',
        maxOutputTokens:
          meta.maxOutputTokens != null ? String(meta.maxOutputTokens) : '',
        caps: {
          tools: Boolean(meta.capabilities?.tools),
          image: Boolean(
            meta.capabilities?.image ?? modalities.input.includes('image')
          ),
          video: Boolean(
            meta.capabilities?.video ?? modalities.input.includes('video')
          ),
          reasoning: Boolean(meta.capabilities?.reasoning ?? thinkingEnabled),
        },
        thinkingLevel: meta.defaultThinkingLevel || 'default',
        protocol: meta.protocol,
        modalities,
        thinkingEnabled,
        thinkingMap,
        pricing,
      });
    },
    [selected, setManualOpen, setConfigOpenId, setCfgDraft]
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
