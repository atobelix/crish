/**
 * 标签条几何常量单一来源 —— 会话标签条（PaneHeader）与工具标签条（LeafToolTabStrip）
 * 及拖拽几何（sessionTabDragFeel）的唯一数值出处。
 *
 * 约束：
 * - CSS 侧由组件根节点把这里的值注入为同名 CSS custom properties，禁止在 CSS 里重写数字；
 * - JS 侧（拖拽指示器、光标对齐数学）直接 import 本模块；
 * - 改尺寸只改这里，CSS / JS / 测试自动跟随。
 */

/** 标签项高度（加号按钮等同行控件同高） */
export const TAB_HEIGHT_PX = 28;

/** 标签项之间的间隙 */
export const TAB_GAP_PX = 4;

/** 会话标签标准宽度（等宽契约基准） */
export const TAB_WIDTH_MAX_PX = 240;

/** 会话标签压缩下限（均分挤压的最低值） */
export const TAB_WIDTH_MIN_PX = 28;

/** 工具标签最大宽度（内容自适应，超长省略） */
export const TOOL_TAB_WIDTH_MAX_PX = 140;

/** 叉号中心相对标签右边缘的距离：右 padding 6px + 按钮 18px 半宽 9px */
export const CLOSE_BTN_RIGHT_OFFSET_PX = 15;

/** 等宽压缩计算中标签以外占用的固定空间（加号 + 间隙 + 容器内衬） */
export const NON_TAB_SPACE_PX = 36;

/** 关闭按钮伪元素热区外扩尺寸 */
export const CLOSE_HIT_PAD_PX = 4;

/** 头部拖拽启动位移阈值：低于该值的指针位移视为点击/双击，不进入窗口拖拽 */
export const DRAG_THRESHOLD_PX = 4;

/** 会话标签拖拽指示器宽度 */
export const INDICATOR_W_PX = 150;

/** 会话标签拖拽指示器高度 */
export const INDICATOR_H_PX = 26;
