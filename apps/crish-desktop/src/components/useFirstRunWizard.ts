/**
 * 首次向导步进状态机 hook：连接表单（名称/URL/密钥/协议）+ 模型完整配置与在线探测 + 步进逻辑。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  activateProfileModel,
  createCustomProfile,
  loadProfiles,
  saveProfileKey,
  upsertProfile,
  type ProviderProfile,
} from '../api/providerProfiles';
import { scanProviderModels } from '../api/modelCatalog';
import { modelsCatalogStore } from '../api/modelsCatalogStore';
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
import {
  addProjectFromPath,
  getActiveProject,
  getWorkspacePath,
} from '../api/projectStore';
import { openDirectoryDialogSafe } from '../api/openDirectoryDialog';
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
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => {
    try {
      return loadProfiles();
    } catch {
      return [];
    }
  });
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
    const freshProfiles = (() => {
      try {
        return loadProfiles();
      } catch {
        return profiles;
      }
    })();
    const target =
      (createdProfileId
        ? freshProfiles.find((p) => p.id === createdProfileId)
        : undefined) ||
      activeProfile ||
      freshProfiles[0];
    if (!target) {
      setError('请先在上一步配置服务商与 API 密钥，再在线获取模型');
      return;
    }
    setScanBusy(true);
    setError('');
    try {
      const r = await scanProviderModels(target);
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
        let profile: ProviderProfile;
        const existing = createdProfileId
          ? loadProfiles().find((p) => p.id === createdProfileId)
          : undefined;
        if (existing) {
          profile = {
            ...existing,
            name: checked.name,
            baseUrl: checked.baseUrl,
            protocol: protocolCast,
          };
          upsertProfile(profile);
        } else {
          profile = createCustomProfile({
            name: checked.name,
            baseUrl: checked.baseUrl,
            protocol: protocolCast,
          });
        }
        setCreatedProfileId(profile.id);
        const shell = await ensureProviderShell({
          providerId: profile.id,
          displayName: profile.name,
          baseUrl: profile.baseUrl,
          protocol: profile.protocol,
        });
        if (!shell.ok) {
          setError(shell.error || '写入服务商失败');
          return;
        }
        const res = await saveProfileKey(profile.id, checked.apiKey);
        try {
          setProfiles(loadProfiles());
        } catch {
          /* keep previous */
        }
        const decision = decideWizardKeySave(res);
        if (decision.action === 'block') {
          setError(decision.error);
          return;
        }
        setAddDraft(emptyAddDraft());
        setScannedModels([]);
        setStep(nextWizardStep(0));
        // 保存密钥后后台自动探测在线模型列表，供下一步下拉选择
        void scanProviderModels({ ...profile, hasKey: true })
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
          if (isDefaultModel) {
            await modelsCatalogStore.setActiveModel({
              providerId: profileId,
              modelId: checked.modelId,
            });
          }
        } catch {
          /* 单元测试或非 Tauri 环境下由 activateProfileModel 兜底同步 */
        }
        const res = await activateProfileModel(profileId, checked.modelId);
        const pageErr = wizardActivatePageError(res);
        if (pageErr) {
          setError(pageErr);
          return;
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
        addProjectFromPath(pathDraft.trim());
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
      const path = await openDirectoryDialogSafe('选择项目文件夹');
      if (path) {
        addProjectFromPath(path);
        setProjectTick((n) => n + 1);
      } else {
        setError('未能打开文件夹选择器，可手动填写路径');
      }
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
