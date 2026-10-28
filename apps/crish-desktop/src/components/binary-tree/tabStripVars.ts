import type { CSSProperties } from 'react';
import {
  CLOSE_HIT_PAD_PX,
  TAB_GAP_PX,
  TAB_HEIGHT_PX,
  TAB_WIDTH_MAX_PX,
  TAB_WIDTH_MIN_PX,
  TOOL_TAB_WIDTH_MAX_PX,
} from '../../utils/tabStripGeometry';

/**
 * binary-tree 页签条 custom-prop 变量的唯一构造点（a_class_multi_writer 消解）。
 * PaneHeader（主页签条）与 LeafToolTabStrip（工具页签条）各自的容器变量
 * 全部由此模块构造，token 名不得散落到组件文件。
 *
 * 命名空间（2026-10-20）：统一使用 `--pane-tab-*` 私有前缀，与 ui/Tabs 的组件孤岛
 * `--tab-*` 隔离（token SSOT 门禁 namespace_overlap 清零）；同时不再借用全局
 * `--tab-gap`（密度档 A 类 token），本组件按自身几何常量独立注入。
 */
export function paneTabStripVars(effectiveTabWidth: number): CSSProperties {
  return {
    '--pane-tab-height': `${TAB_HEIGHT_PX}px`,
    '--pane-tab-gap': `${TAB_GAP_PX}px`,
    '--pane-tab-width-max': `${TAB_WIDTH_MAX_PX}px`,
    '--pane-tab-width-min': `${TAB_WIDTH_MIN_PX}px`,
    '--pane-tab-close-hit-pad': `${CLOSE_HIT_PAD_PX}px`,
    '--pane-tab-item-width': `${effectiveTabWidth}px`,
  } as CSSProperties;
}

export function toolTabStripVars(): CSSProperties {
  return {
    '--pane-header-height': '28px',
    '--pane-tab-height': `${TAB_HEIGHT_PX}px`,
    '--pane-tool-tab-height': '24px',
    '--pane-tab-gap': `${TAB_GAP_PX}px`,
    '--tool-tab-width-max': `${TOOL_TAB_WIDTH_MAX_PX}px`,
    '--pane-action-btn-size': '20px',
  } as CSSProperties;
}
