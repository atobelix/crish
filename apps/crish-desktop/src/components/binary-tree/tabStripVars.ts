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
 */
export function paneTabStripVars(effectiveTabWidth: number): CSSProperties {
  return {
    '--tab-height': `${TAB_HEIGHT_PX}px`,
    '--tab-gap': `${TAB_GAP_PX}px`,
    '--tab-width-max': `${TAB_WIDTH_MAX_PX}px`,
    '--tab-width-min': `${TAB_WIDTH_MIN_PX}px`,
    '--tab-close-hit-pad': `${CLOSE_HIT_PAD_PX}px`,
    '--tab-item-width': `${effectiveTabWidth}px`,
  } as CSSProperties;
}

export function toolTabStripVars(): CSSProperties {
  return {
    '--tab-height': `${TAB_HEIGHT_PX}px`,
    '--tab-gap': `${TAB_GAP_PX}px`,
    '--tool-tab-width-max': `${TOOL_TAB_WIDTH_MAX_PX}px`,
  } as CSSProperties;
}
