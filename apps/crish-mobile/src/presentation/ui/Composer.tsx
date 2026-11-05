// 悬浮输入条（原型 composer.css + 裁决 J2 修订 / J7；形态口径经
// 2026-11-03 用户真机校准修订，见本头注各条）：
// 恒两行形态（2026-11-03 用户裁决，推翻 G1 的「聚焦/内容多行触发展开」）：
// 注入 model 时第二行恒在——左 = 模型钮（透明，Flash 13.5 口径取 14、
// 标签 13/500 secondary + chevron），右 = 附件 ＋（仅 onAttachPress 注入
// 时渲染；右侧簇间距 10 = 原型 row-right-actions gap）。无展开/收起
// 状态机、无第二行高度/透明度动画、无键盘跟随贴合，聚焦与否、内容
// 多少都不切换形态。未注入 model 的宿主无第二行（宿主配置差异，非
// 形态切换），其 ＋ 在首行。
// 首行 = [输入][右槽]：右槽有内容时为绿色发送圆盘 36（用户裁决：发送
// 钮保留且为绿）；宿主注入 hasAttachments（已选附件非空）时同「有内容」
// 口径出发送圆盘——纯附件（无文字）必须可发（G5b）；无内容时右槽留空。
// 语音（2026-11-03 用户裁决）：composer 上不再有麦克风按钮——长按输入
// 框 = 语音输入，是唯一语音入口（与旧麦克风同一条 bridge 链路，不另
// 造第二套）；有文字时长按同样进语音（推翻 FUNC 批「仅空输入」门），
// 选字冲突处置见 inputVoiceGestureEnabled 头注。附件 ＋ 未注入即诚实
// 缺省，不画假按钮（纪律不变）。
// 首行同中线（2026-11-03 对齐校准，用户实测「文字和旁边的按钮不在一
// 个水平线上」）：修前文本中线距行底约 10.5px、工具钮图标 16px、发送
// 盘 18px，三者错位 5.5–7.5px；现统一到发送盘中线（距行底 18px）：
// 输入包裹 minHeight 恒 = 发送盘直径 36 + textAlignVertical center +
// includeFontPadding false（字形按行高盒精确定心），工具钮盒高 36 图
// 标居中。主行 flex-end 不变：多行增高时按钮贴行底、与末行同线。
// 容器：圆角 radius.composer（30，2026-11-03 调大一档）、描边 1px
// borderStrong（2026-11-03 用户点名：无描边时卡缘与屏面看不清；深色
// 下阴影短路，描边即边线本体）、阴影走 SoftShadow 的 composer 档
// （2026-11-03 校准 α +6 点）、内边距横 10、元素间距 6、minHeight 52；
// 两行形态上下边距 10、无第二行时 8，首行 36 + 行距 6 + 第二行 36 +
// 上下 10×2 合成总高 98（原型 expanded 总高同值）。输入字号 15（body
// 14 + 1，原型 composer-input），占位色：单行形态走 textSecondary、
// 两行形态/多行/锁定走 textTertiary；多行增高以实测内容高驱动、
// 直达落值零补间（键盘单时钟源正典第 3 条，见 theme.ts 的 motion
// 成文）：逐字补间 = 框体追赶文字，是输入卡顿源——M-C 的跨档补间
// 口径已被方案 05 的直达同步取代（见 handleContentSizeChange）。
// 通透（J7）：iOS 用 surfaceTranslucent + BlurView；其余平台与减通透时实色兜底。
// 锁定态（审批待决）：原型口径——容器保持纯白实心、占位文案不变、工具图标
// opacity 0.35、发送以禁用形态表达；锁定不改形态（两行恒两行）。
// G1 续建（原型 #23/#24 + F18/F20/F21/F22）：
// - 快捷条（contextBar 注入时）：容器上方透明胶囊行 [项目][权限]——胶囊高 22、
//   图标 12（线宽 2）、字 11.5/400 tertiary（原型 composer-top-controls /
//   capsule-btn-transparent；11.5 档 theme 无此值，以 caption − 1 派生落值），
//   左内边距 14 与无第二行形态下 ＋ 图标左缘零误差对齐：胶囊图标左缘 = 14 +
//   胶囊内距 2 = 16，＋ 图标左缘 = 卡内距 10 + (32 − 20) / 2 = 16（原型同构：
//   条左距 30.5 + 胶囊内距 2 = 32.5 = 首行 ＋ 图标左缘）；条间距 12、下距 5、
//   右内边距 16（原型 padding 0 16px 5px 30.5px 的右值）。原型明定此条
//   无背景（composer.css 原注「无背景！」），不补底托——收纳感由零误差
//   对齐 + 与卡同宽 + 5 下距达成。（G1 旧口径「展开时整条变淡 0.5」随
//   恒两行形态废止：无展开态，条恒全透明度。）
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { useTheme } from '@/adapters/platform/theme';
import { haptics } from '@/adapters/platform/haptics';
import type { VoiceInputApi } from '@/adapters/asr/useVoiceInput';
import type { IconName } from './iconPaths';
import Icon from './Icon';
import { SoftShadow } from './SoftShadow';
import { AnimatedPressable, usePressFade } from './pressFeedback';
import { VoiceErrorBar, VoiceModelGate, VoiceOverlay } from './VoiceOverlay';

