/**
 * 虚拟滚动与程序吸底手势解耦几何常量（SSOT）
 * 集中收敛亚像素容差、手势静默窗口与视口阈值，杜绝散落字面量。
 */

/** 程序滚动目标坐标亚像素匹配容差（px）：高 DPI 缩放下允许 ±2px 亚像素微差 */
export const PROGRAMMATIC_SCROLL_EPSILON_PX = 2;

/** 视口贴底判定亚像素容差（px，对齐 DIM-02 §1.3.2） */
export const BOTTOM_STICK_EPSILON_PX = 2;

/** 视口贴底容差兼容别名（px） */
export const SCROLL_FLOOR_EPSILON = BOTTOM_STICK_EPSILON_PX;

/** 物理手势结束后进入 Commit Epoch 的静默冻结窗口（ms） */
export const GESTURE_FREEZE_MS = 100;

/** 手势静默窗口兼容别名（ms） */
export const GESTURE_IDLE_MS = GESTURE_FREEZE_MS;

/**
 * 显著高度差（px）。
 * 已有实测高度时，不超过该阈值的复测视为亚像素噪声：不写入模型。
 * 否则模型先变、占位高度却留在上一帧，切标签时会按新模型重绘，文字上下跳几个像素。
 */
export const SIGNIFICANT_HEIGHT_DELTA_PX = 4;
export const SIGNIFICANT_HEIGHT_DELTA = SIGNIFICANT_HEIGHT_DELTA_PX;

/** 视口底部邻近阈值（px）：处于底部邻近区时不执行上方 deltaAbove 锚点补偿 */
export const NEAR_BOTTOM_EPSILON_PX = 16;
export const NEAR_BOTTOM_EPSILON = NEAR_BOTTOM_EPSILON_PX;

/** 默认虚拟滚动 overscan 条数 */
export const DEFAULT_OVERSCAN = 6;

/** 消息列表虚拟滚动视口外缓冲行数（SSOT） */
export const MESSAGE_VIEWPORT_OVERSCAN = 8;

/** 默认容器可视高度兜底值（px） */
export const DEFAULT_VIEWPORT_HEIGHT_PX = 600;

/** 离底显现“回到底部”悬浮按钮阈值（px） */
export const SCROLL_BOTTOM_THRESHOLD_PX = 120;
export const SCROLL_BOTTOM_THRESHOLD = SCROLL_BOTTOM_THRESHOLD_PX;

/** 视口顶部亚像素判定容差（px） */
export const SCROLL_TOP_EPSILON_PX = 2;

/** 垂直滚动条轨道/滑块区域命中宽度（px） */
export const SCROLLBAR_TRACK_HIT_WIDTH_PX = 20;

/** 亚像素微震过滤容差（px） */
export const SUBPIXEL_JITTER_EPSILON_PX = 1;
