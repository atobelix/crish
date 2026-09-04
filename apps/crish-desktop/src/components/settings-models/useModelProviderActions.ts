/**
 * useModelProviderActions：服务商连通性动作子 hook（从 useModelProfilesState 拆出）。
 *
 * 职责：runTest（单模型连通测试）、runScan（扫描服务器可用模型并合并）、
 * runCheck（服务商握手连通检查）。三者共用 refresh / notify / runAsLocalMutation
 * 与各自的 busy 状态。
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
  mergeModelIds,
  upsertProfile,
  type ProviderProfile,
} from '../../api/providerProfiles';
import { applyMetaForModel } from './modelsIpcHelpers';

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
      const key = `${selected.id}::${model}`;
      setTestBusy(key);

      try {
        // 重新读取最新 profile，避免基于陈旧引用测试
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
      void runAsLocalMutation(() => {
        const fresh =
          loadProfiles().find((p) => p.id === selected.id) || selected;
        const merged = mergeModelIds(fresh.models, selectedModels);
        upsertProfile({ ...fresh, models: merged });
        // 仅对新添加的模型预填默认能力与单价；已存在模型的手工配置零触碰
        const existing = new Set(
          fresh.models.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean)
        );
        const newIds = selectedModels.filter((m) => m.trim() && !existing.has(m.trim()));
        for (const m of newIds) {
          applyMetaForModel(fresh.id, m, {
            displayName: '',
            contextLength: '',
            caps: { tools: true, image: false, video: false, reasoning: false },
          });
        }
        refresh();
        notify(true, `已同步 ${selectedModels.length} 个模型（新增 ${newIds.length} 个）`);
      });
    },
    [selected, runAsLocalMutation, refresh, notify],
  );

  const runCheck = useCallback(
    async () => {
      if (!selected) return;
      setCheckBusy(true);
      try {
        const fresh =
          loadProfiles().find((p) => p.id === selected.id) || selected;
        const firstModel = fresh.models[0] || '';
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
