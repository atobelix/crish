/**
 * 设置 · 状态诊断（PE-04 T04.5-2：core_get_status 诊断段前端面板）。
 *
 * 只读面板（T-F 06 T2.5 例外：搜索索引行在未就绪时提供「重建索引」按钮，
 * 经 rustCore.rebuildSearchIndex 调 core_rebuild_search_index，M7 入口）：
 * - 子系统就绪：engineReady / dbReady / searchIndexReady
 * - 日志配置：logLevel / logDir
 * - 最近错误：lastError（{kind, detail, ts}，醒目提示 + 复制）
 * - 最近诊断：diagnostics（{ts, level, message}，最新在前）
 *
 * 获取失败 / 状态异常时醒目提示。自动轮询（pollIntervalMs，默认 5s）。
 * 不写 store、不重构设置面板整体（P3 分层前沿用 SettingsUI 现有样式）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, ClipboardCopy, RefreshCw, SearchCheck } from 'lucide-react';
import { useToast } from '../../services/toast/ToastContext';
import {
  fetchEngineStatus,
  type EngineDiagnosticEntry,
  type EngineLastErrorEntry,
  type EngineStatus,
} from '../../api/engineConfig';
import { rebuildSearchIndex } from '../../api/rustCore';
import { SettingsCard, SettingsPage, SettingsRow, SettingsSection } from './SettingsUI';
import { Button, Tooltip } from '../ui';
import styles from './StatusDiagnosticsPanel.module.css';

type Props = {
  /** 轮询间隔（ms）；测试可注入大值只取首拉 */
  pollIntervalMs?: number;
  onBlockingOverlayChange?: (open: boolean) => void;
};

/** 复制到剪贴板（best-effort：clipboard API → execCommand 兜底） */
async function copyTextBestEffort(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 走 execCommand 兜底 */
  }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 时间戳 → 本地时间短串（epoch ms；非法值回退 '—'） */
function formatTs(ts: number | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ts);
  }
}

/** 级别徽标文本（未知级别回退大写原文） */
function levelLabel(level: string): string {
  const n = (level || '').toLowerCase();
  if (n === 'debug') return 'DEBUG';
  if (n === 'info') return 'INFO';
  if (n === 'warn' || n === 'warning') return 'WARN';
  if (n === 'error') return 'ERROR';
  return (level || '?').toUpperCase();
}

/** 子系统就绪行（true → OK；false → 异常徽标 + 醒目提示） */
function SubsystemRow({
  label,
  ready,
  readyLabel,
}: {
  label: string;
  ready: boolean | undefined;
  readyLabel: string;
}) {
  const known = typeof ready === 'boolean';
  return (
    <SettingsRow
      title={label}
      desc={known ? (ready ? '已就绪' : '未就绪（可能影响功能）') : '状态未知'}
      control={
        <span
          className={known && ready ? styles.badgeOk : styles.badgeBad}
          role="status"
          data-testid={`diag-${readyLabel}`}
        >
          {known && ready ? 'OK' : known ? '异常' : '未知'}
        </span>
      }
    />
  );
}

/**
 * 状态诊断面板：四区（子系统就绪 / 日志配置 / 最近错误 / 最近诊断）。
 * 错误时醒目提示；面板自身不写任何状态。
 */
