// 悬浮输入条（原型 composer.css + 裁决 J2 修订 / J7）：
// 单行形态 [＋ 透明图标钮 32][输入][右槽]——右槽有输入内容时为绿色发送圆盘 36
// （用户裁决：发送钮保留且为绿），无内容且注入 voice 时为麦克风透明图标钮 32
// （长按说话；取消原型以来的灰圆底）。附件 ＋ 仅在注入 onAttachPress 时出现：
// 附件面板属 W-C，未注入即诚实缺省，不画假按钮（与麦克风同一纪律）。
// G5b 续建：宿主注入 hasAttachments（已选附件非空）时右槽同「有内容」口径
// 出发送圆盘——纯附件（无文字）必须可发（简报条目 3）；未注入/无附件时
// 形态与既有纪律完全一致，展开行麦克风口径不变（仍只看文字内容）。
// 容器：圆角 26（与高度解耦）、内边距横 10、元素间距 6、minHeight 52；
// 输入字号 15（body 14 + 1，原型 composer-input），占位色单行走 textSecondary、
// 展开/锁定走 textTertiary；多行增高以实测内容高驱动、0.32s emphasized 曲线动画。
// 通透（J7）：iOS 用 surfaceTranslucent + BlurView；其余平台与减通透时实色兜底。
// 锁定态（审批待决）：原型口径——容器保持纯白实心、占位文案不变、工具图标
// opacity 0.35、发送以禁用形态表达。
// G1 续建（原型 #23/#24 + F18/F20/F21/F22）：
// - 快捷条（contextBar 注入时）：容器上方透明胶囊行 [项目][权限]——胶囊高 22、
//   图标 12（线宽 2）、字 11.5/400 tertiary（原型 composer-top-controls /
//   capsule-btn-transparent；11.5 档 theme 无此值，以 caption − 1 派生落值），
//   左内边距 16 与单行形态 ＋ 图标左缘近似对齐（原型 30.5 含宿主外距，宿主
//   已有 4 内距），条间距 12、下距 5；展开形态时整条 opacity 0.5（0.22s）。
// - 展开双行形态（model 注入且聚焦或内容多行、且未锁定时）：第二行高 36——
//   左 = 模型钮（透明，Flash 13.5 口径取 14、标签 13/500 secondary + chevron），
//   右 = ＋ 与麦克风（自首行迁下，纪律不变：＋ 仍仅 onAttachPress 注入时渲染、
//   麦克风仍仅无内容时出现）；发送圆盘恒在首行（有内容时）。展开/收起沿
//   EXPAND_MS emphasized 口径（行块高 0 ↔ 44 = 上距 8 + 行 36，含 opacity）。
//   未注入 contextBar/model 的缺省形态与 M3 完全一致（既有测试面不变）。
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';
import type { IconName } from './iconPaths';
import Icon from './Icon';
import { VoiceModelGate, VoiceOverlay } from './VoiceOverlay';

/** 原型 composer 容器高度过渡：0.32s emphasized（theme 无 320 档，就地定值） */
const EXPAND_MS = 320;
/** 原型快捷条透明度过渡（composer.css .composer-top-controls 0.22s） */
const BAR_FADE_MS = 220;
/** 原型 icon-tool-btn 命中盒 */
const TOOL_BUTTON = 32;
/** 原型 composer 玻璃模糊强度（与 account GlassBackdrop 同口径） */
const GLASS_BLUR_INTENSITY = 40;
/** 展开第二行：行高 36（原型 expanded bottom row）+ 与首行上距 8 */
const EXPANDED_ROW_HEIGHT = 36;
const EXPANDED_ROW_GAP = 8;

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
  /** 附件入口（W-C 附件面板接线；缺省 = 不渲染 ＋ 钮） */
  onAttachPress?: () => void;
  /** 已选附件非空（G5b）：无文字时右槽仍出发送圆盘（纯附件可发） */
  hasAttachments?: boolean;
  /** 审批锁定态：容器实心、工具图标变淡、占位不换文（原型口径） */
  locked?: boolean;
  /** 快捷条（G1）：项目 + 权限胶囊（标签由宿主实时注入当前选择） */
  contextBar?: ComposerContextBar;
  /** 模型钮（G1）：展开行左置；缺省 = 无展开行（M3 单行形态） */
  model?: ComposerModelControl;
  /** 输入框 testID；发送钮为 `${testID}-send`，麦克风为 `${testID}-mic` */
  testID?: string;
}

