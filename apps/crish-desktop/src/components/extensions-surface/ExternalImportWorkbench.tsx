import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Button, SegmentedControl } from '../ui';
import { AppIcon } from '../ui/icons/index';
import { useToast } from '../../services/toast/ToastContext';
import { useSettingsStore } from '../../store/settingsStore';
import { clientApi, type Settings, type McpServer } from '../../api/clientApi';
import {
  pickSkillDirectory,
  addExtraSkillDir,
  createProjectSkill,
  discoverSkills,
} from '../../api/skillsApi';
import {
  detectExternalMcpServers,
  DEFAULT_FALLBACK_MCP,
  type DetectedExternalMcpServer,
} from './detectExternalMcpServers';
import {
  detectExternalSkills,
  type DetectedExternalSkill,
} from './detectExternalSkills';
import { resolveMcpTools } from './McpConnectModal';
import styles from './ExternalImportWorkbench.module.css';

export type ImportCategory = 'mcp' | 'skill';

export interface ExternalImportItem {
  id: string;
  kind: 'mcp' | 'skill';
  source: 'Antigravity' | 'Claude Desktop' | 'Cursor' | '本地' | 'Local';
  name: string;
  description: string;
  rawMcp?: DetectedExternalMcpServer;
  rawSkill?: DetectedExternalSkill;
}

export interface ExternalImportWorkbenchProps {
  onImportSuccess?: () => void;
  onRefresh?: () => void;
  onBackToChat?: () => void;
}

export const ExternalImportWorkbench: React.FC<
  ExternalImportWorkbenchProps
> = ({ onImportSuccess, onRefresh }) => {
  const { showToast } = useToast();
  const settingsMcpServers = useSettingsStore((s) => s.mcpServers || []);

  const [loading, setLoading] = useState(false);
  const [activeCategory, setActiveCategory] = useState<ImportCategory>('mcp');
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
      // ignore
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

        if (isManual) {
          showToast('已完成外部应用 MCP 服务与技能探测扫描');
        }
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
      addExtraSkillDir(selectedDir);
      showToast(`已成功导入技能目录：${selectedDir}`);
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
      if (skill.skillDir) {
        addExtraSkillDir(skill.skillDir);
        showToast(`已成功引入技能目录「${skill.name}」`);
      } else {
        const res = await createProjectSkill({
          name: skill.name,
          description: skill.description,
        });
        if (res.ok) {
          showToast(`已成功将技能「${skill.name}」导入当前工作区`);
        } else if (skill.filePath) {
          const dir = skill.filePath.replace(/[\\/][^\\/]+$/, '');
          addExtraSkillDir(dir);
          showToast(`已通过附加目录引入技能「${skill.name}」`);
        } else {
          showToast(`导入技能失败：${res.error}`);
          return;
        }
      }
      window.dispatchEvent(new CustomEvent('crish-skills-changed'));
      void loadSkillsState();
      notifyChange();
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

  return (
    <div className={styles.workbench}>
      {/* 顶部 Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerTitle}>
            <AppIcon name="folder-input" size={18} />
            <span>从其他应用导入</span>
          </div>
          <div className={styles.headerSubtitle}>
            一键导入 Antigravity、Claude Desktop、Cursor 探测到的 MCP 服务与
            Skill
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
        <div className={styles.countBadge}>
          {activeCategory === 'mcp'
            ? `已发现 ${mcpList.length} 项 MCP 服务`
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
                ? '未发现外部应用（Antigravity、Claude Desktop、Cursor）的 MCP 服务'
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
                <div key={item.id} className={styles.card}>
                  <div className={styles.cardHeaderRow}>
                    <div className={styles.cardHeaderLeft}>
                      <div className={styles.cardIcon}>
                        <AppIcon
                          name={item.kind === 'mcp' ? 'cpu' : 'sparkles'}
                          size={15}
                        />
                      </div>
                      <div className={styles.cardTitleGroup}>
                        <span className={styles.cardName}>{item.name}</span>
                        <span className={styles.sourceBadge}>
                          {item.source}
                        </span>
                      </div>
                    </div>
                    <div className={styles.cardHeaderRight}>
                      {isImported ? (
                        <span className={styles.importedBadge}>
                          <AppIcon name="check" size={12} />
                          <span>已导入</span>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            if (item.kind === 'mcp' && item.rawMcp) {
                              void handleImportMcp(item.rawMcp);
                            } else if (item.kind === 'skill' && item.rawSkill) {
                              void handleImportSkill(item.rawSkill);
                            }
                          }}
                        >
                          导入
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className={styles.cardDesc}>{item.description}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
