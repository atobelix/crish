import React, { useState, useMemo } from 'react';
import { Button, Tooltip, Switch } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { MarkdownDocumentView } from '../markdown/MarkdownDocumentView';
import { useToast } from '../../services/toast/ToastContext';
import { revealSkillPath, type DesktopSkill } from '../../api/skillsApi';
import { SkillDetailModal, parseSkillMarkdown } from './SkillDetailModal';
import modalStyles from './SkillDetailModal.module.css';
import styles from './ExtensionsMainSurface.module.css';

interface SkillDetailWorkbenchProps {
  skill: DesktopSkill;
  onToggleActivation?: (skill: DesktopSkill) => void;
  onBackToChat?: () => void;
}

export const SkillDetailWorkbench: React.FC<SkillDetailWorkbenchProps> = ({
  skill,
  onToggleActivation,
  onBackToChat,
}) => {
  const { showToast } = useToast();
  const [showModal, setShowModal] = useState(false);

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

  const { frontmatter, markdownBody } = useMemo(() => {
    const raw = skill.content || skill.raw || '';
    if (raw.trim()) {
      return parseSkillMarkdown(raw);
    }
    const fallback = `# ${skill.name}\n\n${skill.description || '该技能为预设工作流，可在对话中通过快捷指令触发使用。'}\n\n### 指令语法\n\`\`\`bash\n/skill:${skill.name}\n\`\`\``;
    return { frontmatter: {}, markdownBody: fallback };
  }, [skill]);

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
            <Tooltip content="弹窗查看完整渲染文档与快捷指令">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowModal(true)}
              >
                <AppIcon name="external-link" size={13} />
                <span>弹窗详情</span>
              </Button>
            </Tooltip>
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

        {Object.keys(frontmatter).length > 0 && (
          <div className={modalStyles.yamlMetaBar}>
            {Object.entries(frontmatter).map(([k, v]) => (
              <span key={k} className={modalStyles.yamlPill}>
                <span className={modalStyles.yamlPillKey}>{k}:</span>
                <span>{v}</span>
              </span>
            ))}
          </div>
        )}

        <div className={styles.codePreviewCard}>
          <MarkdownDocumentView
            content={markdownBody}
            filePath={skill.filePath}
            variant="document"
            emptyPlaceholder="暂无技能正文说明"
          />
        </div>
      </div>

      <SkillDetailModal
        open={showModal}
        onClose={() => setShowModal(false)}
        skill={{
          id: skill.id,
          name: skill.name,
          description: skill.description,
          source: skill.system
            ? '官方'
            : skill.scope === 'project'
              ? '当前项目'
              : '全局技能',
          filePath: skill.filePath,
          content: skill.content,
          raw: skill.raw,
          isInstalled: true,
          isEnabled,
          isOfficial: Boolean(skill.system),
          rawSkill: skill,
        }}
        onToggleEnabled={() => onToggleActivation?.(skill)}
        onBackToChat={onBackToChat}
      />
    </div>
  );
};
