import React from 'react';
import { Button, SegmentedControl } from '@/components/ui';
import { AppIcon } from '@/components/ui/icons';
import type { DetectedExternalMcpServer } from './detectExternalMcpServers';
import type { DetectedExternalSkill } from './detectExternalSkills';
import type {
  ExternalImportItem,
  ImportCategory,
} from './externalImportWorkbenchModel';
import { skillMatchesInstalledSet } from './externalImportActions';
import { ExtensionActionCard } from './ExtensionActionCard';
import styles from './ExternalImportWorkbench.module.css';

/** 顶部标题区 + 分类切换/计数栏的展示属性 */
export interface ExternalImportTopBarProps {
  activeCategory: ImportCategory;
  loading: boolean;
  mcpCount: number;
  skillCount: number;
  categoryFilter?: 'skill' | 'skills' | 'mcp';
  onRescan: () => void;
  onPickDirectory: () => void;
  onCategoryChange: (category: ImportCategory) => void;
}

/** 顶部 Header 与分类切换/计数栏：仅渲染，行为经回调上抛 */
export const ExternalImportTopBar: React.FC<ExternalImportTopBarProps> = ({
  activeCategory,
  loading,
  mcpCount,
  skillCount,
  categoryFilter,
  onRescan,
  onPickDirectory,
  onCategoryChange,
}) => (
  <>
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
            {activeCategory === 'skill' ? '导入外部技能' : '导入外部 MCP 服务'}
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
          onClick={onRescan}
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
          <Button size="sm" variant="secondary" onClick={onPickDirectory}>
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
            onChange={(val) => onCategoryChange(val as ImportCategory)}
            options={[
              { value: 'mcp', label: `MCP 服务 (${mcpCount})` },
              { value: 'skill', label: `技能 (${skillCount})` },
            ]}
            aria-label="导入分类切换"
          />
        </div>
      ) : null}
      <div className={styles.countBadge}>
        {activeCategory === 'mcp'
          ? `已发现 ${mcpCount} 项${categoryFilter ? '外部 ' : ''}MCP 服务`
          : `已发现 ${skillCount} 项外部技能`}
      </div>
    </div>
  </>
);

/** 主卡片列表（含空态）的展示属性 */
export interface ExternalImportListProps {
  items: ExternalImportItem[];
  activeCategory: ImportCategory;
  existingMcpNames: Set<string>;
  installedSkillNames: Set<string>;
  busyId?: string | null;
  onOpenDetail: (item: ExternalImportItem) => void;
  onImportMcp: (mcp: DetectedExternalMcpServer) => Promise<void>;
  onImportSkill: (skill: DetectedExternalSkill) => Promise<void>;
  onRemoveMcp: (mcp: DetectedExternalMcpServer) => Promise<void>;
  onRemoveSkill: (skill: DetectedExternalSkill) => Promise<void>;
}

/** 主卡片列表：空态提示与 MCP/技能卡片网格 */
export const ExternalImportList: React.FC<ExternalImportListProps> = ({
  items,
  activeCategory,
  existingMcpNames,
  installedSkillNames,
  busyId,
  onOpenDetail,
  onImportMcp,
  onImportSkill,
  onRemoveMcp,
  onRemoveSkill,
}) => (
  <div className={styles.content}>
    {items.length === 0 ? (
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
        {items.map((item) => {
          const isImported =
            item.kind === 'mcp'
              ? existingMcpNames.has(item.name.toLowerCase())
              : skillMatchesInstalledSet(item.name, installedSkillNames);

          return (
            <ExtensionActionCard
              key={item.id}
              name={item.name}
              description={item.description}
              badge={item.source}
              icon={item.kind === 'mcp' ? 'cpu' : 'sparkles'}
              placement="import"
              installed={isImported}
              busy={busyId === item.id}
              onOpen={
                item.kind === 'skill' ? () => onOpenDetail(item) : undefined
              }
              onAction={() => {
                if (isImported) {
                  if (item.kind === 'mcp' && item.rawMcp) {
                    void onRemoveMcp(item.rawMcp);
                  } else if (item.rawSkill) {
                    void onRemoveSkill(item.rawSkill);
                  }
                  return;
                }
                if (item.kind === 'mcp' && item.rawMcp) {
                  void onImportMcp(item.rawMcp);
                } else if (item.rawSkill) {
                  void onImportSkill(item.rawSkill);
                }
              }}
            />
          );
        })}
      </div>
    )}
  </div>
);
