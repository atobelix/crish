import React, { useState, useMemo, useEffect } from 'react';
import { Button, Tooltip, Switch } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { MarkdownDocumentView } from '../markdown/MarkdownDocumentView';
import { useToast } from '../../services/toast/ToastContext';
import {
  readTextAny,
  revealSkillPath,
  type DesktopSkill,
} from '../../api/skillsApi';
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
  const [loadedRaw, setLoadedRaw] = useState('');

  useEffect(() => {
    const direct = skill.content || skill.raw;
    if (direct) {
      setLoadedRaw(direct);
      return;
    }
    if (!skill.filePath) {
      setLoadedRaw('');
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const text = await readTextAny(skill.filePath!);
        if (!cancelled) setLoadedRaw(text || '');
      } catch {
        if (!cancelled) setLoadedRaw('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skill.content, skill.raw, skill.filePath]);

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
    const raw = loadedRaw || skill.content || skill.raw || '';
    if (raw.trim()) {
      return parseSkillMarkdown(raw);
    }
    const fallback = `# ${skill.name}\n\n${skill.description || '该技能为预设工作流，可在对话中通过快捷指令触发使用。'}\n\n### 指令语法\n\`\`\`bash\n/skill:${skill.name}\n\`\`\``;
    return { frontmatter: {}, markdownBody: fallback };
  }, [loadedRaw, skill]);

  const extraMetaEntries = useMemo(
    () =>
      Object.entries(frontmatter).filter(
        ([k]) => k !== 'name' && k !== 'description'
      ),
    [frontmatter]
  );

  return (
    <div className={styles.workbenchContent}>
      <div className={styles.skillUnifiedHeader}>
        <div className={styles.skillHeaderMain}>
          <div className={styles.skillHeaderIconBox}>
            <AppIcon name="sparkles" size={18} />
          </div>
          <div className={styles.detailTitleInfo}>
            <div className={styles.skillHeaderTitleLine}>
              <span className={styles.detailTitle}>{skill.name}</span>
              <span className={styles.metaPill}>
                {skill.scope === 'project' ? '当前项目' : '全局技能'}
              </span>
              <Tooltip content="点击复制快捷指令">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCopyCommand}
                  className={styles.copyCmdBtn}
                  aria-label={`复制快捷指令 /skill:${skill.name}`}
                >
                  <AppIcon name="copy" size={12} />
                  <span>/skill:{skill.name}</span>
                </Button>
              </Tooltip>
              {extraMetaEntries.map(([k, v]) => (
                <span key={k} className={modalStyles.yamlPill}>
                  <span className={modalStyles.yamlPillKey}>{k}:</span>
                  <span>{v}</span>
                </span>
              ))}
            </div>
            {skill.description || frontmatter.description ? (
              <div className={styles.detailSubtitle}>
                {skill.description || frontmatter.description}
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.headerActions}>
          {onToggleActivation && (
            <Tooltip
              content={
                isEnabled ? '技能已启用（点击停用）' : '技能已停用（点击启用）'
              }
            >
              <div className={styles.switchSlot}>
                <Switch
                  checked={isEnabled}
                  onCheckedChange={() => onToggleActivation(skill)}
                  aria-label={`启用 ${skill.name}`}
                />
              </div>
            </Tooltip>
          )}
          <Tooltip content="在系统文件管理器中定位技能目录">
            <Button
              variant="ghost"
              size="sm"
              className={styles.iconActionBtn}
              onClick={() => void handleReveal()}
              aria-label="定位技能目录"
            >
              <AppIcon name="folder-open" size={16} />
            </Button>
          </Tooltip>
          <Tooltip content="弹窗查看完整渲染文档与快捷指令">
            <Button
              variant="ghost"
              size="sm"
              className={styles.iconActionBtn}
              onClick={() => setShowModal(true)}
              aria-label="弹窗详情"
            >
              <AppIcon name="maximize" size={15} />
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.skillDocSection}>
        <div className={styles.skillDocSurface}>
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
          content: loadedRaw || skill.content,
          raw: loadedRaw || skill.raw,
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
