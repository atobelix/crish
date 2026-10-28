import React, { useState, useEffect } from 'react';
import { Dialog, Button, Textarea } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import { useToast } from '../../services/toast/ToastContext';
import { useSessionStore } from '../../store/storeAccess';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { emitUiEvent } from '../../api/uiEvents';
import {
  pickSkillDirectory,
  addExtraSkillDir,
  type DesktopSkill,
} from '../../api/skillsApi';
import styles from './SkillCreateModal.module.css';

export interface SkillCreateModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (skill?: DesktopSkill) => void;
}

const DEFAULT_AI_PROMPT =
  '请帮我创建一个用于自动化处理任务的技能，包括常用脚本执行、环境检查与容错机制';

export const SkillCreateModal: React.FC<SkillCreateModalProps> = ({
  open,
  onClose,
  onSuccess,
}) => {
  const { showToast } = useToast();
  const [aiPrompt, setAiPrompt] = useState(DEFAULT_AI_PROMPT);

  useEffect(() => {
    if (open) {
      setAiPrompt(DEFAULT_AI_PROMPT);
    }
  }, [open]);

  // 方式一：AI 智能对话创建
  const handleAiCreate = () => {
    const activeSid = useSessionStore.getState().activeSessionId;
    if (!activeSid) {
      showToast('当前无活跃对话，请先创建或打开一个对话');
      return;
    }

    const requirement = aiPrompt.trim() || DEFAULT_AI_PROMPT;
    const promptSeed = [
      '请帮我创建一个符合规范的 Crish 技能（SKILL.md）。',
      '',
      '## 需求描述',
      requirement,
      '',
      '## 生成规范',
      '1. 请包含完整的 YAML frontmatter（包含 name、description、activation: recommended 等字段）；',
      '2. 结构清晰：# 标题、## 何时使用、## 执行步骤、## 注意事项；',
      '3. 保证内容专业、结构完整，并提供可直接保存的完整 SKILL.md 代码。',
    ].join('\n');

    sessionDraftManager.injectSeed({
      targetSessionId: activeSid,
      content: promptSeed,
      mode: 'safe_seed',
      metadata: { source: 'skill_editor', title: 'AI 技能创建' },
    });

    showToast('已将技能创建需求填入对话输入框');
    onClose();
    emitUiEvent('open-chat');
  };

  // 方式二：导入本地已有技能目录
  const handleImportExistingDir = async () => {
    try {
      const selectedDir = await pickSkillDirectory();
      if (!selectedDir) return;
      addExtraSkillDir(selectedDir);
      showToast(`已成功导入技能目录：${selectedDir}`);
      onSuccess();
      onClose();
    } catch (err) {
      showToast(
        `导入技能目录失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  return (
    <Dialog
      size="lg"
      open={open}
      onClose={onClose}
      title="添加技能"
      classNames={{
        panel: styles.modalPanel,
        body: styles.modalBody,
      }}
      footer={
        <div className={styles.modalFooter}>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
        </div>
      }
    >
      <div className={styles.cardsContainer}>
        {/* AI 智能对话创建 */}
        <div className={styles.methodCard}>
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrapper}>
              <AppIcon name="sparkles" size={16} />
            </div>
            <div className={styles.cardHeaderText}>
              <div className={styles.cardTitle}>AI 智能对话创建</div>
            </div>
          </div>

          <Textarea
            label="技能需求描述"
            rows={3}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="请帮我创建一个用于自动化处理任务的技能，包括常用脚本执行、环境检查与容错机制"
          />

          <div className={styles.cardAction}>
            <Button
              variant="primary"
              size="sm"
              icon={<AppIcon name="sparkles" size={14} />}
              onClick={handleAiCreate}
            >
              在对话中由 AI 创建
            </Button>
          </div>
        </div>

        {/* 导入本地已有技能目录 */}
        <div className={styles.methodCard}>
          <div className={styles.cardHeader}>
            <div className={styles.cardIconWrapper}>
              <AppIcon name="folder-open" size={16} />
            </div>
            <div className={styles.cardHeaderText}>
              <div className={styles.cardTitle}>导入本地已有技能目录</div>
            </div>
          </div>

          <div className={styles.cardAction}>
            <Button
              variant="secondary"
              size="sm"
              icon={<AppIcon name="folder-open" size={14} />}
              onClick={handleImportExistingDir}
            >
              浏览并导入本地技能目录
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
