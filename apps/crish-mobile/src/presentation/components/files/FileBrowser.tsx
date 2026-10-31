// 文件浏览列表：面包屑 + 四态 + 下拉刷新。
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import type { DirLoadStatus } from '@/domain/store/filesReducers';
import type { FilesVm } from '@/adapters/viewmodels/useFilesVm';
import { useTheme } from '@/adapters/platform/theme';
import { Button, EmptyState, Spinner } from '@/presentation/ui';
import { mapFilesErrorCode } from './fileMeta';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileRow } from './FileRow';

export type BrowserView =
  'disconnected' | 'error' | 'loading' | 'empty' | 'list';

export function browserViewState(
  connected: boolean,
  errorCode: string | null,
  status: DirLoadStatus,
  entryCount: number
): BrowserView {
  if (!connected) return 'disconnected';
  if (errorCode) return 'error';
  if (status === 'idle' || status === 'loading') return 'loading';
  if (status === 'loaded' && entryCount === 0) return 'empty';
  return 'list';
}

export interface FileBrowserProps {
  vm: FilesVm;
  onOpenFile: (entry: FileEntry) => void;
  showBreadcrumb?: boolean;
}

export function FileBrowser({
  vm,
  onOpenFile,
  showBreadcrumb = true,
}: FileBrowserProps) {
  const theme = useTheme();
  const view = browserViewState(
    vm.connected,
    vm.errorCode,
    vm.status,
    vm.entries.length
  );

  const handleRowPress = (entry: FileEntry) => {
    if (entry.isDir) vm.enterDir(entry.relPath);
    else onOpenFile(entry);
  };

  return (
    <View style={styles.container}>
      {showBreadcrumb ? (
        <FileBreadcrumb
          history={vm.history}
          workspaceName={vm.workspaceName}
          backEnabled={vm.canGoBack}
          onBack={vm.back}
          onSelectSegment={vm.jumpTo}
        />
      ) : null}
      {view === 'list' ? (
        <FlatList
          testID="files-list"
          data={vm.entries as FileEntry[]}
          keyExtractor={(entry) => entry.relPath}
          renderItem={({ item, index }) => (
            <FileRow
              entry={item}
              onPress={handleRowPress}
              divider={index < vm.entries.length - 1}
            />
          )}
          contentContainerStyle={{ paddingBottom: theme.space.xxl }}
          refreshControl={
            <RefreshControl
              refreshing={vm.refreshing}
              onRefresh={vm.refresh}
              tintColor={theme.colors.textTertiary}
            />
          }
        />
      ) : (
        <View style={styles.state}>
          {view === 'loading' ? (
            <Spinner />
          ) : view === 'disconnected' ? (
            <EmptyState
              title="未连接"
              action={
                <Button
                  label="重新连接"
                  variant="secondary"
                  onPress={vm.retryConnect}
                />
              }
            />
          ) : view === 'error' ? (
            <EmptyState
              title={mapFilesErrorCode(vm.errorCode).title}
              action={
                <Button label="重试" variant="secondary" onPress={vm.retry} />
              }
            />
          ) : (
            <EmptyState
              title="该目录为空"
              action={
                <Button label="刷新" variant="secondary" onPress={vm.refresh} />
              }
            />
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  state: {
    flex: 1,
    justifyContent: 'center',
  },
});

export default FileBrowser;
