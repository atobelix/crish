import { useToast } from '../../services/toast/ToastContext';
import React from 'react';
import * as Lucide from 'lucide-react';
import { revealSkillPath, type DesktopSkill, type SkillActivation } from '../../api/skillsApi';
import { Button, MarkdownDocumentView, SegmentedControl, Tooltip } from '../ui';
import styles from './SkillsSettingsTab.module.css';
import { ACTIVATION_OPTIONS, scopeGroupLabel } from './useSkillsSettingsState';

interface SkillDetailPreviewProps {
  selected: DesktopSkill | null;
  skillsCount: number;
  activeScopeProjectName: string;
  selectedSlash: string;
  copySlashCommand: (name: string) => Promise<void>;
  busyId: string | null;
  batchBusy: boolean;
  setActivation: (skill: DesktopSkill, activation: SkillActivation) => Promise<void>;
  showRaw: boolean;
  setShowRaw: React.Dispatch<React.SetStateAction<boolean>>;
  previewHtml?: string;
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
  previewHtml: _previewHtml,
}) => {
  const { showToast } = useToast();
  const skillContent = selected
    ? `# ${selected.name}\n\n> ${selected.description}\n\n${selected.content || '_（无正文）_'}`
    : '';
  return (
    <section className={`${styles.skillsDetail} ${styles.skillsDetailCoverContent} skills-detail`} aria-label="技能预览">
      {!selected ? (
        <div className={`${styles.skillsDetailEmpty} skills-detail-empty`} role="status">
          {skillsCount === 0 ? '新建技能后在此预览' : '选择左侧技能'}
        </div>
      ) : (
        <>
          <div className={`${styles.skillsDetailTop} skills-detail-top`}>
            <div className={`${styles.skillsDetailMain} skills-detail-main`}>
              <div className={`${styles.skillsDetailNameRow} skills-detail-name-row`}>
                <Tooltip content={selected.name}>
                  <div className={`${styles.skillsDetailName} skills-detail-name`}>
                    {selected.name}
                  </div>
                </Tooltip>
                <div className={`${styles.skillsDetailMeta} skills-detail-meta`}>
                  <span className={`${styles.skillsScope} skills-scope`}>
                    {scopeGroupLabel(selected.scope, activeScopeProjectName)}
                  </span>
                  {selected.system ? (
                    <span className={`${styles.skillsTag} skills-tag`}>系统</span>
                  ) : null}
                  {selected.disableModelInvocation ? (
                    <span className={`${styles.skillsTag} skills-tag`} aria-label="禁止模型自动调用">
                      禁自动
                    </span>
                  ) : null}
                  {selected.tags.slice(0, 2).map((t) => (
                    <span key={t} className={`${styles.skillsTag} skills-tag`}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <div className={`${styles.skillsDetailCmdRow} skills-detail-cmd-row`}>
                <Tooltip content={selectedSlash}>
                  <code className={styles.skillsKbd}>
                    {selectedSlash}
                  </code>
                </Tooltip>
                <Tooltip content="复制斜杠命令">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`复制命令 ${selectedSlash}`}
                    onClick={() => void copySlashCommand(selected.name)}
                    icon={<Lucide.Copy size={14} aria-hidden />}
                  />
                </Tooltip>
                <Tooltip content={selected.filePath}>
                  <span className={`${styles.skillsPathInline} skills-path-inline`}>
                    {selected.filePath}
                  </span>
                </Tooltip>
                <Tooltip content="在文件管理器中打开位置">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="打开技能文件位置"
                    onClick={() => {
                      void revealSkillPath(selected.filePath).then((ok) => {
                        if (!ok) showToast('无法打开路径（需桌面壳）');
                      });
                    }}
                    icon={<Lucide.ExternalLink size={14} aria-hidden />}
                  />
                </Tooltip>
              </div>
            </div>
            <div className={`${styles.skillsDetailControls} skills-detail-controls`}>
              <div className="skills-activation">
                <SegmentedControl
                  aria-label={`${selected.name} 启用状态`}
                  size="sm"
                  className={styles.segment}
                  value={selected.activation}
                  disabled={busyId === selected.id || batchBusy}
                  options={ACTIVATION_OPTIONS.map((opt) => ({
                    value: opt.id,
                    label: opt.label,
                    'aria-label': `设为${opt.label}`,
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
                aria-label={showRaw ? '切换为预览' : '切换为原文'}
              >
                {showRaw ? '预览' : '原文'}
              </Button>
            </div>
          </div>

          {showRaw ? (
            <pre className={`${styles.skillsRaw} ${styles.skillsRawCoverContent} skills-raw`} tabIndex={0} aria-label="技能原文">
              {selected.raw}
            </pre>
          ) : (
            <div
              className={`${styles.skillsPreview} ${styles.skillsPreviewCoverContent} skills-preview`}
              aria-label="技能预览"
            >
              <MarkdownDocumentView
                content={skillContent}
                filePath={selected.filePath}
                variant="document"
                emptyPlaceholder="暂无技能正文"
              />
            </div>
          )}
        </>
      )}
    </section>
  );
};