// 本文件不就地定动效值：一切时长/曲线出 theme.motion 单源（批 A
// 守卫 motionTokens.guard 钉死）；原 EXPAND_MS=320 就地定值已收编
// （M-C 硬编码清零），输入增高现行走直达同步、不再消费 expand 档。
/** 原型 icon-tool-btn 命中盒宽（高 36 与发送盘同中线，见 styles.toolButton） */
const TOOL_BUTTON = 32;
/** 原型 composer 玻璃模糊强度（与 account GlassBackdrop 同口径） */
const GLASS_BLUR_INTENSITY = 40;
/** 第二行：行高 36（原型 expanded bottom row）+ 与首行上距 6
 * （两行形态总高 98 = 卡内上下边距 10×2 + 首行 36 + 行距 6 + 次行 36） */
const SECOND_ROW_HEIGHT = 36;
const SECOND_ROW_GAP = 6;
/** 软阴影尺寸提交静默窗（ms）：卡高动画（输入跨档增高补间）期间
 * onLayout 逐帧到达，实测尺寸须静默满本窗才提交给 SoftShadow——逐帧
 * 提交 = Composer 子树逐帧重渲染 + SVG 滤镜整幅重栅格化（M4 性能
 * 裁定）；动画期阴影保持提交前尺寸（尺寸滞后不可感知），落定后一次
 * 到位。90ms 高于常见帧抖动间隔、远低于人眼对动画落定后残留错位的
 * 感知阈。 */
const CARD_SIZE_SETTLE_MS = 90;
/** SoftShadow 记忆化外壳：Composer 因输入/焦点等状态重渲染时，已提交
 * 尺寸与圆角不变则 SVG 滤镜树不重跑；尺寸变更仍经 cardSize 状态下发。 */
const MemoSoftShadow = memo(SoftShadow);

/** 语音手势的宿主输入框（动效组件化）：GestureDetector 必须直接包它
 * 本人——Android 上 ReactEditText 自行消费触摸流并跑原生选字长按，手势
 * 挂在祖先包裹层上永远等不到激活（详见 inputVoiceGestureEnabled 头注的
 * 失效复盘）。createAnimatedComponent 让 RNGH 的 handler 视图就是
 * EditText 本体，激活时原生流收到 ACTION_CANCEL，选字被压掉。 */
/** 长按可容忍的指位漂移（dp）：默认 10dp 在真机上单手持握的微漂移
 * 极易越界、长按未及激活先判败——而判败后没有任何第二条路，500ms 处
 * 原生选字接管（用户实测症状）。故漂移实质不设限（位移语义由结对的
 * Pan 独占：pressMove 驱动上滑取消），长按只以按满时长定成败。 */
const VOICE_LONG_PRESS_MAX_DISTANCE = 10_000;

export interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit: (text?: string) => void;
  canSubmit: boolean;
  editable: boolean;
  placeholder?: string;
  maxLength?: number;
  /** 语音输入接线（useVoiceInput 的返回值；缺省 = 无语音，长按输入亦不启用） */
  voice?: VoiceInputApi;
  /** 附件入口（W-C 附件面板接线；缺省 = 不渲染 ＋ 钮） */
  onAttachPress?: () => void;
  /** 已选附件非空（G5b）：无文字时右槽仍出发送圆盘（纯附件可发） */
  hasAttachments?: boolean;
  /** 审批锁定态：容器实心、工具图标变淡、占位不换文（原型口径） */
  locked?: boolean;
  /** 快捷条（G1）：项目 + 权限胶囊（标签由宿主实时注入当前选择） */
  contextBar?: ComposerContextBar;
  /** 模型钮（G1）：第二行左置；注入即恒两行形态，缺省 = 无第二行 */
  model?: ComposerModelControl;
  /** 输入框 testID；发送钮为 `${testID}-send`（麦克风钮已于 2026-11-03 删除） */
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

// 减动效信号已收敛到共享实现 adapters/platform/useReducedMotion（手感基建批，
// 审计 H-1）：本文件原本地副本已删除，高度过渡直达终值的消费口径不变。

/** 快捷条胶囊（原型 capsule-btn-transparent：无背景、图标 + 标签 + 小箭头）；
 * 按压整件透明度 120ms 过渡（按压过渡统一批，替代瞬时文字换色） */
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
  const press = usePressFade();
  return (
    <AnimatedPressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={{ top: 8, bottom: 8 }}
      style={[styles.capsule, press.fadeStyle]}
    >
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
            color: colors.textTertiary,
          }}
        >
          {label}
        </Text>
        <Icon name="chevron-down" size={10} color={colors.textTertiary} />
      </>
    </AnimatedPressable>
  );
}

/**
 * 附件 ＋ 钮（memo 子簇，C-PERF）：按压反馈钩子内聚本组件。旧形态是
 * Composer 渲染体内联构造的元素变量——逐键渲染时整件重造、子树
 * 重渲染。现只收基元 props（变淡量/禁用/稳定跳板回调），逐键跳过。
 * 两形态落位口径不变：无第二行时首行、两行形态时第二行右侧簇，
 * 由父级在两处互斥渲染本组件。
 */
export const AttachButton = memo(function AttachButton({
  dimmed,
  disabled,
  onPress,
}: {
  /** 锁定态变淡量（1 = 常态） */
  dimmed: number;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { colors, size } = theme;
  const press = usePressFade();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="添加附件"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      // 命中面补到 44dp（视觉 32 不变，F1 审计）：四边各扩 6
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={[styles.toolButton, { opacity: dimmed }]}
    >
      {/* 按压反馈走 usePressFade 的 fade 形态、只作用于字形层：整件
          opacity 已被锁定态变淡（dimmed）占用，字形层与之叠乘
          既不覆盖变淡、又与同排模型钮的 fade 语言一致（F1） */}
      <Animated.View style={press.fadeStyle}>
        {/* 原型 .icon-tool-btn 图标色 = text-1（近黑），深于占位文 text-2 */}
        <Icon name="add" size={size.icon} color={colors.textPrimary} />
      </Animated.View>
    </Pressable>
  );
});

