/**
 * 浏览器数据与凭据管理组件（系统一级设置规范终极重塑）
 * 正本清源：彻底清退私造样式与非标准区块，全面对齐系统 SettingsRow 与单原子操作
 */
import React, { useState } from 'react';
import {
  Bookmark,
  Download,
  History,
  KeyRound,
} from 'lucide-react';
import styles from './BrowserImportSection.module.css';
import { Button, Tooltip } from '../../ui';
import { useBookmarksImport } from './import-hooks/useBookmarksImport';
import { useHistoryImport } from './import-hooks/useHistoryImport';
import { useStorageImport } from './import-hooks/useStorageImport';
import { useExportAuth } from './import-hooks/useExportAuth';
import { ExportAuthDialogs } from './ExportAuthDialogs';
import { SettingsCard, SettingsRow, SettingsSection } from '../../settings/SettingsUI';
import type { BusyKind } from './import-hooks/browserImportShared';

export interface BrowserImportSectionProps {
  /** 浏览器是否运行中：登录态导出/导入需运行中会话。 */
  browserRunning?: boolean;
  /** 测试注入：登录态「另存为」写盘（缺省 downloadTextFile）。 */
  saveExport?: (filename: string, content: string) => void;
  /** 外部传入通知 toast 回调。 */
  onShowToast?: (message: string) => void;
}

export const BrowserImportSection: React.FC<BrowserImportSectionProps> = ({
  browserRunning = false,
  saveExport,
  onShowToast,
}) => {
  const [busy, setBusy] = useState<BusyKind>(null);

  const bookmarks = useBookmarksImport({ busy, setBusy, onShowToast });
  const history = useHistoryImport({ busy, setBusy, onShowToast });
  const storage = useStorageImport({ busy, setBusy, onShowToast });
  const exportAuth = useExportAuth({
    setBusy,
    setStorageError: storage.setStorageError,
    saveExport,
    onShowToast,
  });

  const exportReady = browserRunning && busy !== 'storageExport';

  // 自动装载并执行书签导入
  const handleBookmarksFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      void bookmarks.importBookmarksFile(file);
    }
  };

  // 自动装载并执行登录态导入
  const handleStorageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) {
      void storage.importStorageFile(file);
    }
  };

  return (
    <div className={styles.container} aria-label="浏览器数据管理">
      <SettingsSection title="数据导入">
        <SettingsCard>
          <SettingsRow
            icon={<Bookmark size={16} strokeWidth={1.75} />}
            title="书签"
            desc="导入 Chrome 书签文件"
            control={
              <>
                <input
                  ref={bookmarks.bookmarksFileRef}
                  type="file"
                  accept=".json,application/json"
                  className={styles.hiddenFileInput}
                  data-testid="bookmarks-file-input"
                  onChange={handleBookmarksFileChange}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label="导入书签"
                  disabled={busy !== null}
                  loading={busy === 'bookmarks'}
                  onClick={() => bookmarks.bookmarksFileRef.current?.click()}
                >
                  导入
                </Button>
              </>
            }
          />

          <SettingsRow
            icon={<History size={16} strokeWidth={1.75} />}
            title="浏览历史"
            desc="导入本地 Chrome 历史记录"
            control={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label="导入历史"
                disabled={busy !== null}
                loading={busy === 'history'}
                onClick={() => {
                  void history.runHistoryImport();
                }}
              >
                导入
              </Button>
            }
          />

          <SettingsRow
            icon={<KeyRound size={16} strokeWidth={1.75} />}
            title="登录态"
            desc="导入浏览器会话凭据"
            control={
              <>
                <input
                  ref={storage.storageFileRef}
                  type="file"
                  accept=".json,application/json"
                  className={styles.hiddenFileInput}
                  data-testid="storage-file-input"
                  onChange={handleStorageFileChange}
                />
                <Tooltip
                  content={
                    browserRunning
                      ? '导入会话 Cookies 与 Storage 凭据'
                      : '需先启动浏览器会话'
                  }
                >
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    aria-label="导入登录态"
                    disabled={busy !== null || !browserRunning}
                    loading={busy === 'storageImport'}
                    onClick={() => storage.storageFileRef.current?.click()}
                  >
                    导入
                  </Button>
                </Tooltip>
              </>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="凭据备份">
        <SettingsCard>
          <SettingsRow
            icon={<Download size={16} strokeWidth={1.75} />}
            title="导出登录态"
            desc="备份当前浏览器会话凭据"
            control={
              <Tooltip
                content={
                  browserRunning
                    ? '导出当前会话 Cookies 与 Storage 凭据'
                    : '需先启动浏览器会话'
                }
              >
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label="导出登录态"
                  disabled={!exportReady}
                  loading={busy === 'storageExport'}
                  onClick={() => exportAuth.setExportAuthOpen(true)}
                >
                  导出
                </Button>
              </Tooltip>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <ExportAuthDialogs
        busy={busy}
        exportAuthOpen={exportAuth.exportAuthOpen}
        setExportAuthOpen={exportAuth.setExportAuthOpen}
        exportPreviewOpen={exportAuth.exportPreviewOpen}
        setExportPreviewOpen={exportAuth.setExportPreviewOpen}
        exportPreview={exportAuth.exportPreview}
        setExportPreview={exportAuth.setExportPreview}
        setExportedJson={exportAuth.setExportedJson}
        runExportAuth={exportAuth.runExportAuth}
        runExportSave={exportAuth.runExportSave}
      />
    </div>
  );
};
