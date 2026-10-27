# 分维详案：ColorPicker 与 TextMorph 数值及格式渐变动效分析

> **战役工作区**：`docs/arc-library-animation-study/`  
> **专题维度**：ColorPicker 颜色体系切换、TextMorph 字形形变算法与数值平滑动画  
> **权威对标参考**：`reference/arc-library/registry/components/color-picker/`、`reference/arc-library/registry/components/text-morph/`  
> **项目对齐标的**：`apps/crish-desktop/src/api/theme*.ts`、`apps/crish-desktop/src/components/chat-message-row/colorPickerUtils.ts`、`apps/crish-desktop/src/styles/tokens-palette.css`

---

## 一、ColorPicker 核心交互场景与动效解密

在 `arc-library` 的 `ColorPicker`（`color-picker.tsx`）中，用户点击格式切换按钮（`cycleFormat`）可在 `HEX`、`RGB`、`HSL`、`OKLCH` 四种色彩空间之间循环切换。整个过程伴随两大精密动效：
1. **格式按钮自身的就地字符变形**（Format Button Label Morphing）；
2. **输入框内颜色代码字符串的高阶字符补间**（Input Field Value Morphing Overlay）。

### 1.1 格式按钮的就地字符变形
- **实现代码**：`color-picker.tsx:474-476`
  ```tsx
  <button type="button" className={styles.format} onClick={cycleFormat} aria-label={`Format: ${formatNames[kind]}. Switch format`}>
    <TextMorph>{formatNames[kind]}</TextMorph>
  </button>
  ```
- **机制剖析**：
  格式按钮通过直接包裹 `<TextMorph>`，在 `kind` 从 `hex` 切换到 `rgb`、`hsl`、`oklch` 时，字符会在按钮内部直接完成“共有字符位置平滑滑动、新字符柔和浮现、旧字符微模糊退场”的字形补间，按钮宽度跟随文字长度以弹簧形式自适应展开，杜绝了普通文本替换的生硬闪动。

### 1.2 输入框色彩字符串变形：双阶段 RAF + 伪装遮罩层 + 延时交割
原生的 HTML `<input>` 具有焦点、选区、光标和输入法（IME）控制逻辑，无法直接对其内部的文本节点做 CSS 变换或 Motion 逐字动画。`arc-library` 巧妙利用了**“双阶段 RAF + 绝对定位遮罩 + 延时交割”**策略：

#### 核心状态与切流逻辑
- **状态定义**（`color-picker.tsx:262`）：
  ```tsx
  const [morph, setMorph] = useState<{ id: number; from: string; to: string; phase: 0 | 1 } | null>(null);

  function cycleFormat() {
    const next = formats[(formats.indexOf(kind) + 1) % formats.length]!;
    setKind(next); setDraft(null); setInvalid(false);
    if (!reduced) setMorph({ id: Date.now(), from: text, to: format(hsva, next), phase: 0 });
  }
  ```
- **双阶段推进**（`color-picker.tsx:361-370`）：
  ```tsx
  // 阶段 0 -> 阶段 1：利用 requestAnimationFrame 确保旧文字已稳定挂载后，再切入新文字目标
  useEffect(() => {
    if (!morph || morph.phase === 1) return;
    const frame = requestAnimationFrame(() =>
      setMorph(current => current && current.id === morph.id ? { ...current, phase: 1 } : current)
    );
    return () => cancelAnimationFrame(frame);
  }, [morph]);

  // 阶段 1 -> 销毁：预留 620ms（覆盖 TextMorph 约 420ms 弹簧与交错时长）后清理遮罩
  useEffect(() => {
    if (!morph || morph.phase === 0) return;
    const timer = window.setTimeout(() =>
      setMorph(current => current?.id === morph.id ? null : current), 620
    );
    return () => window.clearTimeout(timer);
  }, [morph]);
  ```
