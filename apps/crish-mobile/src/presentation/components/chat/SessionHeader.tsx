// 统一对话屏悬浮头栏（移动界面统一方案 §7，由 SessionHeader 演进为
// ConversationHeader；文件名沿旧名——原生阴影守卫按路径点名本文件，
// 改名留待守卫口径统一时处理）：完全通透，无底色、无边界，浮于滚动流
// 之上；汉堡圆钮（开抽屉，代原返回钮）+ 纯白标题胶囊 + 新建对话圆钮 +
// 更多圆钮。返回路径由抽屉/新建/系统返回兜底（方案 §2.3）。
// 阴影口径（SVG 软阴影收编定案）：标题胶囊是原型点名的悬浮面之一——
// Android 浅色经 SoftShadow 出原型两层极淡投影（实测宽度到手才渲染），
// 填充由胶囊 backgroundColor 单一承担（surfaceRaised）；深色 SoftShadow
// 内部短路、区分回归亮度台阶；iOS 无阴影。两侧圆钮（汉堡钮/新建/更多）
// 均为 floating 圆钮，阴影由 IconButton floating 自带 SoftShadow（button 档）。
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, IconButton, SoftShadow } from '@/presentation/ui';
import type { AnchorRect } from '@/presentation/ui/dropdownLayout';

export interface ConversationHeaderProps {
  title: string;
  /** 返回钮（2026-11-05 导航语义矩阵）：栈内确有上一界面时由宿主注入，
   *  点击 = useSafeBack（回到上一个打开的界面）；缺省 = 无栈可回（冷启动
   *  深链），诚实不渲染 */
  onBack?: () => void;
  /** 汉堡钮：打开 (main) 抽屉（全 App 顶栏左侧语义收敛为开抽屉） */
  onOpenDrawer: () => void;
  /** 新建对话（回主页新对话面） */
  onNewConversation: () => void;
  /** 更多菜单触发（菜单本体由调用方渲染，锚点见 DropdownMenu anchorRect） */
  onMore: () => void;
  /** 更多按钮物理锚点矩形变化通知（用于 DropdownMenu 像素级对齐） */
  onMoreAnchorChange?: (rect: AnchorRect) => void;
  /** 标题胶囊内尾随元素（预留） */
  trailing?: ReactNode;
  testID?: string;
}

export function ConversationHeader({
  title,
  onBack,
  onOpenDrawer,
  onNewConversation,
  onMore,
  onMoreAnchorChange,
  trailing,
  testID,
}: ConversationHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const moreBtnRef = useRef<View | null>(null);
  // Android 软阴影需要实测宽度（胶囊宽随标题长度变化），onLayout 捕获后渲染
  const [pillWidth, setPillWidth] = useState(0);
  const pillHeight = theme.size.barAction + 2;

  const handleMore = useCallback(() => {
    moreBtnRef.current?.measureInWindow?.((x, y, width, height) => {
      if (width > 0 && height > 0) {
        onMoreAnchorChange?.({ x, y, width, height });
      }
    });
    onMore();
  }, [onMore, onMoreAnchorChange]);
  return (
    <View
      testID={testID}
      pointerEvents="box-none"
      style={[
        styles.anchor,
        {
          top: insets.top,
          paddingLeft: theme.space.lg + insets.left,
          paddingRight: theme.space.lg + insets.right,
        },
      ]}
    >
      <View style={styles.row}>
        {/* 左侧复合簇：[返回（栈可回时）] 菜单按钮 + 紧随其后的对话标题胶囊
            （取消居中，自然左对齐流） */}
        <View style={[styles.leftCluster, { gap: theme.space.sm }]}>
          {onBack ? (
            <IconButton
              name="chevron-left"
              variant="floating"
              accessibilityLabel="返回上一界面"
              onPress={onBack}
              testID="session-back"
            />
          ) : null}
          <IconButton
            name="menu"
            variant="floating"
            accessibilityLabel="打开菜单"
            onPress={onOpenDrawer}
            testID="session-drawer"
          />

          {/* 标题胶囊：纯白、仅文字，无任何多余图标；自适应收缩与超长截断 */}
          <View
            onLayout={(e) => setPillWidth(e.nativeEvent.layout.width)}
            style={[
              styles.titlePill,
              {
                height: pillHeight,
                borderRadius: theme.radius.pill,
                // 填充单一绘制点（surfaceRaised）；Android 浅色的投影由
                // 下方 SoftShadow 承担，深色/iOS 靠本亮度台阶区分
                backgroundColor: theme.colors.surfaceRaised,
                paddingHorizontal: theme.space.lg,
              },
            ]}
          >
            {/* Android SVG 软阴影（全 App 唯一阴影路径）：最底层，只画
                阴影不绘填充（填充由上方 backgroundColor 单一承担） */}
            {Platform.OS === 'android' && pillWidth > 0 ? (
              <SoftShadow
                width={pillWidth}
                height={pillHeight}
                borderRadius={pillHeight / 2}
              />
            ) : null}
            <AppText
              variant="barAction"
              numberOfLines={1}
              style={styles.titleText}
            >
              {title}
            </AppText>
            {trailing ?? null}
          </View>
        </View>

        {/* 右侧动作簇：新建会话 + 更多菜单（高优先级显示空间，永不位移压缩） */}
        <View style={[styles.rightCluster, { gap: theme.space.sm }]}>
          <IconButton
            name="add"
            variant="floating"
            accessibilityLabel="新建对话"
            onPress={onNewConversation}
            testID="session-new"
          />
          <View ref={moreBtnRef} collapsable={false}>
            <IconButton
              name="more"
              variant="floating"
              accessibilityLabel="会话选项"
              onPress={handleMore}
              testID="session-more"
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  anchor: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 20,
  },
  row: {
    // 原型 conv-top-bar 栏高 48（本组件专值；通用顶栏档 size.header=52 归
    // AppHeader/AuthBar 等消费方，本组件不随之，M8 收口核定）
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  leftCluster: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0, // 拦截溢出关键
    marginRight: 12, // 与右侧簇保持呼吸间隙
  },
  titlePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    flexShrink: 1, // 自适应压缩
  },
  titleText: {
    flexShrink: 1,
  },
  rightCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
});

export default ConversationHeader;
