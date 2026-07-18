/**
 * 正式版首次向导：密钥 → 模型（可手填）→ 项目 → 开始
 *
 * 契约：写入 providerProfiles（LS）+ activateProfileModel（ENGINE-CONFIG）。
 * 引导态只用页内 error/hint，成功路径禁止 toast。
 * 默认服务商不预置模型 id（无 mimo 硬编码 / 不发明远程演示默认）。
 * 模型步可「稍后手填」——由底栏 ModelPicker / needsModel soft-hint 接手。
 */

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  activateProfileModel,
  anyProfileHasKey,
  loadProfiles,
  normalizeModelIds,
  profileDisplayLabel,
  saveProfileKey,
  type ProviderProfile,
} from '../api/providerProfiles';
import {
  addProjectFromPath,
  getActiveProject,
  getWorkspacePath,
} from '../api/projectStore';
import { networkUserMessage } from '../api/userFacingErrors';
import { fetchEngineStatus } from '../api/engineConfig';
import { SettingsSelect } from './SettingsSelect';
import styles from './FirstRunWizard.module.css';

const DONE_KEY = 'crish_first_run_done_v1';

/** 向导盖层是否挂载（组件生命周期；与 LS done 标记解耦，避免中途写密钥后 soft-hint 抢位） */
let firstRunOverlayMounted = false;

export function isFirstRunOverlayOpen(): boolean {
  return firstRunOverlayMounted;
}

export function isFirstRunDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === '1';
  } catch {
    return true;
  }
}

export function markFirstRunDone() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    /* ignore */
  }
}

/**
 * 手填 / 列表模型 id 规范化：trim。
 * 纯函数，供向导与单测共用；不在此剥离内部空白（留给校验报页内 error）。
 */
export function normalizeHandFilledModelId(raw: string): string {
  return String(raw ?? '').trim();
}

/** 手填模型 id 合理上限（防粘贴整段文档） */
export const WIZARD_MODEL_ID_MAX_LEN = 128;

/** 向导模型 id 校验结果（判别联合，供 UI / 测试共用） */
export type WizardModelIdResult =
  | { ok: true; modelId: string }
  | { ok: false; error: string };

/** 成功支路 type guard：调用侧可安全读 modelId */
export function isWizardModelIdOk(
  r: WizardModelIdResult,
): r is Extract<WizardModelIdResult, { ok: true }> {
  return r.ok === true;
}

/** 失败支路 type guard：调用侧可安全读 error（页内 alert 文案） */
export function isWizardModelIdError(
  r: WizardModelIdResult,
): r is Extract<WizardModelIdResult, { ok: false }> {
  return r.ok === false;
}

/**
 * 校验向导模型步输入（列表选中或手填）。
 * 成功路径不 toast；错误文案仅供页内 role=alert。
 */
export function validateWizardModelId(raw: string): WizardModelIdResult {
  const modelId = normalizeHandFilledModelId(raw);
  if (!modelId) {
    return { ok: false, error: '请手填模型 id，或从上方列表选择' };
  }
  if (/\s/.test(modelId)) {
    return { ok: false, error: '模型 id 不能包含空格' };
  }
  // 控制字符 / 不可见字符（粘贴污染）
  if (/[\u0000-\u001F\u007F]/.test(modelId)) {
    return { ok: false, error: '模型 id 含有非法字符' };
  }
  if (modelId.length > WIZARD_MODEL_ID_MAX_LEN) {
    return { ok: false, error: `模型 id 过长（最多 ${WIZARD_MODEL_ID_MAX_LEN} 字符）` };
  }
  return { ok: true, modelId };
}

/**
 * 向导模型列表守卫（纯）：trim / 去空 / 去重。
 * 空 catalog → []，绝不发明远程演示 id（如 mimo）。
 */
export function wizardListedModels(
  profile: Pick<ProviderProfile, 'models'> | null | undefined,
): string[] {
  return normalizeModelIds(profile?.models);
}

