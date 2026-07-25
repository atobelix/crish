import React, { useMemo } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import DOMPurify from 'dompurify';
import { useAsyncMarkdownHtml } from '../../../api/markdownRenderAsync';
import { revealSkillPath } from '../../../api/skillsApi';
import { Tooltip } from '../SettingsUI';
import styles from '../../SkillsSettingsTab.module.css';
import type { DesktopSkill, SkillActivation } from '../../../api/skillsApi';

function scopeGroupLabel(scope: string, projectName: string): string {
  if (scope === 'global') return '全局';
  if (scope === 'workspace') return projectName || '工作区';
  if (scope === 'project') return projectName || '当前项目';
  return scope;
}

function skillSlashCmd(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `/skill:${slug || name.trim()}`;
}

const ACTIVATION_OPTIONS: { id: SkillActivation; label: string }[] = [
  { id: 'enabled', label: '启用' }, { id: 'recommended', label: '推荐' }, { id: 'disabled', label: '禁用' },
];

interface SkillDetailProps {
  selected: DesktopSkill | null;
  showRaw: boolean;
  busyId: string | null;
  batchBusy: boolean;
  activeScopeProjectName: string;
  onShowRawToggle: () => void;
  onActivationChange: (skill: DesktopSkill, activation: SkillActivation) => void;
  onCopySlash: (name: string) => void;
  onShowToast?: (msg: string) => void;
}

export const SkillDetail: React.FC<SkillDetailProps> = React.memo(({
  selected, showRaw, busyId, batchBusy, activeScopeProjectName,
  onShowRawToggle, onActivationChange, onCopySlash, onShowToast,
}) => {
  const previewMd = useMemo(() => {
    if (!selected || showRaw) return '';
    return `# ${selected.name}\n\n> ${selected.description}\n\n${selected.content || '_（无正文）_'}`;
  }, [selected, showRaw]);
  const { html: previewHtml } = useAsyncMarkdownHtml(previewMd);

  const selectedSlash = selected ? skillSlashCmd(selected.name) : '';

  if (!selected) return null;

  return (
    <section className={`${styles.skillsDetail} skills-detail`} aria-label="技能预览">
      <div className={`${styles.skillsDetailTop} skills-detail-top`}>
        <div className={`${styles.skillsDetailMain} skills-detail-main`}>
          <div className={`${styles.skillsDetailNameRow} skills-detail-name-row`}>
            <Tooltip content={selected.name}><div className={`${styles.skillsDetailName} skills-detail-name`}>{selected.name}</div></Tooltip>
            <div className={`${styles.skillsDetailMeta} skills-detail-meta`}>
              <span className={`${styles.skillsScope} skills-scope`}>{scopeGroupLabel(selected.scope, activeScopeProjectName)}</span>
              {selected.system ? <span className={`${styles.skillsTag} skills-tag`}>系统</span> : null}
              {selected.disableModelInvocation ? <span className={`${styles.skillsTag} skills-tag`} aria-label="禁止模型自动调用">禁自动</span> : null}
              {selected.tags.slice(0, 2).map((t) => <span key={t} className={`${styles.skillsTag} skills-tag`}>{t}</span>)}
            </div>
          </div>
          <div className={`${styles.skillsDetailCmdRow} skills-detail-cmd-row`}>
            <Tooltip content={selectedSlash}><code className="settings-kbd">{selectedSlash}</code></Tooltip>
            <Tooltip content="复制斜杠命令">
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label={`复制命令 ${selectedSlash}`}
                onClick={() => onCopySlash(selected.name)}><Copy size={14} aria-hidden /></button>
            </Tooltip>
            <Tooltip content={selected.filePath}><span className={`${styles.skillsPathInline} skills-path-inline`}>{selected.filePath}</span></Tooltip>
            <Tooltip content="在文件管理器中打开位置">
              <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" aria-label="打开技能文件位置"
                onClick={() => { void revealSkillPath(selected.filePath).then((ok) => { if (!ok) onShowToast?.('无法打开路径（需桌面壳）'); }); }}>
                <ExternalLink size={14} aria-hidden /></button>
            </Tooltip>
          </div>
        </div>
        <div className={`${styles.skillsDetailControls} skills-detail-controls`}>
          <div className="skills-activation" role="group" aria-label={`${selected.name} 启用状态`}>
            <div className="ui-segment ui-segment--inline settings-segment-pill">
              {ACTIVATION_OPTIONS.map((opt) => (
                <button key={opt.id} type="button"
                  className={`ui-segment-item ${selected.activation === opt.id ? 'active' : ''}`}
                  disabled={busyId === selected.id || batchBusy}
                  aria-pressed={selected.activation === opt.id} aria-label={`设为${opt.label}`}
                  aria-busy={busyId === selected.id || undefined}
                  onClick={() => onActivationChange(selected, opt.id)}>{opt.label}</button>
              ))}
            </div>
          </div>
          <button type="button" className={`ui-btn ui-btn-ghost ui-btn-sm ${showRaw ? 'is-active' : ''}`}
            onClick={onShowRawToggle} aria-pressed={showRaw}
            aria-label={showRaw ? '切换为预览' : '切换为原文'}>{showRaw ? '预览' : '原文'}</button>
        </div>
      </div>
      {showRaw ? (
        <pre className={`${styles.skillsRaw} skills-raw`} tabIndex={0} aria-label="技能原文">{selected.raw}</pre>
      ) : (
        <div className={`${styles.skillsPreview} skills-preview md-rendered msg-assistant-text`}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }} aria-label="技能预览" />
      )}
    </section>
  );
});