/** 发送盘（memo 子簇，C-PERF）：只随 canSubmit 翻转重渲染，逐键跳过。 */
export const SendButton = memo(function SendButton({
  canSubmit,
  testID,
  onSubmit,
}: {
  canSubmit: boolean;
  testID?: string;
  onSubmit: () => void;
}) {
  const theme = useTheme();
  const { colors, radius, size } = theme;
  const press = usePressFade();
  const buttonSize = size.sendButton;
  return (
    <AnimatedPressable
      testID={testID ? `${testID}-send` : undefined}
      accessibilityRole="button"
      accessibilityLabel="发送"
      accessibilityState={{ disabled: !canSubmit }}
      disabled={!canSubmit}
      onPress={() => {
        if (canSubmit) onSubmit();
      }}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      // 命中面补到 44dp（视觉 36 不变，用户定案，审计 D6）：四边各扩 4
      hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
      style={[
        styles.send,
        {
          width: buttonSize,
          height: buttonSize,
          borderRadius: radius.pill,
          backgroundColor: canSubmit
            ? colors.actionPrimary
            : colors.actionDisabled,
        },
        press.pressScaleStyle,
      ]}
    >
      {Platform.OS === 'android' && canSubmit ? (
        <SoftShadow
          width={buttonSize}
          height={buttonSize}
          borderRadius={buttonSize / 2}
        />
      ) : null}
      <Icon
        name="send"
        size={size.iconSmall}
        color={canSubmit ? colors.actionPrimaryText : colors.textDisabled}
      />
    </AnimatedPressable>
  );
});

/**
 * 第二行（memo 子簇，C-PERF）：模型钮 + 右侧附件簇。标签是基元、
 * 回调是稳定跳板——模型标签不变时逐键整行跳过（旧形态逐键重造
 * 模型钮子树）。行高/间距口径（36 + 上距 6）不变。
 */
export const ComposerSecondRow = memo(function ComposerSecondRow({
  label,
  dimmed,
  showAttach,
  attachDisabled,
  onModelPress,
  onAttachPress,
  testID,
}: {
  label: string;
  dimmed: number;
  showAttach: boolean;
  attachDisabled: boolean;
  onModelPress: () => void;
  onAttachPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { colors, type } = theme;
  const modelPress = usePressFade();
  return (
    <View style={styles.secondRow}>
      <AnimatedPressable
        testID={testID ? `${testID}-model` : undefined}
        accessibilityRole="button"
        accessibilityLabel={`模型：${label}`}
        onPress={onModelPress}
        onPressIn={modelPress.onPressIn}
        onPressOut={modelPress.onPressOut}
        // 命中高补到 44dp 等效（视觉高 28 不变，F2 审计）：上下各扩 8
        hitSlop={{ top: 8, bottom: 8 }}
        style={[styles.modelButton, modelPress.fadeStyle]}
      >
        <>
          <Icon name="zap" size={14} color={colors.textSecondary} />
          <Text
            style={{
              fontSize: type.footnote.fontSize,
              lineHeight: type.footnote.lineHeight,
              fontWeight: '500',
              color: colors.textSecondary,
            }}
          >
            {label}
          </Text>
          <Icon name="chevron-down" size={11} color={colors.textSecondary} />
        </>
      </AnimatedPressable>
      <View style={styles.secondRowSpacer} />
      {/* 右侧动作簇：簇内间距 10（原型 .row-right-actions gap） */}
      <View style={styles.secondRowActions}>
        {showAttach ? (
          <AttachButton
            dimmed={dimmed}
            disabled={attachDisabled}
            onPress={onAttachPress}
          />
        ) : null}
      </View>
    </View>
  );
});

/** 快捷条（memo 子簇，C-PERF）：标签基元 + 稳定跳板，逐键整条跳过。 */
export const ComposerContextBar = memo(function ComposerContextBar({
  workspaceLabel,
  permissionLabel,
  onWorkspacePress,
  onPermissionPress,
  testID,
}: {
  workspaceLabel: string;
  permissionLabel: string;
  onWorkspacePress: () => void;
  onPermissionPress: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.contextBar}>
      <ContextCapsule
        icon="folder"
        label={workspaceLabel}
        onPress={onWorkspacePress}
        testID={testID ? `${testID}-workspace` : undefined}
        accessibilityLabel={`项目：${workspaceLabel}`}
      />
      <ContextCapsule
        icon="shield"
        label={permissionLabel}
        onPress={onPermissionPress}
        testID={testID ? `${testID}-permission` : undefined}
        accessibilityLabel={`权限：${permissionLabel}`}
      />
    </View>
  );
});

/**
 * 语音错误条（memo 子簇，C-PERF）：error 未变（常态为 null）时逐键
 * 跳过；回调经父级 voiceRef 跳板稳定化，不直收 voice 对象的方法。
 */
export const ComposerVoiceError = memo(function ComposerVoiceError({
  error,
  onRecover,
  onDismiss,
}: {
  error: VoiceInputApi['error'];
  onRecover: () => void;
  onDismiss: () => void;
}) {
  return (
    <VoiceErrorBar error={error} onRecover={onRecover} onDismiss={onDismiss} />
  );
});

