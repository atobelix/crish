/**
 * 首次使用引导向导：极简高信噪比设计。
 * 步骤：0 配置服务商 → 1 启用模型 → 2 选择工作目录 → 3 开始使用
 *
 * 顶栏简洁：当前步骤标题 + 步骤计数徽标。
 * 第 1 步直接复用设置页 ManualAddForm（在线获取模型 + 完整能力与思考档位配置）。
 */

import React, { useEffect, useId, useRef } from 'react';

import styles from './FirstRunWizard.module.css';
import { Button, Dialog } from '@/components/ui';
import { useFirstRunWizard } from '../useFirstRunWizard';
import { WizardKeyStep } from '../WizardKeyStep';
import { WizardModelStep } from '../WizardModelStep';
import { WizardProjectStep } from '../WizardProjectStep';
import {
  WIZARD_STEP_META,
  wizardPrimaryCtaLabel,
  wizardStepMeta,
  type WizardStep,
} from '../firstRunWizardLib';
import { AppIcon } from '@/components/ui/icons';

type Props = {
  onDone: () => void;
  onOpenSettings?: () => void;
  initialStep?: WizardStep;
};

export const FirstRunWizard: React.FC<Props> = ({
  onDone,
  onOpenSettings,
  initialStep,
}) => {
  const reactId = useId();
  const stepStatusId = `first-run-step-status-${reactId}`;
  const errorId = `first-run-error-${reactId}`;
  const nameId = `first-run-name-${reactId}`;
  const baseUrlId = `first-run-base-url-${reactId}`;
  const protocolId = `first-run-protocol-${reactId}`;
  const keyId = `first-run-key-${reactId}`;
  const pathId = `first-run-path-${reactId}`;
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const {
    step,
    vendorName,
    baseUrl,
    protocol,
    apiKey,
    addDraft,
    isDefaultModel,
    scanBusy,
    scannedModels,
    pathDraft,
    busy,
    error,
    activeProfile,
    listedModels,
    hasProject,
    currentProjectLabel,
    setVendorName,
    setBaseUrl,
    setProtocol,
    setApiKey,
    setAddDraft,
    setIsDefaultModel,
    setPathDraft,
    setError,
    runScan,
    advanceFromStep,
    goPrev,
    skipConnectStep,
    skipModelStep,
    skipProjectStep,
    finish,
    pickProjectFolder,
  } = useFirstRunWizard({
    onDone,
    ...(initialStep !== undefined ? { initialStep } : {}),
  });

  // 步进后把焦点送入正文，便于读屏与键盘用户
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const focusable = root.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    focusable?.focus();
  }, [step]);

  const activeMeta = wizardStepMeta(step);
  const fieldDescribedBy = error ? errorId : undefined;
  const stepIds = {
    nameId,
    baseUrlId,
    protocolId,
    keyId,
    pathId,
  };

  const providerVendor =
    activeProfile?.id && !activeProfile.id.startsWith('custom-')
      ? activeProfile.id
      : activeProfile?.name || vendorName || undefined;

  return (
    <Dialog
      open
      onClose={() => {}}
      dismissible={false}
      title={
        <div className={styles.firstRunHeader}>
          <span className={styles.firstRunHeaderTitle}>{activeMeta.title}</span>
          <span
            className={styles.firstRunStepBadge}
            aria-label={`第 ${step + 1} 步，共 ${WIZARD_STEP_META.length} 步`}
          >
            {`${step + 1} / ${WIZARD_STEP_META.length}`}
          </span>
        </div>
      }
      classNames={{
        panel: styles.firstRunDialog,
        overlay: styles.firstRunOverlay,
      }}
    >
      <div className={styles.firstRunCard}>
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
              name={vendorName}
              baseUrl={baseUrl}
              apiKey={apiKey}
              protocol={protocol}
              busy={busy}
              error={error}
              describedBy={fieldDescribedBy}
              onNameChange={(v) => {
                setVendorName(v);
                setError('');
              }}
              onBaseUrlChange={(v) => {
                setBaseUrl(v);
                setError('');
              }}
              onKeyChange={(v) => {
                setApiKey(v);
                setError('');
              }}
              onProtocolChange={(v) => {
                setProtocol(v);
                setError('');
              }}
              onEnter={() => {
                void advanceFromStep();
              }}
            />
          )}

          {step === 1 && (
            <WizardModelStep
              addDraft={addDraft}
              setAddDraft={(updater) => {
                setAddDraft(updater);
                setError('');
              }}
              isDefaultModel={isDefaultModel}
              onDefaultChange={(v) => {
                setIsDefaultModel(v);
              }}
              runScan={runScan}
              scanBusy={scanBusy}
              {...(providerVendor !== undefined ? { providerVendor } : {})}
              scannedModels={scannedModels}
              existingModels={listedModels}
              busy={busy}
              onEnter={() => {
                void advanceFromStep();
              }}
            />
          )}

          {step === 2 && (
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

          {step === 3 && (
            <div className={styles.firstRunReady}>
              <AppIcon
                name="check-circle"
                size={36}
                style={{ color: 'var(--brand-deep)' }}
                aria-hidden="true"
              />
              <div style={{ fontWeight: 600, fontSize: 16 }}>配置已就绪</div>
              <p
                className={styles.firstRunHint}
                style={{ textAlign: 'center', margin: 0 }}
              >
                点击下方按钮即可进入 Crish 开始对话
              </p>
            </div>
          )}
        </div>

        <div className={styles.firstRunFooter}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.firstRunLink}
            disabled={busy}
            onClick={finish}
          >
            稍后配置
          </Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {step > 0 && (
              <Button
                type="button"
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={goPrev}
              >
                上一步
              </Button>
            )}
            {step < 3 ? (
              <Button
                type="button"
                variant="primary"
                size="md"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => {
                  void advanceFromStep();
                }}
              >
                {wizardPrimaryCtaLabel(step, busy)}
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={finish}
              >
                {wizardPrimaryCtaLabel(3, false)}
              </Button>
            )}
          </div>
        </div>

        {step === 0 ? (
          <div
            className={styles.firstRunModelAlt}
            role="group"
            aria-label="连接其它方式"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
              disabled={busy}
              onClick={skipConnectStep}
            >
              暂不配置连接，浏览下一步
            </Button>
          </div>
        ) : null}

        {step === 1 ? (
          <div
            className={styles.firstRunModelAlt}
            role="group"
            aria-label="模型其它方式"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
              disabled={busy}
              onClick={skipModelStep}
            >
              暂不启用模型，浏览下一步
            </Button>
            {onOpenSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
                disabled={busy}
                onClick={() => {
                  finish();
                  onOpenSettings();
                }}
              >
                打开设置详细配置模型
              </Button>
            ) : null}
          </div>
        ) : null}

        {step === 2 ? (
          <div
            className={styles.firstRunModelAlt}
            role="group"
            aria-label="项目其它方式"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.firstRunLink} ${styles.firstRunLinkCenter}`}
              disabled={busy}
              onClick={skipProjectStep}
            >
              暂不选择目录，进入主界面
            </Button>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
