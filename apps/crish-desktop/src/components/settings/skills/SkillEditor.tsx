import React from 'react';
import { Tooltip } from '../SettingsUI';
import styles from '../../SkillsSettingsTab.module.css';

interface SkillEditorProps {
  createMode: 'none' | 'paths' | 'manual';
  createName: string;
  createDesc: string;
  createBusy: boolean;
  onModeChange: (mode: 'none' | 'paths' | 'manual') => void;
  onNameChange: (name: string) => void;
  onDescChange: (desc: string) => void;
  onCreate: () => void;
  onImportBrowse: () => void;
  onAiCreate: () => void;
}

export const SkillEditor: React.FC<SkillEditorProps> = React.memo(({
  createMode, createName, createDesc, createBusy,
  onModeChange, onNameChange, onDescChange, onCreate, onImportBrowse, onAiCreate,
}) => {
  if (createMode === 'none') return null;

  return (
    <>
      {createMode === 'paths' ? (
        <section className={`${styles.skillsCreateBox} skills-create-box`} aria-label="新建技能">
          <div className="settings-create-paths">
            <button type="button" className="settings-create-path" onClick={onImportBrowse}>
              <span className="settings-create-path-title">浏览导入</span>
              <span className="settings-create-path-desc">选择本机已有技能目录（如 .codex/skills），导入后直接出现在列表</span>
            </button>
            <button type="button" className="settings-create-path" onClick={onAiCreate}>
              <span className="settings-create-path-title">AI 创建</span>
              <span className="settings-create-path-desc">打开对话，由 AI 写完整 SKILL.md（推荐，无需手写）</span>
            </button>
          </div>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onModeChange('manual')}>高级：手填空白技能…</button>
        </section>
      ) : (
        <section className={`${styles.skillsCreateBox} skills-create-box`} aria-label="手填项目技能">
          <div className={`${styles.skillsCreateRow} skills-create-row`}>
            <Tooltip content="写入 .conex/skills/<name>/SKILL.md">
              <input className="settings-field-input settings-field-input--sm" placeholder="名称" value={createName}
                onChange={(e) => onNameChange(e.target.value)} aria-label="技能名称" disabled={createBusy}
                onKeyDown={(e) => { if (e.key === 'Enter' && createName.trim()) { e.preventDefault(); onCreate(); } }} />
            </Tooltip>
            <input className="settings-field-input settings-field-input--sm" placeholder="描述（可选）" value={createDesc}
              onChange={(e) => onDescChange(e.target.value)} aria-label="技能描述（可选）" disabled={createBusy}
              onKeyDown={(e) => { if (e.key === 'Enter' && createName.trim()) { e.preventDefault(); onCreate(); } }} />
            <button type="button" className="ui-btn ui-btn-secondary ui-btn-sm" disabled={!createName.trim() || createBusy}
              aria-busy={createBusy || undefined} onClick={onCreate} aria-label={createBusy ? '创建中' : '创建技能'}>
              {createBusy ? '…' : '创建'}</button>
            <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => onModeChange('paths')}>返回</button>
          </div>
        </section>
      )}
    </>
  );
});
