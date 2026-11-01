// 悬浮胶囊输入条（主屏平铺列表页与会话页共用）。
// 原型规范：圆角恒定 26（与高度解耦）、纯白底零描边、微柔浮雕阴影；
// 多行自适应增高。底部可选项：发送恒在；麦克风仅在屏幕注入 voice
// （useVoiceInput）时渲染——离线语音是本机 ASR 能力（01 文档 W-D），
// 未注入即诚实缺省，不画假按钮。
import { useRef } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';
import Icon from './Icon';
import { VoiceModelGate, VoiceOverlay } from './VoiceOverlay';

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: () => void;
  canSubmit: boolean;
  editable: boolean;
  placeholder: string;
  maxLength?: number;
  /** 语音输入接线（useVoiceInput 的返回值；缺省 = 无麦克风） */
  voice?: VoiceInputApi;
  /** 输入框 testID；发送钮为 `${testID}-send`，麦克风为 `${testID}-mic` */
  testID?: string;
}

export function Composer({
  value,
  onChangeText,
  onSubmit,
  canSubmit,
  editable,
  placeholder,
  maxLength,
  voice,
  testID,
}: ComposerProps) {
  const theme = useTheme();
  const { colors, radius, size, space } = theme;

  // 手势回调经 ref 桥接最新 voice 实例（worklet → runOnJS，模式同
  // SlideToConfirm）：手势对象本身不随渲染重建而失联。
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const bridgeRef = useRef({
    start: () => voiceRef.current?.pressStart(),
    move: (translationY: number) => voiceRef.current?.pressMove(translationY),
    end: () => voiceRef.current?.pressEnd(),
  });

  const voiceGesture = Gesture.Simultaneous(
    Gesture.LongPress()
      .minDuration(200)
      .enabled(Boolean(voice) && editable)
      .onStart(() => {
        'worklet';
        runOnJS(bridgeRef.current.start)();
      })
      .onFinalize(() => {
        'worklet';
        runOnJS(bridgeRef.current.end)();
      }),
    Gesture.Pan()
      .enabled(Boolean(voice) && editable)
      .onUpdate((event) => {
        'worklet';
        runOnJS(bridgeRef.current.move)(event.translationY);
      })
      .onFinalize(() => {
        'worklet';
        runOnJS(bridgeRef.current.end)();
      })
  );

  return (
    <>
      <View
        style={[
          styles.shell,
          {
            minHeight: size.composerMin,
            borderRadius: radius.composer,
            backgroundColor: colors.surface,
            paddingLeft: space.lg,
            paddingRight: space.sm,
            paddingVertical: space.sm,
            gap: space.sm,
          },
          theme.shadow.sm,
        ]}
      >
        {voice ? (
          <GestureDetector gesture={voiceGesture}>
            <View
              testID={testID ? `${testID}-mic` : undefined}
              accessible
              accessibilityRole="button"
              accessibilityLabel="按住说话"
              accessibilityHint="按住录音，松开发送，上滑取消"
              accessibilityState={{ disabled: !editable }}
              style={[
                styles.mic,
                {
                  width: size.sendButton,
                  height: size.sendButton,
                  borderRadius: radius.pill,
                  backgroundColor: colors.fillSubtle,
                  opacity: editable ? 1 : 0.5,
                },
              ]}
            >
              <Icon
                name="mic"
                size={size.iconSmall}
                color={colors.textSecondary}
              />
            </View>
          </GestureDetector>
        ) : null}
        <TextInput
          testID={testID}
          multiline
          value={value}
          onChangeText={onChangeText}
          editable={editable}
          maxLength={maxLength}
          placeholder={placeholder}
          placeholderTextColor={colors.textTertiary}
          style={[
            styles.input,
            theme.type.body,
            {
              color: colors.textPrimary,
              maxHeight: theme.layout.composerInputMaxHeight,
            },
          ]}
        />
        <Pressable
          testID={testID ? `${testID}-send` : undefined}
          accessibilityRole="button"
          accessibilityLabel="发送"
          accessibilityState={{ disabled: !canSubmit }}
          disabled={!canSubmit}
          onPress={onSubmit}
          style={({ pressed }) => [
            styles.send,
            {
              width: size.sendButton,
              height: size.sendButton,
              borderRadius: radius.pill,
              backgroundColor: canSubmit
                ? colors.actionPrimary
                : colors.actionDisabled,
            },
            pressed && { transform: [{ scale: theme.motion.pressScale }] },
          ]}
        >
          <Icon
            name="send"
            size={size.iconSmall}
            color={canSubmit ? colors.actionPrimaryText : colors.textDisabled}
          />
        </Pressable>
      </View>
      {voice ? (
        <>
          <VoiceOverlay
            phase={voice.phase}
            starting={voice.starting}
            displayText={voice.displayText}
            level={voice.level}
          />
          <VoiceModelGate
            visible={voice.gateVisible}
            state={voice.gateState}
            modelTotalBytes={voice.modelTotalBytes}
            onConfirmDownload={voice.confirmDownload}
            onDismiss={voice.dismissGate}
          />
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    alignSelf: 'center',
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
  send: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mic: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Composer;
