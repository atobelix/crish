/**
 * 首次向导步进状态机 hook：连接表单（名称/URL/密钥/协议）+ 模型完整配置与在线探测 + 步进逻辑。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  activateProfileModel,
  saveProfileKey,
  type ProviderProfile,
} from '../api/providerProfiles';
import { scanProviderModels } from '../api/modelCatalogIpc';
import { modelsCatalogStore } from '../api/modelsCatalogStore';
import { listLiveProviders, toProviderView } from '../api/modelsCatalogLive';
import { useModelsCatalogVersion } from '../hooks/useModelsCatalogVersion';
import { thinkingVocabularyDiagnostic } from '../api/modelsNormalize';
import {
  addDraftToModelInput,
  ensureProviderShell,
} from './settings-models/catalogWriteGate';
import {
  emptyAddDraft,
  type AddModelDraft,
} from './settings-models/modelsIpcHelpers';
import { calculateAutofillDraft } from './settings-models/manualAddAutofill';
import { getActiveProject, getWorkspacePath } from '../api/projectStore';
import {
  addProjectFromRecentPath,
  pickAndAddWorkspaceProject,
  WorkspaceAccessError,
} from '../api/workspaceAccessApi';
import { fetchEngineStatus } from '../api/engineConfig';
import { setFirstRunOverlayOpen } from './firstRunOverlayFlag';
import {
  DEFAULT_WIZARD_PROTOCOL,
  decideWizardKeySave,
  isWizardModelIdError,
  isWizardModelIdOk,
  isWizardStep,
  markFirstRunDone,
  nextWizardStep,
  prevWizardStep,
  validateWizardConnectForm,
  validateWizardModelId,
  wizardActivatePageError,
  wizardListedModels,
  type WizardStep,
} from './firstRunWizardLib';

export type UseFirstRunWizardOptions = {
  onDone: () => void;
  initialStep?: WizardStep;
};

export type UseFirstRunWizardResult = {
  step: WizardStep;
  vendorName: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
  modelId: string;
  addDraft: AddModelDraft;
  isDefaultModel: boolean;
  scanBusy: boolean;
  scannedModels: string[];
  pathDraft: string;
  busy: boolean;
  error: string;
  activeProfile: ProviderProfile | undefined;
  listedModels: string[];
  hasListedModels: boolean;
  hasProfiles: boolean;
  modelInList: boolean;
  hasProject: boolean;
  currentProjectLabel: string;
  setVendorName: (v: string) => void;
  setBaseUrl: (v: string) => void;
  setProtocol: (v: string) => void;
  setApiKey: (v: string) => void;
  setModelId: (v: string) => void;
  setAddDraft: React.Dispatch<React.SetStateAction<AddModelDraft>>;
  setIsDefaultModel: (v: boolean) => void;
  setPathDraft: (v: string) => void;
  setError: (v: string) => void;
  runScan: () => Promise<void>;
  advanceFromStep: () => Promise<void>;
  goPrev: () => void;
  goToStep: (target: WizardStep) => void;
  skipConnectStep: () => void;
  skipModelStep: () => void;
  skipProjectStep: () => void;
  finish: () => void;
  pickProjectFolder: () => Promise<void>;
};

export function useFirstRunWizard(
  opts: UseFirstRunWizardOptions
): UseFirstRunWizardResult {
  const [step, setStep] = useState<WizardStep>(() =>
    opts.initialStep !== undefined && isWizardStep(opts.initialStep)
      ? opts.initialStep
      : 0
  );
  const [createdProfileId, setCreatedProfileId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState(DEFAULT_WIZARD_PROTOCOL);
  const [apiKey, setApiKey] = useState('');
  const [addDraft, setAddDraft] = useState<AddModelDraft>(() =>
    emptyAddDraft()
  );
  const [isDefaultModel, setIsDefaultModel] = useState(true);
  const [scanBusy, setScanBusy] = useState(false);
  const [scannedModels, setScannedModels] = useState<string[]>([]);
  const [pathDraft, setPathDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectTick, setProjectTick] = useState(0);

  const modelId = addDraft.modelId;
  const setModelId = useCallback((v: string) => {
    setAddDraft((prev) => ({ ...prev, modelId: v }));
  }, []);

  // 服务商名单唯一来源 = 统一树（含空树：向导第一步自建供应商）。
  const catalogVersion = useModelsCatalogVersion();
  const profiles = useMemo<ProviderProfile[]>(
    () => listLiveProviders().map(toProviderView),
    [catalogVersion]
  );

  useEffect(() => {
    setFirstRunOverlayOpen(true);
    return () => {
      setFirstRunOverlayOpen(false);
    };
  }, []);

  useEffect(() => {
    if (opts.initialStep !== undefined && isWizardStep(opts.initialStep)) {
      setError('');
      setStep(opts.initialStep);
    }
  }, [opts.initialStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (busy) return;
      e.preventDefault();
      if (error) {
        setError('');
        return;
      }
      if (step > 0) {
        setStep((s) => prevWizardStep(s));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, error, step]);

  const activeProfile = useMemo(() => {
    if (createdProfileId) {
      return profiles.find((p) => p.id === createdProfileId);
    }
    return profiles[0];
  }, [profiles, createdProfileId]);

  const listedModels = useMemo(
    () => wizardListedModels(activeProfile),
    [activeProfile]
  );
  const hasListedModels = listedModels.length > 0;
  const hasProfiles = profiles.length > 0;
  const modelInList = hasListedModels && listedModels.includes(modelId);

  void projectTick;
  const hasProject = Boolean(getActiveProject() || getWorkspacePath());
  const currentProjectLabel =
    getActiveProject()?.name || getWorkspacePath() || '';

  const runScan = useCallback(async () => {
    const targetId = (
      createdProfileId ||
      activeProfile?.id ||
      profiles[0]?.id ||
      ''
    ).trim();
    if (!targetId) {
      setError('请先在上一步配置服务商与 API 密钥，再在线获取模型');
      return;
    }
    setScanBusy(true);
    setError('');
    try {
      const r = await scanProviderModels(targetId);
      if (r.ok && r.models?.length) {
        setScannedModels(r.models);
      } else {
        setError(r.error || '未能从服务商获取到模型列表，可手动输入模型 ID');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanBusy(false);
    }
  }, [createdProfileId, activeProfile, profiles]);

  const finish = () => {
    markFirstRunDone();
    opts.onDone();
  };

  const skipConnectStep = () => {
    setError('');
    setStep(nextWizardStep(0));
  };

  const skipModelStep = () => {
    setError('');
    setStep(nextWizardStep(1));
  };

  const skipProjectStep = () => {
    setError('');
    setStep(nextWizardStep(2));
  };

  const goPrev = () => {
    setError('');
    setStep((s) => prevWizardStep(s));
  };

  const goToStep = (target: WizardStep) => {
    if (busy || !isWizardStep(target)) return;
    setError('');
    setStep(target);
  };

  const advanceFromStep = async () => {
    setError('');
    if (step === 0) {
      const checked = validateWizardConnectForm({
        name: vendorName,
        baseUrl,
        apiKey,
        protocol,
      });
      if (!checked.ok) {
        setError(checked.error);
        return;
      }
      setBusy(true);
      try {
        const protocolCast = checked.protocol as ProviderProfile['protocol'];
        // 单轨：供应商只写统一树（重复提交 = 更新同一 shell，幂等）。
        const profileId =
          createdProfileId || `custom-${Date.now().toString(36)}`;
        const shell = await ensureProviderShell({
          providerId: profileId,
          displayName: checked.name,
          baseUrl: checked.baseUrl,
          protocol: protocolCast,
        });
        if (!shell.ok) {
          setError(shell.error || '写入服务商失败');
          return;
        }
        setCreatedProfileId(profileId);
        const res = await saveProfileKey(profileId, checked.apiKey);
        const decision = decideWizardKeySave(res);
        if (decision.action === 'block') {
          setError(decision.error);
          return;
        }
        setAddDraft(emptyAddDraft());
        setScannedModels([]);
        setStep(nextWizardStep(0));
        // 保存密钥后后台自动探测在线模型列表，供下一步下拉选择
        void scanProviderModels(profileId)
          .then((r) => {
            if (r.ok && r.models?.length) {
              setScannedModels(r.models);
            }
          })
          .catch(() => {
            /* 预探测失败静默回退，用户可在下一步手动输入或点击重新获取 */
          });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 1) {
      const checked = validateWizardModelId(addDraft.modelId);
      if (isWizardModelIdError(checked)) {
        setError(checked.error);
        return;
      }
      if (!isWizardModelIdOk(checked)) return;
      if (addDraft.thinkingEnabled === true) {
        const diag = thinkingVocabularyDiagnostic(addDraft.thinkingMap);
        if (diag) {
          setError(diag);
          return;
        }
      }
      const profileId = createdProfileId || activeProfile?.id || '';
      if (!profileId) {
        setError('请先完成服务商配置');
        return;
      }
      setBusy(true);
      try {
        const vendorHint =
          activeProfile?.id && !activeProfile.id.startsWith('custom-')
            ? activeProfile.id
            : activeProfile?.name || vendorName || undefined;
        const resolvedDraft = calculateAutofillDraft(
          checked.modelId,
          vendorHint,
          addDraft
        );
        try {
          await modelsCatalogStore.addModel(
            profileId,
            addDraftToModelInput(checked.modelId, resolvedDraft)
          );
        } catch {
          /* 非法草稿由 addModel 显式报错；此处吞异常会导致下一步无模型可选 */
        }
        // 激活即树 CAS 提交（内核落盘后自动 reload_provider）；「设为默认」
        // 与激活是同一动作，禁止再写第二份活跃标记。
        if (isDefaultModel) {
          const res = await activateProfileModel(profileId, checked.modelId);
          const pageErr = wizardActivatePageError(res);
          if (pageErr) {
            setError(pageErr);
            return;
          }
        }
        void fetchEngineStatus();
        setStep(nextWizardStep(1));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 2) {
      if (!hasProject && pathDraft.trim()) {
        try {
          await addProjectFromRecentPath(pathDraft.trim());
        } catch (error) {
          setError(
            error instanceof WorkspaceAccessError
              ? error.message
              : '该路径未获授权，请重新选择项目文件夹。'
          );
          return;
        }
        setProjectTick((n) => n + 1);
      }
      setStep(nextWizardStep(2));
      return;
    }
    if (step === 3) {
      finish();
    }
  };

  const pickProjectFolder = async () => {
    setBusy(true);
    setError('');
    try {
      const project = await pickAndAddWorkspaceProject();
      if (project) {
        setProjectTick((n) => n + 1);
      }
    } catch (error) {
      setError(
        error instanceof WorkspaceAccessError
          ? error.message
          : '无法打开本地文件夹选择器。'
      );
    } finally {
      setBusy(false);
    }
  };

  return {
    step,
    vendorName,
    baseUrl,
    protocol,
    apiKey,
    modelId,
    addDraft,
    isDefaultModel,
    scanBusy,
    scannedModels,
    pathDraft,
    busy,
    error,
    activeProfile,
    listedModels,
    hasListedModels,
    hasProfiles,
    modelInList,
    hasProject,
    currentProjectLabel,
    setVendorName,
    setBaseUrl,
    setProtocol,
    setApiKey,
    setModelId,
    setAddDraft,
    setIsDefaultModel,
    setPathDraft,
    setError,
    runScan,
    advanceFromStep,
    goPrev,
    goToStep,
    skipConnectStep,
    skipModelStep,
    skipProjectStep,
    finish,
    pickProjectFolder,
  };
}
