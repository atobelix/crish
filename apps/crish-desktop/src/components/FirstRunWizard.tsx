/**
 * 正式版首次向导：密钥 → 模型 → 项目 → 开始
 */

import React, { useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  activateProfileModel,
  anyProfileHasKey,
  loadProfiles,
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

const DONE_KEY = 'crish_first_run_done_v1';

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

/** 是否应展示向导：正式版、未完成、且尚未配好密钥 */
export function shouldShowFirstRunWizard(): boolean {
  if (isFirstRunDone()) return false;
  // 已有密钥视为用户会用，不再强制向导
  if (anyProfileHasKey()) {
    markFirstRunDone();
    return false;
  }
  return true;
}

type Step = 0 | 1 | 2 | 3;

type Props = {
  onDone: () => void;
  onOpenSettings?: () => void;
};

async function pickFolderNative(): Promise<string | null> {
  try {
    const mod: any = await (Function('return import("@tauri-apps/plugin-dialog")')() as Promise<any>).catch(
      () => null,
    );
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
  const [step, setStep] = useState<Step>(0);
  const [profiles, setProfiles] = useState<ProviderProfile[]>(() => loadProfiles());
  const [profileId, setProfileId] = useState(() => profiles[0]?.id || '');
  const [apiKey, setApiKey] = useState('');
  const [modelId, setModelId] = useState(() => profiles[0]?.models[0] || '');
  const [pathDraft, setPathDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [projectTick, setProjectTick] = useState(0);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === profileId) || profiles[0],
    [profiles, profileId],
  );

  const hasProject = Boolean(getActiveProject() || getWorkspacePath());
  void projectTick;

  const finish = () => {
    markFirstRunDone();
    onDone();
  };

  const steps = [
    { id: 0 as const, title: '配置密钥', desc: '选择服务商并粘贴 API 密钥' },
    { id: 1 as const, title: '启用模型', desc: '写入引擎并验证' },
    { id: 2 as const, title: '选择项目', desc: '可选，也可稍后选择' },
    { id: 3 as const, title: '开始使用', desc: '进入主界面' },
  ];

  return (
    <div className="first-run-root" role="dialog" aria-label="首次设置">
      <div className="first-run-card">
        <div className="first-run-brand">
          <div className="first-run-logo">C</div>
          <div>
            <div className="first-run-title">欢迎使用 Crish</div>
            <div className="first-run-sub">完成几步即可开始对话</div>
          </div>
        </div>

        <div className="first-run-steps">
          {steps.map((s) => (
            <div
              key={s.id}
              className={`first-run-step ${step === s.id ? 'is-active' : ''} ${step > s.id ? 'is-done' : ''}`}
            >
              <span className="first-run-step-num">{step > s.id ? '✓' : s.id + 1}</span>
              <span className="first-run-step-label">{s.title}</span>
            </div>
          ))}
        </div>

        <div className="first-run-body">
          {error && <div className="first-run-error">{error}</div>}

          {step === 0 && (
            <>
              <label className="first-run-label">服务商</label>
              <select
                className="first-run-input"
                value={profileId}
                onChange={(e) => {
                  const id = e.target.value;
                  setProfileId(id);
                  const p = profiles.find((x) => x.id === id);
                  setModelId(p?.models[0] || '');
                  setError('');
                }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <label className="first-run-label">API 密钥</label>
              <input
                type="password"
                className="first-run-input"
                placeholder="粘贴密钥"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setError('');
                }}
                autoFocus
              />
              <p className="first-run-hint">密钥仅保存在本机，用于调用所选服务商。</p>
            </>
          )}

          {step === 1 && (
            <>
              <label className="first-run-label">模型</label>
              <select
                className="first-run-input"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              >
                {(activeProfile?.models || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              {!modelId && (
                <p className="first-run-hint">该服务商还没有模型 ID，可到设置中添加后再试。</p>
              )}
              <p className="first-run-hint">将把密钥与模型同步到本地引擎。</p>
            </>
          )}

          {step === 2 && (
            <>
              <p className="first-run-hint" style={{ marginTop: 0 }}>
                选择工作目录后，助手会在该项目下读写文件。也可跳过，无项目直接对话。
              </p>
              {hasProject ? (
                <div className="first-run-project-ok">
                  <Lucide.FolderCheck size={16} />
                  <span>
                    当前：{getActiveProject()?.name || getWorkspacePath()}
                  </span>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="first-run-btn secondary"
                    disabled={busy}
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
                    <Lucide.FolderInput size={16} />
                    选择文件夹
                  </button>
                  <label className="first-run-label">或输入路径</label>
                  <input
                    className="first-run-input"
                    placeholder="例如 C:/Software/conex"
                    value={pathDraft}
                    onChange={(e) => setPathDraft(e.target.value)}
                  />
                </>
              )}
            </>
          )}

          {step === 3 && (
            <div className="first-run-ready">
              <Lucide.CheckCircle2 size={28} style={{ color: 'var(--text-secondary)' }} />
              <div style={{ fontWeight: 600, fontSize: 15 }}>可以开始了</div>
              <p className="first-run-hint" style={{ textAlign: 'center' }}>
                在主界面输入问题即可。随时可在设置中改模型、项目与权限。
              </p>
            </div>
          )}
        </div>

        <div className="first-run-footer">
          <button type="button" className="first-run-link" onClick={finish}>
            跳过向导
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button
                type="button"
                className="first-run-btn ghost"
                disabled={busy}
                onClick={() => {
                  setError('');
                  setStep((s) => (s - 1) as Step);
                }}
              >
                上一步
              </button>
            )}
            {step < 3 ? (
              <button
                type="button"
                className="first-run-btn primary"
                disabled={busy}
                onClick={async () => {
                  setError('');
                  if (step === 0) {
                    const key = apiKey.trim();
                    if (!key) {
                      setError('请粘贴 API 密钥');
                      return;
                    }
                    if (!profileId) {
                      setError('请选择服务商');
                      return;
                    }
                    setBusy(true);
                    const res = await saveProfileKey(profileId, key, {
                      activateModel: modelId || activeProfile?.models[0],
                    });
                    setProfiles(loadProfiles());
                    setBusy(false);
                    if (!res.ok && res.error === 'not_connected') {
                      setError(networkUserMessage());
                      return;
                    }
                    // 密钥已落盘；引擎同步失败也可继续选模型
                    if (!modelId && activeProfile?.models[0]) {
                      setModelId(activeProfile.models[0]);
                    }
                    setStep(1);
                    return;
                  }
                  if (step === 1) {
                    if (!modelId) {
                      setError('请选择模型，或到设置中添加模型 ID');
                      onOpenSettings?.();
                      return;
                    }
                    setBusy(true);
                    const res = await activateProfileModel(profileId, modelId);
                    setBusy(false);
                    if (!res.ok) {
                      setError(
                        res.error === 'not_connected'
                          ? networkUserMessage()
                          : '启用失败，请检查密钥与地址',
                      );
                      return;
                    }
                    void fetchEngineStatus();
                    setStep(2);
                    return;
                  }
                  if (step === 2) {
                    if (!hasProject && pathDraft.trim()) {
                      addProjectFromPath(pathDraft.trim());
                      setProjectTick((n) => n + 1);
                    }
                    setStep(3);
                    return;
                  }
                }}
              >
                {busy ? '处理中…' : '继续'}
              </button>
            ) : (
              <button type="button" className="first-run-btn primary" onClick={finish}>
                进入 Crish
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
