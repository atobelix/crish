import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { appState, type DaemonBrowserState, type DaemonEventSliceDiagnostics } from '../core/app-state';
import { tauriBridge } from '../core/tauri-bridge';
import { getBackendDiagnostics } from '../core/tauri-bridge';
import type { BackendCommandDiagnostic } from '../core/tauri-command-registry';
import { isBridgeDiagnostic } from '../core/bridge-utils';
import type { RuntimeTimelineItem } from '../core/runtime-event-projector';
import type { DaemonOrchestratorEvent, DaemonRunRecord, DaemonSessionRecord, DaemonSessionSummary } from '../shared/workbench-contract';
import { IconAlertTriangle, IconChevronRight, IconList, IconRefresh, IconSpinner, IconTerminal, IconX } from './icons';
import { truncatePath } from './utils';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;
const EVENT_PAGE_SIZE = 200;

export default function SessionBrowserPanel() {
  const [browser, setBrowser] = useState<DaemonBrowserState>(appState.getState().daemonBrowser);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);
  const [sessionRevision, setSessionRevision] = useState(0);

  useEffect(() => {
    const unsubscribe = appState.subscribe('daemonBrowser', setBrowser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const unsubscribe = appState.subscribe('sessions', () => setSessionRevision((value) => value + 1));
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (appState.getState().daemonBrowser.sessions.length === 0) {
      void refreshSessions();
    }
  }, []);

  const selectedSession = useMemo(
    () => browser.sessions.find((s) => s.id === browser.selectedSessionId) ?? null,
    [browser.sessions, browser.selectedSessionId]
  );
  const runs = selectedSession ? browser.runsBySessionId[selectedSession.id] ?? [] : [];
  const selectedRun = runs.find((r) => r.id === browser.selectedRunId) ?? null;
  const eventSlice =
    selectedRun && browser.runEventsByRunId[selectedRun.id]
      ? browser.runEventsByRunId[selectedRun.id]
      : selectedSession
        ? browser.sessionEventsBySessionId[selectedSession.id]
        : undefined;
  const events = eventSlice?.events ?? [];
  const nextAfter = eventSlice?.nextAfterSequence ?? 0;
  const hasMore = eventSlice?.hasMore ?? false;
  const selectedEvent = events.find((e) => e.id === selectedEventId) ?? events.at(-1) ?? null;
  const eventDiagnostics = eventSlice?.diagnostics ?? browser.diagnostics?.lastEventLoad;
  const backendDiagnostics = getBackendDiagnostics();
  const latestBackendDiagnostic = backendDiagnostics.at(-1);
  const timelineItems = useMemo(
    () => selectedSession ? appState.getSessionTimeline(selectedSession.id) : [],
    [selectedSession?.id, sessionRevision, browser.sessionEventsBySessionId, browser.runEventsByRunId]
  );
  const timelinePreviewItems = timelineItems.slice(-6);

  // 事件过滤
  const filteredEvents = useMemo(() => {
    if (!eventFilter.trim()) return events;
    const keyword = eventFilter.trim().toLowerCase();
    return events.filter(e => {
      const type = (e.type || '').toLowerCase();
      const payload = JSON.stringify(e.payload || {}).toLowerCase();
      return type.includes(keyword) || payload.includes(keyword);
    });
  }, [events, eventFilter]);

  const retryWithBackoff = useCallback(async <T,>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (retries <= 0) throw error;
      setRetryCount(MAX_RETRIES - retries + 1);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (MAX_RETRIES - retries + 1)));
      return retryWithBackoff(fn, retries - 1);
    } finally {
      setRetryCount(0);
    }
  }, []);

  async function withLoading(target: 'sessions' | 'runs' | 'events', task: () => Promise<void>) {
    const loadingKey = target === 'sessions' ? 'loadingSessions' : target === 'runs' ? 'loadingRuns' : 'loadingEvents';
    appState.patchDaemonBrowser({ [loadingKey]: true, error: null });
    try { await task(); }
    catch (error) { appState.patchDaemonBrowser({ error: errorMessage(error) }); }
    finally { appState.patchDaemonBrowser({ [loadingKey]: false }); }
  }

  async function refreshSessions() {
    await withLoading('sessions', async () => {
      const startedAt = nowMs();
      const sessionList = await tauriBridge.listSessions();
      if (isBridgeDiagnostic(sessionList)) throw new Error(sessionList.diagnostic.message);
      appState.setDaemonSessions(sessionList.sessions, sessionList.summaries ?? []);
      appState.recordDaemonListLoad('sessions', nowMs() - startedAt, sessionList.sessions.length);
      const selected = appState.getState().daemonBrowser.selectedSessionId ?? sessionList.sessions[0]?.id;
      if (selected) await loadSession(selected, { activate: false });
    });
  }

  async function loadSession(sessionId: string, options: { activate?: boolean } = {}) {
    setSelectedEventId(null);
    await appState.refreshDaemonSessionDetail(sessionId, { activate: options.activate });
    const slice = appState.getState().daemonBrowser.sessionEventsBySessionId[sessionId];
    setSelectedEventId(slice?.events.at(-1)?.id ?? null);
  }

  async function loadSessionEvents(
    sessionId: string,
    afterSequence: number,
    cursor?: ReturnType<typeof appState.getPersistedSessionCursor>
  ) {
    await withLoading('events', async () => {
      const startedAt = nowMs();
      const response = await retryWithBackoff(() =>
        tauriBridge.readSessionEvents({ sessionId, afterSequence, cursor: cursor ?? undefined, maxEvents: EVENT_PAGE_SIZE })
      );
      const requestMs = nowMs() - startedAt;
      const hasMore = response.hasMore ?? response.diagnostics?.truncated === true;
      if (afterSequence === 0 || response.cursorDiagnostic) {
        appState.setDaemonSessionEvents(sessionId, response.events, response.eventLog, response.nextAfterSequence, hasMore, {
          requestMs,
          backend: response.diagnostics,
          nextCursor: response.nextCursor,
          hasMore,
          mode: response.cursorDiagnostic ? 'full-replay' : afterSequence === 0 ? 'full-replay' : 'incremental',
        });
      } else {
        appState.appendDaemonSessionEvents(sessionId, response.events, response.eventLog, response.nextAfterSequence, hasMore, {
          requestMs,
          backend: response.diagnostics,
          nextCursor: response.nextCursor,
          hasMore,
          mode: 'incremental',
        });
      }
      const fallbackEventId = appState.getState().daemonBrowser.sessionEventsBySessionId[sessionId]?.events.at(-1)?.id ?? null;
      setSelectedEventId(response.events.at(-1)?.id ?? fallbackEventId);
    });
  }

  async function loadRunEvents(
    runId: string,
    afterSequence: number,
    cursor?: ReturnType<typeof appState.getPersistedRunCursor>
  ) {
    appState.selectDaemonRun(runId);
    await withLoading('events', async () => {
      const startedAt = nowMs();
      const response = await retryWithBackoff(() =>
        tauriBridge.readRunEvents({ runId, afterSequence, cursor: cursor ?? undefined, maxEvents: EVENT_PAGE_SIZE })
      );
      const requestMs = nowMs() - startedAt;
      const hasMore = response.hasMore ?? response.diagnostics?.truncated === true;
      if (afterSequence === 0 || response.cursorDiagnostic) {
        appState.setDaemonRunEvents(runId, response.events, response.eventLog, response.nextAfterSequence, null, hasMore, {
          requestMs,
          backend: response.diagnostics,
          nextCursor: response.nextCursor,
          hasMore,
          mode: response.cursorDiagnostic ? 'full-replay' : afterSequence === 0 ? 'full-replay' : 'incremental',
        });
      } else {
        appState.appendDaemonRunEvents(runId, response.events, response.eventLog, response.nextAfterSequence, hasMore, {
          requestMs,
          backend: response.diagnostics,
          nextCursor: response.nextCursor,
          hasMore,
          mode: 'incremental',
        });
      }
      const fallbackEventId = appState.getState().daemonBrowser.runEventsByRunId[runId]?.events.at(-1)?.id ?? null;
      setSelectedEventId(response.events.at(-1)?.id ?? fallbackEventId);
    });
  }

  async function selectRun(runId: string) {
    const cached = appState.getState().daemonBrowser.runEventsByRunId[runId];
    if (cached) {
      appState.selectDaemonRun(runId);
      setSelectedEventId(cached.events.at(-1)?.id ?? null);
    }
    const cursor = cached ? appState.getPersistedRunCursor(runId) : null;
    await loadRunEvents(runId, cursor?.afterSequence ?? cached?.nextAfterSequence ?? 0, cursor ?? undefined);
  }

  async function loadMoreEvents() {
    if (selectedRun) {
      await loadRunEvents(selectedRun.id, eventSlice?.nextCursor?.afterSequence ?? nextAfter, eventSlice?.nextCursor);
    } else if (selectedSession) {
      await loadSessionEvents(selectedSession.id, eventSlice?.nextCursor?.afterSequence ?? nextAfter, eventSlice?.nextCursor);
    }
  }

  async function openSelectedSession() {
    if (!selectedSession) return;
    await loadSession(selectedSession.id, { activate: true });
  }

  return (
    <div class="repl-sb-panel">
      <div class="repl-sb-toolbar">
        <div class="repl-sb-toolbar-title">
          <IconList />
          <span>会话浏览器</span>
        </div>
        <div class="repl-sb-toolbar-actions">
          <button class="repl-rs-icon-btn" onClick={() => void refreshSessions()} title="刷新">
            {browser.loadingSessions ? <span class="spin-icon"><IconSpinner /></span> : <IconRefresh />}
          </button>
          <button
            class="repl-rs-btn-sm primary"
            onClick={() => void openSelectedSession()}
            disabled={!selectedSession || browser.loadingEvents}
          >
            恢复
          </button>
        </div>
      </div>

      {browser.error && (
        <div class="repl-sb-error">
          <span>{browser.error}</span>
          <button class="repl-rs-icon-btn" onClick={() => void refreshSessions()} title="重试">
            <IconRefresh />
          </button>
        </div>
      )}

      {backendDiagnostics.length > 0 && (
        <DiagnosticBanner diagnostic={latestBackendDiagnostic} />
      )}

      <div class="repl-sb-grid">
        <section class="repl-sb-column">
          <div class="repl-sb-column-header">
            <span>会话</span>
            <span class="repl-sb-count">
              {browser.loadingSessions ? <span class="spin-icon"><IconSpinner /></span> : browser.sessions.length}
            </span>
          </div>
          <div class="repl-sb-list">
            {browser.loadingSessions && browser.sessions.length === 0 && <LoadingRows kind="session" />}
            {!browser.loadingSessions && browser.sessions.length === 0 && (
              <StateRow
                title={latestBackendDiagnostic ? stateTitleForDiagnostic(latestBackendDiagnostic) : '暂无会话'}
                meta={latestBackendDiagnostic ? stateMetaForDiagnostic(latestBackendDiagnostic) : '运行任务后会显示在这里'}
                tone={latestBackendDiagnostic ? toneForDiagnostic(latestBackendDiagnostic) : 'muted'}
              />
            )}
            {browser.sessions.map((session) => (
              <button
                key={session.id}
                class={`repl-sb-row ${session.id === browser.selectedSessionId ? 'active' : ''}`}
                onClick={() => void loadSession(session.id)}
              >
                <span class={`repl-sb-status-dot ${session.status === 'open' ? 'good' : 'muted'}`} />
                <span class="repl-sb-row-main">
                  <span class="repl-sb-row-title">{sessionTitle(session)}</span>
                  <span class="repl-sb-row-preview">{sessionPreview(session, browser.sessionSummaries[session.id])}</span>
                  <span class="repl-sb-row-meta">{truncatePath(session.cwd || session.id, 46)}</span>
                </span>
                <span class="repl-sb-row-side">
                  <span class={`repl-sb-pill ${session.status === 'open' ? 'good' : 'muted'}`}>{session.status}</span>
                  <span class="repl-sb-row-time">{sessionSummaryMeta(session, browser.sessionSummaries[session.id])}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section class="repl-sb-column">
          <div class="repl-sb-column-header">
            <span>运行</span>
            <span class="repl-sb-count">{browser.loadingRuns ? <span class="spin-icon"><IconSpinner /></span> : runs.length}</span>
          </div>
          <div class="repl-sb-list">
            {!selectedSession && <StateRow title="选择会话" meta="先从左侧选择一条会话" />}
            {selectedSession && browser.loadingRuns && runs.length === 0 && <LoadingRows kind="run" />}
            {selectedSession && !browser.loadingRuns && runs.length === 0 && <StateRow title="暂无运行" meta="该会话还没有运行记录" />}
            {runs.map((run) => (
              <button
                key={run.id}
                class={`repl-sb-row ${run.id === browser.selectedRunId ? 'active' : ''}`}
                onClick={() => void selectRun(run.id)}
              >
                <span class={`repl-sb-status-dot ${runTone(run.status)}`} />
                <span class="repl-sb-row-main">
                  <span class="repl-sb-row-title">{runTitle(run)}</span>
                  <span class="repl-sb-row-meta">{timeLabel(run.updatedAt)} · {shortId(run.id)}</span>
                </span>
                <span class={`repl-sb-pill ${runTone(run.status)}`}>{run.status}</span>
              </button>
            ))}
          </div>
        </section>

        <section class="repl-sb-column detail">
          <div class="repl-sb-column-header">
            <span>{selectedRun ? '运行事件' : '会话事件'}</span>
            <span class="repl-sb-count">{browser.loadingEvents ? <span class="spin-icon"><IconSpinner /></span> : filteredEvents.length}{eventFilter ? `/${events.length}` : ''}</span>
          </div>
          {events.length > 5 && (
            <div class="repl-sb-filter">
              <input
                class="repl-sb-filter-input"
                type="text"
                placeholder="过滤事件..."
                value={eventFilter}
                onInput={(e: any) => setEventFilter(e.currentTarget.value)}
              />
              {eventFilter && (
                <button class="repl-sb-filter-clear" onClick={() => setEventFilter('')}>
                  <IconX />
                </button>
              )}
            </div>
          )}
          {retryCount > 0 && (
            <div class="repl-sb-retry-banner">
              <IconSpinner /> 重试中 ({retryCount}/{MAX_RETRIES})...
            </div>
          )}
          {eventDiagnostics && (
            <LoadDiagnostic diagnostics={eventDiagnostics} loading={browser.loadingEvents} />
          )}
          <TimelinePreview items={timelinePreviewItems} total={timelineItems.length} />
          <div class="repl-sb-events-layout">
            <div class="repl-sb-list events">
              {browser.loadingEvents && events.length === 0 && <LoadingRows kind="event" />}
              {browser.loadingEvents && events.length > 0 && <StateRow title="同步事件中" meta={`已显示 ${events.length} 条事件`} compact />}
              {!browser.loadingEvents && events.length === 0 && (
                <StateRow
                  title={latestBackendDiagnostic ? stateTitleForDiagnostic(latestBackendDiagnostic) : '暂无事件'}
                  meta={latestBackendDiagnostic ? stateMetaForDiagnostic(latestBackendDiagnostic) : selectedSession ? '该范围暂无事件' : '先选择会话'}
                  tone={latestBackendDiagnostic ? toneForDiagnostic(latestBackendDiagnostic) : 'muted'}
                />
              )}
              {events.length > 0 && filteredEvents.length === 0 && <StateRow title="无匹配事件" meta="调整过滤条件" compact />}
              {filteredEvents.map((event) => (
                <button
                  key={event.id}
                  class={`repl-sb-event-row ${event.id === selectedEvent?.id ? 'active' : ''}`}
                  onClick={() => setSelectedEventId(event.id)}
                >
                  <span class="repl-sb-seq">#{event.sequence}</span>
                  <span class="repl-sb-row-main">
                    <span class="repl-sb-row-title">{eventTitle(event)}</span>
                    <span class="repl-sb-row-meta">{timeLabel(event.timestamp)}</span>
                  </span>
                  <span class="repl-sb-chevron"><IconChevronRight /></span>
                </button>
              ))}
              {hasMore && (
                <button class="repl-sb-load-more" onClick={() => void loadMoreEvents()} disabled={browser.loadingEvents}>
                  {browser.loadingEvents ? <span class="spin-icon"><IconSpinner /></span> : '加载更多'}
                </button>
              )}
            </div>
            <EventDetail event={selectedEvent} />
          </div>
        </section>
      </div>
    </div>
  );
}

function EventDetail({ event }: { event: DaemonOrchestratorEvent | null }) {
  if (!event) {
    return <div class="repl-sb-detail-empty">选择事件查看详情</div>;
  }
  return (
    <div class="repl-sb-detail">
      <div class="repl-sb-detail-header">
        <span class="repl-sb-detail-title">{eventTitle(event)}</span>
        <span class="repl-sb-row-meta">#{event.sequence}</span>
      </div>
      <div class="repl-sb-detail-meta">
        <MetaItem label="类型" value={event.type} />
        <MetaItem label="会话" value={shortId(event.sessionId)} />
        <MetaItem label="运行" value={event.runId ? shortId(event.runId) : '--'} />
        <MetaItem label="时间" value={timeLabel(event.timestamp)} />
      </div>
      <pre class="repl-sb-pre">{JSON.stringify(event.payload, null, 2)}</pre>
    </div>
  );
}

function TimelinePreview({ items, total }: { items: RuntimeTimelineItem[]; total: number }) {
  if (total === 0) return null;
  return (
    <div class="repl-sb-timeline-preview">
      <div class="repl-sb-timeline-head">
        <span>消息时间线</span>
        <span>最近 {items.length}/{total}</span>
      </div>
      <div class="repl-sb-timeline-list">
        {items.map((item) => (
          <div class={`repl-sb-timeline-row ${timelineItemTone(item)}`} key={item.id}>
            <span class="repl-sb-timeline-role">{timelineItemTitle(item)}</span>
            <span class="repl-sb-timeline-text">{timelineItemPreview(item)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function timelineItemTitle(item: RuntimeTimelineItem): string {
  if (item.kind === 'diagnostic') return item.diagnostic.title;
  if (item.message.role === 'user') return '用户';
  if (item.message.role === 'assistant') return item.message.streaming ? 'AI 输出中' : 'AI';
  return '系统';
}

function timelineItemPreview(item: RuntimeTimelineItem): string {
  const text =
    item.kind === 'diagnostic'
      ? item.diagnostic.content
      : item.message.content || item.message.toolCalls?.map((tool) => tool.name).join(', ') || '';
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 88 ? `${normalized.slice(0, 88)}...` : normalized || '无文本内容';
}

function timelineItemTone(item: RuntimeTimelineItem): string {
  if (item.kind === 'diagnostic') return 'bad';
  if (item.message.role === 'user') return 'user';
  if (item.message.role === 'assistant') return 'assistant';
  return 'system';
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div class="repl-sb-meta-item">
      <span class="repl-sb-meta-label">{label}</span>
      <span class="repl-sb-meta-value">{value}</span>
    </div>
  );
}

function LoadingRows({ kind }: { kind: 'session' | 'run' | 'event' }) {
  const rows = kind === 'event' ? 5 : 4;
  return (
    <>
      {Array.from({ length: rows }).map((_, index) => (
        <div class={`repl-sb-skeleton-row ${kind}`} key={`${kind}-${index}`}>
          <span class="repl-sb-skeleton-dot" />
          <span class="repl-sb-skeleton-lines">
            <span class="repl-skeleton-text medium" />
            <span class="repl-skeleton-text short" />
          </span>
        </div>
      ))}
    </>
  );
}

function StateRow({
  title,
  meta,
  tone = 'muted',
  compact = false,
}: {
  title: string;
  meta?: string;
  tone?: 'muted' | 'warn' | 'bad';
  compact?: boolean;
}) {
  return (
    <div class={`repl-sb-state-row ${tone} ${compact ? 'compact' : ''}`}>
      {tone !== 'muted' && <IconAlertTriangle />}
      <span class="repl-sb-state-main">
        <span class="repl-sb-state-title">{title}</span>
        {meta && <span class="repl-sb-state-meta">{meta}</span>}
      </span>
    </div>
  );
}

function DiagnosticBanner({ diagnostic }: { diagnostic?: BackendCommandDiagnostic }) {
  if (!diagnostic) return null;
  return (
    <div class={`repl-sb-diagnostic-banner ${toneForDiagnostic(diagnostic)}`}>
      <IconAlertTriangle />
      <span class="repl-sb-state-main">
        <span class="repl-sb-state-title">{stateTitleForDiagnostic(diagnostic)}</span>
        <span class="repl-sb-state-meta">{stateMetaForDiagnostic(diagnostic)}</span>
      </span>
    </div>
  );
}

function LoadDiagnostic({ diagnostics, loading }: { diagnostics: DaemonEventSliceDiagnostics; loading: boolean }) {
  return (
    <div class="repl-sb-load-diagnostic">
      {loading && <span class="spin-icon"><IconSpinner /></span>}
      <span>{diagnosticSummary(diagnostics)}</span>
    </div>
  );
}

function sessionTitle(session: DaemonSessionRecord): string {
  const title = stringMetadata(session.metadata, 'title');
  if (title) return title;
  const folder = session.cwd.split(/[\\/]/).filter(Boolean).at(-1);
  return folder ? `${folder} 会话` : `会话 ${shortId(session.id)}`;
}

function sessionPreview(session: DaemonSessionRecord, summary?: DaemonSessionSummary): string {
  if (summary?.lastMessagePreview) {
    return summary.lastMessagePreview.length > 56 ? `${summary.lastMessagePreview.slice(0, 56)}...` : summary.lastMessagePreview;
  }
  const prompt = stringMetadata(session.metadata, 'prompt') ?? stringMetadata(session.metadata, 'summary');
  if (prompt) return prompt.length > 56 ? `${prompt.slice(0, 56)}...` : prompt;
  const model = stringMetadata(session.metadata, 'model');
  return model ? `模型 ${model}` : shortId(session.id);
}

function sessionSummaryMeta(session: DaemonSessionRecord, summary?: DaemonSessionSummary): string {
  if (!summary) return timeLabel(session.updatedAt);
  return `${timeLabel(summary.lastUpdated)} | ${summary.runCount}r/${summary.eventCount}e`;
}

function runTitle(run: DaemonRunRecord): string {
  const prompt = stringMetadata(run.metadata, 'prompt');
  if (prompt) return prompt.length > 44 ? `${prompt.slice(0, 44)}...` : prompt;
  return `运行 ${shortId(run.id)}`;
}

function eventTitle(event: DaemonOrchestratorEvent): string {
  const runtimeType = recordValue(event.payload, 'event')?.type;
  if (event.type === 'runtime-event' && typeof runtimeType === 'string') return runtimeType;
  return event.type;
}

function runTone(status: DaemonRunRecord['status']): string {
  if (status === 'completed') return 'good';
  if (status === 'failed' || status === 'cancelled') return 'bad';
  if (status === 'awaiting-approval' || status === 'cancelling') return 'warn';
  return status === 'running' || status === 'queued' ? 'good' : 'muted';
}

function recordValue(parent: unknown, key: string): Record<string, unknown> | undefined {
  if (!parent || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
  const value = (parent as Record<string, unknown>)[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function shortId(id: string): string { return id.length > 10 ? id.slice(-10) : id; }

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function diagnosticSummary(diagnostics: NonNullable<DaemonBrowserState['diagnostics']>['lastEventLoad']): string {
  if (!diagnostics) return '';
  const requestMs = diagnostics.requestMs !== undefined ? ` / ${Math.round(diagnostics.requestMs)}ms` : '';
  const page = diagnostics.maxEvents !== undefined ? ` / page ${diagnostics.maxEvents}` : '';
  const more = diagnostics.hasMore ? ' / more' : '';
  return `${diagnostics.mode} / fetched ${diagnostics.eventsFetched} / applied ${diagnostics.eventsApplied} / deduped ${diagnostics.dedupedCount}${page}${more}${requestMs}`;
}

function stateTitleForDiagnostic(diagnostic: BackendCommandDiagnostic): string {
  if (diagnostic.code === 'backend-not-wired' || diagnostic.code === 'unsupported') return '后端命令未接入';
  if (diagnostic.code === 'daemon-disconnected') return '后台已断开';
  return '加载失败';
}

function stateMetaForDiagnostic(diagnostic: BackendCommandDiagnostic): string {
  if (diagnostic.code === 'backend-not-wired' || diagnostic.code === 'unsupported') {
    return `${diagnostic.feature} 暂不可用`;
  }
  if (diagnostic.code === 'daemon-disconnected') return '检查后台服务后重试';
  return diagnostic.message;
}

function toneForDiagnostic(diagnostic: BackendCommandDiagnostic): 'warn' | 'bad' {
  return diagnostic.code === 'backend-not-wired' || diagnostic.code === 'unsupported' ? 'warn' : 'bad';
}
