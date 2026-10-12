import { useCallback, useEffect, useMemo, useState } from 'react';
import { isDemoMode } from '../../api/appMode';
import { clientApi } from '../../api/clientApi';
import type { SkillSlashCommand } from '../../api/skillsApi';

export interface UseSlashMenuOptions {
  chatInput: string;
}

export interface UseSlashMenuResult {
  slashMenuOpen: boolean;
  setSlashMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  slashSelectedIndex: number;
  setSlashSelectedIndex: React.Dispatch<React.SetStateAction<number>>;
  filteredCommands: { cmd: string; desc: string }[];
  loadSkillSlash: () => Promise<void>;
  skillCommandsEnabled: boolean;
}

export function useSlashMenu({
  chatInput,
}: UseSlashMenuOptions): UseSlashMenuResult {
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [skillSlash, setSkillSlash] = useState<SkillSlashCommand[]>([]);
  const [skillCommandsEnabled, setSkillCommandsEnabled] = useState(true);

  const BASE_SLASH = useMemo(
    () => [
      { cmd: '/goal', desc: '开启长程自主推进模式，直到彻底达成目标' },
      { cmd: '/compact', desc: '压缩会话上下文，释放 Token' },
      { cmd: '/schedule', desc: '定时/周期性工作流任务编排' },
      { cmd: '/browser', desc: '唤起内置受管预览浏览器' },
      { cmd: '/teamwork', desc: '多 Agent 团队并行协同看板' },
      { cmd: '/learn', desc: '从对话经验沉淀并记住长期规则' },
      { cmd: '/grill-me', desc: '深度交互式方案推演，严格拷问' },
      { cmd: '/clear', desc: '清空当前会话上下文并重置状态' },
      { cmd: '/stop', desc: '停止当前正在生成的回答或运行中的任务' },
      { cmd: '/settings', desc: '打开工作台设置中心' },
      ...(isDemoMode() ? [{ cmd: '/simulate', desc: '演示流水线' }] : []),
    ],
    []
  );

  useEffect(() => {
    let cancelled = false;
    const loadSettings = async () => {
      try {
        const settings = await clientApi.getSettings();
        if (cancelled) return;
        const on = settings?.enableSkillCommands !== false;
        setSkillCommandsEnabled(on);
        if (!on) setSkillSlash([]);
      } catch {
        /* ignore */
      }
    };
    void loadSettings();
    const onSkillsChanged = () => {
      void (async () => {
        try {
          const settings = await clientApi.getSettings();
          if (cancelled) return;
          const on = settings?.enableSkillCommands !== false;
          setSkillCommandsEnabled(on);
          if (!on) {
            setSkillSlash([]);
            return;
          }
          const { getSkillSlashCommandsCached } =
            await import('../../api/skillsApi');
          const { commands } = await getSkillSlashCommandsCached(true);
          if (!cancelled) setSkillSlash(commands);
        } catch {
          /* ignore */
        }
      })();
    };
    window.addEventListener('crish-skills-changed', onSkillsChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('crish-skills-changed', onSkillsChanged);
    };
  }, []);

  const loadSkillSlash = useCallback(async () => {
    if (!skillCommandsEnabled) return;
    try {
      const { getSkillSlashCommandsCached } =
        await import('../../api/skillsApi');
      const { commands } = await getSkillSlashCommandsCached();
      setSkillSlash(commands);
    } catch {
      /* ignore */
    }
  }, [skillCommandsEnabled]);

  const allSlashCommands = useMemo(() => {
    const skillPart = skillCommandsEnabled
      ? skillSlash.map((s) => ({
          cmd: s.cmd,
          desc: s.desc,
          skillId: s.skillId,
          skillName: s.skillName,
          filePath: s.filePath,
        }))
      : [];
    return [...BASE_SLASH, ...skillPart];
  }, [BASE_SLASH, skillSlash, skillCommandsEnabled]);

  const filteredCommands = allSlashCommands.filter((c) => {
    const q = chatInput.toLowerCase();
    if (!q || q === '/' || q === '、') return true;
    const qNorm = q.startsWith('、') ? `/${q.slice(1)}` : q;
    const cmdLower = c.cmd.toLowerCase();
    if (cmdLower.startsWith(qNorm) || cmdLower.startsWith(q)) return true;
    const bareCmd = cmdLower.replace(/^\/skill:/, '/');
    if (bareCmd.startsWith(qNorm) || bareCmd.startsWith(q)) return true;
    const skillName =
      'skillName' in c && typeof c.skillName === 'string' ? c.skillName : '';
    if (skillName) {
      const nameLower = skillName.toLowerCase();
      const qWithoutPrefix = q.replace(/^[、/]/, '');
      if (
        nameLower.startsWith(qWithoutPrefix) ||
        nameLower.includes(qWithoutPrefix)
      ) {
        return true;
      }
    }
    return false;
  });

  return {
    slashMenuOpen,
    setSlashMenuOpen,
    slashSelectedIndex,
    setSlashSelectedIndex,
    filteredCommands,
    loadSkillSlash,
    skillCommandsEnabled,
  };
}
