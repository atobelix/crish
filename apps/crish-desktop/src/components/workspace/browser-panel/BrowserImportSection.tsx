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
 */
import React, { useCallback, useId, useRef, useState } from 'react';
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
import { Button, ConfirmDialog, Input, Tooltip } from '../../ui';
import { downloadTextFile } from '../../../api/sessionExport';
import {
  importBookmarks,
  importHistory,
  importStorageState,
  exportStorageState,
  listBookmarks,
  listHistory,
  readTextFileAtPath,
  type BookmarksImportPayload,
  type HistoryImportPayload,
  type ImportedBookmarkRow,
  type ImportedHistoryRow,
  type StorageImportPayload,
} from '../../../api/browserImportApi';
import {
  BROWSER_IMPORT_MAX_BYTES,
  formatUnixSecTime,
  isUsableJsonText,
  parseStorageStatePreview,
  storageStateExportFilename,
  type StorageStatePreview,
} from '../../../api/browserImportLib';
import type { ShowToastFn } from '../../../hooks/useToastQueue';

export interface BrowserImportSectionProps {
  onShowToast: ShowToastFn;
  /** 受管浏览器是否运行中：登录态导出/导入需运行中会话（storage 命令不触发惰性启动）。 */
  browserRunning?: boolean;
  /** 测试注入：登录态「另存为」写盘（缺省 downloadTextFile）。 */
  saveExport?: (filename: string, content: string) => void;
}

type BusyKind =
  | 'bookmarks'
  | 'bookmarksPath'
  | 'history'
  | 'storageExport'
  | 'storageImport'
  | 'list'
  | null;