- **DOM 结构与透明度伪装**（`color-picker.tsx:477-487`、`color-picker.module.css:73-75`）：
  ```tsx
  <span className={styles.inputWrap}>
    <input
      ref={inputRef}
      className={styles.input}
      value={draft ?? text}
      data-morphing={morph ? "" : undefined}
      onChange={...}
    />
    {morph && (
      <span className={styles.morph} aria-hidden="true">
        <TextMorph>{morph.phase === 0 ? morph.from : morph.to}</TextMorph>
      </span>
    )}
  </span>
  ```
  ```css
  .input[data-morphing] { color: transparent; }
  .morph { position: absolute; inset: 0; display: flex; align-items: center; overflow: hidden; pointer-events: none; }
  ```

#### 时序流程分解
1. **触发挂载（Phase 0）**：用户点击格式切换，`setMorph({ phase: 0, from: "#2F6BFF", to: "rgb(47 107 255)" })`。`<input>` 被加上 `data-morphing`，文字颜色瞬间变为 `transparent`；同时上层绝对定位的 `.morph` 挂载 `<TextMorph>{morph.from}</TextMorph>`。用户肉眼看到的依然是上一状态的字符串，位置完全对齐。
2. **启动形变（Phase 1）**：下一帧 RAF，`phase` 变为 `1`，`<TextMorph>` 的 children 变更为 `morph.to`。此时内部触发字符匹配与位置弹簧滑动。
3. **安全交割（Timeout Settle）**：620ms 后动画收敛，`morph` 置为 `null`，`.morph` 卸载，原生 `<input>` 的文本颜色恢复，用户可直接进行光标选中、复制、打字编辑。整个过程兼顾了电影级的平滑视觉与原生的完整输入编辑能力。

---

## 二、TextMorph 核心算法深度剖析

`reference/arc-library/registry/components/text-morph/text-morph.tsx` 仅用约 80 行代码便实现了极高完成度的字形变形系统。

### 2.1 字符出现频次映射算法（`toGlyphs`）
```typescript
// text-morph.tsx:19-23
function toGlyphs(text: string) {
  const seen = new Map<string, number>();
  return Array.from(text).map(char => {
    const count = seen.get(char) ?? 0;
    seen.set(char, count + 1);
    return { char, key: `${char}-${count}` };
  });
}
```
- **算法核心逻辑**：
  - 若单纯使用字符本身为 key，重复字符（如 `rgb(47 107 255)` 中的三个空格或两个 `5`）会导致 React Key 冲突；
  - 若使用数组下标（index）为 key，一旦字符串长度改变或字符插入，所有后续字符会被 React 判定为完全变动，无法实现跨索引位置的字符保留与滑动；
  - `toGlyphs` 采用 **“字符 + 出现频次索引”** 作为全局唯一 Key（例如第一个 `5` 是 `5-0`，第二个 `5` 是 `5-1`）。
  - 当字符串从 `Publishing` 变到 `Published` 时，共有字符 `P-0, u-0, b-0, l-0, i-0, s-0, h-0` 保持绝对恒等，React 直接复用组件实例，触发 `layout="position"` 的物理平移。

### 2.2 共有字符与新字符分流（`kept` 机制与阶梯入场）
```typescript
// text-morph.tsx:35-39, 67
const [labels, setLabels] = useState({ current: children, previous: children });
if (labels.current !== children) setLabels({ current: children, previous: labels.current });
const kept = useMemo(() => new Set(toGlyphs(labels.previous).map(glyph => glyph.key)), [labels.previous]);
let entering = 0;
```
- 在渲染循环中：`const order = kept.has(key) ? 0 : entering++;`
- **关键机制**：
  - **共有字符（Preserved Glyphs）**：`kept.has(key) === true`，其 `order` 恒为 `0`，没有入场阶梯延迟，直接以 `layout: motionTokens.spring.morph` 沿弹簧轨道平滑滑动；
  - **新增字符（Entering Glyphs）**：只有未曾在上一状态出现的新字符，才获得递增的 `order`，产生精密的逐字交错延迟：
    $$\text{delay} = \text{HANDOFF} + \min(\text{order}, 8) \times \text{stagger.char} \times 2$$
    其中 `HANDOFF = 0.05s`（50ms），确保退场字符先启动散开，新增字符随后有序浮现，避免重叠重影。