/**
 * 语音浮层组（memo 子簇，C-PERF）：录音相位量（phase/level 等）是
 * 基元——录音中 level 逐帧变时只本组重渲染，不再连带输入卡整树；
 * 打字期这些量恒定，整组逐键跳过。
 */
export const ComposerVoiceOverlays = memo(function ComposerVoiceOverlays({
  phase,
  starting,
  displayText,
  level,
  dragX,
  dragY,
  gateVisible,
  gateState,
  modelTotalBytes,
  onConfirmDownload,
  onDismissGate,
}: {
  phase: VoiceInputApi['phase'];
  starting: boolean;
  displayText: string;
  level: number;
  dragX?: SharedValue<number>;
  dragY?: SharedValue<number>;
  gateVisible: boolean;
  gateState: VoiceInputApi['gateState'];
  modelTotalBytes: VoiceInputApi['modelTotalBytes'];
  onConfirmDownload: () => void;
  onDismissGate: () => void;
}) {
  return (
    <>
      <VoiceOverlay
        phase={phase}
        starting={starting}
        displayText={displayText}
        level={level}
        dragX={dragX}
        dragY={dragY}
      />
      <VoiceModelGate
        visible={gateVisible}
        state={gateState}
        modelTotalBytes={modelTotalBytes}
        onConfirmDownload={onConfirmDownload}
        onDismiss={onDismissGate}
      />
    </>
  );
});

/**
 * 输入框长按语音的启用判定（纯函数，测试钉口径）：语音链路在场、可
 * 编辑、未锁定即启用——**有无文字不问**（2026-11-03 用户裁决：长按
 * 输入框 = 语音输入、composer 麦克风钮删除，长按是唯一语音入口；推翻
 * FUNC 批「仅空输入启用」门——有内容时禁掉等于无路可走）。
 * 本判定只问「功能在场」：voice prop 由宿主无条件注入 useVoiceInput
 * 的返回值（恒在场，与 ASR 模型/引擎/权限是否就绪无关）——就绪与否
 * 在 pressStart 时才判，未就绪走既有呈现面（下载门 / VoiceErrorBar
 * 恢复动作），**永不以禁用手势的方式静默退化成文字选中**（交互合同：
 * composer 屏长按 = 语音，起不来给错误面，不给选字）。
 * 选字冲突处置（机制复盘 2026-11-03，用户实测长按只出原生选字）：
 * 本手势形状自 W-D 麦克风钮克隆而来——在麦克风上 handler 视图是普通
 * View、触摸流归 RNGH 所有，长按工作正常；FUNC 把同一形状原样搬到
 * 输入框时，GestureDetector 包的是输入框外层的 Animated.View 包裹
 * 层。Android 的 ReactEditText 是自处理原生视图：它消费自己的触摸
 * 流并以原生计时器（约 500ms）跑选字长按；handler 挂在祖先层上时
 * 既收不到可激活的事件序列、也无从向 EditText 投递 ACTION_CANCEL，
 * 长按从未激活过（onStart 零触发），500ms 处选字接管——FUNC 的空
 * 输入门又让这一失效长期无人触发、无人察觉，COMP-FORM 摘掉文字门
 * 后才在日常输入中暴露。现行处置：GestureDetector 直接包
 * AnimatedTextInput 本人（handler 视图 = EditText），长按 200ms 激
 * 活（先于原生 500ms 触发点）时 EditText 收到 ACTION_CANCEL，本次
 * 按压的选字/粘贴菜单被压掉、不与录音浮层同屏；漂移不判败与滑出
 * 不取消见 VOICE_LONG_PRESS_MAX_DISTANCE 与手势构造处注释。松手
 * onFinalize 即 pressEnd 结束录音。点按聚焦不受影响：点按时长不
 * 足，长按手势直接落败放行给 TextInput。
 */
/**
 * 输入框长按语音的启用判定（纯函数，单测钉死）：
 * 1. voice 接口在场；
 * 2. 未处于审批锁定态（!locked）；
 * 3. 彻底解耦 editable！本地 ASR 能力不受网络连接与编辑锁限制，断网亦可录音转写。
 */
export function inputVoiceGestureEnabled(args: {
  voicePresent: boolean;
  locked: boolean;
  editable?: boolean;
}): boolean {
  return args.voicePresent && !args.locked;
}

export const DEFAULT_COMPOSER_PLACEHOLDER = '点击发消息、长按语音输入';

