// 模型选择卡片（向导第 2 步）：
// - 呈现单个待选模型：左侧多选复选框（圆角 6dp，未选浅灰边，选中品牌色勾选）、
//   中间模型 ID 与上下文大小标签、右侧固定能力槽位（Canonical Slots）；
// - 固定能力槽位绝对对齐：严格按照 [文本] -> [视觉] -> [文档] -> [思考] -> [语音]
//   5 槽位排列（每个槽位 16px 宽，间距 4px）。未支持能力保留相同宽度透明占位
//   （opacity: 0），使整列卡片纵向绝对对齐无参差；
// - 选中态：背景轻微提亮，柔和边框，零突兀黑粗边（对比度 <= 10%）；
// - 按压动效：usePressFade 120ms 平滑过渡。
import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import { AppText, Icon, type IconName } from '@/presentation/ui';

export type CanonicalCapabilityKey =
  'text' | 'vision' | 'file' | 'thinking' | 'audio';

export interface CanonicalSlotDef {
  key: CanonicalCapabilityKey;
  label: string;
  icon: IconName;
}

/**
 * 权威 5 大能力槽位（严格有序）：
 * [文本] -> [视觉] -> [文档] -> [思考] -> [语音]
 * 每个槽位固定 16px 宽，间距 4px，总宽 96px。
 */
export const DEFAULT_CANONICAL_SLOTS: readonly CanonicalSlotDef[] = [
  { key: 'text', label: '文本', icon: 'text-font' },
  { key: 'vision', label: '视觉', icon: 'image' },
  { key: 'file', label: '文档', icon: 'file' },
  { key: 'thinking', label: '思考', icon: 'zap' },
  { key: 'audio', label: '语音', icon: 'audio-wave' },
] as const;

export type ModelCapabilitiesInput =
  | readonly (string | CanonicalCapabilityKey)[]
  | Partial<Record<string, boolean>>
  | {
      input?: readonly string[];
      output?: readonly string[];
    };

/**
 * 纯函数：判定给定槽位是否被模型支持。
 * 兼容数组形式、Record 形式与 ModalitiesSpec 输入/输出形式，支持 image/vision、document/file 等别名。
 */
export function isCapabilitySupported(
  key: CanonicalCapabilityKey,
  capabilities?: ModelCapabilitiesInput,
  supportsThinking?: boolean
): boolean {
  if (key === 'thinking' && supportsThinking) {
    return true;
  }
  if (!capabilities) {
    return key === 'text';
  }

  // 1. 数组形式：['text', 'image', 'thinking']
  if (Array.isArray(capabilities)) {
    const list = capabilities.map((c) => String(c).toLowerCase());
    if (key === 'text') return list.includes('text');
    if (key === 'vision')
      return list.includes('vision') || list.includes('image');
    if (key === 'file')
      return list.includes('file') || list.includes('document');
    if (key === 'thinking')
      return (
        list.includes('thinking') ||
        list.includes('reasoning') ||
        Boolean(supportsThinking)
      );
    if (key === 'audio')
      return (
        list.includes('audio') ||
        list.includes('voice') ||
        list.includes('sound')
      );
    return false;
  }

  // 2. ModalitiesSpec 形式：{ input: ['text', 'image'], output: ['text'] }
  if (
    typeof capabilities === 'object' &&
    capabilities !== null &&
    ('input' in capabilities || 'output' in capabilities)
  ) {
    const rawInput = (capabilities as { input?: unknown }).input;
    const rawOutput = (capabilities as { output?: unknown }).output;
    if (Array.isArray(rawInput) || Array.isArray(rawOutput)) {
      const inputList = Array.isArray(rawInput)
        ? rawInput.map((c) => String(c).toLowerCase())
        : [];
      const outputList = Array.isArray(rawOutput)
        ? rawOutput.map((c) => String(c).toLowerCase())
        : [];
      const all = new Set([...inputList, ...outputList]);
      if (key === 'text') return all.has('text');
      if (key === 'vision') return all.has('vision') || all.has('image');
      if (key === 'file') return all.has('file') || all.has('document');
      if (key === 'thinking') return Boolean(supportsThinking);
      if (key === 'audio') return all.has('audio') || all.has('voice');
      return false;
    }
  }

  // 3. Record 键值形式：{ text: true, vision: true, thinking: true }
  const map = capabilities as Record<string, boolean | undefined>;
  if (key === 'text') return Boolean(map.text);
  if (key === 'vision') return Boolean(map.vision ?? map.image);
  if (key === 'file') return Boolean(map.file ?? map.document);
  if (key === 'thinking')
    return Boolean(map.thinking ?? map.reasoning ?? supportsThinking);
  if (key === 'audio') return Boolean(map.audio ?? map.voice);
  return false;
}

/**
 * 纯函数：将数值型上下文 Tokens 格式化为阅读友好的标签（如 131072 -> '128k', 1048576 -> '1M'）
 */
export function formatContextLength(
  contextLength?: string | number
): string | undefined {
  if (contextLength === undefined || contextLength === null) return undefined;
  if (typeof contextLength === 'string') {
    const trimmed = contextLength.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof contextLength === 'number' && Number.isFinite(contextLength)) {
    if (contextLength <= 0) return undefined;
    if (contextLength >= 1048576) {
      const mb = Math.round(contextLength / 1048576);
      return `${mb}M`;
    }
    if (contextLength >= 1024) {
      const kb = Math.round(contextLength / 1024);
      return `${kb}k`;
    }
    return String(contextLength);
  }
  return undefined;
}

