// 模型选择 Sheet（G1 · F22 的 UI 半）：结构与接口为 G2（W-B）预留——
// G2 落地 GET /v1/models + POST /v1/models/active 两端点后，在
// useComposerContextVm 接入模型列表与切换动作，本 Sheet 的 props 扩展为
// { models, activeModelId, onSelectModel } 即可直接灌数据，无需改调用面形态。
// 现行诚实状态（禁止假列表）：移动端没有任何模型状态可读——发起 run 时不送
// 模型字段，实际模型由桌面端「全局默认模型」决定（桌面 models 页口径）。故本
// Sheet 只展示一行缺省表述 + 空态说明，不编造模型名与列表。
import { Text, View } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import Icon from '@/presentation/ui/Icon';
import { Sheet } from '@/presentation/ui/Sheet';

export interface ModelSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 当前模型标签（现行恒为缺省表述「默认模型」，G2 后为真实型号） */
  currentLabel: string;
  testID?: string;
}

export function ModelSheet({
  visible,
  onClose,
  currentLabel,
  testID = 'model-sheet',
}: ModelSheetProps) {
  const theme = useTheme();
  const t = theme.type;
  return (
    <Sheet visible={visible} onClose={onClose} title="模型选择" testID={testID}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.space.md,
          borderRadius: theme.radius.md,
          paddingHorizontal: 14,
          paddingVertical: 13,
          backgroundColor: theme.colors.fillSubtle,
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text
            style={{
              fontSize: t.body.fontSize,
              lineHeight: t.body.lineHeight,
              fontWeight: '500',
              color: theme.colors.textPrimary,
            }}
          >
            {currentLabel}
          </Text>
          <Text
            style={{
              fontSize: t.caption.fontSize,
              lineHeight: t.caption.lineHeight,
              color: theme.colors.textTertiary,
            }}
          >
            任务实际使用桌面端的全局默认模型
          </Text>
        </View>
        <Icon name="check" size={15} color={theme.colors.brand} />
      </View>
      <Text
        style={{
          marginTop: theme.space.md,
          fontSize: t.caption.fontSize,
          lineHeight: t.caption.lineHeight,
          color: theme.colors.textTertiary,
        }}
      >
        模型列表待桌面端接口开放后在此选择，当前无法从手机端切换模型。
      </Text>
    </Sheet>
  );
}
