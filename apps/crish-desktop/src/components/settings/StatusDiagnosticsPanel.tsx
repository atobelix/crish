/**
 * 设置 · 状态诊断（PE-04 T04.5-2：core_get_status 诊断段前端面板）。
 *
 * 只读面板（T-F 06 T2.5 例外：搜索索引行在未就绪时提供「重建索引」按钮，
 * 经 rustCore.rebuildSearchIndex 调 core_rebuild_search_index，M7 入口）：
 * - 子系统就绪：engineReady / dbReady / searchIndexReady / 日志目录，
 *   开发者模式下另有「核心连接」测试行（R2 自账号页迁入，文案归
 *   settings.diagnostics.* 命名空间，R7 收编）
 * - 最近错误：lastError（{kind, detail, ts}，醒目提示 + 复制）
 * - 最近诊断：diagnostics（{ts, level, message}，最新在前，统一 SettingsRow 口径）
 *
 * 获取失败 / 状态异常时醒目提示。自动轮询（pollIntervalMs，默认 5s）。
 * 不写 store、不重构设置面板整体（P3 分层前沿用 SettingsUI 现有样式）。
 * 全页文案走 settings.diagnostics.*（R7 整页 i18n）。
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useToast } from '../../services/toast/ToastContext';
import {
  fetchEngineStatus,
  type EngineDiagnosticEntry,
  type EngineLastErrorEntry,
  type EngineStatus,
} from '../../api/engineConfig';
import { rebuildSearchIndex } from '../../api/rustCore';
import { ensureEngineConnected } from '../../api/chatBridge';
import { getTransport } from '../../api/transport';
import { isDeveloperEngineUiEnabled } from '../../api/productMode';
import { networkUserMessage } from '../../api/userFacingErrors';
import { useI18n } from '../../i18n';
import {
  SettingsCard,
  SettingsEmpty,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from './SettingsUI';
import { Button, Tooltip } from '@/components/ui';
import styles from './StatusDiagnosticsPanel.module.css';
import { AppIcon } from '@/components/ui/icons';
import { copyTextToClipboard } from '@crish/shared-utils';

type Props = {
  /** 轮询间隔（ms）；测试可注入大值只取首拉 */
  pollIntervalMs?: number;
  onBlockingOverlayChange?: (open: boolean) => void;
};

/** 时间戳 → 本地时间短串（epoch ms；非法值回退 '—'，locale 随界面语言） */
function formatTs(ts: number | undefined, locale: string): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return '—';
  try {
    return new Date(ts).toLocaleString(locale, { hour12: false });
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
  const { t } = useI18n();
  const known = typeof ready === 'boolean';
  return (
    <SettingsRow
      title={label}
      control={
        <span
          className={known && ready ? styles.badgeOk : styles.badgeBad}
          role="status"
          data-testid={`diag-${readyLabel}`}
        >
          {known && ready
            ? t('settings.diagnostics.badgeOk', 'OK')
            : known
              ? t('settings.diagnostics.badgeAbnormal', '异常')
              : t('settings.diagnostics.badgeUnknown', '未知')}
        </span>
      }
    />
  );
}

/**
 * 状态诊断面板：三区（子系统就绪 / 最近错误 / 最近诊断）。
 * 错误时醒目提示；面板自身不写任何状态。
 */
