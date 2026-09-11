import { useCallback, useState } from 'react';
import type { DesktopSkill } from '../../api/skillsApi';

import {
  readSkillsCache,
  writeSkillsCache,
} from '../../api/cache/runtimeCache';

/** skills 缓存读写 hook（03-detail T10 拆分：useSkillsCache） */
export function useSkillsCache() {
  const [skills, setSkills] = useState<DesktopSkill[]>(() =>
    readSkillsCache()
  );

  const saveSkills = useCallback((list: DesktopSkill[]) => {
    setSkills(list);
    writeSkillsCache(list);
  }, []);

  return { skills, setSkills, saveSkills };
}
