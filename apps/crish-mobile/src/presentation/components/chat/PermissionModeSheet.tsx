// 权限模式选择 Sheet（G1 · F21）：与桌面软件对齐的三档（每次询问 / 智能放行 /
// 完全允许）——档位、顺序、文案与映射的单一真源在 domain/pure/permissionMode
// （照抄桌面 permissionModes.ts + zh-CN settingsParts 口径，证据见该文件头）。
// 视觉走 M4 Sheet 体系；行形态与 SheetOptionRow 同语言（fillSubtle 底 + 品牌
// 对号），但 SheetOptionRow 的 hint 是行内短注、无行下说明位，故本组件按其
// token 自绘「名 + 说明」的两行行形态（含桌面同款「推荐」标记）。
// 脚注为远程生效口径的如实说明：远程发起的 run 在桌面执行侧会把「完全允许」
// 按桌面安全规则处理（网关 apply_remote_mode：full → ask），本机发起不受影响；
// 文案只陈述该事实，不承诺降级之外的效果。
import { Pressable, Text, View } from 'react-native';
import {
  PERMISSION_MODE_OPTIONS,
  type PermissionMode,
} from '@/domain/pure/permissionMode';
import { useTheme } from '@/adapters/platform/theme';
import Icon from '@/presentation/ui/Icon';
import { Sheet } from '@/presentation/ui/Sheet';

export interface PermissionModeSheetProps {
  visible: boolean;
  onClose: () => void;
  value: PermissionMode;
  onSelect: (mode: PermissionMode) => void;
  testID?: string;
}

export function PermissionModeSheet({
  visible,
  onClose,
  value,
  onSelect,
  testID = 'permission-sheet',
}: PermissionModeSheetProps) {
  const theme = useTheme();
  const t = theme.type;
  return (
    <Sheet visible={visible} onClose={onClose} title="权限模式" testID={testID}>
      <View style={{ gap: theme.space.sm }}>
        {PERMISSION_MODE_OPTIONS.map((option) => {
          const selected = option.id === value;
          return (
            <Pressable
              key={option.id}
              testID={`${testID}-option-${option.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => onSelect(option.id)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.space.md,
                borderRadius: theme.radius.md,
                paddingHorizontal: 14,
                paddingVertical: 13,
                backgroundColor: pressed
                  ? theme.colors.fillPressed
                  : theme.colors.fillSubtle,
              })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.space.sm,
                  }}
                >
                  <Text
                    style={{
                      fontSize: t.body.fontSize,
                      lineHeight: t.body.lineHeight,
                      fontWeight: '500',
                      color: theme.colors.textPrimary,
                    }}
                  >
                    {option.label}
                  </Text>
                  {option.recommended ? (
                    <View
                      style={{
                        borderRadius: theme.radius.sm,
                        paddingHorizontal: theme.space.xs,
                        paddingVertical: 1,
                        backgroundColor: theme.colors.brandSoft,
                      }}
                    >
                      <Text
                        style={{
                          fontSize: t.caption.fontSize,
                          lineHeight: t.caption.lineHeight,
                          color: theme.colors.brand,
                        }}
                      >
                        推荐
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text
                  style={{
                    fontSize: t.caption.fontSize,
                    lineHeight: t.caption.lineHeight,
                    color: theme.colors.textTertiary,
                  }}
                >
                  {option.description}
                </Text>
              </View>
              {selected ? (
                <Icon name="check" size={15} color={theme.colors.brand} />
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <Text
        style={{
          marginTop: theme.space.md,
          fontSize: t.caption.fontSize,
          lineHeight: t.caption.lineHeight,
          color: theme.colors.textTertiary,
        }}
      >
        通过手机远程发起的任务，桌面端会按其安全规则执行：选择「完全允许」时，桌面会以「每次询问」的方式逐条确认；其余档位按所选模式执行。
      </Text>
    </Sheet>
  );
}
