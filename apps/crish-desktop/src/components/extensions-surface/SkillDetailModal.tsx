import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Dialog, Button, Switch, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { MarkdownDocumentView } from '../markdown/MarkdownDocumentView';
import { useSessionStore } from '../../store/storeAccess';
import { navigateToChatSession } from '../../store/storeAccess';
import { useToast } from '../../services/toast/ToastContext';
import { readTextAny, type DesktopSkill } from '../../api/skillsApi';
import type {
  CatalogEntry,
  InstalledExtension,
} from '../../api/extensionCatalog';
import type { DetectedExternalSkill } from './detectExternalSkills';
import styles from './SkillDetailModal.module.css';

export interface SkillDetailTarget {
  id: string;
  name: string;
  description?: string;
  source?: string;
  version?: string;
  filePath?: string;
  content?: string;
  raw?: string;
  isInstalled?: boolean;
  isEnabled?: boolean;
  isOfficial?: boolean;
  rawSkill?: DesktopSkill;
  rawExternal?: DetectedExternalSkill;
  catalogEntry?: CatalogEntry;
  installedItem?: InstalledExtension;
}

export interface SkillDetailModalProps {
  open: boolean;
  onClose: () => void;
  skill: SkillDetailTarget | null;
  onImport?: (skill: SkillDetailTarget) => Promise<void> | void;
  onToggleEnabled?: (
    skill: SkillDetailTarget,
    enabled: boolean
  ) => Promise<void> | void;
  onStartChatWithSkill?: (skill: SkillDetailTarget) => void;
  onBackToChat?: () => void;
  busy?: boolean;
}

/**
 * 智能解析 SKILL.md 文档：
 * 剥离并提取顶部的 YAML frontmatter 元数据；
 * 返回干净的 Markdown 正文以供富文本引擎高清渲染。
 */
export function parseSkillMarkdown(raw: string): {
  frontmatter: Record<string, string>;
  markdownBody: string;
} {
  const frontmatter: Record<string, string> = {};
  if (!raw || typeof raw !== 'string') {
    return { frontmatter, markdownBody: '' };
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('---')) {
    const endMatch = trimmed.slice(3).indexOf('---');
    if (endMatch !== -1) {
      const yamlContent = trimmed.slice(3, 3 + endMatch).trim();
      const body = trimmed.slice(3 + endMatch + 3).trim();

      for (const line of yamlContent.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let val = line.slice(colonIdx + 1).trim();
          if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
          ) {
            val = val.slice(1, -1);
          }
          if (key) {
            frontmatter[key] = val;
          }
        }
      }

      return { frontmatter, markdownBody: body };
    }
  }

  return { frontmatter, markdownBody: trimmed };
}

