// 文件浏览主组件（R2-06b，F4 §6.2 文件浏览页）：
// - 虚拟列表：RN 内置 FlatList（FlashList 未引入，D4 依赖清单无——EventFeed
//   同款基建注释），固定行高（密度三档 44/48/56，默认 48，R2UX-06-01）
//   getItemLayout + initialNumToRender/maxToRenderPerBatch/windowSize 窗口参数；
//   目录缓存 LRU 128 层由接线层保证（F4 §5.2），本组件只负责窗口化渲染；
// - 排序条（F4-F13）：名称（默认目录优先+名称，F4 §2.2）/ 修改时间倒序 /
//   大小倒序 + 密度三档循环切换（设置联动可后置）；
// - 四态（R2UX-06-07 + 任务书）：未连接（transport.closed 投影）/ 加载 /
//   空态（「该目录为空」+ 刷新）/ 错误（横幅文案 + 重试）——全部渲染在
//   FlatList ListEmptyComponent 内，下拉刷新（RefreshControl）任意态可用；
// - 行交互（F4 §6.2）：目录 → enterDir（push 导航）；文件 → onOpenFile（预览）。
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { FileEntry } from '@/domain/types/domain';
import type { DirLoadStatus, DirSortMode } from '@/domain/store/filesReducers';
import type { FilesVm, RowDensity } from '@/adapters/viewmodels/useFilesVm';
import { useTheme } from '@/adapters/platform/theme';
import { mapFilesErrorCode } from './fileMeta';
import { FileBreadcrumb } from './FileBreadcrumb';
import { FileRow } from './FileRow';
import { dualHitSlop } from '@/presentation/components/ui/hitTargets';

// ── 四态派生（纯函数导出供单测，R2UX-06-07） ─────────────────────────────

export type BrowserView =
  'disconnected' | 'error' | 'loading' | 'empty' | 'list';

/**
 * 浏览区视图态（优先级：未连接 > 错误 > 加载 > 空态 > 列表）：
 * - 未连接：connectionStore 相位非 ready（任务书「未接连接时显示未连接错误态」）；
 * - 错误：工作区错误（未授权/切换失败）或当前层加载失败（可重试）；
 * - 空态：loaded 且条目为空（「该目录为空」+ 刷新）。
 */
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

// ── 排序 / 密度条 ─────────────────────────────────────────────────────────

const SORT_OPTIONS: ReadonlyArray<{
  mode: DirSortMode;
  label: string;
  testID: string;
}> = [
  { mode: 'name', label: '名称', testID: 'sort-name' },
  { mode: 'mtime-desc', label: '修改时间', testID: 'sort-mtime' },
  { mode: 'size-desc', label: '大小', testID: 'sort-size' },
];

/** 密度循环：44 → 48 → 56 → 44（设置联动可后置，默认 48） */
export function nextDensity(current: RowDensity): RowDensity {
  if (current === 44) return 48;
  if (current === 48) return 56;
  return 44;
}

