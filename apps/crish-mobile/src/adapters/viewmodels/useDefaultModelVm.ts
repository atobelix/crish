// 默认模型页 VM（L3）：默认模型的唯一真源是 localChatStore 的
// config.activeModel，本 VM 只做投影与显式选择——
// - 当前默认经 resolveActiveSelection 解析：有效才报「供应商 · 模型」；
//   activeModel 在但解析失效（模型被删/停用、供应商不可用）时给失效
//   说明，明示系统没有自动改投，绝不替用户选一个顶上；
// - 可选集 = 各启用供应商的启用模型 + 本机已就绪（管理器真值 kind
//   === 'ready')模型；停用模型/停用供应商的模型列为不可用并给原因；
// - 本机未就绪条目列为不可用，原因是 IA 状态词，点击去详情页处理
//   （本页不内嵌下载）；
// - 选择只经用户点选行 → setActiveModel，没有任何自动落位路径。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { localChatStore } from '@/domain/store/localChatStore';
import { resolveActiveSelection } from '@/domain/pure/localChatProtocol';
import type { LocalModelsConfig } from '@/domain/types/localChat';
import {
  ON_DEVICE_PROVIDER_ID,
  ON_DEVICE_PROVIDER_NAME,
} from '../onDevice/onDeviceProviderSync';
import { onDeviceIaStatusText } from '@/presentation/components/localChat/views/OnDeviceShared';
import {
  useOnDeviceModelsVm,
  type OnDeviceModelsVm,
} from './useOnDeviceModelsVm';

export interface DefaultModelSelectableRow {
  providerId: string;
  modelId: string;
  name: string;
  isCurrent: boolean;
}

export interface DefaultModelUnavailableRow {
  modelId: string;
  name: string;
  reasonText: string;
  /** 本机未就绪条目的详情页 id（云端不可用行 = null，静态展示） */
  onDeviceDetailId: string | null;
}

export interface DefaultModelGroup {
  providerId: string;
  providerName: string;
  selectable: readonly DefaultModelSelectableRow[];
  unavailable: readonly DefaultModelUnavailableRow[];
}

export interface DefaultModelVm {
  /** 当前默认文案（有效时「供应商 · 模型」，否则「未设置」） */
  currentText: string;
  /** 默认已失效时的说明（有效或未设置时 = null） */
  invalidReasonText: string | null;
  groups: readonly DefaultModelGroup[];
  hasAnySelectable: boolean;
  select: (providerId: string, modelId: string) => void;
  refresh: () => Promise<void>;
}

export function useDefaultModelVm(): DefaultModelVm {
  const modelsVm: OnDeviceModelsVm = useOnDeviceModelsVm();

  const [config, setConfig] = useState<LocalModelsConfig>(
    () => localChatStore.getState().config
  );
  useEffect(() => {
    const update = () =>
      setConfig(localChatStore.getState().config);
    update();
    return localChatStore.subscribe(update);
  }, []);

  const select = useCallback((providerId: string, modelId: string) => {
    localChatStore.getState().setActiveModel(providerId, modelId);
  }, []);

  const refresh = useCallback(async () => {
    await modelsVm.refresh();
  }, [modelsVm]);

  return useMemo<DefaultModelVm>(() => {
    const selection = resolveActiveSelection(config);
    const active = config.activeModel;
    const currentText =
      selection !== null
        ? `${selection.provider.displayName ?? selection.providerId} · ${
            selection.model.displayName ?? selection.modelId
          }`
        : '未设置';
    const invalidReasonText =
      active !== null && selection === null
        ? '当前默认已失效（模型被删除、停用，或供应商不可用），系统没有自动改用其他模型。请在下方重新选择。'
        : null;

    const groups: DefaultModelGroup[] = [];
    for (const [providerId, provider] of Object.entries(config.providers)) {
      if (providerId === ON_DEVICE_PROVIDER_ID) continue;
      const providerName = provider.displayName ?? providerId;
      const selectable: DefaultModelSelectableRow[] = [];
      const unavailable: DefaultModelUnavailableRow[] = [];
      for (const model of provider.models) {
        const name = model.displayName ?? model.id;
        if (provider.enabled === false) {
          unavailable.push({
            modelId: model.id,
            name,
            reasonText: '供应商已停用',
            onDeviceDetailId: null,
          });
        } else if (model.enabled === false) {
          unavailable.push({
            modelId: model.id,
            name,
            reasonText: '已停用',
            onDeviceDetailId: null,
          });
        } else {
          selectable.push({
            providerId,
            modelId: model.id,
            name,
            isCurrent:
              active?.providerId === providerId &&
              active?.modelId === model.id,
          });
        }
      }
      groups.push({ providerId, providerName, selectable, unavailable });
    }

    // 本机组：可选集以管理器真值为准（就绪才可选），未就绪给状态词
    // 并导向详情页；本页不内嵌下载、不替用户落位。
    const onDeviceSelectable: DefaultModelSelectableRow[] = [];
    const onDeviceUnavailable: DefaultModelUnavailableRow[] = [];
    for (const row of modelsVm.rows) {
      if (row.state?.kind === 'ready') {
        onDeviceSelectable.push({
          providerId: ON_DEVICE_PROVIDER_ID,
          modelId: row.id,
          name: row.name,
          isCurrent:
            active?.providerId === ON_DEVICE_PROVIDER_ID &&
            active?.modelId === row.id,
        });
      } else {
        onDeviceUnavailable.push({
          modelId: row.id,
          name: row.name,
          reasonText: onDeviceIaStatusText(row.state, false),
          onDeviceDetailId: row.id,
        });
      }
    }
    groups.push({
      providerId: ON_DEVICE_PROVIDER_ID,
      providerName: ON_DEVICE_PROVIDER_NAME,
      selectable: onDeviceSelectable,
      unavailable: onDeviceUnavailable,
    });

    return {
      currentText,
      invalidReasonText,
      groups,
      hasAnySelectable: groups.some((g) => g.selectable.length > 0),
      select,
      refresh,
    };
  }, [config, modelsVm.rows, select, refresh]);
}
