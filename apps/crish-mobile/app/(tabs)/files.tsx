import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import { useFilesVm } from '@/adapters/viewmodels/useFilesVm';
import { useFilePreviewVm } from '@/adapters/viewmodels/useFilePreviewVm';
import { useTheme } from '@/adapters/platform/theme';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';
import {
  FileBrowser,
  FilePreview,
  WorkspaceSwitcher,
} from '@/presentation/components/files';

// 文件浏览（R2-06 落地，F4 §6 交互）：工作区切换 + 目录树虚拟列表 + 文件预览
// - 浏览态：FileBrowser（面包屑导航/排序/四态/下拉刷新）+ 顶部工作区选择器入口；
// - 预览态：点击文件行进入（按需加载，R2UX-06-02），返回列表缓存保留
//   （filesStore 内存态，X4-6 返回一致性）；
// - 接线：useFilesVm / useFilePreviewVm（WsGateway.invoke 注入，未连接 → 错误态）。
export default function FilesScreen() {
  const theme = useTheme();
  const vm = useFilesVm();
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const preview = useFilePreviewVm(openFile);

  if (openFile && preview.file) {
    return <FilePreview vm={preview} onBack={() => setOpenFile(null)} />;
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bgPrimary }]}>
      <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
        <Text style={[styles.title, { color: theme.textPrimary }]}>文件</Text>
        <Pressable
          testID="files-workspace-button"
          accessibilityRole="button"
          accessibilityLabel="切换工作区"
          hitSlop={dualHitSlop(36)}
          onPress={() => {
            vm.openWorkspaceList();
            setWorkspaceOpen(true);
          }}
          style={({ pressed }) => [
            styles.workspaceBtn,
            { borderColor: theme.hairlineStrong },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.workspaceText, { color: theme.textSecondary }]}
          >
            {vm.workspaceName ?? '选择工作区'} ▾
          </Text>
        </Pressable>
      </View>

      <FileBrowser vm={vm} onOpenFile={setOpenFile} />

      {workspaceOpen ? (
        <WorkspaceSwitcher
          workspaces={vm.workspaces}
          status={vm.workspacesStatus}
          errorCode={vm.workspacesError}
          activeRoot={vm.activeWorkspaceRoot}
          switching={vm.switchingWorkspace}
          onClose={() => setWorkspaceOpen(false)}
          onSelect={(root) => {
            vm.switchWorkspace(root);
            setWorkspaceOpen(false);
          }}
          onRetry={vm.openWorkspaceList}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: 16,
    paddingTop: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
  },
  workspaceBtn: {
    maxWidth: 220,
    minHeight: 36,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  workspaceText: {
    fontSize: 13,
    maxWidth: 180,
  },
});