/** 空列表 / 无服务商时模型步中文提示（纯，页内 hint，不 toast） */
export function wizardEmptyModelCatalogHint(hasProfile: boolean): string {
  if (!hasProfile) {
    return '暂无可用服务商。请稍后在设置中添加，或跳过向导。';
  }
  return '本机目录为空：请手填供应商文档中的 model id，或稍后在设置中「获取列表」。不会预置任何远程演示模型。';
}

/** 密钥步 saveProfileKey 返回的已知 error code（宽字符串兼容未知支路） */
export type WizardKeySaveErrorCode =
  | 'empty_key'
  | 'not_connected'
  | 'profile_not_found'
  | (string & {});

/** 密钥步页内决策：block 停步展示 error；continue 进模型手填步 */
export type WizardKeySaveDecision =
  | { action: 'block'; error: string }
  | { action: 'continue' };

/**
 * 将 saveProfileKey 结果映射为页内决策（判别联合）。
 * empty_key / 关键失败 → block + 页内 error；密钥已落盘的软同步失败 → continue。
 */
export function decideWizardKeySave(res: {
  ok: boolean;
  error?: string;
}): WizardKeySaveDecision {
  if (res.ok) return { action: 'continue' };
  const code = (res.error || '') as WizardKeySaveErrorCode;
  if (code === 'empty_key') {
    return { action: 'block', error: '请粘贴 API 密钥' };
  }
  if (code === 'profile_not_found') {
    return { action: 'block', error: '服务商不存在，请重新选择' };
  }
  if (code === 'not_connected') {
    // 密钥已落盘，但向导需告知引擎未连上（页内，不 toast）
    return { action: 'block', error: networkUserMessage() };
  }
  // 其它引擎同步失败：本地密钥已有，允许继续手填模型
  return { action: 'continue' };
}

/** 模型激活失败时的已知 code */
export type WizardActivateErrorCode =
  | 'not_connected'
  | 'empty_model'
  | 'profile_not_found'
  | (string & {});

/**
 * activateProfileModel 失败 → 页内 error 文案（成功返回 null，调用方不 toast）。
 */
export function wizardActivatePageError(res: {
  ok: boolean;
  error?: string;
}): string | null {
  if (res.ok) return null;
  const code = (res.error || '') as WizardActivateErrorCode;
  if (code === 'not_connected') return networkUserMessage();
  if (code === 'empty_model') return '请填写模型 id';
  if (code === 'profile_not_found') return '服务商不存在，请重新选择';
  return '启用失败，请检查密钥与地址';
}

/** 向导步（字面量联合，禁止任意 number） */
export type WizardStep = 0 | 1 | 2 | 3;

const WIZARD_STEPS: readonly WizardStep[] = [0, 1, 2, 3];

export function isWizardStep(n: number): n is WizardStep {
  return (WIZARD_STEPS as readonly number[]).includes(n);
}

/** 上一步：到 0 为止，无 as 断言 */
export function prevWizardStep(s: WizardStep): WizardStep {
  if (s === 0) return 0;
  const prev = s - 1;
  return isWizardStep(prev) ? prev : 0;
}

/** 下一步：到 3 为止，无 as 断言 */
export function nextWizardStep(s: WizardStep): WizardStep {
  if (s === 3) return 3;
  const next = s + 1;
  return isWizardStep(next) ? next : 3;
}

/** 中文步骤元数据（标题 + 简述；纯，供轨与副标题共用） */
export type WizardStepMeta = {
  id: WizardStep;
  title: string;
  desc: string;
};

export const WIZARD_STEP_META: readonly WizardStepMeta[] = [
  { id: 0, title: '配置密钥', desc: '选择服务商并粘贴 API 密钥' },
  { id: 1, title: '启用模型', desc: '手填或选择模型 id 并写入引擎' },
  { id: 2, title: '选择项目', desc: '可选，也可稍后选择' },
  { id: 3, title: '开始使用', desc: '进入主界面' },
];