export const StatusDiagnosticsPanel: React.FC<Props> = ({
  pollIntervalMs = 5_000,
}) => {
  const { showToast: _showToast } = useToast();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await fetchEngineStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setFetchError(next.ok ? null : next.error ?? '核心状态获取失败');
    } catch (e) {
      if (!mountedRef.current) return;
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const timer = setInterval(() => {
      void load();
    }, pollIntervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [load, pollIntervalMs]);

  const handleCopy = useCallback(
    async (err: EngineLastErrorEntry) => {
      const text = `[${err.kind}] ${err.detail}`;
      const ok = await copyTextBestEffort(text);
      if (ok) showToast('已复制错误信息');
      else showToast('复制失败');
    },
    [showToast],
  );

  /**
   * 重建搜索索引（T-F 06 T2.5 / M7 入口）：调 rustCore.rebuildSearchIndex
   * （core_rebuild_search_index），成功后刷新状态（诚实等待 searchIndexReady
   * 反映重建结果）；失败保留原状态，按钮可重试。组件本地状态，不依赖
   * 已退役的 rustCoreStore（批次 5 D8 删除，此处注释随批清理）。
   */
  const handleRebuild = useCallback(async () => {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      const ok = await rebuildSearchIndex();
      if (!mountedRef.current) return;
      if (ok) {
        showToast('已触发搜索索引重建');
        await load();
      } else {
        showToast('重建失败：索引命令不可用或报错');
      }
    } catch {
      if (mountedRef.current) showToast('重建失败');
    } finally {
      if (mountedRef.current) setRebuilding(false);
    }
  }, [rebuilding, showToast, load]);

  const lastError = status?.lastError ?? null;
  const diagnostics: EngineDiagnosticEntry[] = status?.diagnostics ?? [];
  // 最新在前（Rust 侧缓冲最旧在前）
  const recentDiags = [...diagnostics].reverse();

  return (
    <SettingsPage
      title="状态诊断"
      meta={
        <Tooltip content={fetchError ? '获取核心状态失败' : '自动轮询中'}>
          <span className={styles.pageMeta}>
            <span
              className={fetchError ? styles.connBad : styles.connOk}
              role="status"
              data-testid="diag-connection"
            >
              {fetchError ? '连接异常' : '在线'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() => void load()}
              aria-label="刷新状态诊断"
              icon={<RefreshCw size={14} strokeWidth={1.75} className={refreshing ? styles.spin : undefined} />}
            >
              刷新
            </Button>
          </span>
        </Tooltip>
      }
    >
      {fetchError ? (
        <div className={styles.errorBanner} role="alert" data-testid="diag-error-banner">
          <AlertTriangle size={16} strokeWidth={1.75} aria-hidden />
          <div className={styles.errorBannerBody}>
            <strong>无法获取核心状态</strong>
            <span>{fetchError}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void load()}
          >
            重试
          </Button>
        </div>
      ) : null}

      <SettingsSection title="子系统就绪">
        <SettingsCard>
          <SubsystemRow label="引擎（session-loop）" ready={status?.engineReady} readyLabel="engineReady" />
          <SubsystemRow label="会话数据库" ready={status?.dbReady} readyLabel="dbReady" />
          <SettingsRow
            title="搜索索引"
            desc={
              status?.searchIndexReady
                ? '已就绪'
                : typeof status?.searchIndexReady === 'boolean'
                  ? '未就绪（可能影响功能）'
                  : '状态未知'
            }
            control={
              <span
                className={status?.searchIndexReady ? styles.badgeOk : styles.badgeBad}
                role="status"
                data-testid="diag-searchIndexReady"
              >
                {status?.searchIndexReady ? 'OK' : typeof status?.searchIndexReady === 'boolean' ? '异常' : '未知'}
              </span>
            }
          />
          {status?.searchIndexReady === false ? (
            <SettingsRow
              title="重建索引"
              desc="索引未就绪时触发重建（core_rebuild_search_index）"
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={rebuilding}
                  onClick={() => void handleRebuild()}
                  data-testid="diag-rebuild-search-index"
                  icon={<SearchCheck size={14} strokeWidth={1.75} />}
                >
                  {rebuilding ? '重建中…' : '重建索引'}
                </Button>
              }
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="日志配置">
        <SettingsCard>
          <SettingsRow
            icon={<Activity size={18} strokeWidth={1.75} />}
            title="当前日志级别"
            desc="日志文件与状态面板共用的过滤级别"
            control={
              <span className={styles.monoBadge} role="status" data-testid="diag-log-level">
                {status?.logLevel ?? '—'}
              </span>
            }
          />
          <SettingsRow
            title="日志目录"
            desc="日志文件落盘位置（可在文件管理器中查看）"
            control={
              <Tooltip content={status?.logDir ?? '未知'}>
                <span className={styles.monoEllipsis} data-testid="diag-log-dir">
                  {status?.logDir ?? '—'}
                </span>
              </Tooltip>
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="最近错误">
        <SettingsCard>
          {lastError ? (
            <div className={styles.lastError} role="alert" data-testid="diag-last-error">
              <div className={styles.lastErrorHead}>
                <span className={styles.lastErrorKind}>{lastError.kind}</span>
                <span className={styles.lastErrorTs}>{formatTs(lastError.ts)}</span>
                <Tooltip content="复制错误信息">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="复制错误信息"
                    onClick={() => void handleCopy(lastError)}
                    icon={<ClipboardCopy size={14} strokeWidth={1.75} />}
                  >
                    复制
                  </Button>
                </Tooltip>
              </div>
              <pre className={styles.lastErrorDetail}>{lastError.detail}</pre>
            </div>
          ) : (
            <div className={styles.noError} role="status" data-testid="diag-no-error">
              <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden />
              无错误记录
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="最近诊断">
        <SettingsCard>
          {recentDiags.length === 0 ? (
            <div className={styles.noError} role="status" data-testid="diag-no-diagnostics">
              暂无诊断记录
            </div>
          ) : (
            <ul className={styles.diagList} aria-label="最近诊断条目" data-testid="diag-list">
              {recentDiags.map((d, i) => (
                <li key={`${d.ts}-${i}`} className={styles.diagItem}>
                  <span
                    className={`${styles.diagLevel} ${styles[`diagLevel_${(d.level || '').toLowerCase()}`] ?? ''}`}
                    role="status"
                  >
                    {levelLabel(d.level)}
                  </span>
                  <span className={styles.diagTs}>{formatTs(d.ts)}</span>
                  <span className={styles.diagMsg}>{d.message}</span>
                </li>
              ))}
            </ul>
          )}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
};