export const StatusDiagnosticsPanel: React.FC<Props> = ({
  pollIntervalMs = 5_000,
}) => {
  const { showToast } = useToast();
  const { t, language } = useI18n();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const mountedRef = useRef(true);

  // 核心服务连接（自账号页迁入）：测试核心初始化连通性，结果行内展示，失败另 toast
  const showDeveloper = isDeveloperEngineUiEnabled();
  const engineStatusId = useId();
  const [connBusy, setConnBusy] = useState(false);
  const [connHint, setConnHint] = useState('');
  const coreConnStatus =
    connHint ||
    (getTransport().isReady() ? t('common.online') : t('common.offline'));

  const handleTestCoreConn = useCallback(() => {
    if (connBusy) return;
    setConnBusy(true);
    setConnHint(t('settings.diagnostics.connecting'));
    void ensureEngineConnected()
      .then((r) => {
        setConnHint(
          r.ok
            ? t('settings.diagnostics.connected')
            : networkUserMessage(r.error) ||
                t('settings.diagnostics.notConnected')
        );
        // 失败结果行内展示；成功也行内，均不 toast
      })
      .catch((err) => {
        const msg =
          networkUserMessage(err) || t('settings.diagnostics.notConnected');
        setConnHint(msg);
        showToast(t('settings.diagnostics.connectionFailed', { error: msg }));
      })
      .finally(() => setConnBusy(false));
  }, [connBusy, showToast, t]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await fetchEngineStatus();
      if (!mountedRef.current) return;
      setStatus(next);
      setFetchError(
        next.ok
          ? null
          : (next.error ??
              t('settings.diagnostics.fetchFailedFallback', '核心状态获取失败'))
      );
    } catch (e) {
      if (!mountedRef.current) return;
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setRefreshing(false);
    }
  }, [t]);

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
      const ok = await copyTextToClipboard(text);
      if (ok)
        showToast(t('settings.diagnostics.copiedErrorInfo', '已复制错误信息'));
      else showToast(t('settings.diagnostics.copyFailed', '复制失败'));
    },
    [showToast, t]
  );

  const handleCopyPath = useCallback(
    async (pathStr: string) => {
      const ok = await copyTextToClipboard(pathStr);
      if (ok) showToast(t('settings.diagnostics.copiedPath', '已复制路径'));
      else showToast(t('settings.diagnostics.copyFailed', '复制失败'));
    },
    [showToast, t]
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
        showToast(
          t('settings.diagnostics.rebuildTriggered', '已触发搜索索引重建')
        );
        await load();
      } else {
        showToast(
          t(
            'settings.diagnostics.rebuildFailedDetail',
            '重建失败：索引命令不可用或报错'
          )
        );
      }
    } catch {
      if (mountedRef.current)
        showToast(t('settings.diagnostics.rebuildFailed', '重建失败'));
    } finally {
      if (mountedRef.current) setRebuilding(false);
    }
  }, [rebuilding, showToast, load, t]);

  // 微内核健康态判定：仅针对微内核崩溃（lastCrash）、致命运行异常（FatalPanic）、初始化失败或断连
  // 模型供应商未配置在对话主界面已有提示，此处仅反映微内核 session-loop 真实运行时健康态
  const isEngineHealthy =
    status && status.ok
      ? Boolean(
          status.connected !== false &&
          (status.initialized ?? true) &&
          !status.lastCrash &&
          status.lastError?.kind !== 'FatalPanic'
        )
      : undefined;

  const lastError = status?.lastError ?? null;
  const diagnostics: EngineDiagnosticEntry[] = status?.diagnostics ?? [];
  // 最新在前（Rust 侧缓冲最旧在前）
  const recentDiags = [...diagnostics].reverse();

  return (
    <SettingsPage
      title={t('settings.tabs.diagnostics', '状态诊断')}
      meta={
        <Tooltip
          content={
            fetchError
              ? t('settings.diagnostics.fetchFailed', '获取核心状态失败')
              : t('settings.diagnostics.polling', '自动轮询中')
          }
        >
          <span className={styles.pageMeta}>
            <span
              className={fetchError ? styles.connBad : styles.connOk}
              role="status"
              data-testid="diag-connection"
            >
              {fetchError
                ? t('settings.diagnostics.connectionError', '连接异常')
                : t('settings.diagnostics.online', '在线')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={refreshing}
              onClick={() => void load()}
              aria-label={t('settings.diagnostics.refreshAria', '刷新状态诊断')}
              icon={
                <AppIcon
                  name="refresh"
                  size={14}
                  className={refreshing ? styles.spin : undefined}
                />
              }
            >
              {t('settings.diagnostics.refresh', '刷新')}
            </Button>
          </span>
        </Tooltip>
      }
    >
      {fetchError ? (
        <div
          className={styles.errorBanner}
          role="alert"
          data-testid="diag-error-banner"
        >
          <AppIcon name="alert-triangle" size={16} aria-hidden />
          <div className={styles.errorBannerBody}>
            <strong>
              {t('settings.diagnostics.fetchErrorTitle', '无法获取核心状态')}
            </strong>
            <span>{fetchError}</span>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void load()}
          >
            {t('settings.diagnostics.retry', '重试')}
          </Button>
        </div>
      ) : null}

      <SettingsSection
        title={t('settings.diagnostics.subsystemsSection', '子系统就绪')}
      >
        <SettingsCard>
          <SubsystemRow
            label={t('settings.diagnostics.engineRow', '引擎（session-loop）')}
            ready={isEngineHealthy}
            readyLabel="engineReady"
          />
          <SubsystemRow
            label={t('settings.diagnostics.dbRow', '会话数据库')}
            ready={status?.dbReady}
            readyLabel="dbReady"
          />
          <SettingsRow
            title={t('settings.diagnostics.searchIndexRow', '搜索索引')}
            desc={
              status?.searchIndexReady
                ? t('settings.diagnostics.searchIndexReady', '已就绪')
                : typeof status?.searchIndexReady === 'boolean'
                  ? t(
                      'settings.diagnostics.searchIndexNotReady',
                      '未就绪（可能影响功能）'
                    )
                  : t('settings.diagnostics.statusUnknown', '状态未知')
            }
            control={
              <span
                className={
                  status?.searchIndexReady ? styles.badgeOk : styles.badgeBad
                }
                role="status"
                data-testid="diag-searchIndexReady"
              >
                {status?.searchIndexReady
                  ? t('settings.diagnostics.badgeOk', 'OK')
                  : typeof status?.searchIndexReady === 'boolean'
                    ? t('settings.diagnostics.badgeAbnormal', '异常')
                    : t('settings.diagnostics.badgeUnknown', '未知')}
              </span>
            }
          />
          {status?.searchIndexReady === false ? (
            <SettingsRow
              title={t('settings.diagnostics.rebuildRow', '重建索引')}
              control={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={rebuilding}
                  onClick={() => void handleRebuild()}
                  data-testid="diag-rebuild-search-index"
                  icon={<AppIcon name="search-check" size={14} />}
                >
                  {rebuilding
                    ? t('settings.diagnostics.rebuilding', '重建中…')
                    : t('settings.diagnostics.rebuildRow', '重建索引')}
                </Button>
              }
            />
          ) : null}
          <SettingsRow
            title={t('settings.diagnostics.logDirRow', '日志目录')}
            control={
              <div className={styles.logDirControl}>
                <Tooltip
                  content={
                    status?.logDir ??
                    t('settings.diagnostics.badgeUnknown', '未知')
                  }
                >
                  <span
                    className={styles.monoEllipsis}
                    data-testid="diag-log-dir"
                  >
                    {status?.logDir ?? '—'}
                  </span>
                </Tooltip>
                {status?.logDir ? (
                  <Tooltip
                    content={t(
                      'settings.diagnostics.copyLogDirPath',
                      '复制日志目录路径'
                    )}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(
                        'settings.diagnostics.copyLogDirPath',
                        '复制日志目录路径'
                      )}
                      onClick={() => void handleCopyPath(status.logDir!)}
                      icon={<AppIcon name="clipboard-copy" size={13} />}
                    />
                  </Tooltip>
                ) : null}
              </div>
            }
          />
          {showDeveloper ? (
            <SettingsRow
              title={
                <label htmlFor={engineStatusId}>
                  {t('settings.diagnostics.coreConn')}
                </label>
              }
              desc={t('settings.diagnostics.coreConnDesc')}
              control={
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={connBusy}
                    onClick={handleTestCoreConn}
                  >
                    {connBusy
                      ? t('settings.diagnostics.testing')
                      : t('settings.diagnostics.testBtn')}
                  </Button>
                  <span id={engineStatusId} role="status" aria-live="polite">
                    {coreConnStatus}
                  </span>
                </>
              }
            />
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.diagnostics.recentErrorSection', '最近错误')}
      >
        <SettingsCard>
          {lastError ? (
            <div
              className={styles.lastError}
              role="alert"
              data-testid="diag-last-error"
            >
              <div className={styles.lastErrorHead}>
                <span className={styles.lastErrorKind}>{lastError.kind}</span>
                <span className={styles.lastErrorTs}>
                  {formatTs(lastError.ts, language)}
                </span>
                <Tooltip
                  content={t(
                    'settings.diagnostics.copyErrorInfo',
                    '复制错误信息'
                  )}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t(
                      'settings.diagnostics.copyErrorInfo',
                      '复制错误信息'
                    )}
                    onClick={() => void handleCopy(lastError)}
                    icon={<AppIcon name="clipboard-copy" size={14} />}
                  >
                    {t('settings.diagnostics.copy', '复制')}
                  </Button>
                </Tooltip>
              </div>
              <pre className={styles.lastErrorDetail}>{lastError.detail}</pre>
            </div>
          ) : (
            <div data-testid="diag-no-error" role="status">
              <SettingsEmpty
                icon={<AppIcon name="check-circle" size={16} aria-hidden />}
                title={t('settings.diagnostics.noErrorRecord', '无错误记录')}
              />
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('settings.diagnostics.recentListSection', '最近诊断')}
      >
        <SettingsCard>
          {recentDiags.length === 0 ? (
            <div data-testid="diag-no-diagnostics" role="status">
              <SettingsEmpty
                title={t('settings.diagnostics.noDiagnostics', '暂无诊断记录')}
              />
            </div>
          ) : (
            <div
              aria-label={t('settings.diagnostics.listAria', '最近诊断条目')}
              data-testid="diag-list"
            >
              {recentDiags.map((d, i) => (
                <SettingsRow
                  key={`${d.ts}-${i}`}
                  title={d.message}
                  desc={formatTs(d.ts, language)}
                  control={
                    <span
                      className={`${styles.diagLevel} ${styles[`diagLevel_${(d.level || '').toLowerCase()}`] ?? ''}`}
                      role="status"
                    >
                      {levelLabel(d.level)}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
};
