// 本地线程操作控制器（界面统一 U3）：抽屉本地行长按的操作状态机。
// 形态与远端 useSessionOpsController 对齐（Sheet + 改名弹窗 + 确认弹窗，
// 同一套组件体系），但写操作全部作用于本地真源（localChatSessionStore /
// localChatEngine），不经桌面命令通道：
// - 重命名：标题清洗（去首尾空白 + 折叠内部空白，与桌面改名同口径）后
//   走 store.setThreadTitle(..., 'user')——来源阶梯封顶，此后 AI 标题与
//   派生标题永不覆盖用户标题（U4 纪律）；
// - 清空对话：确认后执行；生成中的线程先停止（stopLocalChatMessage）
//   再 clearThread，避免已清线程被迟到增量回填；
// - 删除对话：危险项 + 确认弹窗；abortLocalThread 中止流后 deleteThread
//   （连带历史落盘删除）。删除成功经 onThreadDeleted 通知宿主做导航
//   收尾（删的正是当前打开的线程时回主页）。
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  abortLocalThread,
  isLocalThreadStreaming,
  stopLocalChatMessage,
} from '@/adapters/localChat/localChatEngine';
import {
  LOCAL_THREAD_PLACEHOLDER_TITLE,
  localChatSessionStore,
} from '@/domain/store/localChatSessionStore';
import type { LocalThreadMeta } from '@/domain/types/localChat';
import { Dialog, Sheet, SheetOptionRow } from '@/presentation/ui';
import { RenameSessionDialog } from './RenameSessionDialog';

export interface LocalThreadOpsController {
  /** 打开线程操作 Sheet（抽屉本地行长按） */
  openActions: (thread: LocalThreadMeta) => void;
  /** Sheet + 改名弹窗 + 清空/删除确认弹窗（宿主渲染一次） */
  layer: ReactNode;
}

export interface LocalThreadOpsOptions {
  /** 删除成功回调（宿主据此处理「删的正是当前打开的线程」等收尾） */
  onThreadDeleted?: (threadId: string) => void;
}

function titleOf(thread: LocalThreadMeta | null): string {
  return thread?.title?.trim() || LOCAL_THREAD_PLACEHOLDER_TITLE;
}

export function useLocalThreadOpsController(
  options?: LocalThreadOpsOptions
): LocalThreadOpsController {
  const theme = useTheme();
  // Sheet 目标与可见性分开（同远端控制器口径）：关闭时保留目标，
  // 让 Sheet 走完退出动画
  const [sheetThread, setSheetThread] = useState<LocalThreadMeta | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LocalThreadMeta | null>(
    null
  );
  const [renameError, setRenameError] = useState<string | null>(null);
  const [clearTarget, setClearTarget] = useState<LocalThreadMeta | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalThreadMeta | null>(
    null
  );
  const onDeletedRef = useRef(options?.onThreadDeleted);
  onDeletedRef.current = options?.onThreadDeleted;

  const openActions = useCallback((thread: LocalThreadMeta) => {
    setSheetThread(thread);
    setSheetOpen(true);
  }, []);

  const renameThread = useCallback((thread: LocalThreadMeta) => {
    setSheetOpen(false);
    setRenameError(null);
    setRenameTarget(thread);
  }, []);

  const submitRename = useCallback(
    (title: string) => {
      const target = renameTarget;
      if (!target) return;
      // 标题规范化在宿主侧（与桌面改名同口径：清洗/折叠）
      const clean = title.trim().replace(/\s+/g, ' ');
      if (clean === '') {
        setRenameError('标题清洗后为空，请换个标题');
        return;
      }
      const ok = localChatSessionStore
        .getState()
        .setThreadTitle(target.id, clean, 'user');
      // 'user' 是来源阶梯顶格，正常必写入；返回 false 只余「同名再提交」
      // （与目标现名相同 = 已达所愿，按成功关窗）与线程已不存在两种情形，
      // 后者给明确失败文案，不静默吞
      if (!ok && clean !== target.title) {
        setRenameError('改名失败，请重试');
        return;
      }
      setRenameTarget(null);
      setRenameError(null);
    },
    [renameTarget]
  );

  const clearThread = useCallback((thread: LocalThreadMeta) => {
    setSheetOpen(false);
    setClearTarget(thread);
  }, []);

  const confirmClear = useCallback(() => {
    const target = clearTarget;
    if (!target) return;
    if (isLocalThreadStreaming(target.id)) {
      stopLocalChatMessage(target.id);
    }
    localChatSessionStore.getState().clearThread(target.id);
    setClearTarget(null);
  }, [clearTarget]);

  const deleteThread = useCallback((thread: LocalThreadMeta) => {
    setSheetOpen(false);
    setDeleteTarget(thread);
  }, []);

  const confirmDelete = useCallback(() => {
    const target = deleteTarget;
    if (!target) return;
    abortLocalThread(target.id);
    localChatSessionStore.getState().deleteThread(target.id);
    setDeleteTarget(null);
    onDeletedRef.current?.(target.id);
  }, [deleteTarget]);

  const layer = (
    <>
      {sheetThread ? (
        <Sheet
          keyboard="none"
          visible={sheetOpen}
          onClose={() => setSheetOpen(false)}
          title={titleOf(sheetThread)}
          size="medium"
          testID="local-thread-actions-sheet"
        >
          <View style={{ gap: theme.space.sm }}>
            <SheetOptionRow
              testID="local-thread-actions-rename"
              label="重命名"
              onPress={() => renameThread(sheetThread)}
            />
            <SheetOptionRow
              testID="local-thread-actions-clear"
              label="清空对话"
              onPress={() => clearThread(sheetThread)}
            />
            <SheetOptionRow
              testID="local-thread-actions-delete"
              label="删除对话"
              danger
              onPress={() => deleteThread(sheetThread)}
            />
          </View>
        </Sheet>
      ) : null}
      <RenameSessionDialog
        visible={renameTarget !== null}
        initialTitle={renameTarget?.title ?? ''}
        error={renameError}
        onCancel={() => setRenameTarget(null)}
        onSubmit={submitRename}
        testID="rename-local-thread-dialog"
      />
      <Dialog
        visible={clearTarget !== null}
        title="清空对话"
        description={
          clearTarget
            ? `确定要清空「${titleOf(clearTarget)}」的全部消息吗？清空后无法恢复。`
            : undefined
        }
        onDismiss={() => setClearTarget(null)}
        testID="clear-local-thread-dialog"
        actions={[
          {
            label: '取消',
            variant: 'ghost',
            onPress: () => setClearTarget(null),
            testID: 'clear-local-thread-cancel',
          },
          {
            label: '清空',
            variant: 'danger',
            onPress: confirmClear,
            testID: 'clear-local-thread-confirm',
          },
        ]}
      />
      <Dialog
        visible={deleteTarget !== null}
        title="删除对话"
        description={
          deleteTarget
            ? `确定要删除「${titleOf(deleteTarget)}」吗？删除后无法恢复。`
            : undefined
        }
        onDismiss={() => setDeleteTarget(null)}
        testID="delete-local-thread-dialog"
        actions={[
          {
            label: '取消',
            variant: 'ghost',
            onPress: () => setDeleteTarget(null),
            testID: 'delete-local-thread-cancel',
          },
          {
            label: '删除',
            variant: 'danger',
            onPress: confirmDelete,
            testID: 'delete-local-thread-confirm',
          },
        ]}
      />
    </>
  );

  return { openActions, layer };
}

export default useLocalThreadOpsController;
