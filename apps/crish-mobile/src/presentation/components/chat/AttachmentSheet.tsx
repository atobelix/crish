// 附件菜单（G5b 落点，批 A 2026-11-03 改锚定 Popover 形态）：
// Composer ＋ 入口打开的二级选择面（拍照 / 相册 / 文件三入口格 +
// 技能行）。原形态是底部 Sheet（RN Modal）——开菜单即键盘落下，选完
// 键盘再升起，一次点选一轮升降（深比 01-3 的浮层双政策要消灭的
// 正是这个）。现按「保键盘浮层」政策改锚定呈现：
// - 本组件由宿主渲染在 KeyboardStickyView 内（composer 正上方、同窗
//   内流），开合不经 Modal、不 blur 输入框——键盘全程不动，菜单随
//   StickyView 逐帧贴在键盘上方（键盘高度天然算进布局，无第二时钟）；
// - 进出场走 Collapsible（height+opacity 同曲线），关闭路径三条：
//   再点 ＋（宿主 toggle)、点任一入口（先关再执行）、发送（宿主关）；
//   内流形态没有全屏关闭层，这是锚定形态的取舍（菜单与 composer
//   同属一个输入上下文，键盘/输入框始终可用）；
// - 三入口点击后先关菜单再拉起系统选择器——系统 UI 接管后键盘如何
//   属系统层（换上下文类，交接在选择器返回后由下一次聚焦自然重连）；
// - 技能行打开技能目录 Sheet：Sheet 是换上下文类，走 ui/Sheet 的
//   键盘交接协议（等键盘 settle + 1 帧再呈现、关后不自动重弹）。
// 数值口径（M3 登记的原型附件格）：卡底 fillSubtle（浅色 #f9f9f9）、
// 圆角 18（radius.menu）、3 列等分、列间距 10（space.sm + 2 派生）、
// 图标 32、标签 13/500；菜单卡本体 = surfaceRaised + radius.menu，
// 无阴影（不在六个 sanctioned 阴影面之列，内流面同附件条先例）。
// 技能行副文案 = 目录总数（已拉取时），不是原型写死的「N 个已启
// 用」——启停生效值在桌面端本地、宿主无数据面，不编造启用计数。
import { useId } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Collapsible, Icon, type IconName } from '@/presentation/ui';
import { usePressFade } from '@/presentation/ui/pressFeedback';
import { useOverlayRegistration } from '@/presentation/ui/overlayStack';

export interface AttachmentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 三入口：本组件先关菜单再回调，宿主在回调里拉起系统选择器 */
  onTakePhoto: () => void;
  onPickImage: () => void;
  onPickFile: () => void;
  /** 技能行（G7）：提供 onOpenSkills 才渲染；点击先关菜单再回调 */
  onOpenSkills?: () => void;
  /** 技能目录总数（已拉取时用于行副文案；未拉取 = null，不编造） */
  skillsCount?: number | null;
  testID?: string;
}

/** M3 登记的附件格图标边长（theme 无 32 档，就地定值，同 Sheet 关闭钮 30 先例） */
const GRID_ICON_SIZE = 32;

const ENTRIES: readonly {
  key: string;
  icon: IconName;
  label: string;
  action: 'camera' | 'library' | 'files';
}[] = [
  { key: 'camera', icon: 'camera', label: '拍照', action: 'camera' },
  { key: 'library', icon: 'image', label: '相册', action: 'library' },
  { key: 'files', icon: 'file', label: '文件', action: 'files' },
];

export function AttachmentSheet({
  visible,
  onClose,
  onTakePhoto,
  onPickImage,
  onPickFile,
  onOpenSkills,
  skillsCount = null,
  testID = 'attachment-sheet',
}: AttachmentSheetProps) {
  const theme = useTheme();
  // 覆盖层登记（批 D）：锚点 Popover 与 Sheet/菜单同栈——系统返回
  // 先关本菜单（根布局注册表 BackHandler 分发），与 Modal 型浮层
  // 同一口径；内流形态原有的三条关闭路径不变
  const overlayId = useId();
  useOverlayRegistration(overlayId, visible, {
    dismissible: true,
    onRequestClose: onClose,
  });
  const handlerOf = {
    camera: onTakePhoto,
    library: onPickImage,
    files: onPickFile,
  } as const;
  return (
    <Collapsible visible={visible}>
      <View
        testID={testID}
        style={[
          styles.menuCard,
          {
            borderRadius: theme.radius.menu,
            backgroundColor: theme.colors.surfaceRaised,
            padding: theme.space.md,
            marginBottom: theme.space.sm,
          },
        ]}
      >
        <View style={[styles.grid, { gap: theme.space.sm + 2 }]}>
          {ENTRIES.map((entry) => (
            <AttachmentEntryCard
              key={entry.key}
              testID={`${testID}-${entry.key}`}
              label={entry.label}
              icon={entry.icon}
              onPress={() => {
                onClose();
                handlerOf[entry.action]();
              }}
            />
          ))}
        </View>
        {onOpenSkills ? (
          <SkillsEntryRow
            testID={`${testID}-skills`}
            skillsCount={skillsCount}
            onPress={() => {
              onClose();
              onOpenSkills();
            }}
          />
        ) : null}
      </View>
    </Collapsible>
  );
}

/** 附件入口格（列表项内独立组件：按压叠层 hook 不得进 map 回调） */
function AttachmentEntryCard({
  testID,
  label,
  icon,
  onPress,
}: {
  testID: string;
  label: string;
  icon: IconName;
  onPress: () => void;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.card,
        {
          borderRadius: theme.radius.menu,
          backgroundColor: theme.colors.fillSubtle,
          paddingVertical: theme.space.lg,
          gap: theme.space.sm,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.menu,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <Icon
        name={icon}
        size={GRID_ICON_SIZE}
        color={theme.colors.textSecondary}
      />
      <AppText variant="footnote" style={styles.label}>
        {label}
      </AppText>
    </Pressable>
  );
}

/** 技能行入口：常驻透明底 + 按压叠层 120ms 过渡 */
function SkillsEntryRow({
  testID,
  skillsCount,
  onPress,
}: {
  testID: string;
  skillsCount: number | null;
  onPress: () => void;
}) {
  const theme = useTheme();
  const press = usePressFade();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="技能"
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.skillsRow,
        {
          borderRadius: theme.radius.menu,
          paddingVertical: theme.space.md,
          paddingHorizontal: theme.space.sm,
          marginTop: theme.space.sm,
          gap: theme.space.md,
        },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.menu,
            backgroundColor: theme.colors.fillPressed,
          },
          press.overlayStyle,
        ]}
      />
      <Icon
        name="sparkles"
        size={theme.size.icon}
        color={theme.colors.textSecondary}
      />
      <View style={styles.skillsText}>
        <AppText variant="body">技能</AppText>
        {skillsCount !== null ? (
          <AppText variant="caption" color="textTertiary">
            {`${skillsCount} 个技能`}
          </AppText>
        ) : null}
      </View>
      <Icon
        name="chevron-right"
        size={theme.size.iconSmall}
        color={theme.colors.textTertiary}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  menuCard: {},
  grid: {
    flexDirection: 'row',
  },
  skillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  skillsText: {
    flex: 1,
  },
  card: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    // M3 登记 13/500：footnote 档字号 13，字重以 500 覆盖（既有口径）
    fontWeight: '500',
  },
});

export default AttachmentSheet;