### 2.3 PopLayout 模式与光学模糊（Optical Blur）
```tsx
// text-morph.tsx:66-74
<AnimatePresence mode="popLayout" initial={false}>
  {glyphs.map(({ char, key }) => {
    const order = kept.has(key) ? 0 : entering++;
    return (
      <motion.span
        key={key}
        layout="position"
        className={styles.glyph}
        initial={reduced ? false : { opacity: 0, scale: .8, y: "0.14em", filter: blurred }}
        animate={{ opacity: 1, scale: 1, y: "0em", filter: "blur(0px)" }}
        exit={reduced ? { opacity: 0, transition: { duration: 0 } } : {
          opacity: 0, scale: .86, y: "-0.1em", filter: blurred,
          transition: { duration: motionTokens.duration.exit, ease: standard }
        }}
        transition={reduced ? { duration: 0 } : {
          layout: motionTokens.spring.morph,
          default: {
            duration: motionTokens.duration.standard + .04,
            ease: enter,
            delay: HANDOFF + Math.min(order, 8) * motionTokens.stagger.char * 2
          }
        }}
      >
        {char === " " ? "\u00a0" : char}
      </motion.span>
    );
  })}
</AnimatePresence>
```
1. **`mode="popLayout"`**：退出中的字符立刻被设为 `position: absolute` 脱离正常文档流，后续字符立刻以实际排版位置开始计算布局，完全消除了退场字符占位引发的排版抖动；
2. **光学景深模糊**：入场与退场均配合 `blur(4px)`（`motionTokens.blur.soft`），使字符的诞生与消亡具有类似光学镜头的景深对焦感；
3. **空格保活**：`{char === " " ? "\u00a0" : char}`，使用不换行空格 `&nbsp;` 防止浏览器 inline 盒模型吞噬连续空白。

### 2.4 双层容器测量与无抖动弹簧宽度
- **结构设计**（`text-morph.tsx:65` 与 `text-morph.module.css:4-6`）：
  - 外层 `.frame`：带有显式像素宽度的受控弹性盒；
  - 内层 `.track`：由字形排版自然决定的真实宽度无约束容器。
  - 边缘蒙版：外层 `.frame` 具备 `mask-image: linear-gradient(90deg, #000 calc(100% - .5em), transparent)`，在宽度伸缩时给边缘字符提供柔和过渡，杜绝硬切。
- **绘制前瞬时测算与弹簧过渡**（`text-morph.tsx:41-48`）：
  ```tsx
  useLayoutEffect(() => {
    const frameElement = frame.current, trackElement = track.current;
    if (!frameElement || !trackElement) return;
    const next = measure(trackElement);
    if (!Number.isFinite(next)) return;
    if (width.current && Math.abs(next - width.current) > .5 && !reduced) {
      sizing.current = animate(frameElement, { width: next }, motionTokens.spring.morph);
    } else {
      sizing.current?.stop();
      frameElement.style.width = `${next}px`;
    }
    width.current = next;
  }, [children, reduced]);
  ```
- **ResizeObserver 响应式环境自适应**（`text-morph.tsx:51-61`）：
  当 WebFont 加载完成、系统 DPI 或全局 rem 缩放触发时，`ResizeObserver` 会直接将最新宽度瞬时赋给 `.frame`，不走用户交互时的弹簧过渡，保证响应式布局迅速到位。

---

## 三、Contrast Ratio 对比度数值的高性能弹簧驱动

在 `ColorPicker` 的对比度显示区域（`color-picker.tsx:491-502`），对比度读数（如 `4.52:1`）伴随拖动和颜色变化以高帧率平滑滚动，且**完全不触发父组件及周边控件的 React 重渲染**。

### 3.1 `useFollow`：物理阻尼驱动器
```tsx
// color-picker.tsx:172-181
function useFollow(target: number, reduced: boolean, dragging = false) {
  const value = useMotionValue(target);
  useEffect(() => {
    if (reduced) { value.jump(target); return; }
    const controls = animate(value, target, dragging ? dragSpring : thumbSpring);
    return () => controls.stop();
  }, [dragging, reduced, target, value]);
  return value;
}
```
- `thumbSpring`: `physical(visualDuration: 0.26, bounce: 0)`（点击色块时 260ms 快速平稳落定）；
- `dragSpring`: `physical(visualDuration: 0.1, bounce: 0)`（拖拽取色球时 100ms 紧随指针，零延迟粘手感）；
- **物理初速度继承（Retargeting）**：当连续拖动或高频变化时，Motion 底层保留当前运动的切线瞬时初速度，重定向至新目标点，不会发生任何物理跳突。