export const Composer = memo(function Composer({
  value,
  onChangeText,
  onSubmit,
  canSubmit,
  editable,
  placeholder = DEFAULT_COMPOSER_PLACEHOLDER,
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
  const { colors, radius, size, space } = theme;
  const reduceTransparency = useReduceTransparency();

  // 原生输入框实例与文本镜像引用（缓冲隔离设计）：
  // textRef 实时镜像原生 TextInput 的当前内容，用于提交时直接读取最新文本并清空原生输入；
  const inputRef = useRef<TextInput | null>(null);
  const textRef = useRef(value ?? '');

  // 发送钮显隐按「有无内容」：受控 value 之外再记内部态——
  // 逐键守卫（C-PERF）：改走 ref 比对，仅在 hasText 布尔值发生真实翻转（空 -> 非空 或 非空 -> 空）时
  // 才触发内部状态重新计算（控制发送按钮颜色/显隐）；在连续敲击字母时，hasText 恒为 true，
  // 不触发组件额外重绘！
  const [hasText, setHasText] = useState(() => (value ?? '').trim().length > 0);
  const hasTextRef = useRef(hasText);
  const applyHasText = useCallback((next: boolean) => {
    if (hasTextRef.current === next) return;
    hasTextRef.current = next;
    setHasText(next);
  }, []);

  // 保持受控属性 value 更新（如语音输入回填、外部重置草稿）的兼容性：
  // 当外部传入的 value 发生变更时，同步更新 textRef 与 hasText 翻转状态
  useEffect(() => {
    const nextText = value ?? '';
    textRef.current = nextText;
    applyHasText(nextText.trim().length > 0);
  }, [value, applyHasText]);

  const handleChangeText = (text: string) => {
    textRef.current = text;
    applyHasText(text.trim().length > 0);
    onChangeText(text);
  };

  // 多行增高：实测内容高（onContentSizeChange）驱动。
  // 方案 05 优化（消灭 280ms 延时追赶）：直接瞬时同步 inputHeight.value = next，
  // 彻底消灭打字换行时“文字跑前面、框体在后头追”的输入跳跃与卡顿根源，
  // 实现文字折行与框体扩高的绝对零延迟浑然一体。
  const [expanded, setExpanded] = useState(false);
  // expanded 的逐键守卫（C-PERF，同 hasText）：onContentSizeChange 逐键
  // 到达，布尔未翻转时不提交状态。
  const expandedRef = useRef(false);
  const inputHeight = useSharedValue<number | undefined>(undefined);
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
    const nextExpanded = next > singleLineHeight + 2;
    if (expandedRef.current !== nextExpanded) {
      expandedRef.current = nextExpanded;
      setExpanded(nextExpanded);
    }
    // 瞬时直达，零补间延迟
    inputHeight.value = next;
  };

  // 恒两行形态（2026-11-03 用户裁决）：第二行在否只取决于 model 是否
  // 注入——无聚焦/内容触发、无第二行高度与透明度动画、无键盘跟随贴合
  // （旧展开状态机、快捷条变淡与 M-C 的键盘同源贴合随形态切换一并废
  // 止：没有切换，便没有需要贴合的动画）。锁定态亦不改形态（锁定只
  // 变实心/变淡，见文件头锁定条）。
  const twoRow = Boolean(model);

  // 输入框焦点态（双模分流与透明拦截层）：未聚焦时（!isFocused）顶层透明
  // 手势拦截层接管触控（pointerEvents="auto"），短按聚焦调起软键盘、长按 200ms
  // 触发吸附触感并唤醒语音；聚焦打字态（isFocused）透明层让出直通权（pointerEvents="none"），
  // 保证光标移动、选字与文字输入直通原生 TextInput。
  const [isFocused, setIsFocused] = useState(false);

  // 手势回调经 ref 桥接最新 voice 实例（worklet → runOnJS，模式同
  // SlideToConfirm）：手势对象本身不随渲染重建而失联。
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const voiceBridgeRef = useRef({
    onLongPressStart: () => {
      // 1. 触发严选的吸附触感（符合 feelInfra 门面）
      haptics.snap();
      // 2. 主动收起软键盘并失焦输入框
      Keyboard.dismiss();
      inputRef.current?.blur();
      setIsFocused(false);
      // 3. 呼起语音录音管线
      voiceRef.current?.pressStart();
    },
    onPanMove: (translationX: number, translationY: number) => {
      voiceRef.current?.pressMove(translationX, translationY);
    },
    onLongPressEnd: () => {
      const wasEditing = voiceRef.current?.phase === 'editing';
      voiceRef.current?.pressEnd();
      if (wasEditing) {
        // 右滑松手落入框内编辑：自动聚焦输入框并调起键盘供二次修改
        setTimeout(() => {
          inputRef.current?.focus();
          setIsFocused(true);
        }, 50);
      }
    },
    onTap: () => {
      // 点击分流：调用原生输入框聚焦，调起键盘
      inputRef.current?.focus();
      setIsFocused(true);
    },
  });

  // 宿主回调跳板（C-PERF）：宿主逐渲染重造 model / contextBar 对象
  // 字面量时其回调引用随之翻新，memo 子簇（第二行/快捷条/发送盘）若
  // 直收这些回调会被逐键击穿。最新回调统一经 ref 桥接（与 voice 的
  // bridgeRef 同模式），子簇只收稳定跳板 + 基元 props——memo 由此与
  // 宿主对象 identity 解耦，逐键时整簇跳过渲染。
  const latestCallbacksRef = useRef({
    onSubmit,
    onAttachPress,
    modelOnPress: model?.onPress,
    workspaceOnPress: contextBar?.onWorkspacePress,
    permissionOnPress: contextBar?.onPermissionPress,
  });
  latestCallbacksRef.current = {
    onSubmit,
    onAttachPress,
    modelOnPress: model?.onPress,
    workspaceOnPress: contextBar?.onWorkspacePress,
    permissionOnPress: contextBar?.onPermissionPress,
  };
  const handleSubmitPress = useCallback(() => {
    if (!canSubmit) return;
    const text = textRef.current;
    textRef.current = '';
    applyHasText(false);
    inputRef.current?.clear();
    // 发送消息生命周期闭环：触感反馈 + 强制失焦并收起软键盘，让输入框平滑回到最下面
    haptics.tap();
    inputRef.current?.blur();
    Keyboard.dismiss();
    setIsFocused(false);
    latestCallbacksRef.current.onSubmit(text);
  }, [canSubmit, applyHasText]);
  const handleAttachPress = useCallback(() => {
    latestCallbacksRef.current.onAttachPress?.();
  }, []);
  const handleModelPress = useCallback(() => {
    latestCallbacksRef.current.modelOnPress?.();
  }, []);
  const handleWorkspacePress = useCallback(() => {
    latestCallbacksRef.current.workspaceOnPress?.();
  }, []);
  const handlePermissionPress = useCallback(() => {
    latestCallbacksRef.current.permissionOnPress?.();
  }, []);
  // 语音浮层回调同走 voiceRef 桥（voice 对象由宿主 hook 逐渲染重造，
  // 直传其方法引用会逐渲染击穿浮层 memo）。
  const handleVoiceRecover = useCallback(() => {
    voiceRef.current?.recover();
  }, []);
  const handleVoiceDismissError = useCallback(() => {
    voiceRef.current?.dismissError();
  }, []);
  const handleVoiceConfirmDownload = useCallback(() => {
    voiceRef.current?.confirmDownload();
  }, []);
  const handleVoiceDismissGate = useCallback(() => {
    voiceRef.current?.dismissGate();
  }, []);

  // 输入框长按说话（2026-11-02 用户裁决立项；2026-11-03 麦克风钮删除
  // 后升为唯一语音入口）：走与旧麦克风同一条语音链路（同一 bridgeRef
  // → pressStart/pressMove/pressEnd，不另造第二套），有无文字都启用
  // （判定口径见 inputVoiceGestureEnabled；选字抑制的成败在手势**挂载
  // 点**不在此处配置——detector 必须直包输入框本人，见 JSX 处与判定
  // 头注的复盘）。上滑取消的位移语义由结对的 Pan 承担（pressMove；
  // 非录音相位由 voice 侧空转）。
  // 手势对象记忆化（C-PERF）：旧实现逐渲染在渲染体内重建整条手势链
  // 并交给 GestureDetector——逐键重注册手势。启用与否只取决于三个
  // 布尔（判定纯函数收敛为单值），以其为唯一依赖记忆：逐键渲染时
  // 手势对象 identity 不变；回调经 bridgeRef 桥接最新 voice，手势
  // 不会因记忆而失联（与桥的既有设计同构）。启用翻转时 useMemo 重
  // 建新对象、GestureDetector 随之换装新 handler——此路径有回归测
  // 试钉住（uiComposer 手势构造计数用例），不得退回渲染体内联构造。
  const voiceGestureEnabled = inputVoiceGestureEnabled({
    voicePresent: Boolean(voice),
    locked,
  });

  // 手势位移 Reanimated 共享变量（驱动流光大球水滴磁吸形变，120Hz 纯 UI 线程）
  const voiceDragX = useSharedValue(0);
  const voiceDragY = useSharedValue(0);

  const springConfig = theme.motion.spring.bouncy;
  const shuntingGesture = useMemo(() => {
    const longPress = Gesture.LongPress()
      .minDuration(200)
      // 漂移不判败（默认 10dp 上限是真机长按落败的另一半成因，
      // 见 VOICE_LONG_PRESS_MAX_DISTANCE）
      .maxDistance(VOICE_LONG_PRESS_MAX_DISTANCE)
      // 滑出输入框不取消：录音中上滑取消本就要滑出框界，取消
      // 会让 onFinalize 在手指未松时提前 pressEnd 误收尾
      .shouldCancelWhenOutside(false)
      // 激活时取消原生输入框触摸流，阻断系统选字与长按菜单
      .cancelsTouchesInView(true)
      .enabled(voiceGestureEnabled)
      .onStart(() => {
        'worklet';
        voiceDragX.value = 0;
        voiceDragY.value = 0;
        runOnJS(voiceBridgeRef.current.onLongPressStart)();
      })
      .onFinalize(() => {
        'worklet';
        voiceDragX.value = withSpring(0, springConfig);
        voiceDragY.value = withSpring(0, springConfig);
        runOnJS(voiceBridgeRef.current.onLongPressEnd)();
      });

    const pan = Gesture.Pan()
      // 与 LongPress 同口径：上滑轨迹滑出框界不判终局
      .shouldCancelWhenOutside(false)
      .cancelsTouchesInView(true)
      .enabled(voiceGestureEnabled)
      .onUpdate((event) => {
        'worklet';
        voiceDragX.value = event.translationX;
        voiceDragY.value = event.translationY;
        runOnJS(voiceBridgeRef.current.onPanMove)(
          event.translationX,
          event.translationY
        );
      })
      .onFinalize(() => {
        'worklet';
        voiceDragX.value = withSpring(0, springConfig);
        voiceDragY.value = withSpring(0, springConfig);
        runOnJS(voiceBridgeRef.current.onLongPressEnd)();
      });

    const tap = Gesture.Tap()
      .maxDuration(200)
      .onEnd(() => {
        'worklet';
        runOnJS(voiceBridgeRef.current.onTap)();
      });

    // 区分短按聚焦与长按触发语音录入（Exclusive 互斥）：
    // 1. 长按满 200ms：LongPress + Pan 激活，触发吸附微震并收起键盘录音，取消短按与原生选字；
    // 2. 短按未满 200ms 松手：LongPress 失败，Tap 胜出，触发 inputRef.focus() 聚焦发消息。
    const voiceSimultaneous = Gesture.Simultaneous(longPress, pan);
    return Gesture.Exclusive(voiceSimultaneous, tap);
  }, [voiceGestureEnabled, springConfig]);

  // 仅在深色模式且 iOS 环境下保留玻璃质感；浅色模式下强制禁用 glassActive！
  // 浅色模式下输入框必须是坚实纯净的纯白实体（#ffffff / colors.surface），杜绝图层混合发灰发脏
  const glassActive =
    Platform.OS === 'ios' && !reduceTransparency && !locked && theme.dark;
  const toolsDimmed = locked ? 0.35 : 1;

  // 输入卡软阴影（SVG 软阴影收编定案）：本卡是原型点名的悬浮面之一——
  // Android 浅色经 SoftShadow 的 composer 档（2026-11-03 校准 α +6 点）
  // 出两层投影，填充由卡 backgroundColor 单一承担；深色 SoftShadow 内部
  // 短路（边线由描边承担），iOS 无阴影（玻璃面）。
  // 尺寸提交纪律（M4 性能裁定）：卡高仍可被输入跨档增高补间逐帧驱动，
  // 动画期 onLayout 逐帧到达，逐帧写状态即逐帧全子树重渲染 + 滤镜整幅
  // 重栅格化。故实测先整数化进 ref：首次实测立即提交（挂载即出影，与旧
  // 行为一致）；其后变化须静默满 CARD_SIZE_SETTLE_MS 才提交，动画期
  // 阴影保持旧尺寸。
  const [cardSize, setCardSize] = useState({ width: 0, height: 0 });
  const committedCardSizeRef = useRef({ width: 0, height: 0 });
  const pendingCardSizeRef = useRef<{ width: number; height: number } | null>(
    null
  );
  const cardSizeSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  useEffect(
    () => () => {
      if (cardSizeSettleTimerRef.current !== null) {
        clearTimeout(cardSizeSettleTimerRef.current);
        cardSizeSettleTimerRef.current = null;
      }
    },
    []
  );
  const handleCardLayout = (e: LayoutChangeEvent) => {
    const width = Math.round(e.nativeEvent.layout.width);
    const height = Math.round(e.nativeEvent.layout.height);
    if (width <= 0 || height <= 0) return;
    const committed = committedCardSizeRef.current;
    if (width === committed.width && height === committed.height) {
      // 回到已提交尺寸（动画过冲回落等）：取消待提交，阴影无需动
      if (cardSizeSettleTimerRef.current !== null) {
        clearTimeout(cardSizeSettleTimerRef.current);
        cardSizeSettleTimerRef.current = null;
        pendingCardSizeRef.current = null;
      }
      return;
    }
    if (committed.width === 0) {
      // 首次实测：立即提交（保持挂载即出影的既有行为）
      committedCardSizeRef.current = { width, height };
      setCardSize({ width, height });
      return;
    }
    const pending = pendingCardSizeRef.current;
    if (pending && pending.width === width && pending.height === height) {
      // 同一待提交尺寸重复到达：计时已在跑，不重置（防逐帧重置饿死提交）
      return;
    }
    pendingCardSizeRef.current = { width, height };
    if (cardSizeSettleTimerRef.current !== null) {
      clearTimeout(cardSizeSettleTimerRef.current);
    }
    cardSizeSettleTimerRef.current = setTimeout(() => {
      cardSizeSettleTimerRef.current = null;
      const settled = pendingCardSizeRef.current;
      pendingCardSizeRef.current = null;
      if (settled) {
        committedCardSizeRef.current = settled;
        setCardSize(settled);
      }
    }, CARD_SIZE_SETTLE_MS);
  };
  // 发送盘 / 附件钮 / 第二行已抽为文件内 memo 子簇（AttachButton /
  // SendButton / ComposerSecondRow，见 ContextCapsule 后定义）：按压
  // 反馈钩子随组件内移，宿主回调经上方跳板收敛——逐键渲染时整簇
  // 跳过（C-PERF）。

  return (
    <>
      {contextBar ? (
        <ComposerContextBar
          workspaceLabel={contextBar.workspaceLabel}
          permissionLabel={contextBar.permissionLabel}
          onWorkspacePress={handleWorkspacePress}
          onPermissionPress={handlePermissionPress}
          testID={testID}
        />
      ) : null}
      {voice ? (
        <ComposerVoiceError
          error={voice.error}
          onRecover={handleVoiceRecover}
          onDismiss={handleVoiceDismissError}
        />
      ) : null}
      <View
        testID={testID ? `${testID}-shell` : 'composer-shell'}
        onLayout={handleCardLayout}
        collapsable={false}
        style={[
          styles.shell,
          {
            minHeight: size.composerMin,
            borderRadius: radius.composer,
            backgroundColor: theme.dark
              ? glassActive
                ? colors.surfaceTranslucent
                : colors.surface
              : colors.surface,
            // 描边（2026-11-03 降重调优）：浅色走 2.5% 极柔微描边（从 6% 进一步降低），
            // 彻底柔和融于背景；深色走 borderStrong
            borderWidth: 1,
            borderColor: theme.dark
              ? colors.borderStrong
              : 'rgba(0, 0, 0, 0.025)',
            // 原型 single-composer-view：内边距横 10
            paddingHorizontal: 10,
            // 无第二行上下 8（+ minHeight 52 居中托底）；两行形态上下
            // 10（原型 expanded-view padding 10px），与首行 36 + 行距 6
            // + 次行 36 合成总高 98
            paddingVertical: twoRow ? 10 : space.sm,
            overflow: glassActive ? 'hidden' : 'visible',
          },
        ]}
      >
        {/* Android SVG 软阴影（全 App 唯一阴影路径）：最底层，只画阴影
            不绘填充；Android 路径 overflow=visible 不裁出血区 */}
        {Platform.OS === 'android' && cardSize.width > 0 ? (
          <MemoSoftShadow
            width={cardSize.width}
            height={cardSize.height}
            borderRadius={radius.composer}
            variant="composer"
          />
        ) : null}
        {glassActive ? (
          <BlurView
            testID={testID ? `${testID}-blur` : 'composer-blur'}
            intensity={GLASS_BLUR_INTENSITY}
            tint={theme.dark ? 'dark' : 'light'}
            style={styles.glassFill}
            pointerEvents="none"
          />
        ) : null}
        <View style={styles.mainRow}>
          {!twoRow && onAttachPress ? (
            <AttachButton
              dimmed={toolsDimmed}
              disabled={!editable}
              onPress={handleAttachPress}
            />
          ) : null}
          <Animated.View
            testID={testID ? `${testID}-input-wrap` : 'composer-input-wrap'}
            style={[
              styles.inputWrap,
              animatedInputStyle,
              {
                // 首行托底 = 发送盘直径 36（对齐校准 2026-11-03）：单
                // 行时输入在 36 盒内垂直居中，文本中线与发送盘、工具
                // 钮图标同线（距行底 18）；多行增高后实测高胜出
                minHeight: size.sendButton,
              },
            ]}
          >
            {/* 底层：原生真实 TextInput（专注键盘输入、光标展示与文本渲染） */}
            <TextInput
              ref={inputRef}
              testID={testID}
              multiline
              value={value}
              onChangeText={handleChangeText}
              onContentSizeChange={handleContentSizeChange}
              editable={editable}
              maxLength={maxLength}
              placeholder={placeholder}
              contextMenuHidden={voiceGestureEnabled}
              selectTextOnFocus={false}
              blurOnSubmit={true}
              onSubmitEditing={() => {
                if (canSubmit) handleSubmitPress();
              }}
              placeholderTextColor={
                // 原型：单行占位 text-2、两行（展开）视图占位 text-3
                locked || expanded || twoRow
                  ? colors.textTertiary
                  : colors.textSecondary
              }
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
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

            {/* 顶层：透明手势拦截与双模分流层 (Transparent Interception Layer，方案 01 落地)
                未聚焦时（!isFocused）：pointerEvents="auto" 捕获 ACTION_DOWN，原生 EditText 未感知；
                聚焦打字态（isFocused）：让出直通权 pointerEvents="none"，光标点选/打字直通底层 TextInput */}
            {voiceGestureEnabled ? (
              <GestureDetector gesture={shuntingGesture}>
                <Animated.View
                  testID={
                    testID
                      ? `${testID}-voice-touch-overlay`
                      : 'composer-voice-touch-overlay'
                  }
                  pointerEvents={isFocused ? 'none' : 'auto'}
                  style={[StyleSheet.absoluteFill, styles.touchOverlay]}
                />
              </GestureDetector>
            ) : null}
          </Animated.View>
          {hasText || hasAttachments ? (
            <SendButton
              canSubmit={canSubmit}
              testID={testID}
              onSubmit={handleSubmitPress}
            />
          ) : null}
        </View>
        {model ? (
          <ComposerSecondRow
            label={model.label}
            dimmed={toolsDimmed}
            showAttach={Boolean(onAttachPress)}
            attachDisabled={!editable}
            onModelPress={handleModelPress}
            onAttachPress={handleAttachPress}
            testID={testID}
          />
        ) : null}
      </View>
      {voice ? (
        <ComposerVoiceOverlays
          phase={voice.phase}
          starting={voice.starting}
          displayText={voice.displayText}
          level={voice.level}
          dragX={voiceDragX}
          dragY={voiceDragY}
          gateVisible={voice.gateVisible}
          gateState={voice.gateState}
          modelTotalBytes={voice.modelTotalBytes}
          onConfirmDownload={handleVoiceConfirmDownload}
          onDismissGate={handleVoiceDismissGate}
        />
      ) : null}
    </>
  );
});

