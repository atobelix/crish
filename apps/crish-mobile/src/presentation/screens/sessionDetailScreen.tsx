// 统一对话屏（移动界面统一方案 §2.1）：ConversationScreen 只按引擎
// 能力面渲染——消息流全屏滚动、上下边缘羽化（EdgeFade）、头栏/输入框
// 通透悬浮其上；引擎差异（远端会话 / 本地线程）全部在适配层，界面零分叉。
// 本文件同时保留远端宿主 SessionDetailScreen（构造远端引擎 → 统一屏），
// 既有路由与测试入口不变；本地宿主在 (main)/thread 路由（U2）。
// 2026-11-05 收敛：draft 伪会话状态机整体删除——本屏只被真实会话 id 打开
// （深链/通知恒真实 id，新建统一走主页，见 navigation/newConversation）；
// 头栏返回钮接入（导航语义矩阵：返回 = 上一个打开的界面）；regenerate
// 经 onRegenerate 通道下发（远端暂无桌面命令 → 诚实隐藏入口）。
// 审批统一交给全局 ApprovalFloat（悬浮于输入框上方）；引擎声明
// composer.locked 时 Composer 锁定（原型 approval-locked：输入禁用、
// 占位不换文，锁定以容器实心 + 工具图标变淡的形态表达）。
import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import { useTheme } from '@/adapters/platform/theme';
import type { TimelineRow } from '@/presentation/timeline/insertTimeSeparators';
import { TimelineView } from '@/presentation/timeline/TimelineView';
import { ConversationHeader } from '@/presentation/components/chat/SessionHeader';
import { useOpenDrawer } from '@/presentation/navigation/useOpenDrawer';
import { useNewConversation } from '@/presentation/navigation/newConversation';
import { safeCanGoBack, useSafeBack } from '@/presentation/navigation/useSafeBack';
import type { ConversationEngine } from '@/adapters/conversation/types';
import { useTimelineBottomInset } from '@/presentation/timeline/useTimelineBottomInset';
import { useRemoteConversationEngine } from '@/adapters/conversation/useRemoteConversationEngine';
import {
  AnimatedPressable,
  usePressFade,
} from '@/presentation/ui/pressFeedback';
import {
  AppText,
  Composer,
  ComposerAmbientVeil,
  DropdownMenu,
  EdgeFade,
  Screen,
  ScrollToBottomButton,
  SoftShadowSurface,
} from '@/presentation/ui';
import type { AnchorRect } from '@/presentation/ui/dropdownLayout';

export interface ConversationScreenProps {
  engine: ConversationEngine;
  /** 时间线跟随态（宿主持有：滚动跟随是屏幕 UI 态，两引擎共用） */
  follow: boolean;
  onFollowChange: (following: boolean) => void;
  /** 打开工具抽屉（宿主导航面；本地引擎无工具行，不传） */
  onOpenTools?: (focusId?: string) => void;
  /** 点击新建会话回调（统一协议：槽位重置 + 回主页新对话面） */
  onNewConversation?: () => void;
  /** 重新生成回调（能力驱动：宿主未声明该能力时工具栏诚实隐藏入口） */
  onRegenerate?: (messageId: string) => void;
  /** 是否允许重新生成（宿主按引擎能力注入；缺省 = 引擎空闲态） */
  canRegenerate?: boolean;
}