/** 安全取步骤元数据（越界回落首步，无 as） */
export function wizardStepMeta(step: WizardStep): WizardStepMeta {
  const found = WIZARD_STEP_META.find((s) => s.id === step);
  return found ?? WIZARD_STEP_META[0];
}

/** 主按钮中文文案（按步密度区分，纯） */
export function wizardPrimaryCtaLabel(step: WizardStep, busy: boolean): string {
  if (busy) return '处理中…';
  if (step === 0) return '保存并继续';
  if (step === 1) return '启用并继续';
  if (step === 2) return '继续';
  return '进入 Crish';
}

/**
 * 冷启动是否应挂载向导：正式版、未完成、且本机尚未配密钥。
 * 已有密钥则落盘完成标记（模型可在底栏手填 / 设置页完成）。
 * 无副作用查询请用 isFirstRunDone / anyProfileHasKey；盖层是否打开用 isFirstRunOverlayOpen。
 */
export function shouldShowFirstRunWizard(): boolean {
  if (isFirstRunDone()) return false;
  // 已有密钥视为用户会用，不再强制向导（模型可手填）
  if (anyProfileHasKey()) {
    markFirstRunDone();
    return false;
  }
  return true;
}

type Step = WizardStep;

type Props = {
  onDone: () => void;
  onOpenSettings?: () => void;
};

async function pickFolderNative(): Promise<string | null> {
  try {
    // Optional desktop plugin; avoid Function() dynamic import
    const dialogSpec = '@tauri-apps/plugin-dialog';
    const mod = (await import(/* @vite-ignore */ dialogSpec).catch(() => null)) as {
      open?: (opts: { directory: boolean; multiple: boolean }) => Promise<string | string[] | null>;
    } | null;
    if (mod?.open) {
      const selected = await mod.open({ directory: true, multiple: false });
      if (typeof selected === 'string' && selected) return selected;
    }
  } catch {
    /* browser */
  }
  return null;
}