/** 快捷条数据面（宿主自 useComposerContextVm 装配） */
export interface ComposerContextBar {
  workspaceLabel: string;
  permissionLabel: string;
  onWorkspacePress: () => void;
  onPermissionPress: () => void;
}

/** 模型钮数据面（标签现行可能为缺省表述，见 ModelSheet 诚实口径） */
export interface ComposerModelControl {
  label: string;
  onPress: () => void;
}

/** 减通透无障碍开关（本文件本地实现一份，避免 ui → account 跨域 import） */
function useReduceTransparency(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setReduced
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** 减动效无障碍开关（本地实现：高度过渡在开启减动效时直达终值） */
function useReduceMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (mounted) setReduced(value);
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduced
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

/** 快捷条胶囊（原型 capsule-btn-transparent：无背景、图标 + 标签 + 小箭头） */
function ContextCapsule({
  icon,
  label,
  onPress,
  testID,
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
  accessibilityLabel: string;
}) {
  const theme = useTheme();
  const { colors, type } = theme;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      hitSlop={{ top: 8, bottom: 8 }}
      style={styles.capsule}
    >
      {({ pressed }) => (
        <>
          <Icon
            name={icon}
            size={12}
            strokeWidth={2}
            color={colors.textTertiary}
          />
          <Text
            style={{
              // 原型 11.5px：caption 档（12.5）− 1 派生（守卫口径 theme 表达式）
              fontSize: (type.caption.fontSize ?? 12.5) - 1,
              lineHeight: type.caption.lineHeight,
              fontWeight: '400',
              color: pressed ? colors.textSecondary : colors.textTertiary,
            }}
          >
            {label}
          </Text>
          <Icon name="chevron-down" size={10} color={colors.textTertiary} />
        </>
      )}
    </Pressable>
  );
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
  onAttachPress,
  hasAttachments = false,
  locked = false,
  contextBar,
  model,
  testID,
}: ComposerProps) {
  const theme = useTheme();
  const { colors, radius, size, space, type } = theme;
  const reduceTransparency = useReduceTransparency();
  const reducedMotion = useReduceMotion();

  // 发送/麦克风切换按「有无内容」：受控 value 之外再记内部态——
  // 输入回调先于父级回填 value，内部态让切换不慢一拍（测试的受控桩亦然）
  const [hasText, setHasText] = useState(() => value.trim().length > 0);
  useEffect(() => {
    setHasText(value.trim().length > 0);
  }, [value]);
  const handleChangeText = (text: string) => {
    setHasText(text.trim().length > 0);
    onChangeText(text);
  };

  // 多行增高动画：实测内容高（onContentSizeChange）→ 0.32s emphasized 过渡；
  // 首测直设不动画；expanded 供占位色切换（展开 #777 档）
  const [expanded, setExpanded] = useState(false);
  const inputHeight = useSharedValue<number | undefined>(undefined);
  const measuredRef = useRef(false);
  const singleLineHeight = theme.type.body.lineHeight ?? 21;
  const animatedInputStyle = useAnimatedStyle(() => ({
    height: inputHeight.value,
  }));
  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>
  ) => {
    const measured = Math.ceil(event.nativeEvent.contentSize.height);
    const next = Math.min(
      Math.max(measured, singleLineHeight),
      theme.layout.composerInputMaxHeight
    );
    setExpanded(next > singleLineHeight + 2);
    if (!measuredRef.current) {
      measuredRef.current = true;
      inputHeight.value = next;
      return;
    }
    if (inputHeight.value !== next) {
      inputHeight.value = reducedMotion
        ? next
        : withTiming(next, {
            duration: EXPAND_MS,
            easing: Easing.bezier(...theme.motion.easing.emphasized),
          });
    }
  };

  // 展开双行形态（G1）：聚焦或内容多行时展开；锁定态恒单行（原型锁定口径）。
  // 快捷条随展开变淡（原型 0.5）、第二行行块高度/透明度同步过渡。
  const [focused, setFocused] = useState(false);
  const layoutExpanded = (focused || expanded) && Boolean(model) && !locked;
  const barOpacity = useSharedValue(1);
  const rowHeight = useSharedValue(0);
  const rowOpacity = useSharedValue(0);
  useEffect(() => {
    const barTarget = layoutExpanded ? 0.5 : 1;
    const heightTarget = layoutExpanded
      ? EXPANDED_ROW_GAP + EXPANDED_ROW_HEIGHT
      : 0;
    const opacityTarget = layoutExpanded ? 1 : 0;
    if (reducedMotion) {
      barOpacity.value = barTarget;
      rowHeight.value = heightTarget;
      rowOpacity.value = opacityTarget;
      return;
    }
    // jest 环境由 jest.setup 的 reanimated 桩提供 Easing.bezier（M8 补桩），
    // 测试与真机同走 token emphasized 曲线
    const easing = Easing.bezier(...theme.motion.easing.emphasized);
    barOpacity.value = withTiming(barTarget, { duration: BAR_FADE_MS });
    rowHeight.value = withTiming(heightTarget, {
      duration: EXPAND_MS,
      easing,
    });
    rowOpacity.value = withTiming(opacityTarget, { duration: EXPAND_MS });
  }, [layoutExpanded, reducedMotion, theme, barOpacity, rowHeight, rowOpacity]);
  const animatedBarStyle = useAnimatedStyle(() => ({
    opacity: barOpacity.value,
  }));
  const animatedRowStyle = useAnimatedStyle(() => ({
    height: rowHeight.value,
    opacity: rowOpacity.value,
  }));

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

  // 锁定态恒实心（原型）；玻璃仅 iOS + 非减通透 + 非锁定
  const glassActive = Platform.OS === 'ios' && !reduceTransparency && !locked;
  const toolsDimmed = locked ? 0.35 : 1;

  // ＋ 与麦克风在单行/展开两形态间迁移（同一元素口径，两形态互斥渲染）
  const attachButton = onAttachPress ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="添加附件"
      accessibilityState={{ disabled: !editable }}
      disabled={!editable}
      onPress={onAttachPress}
      style={[styles.toolButton, { opacity: toolsDimmed }]}
    >
      {({ pressed }) => (
        <Icon
          name="add"
          size={size.icon}
          color={pressed ? colors.textPrimary : colors.textSecondary}
        />
      )}
    </Pressable>
  ) : null;
  const micButton = voice ? (
    <GestureDetector gesture={voiceGesture}>
      <View
        testID={testID ? `${testID}-mic` : undefined}
        accessible
        accessibilityRole="button"
        accessibilityLabel="按住说话"
        accessibilityHint="按住录音，松开发送，上滑取消"
        accessibilityState={{ disabled: !editable }}
        style={[
          styles.toolButton,
          {
            opacity: (editable ? 1 : 0.5) * toolsDimmed,
          },
        ]}
      >
        <Icon name="mic" size={size.icon} color={colors.textSecondary} />
      </View>
    </GestureDetector>
  ) : null;
  const sendButton = (
    <Pressable
      testID={testID ? `${testID}-send` : undefined}
      accessibilityRole="button"
      accessibilityLabel="发送"
      accessibilityState={{ disabled: !canSubmit }}
      disabled={!canSubmit}
      onPress={() => {
        if (canSubmit) onSubmit();
      }}
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
  );

  return (
    <>
      {contextBar ? (
        <Animated.View style={[styles.contextBar, animatedBarStyle]}>
          <ContextCapsule
            icon="folder"
            label={contextBar.workspaceLabel}
            onPress={contextBar.onWorkspacePress}
            testID={testID ? `${testID}-workspace` : undefined}
            accessibilityLabel={`项目：${contextBar.workspaceLabel}`}
          />
          <ContextCapsule
            icon="shield"
            label={contextBar.permissionLabel}
            onPress={contextBar.onPermissionPress}
            testID={testID ? `${testID}-permission` : undefined}
            accessibilityLabel={`权限：${contextBar.permissionLabel}`}
          />
        </Animated.View>
      ) : null}
      <View
        style={[
          styles.shell,
          {
            minHeight: size.composerMin,
            borderRadius: radius.composer,
            backgroundColor: glassActive
              ? colors.surfaceTranslucent
              : colors.surface,
            // 原型 single-composer-view：内边距横 10
            paddingHorizontal: 10,
            paddingVertical: space.sm,
            overflow: glassActive ? 'hidden' : 'visible',
          },
          theme.shadow.sm,
        ]}
      >
        {glassActive ? (
          <BlurView
            intensity={GLASS_BLUR_INTENSITY}
            tint={theme.dark ? 'dark' : 'light'}
            style={styles.glassFill}
            pointerEvents="none"
          />
        ) : null}
        <View style={styles.mainRow}>
          {!layoutExpanded ? attachButton : null}
          <Animated.View style={[styles.inputWrap, animatedInputStyle]}>
            <TextInput
              testID={testID}
              multiline
              value={value}
              onChangeText={handleChangeText}
              onContentSizeChange={handleContentSizeChange}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              editable={editable}
              maxLength={maxLength}
              placeholder={placeholder}
              placeholderTextColor={
                locked || expanded ? colors.textTertiary : colors.textSecondary
              }
              style={[
                styles.input,
                theme.type.body,
                {
                  // 原型 composer-input：15px（body + 1，守卫口径 theme 表达式）
                  fontSize: (theme.type.body.fontSize ?? 14) + 1,
                  color: colors.textPrimary,
                  maxHeight: theme.layout.composerInputMaxHeight,
                },
              ]}
            />
          </Animated.View>
          {hasText || hasAttachments
            ? sendButton
            : !layoutExpanded
              ? micButton
              : null}
        </View>
        {model ? (
          <Animated.View
            style={[styles.expandedClip, animatedRowStyle]}
            pointerEvents={layoutExpanded ? 'auto' : 'none'}
          >
            <View style={styles.expandedRow}>
              <Pressable
                testID={testID ? `${testID}-model` : undefined}
                accessibilityRole="button"
                accessibilityLabel={`模型：${model.label}`}
                onPress={model.onPress}
                style={styles.modelButton}
              >
                {({ pressed }) => (
                  <>
                    <Icon name="zap" size={14} color={colors.textSecondary} />
                    <Text
                      style={{
                        fontSize: type.footnote.fontSize,
                        lineHeight: type.footnote.lineHeight,
                        fontWeight: '500',
                        color: pressed
                          ? colors.textPrimary
                          : colors.textSecondary,
                      }}
                    >
                      {model.label}
                    </Text>
                    <Icon
                      name="chevron-down"
                      size={11}
                      color={colors.textTertiary}
                    />
                  </>
                )}
              </Pressable>
              <View style={styles.expandedSpacer} />
              {layoutExpanded ? attachButton : null}
              {layoutExpanded && !hasText ? micButton : null}
            </View>
          </Animated.View>
        ) : null}
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
    flexDirection: 'column',
  },
  // 原型 .composer-top-controls：容器上方、横排、条间距 12、下距 5；
  // 左内边距 16 ≈ 与首行 ＋ 图标左缘对齐（原型 30.5 含宿主外距，此处宿主
  // 容器已有 4 内距 + 容器内距 10 → 胶囊内 2 后图标缘约在 32 处，近似口径）
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 4,
    paddingBottom: 5,
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 22,
    paddingHorizontal: 2,
  },
  mainRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 6,
  },
  expandedClip: {
    overflow: 'hidden',
  },
  expandedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: EXPANDED_ROW_HEIGHT,
    marginTop: EXPANDED_ROW_GAP,
  },
  expandedSpacer: {
    flex: 1,
  },
  modelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingHorizontal: 2,
  },
  glassFill: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  toolButton: {
    width: TOOL_BUTTON,
    height: TOOL_BUTTON,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  input: {
    flex: 1,
    paddingVertical: 0,
    textAlignVertical: 'center',
  },
  send: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Composer;