export function ConversationScreen({
  engine,
  follow,
  onFollowChange,
  onOpenTools,
  onNewConversation,
  onRegenerate,
  canRegenerate = !engine.busy,
}: ConversationScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const openDrawer = useOpenDrawer();
  const handleBack = useSafeBack();
  const handleNewConversation = useNewConversation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreAnchor, setMoreAnchor] = useState<AnchorRect | undefined>(
    undefined
  );
  // 停止生成 pill 按压反馈（按压过渡统一批口径）
  const stopPress = usePressFade();
  const listRef = useRef<FlatList<TimelineRow> | null>(null);
  /** 滚动门面（B4 SSOT）：由 TimelineView 装配，回底按钮唯一消费入口 */
  const scrollFacadeRef = useRef<(() => void) | null>(null);
  // 消费 Reanimated 共享键盘值（方案 19：120fps UI 线程微秒级同步拉伸与回缩）
  const keyboardAnimation = useReanimatedKeyboardAnimation();

  // 头栏返回钮：仅栈内确有上一界面时呈现（诚实呈现——冷启动深链无栈可回
  // 不造假钮）；路由变化（同屏换 id / push）引发宿主重渲时重估
  const canGoBack = safeCanGoBack();

  // 悬浮 Composer 占高与时间线底部避让推导：
  // 由 useTimelineBottomInset 单一真源管理——实测优先、刚性拦截 <= 0 的初次挂载无效帧、
  // 并以 Composer 实际两行高（98px）/ 单行高（52px）+ 快捷条 + 安全区 + 附件条进行精确物理保底。
  // 保证尾部消息在键盘未激活与激活时，距输入框顶部均保持 16~24px 的舒适空隙（2026-11-03 修复）。
  // timelineBottomInset（经 deriveTimelineBottomInset 推导、含 minOverlay
  // 保底）直传 TimelineView 的 bottomInset——波 5 单一推导收敛后，列表内
  // 不再有第二推导（旧实现 hook 产出无人消费、列表按无保底口径自算）。
  const { floatingHeight, overlayHeight, handleOverlayLayout, timelineBottomInset } =
    useTimelineBottomInset({
      bottomSafeArea: insets.bottom,
      hasContextBar: Boolean(engine.composer.contextBar),
      hasModelControl: Boolean(engine.composer.modelControl),
      hasAttachments: Boolean(engine.composer.hasAttachments),
      hasError: Boolean(engine.error),
      isBusyWithStop: Boolean(engine.busy && engine.stop),
      gap: theme.space.xl,
    });

  return (
    <Screen>
      {/* 全屏消息流（头栏与 Composer 均悬浮其上，内置 KeyboardChatScrollView 满页联动平移） */}
      <TimelineView
        blocks={engine.blocks}
        follow={follow}
        onFollowChange={onFollowChange}
        listRef={listRef}
        onOpenTools={onOpenTools}
        emptyTitle={engine.emptyState.title}
        emptyActionLabel={engine.emptyState.actionLabel}
        onEmptyAction={engine.emptyState.onAction}
        headerClearance={insets.top + theme.size.header + 4}
        bottomInset={timelineBottomInset}
        floatingOverlayHeight={overlayHeight}
        bottomGap={theme.space.xl}
        busy={engine.busy}
        anchorKey={`${engine.kind}:${engine.id}`}
        readyCover
        onRegenerate={onRegenerate}
        canRegenerate={canRegenerate}
        scrollFacadeRef={scrollFacadeRef as MutableRefObject<(() => void) | null>}
      />

      {/* 上下羽化：内容临近边缘渐隐（顶部羽化适度收紧至头栏高度约 80-84dp，释放阅读视口；
          底部 EdgeFade 消费 Reanimated 共享值，120fps 贴合 Composer，
          严禁越界进入 timelineBottomInset 的 gap 呼吸区，保证最后一条消息完整可见） */}
      <EdgeFade
        side="top"
        height={insets.top + theme.size.header}
      />
      <EdgeFade
        side="bottom"
        baseHeight={overlayHeight}
        keyboardHeightSV={keyboardAnimation.height}
        height={Math.max(0, floatingHeight)}
        fadeSpan={28}
      />

      {/* 悬浮头栏（通透，无底色）：[返回] 汉堡开抽屉 + 标题胶囊 + 新建 + 更多 */}
      <ConversationHeader
        title={engine.title ?? '会话'}
        onBack={canGoBack ? handleBack : undefined}
        onOpenDrawer={openDrawer}
        onNewConversation={() => {
          if (onNewConversation) {
            onNewConversation();
          } else {
            handleNewConversation({ closeDrawer: false });
          }
        }}
        onMore={() => setMenuOpen(true)}
        onMoreAnchorChange={setMoreAnchor}
      />

      {!follow ? (
        <ScrollToBottomButton
          alignment="right"
          bottomOffset={overlayHeight + theme.space.sm}
          onPress={() => {
            onFollowChange(true);
            // 滚动 SSOT 门面（B4）：目标含原生 inset 真值，禁直调 scrollToEnd
            scrollFacadeRef.current?.();
          }}
          testID="session-back-to-bottom"
        />
      ) : null}

      {/* 悬浮 Composer（透明底，白胶囊直接浮于滚动层上方）；
          KeyboardStickyView 承载：键盘动画期间逐帧贴键盘顶缘同步升降
          （WindowInsetsAnimationCompat），动画过程与结果同源同帧 */}
      <KeyboardStickyView
        onLayout={handleOverlayLayout}
        style={[
          styles.composerArea,
          {
            paddingHorizontal: theme.space.lg,
            paddingTop: theme.space.sm,
            paddingBottom: Math.max(insets.bottom, theme.space.sm),
          },
        ]}
      >
        {/* 宏观贯穿环境遮蔽大软阴影：位于最底层，贯穿全宽，隐藏消除双重遮罩冲突 */}
        <ComposerAmbientVeil
          testID="composer-ambient-veil"
          style={{ opacity: 0 }}
        />

        {engine.error ? (
          // 常驻错误条（与语音错误条同形态：dangerSoft 底、无阴影、
          // 文案占满整行，detail 续行呈现；关闭独立成行置于右端，
          // 不把文本压成窄列——横幅排版裁决 2026-11-02）。远端错误
          // 只有 message 时同一形态退化为单行文案。
          <View
            testID="session-error"
            style={[
              styles.errorBar,
              {
                backgroundColor: theme.colors.dangerSoft,
                borderRadius: theme.radius.menu,
                paddingHorizontal: theme.space.md,
                paddingVertical: theme.space.sm,
                marginBottom: theme.space.sm,
              },
            ]}
          >
            <AppText variant="footnote" color="danger">
              {engine.error.message}
              {engine.error.detail ? `\n${engine.error.detail}` : ''}
            </AppText>
            {engine.error.onDismiss ? (
              <AppText
                variant="footnote"
                color="textSecondary"
                onPress={engine.error.onDismiss}
                style={styles.errorDismiss}
              >
                关闭
              </AppText>
            ) : null}
          </View>
        ) : null}
        {engine.busy && engine.stop ? (
          // 停止生成（能力驱动：引擎声明 stop 且生成中才在场；
          // 未声明的引擎不渲染——不造假钮）
          <AnimatedPressable
            testID="session-stop"
            accessibilityRole="button"
            accessibilityLabel="停止生成"
            onPress={engine.stop}
            onPressIn={stopPress.onPressIn}
            onPressOut={stopPress.onPressOut}
            style={[
              styles.stopPill,
              {
                marginBottom: theme.space.sm,
              },
              stopPress.fadeStyle,
            ]}
          >
            <SoftShadowSurface
              preset="button"
              borderRadius={theme.radius.pill}
              fill={theme.colors.surfaceGrouped}
              fillStyle={{
                paddingHorizontal: theme.space.lg,
                paddingVertical: theme.space.sm,
                flexDirection: 'row',
                alignItems: 'center',
              }}
            >
              <AppText variant="footnote" color="textPrimary">
                停止生成
              </AppText>
            </SoftShadowSurface>
          </AnimatedPressable>
        ) : null}
        {engine.renderComposerLead ? engine.renderComposerLead() : null}
        <Composer
          testID="session-composer"
          placeholder={engine.composer.placeholder}
          value={engine.composer.prompt}
          onChangeText={engine.composer.setPrompt}
          onSubmit={engine.composer.submit}
          canSubmit={engine.composer.canSubmit}
          editable={engine.composer.editable}
          locked={engine.composer.locked}
          maxLength={4096}
          voice={engine.composer.voice}
          onAttachPress={engine.composer.onAttachPress}
          hasAttachments={engine.composer.hasAttachments}
          contextBar={engine.composer.contextBar}
          model={engine.composer.modelControl}
        />
      </KeyboardStickyView>

      {/* 更多菜单（引擎组装条目；远端 = 运行/终端/工具 + 会话操作）；
          几何单一真源 = anchorRect（打开前测量已就位） */}
      {moreAnchor ? (
        <DropdownMenu
          visible={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRect={moreAnchor}
          testID="session-menu"
          entries={engine.menuEntries}
        />
      ) : null}

      {/* 引擎专属浮层宿主（远端 = 五种 Sheet + 会话操作层） */}
      {engine.renderSheets()}
    </Screen>
  );
}

