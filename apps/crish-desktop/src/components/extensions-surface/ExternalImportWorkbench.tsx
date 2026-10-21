import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/storeAccess';
import {
  pickSkillDirectory,
  addExtraSkillDir,
  createProjectSkill,
  createGlobalSkill,
  setSkillActivation,
  discoverSkills,
  tryHomeDir,
  readTextAny,
  normalizeSlashName,
  skillStableId,
  type DesktopSkill,
} from '../../api/skillsApi';
import { PluginImportPanel } from './PluginImportPanel';
import {
  importDetectedMcpServer,
  removeImportedMcpByName,
  skillMatchesInstalledSet,
  uninstallDesktopSkill,
} from './externalImportActions';
import { setSkillDismissed } from './skillDismissState';

import {
  detectExternalMcpServers,
  DEFAULT_FALLBACK_MCP,
  type DetectedExternalMcpServer,
} from './detectExternalMcpServers';
import {
  detectExternalSkills,
  isDisallowedSkillName,
  isQualifiedSkill,
  type DetectedExternalSkill,
} from './detectExternalSkills';
import { SkillDetailModal, type SkillDetailTarget } from './SkillDetailModal';
import {
  buildImportItems,
  type ExternalImportItem,
  type ImportCategory,
} from './externalImportWorkbenchModel';
import {
  ExternalImportList,
  ExternalImportTopBar,
} from './ExternalImportWorkbench.sections';
import styles from './ExternalImportWorkbench.module.css';

export type { ImportCategory, ExternalImportItem };

export interface ExternalImportWorkbenchProps {
  categoryFilter?: 'skill' | 'skills' | 'mcp' | 'plugin' | 'plugins';
  onImportSuccess?: () => void;
  onRefresh?: () => void;
  onBackToChat?: () => void;
  onRequestPluginImport?: () => void;
}

export const ExternalImportWorkbench: React.FC<
  ExternalImportWorkbenchProps