export const SkillDetailModal: React.FC<SkillDetailModalProps> = ({
  open,
  onClose,
  skill,
  onImport,
  onToggleEnabled,
  onStartChatWithSkill,
  onBackToChat,
  busy = false,
}) => {
  const { showToast } = useToast();
  const [loadedRaw, setLoadedRaw] = useState<string>('');
  const [loadingDoc, setLoadingDoc] = useState<boolean>(false);

  // 当 Skill 载入但无正文时，尝试异步读取本地 SKILL.md
  useEffect(() => {
    if (!open || !skill) {
      setLoadedRaw('');
      return;
    }

    const directContent =
      skill.content ||
      skill.raw ||
      skill.rawSkill?.content ||
      skill.rawSkill?.raw;
    if (directContent) {
      setLoadedRaw(directContent);
      return;
    }

    const targetPath =
      skill.filePath || skill.rawSkill?.filePath || skill.rawExternal?.filePath;
    if (targetPath) {
      setLoadingDoc(true);
      void (async () => {
        try {
          const text = await readTextAny(targetPath);
          if (text) {
            setLoadedRaw(text);
          } else {
            setLoadedRaw('');
          }
        } catch {
          setLoadedRaw('');
        } finally {
          setLoadingDoc(false);
        }
      })();
    } else {
      setLoadedRaw('');
    }
  }, [open, skill]);

  // 解析 Frontmatter 元数据与正文
  const { frontmatter, markdownBody } = useMemo(() => {
    if (!skill) return { frontmatter: {}, markdownBody: '' };
    const rawToParse = loadedRaw || skill.content || skill.raw || '';
    if (rawToParse.trim()) {
      return parseSkillMarkdown(rawToParse);
    }
    // 兜底回退：若无明确 markdown，按名称与描述生成规范 Markdown 概述文档
    const fallbackMd = `# ${skill.name}\n\n${skill.description || '该技能为预设工作流，可在对话中通过快捷指令触发使用。'}\n\n### 指令语法\n\`\`\`bash\n/skill:${skill.name}\n\`\`\``;
    return { frontmatter: {}, markdownBody: fallbackMd };
  }, [loadedRaw, skill]);

  const handleCopyCommand = useCallback(() => {
    if (!skill) return;
    const cmd = `/skill:${skill.name}`;
    navigator.clipboard.writeText(cmd);
    showToast(`已复制快捷命令：${cmd}`);
  }, [skill, showToast]);

  const handleStartChat = useCallback(() => {
    if (!skill) return;
    if (onStartChatWithSkill) {
      onStartChatWithSkill(skill);
    } else {
      const sessionId = useSessionStore
        .getState()
        .createSession({ title: `${skill.name} 对话` });
      useSessionStore
        .getState()
        .setComposerDraft(sessionId, `/skill:${skill.name} `);
      navigateToChatSession(sessionId);
      onBackToChat?.();
      showToast(`已开启新会话并装配「${skill.name}」技能指令`);
    }
    onClose();
  }, [skill, onStartChatWithSkill, onBackToChat, onClose, showToast]);

  if (!skill) return null;

  const isInstalled = Boolean(skill.isInstalled);
  const isEnabled = skill.isEnabled ?? true;
  const sourceName =
    skill.source || frontmatter.source || (skill.isOfficial ? '官方' : '社区');
  const version = skill.version || frontmatter.version;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel={`${skill.name} 技能文档`}
      role="dialog"
      showCloseButton={false}
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
    >
      {/* 头部区 */}
      <div className={styles.modalHeader}>
        <div className={styles.headerLeft}>
          <div className={styles.skillIconBox}>
            <AppIcon name="blocks" size={17} />
          </div>
          <div className={styles.skillTitleGroup}>
            <div className={styles.skillNameRow}>
              <span className={styles.skillName}>{skill.name}</span>
              <span
                className={
                  skill.isOfficial ||
                  sourceName === 'official' ||
                  sourceName === '官方'
                    ? styles.sourceBadgeOfficial
                    : styles.sourceBadgeCommunity
                }
              >
                {sourceName}
              </span>
              {version && <span className={styles.metaBadge}>v{version}</span>}
            </div>
            <span className={styles.skillSubtitle}>
              {skill.description ||
                frontmatter.description ||
                '自定义提示词与工作流技能'}
            </span>
          </div>
        </div>

        <div className={styles.headerRight}>
          <Tooltip content="关闭">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="关闭详情弹窗"
            >
              <AppIcon name="x" size={14} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* YAML 元数据条目栏（若存在有效元数据） */}
      {Object.keys(frontmatter).length > 0 && (
        <div className={styles.yamlMetaBar}>
          {Object.entries(frontmatter).map(([k, v]) => (
            <span key={k} className={styles.yamlPill}>
              <span className={styles.yamlPillKey}>{k}:</span>
              <span>{v}</span>
            </span>
          ))}
        </div>
      )}

      {/* Markdown 正文富文本渲染区 */}
      <div
        className={styles.markdownContainer}
        data-testid="skill-markdown-view"
      >
        {loadingDoc ? (
          <div className={styles.emptyDocHint}>
            <AppIcon name="refresh" size={18} className={styles.spinning} />
            <span>正在读取 SKILL.md 文档…</span>
          </div>
        ) : (
          <MarkdownDocumentView
            content={markdownBody}
            filePath={skill.filePath}
            variant="document"
            emptyPlaceholder="暂无技能正文说明"
          />
        )}
      </div>

      {/* 底部操作区 */}
      <div className={styles.modalFooter}>
        <div className={styles.footerLeft}>
          <Tooltip content="复制该技能的快捷指令">
            <Button
              variant="secondary"
              size="sm"
              className={styles.commandCopyBtn}
              onClick={handleCopyCommand}
              aria-label={`复制 /skill:${skill.name}`}
            >
              <AppIcon name="copy" size={12} />
              <span>/skill:{skill.name}</span>
            </Button>
          </Tooltip>

          {isInstalled && onToggleEnabled && (
            <div className={styles.toggleWrapper}>
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) =>
                  void onToggleEnabled(skill, checked)
                }
                aria-label={`启用 ${skill.name}`}
              />
              <span className={styles.toggleLabel}>
                {isEnabled ? '已启用' : '已停用'}
              </span>
            </div>
          )}
        </div>

        <div className={styles.footerRight}>
          {!isInstalled && onImport && (
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => void onImport(skill)}
            >
              <AppIcon name="download" size={13} />
              <span>导入并启用此技能</span>
            </Button>
          )}

          <Button variant="secondary" size="sm" onClick={handleStartChat}>
            <AppIcon name="message-square" size={13} />
            <span>使用此技能新建对话</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
};
