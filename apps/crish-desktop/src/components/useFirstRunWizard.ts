/**
 * 首次向导步进状态机 hook：7 组状态（step / profiles / profileId / apiKey /
 * modelId / pathDraft / busy / error / projectTick）+ 步进逻辑收敛。
 *
 * 职责：
 * - 步进前进/后退/跳步（advanceFromStep / goPrev / skipModelStep / skipImportStep）
 * - 盖层挂载标记维护（firstRunOverlayFlag）
 * - Esc 三层（有错误先清 → 上一步）
 * - 项目路径落盘（addProjectFromPath）
 * 渲染（轨道/表单/页脚）由壳层与各 Wizard*Step 子组件负责。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  activateProfileModel,
  loadProfiles,
  saveProfileKey,
  type ProviderProfile,
} from '../api/providerProfiles';
import {
  addProjectFromPath,
  getActiveProject,
  getWorkspacePath,
} from '../api/projectStore';
import { openDirectoryDialogSafe } from '../api/openDirectoryDialog';
import { fetchEngineStatus } from '../api/engineConfig';
import { setFirstRunOverlayOpen } from './firstRunOverlayFlag';
import {
  decideWizardKeySave,
  isWizardModelIdError,
  isWizardModelIdOk,
  markFirstRunDone,
  nextWizardStep,
  prevWizardStep,
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
  profiles: ProviderProfile[];
  profileId: string;
  apiKey: string;
  modelId: string;
  pathDraft: string;
  busy: boolean;
  error: string;
  /** 当前 profile（profileId 找不到时回落首个；无 profile → undefined） */
  activeProfile: ProviderProfile | undefined;
  listedModels: string[];
  hasListedModels: boolean;
  hasProfiles: boolean;
  modelInList: boolean;
  hasProject: boolean;
  /** 已激活项目名或工作区路径（展示用） */
  currentProjectLabel: string;
  setProfileId: (id: string) => void;
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
  const [profileId, setProfileId] = useState(() => profiles[0]?.id || '');
  const [apiKey, setApiKey] = useState('');
  /** 模型 id：列表选择或手填；默认空（服务商不预置模型 / 不读引擎演示默认） */
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

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) || profiles[0],
    [profiles, profileId],
  );

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
      if (!hasProfiles || !profileId) {
        setError('请选择服务商');
        return;
      }
      const key = apiKey.trim();
      if (!key) {
        setError('请粘贴 API 密钥');
        return;
      }
      setBusy(true);
      // 密钥步不强制模型：仅落盘密钥；模型在下一步手填（不读引擎默认）
      const res = await saveProfileKey(profileId, key);
      try {
        setProfiles(loadProfiles());
      } catch {
        /* keep previous */
      }
      setBusy(false);
      const decision = decideWizardKeySave(res);
      if (decision.action === 'block') {
        // 页内 error；不 toast
        setError(decision.error);
        return;
      }
      // 密钥已落盘；可继续手填模型（不自动填列表首项）
      setModelId('');
      setStep(nextWizardStep(0));
      return;
    }
    if (step === 1) {
      const checked = validateWizardModelId(modelId);
      if (isWizardModelIdError(checked)) {
        // 页内错误；不 toast
        setError(checked.error);
        return;
      }
      // 成功支路：判别联合收窄到 modelId
      if (!isWizardModelIdOk(checked)) return;
      if (!profileId) {
        setError('请选择服务商');
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
      // 成功不 toast；页内进入下一步（状态刷新不写入向导 model 默认）
      void fetchEngineStatus();
      setStep(nextWizardStep(1));
      return;
    }
    if (step === 2) {
      // 导入步：可选，点「继续」即跳过未导入项
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
      // 首次向导：选择项目文件夹
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
    profiles,
    profileId,
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
    setProfileId,
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