export const FirstRunWizard: React.FC<Props> = ({ onDone, onOpenSettings }) => {
  const reactId = useId();
  const titleId = `first-run-title-${reactId}`;
  const subId = `first-run-sub-${reactId}`;
  const stepStatusId = `first-run-step-status-${reactId}`;
  const errorId = `first-run-error-${reactId}`;
  const providerId = `first-run-provider-${reactId}`;
  const keyId = `first-run-key-${reactId}`;
  const modelIdField = `first-run-model-${reactId}`;
  const modelCustomId = `first-run-model-custom-${reactId}`;
  const pathId = `first-run-path-${reactId}`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [step, setStep] = useState<Step>(0);
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
    firstRunOverlayMounted = true;
    return () => {
      firstRunOverlayMounted = false;
    };
  }, []);

  // 步进后把焦点送入正文，便于读屏与键盘用户
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [step]);

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

  const hasProject = Boolean(getActiveProject() || getWorkspacePath());
  void projectTick;

  const activeMeta = wizardStepMeta(step);
  const stepProgressLabel = `第 ${step + 1} / ${WIZARD_STEP_META.length} 步 · ${activeMeta.title}`;

  const finish = () => {
    markFirstRunDone();
    onDone();
  };

  /** 模型步跳过：不 activate、不 toast；底栏手填 / needsModel soft-hint 接手 */
  const skipModelStep = () => {
    setError('');
    setStep(nextWizardStep(1));
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
      if (!hasProject && pathDraft.trim()) {
        addProjectFromPath(pathDraft.trim());
        setProjectTick((n) => n + 1);
      }
      setStep(nextWizardStep(2));
    }
  };

  const fieldDescribedBy = error ? errorId : undefined;

  return (
    <div
      className={styles.firstRunRoot}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subId}
    >
      <div className={styles.firstRunCard}>
        <div className={styles.firstRunBrand}>
          <div className={styles.firstRunLogo} aria-hidden="true">
            C
          </div>
          <div>
            <div className={styles.firstRunTitle} id={titleId}>
              欢迎使用 Crish
            </div>
            <div className={styles.firstRunSub} id={subId}>
              {activeMeta.desc}
            </div>
          </div>
        </div>

        <div
          className={styles.firstRunSteps}
          role="list"
          aria-label="设置步骤"
        >
          {WIZARD_STEP_META.map((s) => {
            const isActive = step === s.id;
            const isDone = step > s.id;
            return (
              <div
                key={s.id}
                role="listitem"
                className={`${styles.firstRunStep} ${isActive ? styles.isActive : ''} ${isDone ? styles.isDone : ''}`}
                aria-current={isActive ? 'step' : undefined}
              >
                <span className={styles.firstRunStepNum} aria-hidden="true">
                  {isDone ? (
                    <Lucide.Check size={14} strokeWidth={2.5} />
                  ) : (
                    s.id + 1
                  )}
                </span>
                <span className="first-run-step-label">{s.title}</span>
              </div>
            );
          })}
        </div>

        <p
          id={stepStatusId}
          className={styles.firstRunHint}
          style={{ margin: 0 }}
          aria-live="polite"
        >
          {stepProgressLabel}
        </p>

        <div
          className={styles.firstRunBody}
          ref={bodyRef}
          aria-labelledby={stepStatusId}
          aria-busy={busy || undefined}
        >
          {error ? (
            <div className={styles.firstRunError} role="alert" id={errorId}>
              {error}
            </div>
          ) : null}

          {step === 0 && (
            <>
              <label className={styles.firstRunLabel} htmlFor={providerId}>
                服务商
              </label>
              {hasProfiles ? (
                <SettingsSelect
                  className={styles.firstRunSelect}
                  value={profileId}
                  disabled={busy}
                  options={profiles.map((p) => ({
                    value: p.id,
                    label: profileDisplayLabel(p),
                  }))}
                  onChange={(id) => {
                    setProfileId(id);
                    // 切换服务商时清空模型；不自动采用列表首项（避免幽灵远程默认）
                    setModelId('');
                    setError('');
                  }}
                />
              ) : (
                <p className={styles.firstRunHint} role="status">
                  暂无服务商配置。可跳过向导，稍后在设置中添加。
                </p>
              )}
              <label className={styles.firstRunLabel} htmlFor={keyId}>
                API 密钥
              </label>
              <input
                id={keyId}
                type="password"
                className={styles.firstRunInput}
                placeholder="粘贴密钥"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                disabled={busy || !hasProfiles}
                aria-invalid={error ? true : undefined}
                aria-describedby={fieldDescribedBy}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError('');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) {
                    e.preventDefault();
                    void advanceFromStep();
                  }
                }}
              />
              <p className={styles.firstRunHint}>
                密钥仅保存在本机。不会预置模型 id，也不会采用远程演示默认。
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <label className={styles.firstRunLabel} htmlFor={modelIdField}>
                模型 id
              </label>
              {hasListedModels ? (
                <>
                  <SettingsSelect
                    className={styles.firstRunSelect}
                    value={modelInList ? modelId : ''}
                    disabled={busy}
                    placeholder="从本机列表选择…"
                    options={[
                      { value: '', label: '从本机列表选择…' },
                      ...listedModels.map((m) => ({ value: m, label: m })),
                    ]}
                    onChange={(v) => {
                      setModelId(v);
                      setError('');
                    }}
                  />
                  <label className={styles.firstRunLabel} htmlFor={modelCustomId}>
                    或手填模型 id
                  </label>
                  <input
                    id={modelCustomId}
                    className={styles.firstRunInput}
                    placeholder="例如 deepseek-chat、gpt-4o"
                    value={modelInList ? '' : modelId}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={fieldDescribedBy}
                    onChange={(e) => {
                      setModelId(e.target.value);
                      setError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) {
                        e.preventDefault();
                        void advanceFromStep();
                      }
                    }}
                  />
                </>
              ) : (
                <input
                  id={modelIdField}
                  className={styles.firstRunInput}
                  placeholder="输入模型 id（如 deepseek-chat）"
                  value={modelId}
                  disabled={busy}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={fieldDescribedBy}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    setError('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !busy) {
                      e.preventDefault();
                      void advanceFromStep();
                    }
                  }}
                />
              )}
              <p className={styles.firstRunHint} role="status">
                {hasListedModels
                  ? '选用本机已有 id，或手填供应商文档中的 model id；也可跳过，在主界面底栏手填。'
                  : wizardEmptyModelCatalogHint(hasProfiles && Boolean(activeProfile))}
              </p>
            </>
          )}

          {step === 2 && (
            <>
              <p className={styles.firstRunHint} style={{ marginTop: 0 }}>
                选择工作目录后，助手会在该项目下读写文件。也可跳过，无项目直接对话。
              </p>
              {hasProject ? (
                <div className={styles.firstRunProjectOk} role="status">
                  <Lucide.FolderCheck size={16} aria-hidden="true" />
                  <span>
                    当前：{getActiveProject()?.name || getWorkspacePath()}
                  </span>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${styles.firstRunBtn} ${styles.secondary}`}
                    disabled={busy}
                    aria-busy={busy || undefined}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        const path = await pickFolderNative();
                        if (path) {
                          addProjectFromPath(path);
                          setProjectTick((n) => n + 1);
                        } else {
                          setError('未能打开文件夹选择器，可手动填写路径');
                        }
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <Lucide.FolderInput size={16} aria-hidden="true" />
                    选择文件夹
                  </button>
                  <label className={styles.firstRunLabel} htmlFor={pathId}>
                    或输入路径
                  </label>
                  <input
                    id={pathId}
                    className={styles.firstRunInput}
                    placeholder="例如 C:/workspace/crish"
                    value={pathDraft}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={fieldDescribedBy}
                    onChange={(e) => {
                      setPathDraft(e.target.value);
                      setError('');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !busy) {
                        e.preventDefault();
                        void advanceFromStep();
                      }
                    }}
                  />
                </>
              )}
            </>
          )}

          {step === 3 && (
            <div className={styles.firstRunReady}>
              <Lucide.CheckCircle2
                size={28}
                style={{ color: 'var(--text-secondary)' }}
                aria-hidden="true"
              />
              <div style={{ fontWeight: 600, fontSize: 15 }}>可以开始了</div>
              <p className={styles.firstRunHint} style={{ textAlign: 'center' }}>
                在主界面输入问题即可。随时可在设置中改模型、项目与权限。
              </p>
            </div>
          )}
        </div>

        <div className={styles.firstRunFooter}>
          <button
            type="button"
            className={styles.firstRunLink}
            disabled={busy}
            onClick={finish}
          >
            跳过向导
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button
                type="button"
                className={`${styles.firstRunBtn} ${styles.ghost}`}
                disabled={busy}
                onClick={goPrev}
              >
                上一步
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className={`${styles.firstRunBtn} ${styles.primary}`}
                disabled={busy || (step === 0 && !hasProfiles)}
                aria-busy={busy || undefined}
                onClick={() => {
                  void advanceFromStep();
                }}
              >
                {wizardPrimaryCtaLabel(step, busy)}
              </button>
            ) : (
              <button
                type="button"
                className={`${styles.firstRunBtn} ${styles.primary}`}
                onClick={finish}
              >
                {wizardPrimaryCtaLabel(3, false)}
              </button>
            )}
          </div>
        </div>

        {step === 1 ? (
          <div className={styles.firstRunModelAlt} role="group" aria-label="模型其它方式">
            <button
              type="button"
              className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
              disabled={busy}
              onClick={skipModelStep}
            >
              稍后在底栏手填模型
            </button>
            {onOpenSettings ? (
              <button
                type="button"
                className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
                disabled={busy}
                onClick={() => {
                  // 高级：扫描列表在设置页；不 toast
                  markFirstRunDone();
                  onOpenSettings();
                }}
              >
                打开设置获取模型列表
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};
