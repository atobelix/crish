import React from 'react';

export interface ExtractedItemMeta {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * 遍历 JSX 子树静态提取 Item 元数据，确保在浮层未展开前 SelectValue 能即时解析 Label
 */
export function extractItemsFromChildren(
  children: React.ReactNode,
  result: Map<string, ExtractedItemMeta> = new Map()
): Map<string, ExtractedItemMeta> {
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as Record<string, unknown> | null | undefined;
    if (props) {
      if ('value' in props && typeof props.value === 'string') {
        const val = props.value;
        let label = '';
        if (typeof props.label === 'string') {
          label = props.label;
        } else if (typeof props.children === 'string') {
          label = props.children;
        } else if (props.label) {
          label = String(props.label);
        } else {
          label = val;
        }
        result.set(val, {
          value: val,
          label: label || val,
          disabled: Boolean(props.disabled),
        });
      }
      if (props.children) {
        extractItemsFromChildren(props.children as React.ReactNode, result);
      }
    }
  });
  return result;
}
