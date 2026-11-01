// 附件面板（G5b）：Composer ＋ 入口打开的底部 Sheet，三入口格布局。
// 数值口径（M3 登记的原型附件格）：卡底 fillSubtle（浅色 #f9f9f9）、
// 圆角 18（radius.menu）、3 列等分、列间距 10（space.sm + 2 派生，
// 与主屏 headerGroup 同派生式）、图标 32、标签 13/500（footnote 档
// 13 + fontWeight 500 覆盖，SheetOptionRow 既有口径）。
// 入口三项：拍照（camera）/ 相册（image）/ 文件（file）。点击后先关
// 面板再拉起系统选择器——宿主回调里执行（选择器属系统层，不与面板
// 叠放）；权限被拒等结果由宿主经 toast 诚实提示，本面板不假装。
// 技能行（G7）：格下整行入口（原型「添加技能」行落点）——打开技能
// 目录 Sheet（只读浏览，C44）；副文案 = 目录总数（已拉取时），不是
// 原型写死的「N 个已启用」——启停生效值在桌面端本地、宿主无数据
// 面，不在移动端呈现启用计数（诚实口径，见 SkillsSheet）。
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { AppText, Icon, Sheet, type IconName } from '@/presentation/ui';

export interface AttachmentSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 三入口：本组件先关面板再回调，宿主在回调里拉起系统选择器 */
  onTakePhoto: () => void;
  onPickImage: () => void;
  onPickFile: () => void;
  /** 技能行（G7）：提供 onOpenSkills 才渲染；点击先关面板再回调 */
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
  const handlerOf = {
    camera: onTakePhoto,
    library: onPickImage,
    files: onPickFile,
  } as const;
  return (
    <Sheet visible={visible} onClose={onClose} title="添加附件" testID={testID}>
      <View style={[styles.grid, { gap: theme.space.sm + 2 }]}>
        {ENTRIES.map((entry) => (
          <Pressable
            key={entry.key}
            testID={`${testID}-${entry.key}`}
            accessibilityRole="button"
            accessibilityLabel={entry.label}
            onPress={() => {
              onClose();
              handlerOf[entry.action]();
            }}
            style={({ pressed }) => [
              styles.card,
              {
                borderRadius: theme.radius.menu,
                backgroundColor: pressed
                  ? theme.colors.fillPressed
                  : theme.colors.fillSubtle,
                paddingVertical: theme.space.lg,
                gap: theme.space.sm,
              },
            ]}
          >
            <Icon
              name={entry.icon}
              size={GRID_ICON_SIZE}
              color={theme.colors.textSecondary}
            />
            <AppText variant="footnote" style={styles.label}>
              {entry.label}
            </AppText>
          </Pressable>
        ))}
      </View>
      {onOpenSkills ? (
        <Pressable
          testID={`${testID}-skills`}
          accessibilityRole="button"
          accessibilityLabel="技能"
          onPress={() => {
            onClose();
            onOpenSkills();
          }}
          style={({ pressed }) => [
            styles.skillsRow,
            {
              borderRadius: theme.radius.menu,
              backgroundColor: pressed
                ? theme.colors.fillPressed
                : 'transparent',
              paddingVertical: theme.space.md,
              paddingHorizontal: theme.space.sm,
              marginTop: theme.space.sm,
              gap: theme.space.md,
            },
          ]}
        >
          <Icon
            name="sparkles"
            size={theme.size.icon}
            color={theme.colors.textSecondary}
          />
          <View style={styles.skillsText}>
            <AppText variant="body">技能</AppText>
            <AppText variant="caption" color="textTertiary">
              {skillsCount !== null
                ? `${skillsCount} 个技能`
                : '查看桌面端技能目录'}
            </AppText>
          </View>
          <Icon
            name="chevron-right"
            size={theme.size.iconSmall}
            color={theme.colors.textTertiary}
          />
        </Pressable>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
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
