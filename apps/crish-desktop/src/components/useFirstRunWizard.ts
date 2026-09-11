/**
 * 首次向导步进状态机 hook：连接表单（名称/URL/密钥/协议）+ 步进逻辑收敛。
 *
 * 职责：
 * - 第 0 步：创建中立 custom 服务商并落盘密钥（无第三方预置）
 * - 步进前进/后退/跳步（advanceFromStep / goPrev / skipModelStep / skipImportStep）
 * - 盖层挂载标记维护（firstRunOverlayFlag）
 * - Esc 三层（有错误先清 → 上一步）
 * - 项目路径落盘（addProjectFromPath）
 * 渲染（轨道/表单/页脚）由壳层与各 Wizard*Step 子组件负责。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  activateProfileModel,
  createCustomProfile,
  loadProfiles,
  saveProfileKey,
  upsertProfile,
  type ProviderProfile,
} from '../api/providerProfiles';
import { ensureProviderShell } from './settings-models/catalogWriteGate';
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
};

export type UseFirstRunWizardResult = {
  step: WizardStep;
  /** 连接表单：厂商名称 */
  vendorName: string;
  baseUrl: string;
  protocol: string;
  apiKey: string;
  modelId: string;
  pathDraft: string;
  busy: boolean;
  error: string;
  /** 刚创建/选中的 profile（模型步用） */
  activeProfile: ProviderProfile | undefined;
  listedModels: string[];
  hasListedModels: boolean;
  hasProfiles: boolean;
  modelInList: boolean;
  hasProject: boolean;
  /** 已激活项目名或工作区路径（展示用） */
  currentProjectLabel: string;
  setVendorName: (v: string) => void;
  setBaseUrl: (v: string) => void;
  setProtocol: (v: string) => void;
  setApiKey: (v: string) => void;
  setModelId: (v: string) => void;
  setPathDraft: (v: string) => void;
  setError: (v: string) => void;
  advanceFromStep: () => Promise<void>;
  goPrev: () => void;
  skipModelStep: () => void;
  skipImportStep: () => void;
  finish: () => void;
  /** 打开系统目录选择器并落盘项目（含 busy / error 状态维护） */
  pickProjectFolder: () => Promise<void>;
};

export function useFirstRunWizard(
  opts: UseFirstRunWizardOptions,
): UseFirstRunWizardResult {
  const [step, setStep] = useState<WizardStep>(0);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => {
    try {
      return loadProfiles();
    } catch {
      return [];
    }
  });
  /** 连接表单（中立，无预置服务商 id） */
  const [createdProfileId, setCreatedProfileId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState(DEFAULT_WIZARD_PROTOCOL);
  const [apiKey, setApiKey] = useState('');
  /** 模型 id：列表选择或手填；默认空 */
  const [modelId, setModelId] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectTick, setProjectTick] = useState(0);

  // 盖层挂载期间 soft-hint 让位；与 LS done 解耦（密钥步落盘后仍保持独占）
  useEffect(() => {
    setFirstRunOverlayOpen(true);
    return () => {
      setFirstRunOverlayOpen(false);
    };
  }, []);

  // Escape：有错误先清；否则上一步；首步不强制关闭（保留「跳过向导」）
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

  // 空 catalog 守卫：规范化后无幽灵空串 / 不去首项当默认
  const listedModels = useMemo(
    () => wizardListedModels(activeProfile),
    [activeProfile],
  );
  const hasListedModels = listedModels.length > 0;
  const hasProfiles = profiles.length > 0;
  const modelInList = hasListedModels && listedModels.includes(modelId);

  // projectTick 仅用于触发重渲染（选择目录 / 手填路径落盘后刷新 hasProject）
  void projectTick;
  const hasProject = Boolean(getActiveProject() || getWorkspacePath());
  const currentProjectLabel = getActiveProject()?.name || getWorkspacePath() || '';

  const finish = () => {
    markFirstRunDone();
    opts.onDone();
  };

  /** 模型步跳过：不 activate、不 toast；底栏手填 / needsModel soft-hint 接手 */
  const skipModelStep = () => {
    setError('');
    setStep(nextWizardStep(1));
  };

  /** 导入步跳过：可选，不强制扫描 */
  const skipImportStep = () => {
    setError('');
    setStep(nextWizardStep(2));
  };

  const goPrev = () => {
    setError('');
    setStep((s) => prevWizardStep(s));
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
        setModelId('');
        setStep(nextWizardStep(0));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === 1) {
      const checked = validateWizardModelId(modelId);
      if (isWizardModelIdError(checked)) {
        setError(checked.error);
        return;
      }
      if (!isWizardModelIdOk(checked)) return;
      const profileId = createdProfileId || activeProfile?.id || '';
      if (!profileId) {
        setError('请先完成连接配置');
        return;
      }
      setBusy(true);
      const res = await activateProfileModel(profileId, checked.modelId);
      setBusy(false);
      const pageErr = wizardActivatePageError(res);
      if (pageErr) {
        setError(pageErr);
        return;
      }
      void fetchEngineStatus();
      setStep(nextWizardStep(1));
      return;
    }
    if (step === 2) {
      setStep(nextWizardStep(2));
      return;
    }
    if (step === 3) {
      if (!hasProject && pathDraft.trim()) {
        addProjectFromPath(pathDraft.trim());
        setProjectTick((n) => n + 1);
      }
      setStep(nextWizardStep(3));
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
    setPathDraft,
    setError,
    advanceFromStep,
    goPrev,
    skipModelStep,
    skipImportStep,
    finish,
    pickProjectFolder,
  };
}
