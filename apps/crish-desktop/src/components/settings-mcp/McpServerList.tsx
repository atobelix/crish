import React from 'react';

import type { McpServerInfo } from '../../api/mcpApi';
import { mcpStateKind, mcpStateLabel } from '../../api/mcpApi';
import type { McpServer } from '../../api/clientApi';
import styles from './McpSettingsTab.module.css';
import { Button, Switch, Tooltip } from '@/components/ui';
import {
  EMPTY_DEMO_HINT,
  EMPTY_LIVE_HINT_CONFIGURED,
  EMPTY_LIVE_HINT_UNCONFIGURED,
  transportLabel,
  transportTitle,
} from './types';
import { useI18n } from '../../i18n';
import { McpServerTools } from './McpServerTools';
import { McpServerToolbar } from './McpServerToolbar';
import { McpServerFilterEmpty } from './McpServerFilterEmpty';
import type {
  McpServersGroup,
  McpUiGroup,
  McpActionsGroup,
} from './useMcpServerListState';
import { AppIcon } from '@/components/ui/icons';

const kindClassMap: Record<'ok' | 'warn' | 'err' | 'idle', string | undefined> =
  {
    ok: styles.kindOk,
    warn: styles.kindWarn,
    err: styles.kindErr,
    idle: styles.kindIdle,
  };

export type McpServerListProps = {
  servers: McpServersGroup;
  ui: McpUiGroup;
  actions: McpActionsGroup;
};

