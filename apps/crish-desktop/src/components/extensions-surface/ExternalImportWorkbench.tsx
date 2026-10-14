import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, SegmentedControl, Tooltip } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/storeAccess';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
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
import { resolveMcpTools } from './McpConnectModal';
import { SkillDetailModal, type SkillDetailTarget } from './SkillDetailModal';
import styles from './ExternalImportWorkbench.module.css';

export type ImportCategory = 'mcp' | 'skill';

export interface ExternalImportItem {
  id: string;
  kind: 'mcp' | 'skill';
  source:
    | 'Claude Code'
    | 'Codex'
    | 'Antigravity'
    | 'Claude Desktop'
    | 'Cursor'
    | '本地'
    | 'Local';
  name: string;
  description: string;
  rawMcp?: DetectedExternalMcpServer;
  rawSkill?: DetectedExternalSkill;
}

export interface ExternalImportWorkbenchProps {
  categoryFilter?: 'skill' | 'skills' | 'mcp';
  onImportSuccess?: () => void;
  onRefresh?: () => void;
  onBackToChat?: () => void;
}

export const ExternalImportWorkbench: React.FC<
  ExternalImportWorkbenchProps
> = ({ categoryFilter, onImportSuccess, onRefresh, onBackToChat }) => {
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

  const existingMcpNames = useMemo(
    () => new Set(settingsMcpServers.map((s) => s.name.toLowerCase())),
    [settingsMcpServers]
  );

  const loadSkillsState = useCallback(async () => {
    try {
      const current = await discoverSkills();
      const list = Array.isArray(current) ? current : current?.skills || [];
      setInstalledSkillNames(
        new Set(list.map((s: { name: string }) => s.name.toLowerCase()))
      );
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

  // 导入单项 MCP 服务
  const handleImportMcp = async (mcp: DetectedExternalMcpServer) => {
    try {
      const current = useSettingsStore.getState().mcpServers || [];
      const resolvedTools = resolveMcpTools(mcp.name, mcp.command, mcp.args);
      const newServer: McpServer = {
        id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: mcp.name,
        type: mcp.type || 'stdio',
        ...(mcp.command ? { command: mcp.command, args: mcp.args } : {}),
        ...(mcp.url ? { url: mcp.url } : {}),
        ...(mcp.env ? { env: mcp.env } : {}),
        status: 'connected',
        tools: resolvedTools.length > 0 ? resolvedTools : ['default_tool'],
      };

      const updated = [
        ...current.filter(
          (s) => s.name !== newServer.name && s.id !== newServer.id
        ),
        newServer,
      ];
      useSettingsStore.getState().setMcpServers(updated);
      await clientApi.saveSettingsEx('__global__', 'global', {
        mcpServers: updated,
      } as unknown as Partial<Settings>);
      showToast(`已成功导入 MCP 服务「${newServer.name}」`);
      notifyChange();
    } catch (err) {
      showToast(
        `导入 MCP 失败：${err instanceof Error ? err.message : String(err)}`
      );
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

  const currentItems = useMemo<ExternalImportItem[]>(() => {
    if (activeCategory === 'mcp') {
      return mcpList.map((m) => ({
        id: `mcp:${m.source}:${m.name}`,
        kind: 'mcp' as const,
        source: m.source,
        name: m.name,
        description: m.description || `${m.command || 'mcp'} 外部服务`,
        rawMcp: m,
      }));
    }
    return skillsList.map((s) => ({
      id: `skill:${s.source}:${s.name}`,
      kind: 'skill' as const,
      source: s.source === 'Local' ? '本地' : s.source,
      name: s.name,
      description: s.description || '外部扩展技能',
      rawSkill: s,
    }));
  }, [activeCategory, mcpList, skillsList]);

  const openSkillDetail = (item: ExternalImportItem) => {
    if (item.kind !== 'skill' || !item.rawSkill) return;
    const isImported = installedSkillNames.has(item.name.toLowerCase());
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

  return (
    <div className={styles.workbench}>
      {/* 顶部 Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerTitle}>
            <AppIcon
              name={activeCategory === 'skill' ? 'sparkles' : 'cpu'}
              size={18}
            />
            <span>从其他应用导入</span>
            <span style={{ marginLeft: 6, fontSize: '0.85em', opacity: 0.85 }}>
              {activeCategory === 'skill'
                ? '导入外部技能'
                : '导入外部 MCP 服务'}
            </span>
          </div>
          <div className={styles.headerSubtitle}>
            {activeCategory === 'skill'
              ? '从其他软件（Antigravity、Claude Code、Codex）一键导入技能'
              : '从其他软件（Antigravity、Claude Code、Codex、Claude Desktop）一键接入 MCP 服务'}
          </div>
        </div>
        <div className={styles.headerActions}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleScan(true)}
            disabled={loading}
          >
            <AppIcon
              name="rotate-cw"
              size={13}
              className={loading ? styles.spinning : ''}
            />
            <span>{loading ? '扫描中…' : '重新扫描'}</span>
          </Button>
          {activeCategory === 'skill' && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void handlePickDirectory()}
            >
              <AppIcon name="folder-input" size={13} />
              <span>从文件夹导入...</span>
            </Button>
          )}
        </div>
      </div>

      {/* 分类切换与计数栏 */}
      <div className={styles.toolbar}>
        {!categoryFilter ? (
          <div className={styles.segmentedWrapper}>
            <SegmentedControl
              size="sm"
              value={activeCategory}
              onChange={(val) => setActiveCategory(val as ImportCategory)}
              options={[
                { value: 'mcp', label: `MCP 服务 (${mcpList.length})` },
                { value: 'skill', label: `技能 (${skillsList.length})` },
              ]}
              aria-label="导入分类切换"
            />
          </div>
        ) : null}
        <div className={styles.countBadge}>
          {activeCategory === 'mcp'
            ? `已发现 ${mcpList.length} 项${categoryFilter ? '外部 ' : ''}MCP 服务`
            : `已发现 ${skillsList.length} 项外部技能`}
        </div>
      </div>

      {/* 主卡片列表 */}
      <div className={styles.content}>
        {currentItems.length === 0 ? (
          <div className={styles.emptyState}>
            <AppIcon name="archive" size={32} />
            <div>
              {activeCategory === 'mcp'
                ? '未发现外部应用（Claude Code、Codex、Antigravity、Cursor）的 MCP 服务'
                : '未发现外部应用的技能包，可点击右上角「从文件夹导入...」手动引入'}
            </div>
          </div>
        ) : (
          <div className={styles.grid}>
            {currentItems.map((item) => {
              const isImported =
                item.kind === 'mcp'
                  ? existingMcpNames.has(item.name.toLowerCase())
                  : installedSkillNames.has(item.name.toLowerCase());

              return (
                <div
                  key={item.id}
                  className={`${styles.card} ${item.kind === 'skill' ? styles.clickableSkillCard : ''}`}
                  role={item.kind === 'skill' ? 'button' : undefined}
                  tabIndex={item.kind === 'skill' ? 0 : undefined}
                  onClick={() => openSkillDetail(item)}
                  onKeyDown={(e) => {
                    if (
                      item.kind === 'skill' &&
                      (e.key === 'Enter' || e.key === ' ')
                    ) {
                      e.preventDefault();
                      openSkillDetail(item);
                    }
                  }}
                >
                  <div className={styles.cardHeaderRow}>
                    <div className={styles.cardHeaderLeft}>
                      <div className={styles.cardIcon}>
                        <AppIcon
                          name={item.kind === 'mcp' ? 'cpu' : 'sparkles'}
                          size={15}
                        />
                      </div>
                      <div className={styles.cardTitleGroup}>
                        <Tooltip content={item.name}>
                          <span className={styles.cardName}>{item.name}</span>
                        </Tooltip>
                        <span
                          className={styles.sourceBadge}
                          data-source={item.source}
                        >
                          {item.source}
                        </span>
                      </div>
                    </div>
                    <div
                      className={styles.cardHeaderRight}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {isImported ? (
                        <Tooltip content="已导入">
                          <span
                            className={styles.importedSymbol}
                            aria-label="已导入"
                          >
                            <AppIcon name="check" size={14} />
                          </span>
                        </Tooltip>
                      ) : (
                        <Tooltip content="导入">
                          <Button
                            size="sm"
                            variant="secondary"
                            className={styles.importSymbolBtn}
                            aria-label="导入"
                            onClick={() => {
                              if (item.kind === 'mcp' && item.rawMcp)
                                void handleImportMcp(item.rawMcp);
                              else if (item.kind === 'skill' && item.rawSkill)
                                void handleImportSkill(item.rawSkill);
                            }}
                          >
                            <AppIcon name="download" size={13} />
                          </Button>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <Tooltip content={item.description}>
                    <div className={styles.cardDesc}>{item.description}</div>
                  </Tooltip>
                </div>
              );
            })}
          </div>
        )}
      </div>
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
