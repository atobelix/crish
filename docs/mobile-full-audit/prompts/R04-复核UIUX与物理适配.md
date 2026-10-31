# R04 复核任务书 · UI/UX 体验与物理适配报告

- **被复核**：`docs/mobile-full-audit/audits/04-ui-ux-and-platform-adaptation-audit.md`
- **产出（唯一）**：`C:\Software\conex\docs\mobile-full-audit\reviews\R04-uiux-review.md`
- **必读**：`docs/mobile-full-audit/prompts/00-共同约束前言.md`（第三、八、九节必须遵守）

## 你的角色

对抗式复核员。这份报告列了 17 项缺陷、结论大量涉及 **Android 真机行为**。你要判断：哪些是读代码就能确认的，哪些其实依赖平台行为（edge-to-edge、软键盘模式、formSheet 在 Android 的实现）而报告没有证据。

## 核查重点

1. **DEF-15「SlideToConfirm 每帧 setState + `useNativeDriver:false`」**：读 `src/presentation/components/blocks/SlideToConfirm.tsx` 全文，确认 `onPanResponderMove` 里是否真的每帧调用 `setState`；`useNativeDriver` 取值在哪些动画上为 false；“高刷屏下一秒上百次重渲染”需要用代码证明（被 `Animated.Value` 驱动还是 state 驱动？React Compiler 是否已启用并影响结论？app 已启用 React Compiler，请考虑其影响）。
2. **DEF-01「approvals 与 tools 在 Android 退化为全屏卡片、标题遮挡、无退出按钮」**：核实 `react-native-screens` 4.x 在 Android 上对 `presentation: 'formSheet'` 与 `sheetAllowedDetents` 的**真实支持情况**（读 `node_modules/react-native-screens` 源码或类型定义）；若 Android 实际支持 formSheet，则报告此条的前提不成立。核实 `Screen topInset` 的真实用法。
3. **DEF-04「输入框与软键盘间 34px 死缝」**：核实 `app.json` 的 `softwareKeyboardLayoutMode`、Android 是否启用 edge-to-edge、`useSafeAreaInsets().bottom` 在键盘弹出时的真实取值——**这是平台行为，若无法从代码推出，判 ❓ 并写验证实验**。
4. **DEF-06/07（手动配对页无 ScrollView、抽屉搜索被键盘盖死）**：读对应文件确认；抽屉搜索被盖死的问题用户已在真机上亲自确认过（见 N03 任务书），此条请重点核实报告的修复建议是否与 N03 的重排方案冲突。
5. **DEF-08「缺 keyboardShouldPersistTaps 导致首击被吞」**：核实 `TimelineView.tsx`、`CrishDrawer.tsx`（已有 `keyboardShouldPersistTaps="handled"`，请核实其余列表）；RN 默认值与行为给出出处。
6. **DEF-11「验证码 6 位自动提交无任何 Loading」**：读 `accountCodeScreen.tsx` 全文，是否真无任何 busy 视觉？`AuthField`/`AuthButton` 是否有 loading 态而该页没用？
7. **DEF-13「密码登录吞掉网络错误，统一报‘邮箱或密码不正确’」**：读 `accountPasswordScreen.tsx` 与 `loginAccountWithPassword` 的错误通路，核实网络超时会走哪个分支。
8. **DEF-17「42 处硬编码间距」**：**自己 grep 复数一遍**（给出命令与结果），核实数字；核实 `styleTokens.guard.test.ts:18` 是否真的遗漏间距。
9. 报告对“卡顿/迟钝”的**归因链**（手势、验证码、点击吞噬、打字抖动）：哪些是读代码证实的，哪些是推测？“打字抖动”依赖 TimelineView 未 memo——核实，并考虑 React Compiler 的自动 memo。

## 遗漏扫描范围

`src/presentation/**` 全量；`app/**`；`src/adapters/platform/theme.ts`。**额外必查（用户新需求相关）**：全工程所有边框/聚焦环/阴影/动画描边的位置（`borderColor`、`borderWidth`、`outline`、`shadow*`、`elevation`、对 `border*` 的 `Animated`/`useAnimatedStyle` 插值），逐一登记（文件:行号、用途、是否随状态动画）。这份登记表是 N02 席位的输入，请单列「描边清单」章节。

## 输出

按前言第七、八节的结构；第 3 节为逐条判定表 + 汇总表 + 遗漏项 + 描边清单。