export const McpServerList: React.FC<McpServerListProps> = ({
  servers: sv,
  ui,
  actions: ac,
}) => {
  const { t } = useI18n();
  const {
    demo,
    loading,
    servers,
    status,
    demoServers,
    demoEnabled,
    filtered,
    filteredDemo,
    expanded,
    busyId,
    canStartStop,
  } = sv;
  const { filter, sortMode, showAdd, listLabelId, toolsPanelPrefix } = ui;
  const {
    onRefresh,
    onSetSort,
    onSetFilter,
    onClearFilter,
    onSetShowAdd,
    onToggleServer,
    onCopy,
    onToggleExpanded,
    onToggleDemoEnabled,
    onDeleteDemo,
    refreshDemo,
    refreshLive,
  } = ac;
  const filterActive = filter.trim().length > 0;
  const liveEmptyHint = status?.configured
    ? t('settings.mcp.emptyHintConfigured', EMPTY_LIVE_HINT_CONFIGURED)
    : t('settings.mcp.emptyHintUnconfigured', EMPTY_LIVE_HINT_UNCONFIGURED);

  const renderSharedToolbar = () => (
    <McpServerToolbar
      demo={demo}
      loading={loading}
      filter={filter}
      sortMode={sortMode}
      showAdd={showAdd}
      onRefresh={onRefresh}
      onSetSort={onSetSort}
      onSetFilter={onSetFilter}
      onClearFilter={onClearFilter}
      onSetShowAdd={onSetShowAdd}
    />
  );

  const renderServiceList = <T,>(opts: {
    items: T[];
    totalCount: number;
    loading: boolean;
    emptyContent: React.ReactNode;
    renderItem: (item: T, index: number) => React.ReactNode;
  }) => {
    const {
      items,
      totalCount,
      loading: isBusy,
      emptyContent,
      renderItem,
    } = opts;
    return (
      <div
        className={`${styles.mcpList} mcp-list`}
        role="list"
        aria-labelledby={listLabelId}
        aria-label={t('settings.mcp.listAria', '服务列表')}
        aria-busy={isBusy || undefined}
      >
        {items.length > 0 ? items.map(renderItem) : null}
        {!isBusy && totalCount === 0 ? (
          <div
            className={`${styles.mcpEmptyLine} mcp-empty-line`}
            role="status"
            aria-live="polite"
          >
            {emptyContent}
          </div>
        ) : null}
        {!isBusy && totalCount > 0 && items.length === 0 && filterActive ? (
          <McpServerFilterEmpty
            loading={isBusy}
            hasAny
            filterActive
            onClearFilter={onClearFilter}
          />
        ) : null}
        {isBusy && totalCount === 0 ? (
          <McpServerFilterEmpty
            loading={isBusy}
            hasAny
            filterActive
            onClearFilter={onClearFilter}
          />
        ) : null}
      </div>
    );
  };

  if (demo) {
    return (
      <>
        {renderSharedToolbar()}
        {renderServiceList({
          items: filteredDemo,
          totalCount: demoServers.length,
          loading,
          emptyContent: (
            <>
              <span>{t('settings.mcp.emptyDemoHint', EMPTY_DEMO_HINT)}</span>
              <Tooltip
                content={t('settings.mcp.emptyDemoHint', EMPTY_DEMO_HINT)}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetShowAdd(true)}
                  aria-label={t('settings.mcp.addDemo', '添加演示服务')}
                  icon={<AppIcon name="plus" size={14} aria-hidden />}
                >
                  {t('settings.mcp.add', '添加')}
                </Button>
              </Tooltip>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshDemo()}
                disabled={loading}
                aria-label={t('settings.mcp.refreshList', '刷新列表')}
                icon={<AppIcon name="refresh" size={14} aria-hidden />}
              >
                {t('settings.mcp.refresh', '刷新')}
              </Button>
            </>
          ),
          renderItem: (srv: McpServer) => {
            const on = demoEnabled[srv.id] !== false;
            const typeTitle = transportTitle(srv.type, t);
            return (
              <div
                key={srv.id}
                className={`${styles.mcpRow} mcp-row`}
                role="listitem"
              >
                <div className={`${styles.mcpRowMain} mcp-row-main`}>
                  <Tooltip
                    content={
                      on
                        ? t('settings.mcp.enabledTooltip', '已启用')
                        : t('settings.mcp.disabledTooltip', '已禁用')
                    }
                  >
                    <span
                      className={`${styles.mcpDot} mcp-dot kind-${on ? 'ok' : 'idle'} ${on ? styles.kindOk : styles.kindIdle}`}
                      aria-hidden
                    />
                  </Tooltip>
                  <span className={`${styles.mcpRowName} mcp-row-name`}>
                    {srv.name}
                  </span>
                  <Tooltip
                    content={t('settings.mcp.copyIdTooltip', '复制标识 {id}', {
                      id: srv.id,
                    })}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t(
                        'settings.mcp.copyIdAria',
                        '复制标识 {name}',
                        { name: srv.name }
                      )}
                      onClick={() => onCopy(srv.id)}
                      icon={<AppIcon name="copy" size={14} aria-hidden />}
                    />
                  </Tooltip>
                  <span
                    className={`${styles.mcpStateBadge} mcp-state-badge kind-${on ? 'ok' : 'idle'} ${on ? styles.kindOk : styles.kindIdle}`}
                  >
                    {on
                      ? t('settings.mcp.enabledState', '启用')
                      : t('settings.mcp.disabledState', '禁用')}
                  </span>
                  <Tooltip content={typeTitle}>
                    <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                      {transportLabel(srv.type)}
                      {srv.command ? ` · ${srv.command}` : ''}
                      {srv.url ? ` · ${srv.url}` : ''}
                    </span>
                  </Tooltip>
                  <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                    <Tooltip
                      content={
                        on
                          ? t('settings.mcp.disabledState', '禁用')
                          : t('settings.mcp.enabledState', '启用')
                      }
                    >
                      <Switch
                        checked={on}
                        aria-label={
                          on
                            ? t('settings.mcp.disableAria', '禁用 {name}', {
                                name: srv.name,
                              })
                            : t('settings.mcp.enableAria', '启用 {name}', {
                                name: srv.name,
                              })
                        }
                        onCheckedChange={() => onToggleDemoEnabled(srv.id)}
                      />
                    </Tooltip>
                    <Tooltip content={t('settings.mcp.delete', '删除')}>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        aria-label={t(
                          'settings.mcp.deleteAria',
                          '删除 {name}',
                          {
                            name: srv.name,
                          }
                        )}
                        onClick={() => void onDeleteDemo(srv.id)}
                        icon={<AppIcon name="trash" size={14} aria-hidden />}
                      />
                    </Tooltip>
                  </div>
                </div>
              </div>
            );
          },
        })}
      </>
    );
  }

  return (
    <>
      {renderSharedToolbar()}
      {renderServiceList({
        items: filtered,
        totalCount: servers.length,
        loading,
        emptyContent: (
          <>
            <Tooltip content={liveEmptyHint}>
              <span>
                {status?.configured
                  ? t('settings.mcp.noInstances', '暂无服务实例')
                  : t('settings.mcp.noServers', '暂无扩展服务')}
              </span>
            </Tooltip>
            <Tooltip
              content={t('settings.mcp.requeryTooltip', '重新向引擎查询列表')}
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshLive()}
                disabled={loading}
                aria-label={t('settings.mcp.refreshList', '刷新列表')}
                icon={<AppIcon name="refresh" size={14} aria-hidden />}
              >
                {t('settings.mcp.refresh', '刷新')}
              </Button>
            </Tooltip>
          </>
        ),
        renderItem: (srv: McpServerInfo) => {
          const kind = mcpStateKind(srv.state);
          const isOpen = !!expanded[srv.id];
          const running =
            kind === 'ok' ||
            srv.state === 'starting' ||
            srv.state === 'ready' ||
            srv.state === 'running';
          const toolN = srv.toolCount ?? srv.tools.length;
          const panelId = `${toolsPanelPrefix}-${srv.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          const busy = busyId === srv.id;
          const tp = transportLabel(srv.transport);
          const tpTitle = transportTitle(srv.transport, t);

          return (
            <div
              key={srv.id}
              className={`${styles.mcpRow} mcp-row`}
              role="listitem"
            >
              <div className={`${styles.mcpRowMain} mcp-row-main`}>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span
                    className={`${styles.mcpDot} mcp-dot kind-${kind} ${kindClassMap[kind] ?? ''}`}
                    aria-hidden
                  />
                </Tooltip>
                <span className={`${styles.mcpRowName} mcp-row-name`}>
                  {srv.name}
                </span>
                <Tooltip
                  content={t('settings.mcp.copyIdTooltip', '复制标识 {id}', {
                    id: srv.id,
                  })}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t(
                      'settings.mcp.copyIdAria',
                      '复制标识 {name}',
                      {
                        name: srv.name,
                      }
                    )}
                    onClick={() => onCopy(srv.id)}
                    icon={<AppIcon name="copy" size={14} aria-hidden />}
                  />
                </Tooltip>
                <Tooltip content={mcpStateLabel(srv.state)}>
                  <span
                    className={`${styles.mcpStateBadge} mcp-state-badge kind-${kind} ${kindClassMap[kind] ?? ''}`}
                  >
                    {mcpStateLabel(srv.state)}
                  </span>
                </Tooltip>
                <Tooltip content={tpTitle}>
                  <span className={`${styles.mcpRowMeta} mcp-row-meta`}>
                    {tp ? `${tp} · ` : ''}
                    {t('settings.mcp.toolCountMeta', '工具 {count}', {
                      count: toolN,
                    })}
                    {srv.lastError ? (
                      <Tooltip content={srv.lastError}>
                        <span className={`${styles.mcpRowErr} mcp-row-err`}>
                          {' '}
                          · {t('settings.mcp.errorMark', '错误')}
                        </span>
                      </Tooltip>
                    ) : null}
                  </span>
                </Tooltip>
                <div className={`${styles.mcpRowActions} mcp-row-actions`}>
                  <Tooltip
                    content={
                      isOpen
                        ? t('settings.mcp.collapseTools', '收起工具')
                        : t('settings.mcp.expandTools', '展开工具（{count}）', {
                            count: toolN,
                          })
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={
                        isOpen
                          ? t(
                              'settings.mcp.collapseToolsAria',
                              '收起 {name} 的工具',
                              { name: srv.name }
                            )
                          : t(
                              'settings.mcp.expandToolsAria',
                              '展开 {name} 的工具 {count}',
                              { name: srv.name, count: toolN }
                            )
                      }
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      onClick={() => onToggleExpanded(srv.id)}
                      icon={
                        isOpen ? (
                          <AppIcon name="chevron-up" size={14} aria-hidden />
                        ) : (
                          <AppIcon name="chevron-down" size={14} aria-hidden />
                        )
                      }
                    />
                  </Tooltip>
                  {canStartStop ? (
                    running ? (
                      <Tooltip
                        content={
                          busy
                            ? t('settings.mcp.stopping', '停止中…')
                            : t('settings.mcp.stop', '停止')
                        }
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={t(
                            'settings.mcp.stopAria',
                            '停止 {name}',
                            {
                              name: srv.name,
                            }
                          )}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'stop')}
                          icon={<AppIcon name="square" size={14} aria-hidden />}
                        />
                      </Tooltip>
                    ) : (
                      <Tooltip
                        content={
                          busy
                            ? t('settings.mcp.starting', '启动中…')
                            : t('settings.mcp.start', '启动')
                        }
                      >
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          aria-label={t(
                            'settings.mcp.startAria',
                            '启动 {name}',
                            { name: srv.name }
                          )}
                          aria-busy={busy || undefined}
                          onClick={() => void onToggleServer(srv.id, 'start')}
                          icon={<AppIcon name="play" size={14} aria-hidden />}
                        />
                      </Tooltip>
                    )
                  ) : null}
                </div>
              </div>
              {isOpen ? (
                <McpServerTools srv={srv} panelId={panelId} onCopy={onCopy} />
              ) : null}
            </div>
          );
        },
      })}
    </>
  );
};
