// 模态能力选择底抽屉（ModalitySelectSheet）
// 权威依据：
// - docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md §7.4 / §7.5
// - docs/mobile-provider-architecture/analysis/05-rn-components-and-gestures.md §5.5
// 支持输入模态（Input Modalities）与输出生成能力（Output Modalities）网格卡片配置，
// 至少保留一项有效勾选，文本模态默认保底，配备 120ms 按压动效与触感震动反馈。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import {
  AppText,
  Button,
  Icon,
  Sheet,
  useToast,
  type IconName,
} from '@/presentation/ui';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';

export interface ModalityOption {
  key: string;
  label: string;
  icon: IconName;
}

/** 输入模态字典（严格对齐权威规范 5 项标准能力） */
export const INPUT_MODALITY_OPTIONS: readonly ModalityOption[] = [
  { key: 'text', label: '文本 (Text)', icon: 'text-font' },
  { key: 'image', label: '图片 / 视觉 (Vision)', icon: 'image' },
  { key: 'file', label: '文档 / 文件 (Document)', icon: 'file' },
  { key: 'audio', label: '音频 / 录音 (Audio)', icon: 'audio-wave' },
  { key: 'video', label: '视频理解 (Video)', icon: 'camera' },
] as const;

/** 输出生成能力字典（严格对齐权威规范 3 项原生能力） */
export const OUTPUT_MODALITY_OPTIONS: readonly ModalityOption[] = [
  { key: 'text', label: '文本与代码 (Text)', icon: 'text-font' },
  { key: 'image', label: '图像生成 (Vision Generation)', icon: 'image' },
  { key: 'audio', label: '语音合成 (Audio Synthesis)', icon: 'audio-wave' },
] as const;

export interface ModalitySelectSheetProps {
  visible: boolean;
  onClose: () => void;
  type: 'input' | 'output';
  selected: string[];
  onApply: (modalities: string[]) => void;
  testID?: string;
}

/** 安全使用 Toast 控制器，防未包裹 ToastProvider 时异常 */
function useSafeToast() {
  try {
    return useToast();
  } catch {
    return {
      show: () => '',
      showToast: () => '',
      hide: () => {},
      clear: () => {},
    };
  }
}

/** 规范化别名模态键 */
function normalizeModalityKey(rawKey: string): string {
  const lower = rawKey.toLowerCase().trim();
  if (lower === 'vision') return 'image';
  if (lower === 'document') return 'file';
  if (lower === 'voice') return 'audio';
  return lower;
}

export function ModalitySelectSheet({
  visible,
  onClose,
  type,
  selected,
  onApply,
  testID = 'modality-select-sheet',
}: ModalitySelectSheetProps) {
  const theme = useTheme();
  const toast = useSafeToast();

  const isInput = type === 'input';
  const title = isInput ? '输入模态' : '输出生成能力';
  const subtitle = isInput
    ? '设置模型可接收的内容格式'
    : '设置模型原生生成的内容形式';
  const options = isInput ? INPUT_MODALITY_OPTIONS : OUTPUT_MODALITY_OPTIONS;

  // 内部选定状态：默认保底包含 text
  const [currentSelected, setCurrentSelected] = useState<string[]>(() => {
    const normalized = selected.map(normalizeModalityKey).filter(Boolean);
    return normalized.length > 0 ? normalized : ['text'];
  });

  useEffect(() => {
    if (visible) {
      const normalized = selected.map(normalizeModalityKey).filter(Boolean);
      setCurrentSelected(normalized.length > 0 ? normalized : ['text']);
    }
  }, [visible, selected]);

  const handleToggle = useCallback(
    (key: string) => {
      setCurrentSelected((prev) => {
        const isSelected = prev.includes(key);
        if (isSelected) {
          // 单模态保底守卫：至少保留一项已选模态，禁止全取消
          if (prev.length <= 1) {
            const warningMsg = isInput
              ? '至少保留一项输入模态'
              : '至少保留一项输出生成能力';
            toast.show({ message: warningMsg, tone: 'warning' });
            return prev;
          }
          haptics.selection();
          return prev.filter((itemKey) => itemKey !== key);
        } else {
          haptics.selection();
          return [...prev, key];
        }
      });
    },
    [isInput, toast]
  );

  const handleApply = useCallback(() => {
    onApply(currentSelected);
    onClose();
    haptics.selection();
  }, [currentSelected, onApply, onClose]);

  const footerButton = useMemo(
    () => (
      <Button
        label="确定保存"
        variant="primary"
        onPress={handleApply}
        testID={`${testID}-apply-button`}
      />
    ),
    [handleApply, testID]
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      size="large"
      footer={footerButton}
      testID={testID}
    >
      <View style={styles.container}>
        <AppText
          variant="footnote"
          color="textTertiary"
          style={[styles.subtitle, { marginBottom: theme.space.md }]}
        >
          {subtitle}
        </AppText>
        <View style={[styles.cardList, { gap: theme.space.sm }]}>
          {options.map((option) => (
            <ModalityCard
              key={option.key}
              item={option}
              selected={currentSelected.includes(option.key)}
              onPress={() => handleToggle(option.key)}
              testID={`${testID}-card-${option.key}`}
            />
          ))}
        </View>
      </View>
    </Sheet>
  );
}

export interface ModalityCardProps {
  item: ModalityOption;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}

/** 单个模态卡片：120ms 按压透明度平滑过渡，圆盘图标盒 + 标题 + 绿色对号 */
export function ModalityCard({
  item,
  selected,
  onPress,
  testID,
}: ModalityCardProps) {
  const theme = useTheme();
  const press = usePressFade();

  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={item.label}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      style={[
        styles.card,
        {
          borderRadius: theme.radius.md,
          backgroundColor: selected
            ? theme.colors.surfaceRaised
            : theme.colors.surface,
          borderColor: selected ? theme.colors.brand : theme.colors.hairline,
          paddingHorizontal: theme.space.md + theme.space.xxs,
          paddingVertical: theme.space.md,
        },
        press.fadeStyle,
      ]}
    >
      <View
        style={[
          styles.iconBadge,
          {
            borderRadius: theme.radius.pill,
            backgroundColor: selected
              ? theme.colors.actionPrimary
              : theme.colors.fillSubtle,
          },
        ]}
      >
        <Icon
          name={item.icon}
          size={18}
          color={
            selected
              ? theme.colors.actionPrimaryText
              : theme.colors.textSecondary
          }
        />
      </View>
      <View style={[styles.cardBody, { marginLeft: theme.space.md }]}>
        <AppText
          variant="bodyStrong"
          color={selected ? 'textPrimary' : 'textSecondary'}
          numberOfLines={1}
        >
          {item.label}
        </AppText>
      </View>
      <View style={styles.checkIndicator}>
        {selected ? (
          <Icon
            name="check"
            size={18}
            color={theme.colors.actionPrimary}
            strokeWidth={2.4}
          />
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  subtitle: {
    paddingHorizontal: 2,
  },
  cardList: {
    width: '100%',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 56,
  },
  iconBadge: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBody: {
    flex: 1,
  },
  checkIndicator: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
