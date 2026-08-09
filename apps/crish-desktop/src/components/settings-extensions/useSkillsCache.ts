import { useCallback, useState } from 'react';
import type { DesktopSkill } from '../../api/skillsApi';

const SKILLS_CACHE_KEY = 'crish_skills_cache_v1';

function loadSkillsCache(): DesktopSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveSkillsCache(list: DesktopSkill[]) {
  try {
    localStorage.setItem(SKILLS_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** skills 缓存读写 hook（03-detail T10 拆分：useSkillsCache） */
export function useSkillsCache() {
  const [skills, setSkills] = useState<DesktopSkill[]>(() =>
    loadSkillsCache()
  );

  const saveSkills = useCallback((list: DesktopSkill[]) => {
    setSkills(list);
    saveSkillsCache(list);
  }, []);

  return { skills, setSkills, saveSkills };
}
