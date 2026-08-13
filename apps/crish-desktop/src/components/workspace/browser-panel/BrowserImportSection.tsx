/**
 * 浏览器数据导入区（G-4 收尾 U6：书签/历史/登录态导入 UI，03-方案 §4.2 U6）。
 *
 * 布局（BrowserPanel 内「数据导入」区）：
 * - 书签：文件选择（Chrome Bookmarks JSON——文件按钮 / 拖入 / 路径输入三通道）→
 *   导入按钮 → 统计展示（inserted/skippedDupes + 解析侧报告透传）；
 * - 历史：路径输入（History 库路径）→ 导入 → 统计展示（readTotal/inserted/skippedDupes）；
 * - 登录态：导出（两段确认：① 授权读取对话框——确认后才 authorized=true 实读（§5.2
 *   零副作用）；② 域名清单预览对话框——确认后才「另存为」写盘（§5.4 写盘仅走前端
 *   显式另存为路径））；导入（JSON 粘贴或文件）→ 脱敏统计展示（不含 cookie value）；
 * - 列表：list_bookmarks / list_history 可折叠展示（历史带 limit 控制）。
 *
 * 反馈约定：成功统计行内展示（role="status"，成功文案不打扰 toast——产品禁令）；
 * 仅错误走 toast（onShowToast）。
 *
 * 错误面：invokeTyped 三态——missing（引擎未接线）/ error（结构化 kind/message，
 * tool.browser.not_ready / tool.invalid_input 前缀由 message 透传展示）。
 *
 * 结构（D-01 G-03b 拆分）：业务状态与行为已迁至 `import-hooks/` 四个 hook
 * （useBookmarksImport / useHistoryImport（含列表）/ useStorageImport /
 * useExportAuth），导出两段确认对话框抽为 ExportAuthDialogs 纯展示壳；
 * 本文件仅保留：props + useId + busy 编排 + 派生 + JSX 渲染（UI ≤500 行门禁）。
 */
import React, { useId, useState } from 'react';
import {
  Bookmark,
  Download,
  FileJson,
  History,
  KeyRound,
  Loader2,
  RefreshCw,
  Upload,
} from 'lucide-react';
import styles from './BrowserImportSection.module.css';
import { Button, Input, Tooltip } from '../../ui';
import {
  formatUnixSecTime,
  isUsableJsonText,
} from '../../../api/browserImportLib';
import type { ShowToastFn } from '../../../hooks/useToastQueue';
import { useBookmarksImport } from './import-hooks/useBookmarksImport';
import { useHistoryImport } from './import-hooks/useHistoryImport';
import { useStorageImport } from './import-hooks/useStorageImport';
import { useExportAuth } from './import-hooks/useExportAuth';
import { ExportAuthDialogs } from './ExportAuthDialogs';
import type { BusyKind } from './import-hooks/browserImportShared';

export interface BrowserImportSectionProps {
  onShowToast: ShowToastFn;
  /** 受管浏览器是否运行中：登录态导出/导入需运行中会话（storage 命令不触发惰性启动）。 */
  browserRunning?: boolean;
  /** 测试注入：登录态「另存为」写盘（缺省 downloadTextFile）。 */
  saveExport?: (filename: string, content: string) => void;
}

export const BrowserImportSection: React.FC<BrowserImportSectionProps> = ({
  onShowToast,
  browserRunning = false,
  saveExport,
}) => {
  const baseId = useId();
  const [busy, setBusy] = useState<BusyKind>(null);

  const bookmarks = useBookmarksImport({ busy, setBusy, onShowToast });
  const history = useHistoryImport({ busy, setBusy, onShowToast });
  const storage = useStorageImport({ busy, setBusy, onShowToast });
  const exportAuth = useExportAuth({
    setBusy,
    onShowToast,
    setStorageError: storage.setStorageError,
    saveExport,
  });

  const exportReady = browserRunning && busy !== 'storageExport';
  const storageImportReady =
    browserRunning &&
    isUsableJsonText(storage.storageJson) &&
    busy !== 'storageImport';

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
          aria-label="拖入 Chrome Bookmarks JSON"
          tabIndex={0}
          onDragOver={(e) => e.preventDefault()}
          onDrop={bookmarks.onBookmarksDrop}
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
      <div className={styles.block}>
        <h4 className={styles.blockTitle}>已导入数据</h4>
        <div className={styles.row}>
          <Button
            type="button"
            variant={history.listTab === 'bookmarks' ? 'primary' : 'secondary'}
            size="sm"
            disabled={busy === 'list'}
            onClick={() => {
              void history.toggleList('bookmarks');
            }}
          >
            书签列表{history.listTab === 'bookmarks' ? '（收起）' : ''}
          </Button>
          <Button
            type="button"
            variant={history.listTab === 'history' ? 'primary' : 'secondary'}
            size="sm"
            disabled={busy === 'list'}
            onClick={() => {
              void history.toggleList('history');
            }}
          >
            历史列表{history.listTab === 'history' ? '（收起）' : ''}
          </Button>
          {history.listTab ? (
            <>
              {history.listTab === 'history' ? (
                <Input
                  id={`${baseId}-hist-limit`}
                  label="limit"
                  size="sm"
                  type="number"
                  min={1}
                  value={history.historyLimit}
                  onChange={(e) => history.setHistoryLimit(e.target.value)}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={13} aria-hidden />}
                disabled={busy === 'list'}
                onClick={() => {
                  void history.refreshList();
                }}
              >
                刷新
              </Button>
            </>
          ) : null}
        </div>
        {history.listError ? (
          <p className={styles.error} role="alert">
            {history.listError}
          </p>
        ) : null}
        {history.listTab === 'bookmarks' && history.bookmarkRows !== null ? (
          <div className={styles.listWrap}>
            <p className={styles.listCaption} role="status">
              共 {history.bookmarkRows.length} 条（导入时间倒序）
            </p>
            {history.bookmarkRows.length === 0 ? (
              <p className={styles.listEmpty}>暂无已导入书签</p>
            ) : (
              <ul className={styles.list}>
                {history.bookmarkRows.map((row) => (
                  <li
                    key={`${row.url}\u0000${row.name}`}
                    className={styles.listItem}
                  >
                    <span className={styles.itemName}>{row.name}</span>
                    <span className={styles.itemPath}>
                      {row.folder_path.length > 0
                        ? row.folder_path.join(' / ')
                        : '（顶层）'}
                    </span>
                    <span className={styles.itemUrl}>
                      <code>{row.url}</code>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        {history.listTab === 'history' && history.historyRows !== null ? (
          <div className={styles.listWrap}>
            <p className={styles.listCaption} role="status">
              共 {history.historyRows.length} 条（visited_at 倒序，limit 截断）
            </p>
            {history.historyRows.length === 0 ? (
              <p className={styles.listEmpty}>暂无已导入历史</p>
            ) : (
              <ul className={styles.list}>
                {history.historyRows.map((row) => (
                  <li
                    key={`${row.url}\u0000${row.visited_at}`}
                    className={styles.listItem}
                  >
                    <span className={styles.itemTime}>
                      {formatUnixSecTime(row.visited_at)}
                    </span>
                    <span className={styles.itemName}>
                      {row.title || '（无标题）'}
                    </span>
                    <span className={styles.itemUrl}>
                      <code>{row.url}</code>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

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
