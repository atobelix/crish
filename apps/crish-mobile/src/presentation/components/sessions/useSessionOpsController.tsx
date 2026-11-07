// 会话操作控制器（G3）：抽屉 / 主屏 / 会话页三处入口共用的操作状态机。
//
// 入口形态（全部取自现行组件体系，不自创手势）：
// - 抽屉与主屏的会话行：长按（Composer 语音长按同为 App 既有手势面）
//   → SessionActionsSheet（Sheet 体系）；
// - 会话页：头栏 ··· 下拉菜单条目直达各操作（原型 conversation ··· 菜单）。
//
// 纪律：
// - 一切写操作经 C40-C43 命令作用于桌面宿主会话存储（与桌面侧栏同一
//   真源）；成功后以宿主回读（观测桥 refreshNow → listSessions 对账）
//   刷新列表——不做无回滚的乐观改名/置顶，失败时列表状态不漂移；
// - 改名失败在弹窗内呈现（不丢用户输入）；删除失败按错误码给明确
//   文案（cmd.session_busy = 正在运行、cmd.denied = 不可删除）；
// - 导出 Markdown：C03 readSessionEvents 分页回读 → 本地拼装 →
//   RN 系统分享面（Share.share 文本分享，仓内无 expo-sharing，不新增
//   依赖；失败给诚实 toast）。
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Share } from 'react-native';
import type { JsonValue } from '@crish/shared-types';
import {
  ensureObservationWiring,
  getObservationWiring,
} from '@/adapters/wiring/observationWiring';
import {
  getSessionOpsContext,
  remoteControlFacade,
  type SessionOpsRepository,
} from '@/adapters/RemoteControlFacade';
import { buildSessionMarkdown } from '@/domain/pure/sessionMarkdown';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { haptics } from '@/adapters/platform/haptics';
import { Dialog, useToast } from '@/presentation/ui';
import { RenameSessionDialog } from './RenameSessionDialog';
import { SessionActionsSheet } from './SessionActionsSheet';

/** 导出回读单页事件数（monitorRepository 的 MAX_EVENTS_PER_REQUEST 口径） */
const EXPORT_PAGE_SIZE = 500;
/** 导出回读页数上限（防异常分页死循环；500 × 50 = 25000 条事件封顶） */
const EXPORT_MAX_PAGES = 50;

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  return 'internal';
}

function sessionTitleOf(session: SessionSummary): string {
  return session.title?.trim() || '未命名会话';
}

export interface SessionOpsController {
  /** 打开会话操作 Sheet（抽屉/主屏行长按） */
  openActions: (session: SessionSummary) => void;
  /** 置顶/取消置顶（即时命令，成功后回读刷新） */
  togglePin: (session: SessionSummary) => void;
  /** 打开改名弹窗 */
  renameSession: (session: SessionSummary) => void;
  /** 归档/取消归档（即时命令，成功后回读刷新；归档后行从主列表消失） */
  toggleArchive: (session: SessionSummary) => void;
  /** 导出 Markdown（回读事件 → 本地拼装 → 系统分享） */
  exportSession: (session: SessionSummary) => void;
  /** 打开删除确认弹窗（不直接删除） */
  deleteSession: (session: SessionSummary) => void;
  /** Sheet + 改名弹窗 + 删除确认弹窗（宿主屏渲染一次） */
  layer: ReactNode;
}

export interface SessionOpsControllerOptions {
  /** 删除成功回调（会话页删除当前会话时宿主据此返回上一级） */
  onSessionDeleted?: (sessionId: string) => void;
}

