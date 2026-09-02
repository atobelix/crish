/**
 * 浏览器数据导入区（现代化重构产物）
 * 彻底清退刺眼高饱和绿块，统一收敛至标准 Button / Input / Token 规范
 */
import React, { useId, useRef, useState } from 'react';
import {
  Bookmark,
  Download,
  FileJson,
  History,
  KeyRound,
  Loader2,
  Upload,
} from 'lucide-react';
import styles from './BrowserImportSection.module.css';
import { Button, Input, Tooltip } from '../../ui';
import { isUsableJsonText } from '../../../api/browserImportLib';
import { useBookmarksImport } from './import-hooks/useBookmarksImport';
import { useHistoryImport } from './import-hooks/useHistoryImport';
import { useStorageImport } from './import-hooks/useStorageImport';
import { useExportAuth } from './import-hooks/useExportAuth';
import { ExportAuthDialogs } from './ExportAuthDialogs';
import { ImportedListBlock } from './ImportedListBlock';
import type { BusyKind } from './import-hooks/browserImportShared';

export interface BrowserImportSectionProps {
  /** 受管浏览器是否运行中：登录态导出/导入需运行中会话（storage 命令不触发惰性启动）。 */
  browserRunning?: boolean;
  /** 测试注入：登录态「另存为」写盘（缺省 downloadTextFile）。 */
  saveExport?: (filename: string, content: string) => void;
  /** 外部传入错误 toast 回调。 */
  onShowToast?: (message: string) => void;
}

