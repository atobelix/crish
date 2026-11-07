// 会话操作 Sheet（G3）：抽屉/主屏会话行长按的操作入口——与既有 Sheet
// 体系（WorkspaceSheet / ModelSheet）同形态：SheetOptionRow 纵列。
// 操作语义与桌面侧栏一致（同一存储层）：置顶切换即时生效、改名走输入
// 弹窗、归档后行从主列表消失、导出 Markdown 走系统分享、删除须经
// 确认弹窗（确认在本组件之外——点删除只发意图，不直接执行）。
import { View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { SessionSummary } from '@/domain/store/sessionReducers';
import { Sheet, SheetOptionRow } from '@/presentation/ui';

export interface SessionActionsSheetProps {
  visible: boolean;
  session: SessionSummary | null;
  onClose: () => void;
  onTogglePin: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onToggleArchive: (session: SessionSummary) => void;
  onExport: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  testID?: string;
}

export function SessionActionsSheet({
  visible,
  session,
  onClose,
  onTogglePin,
  onRename,
  onToggleArchive,
  onExport,
  onDelete,
  testID = 'session-actions-sheet',
}: SessionActionsSheetProps) {
  const theme = useTheme();
  if (!session) return null;
  const title = session.title?.trim() || '未命名会话';
  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      title={title}
      size="medium"
      testID={testID}
    >
      <View style={{ gap: theme.space.sm }}>
        <SheetOptionRow
          testID={`${testID}-pin`}
          label={session.isPinned ? '取消置顶' : '置顶会话'}
          onPress={() => onTogglePin(session)}
        />
        <SheetOptionRow
          testID={`${testID}-rename`}
          label="重命名"
          onPress={() => onRename(session)}
        />
        <SheetOptionRow
          testID={`${testID}-archive`}
          label={session.isArchived ? '取消归档' : '归档会话'}
          onPress={() => onToggleArchive(session)}
        />
        <SheetOptionRow
          testID={`${testID}-export`}
          label="导出 Markdown"
          onPress={() => onExport(session)}
        />
        <SheetOptionRow
          testID={`${testID}-delete`}
          label="删除会话"
          danger
          onPress={() => onDelete(session)}
        />
      </View>
    </Sheet>
  );
}

export default SessionActionsSheet;
