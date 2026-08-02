/**
 * 正式版首次向导：密钥 → 模型（可手填）→ 导入对话（可选）→ 项目 → 开始
 *
 * 壳组件：步进轨道 / 状态行 / 页内 error / 页脚按钮 / 步内容装配。
 * 步进状态机见 useFirstRunWizard；校验/文案纯函数见 firstRunWizardLib；
 * 盖层挂载标记见 firstRunOverlayFlag；各步表单见 Wizard*Step 子组件。
 *
 * 契约：写入 providerProfiles（LS）+ activateProfileModel（ENGINE-CONFIG）。
 * 引导态只用页内 error/hint，成功路径禁止 toast。
 * 默认服务商不预置模型 id（无 mimo 硬编码 / 不发明远程演示默认）。
 * 模型步可「稍后手填」——由底栏 ModelPicker / needsModel soft-hint 接手。
 * 导入步可跳过，稍后在设置 · 账户完成。
 */

import React, { useEffect, useId, useRef } from 'react';
import * as Lucide from 'lucide-react';
import styles from './FirstRunWizard.module.css';
import { Dialog } from '../ui';
import { useFirstRunWizard } from '../useFirstRunWizard';
import { WizardKeyStep } from '../WizardKeyStep';
import { WizardModelStep } from '../WizardModelStep';
import { WizardImportStep } from '../WizardImportStep';
import { WizardProjectStep } from '../WizardProjectStep';
import {
  markFirstRunDone,
  WIZARD_STEP_META,
  wizardPrimaryCtaLabel,
  wizardStepMeta,
} from '../firstRunWizardLib';

type Props = {
  onDone: () => void;
  onOpenSettings?: () => void;
};

export const FirstRunWizard: React.FC<Props> = ({ onDone, onOpenSettings }) => {
  const reactId = useId();
  const stepStatusId = `first-run-step-status-${reactId}`;
  const errorId = `first-run-error-${reactId}`;
  const providerId = `first-run-provider-${reactId}`;
  const keyId = `first-run-key-${reactId}`;
  const modelIdField = `first-run-model-${reactId}`;
  const modelCustomId = `first-run-model-custom-${reactId}`;
  const pathId = `first-run-path-${reactId}`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const {
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
    hasProfiles,
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
  } = useFirstRunWizard({ onDone });

  // 步进后把焦点送入正文，便于读屏与键盘用户
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [step]);

  const activeMeta = wizardStepMeta(step);
  const stepProgressLabel = `第 ${step + 1} / ${WIZARD_STEP_META.length} 步 · ${activeMeta.title}`;
  const fieldDescribedBy = error ? errorId : undefined;
  const stepIds = { providerId, keyId, modelIdField, modelCustomId, pathId };

  // 弹窗基座（PE-05 T05.2 #6）：盖层/Esc 三层/焦点圈定/动画由基座与
  // useFirstRunWizard 接管；dismissible=false 强制步进（不可 Esc/遮罩关闭，
  // Esc 由状态机消费：有错误先清 → 上一步），onClose 为占位（不会触发）
  return (
    <Dialog
      open
      onClose={() => {}}
      dismissible={false}
      title={
        <span className={styles.firstRunBrand}>
          <span className={styles.firstRunLogo} aria-hidden="true">
            C
          </span>
          <span className={styles.firstRunTitle}>欢迎使用 Crish</span>
        </span>
      }
      description={activeMeta.desc}
      className={styles.firstRunDialog}
      overlayClassName={styles.firstRunOverlay}
    >
      <div className={styles.firstRunCard}>
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
            <WizardKeyStep
              ids={stepIds}
              profiles={profiles}
              profileId={profileId}
              apiKey={apiKey}
              busy={busy}
              error={error}
              describedBy={fieldDescribedBy}
              onProfileChange={(id) => {
                setProfileId(id);
                // 切换服务商时清空模型；不自动采用列表首项（避免幽灵远程默认）
                setModelId('');
                setError('');
              }}
              onKeyChange={(v) => {
                setApiKey(v);
                setError('');
              }}
              onEnter={() => {
                void advanceFromStep();
              }}
            />
          )}

          {step === 1 && (
            <WizardModelStep
              ids={stepIds}
              modelId={modelId}
              listedModels={listedModels}
              hasProfile={hasProfiles && Boolean(activeProfile)}
              busy={busy}
              error={error}
              describedBy={fieldDescribedBy}
              onChange={(v) => {
                setModelId(v);
                setError('');
              }}
              onEnter={() => {
                void advanceFromStep();
              }}
            />
          )}

          {step === 2 && <WizardImportStep />}

          {step === 3 && (
            <WizardProjectStep
              ids={stepIds}
              hasProject={hasProject}
              currentProjectLabel={currentProjectLabel}
              pathDraft={pathDraft}
              busy={busy}
              error={error}
              describedBy={fieldDescribedBy}
              onPathChange={(v) => {
                setPathDraft(v);
                setError('');
              }}
              onPickFolder={() => {
                void pickProjectFolder();
              }}
              onEnter={() => {
                void advanceFromStep();
              }}
            />
          )}

          {step === 4 && (
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
            {step < 4 ? (
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
                {wizardPrimaryCtaLabel(4, false)}
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

        {step === 2 ? (
          <div className={styles.firstRunModelAlt} role="group" aria-label="导入其它方式">
            <button
              type="button"
              className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
              disabled={busy}
              onClick={skipImportStep}
            >
              跳过，稍后在设置中导入
            </button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
