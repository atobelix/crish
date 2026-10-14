/**
 * apps/crish-desktop/src/i18n/Trans.tsx
 *
 * 轻量富文本国际化插槽组件（Trans）。
 *
 * 核心特性：
 * 1. 零外部重量级依赖；
 * 2. 支持上下文翻译解析与显式 fallback 降级；
 * 3. 支持 XML/HTML 风格标签（单层、嵌套如 <a><b>...</b></a>、索引如 <0>...</0>）映射至 React 节点；
 * 4. 支持 {param} 变量安全插值（字符串、数字及 ReactNode）；
 * 5. 极端异常与缺键容灾：在遇到语法破损、未闭合标签或缺失翻译时，安全平滑降级，绝不白屏。
 */

import React, { useContext } from 'react';
import { I18nContext, getGlobalActiveTranslator } from './I18nContext';
import type { KnownTranslationKey } from './types';

export interface TransProps {
  /** 国际化字典键名 */
  i18nKey?: KnownTranslationKey | (string & {});
  /** 插槽组件映射表（如 { b: <strong />, link: <a href="..." />, 0: <span /> }） */
  components?: Record<
    string,
    React.ReactElement | ((children: React.ReactNode) => React.ReactNode)
  >;
  /** 变量插值映射表（如 { name: 'Alice', count: 42 }） */
  values?: Record<string, unknown>;
  /** 显式兜底文本 */
  fallback?: string;
  /** 默认子节点或模板内容 */
  children?: React.ReactNode;
  /** 可选命名空间（向前兼容） */
  ns?: string;
}

/**
 * 对普通文本中的 {param} 进行变量安全插值
 */
function interpolateText(
  text: string,
  values?: Record<string, unknown>,
  keyPrefix = 'interp'
): React.ReactNode[] {
  if (!values || Object.keys(values).length === 0) {
    return [text];
  }

  const result: React.ReactNode[] = [];
  const regex = /\{([a-zA-Z0-9_]+)\}/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const preceding = text.slice(lastIndex, match.index);
    if (preceding) {
      result.push(preceding);
    }

    const paramKey = match[1];
    if (paramKey && Object.prototype.hasOwnProperty.call(values, paramKey)) {
      const val = values[paramKey];
      if (React.isValidElement(val)) {
        result.push(
          React.cloneElement(val, { key: `${keyPrefix}-${result.length}` })
        );
      } else if (val === null || val === undefined) {
        // 空值安全消解，不输出 "undefined"
      } else if (typeof val === 'number') {
        result.push(Number.isNaN(val) ? '-' : String(val));
      } else {
        result.push(String(val));
      }
    } else {
      // 缺参保留原占位符，不破坏句子排版
      result.push(match[0]);
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    result.push(text.slice(lastIndex));
  }

  return result;
}

/**
 * 递归解析带有 XML/HTML 风格标签与 {param} 插值的模板文本为 ReactNode 数组
 */
