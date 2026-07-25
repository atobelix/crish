import React from 'react';
import * as Lucide from 'lucide-react';
import DOMPurify from 'dompurify';
import { revealSkillPath, type DesktopSkill, type SkillActivation } from '../../api/skillsApi';
import { Tooltip } from '../Tooltip';
import styles from '../SkillsSettingsTab.module.css';
import { ACTIVATION_OPTIONS, scopeGroupLabel } from './useSkillsSettingsState';

interface SkillDetailPreviewProps {
  selected: DesktopSkill | null;
  skillsCount: number;
  activeScopeProjectName: string;
  selectedSlash: string;
  copySlashCommand: (name: string) => Promise<void>;
  onShowToast?: (msg: string) => void;
  busyId: string | null;
  batchBusy: boolean;
  setActivation: (skill: DesktopSkill, activation: SkillActivation) => Promise<void>;
  showRaw: boolean;
  setShowRaw: React.Dispatch<React.SetStateAction<boolean>>;
  previewHtml: string;
}

export const SkillDetailPreview: React.FC<SkillDetailPreviewProps> = ({
  selected,
  skillsCount,
  activeScopeProjectName,
  selectedSlash,
  copySlashCommand,
  onShowToast,
  busyId,
  batchBusy,
  setActivation,
  showRaw,
  setShowRaw,
  previewHtml,
}) => {
  return (
    <section className={`${styles.skillsDetail} skills-detail`} aria-label="技能预览">
      {!selected ? (
        <div className={`${styles.skillsDetailEmpty} skills-detail-empty`} role="status">
          {skillsCount === 0 ? '新建技能后在此预览' : '选择左侧技能'}
        </div>
      ) : (
        <>
          <div className={`${styles.skillsDetailTop} skills-detail-top`}>
            <div className={`${styles.skillsDetailMain} skills-detail-main`}>
              <div className={`${styles.skillsDetailNameRow} skills-detail-name-row`}>
                <div className={`${styles.skillsDetailName} skills-detail-name`} title={selected.name}>
                  {selected.name}
                </div>
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
                <code className="settings-kbd" title={selectedSlash}>
                  {selectedSlash}
                </code>
                <Tooltip content="复制斜杠命令">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    aria-label={`复制命令 ${selectedSlash}`}
                    onClick={() => void copySlashCommand(selected.name)}
                  >
                    <Lucide.Copy size={14} aria-hidden />
                  </button>
                </Tooltip>
                <span className={`${styles.skillsPathInline} skills-path-inline`} title={selected.filePath}>
                  {selected.filePath}
                </span>
                <Tooltip content="在文件管理器中打开位置">
                  <button
                    type="button"
                    className="ui-btn ui-btn-ghost ui-btn-sm"
                    aria-label="打开技能文件位置"
                    onClick={() => {
                      void revealSkillPath(selected.filePath).then((ok) => {
                        if (!ok) onShowToast?.('无法打开路径（需桌面壳）');
                      });
                    }}
                  >
                    <Lucide.ExternalLink size={14} aria-hidden />
                  </button>
                </Tooltip>
              </div>
            </div>
            <div className={`${styles.skillsDetailControls} skills-detail-controls`}>
              <div
                className="skills-activation"
                role="group"
                aria-label={`${selected.name} 启用状态`}
              >
                <div className="ui-segment ui-segment--inline settings-segment-pill">
                  {ACTIVATION_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`ui-segment-item ${selected.activation === opt.id ? 'active' : ''}`}
                      disabled={busyId === selected.id || batchBusy}
                      aria-pressed={selected.activation === opt.id}
                      aria-label={`设为${opt.label}`}
                      aria-busy={busyId === selected.id || undefined}
                      onClick={() => void setActivation(selected, opt.id as SkillActivation)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className={`ui-btn ui-btn-ghost ui-btn-sm ${showRaw ? 'is-active' : ''}`}
                onClick={() => setShowRaw((v) => !v)}
                aria-pressed={showRaw}
                aria-label={showRaw ? '切换为预览' : '切换为原文'}
              >
                {showRaw ? '预览' : '原文'}
              </button>
            </div>
          </div>

          {showRaw ? (
            <pre className={`${styles.skillsRaw} skills-raw`} tabIndex={0} aria-label="技能原文">
              {selected.raw}
            </pre>
          ) : (
            <div
              className={`${styles.skillsPreview} skills-preview md-rendered msg-assistant-text`}
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }}
              aria-label="技能预览"
            />
          )}
        </>
      )}
    </section>
  );
};
