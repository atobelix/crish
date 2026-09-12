import type { CSSProperties } from 'react';
import { TOOL_OUTPUT_PIXEL_CAP } from '../../workers';

/**
 * Flow 输出区高度上限的唯一构造点（a_class_multi_writer 消解）。
 * --flow-output-max 与 maxHeight 必须同值同源，禁止在组件内各自重复构造。
 */
export const FLOW_OUTPUT_STYLE = {
  '--flow-output-max': `${TOOL_OUTPUT_PIXEL_CAP}px`,
  maxHeight: TOOL_OUTPUT_PIXEL_CAP,
} as CSSProperties;
