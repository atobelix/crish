/**
 * 全局默认模型的写路径与「停用后同厂商自愈」（从 ModelsSettingsTab 拆出）。
 *
 * 落实审计 1：名单与启用态只读统一 live 树（getLiveModel / getLiveProvider），
 * tick = useModelsCatalogVersion；停用后只在同服务商内自愈，严禁跨服务商静默切模。
 */
import { useCallback, useEffect, useRef } from 'react';
import { modelsCatalogStore } from '../../api/modelsCatalogStore';
import { getLiveModel, getLiveProvider } from '../../api/modelsCatalogLive';
import { useModelsCatalogVersion } from '../../hooks/useModelsCatalogVersion';
import { t } from '../../i18n';

type ActiveModelRef = { providerId: string; modelId: string };

/** live 树中存在且 enabled !== false。缺节点视为未启用（删除后必须自愈）。 */
export function isLiveModelEnabled(profileId: string, model: string): boolean {
  const spec = getLiveModel(profileId, model);
  return spec != null && spec.enabled !== false;
}

/**
 * 停用模型后的活动模型自愈解析器（落实审计 1，严禁跨厂商静默切换）。
 * 名单与启用态只读统一树；`profiles` 参数已废除——树就是唯一名单源。
 */
export function resolveActiveModelAfterMetaChange(
  currentActive: { providerId: string; modelId: string } | null,
  isModelEnabled: (providerId: string, modelId: string) => boolean
): {
  nextActive: { providerId: string; modelId: string } | null;
  selfHealed: boolean;
} {
  if (!currentActive || !currentActive.providerId || !currentActive.modelId) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 1. 若当前活动模型仍处于启用态，无需自愈
  if (isModelEnabled(currentActive.providerId, currentActive.modelId)) {
    return { nextActive: currentActive, selfHealed: false };
  }

  // 2. 当前活动模型已被停用！仅在【同服务商】内部寻找下一个已启用的模型
  const storeIds = (
    getLiveProvider(currentActive.providerId)?.models ?? []
  ).map((m) => m.id);
  const sameProviderNext = storeIds.find((m) => {
    if (m === currentActive.modelId) return false;
    return isModelEnabled(currentActive.providerId, m);
  });

  if (sameProviderNext) {
    return {
      nextActive: {
        providerId: currentActive.providerId,
        modelId: sameProviderNext,
      },
      selfHealed: true,
    };
  }

  // 3. 该服务商已无任何可用模型 -> 严禁跨厂商切换！直接置空以引导手动选择
  return { nextActive: null, selfHealed: true };
}

/**
 * @returns applyActiveModel：全局默认模型唯一写路径（统一树 setActiveModel，带一次 CAS 重试）。
 */
export function useActiveModelSelfHeal({
  activeProfileId,
  globalActiveModelId,
  notify,
}: {
  activeProfileId: string | null | undefined;
  globalActiveModelId: string | null | undefined;
  notify: (ok: boolean, msg: string) => void;
}): (ref: ActiveModelRef | null) => Promise<boolean> {
  const catalogVersion = useModelsCatalogVersion();

  /**
   * 全局默认模型唯一写路径 = 统一树 setActiveModel（workbench_apply_models_config
   * 的 CAS）。修订冲突先重读真源再重试一次，仍失败则明确报错，绝不静默吞掉。
   */
  const applyActiveModel = useCallback(
    async (ref: ActiveModelRef | null) => {
      const first = await modelsCatalogStore.setActiveModel(ref);
      if (first.ok) return true;
      const reloaded = await modelsCatalogStore.ensureLoaded(true);
      if (!reloaded) {
        notify(false, first.error);
        return false;
      }
      const retry = await modelsCatalogStore.setActiveModel(ref);
      if (!retry.ok) notify(false, retry.error);
      return retry.ok;
    },
    [notify]
  );

  // 停用后同厂商自愈：enabled 读 live 树，不读 getModelMeta；tick = catalogVersion。
  // 树规范化会把失效 activeModel 置空，所以以「上一次仍有效的活动模型」为基准判定，
  // 严禁跨服务商静默切换（落实审计 1）。
  const lastActiveModelRef = useRef<{
    providerId: string;
    modelId: string;
  } | null>(null);

  useEffect(() => {
    const current =
      activeProfileId && globalActiveModelId
        ? { providerId: activeProfileId, modelId: globalActiveModelId }
        : null;
    const previous = lastActiveModelRef.current;
    lastActiveModelRef.current = current;

    if (current) {
      const { nextActive, selfHealed } = resolveActiveModelAfterMetaChange(
        current,
        isLiveModelEnabled
      );
      if (!selfHealed) return;
      void applyActiveModel(nextActive);
      if (nextActive) {
        notify(
          true,
          t('settings.models.selfHeal.switched', {
            modelId: nextActive.modelId,
          })
        );
      } else {
        notify(false, t('settings.models.selfHeal.noModelLeft'));
      }
      return;
    }

    if (
      !previous ||
      isLiveModelEnabled(previous.providerId, previous.modelId)
    ) {
      return;
    }
    const { nextActive } = resolveActiveModelAfterMetaChange(
      previous,
      isLiveModelEnabled
    );
    if (nextActive) {
      void applyActiveModel(nextActive);
      notify(
        true,
        t('settings.models.selfHeal.switched', { modelId: nextActive.modelId })
      );
    } else {
      notify(false, t('settings.models.selfHeal.noModelLeft'));
    }
  }, [
    catalogVersion,
    activeProfileId,
    globalActiveModelId,
    notify,
    applyActiveModel,
  ]);

  return applyActiveModel;
}
