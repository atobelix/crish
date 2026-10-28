import { useToast } from '../../services/toast/ToastContext';
import React from 'react';

import {
  revealSkillPath,
  type DesktopSkill,
  type SkillActivation,
} from '../../api/skillsApi';
import { Button, SegmentedControl, Tooltip } from '@/components/ui';
import { MarkdownDocumentView } from '../markdown/MarkdownDocumentView';
import styles from './SkillsSettingsTab.module.css';
import { ACTIVATION_OPTIONS, scopeGroupLabel } from './useSkillsSettingsState';
import { AppIcon } from '@/components/ui/icons';
import { useI18n } from '../../i18n';

interface SkillDetailPreviewProps {
  selected: DesktopSkill | null;
  skillsCount: number;
  activeScopeProjectName: string;
  selectedSlash: string;
  copySlashCommand: (name: string) => Promise<void>;
  busyId: string | null;
  batchBusy: boolean;
  setActivation: (
    skill: DesktopSkill,
    activation: SkillActivation
  ) => Promise<void>;
  showRaw: boolean;
  setShowRaw: React.Dispatch<React.SetStateAction<boolean>>;
}

export const SkillDetailPreview: React.FC<SkillDetailPreviewProps> = ({
  selected,
  skillsCount,
  activeScopeProjectName,
  selectedSlash,
  copySlashCommand,
  busyId,
  batchBusy,
  setActivation,
  showRaw,
  setShowRaw,
}) => {
  const { showToast } = useToast();
  const { t } = useI18n();
  const noBody = t('extensions.skill.preview.noBody');
  const skillContent = selected
    ? `# ${selected.name}\n\n> ${selected.description}\n\n${selected.content || noBody}`
    : '';
  return (
    <section
      className={`${styles.skillsDetail} ${styles.skillsDetailCoverContent} skills-detail`}
      aria-label={t('extensions.skill.preview.ariaLabel')}
    >
      {!selected ? (
        <div
          className={`${styles.skillsDetailEmpty} skills-detail-empty`}
          role="status"
        >
          {skillsCount === 0
            ? t('extensions.skill.preview.createHint')
            : t('extensions.skill.preview.selectHint')}
        </div>
      ) : (
        <>
          <div className={`${styles.skillsDetailTop} skills-detail-top`}>
            <div className={`${styles.skillsDetailMain} skills-detail-main`}>
              <div
                className={`${styles.skillsDetailNameRow} skills-detail-name-row`}
              >
                <Tooltip content={selected.name}>
                  <div
                    className={`${styles.skillsDetailName} skills-detail-name`}
                  >
                    {selected.name}
                  </div>
                </Tooltip>
                <div
                  className={`${styles.skillsDetailMeta} skills-detail-meta`}
                >
                  <span className={`${styles.skillsScope} skills-scope`}>
                    {scopeGroupLabel(selected.scope, activeScopeProjectName)}
                  </span>
                  {selected.system ? (
                    <span className={`${styles.skillsTag} skills-tag`}>
                      {t('extensions.skill.preview.system')}
                    </span>
                  ) : null}
                  {selected.disableModelInvocation ? (
                    <span
                      className={`${styles.skillsTag} skills-tag`}
                      aria-label={t(
                        'extensions.skill.preview.disableModelAria'
                      )}
                    >
                      {t('extensions.skill.preview.disableModel')}
                    </span>
                  ) : null}
                  {selected.tags.slice(0, 2).map((t) => (
                    <span key={t} className={`${styles.skillsTag} skills-tag`}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div
                className={`${styles.skillsDetailCmdRow} skills-detail-cmd-row`}
              >
                <Tooltip content={selectedSlash}>
                  <code className={styles.skillsKbd}>{selectedSlash}</code>
                </Tooltip>
                <Tooltip content={t('extensions.skill.preview.copySlash')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('extensions.skill.preview.copyCommandAria', {
                      command: selectedSlash,
                    })}
                    onClick={() => void copySlashCommand(selected.name)}
                    icon={<AppIcon name="copy" size={14} aria-hidden />}
                  />
                </Tooltip>
                <Tooltip content={selected.filePath}>
                  <span
                    className={`${styles.skillsPathInline} skills-path-inline`}
                  >
                    {selected.filePath}
                  </span>
                </Tooltip>
                <Tooltip content={t('extensions.skill.preview.openLocation')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('extensions.skill.preview.openLocationAria')}
                    onClick={() => {
                      void revealSkillPath(selected.filePath).then((ok) => {
                        if (!ok) {
                          showToast(
                            t('extensions.skill.preview.openPathFailed')
                          );
                        }
                      });
                    }}
                    icon={
                      <AppIcon name="external-link" size={14} aria-hidden />
                    }
                  />
                </Tooltip>
              </div>
            </div>
            <div
              className={`${styles.skillsDetailControls} skills-detail-controls`}
            >
              <div className="skills-activation">
                <SegmentedControl
                  aria-label={t('extensions.skill.preview.activationAria', {
                    name: selected.name,
                  })}
                  size="sm"
                  className={styles.segment}
                  value={selected.activation}
                  disabled={busyId === selected.id || batchBusy}
                  options={ACTIVATION_OPTIONS.map((opt) => ({
                    value: opt.id,
                    label: opt.label,
                    'aria-label': t(
                      'extensions.skill.preview.setActivationAria',
                      { label: opt.label }
                    ),
                  }))}
                  onChange={(v) =>
                    void setActivation(selected, v as SkillActivation)
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                active={showRaw}
                onClick={() => setShowRaw((v) => !v)}
                aria-pressed={showRaw}
                aria-label={
                  showRaw
                    ? t('extensions.skill.preview.switchToPreview')
                    : t('extensions.skill.preview.switchToRaw')
                }
              >
                {showRaw
                  ? t('extensions.skill.preview.preview')
                  : t('extensions.skill.preview.raw')}
              </Button>
            </div>
          </div>

          {showRaw ? (
            <pre
              className={`${styles.skillsRaw} ${styles.skillsRawCoverContent} skills-raw`}
              tabIndex={0}
              aria-label={t('extensions.skill.preview.rawAria')}
            >
              {selected.raw}
            </pre>
          ) : (
            <div
              className={`${styles.skillsPreview} ${styles.skillsPreviewCoverContent} skills-preview`}
              aria-label={t('extensions.skill.preview.ariaLabel')}
            >
              <MarkdownDocumentView
                content={skillContent}
                filePath={selected.filePath}
                variant="document"
                emptyPlaceholder={t(
                  'extensions.skill.preview.emptyPlaceholder'
                )}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
};