/** FileReader 文本读取（DOM 面；jsdom 原生支持）。 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsText(file);
  });
}

export const BrowserImportSection: React.FC<BrowserImportSectionProps> = ({
  onShowToast,
  browserRunning = false,
  saveExport,
}) => {
  const baseId = useId();
  const [busy, setBusy] = useState<BusyKind>(null);

  // ── 书签 ──
  const [bookmarksJson, setBookmarksJson] = useState('');
  const [bookmarksFileName, setBookmarksFileName] = useState('');
  const [bookmarksResult, setBookmarksResult] =
    useState<BookmarksImportPayload | null>(null);
  const [bookmarksError, setBookmarksError] = useState('');
  const [bookmarksPath, setBookmarksPath] = useState('');
  const bookmarksFileRef = useRef<HTMLInputElement>(null);

  // ── 历史 ──
  const [historyPath, setHistoryPath] = useState('');
  const [historyResult, setHistoryResult] =
    useState<HistoryImportPayload | null>(null);
  const [historyError, setHistoryError] = useState('');

  // ── 登录态 ──
  const [exportAuthOpen, setExportAuthOpen] = useState(false);
  const [exportPreviewOpen, setExportPreviewOpen] = useState(false);
  const [exportPreview, setExportPreview] =
    useState<StorageStatePreview | null>(null);
  const [exportedJson, setExportedJson] = useState('');
  const [storageError, setStorageError] = useState('');
  const [storageJson, setStorageJson] = useState('');
  const [storageFileName, setStorageFileName] = useState('');
  const [storageResult, setStorageResult] =
    useState<StorageImportPayload | null>(null);
  const storageFileRef = useRef<HTMLInputElement>(null);

  // ── 列表 ──
  const [listTab, setListTab] = useState<'bookmarks' | 'history' | null>(null);
  const [historyLimit, setHistoryLimit] = useState('50');
  const [bookmarkRows, setBookmarkRows] = useState<
    ImportedBookmarkRow[] | null
  >(null);
  const [historyRows, setHistoryRows] = useState<ImportedHistoryRow[] | null>(
    null
  );
  const [listError, setListError] = useState('');

  /** 错误统一出口：行内 role=alert + toast（仅错误走 toast）。 */
  const reportError = useCallback(
    (area: string, prefix: string, msg: string) => {
      const full = `${prefix}${msg}`;
      if (area === 'bookmarks') setBookmarksError(full);
      else if (area === 'history') setHistoryError(full);
      else if (area === 'storage') setStorageError(full);
      else setListError(full);
      onShowToast(full);
    },
    [onShowToast]
  );

  const resultMessage = useCallback(
    (
      res:
        | { status: 'ok' }
        | { status: 'missing' }
        | { status: 'error'; message: string },
      prefix: string
    ): string => {
      if (res.status === 'ok') return '';
      if (res.status === 'missing') return `${prefix}引擎未接线（命令不可用）`;
      return `${prefix}${res.message}`;
    },
    []
  );

  // ── 书签：文件三通道（选择 / 拖入 / 路径读取）共用装载 ──
  const applyBookmarksContent = useCallback(
    async (file: File) => {
      if (file.size > BROWSER_IMPORT_MAX_BYTES) {
        reportError(
          'bookmarks',
          '书签导入失败：',
          `文件超过 ${BROWSER_IMPORT_MAX_BYTES / 1024 / 1024}MB 上限`
        );
        return;
      }
      try {
        const text = await readFileAsText(file);
        setBookmarksJson(text);
        setBookmarksFileName(file.name);
        setBookmarksResult(null);
        setBookmarksError('');
      } catch (err) {
        reportError('bookmarks', '读取书签文件失败：', String(err ?? ''));
      }
    },
    [reportError]
  );

  const onBookmarksFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void applyBookmarksContent(file);
  };

  const onBookmarksDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) void applyBookmarksContent(file);
  };

  const runBookmarksPathRead = async () => {
    if (busy || !bookmarksPath.trim()) return;
    setBusy('bookmarksPath');
    setBookmarksError('');
    try {
      const text = await readTextFileAtPath(bookmarksPath.trim());
      if (text === null) {
        reportError(
          'bookmarks',
          '路径读取不可用：',
          '非 Tauri 环境不支持按路径读取，请用文件选择或拖入'
        );
      } else {
        setBookmarksJson(text);
        setBookmarksFileName(bookmarksPath.trim());
        setBookmarksResult(null);
      }
    } finally {
      setBusy(null);
    }
  };

  const runBookmarksImport = async () => {
    if (busy || !isUsableJsonText(bookmarksJson)) return;
    setBusy('bookmarks');
    setBookmarksError('');
    const res = await importBookmarks(bookmarksJson);
    if (res.status === 'ok') {
      setBookmarksResult(res.data);
    } else {
      reportError('bookmarks', '书签导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  // ── 历史 ──
  const runHistoryImport = async () => {
    if (busy || !historyPath.trim()) return;
    setBusy('history');
    setHistoryError('');
    const res = await importHistory(historyPath.trim());
    if (res.status === 'ok') {
      setHistoryResult(res.data);
    } else {
      reportError('history', '历史导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  // ── 登录态导出：两段确认（① 授权读取 → ② 预览域名清单后确认写盘） ──
  const runExportAuth = async () => {
    setExportAuthOpen(false);
    setBusy('storageExport');
    setStorageError('');
    const res = await exportStorageState(true);
    if (res.status === 'ok') {
      setExportedJson(res.data);
      setExportPreview(parseStorageStatePreview(res.data));
      setExportPreviewOpen(true);
    } else {
      reportError('storage', '登录态导出失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  const runExportSave = () => {
    const filename = storageStateExportFilename();
    const doSave =
      saveExport ??
      ((f: string, c: string) => {
        downloadTextFile(f, c, { mimeType: 'application/json;charset=utf-8' });
      });
    try {
      doSave(filename, exportedJson);
      setExportPreviewOpen(false);
      setExportedJson('');
      setExportPreview(null);
    } catch (err) {
      reportError('storage', '登录态保存失败：', String(err ?? ''));
    }
  };

  // ── 登录态导入 ──
  const onStorageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void applyStorageFile(file);
  };

  const applyStorageFile = async (file: File) => {
    if (file.size > BROWSER_IMPORT_MAX_BYTES) {
      reportError(
        'storage',
        '登录态导入失败：',
        `文件超过 ${BROWSER_IMPORT_MAX_BYTES / 1024 / 1024}MB 上限`
      );
      return;
    }
    try {
      const text = await readFileAsText(file);
      setStorageJson(text);
      setStorageFileName(file.name);
      setStorageResult(null);
      setStorageError('');
    } catch (err) {
      reportError('storage', '读取登录态文件失败：', String(err ?? ''));
    }
  };

  const runStorageImport = async () => {
    if (busy || !isUsableJsonText(storageJson)) return;
    setBusy('storageImport');
    setStorageError('');
    const res = await importStorageState(storageJson);
    if (res.status === 'ok') {
      setStorageResult(res.data);
    } else {
      reportError('storage', '登录态导入失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  // ── 列表（可折叠 + 历史 limit 控制） ──
  const loadList = async (tab: 'bookmarks' | 'history') => {
    setBusy('list');
    if (tab === 'bookmarks') {
      const res = await listBookmarks();
      if (res.status === 'ok') setBookmarkRows(res.data);
      else reportError('list', '书签列表加载失败：', resultMessage(res, ''));
    } else {
      const limit = Math.max(1, Math.floor(Number(historyLimit)) || 50);
      const res = await listHistory(undefined, limit);
      if (res.status === 'ok') setHistoryRows(res.data);
      else reportError('list', '历史列表加载失败：', resultMessage(res, ''));
    }
    setBusy(null);
  };

  const toggleList = async (tab: 'bookmarks' | 'history') => {
    setListError('');
    if (listTab === tab) {
      setListTab(null);
      return;
    }
    setListTab(tab);
    await loadList(tab);
  };

  const refreshList = async () => {
    if (!listTab || busy === 'list') return;
    setListError('');
    await loadList(listTab);
  };

  const exportReady = browserRunning && busy !== 'storageExport';
  const storageImportReady =
    browserRunning && isUsableJsonText(storageJson) && busy !== 'storageImport';

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
            ref={bookmarksFileRef}
            type="file"
            accept=".json,application/json"
            className={styles.hiddenFileInput}
            data-testid="bookmarks-file-input"
            onChange={onBookmarksFileChange}
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            icon={<FileJson size={14} aria-hidden />}
            disabled={busy !== null}
            onClick={() => bookmarksFileRef.current?.click()}
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
            disabled={busy !== null || !isUsableJsonText(bookmarksJson)}
            loading={busy === 'bookmarks'}
            onClick={() => {
              void runBookmarksImport();
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
          onDrop={onBookmarksDrop}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              bookmarksFileRef.current?.click();
            }
          }}
        >
          {bookmarksFileName ? (
            <span className={styles.fileLoaded}>
              已装载：<code>{bookmarksFileName}</code>
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
            value={bookmarksPath}
            onChange={(e) => setBookmarksPath(e.target.value)}
            clearable
            hint="非 Tauri 环境不支持路径读取，请用文件选择或拖入"
          />
          <Tooltip content="按路径读取文件内容（需 Tauri 环境）">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy !== null || !bookmarksPath.trim()}
              loading={busy === 'bookmarksPath'}
              onClick={() => {
                void runBookmarksPathRead();
              }}
            >
              读取路径
            </Button>
          </Tooltip>
        </div>
        {bookmarksError ? (
          <p className={styles.error} role="alert">
            {bookmarksError}
          </p>
        ) : null}
        {bookmarksResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            新增 {bookmarksResult.inserted} 条，跳过{' '}
            {bookmarksResult.skippedDupes} 条（此前已导入）；解析{' '}
            {bookmarksResult.parsedItems} 条
            {bookmarksResult.skippedInvalid > 0
              ? `，无效跳过 ${bookmarksResult.skippedInvalid}`
              : ''}
            {bookmarksResult.depthCutoff > 0
              ? `，深度超限 ${bookmarksResult.depthCutoff}`
              : ''}
            {bookmarksResult.droppedDupes > 0
              ? `，解析去重 ${bookmarksResult.droppedDupes}`
              : ''}
            {bookmarksResult.truncated > 0
              ? `，截断 ${bookmarksResult.truncated}`
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
            value={historyPath}
            onChange={(e) => setHistoryPath(e.target.value)}
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
            disabled={busy !== null || !historyPath.trim()}
            loading={busy === 'history'}
            onClick={() => {
              void runHistoryImport();
            }}
          >
            导入历史
          </Button>
        </div>
        {historyError ? (
          <p className={styles.error} role="alert">
            {historyError}
          </p>
        ) : null}
        {historyResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            新增 {historyResult.inserted} 条，跳过 {historyResult.skippedDupes}{' '}
            条（此前已导入）；读取 {historyResult.readTotal} 条
            {historyResult.skippedInvalidUrl > 0
              ? `，无效 URL 跳过 ${historyResult.skippedInvalidUrl}`
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
              onClick={() => setExportAuthOpen(true)}
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
            onClick={() => storageFileRef.current?.click()}
          >
            选择文件
          </Button>
          <input
            ref={storageFileRef}
            type="file"
            accept=".json,application/json"
            className={styles.hiddenFileInput}
            data-testid="storage-file-input"
            onChange={onStorageFileChange}
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
              void runStorageImport();
            }}
          >
            导入登录态
          </Button>
        </div>
        <textarea
          id={`${baseId}-storage-json`}
          className={styles.textarea}
          placeholder="粘贴标准 storage_state JSON（Playwright 兼容 { cookies, origins }）"
          value={storageJson}
          onChange={(e) => {
            setStorageJson(e.target.value);
            setStorageResult(null);
          }}
          rows={3}
        />
        {storageFileName ? (
          <p className={styles.fileLoaded}>
            已装载文件：<code>{storageFileName}</code>
          </p>
        ) : null}
        {storageError ? (
          <p className={styles.error} role="alert">
            {storageError}
          </p>
        ) : null}
        {storageResult ? (
          <p className={styles.stats} role="status" aria-live="polite">
            cookies {storageResult.cookies} · origins {storageResult.origins} ·
            localStorage {storageResult.localStorageItems} 条（直写{' '}
            {storageResult.injectedItems}，脚本 {storageResult.injectedScripts}
            ）
            {storageResult.droppedDupes > 0
              ? ` · 去重丢弃 ${storageResult.droppedDupes}`
              : ''}
            {storageResult.skippedEmptyName > 0
              ? ` · 空名跳过 ${storageResult.skippedEmptyName}`
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
            variant={listTab === 'bookmarks' ? 'primary' : 'secondary'}
            size="sm"
            disabled={busy === 'list'}
            onClick={() => {
              void toggleList('bookmarks');
            }}
          >
            书签列表{listTab === 'bookmarks' ? '（收起）' : ''}
          </Button>
          <Button
            type="button"
            variant={listTab === 'history' ? 'primary' : 'secondary'}
            size="sm"
            disabled={busy === 'list'}
            onClick={() => {
              void toggleList('history');
            }}
          >
            历史列表{listTab === 'history' ? '（收起）' : ''}
          </Button>
          {listTab ? (
            <>
              {listTab === 'history' ? (
                <Input
                  id={`${baseId}-hist-limit`}
                  label="limit"
                  size="sm"
                  type="number"
                  min={1}
                  value={historyLimit}
                  onChange={(e) => setHistoryLimit(e.target.value)}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon={<RefreshCw size={13} aria-hidden />}
                disabled={busy === 'list'}
                onClick={() => {
                  void refreshList();
                }}
              >
                刷新
              </Button>
            </>
          ) : null}
        </div>
        {listError ? (
          <p className={styles.error} role="alert">
            {listError}
          </p>
        ) : null}
        {listTab === 'bookmarks' && bookmarkRows !== null ? (
          <div className={styles.listWrap}>
            <p className={styles.listCaption} role="status">
              共 {bookmarkRows.length} 条（导入时间倒序）
            </p>
            {bookmarkRows.length === 0 ? (
              <p className={styles.listEmpty}>暂无已导入书签</p>
            ) : (
              <ul className={styles.list}>
                {bookmarkRows.map((row) => (
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
        {listTab === 'history' && historyRows !== null ? (
          <div className={styles.listWrap}>
            <p className={styles.listCaption} role="status">
              共 {historyRows.length} 条（visited_at 倒序，limit 截断）
            </p>
            {historyRows.length === 0 ? (
              <p className={styles.listEmpty}>暂无已导入历史</p>
            ) : (
              <ul className={styles.list}>
                {historyRows.map((row) => (
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
      <ConfirmDialog
        open={exportAuthOpen}
        title="授权读取登录态"
        description={
          <>
            将读取受管浏览器会话的 cookie（<strong>仅内存传递，不写盘</strong>
            ；含 cookie value 明文，请勿泄露至日志）。确认后先展示域名清单预览，
            由你再次确认后才导出文件。未授权不会执行读取（零副作用）。
          </>
        }
        confirmLabel="继续读取"
        cancelLabel="取消"
        disabled={busy === 'storageExport'}
        onConfirm={() => {
          void runExportAuth();
        }}
        onCancel={() => setExportAuthOpen(false)}
      />
      <ConfirmDialog
        open={exportPreviewOpen}
        title="确认导出登录态"
        description={
          exportPreview ? (
            <>
              将导出 {exportPreview.cookieCount} 条 cookie
              {exportPreview.origins > 0
                ? `、${exportPreview.origins} 个 origin`
                : ''}
              ，涉及域名：
              <code className={styles.domainList}>
                {exportPreview.domains.length > 0
                  ? exportPreview.domains.join('、')
                  : '（无）'}
              </code>
              。导出文件含 cookie value 明文，请谨慎保管；保存位置由「另存为」
              对话框决定（不自动写盘）。
            </>
          ) : (
            '导出内容为空（未读取到 cookie）。'
          )
        }
        confirmLabel="确认导出"
        cancelLabel="取消"
        disabled={busy === 'storageExport'}
        onConfirm={runExportSave}
        onCancel={() => {
          setExportPreviewOpen(false);
          setExportPreview(null);
          setExportedJson('');
        }}
      />
    </section>
  );
};
