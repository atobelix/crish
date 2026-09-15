/**
 * useModelProviderActions：服务商连通性动作子 hook（从 useModelProfilesState 拆出）。
 *
 * 职责：runTest（单模型连通测试）、runScan（扫描服务器可用模型）、
 * runCheck（服务商握手连通检查）。扫描确认走 probeAndAppendModels（ID 差集）。
 *
 * 依赖项由主 hub 注入，保持纯结构性拆分、无重复状态源。
 */
import { useCallback, useState } from 'react';
import {
  scanProviderModels,
  testProviderModel,
} from '../../api/modelCatalog';
import {
  loadProfiles,
  type ProviderProfile,
} from '../../api/providerProfiles';
import {
  modelsCatalogStore,
  selectProvider,
} from '../../api/modelsCatalogStore';
import { modelRefKey } from '../../api/modelsCatalogTypes';
import { ensureProviderShell } from './catalogWriteGate';

export interface ModelProviderActionsArgs {
  selected: ProviderProfile | null;
  refresh: () => void;
  notify: (ok: boolean, msg: string) => void;
  runAsLocalMutation: <T>(fn: () => Promise<T> | T) => Promise<T>;
}

export function useModelProviderActions(args: ModelProviderActionsArgs) {
  const { selected, refresh, notify, runAsLocalMutation } = args;
  const [testBusy, setTestBusy] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [checkBusy, setCheckBusy] = useState(false);
  const [scanModalOpen, setScanModalOpen] = useState(false);
  const [scannedModelsList, setScannedModelsList] = useState<string[]>([]);

  const runTest = useCallback(
    async (model: string) => {
      if (!selected) return;
      setTestBusy(modelRefKey({ providerId: selected.id, modelId: model }));

      try {
        const fresh =
          loadProfiles().find((p) => p.id === selected.id) || selected;
        const r = await testProviderModel(fresh, model);
        refresh();
        if (!r.ok) {
          notify(false, `连通失败 · ${model}：${r.error || '未知错误'}`);
        }
      } catch (e) {
        notify(false, e instanceof Error ? e.message : String(e));
      } finally {
        setTestBusy(null);
      }
    },
    [selected, refresh, notify],
  );

  const runScan = useCallback(
    async () => {
      if (!selected) return;
      setScanBusy(true);
      try {
        const fresh =
          loadProfiles().find((p) => p.id === selected.id) || selected;
        const r = await scanProviderModels(fresh);
        if (r.ok && r.models?.length) {
          setScannedModelsList(r.models);
          setScanModalOpen(true);
        } else {
          notify(false, r.error || '未能检测到服务器可用模型');
        }
      } catch (e) {
        notify(false, e instanceof Error ? e.message : String(e));
      } finally {
        setScanBusy(false);
      }
    },
    [selected, notify],
  );

  const confirmScannedModels = useCallback(
    (selectedModels: string[]) => {
      if (!selected) return;
      void runAsLocalMutation(async () => {
        try {
          const shell = await ensureProviderShell({
            providerId: selected.id,
            displayName: selected.name,
            baseUrl: selected.baseUrl,
            protocol: selected.protocol,
          });
          if (!shell.ok) {
            notify(false, shell.error || '写入服务商失败');
            return;
          }
          const result = await modelsCatalogStore.probeAndAppendModels(
            selected.id,
            selectedModels
          );
          notify(
            true,
            `已同步 ${selectedModels.length} 个模型（新增 ${result.newAppended} 个）`
          );
        } catch (e) {
          notify(false, e instanceof Error ? e.message : String(e));
        }
      });
    },
    [selected, runAsLocalMutation, notify],
  );

  const runCheck = useCallback(
    async () => {
      if (!selected) return;
      setCheckBusy(true);
      try {
        const fresh =
          loadProfiles().find((p) => p.id === selected.id) || selected;
        const firstModel =
          selectProvider(selected.id)?.models[0]?.id ||
          fresh.models[0] ||
          '';
        const r = await testProviderModel(fresh, firstModel);
        if (r.ok) {
          notify(true, `服务商连通正常 (${r.latencyMs || 120}ms)`);
        } else {
          notify(false, `连通检查失败：${r.error || '无法建立握手连接'}`);
        }
      } catch (e) {
        notify(false, e instanceof Error ? e.message : String(e));
      } finally {
        setCheckBusy(false);
      }
    },
    [selected, notify],
  );

  return {
    testBusy,
    scanBusy,
    checkBusy,
    runTest,
    runScan,
    runCheck,
    scanModalOpen,
    setScanModalOpen,
    scannedModelsList,
    confirmScannedModels,
  };
}
