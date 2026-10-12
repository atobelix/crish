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
      { cmd: '/goal', desc: '多轮推进直至完成' },
      { cmd: '/learn', desc: '记住一条规则' },
      { cmd: '/grill-me', desc: '对齐提问，暂不实施' },
      { cmd: '/schedule', desc: '定时任务' },
      { cmd: '/teamwork', desc: '协作看板' },
      { cmd: '/browser', desc: '预览浏览器' },
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
