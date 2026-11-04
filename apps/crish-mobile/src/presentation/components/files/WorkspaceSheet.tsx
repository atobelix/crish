// 工作区选择 Sheet：已授权根列表 + 当前活动标记。
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

export interface WorkspaceSheetProps {
  visible: boolean;
  onClose: () => void;
  workspaces: readonly WorkspaceEntry[] | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  activeRoot: string | null;
  switching: boolean;
  onSelect: (root: string) => void;
  onRetry: () => void;
}

export function WorkspaceSheet({
  visible,
  onClose,
  workspaces,
  status,
  activeRoot,
  switching,
  onSelect,
  onRetry,
}: WorkspaceSheetProps) {
  const theme = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} title="工作区" size="large">
      {status === 'loading' || status === 'idle' ? (
        <LoadingState compact />
      ) : status === 'error' ? (
        <ErrorState compact title="无法获取工作区" onRetry={onRetry} />
      ) : workspaces && workspaces.length > 0 ? (
        workspaces.map((workspace, index) => {
          const active = workspace.root === activeRoot;
          return (
            <ListRow
              key={workspace.root}
              title={workspace.name ?? workspace.root}
              subtitle={workspace.root}
              divider={index < workspaces.length - 1}
              onPress={switching ? undefined : () => onSelect(workspace.root)}
              trailing={
                active ? (
                  <Icon
                    name="check"
                    size={16}
                    color={theme.colors.actionPrimary}
                  />
                ) : undefined
              }
            />
          );
        })
      ) : (
        <AppText variant="body" color="textSecondary">
          没有已授权的工作区
        </AppText>
      )}
    </Sheet>
  );
}

export default WorkspaceSheet;
