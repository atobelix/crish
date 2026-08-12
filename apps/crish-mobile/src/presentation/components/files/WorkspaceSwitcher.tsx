// 工作区选择器（R2-06b，F4 §6.1 工作区列表 + F4-F02 切换）：
// - 底部弹层 + 半透明遮罩（M4 弹层通用形态；点击遮罩关闭）；
// - 数据面：workspaces（F4-F01 已授权根列表，listWorkspaces）+ 装载四态
//   （loading/empty/error/loaded，F4-F03 未授权/不可达引导文案）；
// - 行：工作区名（路径叶名）+ 完整路径 + 当前活动标记（F4 §6.1 卡片信息）；
//   点击 → onSelect(root)（切换由 VM 执行：switchWorkspace → resetWorkspace）；
// - 切换中禁用（switchingWorkspace busy，F2 §9.3-3 防双点）；
// - 空态：无已授权工作区 → 「请先在桌面端添加项目工作区」（F4 §6.1 引导）。
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { WorkspaceEntry } from '../../../../../../packages/shared-types/src/generated/device/types';
import type { WorkspacesStatus } from '@/adapters/viewmodels/useFilesVm';
import { workspaceNameOf } from '@/adapters/wiring/filesWiring';
import { useTheme } from '@/adapters/platform/theme';
import { mapFilesErrorCode } from './fileMeta';

export interface WorkspaceSwitcherProps {
  workspaces: readonly WorkspaceEntry[] | null;
  status: WorkspacesStatus;
  /** 列表装载错误码（status === 'error' 时展示，F4-F03） */
  errorCode: string | null;
  /** 当前活动根（活动标记数据面） */
  activeRoot: string | null;
  /** 切换进行中（禁用行点击，防双点） */
  switching: boolean;
  onClose: () => void;
  onSelect: (root: string) => void;
  /** 列表重试（error 态） */
  onRetry: () => void;
}

/** 工作区卡片信息（名称/路径/活动标记，F4 §6.1） */
export function workspaceCard(
  ws: WorkspaceEntry,
  activeRoot: string | null
): { name: string; path: string; active: boolean } {
  return {
    name: ws.name ?? workspaceNameOf(ws.root),
    path: ws.root,
    active: ws.active || ws.root === activeRoot,
  };
}

export function WorkspaceSwitcher({
  workspaces,
  status,
  errorCode,
  activeRoot,
  switching,
  onClose,
  onSelect,
  onRetry,
}: WorkspaceSwitcherProps) {
  const theme = useTheme();
  const loaded = status === 'loaded' && workspaces !== null;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        testID="workspace-backdrop"
        accessibilityLabel="关闭工作区选择器"
        style={styles.backdrop}
        onPress={onClose}
      />
      <View
        testID="workspace-sheet"
        style={[styles.sheet, { backgroundColor: theme.bgElevated }]}
      >
        <View
          style={[styles.handle, { backgroundColor: theme.hairlineStrong }]}
        />
        <View style={[styles.header, { borderBottomColor: theme.hairline }]}>
          <Text style={[styles.title, { color: theme.textPrimary }]}>
            工作区
          </Text>
          <Pressable
            testID="workspace-close"
            accessibilityRole="button"
            accessibilityLabel="关闭"
            onPress={onClose}
            style={({ pressed }) => [
              styles.closeBtn,
              { borderColor: theme.hairlineStrong },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[styles.closeText, { color: theme.textPrimary }]}>
              ✕
            </Text>
          </Pressable>
        </View>

        {status === 'loading' ? (
          <View testID="workspace-loading" style={styles.center}>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              加载中…
            </Text>
          </View>
        ) : status === 'error' ? (
          <View testID="workspace-error" style={styles.center}>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              {mapFilesErrorCode(errorCode).title}
            </Text>
            <Pressable
              testID="workspace-retry"
              accessibilityRole="button"
              accessibilityLabel="重试"
              onPress={onRetry}
              style={({ pressed }) => [
                styles.retryButton,
                { borderColor: theme.colorSuccess },
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text style={[styles.retryText, { color: theme.colorSuccess }]}>
                重试
              </Text>
            </Pressable>
          </View>
        ) : !loaded || workspaces.length === 0 ? (
          <View testID="workspace-empty" style={styles.center}>
            <Text style={[styles.hint, { color: theme.textSecondary }]}>
              请先在桌面端添加项目工作区（F4 §6.1）
            </Text>
          </View>
        ) : (
          <FlatList
            testID="workspace-list"
            data={workspaces}
            keyExtractor={(ws) => ws.root}
            renderItem={({ item }) => {
              const card = workspaceCard(item, activeRoot);
              return (
                <Pressable
                  testID="workspace-item"
                  accessibilityRole="button"
                  accessibilityState={{
                    selected: card.active,
                    disabled: switching,
                  }}
                  accessibilityLabel={`${card.name}${card.active ? '，当前活动' : ''}`}
                  disabled={switching}
                  onPress={() => onSelect(item.root)}
                  style={({ pressed }) => [
                    styles.item,
                    { borderBottomColor: theme.hairline },
                    pressed && !switching && { opacity: 0.7 },
                  ]}
                >
                  <View style={styles.itemMain}>
                    <Text
                      numberOfLines={1}
                      style={[styles.itemName, { color: theme.textPrimary }]}
                    >
                      {card.name}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={[styles.itemPath, { color: theme.textTertiary }]}
                    >
                      {card.path}
                    </Text>
                  </View>
                  {card.active ? (
                    <Text
                      testID="workspace-active"
                      style={[
                        styles.activeBadge,
                        { color: theme.colorSuccess },
                      ]}
                    >
                      活动中
                    </Text>
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    marginBottom: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    fontSize: 14,
  },
  center: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: 24,
    gap: 10,
  },
  hint: {
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  retryButton: {
    minHeight: 40,
    borderRadius: 9999,
    borderWidth: 1,
    paddingHorizontal: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: {
    fontSize: 14,
    fontWeight: '600',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingHorizontal: 16,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  itemMain: {
    flex: 1,
    gap: 2,
  },
  itemName: {
    fontSize: 15,
    fontWeight: '500',
  },
  itemPath: {
    fontSize: 12,
  },
  activeBadge: {
    fontSize: 12,
    fontWeight: '600',
  },
});