function parseTemplate(
  text: string,
  components: Record<
    string,
    React.ReactElement | ((children: React.ReactNode) => React.ReactNode)
  >,
  values?: Record<string, unknown>,
  keyPrefix = 'trans'
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < text.length) {
    const openTagStart = text.indexOf('<', index);
    if (openTagStart === -1) {
      // 剩余全为纯文本
      const remainingText = text.slice(index);
      if (remainingText) {
        nodes.push(
          ...interpolateText(
            remainingText,
            values,
            `${keyPrefix}-${nodes.length}`
          )
        );
      }
      break;
    }

    // 处理标签前的文本
    if (openTagStart > index) {
      const precedingText = text.slice(index, openTagStart);
      nodes.push(
        ...interpolateText(
          precedingText,
          values,
          `${keyPrefix}-${nodes.length}`
        )
      );
    }

    // 匹配常规开标签 <tag>
    const tagMatch = text.slice(openTagStart).match(/^<([a-zA-Z0-9_]+)>/);
    if (!tagMatch) {
      // 检查自闭合标签 <tag/>
      const selfCloseMatch = text
        .slice(openTagStart)
        .match(/^<([a-zA-Z0-9_]+)\s*\/>/);
      if (selfCloseMatch && selfCloseMatch[1]) {
        const tagName = selfCloseMatch[1];
        const slot = components[tagName];
        const nodeKey = `${keyPrefix}-self-${nodes.length}`;
        if (React.isValidElement(slot)) {
          nodes.push(React.cloneElement(slot, { key: nodeKey }));
        } else if (typeof slot === 'function') {
          nodes.push(
            <React.Fragment key={nodeKey}>{slot(null)}</React.Fragment>
          );
        }
        index = openTagStart + selfCloseMatch[0].length;
        continue;
      }

      // 普通 '<' 字符或不规则闭标签，直接作为文本输出
      nodes.push('<');
      index = openTagStart + 1;
      continue;
    }

    const tagName = tagMatch[1];
    if (!tagName) {
      nodes.push('<');
      index = openTagStart + 1;
      continue;
    }
    const openTagEnd = openTagStart + tagMatch[0].length;

    // 寻找匹配的闭标签 </tagName>，精准支持同名标签嵌套
    let depth = 1;
    let searchPos = openTagEnd;
    let closeTagStart = -1;
    let closeTagEnd = -1;

    const openTagStr = `<${tagName}>`;
    const closeTagStr = `</${tagName}>`;

    while (depth > 0 && searchPos < text.length) {
      const nextOpen = text.indexOf(openTagStr, searchPos);
      const nextClose = text.indexOf(closeTagStr, searchPos);

      if (nextClose === -1) {
        // 未闭合，无法找到匹配闭标签
        break;
      }

      if (nextOpen !== -1 && nextOpen < nextClose) {
        // 发现同名内层开标签
        depth++;
        searchPos = nextOpen + openTagStr.length;
      } else {
        // 发现闭标签
        depth--;
        if (depth === 0) {
          closeTagStart = nextClose;
          closeTagEnd = nextClose + closeTagStr.length;
          break;
        }
        searchPos = nextClose + closeTagStr.length;
      }
    }

    if (closeTagStart === -1 || depth > 0) {
      // 容错：未闭合的开标签，平滑退化为普通文本
      nodes.push(text.slice(openTagStart, openTagEnd));
      index = openTagEnd;
      continue;
    }

    // 提取内层内容并递归解析
    const innerContent = text.slice(openTagEnd, closeTagStart);
    const childrenNodes = parseTemplate(
      innerContent,
      components,
      values,
      `${keyPrefix}-${tagName}-${nodes.length}`
    );

    const slot = components[tagName];
    const nodeKey = `${keyPrefix}-${tagName}-${nodes.length}`;
    const resolvedChildren =
      childrenNodes.length === 1
        ? childrenNodes[0]
        : childrenNodes.length > 0
          ? childrenNodes
          : undefined;

    if (React.isValidElement(slot)) {
      nodes.push(React.cloneElement(slot, { key: nodeKey }, resolvedChildren));
    } else if (typeof slot === 'function') {
      nodes.push(
        <React.Fragment key={nodeKey}>{slot(resolvedChildren)}</React.Fragment>
      );
    } else {
      // 未在 components 注册对应插槽，平滑输出内层 children 节点，绝不抛错
      nodes.push(
        <React.Fragment key={nodeKey}>{childrenNodes}</React.Fragment>
      );
    }

    index = closeTagEnd;
  }

  return nodes;
}

/**
 * Trans 富文本插槽组件
 */
export const Trans: React.FC<TransProps> = ({
  i18nKey,
  components = {},
  values,
  fallback,
  children,
}) => {
  const context = useContext(I18nContext);
  const t = context?.t ?? getGlobalActiveTranslator();

  try {
    let templateText: string | undefined;

    if (i18nKey) {
      const translated = t(i18nKey, fallback);
      // 若翻译结果有效命中且未原样返回 key
      if (translated && translated !== i18nKey) {
        templateText = translated;
      }
    }

    // 降级优先级：翻译文案 -> 显式 fallback -> string 类型的 children -> i18nKey 自身
    if (!templateText) {
      if (fallback !== undefined) {
        templateText = fallback;
      } else if (typeof children === 'string') {
        templateText = children;
      } else if (i18nKey) {
        templateText = i18nKey;
      }
    }

    // 若依然没有文本模板但传入了 ReactNode 类型的 children，直接保全渲染 children
    if (!templateText) {
      if (children !== undefined && children !== null) {
        return <>{children}</>;
      }
      return null;
    }

    const parsedNodes = parseTemplate(templateText, components, values);
    return <>{parsedNodes}</>;
  } catch (error) {
    // 极端容灾：发生任何不可预料的解析异常时，绝不抛出，平滑降级为兜底纯文本
    console.error(`[Trans] Failed to render i18nKey "${i18nKey}":`, error);
    const safeFallback =
      fallback ??
      (typeof children === 'string' ? children : '') ??
      i18nKey ??
      '';
    return <>{safeFallback}</>;
  }
};

export default Trans;