export function useSessionOpsController(
  options?: SessionOpsControllerOptions
): SessionOpsController {
  const { showToast } = useToast();
  // Sheet 目标与可见性分开：关闭时保留目标会话，让 Sheet 走完退出动画
  const [sheetSession, setSheetSession] = useState<SessionSummary | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<SessionSummary | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const onDeletedRef = useRef(options?.onSessionDeleted);
  onDeletedRef.current = options?.onSessionDeleted;

  /** 宿主回读刷新（与下拉刷新同一路径：观测桥 refreshNow → 对账） */
  const refreshSessions = useCallback(async () => {
    try {
      const wiring = getObservationWiring() ?? ensureObservationWiring();
      await wiring?.bridge.refreshNow();
    } catch {
      // 回读失败不掩盖已成功的操作结果；列表随后续推送/手动刷新收敛
    }
  }, []);

  /** 串行执行一个写操作：忙碌守卫 + 未连接守卫 + 成功回读；失败交回调用方呈现 */
  const runOp = useCallback(
    async (
      key: string,
      action: (repository: SessionOpsRepository) => Promise<unknown>
    ): Promise<boolean> => {
      if (busyRef.current) return false;
      if (!remoteControlFacade.isAvailable() && !getSessionOpsContext()) {
        showToast('未连接桌面，无法执行操作', 'error');
        return false;
      }
      busyRef.current = true;
      setBusyKey(key);
      try {
        await action(remoteControlFacade.sessionOps);
        await refreshSessions();
        return true;
      } finally {
        busyRef.current = false;
        setBusyKey(null);
      }
    },
    [refreshSessions, showToast]
  );

  const openActions = useCallback((session: SessionSummary) => {
    haptics.selection();
    setSheetSession(session);
    setSheetOpen(true);
  }, []);

  const togglePin = useCallback(
    (session: SessionSummary) => {
      setSheetOpen(false);
      const next = !session.isPinned;
      void (async () => {
        try {
          const ok = await runOp('pin', (repo) =>
            repo.setSessionPinned({ sessionId: session.id, pinned: next })
          );
          if (!ok) return;
        } catch (error) {
          showToast(
            `${next ? '置顶' : '取消置顶'}失败（${errorCodeOf(error)}），列表未变更`,
            'error'
          );
        }
      })();
    },
    [runOp, showToast]
  );

  const toggleArchive = useCallback(
    (session: SessionSummary) => {
      setSheetOpen(false);
      const next = !session.isArchived;
      void (async () => {
        try {
          const ok = await runOp('archive', (repo) =>
            repo.setSessionArchived({ sessionId: session.id, archived: next })
          );
          if (!ok) return;
        } catch (error) {
          showToast(
            `${next ? '归档' : '取消归档'}失败（${errorCodeOf(error)}），列表未变更`,
            'error'
          );
        }
      })();
    },
    [runOp, showToast]
  );

  const renameSession = useCallback((session: SessionSummary) => {
    setSheetOpen(false);
    setRenameError(null);
    setRenameTarget(session);
  }, []);

  const submitRename = useCallback(
    (title: string) => {
      const target = renameTarget;
      if (!target) return;
      void (async () => {
        try {
          const ok = await runOp('rename', (repo) =>
            repo.renameSession({ sessionId: target.id, title })
          );
          if (!ok) return;
          setRenameTarget(null);
          setRenameError(null);
        } catch (error) {
          const code = errorCodeOf(error);
          setRenameError(
            code === 'cmd.invalid'
              ? '标题清洗后为空，请换个标题'
              : code === 'cmd.not_found'
                ? '会话已不存在'
                : `改名失败（${code}），请重试`
          );
        }
      })();
    },
    [renameTarget, runOp]
  );

  const deleteSession = useCallback((session: SessionSummary) => {
    setSheetOpen(false);
    setDeleteTarget(session);
  }, []);

  const confirmDelete = useCallback(() => {
    const target = deleteTarget;
    if (!target) return;
    void (async () => {
      try {
        const ok = await runOp('delete', (repo) =>
          repo.deleteSession({ sessionId: target.id })
        );
        if (!ok) return;
        setDeleteTarget(null);
        onDeletedRef.current?.(target.id);
      } catch (error) {
        const code = errorCodeOf(error);
        setDeleteTarget(null);
        showToast(
          code === 'cmd.session_busy'
            ? '会话正在运行或有未处理输入，暂时无法删除'
            : code === 'cmd.denied'
              ? '该会话不可删除'
              : code === 'cmd.not_found'
                ? '会话已不存在'
                : `删除失败（${code}），请重试`,
          'error'
        );
        if (code === 'cmd.not_found') void refreshSessions();
      }
    })();
  }, [deleteTarget, runOp, showToast, refreshSessions]);

  const exportSession = useCallback(
    (session: SessionSummary) => {
      setSheetOpen(false);
      void (async () => {
        if (busyRef.current) return;
        if (!remoteControlFacade.isAvailable() && !getSessionOpsContext()) {
          showToast('未连接桌面，无法导出', 'error');
          return;
        }
        busyRef.current = true;
        setBusyKey('export');
        try {
          const events: JsonValue[] = [];
          let after = 0;
          let hasMore = true;
          for (let page = 0; hasMore && page < EXPORT_MAX_PAGES; page += 1) {
            const result =
              await remoteControlFacade.sessionOps.monitor.readSessionEvents({
                sessionId: session.id,
                afterSequence: after,
                maxEvents: EXPORT_PAGE_SIZE,
              });
            events.push(...result.events);
            after = result.nextAfterSequence;
            hasMore = result.hasMore;
          }
          const markdown = buildSessionMarkdown(session.title, events);
          await Share.share({
            title: sessionTitleOf(session),
            message: markdown,
          });
        } catch (error) {
          showToast(`导出失败（${errorCodeOf(error)}），请重试`, 'error');
        } finally {
          busyRef.current = false;
          setBusyKey(null);
        }
      })();
    },
    [showToast]
  );

  const layer = (
    <>
      <SessionActionsSheet
        visible={sheetOpen}
        session={sheetSession}
        onClose={() => setSheetOpen(false)}
        onTogglePin={togglePin}
        onRename={renameSession}
        onToggleArchive={toggleArchive}
        onExport={exportSession}
        onDelete={deleteSession}
      />
      <RenameSessionDialog
        visible={renameTarget !== null}
        initialTitle={renameTarget?.title ?? ''}
        error={renameError}
        submitting={busyKey === 'rename'}
        onCancel={() => {
          if (busyKey !== 'rename') setRenameTarget(null);
        }}
        onSubmit={submitRename}
      />
      <Dialog
        visible={deleteTarget !== null}
        title="删除会话"
        description={
          deleteTarget
            ? `确定要删除「${sessionTitleOf(deleteTarget)}」吗？删除后无法恢复。`
            : undefined
        }
        onDismiss={() => {
          if (busyKey !== 'delete') setDeleteTarget(null);
        }}
        testID="delete-session-dialog"
        actions={[
          {
            label: '取消',
            variant: 'ghost',
            onPress: () => setDeleteTarget(null),
            testID: 'delete-session-cancel',
          },
          {
            label: busyKey === 'delete' ? '删除中…' : '删除',
            variant: 'danger',
            onPress: confirmDelete,
            testID: 'delete-session-confirm',
          },
        ]}
      />
    </>
  );

  return {
    openActions,
    togglePin,
    renameSession,
    toggleArchive,
    exportSession,
    deleteSession,
    layer,
  };
}

export default useSessionOpsController;