export interface ModelSelectCardProps {
  /** 模型真实 ID（如 "deepseek-chat"） */
  id: string;
  /** 展示名（缺省使用 id） */
  displayName?: string;
  /** 上下文容量（如 "128k" 或 131072） */
  contextLength?: string | number;
  /** 是否选中 */
  selected: boolean;
  /** 切换勾选回调 */
  onToggle?: (id: string) => void;
  /** 模型能力配置（数组、ModalitiesSpec 或布尔键值） */
  capabilities?: ModelCapabilitiesInput;
  /** 是否支持思考/推理 */
  supportsThinking?: boolean;
  /** 自定义固定能力槽位定义（缺省为标准 5 槽位） */
  slots?: readonly CanonicalSlotDef[];
  /** 自定义卡片样式 */
  style?: StyleProp<ViewStyle>;
  /** 测试 ID */
  testID?: string;
}

export const ModelSelectCard = memo(function ModelSelectCard({
  id,
  displayName,
  contextLength,
  selected,
  onToggle,
  capabilities,
  supportsThinking,
  slots = DEFAULT_CANONICAL_SLOTS,
  style,
  testID,
}: ModelSelectCardProps) {
  const theme = useTheme();
  const { onPressIn, onPressOut, fadeStyle } = usePressFade();
  const contextTag = formatContextLength(contextLength);

  const handlePress = () => {
    onToggle?.(id);
  };

  const a11yLabel = `${displayName ?? id}${
    contextTag ? `，上下文 ${contextTag}` : ''
  }，${selected ? '已选中' : '未选中'}`;

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={a11yLabel}
      testID={testID ?? `model-select-card-${id}`}
      style={[
        styles.card,
        {
          borderRadius: theme.radius.codeCell,
          backgroundColor: selected
            ? theme.colors.surfaceRaised
            : theme.colors.surface,
          borderColor: selected ? theme.colors.brand : theme.colors.hairline,
        },
        fadeStyle,
        style,
      ]}
    >
      {/* 1. 左侧多选复选框（圆角 6dp，未选浅灰边，选中品牌色勾选） */}
      <View
        style={[
          styles.checkbox,
          {
            borderRadius: theme.radius.xs, // 6dp
            borderColor: selected
              ? theme.colors.actionPrimary
              : theme.colors.borderStrong,
            backgroundColor: selected
              ? theme.colors.actionPrimary
              : theme.colors.surface,
          },
        ]}
        testID={`model-checkbox-${id}`}
      >
        {selected ? (
          <Icon
            name="check"
            size={13}
            color={theme.colors.actionPrimaryText}
            strokeWidth={2.4}
          />
        ) : null}
      </View>

      {/* 2. 中间模型 ID 与上下文大小标签 */}
      <View style={styles.centerSection}>
        <AppText
          variant="footnote"
          color="textPrimary"
          numberOfLines={1}
          ellipsizeMode="tail"
          style={styles.modelIdText}
          testID={`model-id-${id}`}
        >
          {displayName ?? id}
        </AppText>
        {contextTag ? (
          <View
            style={[
              styles.contextTagBadge,
              {
                borderRadius: theme.radius.xs,
                backgroundColor: theme.colors.fillSubtle,
              },
            ]}
            testID={`model-context-tag-${id}`}
          >
            <AppText
              variant="caption"
              color="textTertiary"
              style={styles.contextTagText}
            >
              {contextTag}
            </AppText>
          </View>
        ) : null}
      </View>

      {/* 3. 右侧固定能力槽位绝对对齐（Canonical Slots） */}
      <View
        style={styles.slotsContainer}
        testID={`canonical-slots-${id}`}
        accessibilityLabel="模型支持能力槽位"
      >
        {slots.map((slot) => {
          const supported = isCapabilitySupported(
            slot.key,
            capabilities,
            supportsThinking
          );
          return (
            <View
              key={slot.key}
              style={styles.slotBox}
              testID={`canonical-slot-${slot.key}`}
              accessibilityLabel={`${slot.label}${supported ? '支持' : '不支持'}`}
            >
              {supported ? (
                <View testID={`canonical-slot-${slot.key}-supported`}>
                  <Icon
                    name={slot.icon}
                    size={theme.size.iconSmall}
                    color={theme.colors.textSecondary}
                  />
                </View>
              ) : (
                <View
                  style={styles.slotEmptyPlaceholder}
                  testID={`canonical-slot-${slot.key}-empty`}
                  pointerEvents="none"
                />
              )}
            </View>
          );
        })}
      </View>
    </AnimatedPressable>
  );
});

const styles = StyleSheet.create({
  card: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  checkbox: {
    width: 20,
    height: 20,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    flexShrink: 0,
  },
  centerSection: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginRight: 8,
    gap: 6,
  },
  modelIdText: {
    flexShrink: 1,
    fontWeight: '500',
  },
  contextTagBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  contextTagText: {
    fontWeight: '500',
  },
  slotsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    width: 96,
    gap: 4,
    flexShrink: 0,
  },
  slotBox: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotEmptyPlaceholder: {
    width: 16,
    height: 16,
    opacity: 0,
  },
});

export default ModelSelectCard;