const styles = StyleSheet.create({
  shell: {
    flexDirection: 'column',
    // minHeight 托底时余量上下均分（内容未满托底高时），不再余量全沉底
    justifyContent: 'center',
  },
  // 原型 .composer-top-controls：容器上方、横排、条间距 12、下距 5；
  // 左内边距 14 = 零误差对齐（推导见文件头快捷条条目）；右内边距 16
  // （原型 padding 右值）
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 14,
    paddingRight: 16,
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
  secondRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: SECOND_ROW_HEIGHT,
    marginTop: SECOND_ROW_GAP,
  },
  secondRowSpacer: {
    flex: 1,
  },
  secondRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  modelButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    // 原型 .model-select-btn-transparent：padding 0 4px
    paddingHorizontal: 4,
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
    // 盒高 = 发送盘直径 36（对齐校准 2026-11-03）：图标在盒内居中，中线
    // 与发送盘、输入文本同线（距行底 18）；字形不变（20 图标居 32×36 盒）
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputWrap: {
    flex: 1,
    justifyContent: 'center',
  },
  touchOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  input: {
    flex: 1,
    paddingVertical: 0,
    textAlignVertical: 'center',
    // 剔除 Android 字体附加内距：字形按行高盒精确定心（对齐校准
    // 2026-11-03——保留默认内距时字形视觉中线随字体度量偏移、与按钮错位）
    includeFontPadding: false,
  },
  send: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default Composer;
