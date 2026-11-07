// 移动端三步向导指示器（WizardStepper）：连接配置 -> 选择模型 -> 规格微调
// 遵循 docs/mobile-provider-architecture/analysis/05-rn-components-and-gestures.md §4.1
// 与 docs/mobile-provider-architecture/analysis/01-prototype-ui-ux-spec.md §5.2 规范。
// 浅色纯白 surface 恒白胶囊外壳，圆角 18dp（theme.radius.field），零生硬黑边，极软微阴影。
import { StyleSheet, View, Pressable } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import { AppText, Icon } from '@/presentation/ui';

export type WizardStep = 1 | 2 | 3;

export interface WizardStepperProps {
  /** 当前所处步骤（1: 连接配置, 2: 选择模型, 3: 规格微调） */
  currentStep: WizardStep;
  /** 点击步骤节点时的回调（用于前后向导步骤导航） */
  onStepPress?: (step: WizardStep) => void;
  /** 自定义三步标签文本（缺省为 ['连接', '模型', '规格']） */
  steps?: readonly string[];
  /** 自定义外层样式 */
  style?: StyleProp<ViewStyle>;
  /** 测试标识 */
  testID?: string;
}

const STEP_CIRCLE_SIZE = 22;
const STEP_LINE_WIDTH = 28;
const STEP_LINE_HEIGHT = 2;
const DEFAULT_STEPS = ['连接', '模型', '规格'] as const;

export function WizardStepper({
  currentStep,
  onStepPress,
  steps = DEFAULT_STEPS,
  style,
  testID,
}: WizardStepperProps) {
  const theme = useTheme();

  return (
    <View
      testID={testID ?? 'wizard-stepper'}
      style={[
        styles.stepperContainer,
        {
          backgroundColor: theme.colors.surface,
          borderRadius: theme.radius.field,
          borderColor: theme.dark ? theme.colors.hairline : 'transparent',
          borderWidth: theme.dark ? StyleSheet.hairlineWidth : 0,
        },
        style,
      ]}
    >
      {steps.map((label, idx) => {
        const stepNum = (idx + 1) as WizardStep;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;

        const circleBg =
          isActive || isCompleted
            ? theme.colors.actionPrimary
            : theme.colors.hairline;
        const circleTextColor =
          isActive || isCompleted
            ? theme.colors.actionPrimaryText
            : theme.colors.textTertiary;
        const opacity = isActive ? 1 : isCompleted ? 0.9 : 0.45;

        return (
          <View key={`${stepNum}-${label}`} style={styles.stepGroup}>
            {idx > 0 ? (
              <View
                style={[
                  styles.stepLine,
                  {
                    backgroundColor:
                      stepNum <= currentStep
                        ? theme.colors.actionPrimary
                        : theme.colors.hairline,
                    borderRadius: STEP_LINE_HEIGHT / 2,
                  },
                ]}
                testID={`${testID ?? 'wizard-stepper'}-line-${stepNum - 1}`}
              />
            ) : null}

            <Pressable
              disabled={!onStepPress}
              onPress={() => {
                if (onStepPress) {
                  haptics.selection();
                  onStepPress(stepNum);
                }
              }}
              accessibilityRole={onStepPress ? 'button' : undefined}
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`步骤 ${stepNum}: ${label}${
                isCompleted ? ' 已完成' : isActive ? ' 当前步骤' : ''
              }`}
              style={[styles.stepNode, { opacity }]}
              testID={`${testID ?? 'wizard-stepper'}-step-${stepNum}`}
            >
              <View
                style={[
                  styles.stepCircle,
                  {
                    backgroundColor: circleBg,
                    borderRadius: STEP_CIRCLE_SIZE / 2,
                  },
                ]}
              >
                {isCompleted ? (
                  <Icon
                    name="check"
                    size={13}
                    color={theme.colors.actionPrimaryText}
                    strokeWidth={2.4}
                  />
                ) : (
                  <AppText
                    variant="caption"
                    style={[styles.stepNumText, { color: circleTextColor }]}
                  >
                    {stepNum}
                  </AppText>
                )}
              </View>
              <AppText
                variant="footnote"
                color={isActive || isCompleted ? 'textPrimary' : 'textTertiary'}
                style={[
                  styles.stepLabel,
                  { fontWeight: isActive ? '600' : '500' },
                ]}
              >
                {label}
              </AppText>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  stepperContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 12,
  },
  stepGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  stepNode: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  stepCircle: {
    width: STEP_CIRCLE_SIZE,
    height: STEP_CIRCLE_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumText: {
    fontWeight: '600',
    textAlign: 'center',
  },
  stepLabel: {
    textAlign: 'center',
  },
  stepLine: {
    width: STEP_LINE_WIDTH,
    height: STEP_LINE_HEIGHT,
  },
});

export default WizardStepper;
