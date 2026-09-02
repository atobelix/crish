import { useCallback, useMemo, useState } from 'react';
import { toast } from '../../services/toast/ToastContext';
import { createProjectSkill, type DesktopSkill } from '../../api/skillsApi';
import { skillStableId } from '../../api/skillId';
import { getWorkspacePath } from '../../api/projectStore';
import { parseMarkdownToHtml } from '../../api/markdownRender';
import { useSessionStore } from '../../store/sessionStore';
import { sessionDraftManager } from '../../api/draft/sessionDraftManager';
import { emitUiEvent } from '../../api/uiEvents';
import { closeSettings } from '../../store/storeAccess';
import {
  errText,
  skillSlashCmd,
  type SharedSkillApi,
} from './skillsSettingsTypes';

export interface UseSkillEditorDeps {
  selected: DesktopSkill | null;
}

export function useSkillEditor(deps: UseSkillEditorDeps, api: SharedSkillApi) {
  const [createMode, setCreateMode] = useState<'none' | 'paths' | 'manual'>(
    'none'
  );
  const [createName, setCreateName] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [extraOpen, setExtraOpen] = useState(false);

  // 共享 setter 给 hub，让 useSkillDirectories.handleImportBrowse 能消费。
  api.setCreateMode = setCreateMode;
  api.setExtraOpen = setExtraOpen;

  const handleCreate = async () => {
    if (!createName.trim() || createBusy) return;
    setCreateBusy(true);
    try {
      const r = await createProjectSkill({
        name: createName.trim(),
        ...(createDesc.trim() ? { description: createDesc.trim() } : {}),
        workspacePath: getWorkspacePath(),
      });
      if (r.ok === false) {
        toast.show(r.error || '创建技能失败');
        return;
      }
      const slug = createName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      const selectId = skillStableId(slug || createName.trim(), r.skillPath);
      setCreateMode('none');
      setCreateName('');
      setCreateDesc('');
      await api.refresh();
      api.setSelectedId(selectId);
    } catch (e) {
      toast.show(`创建技能失败：${errText(e)}`);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleAiCreateSkill = () => {
    // 以 store 当前活跃会话定向注入（返回对话时即该会话）；无活跃会话则中止
    const targetSid = useSessionStore.getState().activeSessionId;
    if (targetSid) {
      sessionDraftManager.injectSeed({
        targetSessionId: targetSid,
        content: [
          '请帮我创建一个 Crish 技能（正式 SKILL.md）。',
          '需要：用途说明、适用场景、主要步骤，以及可直接保存的完整 SKILL.md 内容（含 frontmatter）。',
          '我打算用它来：',
        ].join('\n'),
        mode: 'safe_seed',
        metadata: { source: 'skill_editor', title: '技能对话创建' },
      });
    } else {
      console.warn('[useSkillEditor] 无活跃会话，跳过草稿注入');
    }
    setCreateMode('none');
    closeSettings();
    emitUiEvent('open-chat');
  };

  const copySlashCommand = async (name: string) => {
    const cmd = skillSlashCmd(name);
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      toast.show('复制失败');
    }
  };

  const previewHtml = useMemo(() => {
    if (!deps.selected) return '';
    if (showRaw) return '';
    const md = `# ${deps.selected.name}\n\n> ${deps.selected.description}\n\n${deps.selected.content || '_（无正文）_'}`;
    return parseMarkdownToHtml(md);
  }, [deps.selected, showRaw]);

  const selectedSlash = deps.selected
    ? skillSlashCmd(deps.selected.name)
    : '';

  return {
    createMode,
    setCreateMode,
    createName,
    setCreateName,
    createDesc,
    setCreateDesc,
    createBusy,
    handleCreate,
    handleAiCreateSkill,
    showRaw,
    setShowRaw,
    previewHtml,
    selectedSlash,
    copySlashCommand,
    moreOpen,
    setMoreOpen,
    extraOpen,
    setExtraOpen,
  };
}

export type UseSkillEditorReturn = ReturnType<typeof useSkillEditor>;
