import React from 'react';
import * as Lucide from 'lucide-react';
import type { ExternalImportRoots } from '../../api/import';
import { Button, Tooltip } from '../ui';
import styles from './ExternalSessionImport.module.css';

export type ImportRootDisplay = {
  /** Effective scan root (custom or default) */
  effective: ExternalImportRoots;
  /** Home-relative defaults without custom overrides */
  defaults: ExternalImportRoots;
  customClaude: boolean;
  customCodex: boolean;
};

/** 向导步骤 1：扫描根目录选择（文件选择） */
export const ImportRootsSection: React.FC<{
  roots: ImportRootDisplay;
  busy: boolean;
  onPickClaudeRoot: () => Promise<void>;
  onPickCodexRoot: () => Promise<void>;
  onResetClaudeRoot: () => Promise<void>;
  onResetCodexRoot: () => Promise<void>;
}> = ({
  roots,
  busy,
  onPickClaudeRoot,
  onPickCodexRoot,
  onResetClaudeRoot,
  onResetCodexRoot,
}) => {
  return (
    <div className={styles.importRoots} role="group" aria-label="扫描根目录">
      <div className={styles.importRootRow}>
        <div className={styles.importRootInfo}>
          <span className={styles.importRootLabel}>
            Claude
            {roots.customClaude ? (
              <span className={styles.importRootBadge}>自定义</span>
            ) : (
              <span className={styles.importRootBadgeMuted}>默认</span>
            )}
          </span>
          <Tooltip
            content={
              roots.effective.claudeConfig ||
              roots.defaults.claudeConfig ||
              '（未解析）'
            }
          >
            <span className={styles.importRootPath}>
              {roots.effective.claudeConfig ||
                roots.defaults.claudeConfig ||
                '（未解析）'}
            </span>
          </Tooltip>
        </div>
        <div className={styles.importRootBtns}>
          <Tooltip content="选择非默认的 Claude Code 配置目录（含 projects）">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void onPickClaudeRoot();
              }}
              icon={<Lucide.FolderOpen size={14} aria-hidden />}
            >
              选择 Claude 目录
            </Button>
          </Tooltip>
          {roots.customClaude ? (
            <Tooltip content={`恢复默认：${roots.defaults.claudeConfig}`}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void onResetClaudeRoot();
                }}
              >
                恢复默认
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className={styles.importRootRow}>
        <div className={styles.importRootInfo}>
          <span className={styles.importRootLabel}>
            Codex
            {roots.customCodex ? (
              <span className={styles.importRootBadge}>自定义</span>
            ) : (
              <span className={styles.importRootBadgeMuted}>默认</span>
            )}
          </span>
          <Tooltip
            content={
              roots.effective.codexHome ||
              roots.defaults.codexHome ||
              '（未解析）'
            }
          >
            <span className={styles.importRootPath}>
              {roots.effective.codexHome ||
                roots.defaults.codexHome ||
                '（未解析）'}
            </span>
          </Tooltip>
        </div>
        <div className={styles.importRootBtns}>
          <Tooltip content="选择非默认的 Codex 配置目录（含 sessions）">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void onPickCodexRoot();
              }}
              icon={<Lucide.FolderOpen size={14} aria-hidden />}
            >
              选择 Codex 目录
            </Button>
          </Tooltip>
          {roots.customCodex ? (
            <Tooltip content={`恢复默认：${roots.defaults.codexHome}`}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void onResetCodexRoot();
                }}
              >
                恢复默认
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
};