export interface SessionDetailScreenProps {
  sessionId?: string | null;
  onOpenRun?: (runId: string) => void;
  onOpenTerminal?: (runId: string) => void;
  /** 打开工具抽屉；focusId 为某组首个工具 id */
  onOpenTools?: (focusId?: string) => void;
}

/** 远端宿主：构造远端引擎并托管时间线跟随态，渲染统一对话屏 */
export default function SessionDetailScreen({
  sessionId,
  onOpenRun,
  onOpenTerminal,
  onOpenTools,
}: SessionDetailScreenProps) {
  const [follow, setFollow] = useState(true);

  const handleSent = useCallback(() => {
    setFollow(true);
  }, []);

  // 顶栏 "+"：统一新建协议——双模槽位重置 + 回主页新对话面
  //（2026-11-05 裁决；旧"就地变草稿"造成 URL 与画面脱钩，废止）
  const handleNewConversation = useNewConversation();

  const engine = useRemoteConversationEngine(
    sessionId ?? '',
    { onOpenRun, onOpenTerminal, onOpenTools },
    {
      follow,
      onSendSuccess: handleSent,
    }
  );

  return (
    <ConversationScreen
      engine={engine}
      follow={follow}
      onFollowChange={setFollow}
      onOpenTools={onOpenTools}
      onNewConversation={() => handleNewConversation({ closeDrawer: false })}
      // 远端 regenerate：桌面命令面暂无 regenerate 能力（全库核实），
      // 诚实隐藏入口（canRegenerate=false），待桌面命令立项后经
      // onRegenerate 通道开启——不造假钮（H6 口径）
      canRegenerate={false}
    />
  );
}

const styles = StyleSheet.create({
  composerArea: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  // 列布局：文案整行 + 关闭行（见错误条呈现处裁决注释）
  errorBar: { gap: 4 },
  errorDismiss: { alignSelf: 'flex-end' },
  stopPill: { alignSelf: 'center' },
});
