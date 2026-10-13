import React from 'react';
import { Button, Tooltip, Switch } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import { revealSkillPath, type DesktopSkill } from '../../api/skillsApi';
import styles from './ExtensionsMainSurface.module.css';

interface SkillDetailWorkbenchProps {
  skill: DesktopSkill;
  onToggleActivation?: (skill: DesktopSkill) => void;
}

export const SkillDetailWorkbench: React.FC<SkillDetailWorkbenchProps> = ({
  skill,
  onToggleActivation,
}) => {
  const { showToast } = useToast();

  const handleReveal = async () => {
    if (!skill.filePath) {
      showToast('未找到技能文件路径');
      return;
    }
    const ok = await revealSkillPath(skill.filePath);
    if (ok) {
      showToast('已在资源管理器中定位技能目录');
    } else {
      showToast('定位技能目录失败');
    }
  };

  const handleCopyCommand = () => {
    const cmd = `/skill:${skill.name}`;
    navigator.clipboard.writeText(cmd);
    showToast(`已复制快捷命令：${cmd}`);
  };

  const isEnabled =
    skill.activation === 'enabled' || skill.activation === 'recommended';

  return (
    <div className={styles.workbenchContent}>
      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <div className={styles.detailTitleInfo}>
            <div className={styles.detailTitle}>{skill.name}</div>
            <div className={styles.detailSubtitle}>
              {skill.description || '自定义提示词与自动化流程技能'}
            </div>
          </div>
          <div className={styles.headerActions}>
            <Tooltip content="在系统文件管理器中定位技能目录">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleReveal()}
              >
                <AppIcon name="folder" size={13} />
                <span>定位技能目录</span>
              </Button>
            </Tooltip>
          </div>
        </div>

        <div className={styles.pluginSettingsRow}>
          <div className={styles.settingItem}>
            <div className={styles.settingLabelGroup}>
              <span className={styles.settingTitle}>启用状态</span>
              <span className={styles.settingDesc}>
                {isEnabled
                  ? '技能已启用，可在输入框中通过快捷指令触发'
                  : '技能已禁用'}
              </span>
            </div>
            {onToggleActivation && (
              <Switch
                checked={isEnabled}
                onCheckedChange={() => onToggleActivation(skill)}
                aria-label={`启用 ${skill.name}`}
              />
            )}
          </div>
          <div className={styles.metaPillGroup}>
            <span className={styles.metaPill}>
              {skill.scope === 'project' ? '当前项目' : '全局技能'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyCommand}
              className={styles.copyCmdBtn}
            >
              <AppIcon name="copy" size={11} />
              <span>/skill:{skill.name}</span>
            </Button>
          </div>
        </div>
      </div>

      <div className={styles.detailBodySection}>
        <div className={styles.sectionHeader}>
          <AppIcon name="file-text" size={14} />
          <span>技能指令定义（Prompt Instructions）</span>
        </div>
        <div className={styles.codePreviewCard}>
          <pre className={styles.codeBlock}>
            {skill.content || skill.raw || '// 暂无文本内容'}
          </pre>
        </div>
      </div>
    </div>
  );
};
