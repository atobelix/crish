// 工作区选择 Sheet：已授权根列表 + 当前活动标记。
// 长列表跟模型表同一窗口：锁住高度后由 FlatList 只挂可见行。
import { memo, useCallback, useRef } from 'react';
import { FlatList } from 'react-native';
import type { WorkspaceEntry } from '@crish/shared-types';
import { useTheme } from '@/adapters/platform/theme';
import {
  AppText,
  ErrorState,
  Icon,
  ListRow,
  LoadingState,
  Sheet,
} from '@/presentation/ui';
import {
  SHEET_LIST_BATCH,
  SHEET_LIST_INITIAL,
  SHEET_LIST_WINDOW,
  useLargeSheetListBudget,
} from '@/presentation/ui/sheetListWindow';

export interface WorkspaceSheetProps {
  visible: boolean;
  onClose: () => void;
  onCloseComplete?: () => void;
  workspaces: readonly WorkspaceEntry[] | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  activeRoot: string | null;
  switching: boolean;
  onSelect: (root: string) => void;
  onRetry: () => void;
}

const WorkspaceOptionRow = memo(function WorkspaceOptionRow({
  workspace,
  selected,
  switching,
  divider,
  testID,
  onSelect,
}: {
  workspace: WorkspaceEntry;
  selected: boolean;
  switching: boolean;
  divider: boolean;
  testID: string;
  onSelect: (root: string) => void;
}) {
  const theme = useTheme();
  const onPress = useCallback(() => {
    if (switching) return;
    onSelect(workspace.root);
  }, [onSelect, switching, workspace.root]);
  return (
    <ListRow
      testID={testID}
      title={workspace.name ?? workspace.root}
      subtitle={workspace.root}
      divider={divider}
      onPress={onPress}
      trailing={
        selected ? (
          <Icon name="check" size={16} color={theme.colors.actionPrimary} />
        ) : undefined
      }
    />
  );
});

export function WorkspaceSheet({
  visible,
  onClose,
  onCloseComplete,
  workspaces,
  status,
  activeRoot,
  switching,
  onSelect,
  onRetry,
}: WorkspaceSheetProps) {
  const listMaxHeight = useLargeSheetListBudget();
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectRoot = useCallback((root: string) => {
    onSelectRef.current(root);
  }, []);
  const keyExtractor = useCallback((item: WorkspaceEntry) => item.root, []);
  const renderWorkspace = useCallback(
    ({ item, index }: { item: WorkspaceEntry; index: number }) => (
      <WorkspaceOptionRow
        workspace={item}
        selected={item.root === activeRoot}
        switching={switching}
        divider={index < (workspaces?.length ?? 0) - 1}
        testID={`workspace-sheet-row-${index}`}
        onSelect={selectRoot}
      />
    ),
    [activeRoot, selectRoot, switching, workspaces?.length]
  );
  const rows = workspaces ?? [];
  const virtualize = rows.length > SHEET_LIST_INITIAL;
  return (
    <Sheet
      keyboard="none"
      visible={visible}
      onClose={onClose}
      onCloseComplete={onCloseComplete}
      title="工作区"
      size="large"
      measureKey="workspace-sheet"
      contentKey={`${status}:${rows.length}`}
    >
      {status === 'loading' || status === 'idle' ? (
        <LoadingState compact />
      ) : status === 'error' ? (
        <ErrorState compact title="无法获取工作区" onRetry={onRetry} />
      ) : rows.length > 0 ? (
        <FlatList
          testID="workspace-sheet-list"
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderWorkspace}
          extraData={`${activeRoot ?? ''}:${switching ? 1 : 0}`}
          style={
            virtualize
              ? { height: listMaxHeight }
              : { maxHeight: listMaxHeight }
          }
          nestedScrollEnabled={virtualize}
          scrollEnabled={virtualize}
          initialNumToRender={SHEET_LIST_INITIAL}
          maxToRenderPerBatch={SHEET_LIST_BATCH}
          windowSize={SHEET_LIST_WINDOW}
          keyboardShouldPersistTaps="handled"
        />
      ) : (
        <AppText variant="body" color="textSecondary">
          没有已授权的工作区
        </AppText>
      )}
    </Sheet>
  );
}

export default WorkspaceSheet;