export const BrowserImportSection: React.FC<BrowserImportSectionProps> = ({
  browserRunning = false,
  saveExport,
  onShowToast,
}) => {
  const baseId = useId();
  const [busy, setBusy] = useState<BusyKind>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

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
  const storageImportReady =
    browserRunning &&
    isUsableJsonText(storage.storageJson) &&
    busy !== 'storageImport';

  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) {
      setIsDragging(true);
    }
  };

  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setIsDragging(false);
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  };

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);
    bookmarks.onBookmarksDrop(e);
  };

  return (
    <section className={styles.section} aria-label="数据导入">
      <header className={styles.header}>
        <span className={styles.title}>数据导入</span>
        <span className={styles.hint}>
          书签/历史落库本机（幂等：重复导入自动跳过）；登录态仅注入受管浏览器会话
        </span>
      </header>

      {/* ── 书签 ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>
          <Bookmark size={13} strokeWidth={1.75} aria-hidden /> 书签
        </h4>
        <div className={styles.row}>
          <input
            ref={bookmarks.bookmarksFileRef}
            type="file"
            accept=".json,application/json"
            className={styles.hiddenFileInput}
            data-testid="bookmarks-file-input"
            onChange={bookmarks.onBookmarksFileChange}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<FileJson size={14} aria-hidden />}
            disabled={busy !== null}
            onClick={() => bookmarks.bookmarksFileRef.current?.click()}
          >
            选择文件
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon={
              busy === 'bookmarks' ? (
                <Loader2 size={14} aria-hidden className={styles.spin} />
              ) : (
                <Upload size={14} aria-hidden />
              )
            }
            disabled={
              busy !== null || !isUsableJsonText(bookmarks.bookmarksJson)
            }
            loading={busy === 'bookmarks'}
            onClick={() => {
              void bookmarks.runBookmarksImport();
            }}
          >
            导入书签
          </Button>
        </div>
        <div
          className={styles.dropZone}
          role="button"
          aria-label={
            bookmarks.bookmarksFileName
              ? `已装载：${bookmarks.bookmarksFileName}`
              : '拖入 Chrome Bookmarks JSON'
          }
          data-dragging={isDragging ? 'true' : undefined}
          tabIndex={0}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              bookmarks.bookmarksFileRef.current?.click();
            }
          }}
        >
          {bookmarks.bookmarksFileName ? (
            <span className={styles.fileLoaded}>
              已装载：<code>{bookmarks.bookmarksFileName}</code>
            </span>
          ) : (
            <span>
              将 Chrome Bookmarks JSON 拖入此处（或点上方「选择文件」）
            </span>
          )}
        </div>
        <div className={styles.row}>
          <Input
            id={`${baseId}-bm-path`}
            label="或输入文件路径"
            size="sm"
            placeholder="C:\Users\…\Bookmarks"
            value={bookmarks.bookmarksPath}
            onChange={(e) => bookmarks.setBookmarksPath(e.target.value)}
            clearable
            hint="非 Tauri 环境不支持路径读取，请用文件选择或拖入"
          />
          <Tooltip content="按路径读取文件内容（需 Tauri 环境）">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null || !bookmarks.bookmarksPath.trim()}
              loading={busy === 'bookmarksPath'}
              onClick={() => {
                void bookmarks.runBookmarksPathRead();
              }}
            >
              读取路径
            </Button>
          </Tooltip>
        </div>
        {bookmarks.bookmarksError ? (
          <p className={styles.error} role="alert">
            {bookmarks.bookmarksError}
          </p>
        ) : null}
        {bookmarks.bookmarksResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            新增 {bookmarks.bookmarksResult.inserted} 条，跳过{' '}
            {bookmarks.bookmarksResult.skippedDupes} 条（此前已导入）；解析{' '}
            {bookmarks.bookmarksResult.parsedItems} 条
            {bookmarks.bookmarksResult.skippedInvalid > 0
              ? `，无效跳过 ${bookmarks.bookmarksResult.skippedInvalid}`
              : ''}
            {bookmarks.bookmarksResult.depthCutoff > 0
              ? `，深度超限 ${bookmarks.bookmarksResult.depthCutoff}`
              : ''}
            {bookmarks.bookmarksResult.droppedDupes > 0
              ? `，解析去重 ${bookmarks.bookmarksResult.droppedDupes}`
              : ''}
            {bookmarks.bookmarksResult.truncated > 0
              ? `，截断 ${bookmarks.bookmarksResult.truncated}`
              : ''}
          </p>
        ) : null}
      </div>

      {/* ── 历史 ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>
          <History size={13} strokeWidth={1.75} aria-hidden /> 历史
        </h4>
        <div className={styles.row}>
          <Input
            id={`${baseId}-hist-path`}
            label="History 库路径"
            size="sm"
            placeholder="C:\Users\…\AppData\Local\Google\Chrome\User Data\Default\History"
            value={history.historyPath}
            onChange={(e) => history.setHistoryPath(e.target.value)}
            clearable
            hint="只读读取最近 90 天 / 上限 1000 条；来源浏览器须已关闭"
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon={
              busy === 'history' ? (
                <Loader2 size={14} aria-hidden className={styles.spin} />
              ) : (
                <Upload size={14} aria-hidden />
              )
            }
            disabled={busy !== null || !history.historyPath.trim()}
            loading={busy === 'history'}
            onClick={() => {
              void history.runHistoryImport();
            }}
          >
            导入历史
          </Button>
        </div>
        {history.historyError ? (
          <p className={styles.error} role="alert">
            {history.historyError}
          </p>
        ) : null}
        {history.historyResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            新增 {history.historyResult.inserted} 条，跳过{' '}
            {history.historyResult.skippedDupes} 条（此前已导入）；读取{' '}
            {history.historyResult.readTotal} 条
            {history.historyResult.skippedInvalidUrl > 0
              ? `，无效 URL 跳过 ${history.historyResult.skippedInvalidUrl}`
              : ''}
          </p>
        ) : null}
      </div>

      {/* ── 登录态 ── */}
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>
          <KeyRound size={13} strokeWidth={1.75} aria-hidden /> 登录态
        </h4>
        <div className={styles.row}>
          <Tooltip
            content={
              browserRunning
                ? '读取受管浏览器 cookie（需授权确认）'
                : '需先启动浏览器会话'
            }
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              icon={
                busy === 'storageExport' ? (
                  <Loader2 size={14} aria-hidden className={styles.spin} />
                ) : (
                  <Download size={14} aria-hidden />
                )
              }
              disabled={!exportReady}
              loading={busy === 'storageExport'}
              onClick={() => exportAuth.setExportAuthOpen(true)}
            >
              导出登录态
            </Button>
          </Tooltip>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<FileJson size={14} aria-hidden />}
            disabled={busy !== null || !browserRunning}
            onClick={() => storage.storageFileRef.current?.click()}
          >
            选择文件
          </Button>
          <input
            ref={storage.storageFileRef}
            type="file"
            accept=".json,application/json"
            className={styles.hiddenFileInput}
            data-testid="storage-file-input"
            onChange={storage.onStorageFileChange}
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon={
              busy === 'storageImport' ? (
                <Loader2 size={14} aria-hidden className={styles.spin} />
              ) : (
                <Upload size={14} aria-hidden />
              )
            }
            disabled={!storageImportReady}
            loading={busy === 'storageImport'}
            onClick={() => {
              void storage.runStorageImport();
            }}
          >
            导入登录态
          </Button>
        </div>
        <textarea
          id={`${baseId}-storage-json`}
          className={styles.textarea}
          aria-label="粘贴标准 storage_state JSON（Playwright 兼容 { cookies, origins }）"
          placeholder="粘贴标准 storage_state JSON（Playwright 兼容 { cookies, origins }）"
          value={storage.storageJson}
          onChange={(e) => {
            storage.setStorageJson(e.target.value);
            storage.setStorageResult(null);
          }}
          rows={3}
        />
        {storage.storageFileName ? (
          <p className={styles.fileLoaded}>
            已装载文件：<code>{storage.storageFileName}</code>
          </p>
        ) : null}
        {storage.storageError ? (
          <p className={styles.error} role="alert">
            {storage.storageError}
          </p>
        ) : null}
        {storage.storageResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            cookies {storage.storageResult.cookies} · origins{' '}
            {storage.storageResult.origins} · localStorage{' '}
            {storage.storageResult.localStorageItems} 条（直写{' '}
            {storage.storageResult.injectedItems}，脚本{' '}
            {storage.storageResult.injectedScripts}）
            {storage.storageResult.droppedDupes > 0
              ? ` · 去重丢弃 ${storage.storageResult.droppedDupes}`
              : ''}
            {storage.storageResult.skippedEmptyName > 0
              ? ` · 空名跳过 ${storage.storageResult.skippedEmptyName}`
              : ''}
          </p>
        ) : null}
      </div>

      {/* ── 列表 ── */}
      <ImportedListBlock
        busy={busy}
        baseId={baseId}
        list={history}
      />

      {/* ── 导出两段确认对话框 ── */}
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
    </section>
  );
};
