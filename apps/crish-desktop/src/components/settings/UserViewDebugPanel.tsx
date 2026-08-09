/**
 * UserView / ModelView 投影调试面板（轻量 productization · ledger W4-6）。
 * 只读：projectSessionMessagesToUserView → 统计 / 隐藏桶 / JSON 导出。
 * 不写 store、不回流 ModelView（I-PROJ）。
 */
import React, { useCallback, useMemo, useState } from 'react';
import * as Lucide from 'lucide-react';
import {
  debugExportUserView,
  isUserViewDebugEnabled,
  projectSessionMessagesToUserView,
  serializeUserViewProjectionExport,
  summarizeUserViewProjection,
  type HiddenBucketKind,
} from '../../api/messageUserProjection';
import { downloadTextFile } from '../../api/sessionExport';
import { useActiveSession } from '../../api/store-access/componentAccess';
import { SettingsCard, SettingsRow, SettingsSection } from './SettingsUI';
import { Button, Tooltip } from '../ui';
import styles from './UserViewDebugPanel.module.css';

type Props = {
  onShowToast?: (msg: string) => void;
};

const KIND_LABEL_ZH: Record<HiddenBucketKind, string> = {
  thinking: 'thinking',
  tool_raw: 'tool_raw',
  system: 'system',
  nudge: 'nudge',
  system_nudge: 'system_nudge',
};

function safeSessionTitle(title: string | undefined): string {
  const t = (title || '').trim();
  return t || '未命名会话';
}

function exportFilename(sessionId: string | undefined): string {
  const id = (sessionId || 'no-session').replace(/[^\w.-]+/g, '_').slice(0, 48);
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `user-view-projection-${id}-${y}${m}${day}.json`;
}

/**
 * 开发者设置内嵌：当前活动会话的 UserView 投影统计。
 * 由父级用 isDeveloperEngineUiEnabled / DEV 门控；本组件不改投影语义。
 */
export const UserViewDebugPanel: React.FC<Props> = ({ onShowToast }) => {
  const session = useActiveSession();
  const [showBucketList, setShowBucketList] = useState(false);

  const dto = useMemo(() => {
    const messages = session?.messages ?? [];
    return projectSessionMessagesToUserView(messages);
  }, [session?.messages]);

  const summary = useMemo(
    () =>
      summarizeUserViewProjection(dto, {
        sessionId: session?.id,
        sessionTitle: session?.title,
        sessionMessageCount: session?.messages?.length ?? 0,
      }),
    [dto, session?.id, session?.title, session?.messages?.length],
  );

  const handleExport = useCallback(() => {
    try {
      // console 路径仍受 isUserViewDebugEnabled 门控；下载始终可用（面板已在 dev 区）
      debugExportUserView(dto, 'UserViewDebugPanel');
      const json = serializeUserViewProjectionExport(dto, {
        sessionId: session?.id,
        sessionTitle: session?.title,
        sessionMessageCount: session?.messages?.length ?? 0,
      });
      downloadTextFile(exportFilename(session?.id), json, {
        mimeType: 'application/json;charset=utf-8',
      });
      onShowToast?.('已导出投影 JSON');
    } catch (err) {
      onShowToast?.('导出失败：' + String(err));
    }
  }, [dto, onShowToast, session?.id, session?.messages?.length, session?.title]);

  const noSession = !session?.id;
  const consoleFlagOn = isUserViewDebugEnabled();

  return (
    <SettingsSection title="UserView 投影（调试）">
      <SettingsCard>
        <SettingsRow
          title="活动会话"
          desc={
            noSession
              ? '无活动会话'
              : `${safeSessionTitle(session?.title)} · ${(session?.id || '').slice(0, 12)}…`
          }
          control={
            <Tooltip content={session?.id || '无会话'}>
              <span className={styles.metaMono} role="status">
                {noSession ? '—' : `${summary.sessionMessageCount} 条消息`}
              </span>
            </Tooltip>
          }
        />

        <div className={styles.statsGrid} role="group" aria-label="投影统计">
          <div className={styles.statItem}>
            <span className={styles.statLabel}>UserView 消息</span>
            <span className={styles.statValue}>{summary.userViewMessageCount}</span>
          </div>
          <div className={styles.statItem}>
            <Tooltip content="ModelView 粗算块：正文 + thinking + 每个 tool">
              <span className={styles.statLabel}>ModelView 块</span>
            </Tooltip>
            <span className={styles.statValue}>{summary.stats.modelBlockCount}</span>
          </div>
          <div className={styles.statItem}>
            <Tooltip content="可见正文条 + 工具摘要卡">
              <span className={styles.statLabel}>可见块</span>
            </Tooltip>
            <span className={styles.statValue}>
              {summary.stats.userVisibleBlockCount}
            </span>
          </div>
          <div className={styles.statItem}>
            <span className={styles.statLabel}>隐藏桶</span>
            <span className={styles.statValue}>{summary.stats.hiddenCount}</span>
          </div>
        </div>

        <SettingsRow
          title="ModelView ≥ UserView"
          desc={
            summary.modelGeUser
              ? '块计数满足差集验收'
              : '可见块多于模型块（异常）'
          }
          control={
            <span
              className={
                summary.modelGeUser ? styles.badgeOk : styles.badgeWarn
              }
              role="status"
            >
              {summary.modelGeUser ? 'OK' : 'CHECK'}
            </span>
          }
        />

        <SettingsRow
          title="隐藏 kind"
          desc={
            summary.hiddenKinds.length === 0
              ? '无隐藏内容'
              : summary.hiddenKinds
                  .map(
                    (k) =>
                      `${KIND_LABEL_ZH[k] ?? k}×${summary.kindCounts[k] ?? 0}`,
                  )
                  .join(' · ')
          }
          control={
            summary.stats.hiddenCount > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowBucketList((v) => !v)}
              >
                {showBucketList ? '收起' : '明细'}
              </Button>
            ) : (
              <span className={styles.metaMuted}>—</span>
            )
          }
        />

        {showBucketList && summary.stats.hiddenCount > 0 ? (
          <ul className={styles.bucketList} aria-label="隐藏桶明细">
            {dto.hiddenBuckets.map((b, i) => (
              <li key={`${b.kind}-${b.sourceMessageId ?? ''}-${i}`} className={styles.bucketItem}>
                <span className={styles.bucketKind}>{KIND_LABEL_ZH[b.kind] ?? b.kind}</span>
                <span className={styles.bucketChars}>{b.charCount} 字</span>
                <Tooltip content={b.preview || '(空)'}>
                  <span className={styles.bucketPreview}>
                    {b.preview || '—'}
                  </span>
                </Tooltip>
              </li>
            ))}
          </ul>
        ) : null}

        <div className={styles.actionsBar}>
          <Tooltip content="下载当前会话 UserView 投影 JSON（只读，不写 ModelView）">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={noSession}
              onClick={handleExport}
              icon={<Lucide.Download size={14} strokeWidth={1.75} />}
            >
              导出投影 JSON
            </Button>
          </Tooltip>
          {consoleFlagOn ? (
            <span className={styles.metaMuted} role="status">
              console debug 已开
            </span>
          ) : (
            <Tooltip content="localStorage crish:userViewDebug=1 可开启 console.debug">
              <span className={styles.metaMuted}>console 未开</span>
            </Tooltip>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
};