### 3.2 `useTransform` 与零 React 重新渲染机制
```tsx
// color-picker.tsx:429-430, 493
const ratioValue = useFollow(ratio, reduced);
const ratioText = useTransform(ratioValue, v => v.toFixed(2));

// JSX 渲染位置：
<span className={styles.ratio}>
  <motion.span>{ratioText}</motion.span>:1
</span>
```
- **核心优势**：
  1. `ratioValue` 是纯数字 `MotionValue`；
  2. `ratioText` 经 `useTransform` 派生为格式化两位小数的字符串 `MotionValue`；
  3. 当 `<motion.span>` 的子节点直接绑定 `MotionValue` 时，Motion 内部会直接订阅并在 RAF 周期内直写 DOM 的 `textContent`；
  4. **每秒 120 帧高刷插值过程中，仅修改当前 `<span>` 的文本内容，ColorPicker 的 2D 拾色板、滑块、色板列表均不会触发任何一次 React Fiber Reconciliation / Virtual DOM Diff**，CPU 消耗低至微秒级。

---

## 四、对比 Conex 项目现状与不足分析

### 4.1 现状与差距对比矩阵

| 评估维度 | arc-library 架构标杆 | Conex 当前现状 (`apps/crish-desktop`) | 差距与影响分析 |
| :--- | :--- | :--- | :--- |
| **色彩空间支持** | 完整覆盖 Hex, RGB, HSL, OKLCH，具备严谨的双向 LMS 立方根矩阵转换 | 仅包含基础 Hex/HSV 互转；OKLCH 仅为经验近似公式（`oklchColorGuard.ts`） | 遇到极端彩度颜色时，Conex 计算出的对比度与亮度容易失真 |
| **文字形变系统** | 具备通用 `TextMorph` 组件，按字符频次索引建立持久 Key，支持弹性自适应宽度 | **完全缺失**。全仓文本切换均为瞬间替换或普通 opacity 渐隐 | 状态流转（如 Agent 任务状态切换）缺乏视觉流动性与生动感 |
| **高精取色器** | 完整的 2D Saturation-Value 面板、Hue/Alpha 滑块、色板拖拽排序与 EyeDropper 原生集成 | 仅在消息行钉选中包含极简的 6 个固定圆点预设选择（`colorPickerUtils.ts`） | 无法满足深度个性化主题定制需求 |
| **对比度指示** | 实时 WCAG 2.1 相对亮度计算，结合 `useFollow` + `useTransform` 零重渲染渲染读数 | 仅粗暴按 `oklch.l > 0.52` 做二元浅灰/深炭黑判定 | 无法提供精确的 AA / AAA 标准指示 |

---

## 五、Conex 可落地的工程升级方案

Conex 的 `apps/crish-desktop` 已经安装了 `"motion": "^13.2.0"` 与 `"react": "^19.1.1"`，在底层依赖上与 `arc-library` 完全一致，具备零新引入依赖、无损落地的最佳条件。

### 5.1 实施路径
1. **构建精确色彩数学模块**：
   在 `apps/crish-desktop/src/utils/colorMath.ts` 中引入标准的 Linear/LMS/OKLCH 矩阵算法，统一作为全仓色彩计算单一真理源（SSOT）。
2. **封装通用 `<TextMorph>` 组件**：
   在 `apps/crish-desktop/src/components/ui/TextMorph/` 封装通用组件，并优先接入：
   - Agent 任务状态徽章（`Thinking` $\to$ `Running Tool` $\to$ `Done`）；
   - 模型切换标签；
   - 会话状态读数。
3. **落地专业级 `<ColorPicker>` 组件**：
   复刻 2D SV 拾色板、双阶段 RAF 遮罩与 `useFollow` 零重渲染对比度指示仪，并集成桌面端原生的 `window.EyeDropper` API，供主题设置与个性化皮肤深度消费。