> = ({
  categoryFilter,
  onImportSuccess,
  onRefresh,
  onBackToChat,
  onRequestPluginImport,
}) => {
  const { showToast } = useToast();
  const settingsMcpServers = useSettingsStore((s) => s.mcpServers || []);

  const [loading, setLoading] = useState(false);
  const [selectedSkillForModal, setSelectedSkillForModal] =
    useState<SkillDetailTarget | null>(null);
  const initialCategory: ImportCategory =
    categoryFilter === 'skills' || categoryFilter === 'skill' ? 'skill' : 'mcp';
  const [activeCategory, setActiveCategory] =
    useState<ImportCategory>(initialCategory);

  useEffect(() => {
    if (categoryFilter) {
      setActiveCategory(
        categoryFilter === 'skills' || categoryFilter === 'skill'
          ? 'skill'
          : 'mcp'
      );
    }
  }, [categoryFilter]);
  const [mcpList, setMcpList] = useState<DetectedExternalMcpServer[]>([]);
  const [skillsList, setSkillsList] = useState<DetectedExternalSkill[]>([]);
  const [installedSkillNames, setInstalledSkillNames] = useState<Set<string>>(
    () => new Set()
  );
  const [optimisticSkillNames, setOptimisticSkillNames] = useState<Set<string>>(
    () => new Set()
  );
  const [skillEpoch, setSkillEpoch] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isPluginCategory =
    categoryFilter === 'plugin' || categoryFilter === 'plugins';

  const existingMcpNames = useMemo(
    () => new Set(settingsMcpServers.map((s) => s.name.toLowerCase())),
    [settingsMcpServers]
  );

  const visibleSkillNames = useMemo(() => {
    const next = new Set(installedSkillNames);
    for (const name of optimisticSkillNames) {
      next.add(name.toLowerCase());
      const slug = normalizeSlashName(name);
      if (slug) next.add(slug);
    }
    return next;
  }, [installedSkillNames, optimisticSkillNames, skillEpoch]);

  const loadSkillsState = useCallback(async () => {
    try {
      const current = await discoverSkills();
      const list = Array.isArray(current) ? current : current?.skills || [];
      const next = new Set<string>();
      for (const skill of list as { name?: string }[]) {
        const name = String(skill.name || '').trim();
        if (!name) continue;
        next.add(name.toLowerCase());
        const slug = normalizeSlashName(name);
        if (slug) next.add(slug);
      }
      setInstalledSkillNames(next);
    } catch {
      /* ignore */
    }
  }, []);

  const handleScan = useCallback(
    async (isManual = false) => {
      setLoading(true);
      try {
        const [detectedMcp, detectedSkills] = await Promise.all([
          detectExternalMcpServers().catch(() => []),
          detectExternalSkills().catch(() => []),
          loadSkillsState(),
        ]);
        setMcpList(detectedMcp.length > 0 ? detectedMcp : DEFAULT_FALLBACK_MCP);
        setSkillsList(detectedSkills);
        if (isManual) showToast('已完成外部应用 MCP 服务与技能探测扫描');
      } catch (err) {
        showToast(
          `扫描外部配置失败：${err instanceof Error ? err.message : String(err)}`
        );
      } finally {
        setLoading(false);
      }
    },
    [loadSkillsState, showToast]
  );

  useEffect(() => {
    void handleScan(false);
  }, [handleScan]);

  useEffect(() => {
    const onSkillsChanged = () => {
      void loadSkillsState();
    };
    window.addEventListener('crish-skills-changed', onSkillsChanged);
    return () =>
      window.removeEventListener('crish-skills-changed', onSkillsChanged);
  }, [loadSkillsState]);

  const notifyChange = () => {
    onImportSuccess?.();
    onRefresh?.();
  };

  // 从文件夹导入技能
  const handlePickDirectory = async () => {
    try {
      const selectedDir = await pickSkillDirectory();
      if (!selectedDir) return;
      const rawHome = await tryHomeDir();
      const envHome =
        typeof process !== 'undefined'
          ? process.env?.USERPROFILE || process.env?.HOME
          : '';
      const homeDir = (rawHome?.trim() || envHome || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
      const norm = selectedDir.replace(/\\/g, '/');
      const expandedDir =
        homeDir && (norm === '~' || norm.startsWith('~/'))
          ? norm === '~'
            ? homeDir
            : `${homeDir}/${norm.slice(2)}`
          : selectedDir;
      addExtraSkillDir(expandedDir);
      showToast(`已成功导入技能目录：${expandedDir}`);
      window.dispatchEvent(new CustomEvent('crish-skills-changed'));
      void loadSkillsState();
      notifyChange();
    } catch (err) {
      showToast(
        `导入目录失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const mcpItemId = (mcp: DetectedExternalMcpServer) =>
    `mcp:${mcp.source}:${mcp.name}`;
  const skillItemId = (skill: DetectedExternalSkill) =>
    `skill:${skill.source}:${skill.name}`;

  const rememberImportedSkill = (name: string) => {
    setSkillDismissed(name, false);
    setOptimisticSkillNames((prev) => {
      const next = new Set(prev);
      next.add(name.toLowerCase());
      return next;
    });
    setSkillEpoch((value) => value + 1);
  };

  const forgetImportedSkill = (name: string) => {
    setOptimisticSkillNames((prev) => {
      const next = new Set(prev);
      next.delete(name.toLowerCase());
      const slug = normalizeSlashName(name);
      if (slug) next.delete(slug);
      return next;
    });
    setSkillEpoch((value) => value + 1);
  };

  // 导入单项 MCP 服务
  const handleImportMcp = async (mcp: DetectedExternalMcpServer) => {
    setBusyId(mcpItemId(mcp));
    try {
      const result = await importDetectedMcpServer(mcp);
      showToast(result.message);
      if (result.ok) notifyChange();
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveMcp = async (mcp: DetectedExternalMcpServer) => {
    setBusyId(mcpItemId(mcp));
    try {
      const result = await removeImportedMcpByName(mcp.name);
      showToast(result.message);
      if (result.ok) notifyChange();
    } finally {
      setBusyId(null);
    }
  };

  const handleRemoveSkill = async (skill: DetectedExternalSkill) => {
    setBusyId(skillItemId(skill));
    try {
      const result = await uninstallDesktopSkill({
        name: skill.name,
        filePath: skill.filePath,
        baseDir: skill.skillDir,
        description: skill.description,
      });
      showToast(result.message);
      if (result.ok) {
        forgetImportedSkill(skill.name);
        await loadSkillsState();
        notifyChange();
      }
    } finally {
      setBusyId(null);
    }
  };

  // 导入单项技能
  const handleImportSkill = async (skill: DetectedExternalSkill) => {
    try {
      if (isDisallowedSkillName(skill.name) || !isQualifiedSkill(skill)) {
        showToast(`技能「${skill.name}」属于不合规或未适配脚本，已禁止导入`);
        return;
      }

      const rawHome = await tryHomeDir();
      const envHome =
        typeof process !== 'undefined'
          ? process.env?.USERPROFILE || process.env?.HOME
          : '';
      const homeDir = (rawHome?.trim() || envHome || '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
      const expandTilde = (p?: string): string => {
        if (!p) return '';
        const n = p.replace(/\\/g, '/');
        if (
          homeDir &&
          (n === '~' || n.startsWith('~/') || n.startsWith('~\\'))
        ) {
          return n === '~'
            ? homeDir
            : `${homeDir}/${n.slice(2).replace(/^[\\/]+/, '')}`;
        }
        return n;
      };
      const expandedFilePath = expandTilde(skill.filePath);
      const expandedSkillDir = expandTilde(
        skill.skillDir ||
          (skill.filePath ? skill.filePath.replace(/[\\/][^\\/]+$/, '') : '')
      );

      let contentToSave = skill.content?.trim();
      if (!contentToSave && expandedFilePath) {
        try {
          const text = await readTextAny(expandedFilePath);
          if (text !== null && text !== undefined && !text.trim()) {
            showToast(`技能「${skill.name}」正文为空，无法导入`);
            return;
          }
          if (text?.trim()) contentToSave = text.trim();
        } catch {
          /* ignore */
        }
      }

      const slug =
        normalizeSlashName(skill.name) ||
        skill.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      const desc = (skill.description || `${skill.name} 技能`).trim();
      if (!contentToSave) {
        contentToSave = [
          '---',
          `name: ${slug}`,
          `description: ${JSON.stringify(desc)}`,
          'activation: recommended',
          '---',
          '',
          `# ${skill.name}`,
          '',
          '## 何时使用',
          `- ${desc}`,
          '',
          '## 步骤',
          '1. 阅读任务上下文',
          '2. 按本技能约定执行',
          '3. 完成后做简要校验',
          '',
        ].join('\n');
      }

      let savedSkillPath = '';
      let savedSkillDir = '';
      let saveScope: 'project' | 'global' = 'project';

      const projRes = await createProjectSkill({
        name: skill.name,
        description: skill.description,
        content: contentToSave,
        overwrite: true,
      });

      if (projRes.ok) {
        savedSkillPath = projRes.skillPath;
        savedSkillDir = projRes.skillDir;
        saveScope = 'project';
      } else {
        const globalRes = await createGlobalSkill({
          name: skill.name,
          description: skill.description,
          homeDir,
          content: contentToSave,
          overwrite: true,
        });
        if (globalRes.ok) {
          savedSkillPath = globalRes.skillPath;
          savedSkillDir = globalRes.skillDir;
          saveScope = 'global';
        } else if (expandedSkillDir) {
          addExtraSkillDir(expandedSkillDir);
          savedSkillDir = expandedSkillDir;
          savedSkillPath = expandedFilePath || `${expandedSkillDir}/SKILL.md`;
          saveScope = 'global';
        } else {
          showToast(`导入技能失败：${projRes.error || globalRes.error}`);
          return;
        }
      }

      const finalId = skillStableId(skill.name, savedSkillPath);
      const importedSkill: DesktopSkill = {
        id: finalId,
        name: skill.name,
        description: desc,
        filePath: savedSkillPath,
        baseDir: savedSkillDir,
        content: contentToSave,
        raw: contentToSave,
        scope: saveScope,
        activation: 'enabled',
        tags: [],
        appliesTo: [],
        disableModelInvocation: false,
        system: false,
      };

      await setSkillActivation(importedSkill, 'enabled');
      rememberImportedSkill(skill.name);
      window.dispatchEvent(new CustomEvent('crish-skills-changed'));
      await loadSkillsState();
      notifyChange();

      if (saveScope === 'project' && projRes.ok) {
        showToast(`已成功将技能「${skill.name}」导入当前工作区并启用`);
      } else if (saveScope === 'global' && !expandedSkillDir) {
        showToast(`已成功将技能「${skill.name}」导入全局技能库并启用`);
      } else {
        showToast(`已成功导入技能「${skill.name}」并启用`);
      }
    } catch (err) {
      showToast(
        `导入技能失败：${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const currentItems = useMemo<ExternalImportItem[]>(
    () => buildImportItems(activeCategory, mcpList, skillsList),
    [activeCategory, mcpList, skillsList]
  );

  const openSkillDetail = (item: ExternalImportItem) => {
    if (item.kind !== 'skill' || !item.rawSkill) return;
    const isImported = skillMatchesInstalledSet(item.name, visibleSkillNames);
    setSelectedSkillForModal({
      id: item.id,
      name: item.name,
      description: item.description,
      source: item.source,
      filePath: item.rawSkill.filePath,
      content: item.rawSkill.content,
      raw: item.rawSkill.content,
      isInstalled: isImported,
      rawExternal: item.rawSkill,
    });
  };

  if (isPluginCategory) {
    return (
      <div className={styles.workbench}>
        <PluginImportPanel onRequestFileImport={onRequestPluginImport} />
      </div>
    );
  }

  return (
    <div className={styles.workbench}>
      <ExternalImportTopBar
        activeCategory={activeCategory}
        loading={loading}
        mcpCount={mcpList.length}
        skillCount={skillsList.length}
        categoryFilter={categoryFilter}
        onRescan={() => void handleScan(true)}
        onPickDirectory={() => void handlePickDirectory()}
        onCategoryChange={setActiveCategory}
      />
      <ExternalImportList
        items={currentItems}
        activeCategory={activeCategory}
        existingMcpNames={existingMcpNames}
        installedSkillNames={visibleSkillNames}
        busyId={busyId}
        onOpenDetail={openSkillDetail}
        onImportMcp={handleImportMcp}
        onImportSkill={handleImportSkill}
        onRemoveMcp={handleRemoveMcp}
        onRemoveSkill={handleRemoveSkill}
      />
      <SkillDetailModal
        open={Boolean(selectedSkillForModal)}
        onClose={() => setSelectedSkillForModal(null)}
        skill={selectedSkillForModal}
        onImport={async (target) => {
          if (target.rawExternal) {
            await handleImportSkill(target.rawExternal);
            setSelectedSkillForModal(null);
          }
        }}
        onBackToChat={onBackToChat}
      />
    </div>
  );
};