function SortBar({
  sortMode,
  density,
  onSortChange,
  onDensityChange,
}: {
  sortMode: DirSortMode;
  density: RowDensity;
  onSortChange: (mode: DirSortMode) => void;
  onDensityChange: (density: RowDensity) => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.sortBar, { borderBottomColor: theme.hairline }]}>
      {SORT_OPTIONS.map((opt) => {
        const active = sortMode === opt.mode;
        return (
          <Pressable
            key={opt.mode}
            testID={opt.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`按${opt.label}排序`}
            onPress={() => onSortChange(opt.mode)}
            hitSlop={dualHitSlop(32)}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: active ? theme.colorSuccess : theme.hairlineStrong,
              },
              active && { backgroundColor: theme.colorSuccessBg },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text
              style={[
                styles.chipText,
                { color: active ? theme.colorSuccess : theme.textSecondary },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
      <View style={styles.spacer} />
      <Pressable
        testID="density-toggle"
        accessibilityRole="button"
        accessibilityLabel={`列表密度 ${density}，点击切换`}
        onPress={() => onDensityChange(nextDensity(density))}
        hitSlop={dualHitSlop(32)}
        style={({ pressed }) => [
          styles.chip,
          { borderColor: theme.hairlineStrong },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.chipText, { color: theme.textSecondary }]}>
          密度 {density}
        </Text>
      </Pressable>
    </View>
  );
}

// ── 四态视图 ──────────────────────────────────────────────────────────────

function StateView({
  view,
  errorCode,
  onRetry,
  onRetryConnect,
  onRefresh,
}: {
  view: BrowserView;
  errorCode: string | null;
  onRetry: () => void;
  onRetryConnect: () => void;
  onRefresh: () => void;
}) {
  const theme = useTheme();
  if (view === 'list') return null; // 列表态不由 StateView 渲染
  if (view === 'disconnected') {
    return (
      <View testID="files-error-state" style={styles.stateWrap}>
        <Text style={[styles.stateTitle, { color: theme.textPrimary }]}>
          未连接
        </Text>
        <Text style={[styles.stateHint, { color: theme.textSecondary }]}>
          与桌面端连接已断开，请检查网络后重试
        </Text>
        <Pressable
          testID="files-retry-connect"
          accessibilityRole="button"
          accessibilityLabel="重新连接"
          onPress={onRetryConnect}
          hitSlop={dualHitSlop(40)}
          style={({ pressed }) => [
            styles.stateButton,
            { borderColor: theme.colorSuccess },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={[styles.stateButtonText, { color: theme.colorSuccess }]}>
            重新连接
          </Text>
        </Pressable>
      </View>
    );
  }
  if (view === 'error') {
    const text = mapFilesErrorCode(errorCode);
    return (
      <View testID="files-error-state" style={styles.stateWrap}>
        <Text style={[styles.stateTitle, { color: theme.textPrimary }]}>
          {text.title}
        </Text>
        <Text style={[styles.stateHint, { color: theme.textSecondary }]}>
          {text.hint}
        </Text>
        <Pressable
          testID="files-retry"
          accessibilityRole="button"
          accessibilityLabel="重试"
          onPress={onRetry}
          hitSlop={dualHitSlop(40)}
          style={({ pressed }) => [
            styles.stateButton,
            { borderColor: theme.colorSuccess },
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={[styles.stateButtonText, { color: theme.colorSuccess }]}>
            重试
          </Text>
        </Pressable>
      </View>
    );
  }
  if (view === 'loading') {
    return (
      <View testID="files-loading-state" style={styles.stateWrap}>
        <Text style={[styles.stateHint, { color: theme.textSecondary }]}>
          加载中…
        </Text>
      </View>
    );
  }
  return (
    <View testID="files-empty-state" style={styles.stateWrap}>
      <Text style={[styles.stateTitle, { color: theme.textPrimary }]}>
        该目录为空
      </Text>
      <Text style={[styles.stateHint, { color: theme.textSecondary }]}>
        没有文件或子目录（F4 §6.2 空态口径）
      </Text>
      <Pressable
        testID="files-empty-refresh"
        accessibilityRole="button"
        accessibilityLabel="刷新"
        onPress={onRefresh}
        hitSlop={dualHitSlop(40)}
        style={({ pressed }) => [
          styles.stateButton,
          { borderColor: theme.colorSuccess },
          pressed && { opacity: 0.7 },
        ]}
      >
        <Text style={[styles.stateButtonText, { color: theme.colorSuccess }]}>
          刷新
        </Text>
      </Pressable>
    </View>
  );
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export interface FileBrowserProps {
  vm: FilesVm;
  /** 文件行点击 → 打开预览（R2UX-06-02 按需加载入口） */
  onOpenFile: (entry: FileEntry) => void;
}

export function FileBrowser({ vm, onOpenFile }: FileBrowserProps) {
  const theme = useTheme();
  const view = browserViewState(
    vm.connected,
    vm.errorCode,
    vm.status,
    vm.entries.length
  );
  const showList = view === 'list';

  const handleRowPress = (entry: FileEntry): void => {
    if (entry.isDir) {
      vm.enterDir(entry.relPath);
    } else {
      onOpenFile(entry);
    }
  };

  return (
    <View style={styles.container}>
      <FileBreadcrumb
        history={vm.history}
        workspaceName={vm.workspaceName}
        backEnabled={vm.canGoBack}
        onBack={vm.back}
        onSelectSegment={vm.jumpTo}
      />
      <SortBar
        sortMode={vm.sortMode}
        density={vm.density}
        onSortChange={vm.setSortMode}
        onDensityChange={vm.setDensity}
      />
      <FlatList
        testID="files-list"
        data={showList ? vm.entries : []}
        keyExtractor={(entry) => entry.relPath}
        renderItem={({ item }) => (
          <FileRow
            entry={item}
            rowHeight={vm.density}
            onPress={handleRowPress}
          />
        )}
        getItemLayout={(_data, index) => ({
          length: vm.density,
          offset: vm.density * index,
          index,
        })}
        initialNumToRender={14}
        maxToRenderPerBatch={14}
        windowSize={7}
        refreshing={vm.refreshing}
        onRefresh={vm.refresh}
        ListEmptyComponent={
          <StateView
            view={view}
            errorCode={vm.errorCode}
            onRetry={vm.retry}
            onRetryConnect={vm.retryConnect}
            onRefresh={vm.refresh}
          />
        }
        style={{ backgroundColor: theme.bgPrimary }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  sortBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    minHeight: 32,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: {
    fontSize: 12,
    fontWeight: '500',
  },
  spacer: {
    flex: 1,
  },
  stateWrap: {
    alignItems: 'center',
    paddingVertical: 64,
    paddingHorizontal: 24,
    gap: 10,
  },
  stateTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  stateHint: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  stateButton: {
    marginTop: 8,
    minHeight: 40,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
