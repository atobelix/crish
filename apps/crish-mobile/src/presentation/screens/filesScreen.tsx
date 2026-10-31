// 文件：工作区切换、目录浏览、文本预览、排序。
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import { useFilesVm } from '@/adapters/viewmodels/useFilesVm';
import { useFilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import { useTheme } from '@/adapters/platform/theme';
import {
  AppHeader,
  AppText,
  Icon,
  IconButton,
  ListRow,
  Sheet,
} from '@/presentation/ui';
import { FileBrowser, FilePreview } from '@/presentation/components/files';
import { WorkspaceSheet } from '@/presentation/components/files/WorkspaceSheet';
import type { DirSortMode } from '@/domain/store/filesReducers';

const SORT_OPTIONS: ReadonlyArray<{ mode: DirSortMode; label: string }> = [
  { mode: 'name', label: '名称' },
  { mode: 'mtime-desc', label: '最近修改' },
  { mode: 'size-desc', label: '大小' },
];

export default function FilesScreen() {
  const theme = useTheme();
  const vm = useFilesVm();
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const preview = useFilePreviewVm(openFile);

  if (openFile && preview.file) {
    return (
      <View style={styles.flex}>
        <AppHeader
          title={preview.file.name}
          status={
            <AppText variant="caption" color="textTertiary" numberOfLines={1}>
              {preview.file.relPath}
            </AppText>
          }
          onBack={() => setOpenFile(null)}
        />
        <FilePreview
          vm={preview}
          onBack={() => setOpenFile(null)}
          showHeader={false}
        />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <AppHeader
        large
        title="文件"
        actions={
          <>
            <IconButton
              name="folder-open"
              accessibilityLabel="切换工作区"
              onPress={() => {
                vm.openWorkspaceList();
                setWorkspaceOpen(true);
              }}
              testID="files-workspace-button"
            />
            <IconButton
              name="sort"
              accessibilityLabel="排序"
              onPress={() => setSortOpen(true)}
              testID="files-sort-button"
            />
          </>
        }
      />
      <FileBrowser
        vm={vm}
        onOpenFile={setOpenFile}
        showBreadcrumb={vm.activeWorkspaceRoot !== null}
      />
      <WorkspaceSheet
        visible={workspaceOpen}
        onClose={() => setWorkspaceOpen(false)}
        workspaces={vm.workspaces}
        status={vm.workspacesStatus}
        activeRoot={vm.activeWorkspaceRoot}
        switching={vm.switchingWorkspace}
        onSelect={(root) => {
          vm.switchWorkspace(root);
          setWorkspaceOpen(false);
        }}
        onRetry={vm.openWorkspaceList}
      />
      <Sheet visible={sortOpen} onClose={() => setSortOpen(false)} title="排序">
        {SORT_OPTIONS.map((option, index) => {
          const active = vm.sortMode === option.mode;
          return (
            <ListRow
              key={option.mode}
              title={option.label}
              divider={index < SORT_OPTIONS.length - 1}
              onPress={() => {
                vm.setSortMode(option.mode);
                setSortOpen(false);
              }}
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
        })}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
