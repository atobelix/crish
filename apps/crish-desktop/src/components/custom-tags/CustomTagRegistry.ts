/**
 * CustomTagRegistry.ts
 *
 * 自定义 HTML 交互组件单例注册中心、属性反序列化与 4 层 XSS 纵深防御套件
 *
 * 核心设计：
 * 1. CustomTagRegistry: 集中式单例注册表，管理 <widget-diff>, <file-tree>, <ai-card> 等组件定义；
 * 2. parseComponentAttributes: 属性强类型管道（kebab-case -> camelCase, boolean, number, JSON）；
 * 3. 4 层 XSS 纵深防御：
 *    - Tier 1: 标签白名单校验（未知自定义标签安全剥离外壳展开子节点，拦截危险原生标签）；
 *    - Tier 2: 属性与 on* / formaction 事件彻底剥离，单属性长度 10,000 字符熔断；
 *    - Tier 3: 协议白名单（http, https, mailto, conex, crish-local，相对路径）；
 *    - Tier 4: CustomTagErrorBoundary 局部故障隔离。
 */

import type { ComponentType, ReactNode } from 'react';

export interface ExtraComponentProps {
  node?: unknown;
  isStreaming?: boolean;
  onAgentAction?: (action: string, payload?: unknown) => void;
  messageId?: string;
  className?: string;
}

export interface ContainerTagProps extends ExtraComponentProps {
  children?: ReactNode;
}

export interface CustomTagDefinition<TProps = any> {
  name: string;
  type: 'container' | 'leaf';
  component: ComponentType<TProps>;
  fallback?: ComponentType<TProps>;
  description?: string;
}

export class CustomTagRegistry {
  private static instance: CustomTagRegistry | null = null;
  private readonly registry = new Map<string, CustomTagDefinition>();

  public static getInstance(): CustomTagRegistry {
    if (!this.instance) {
      this.instance = new CustomTagRegistry();
    }
    return this.instance;
  }

  public register<T = any>(definition: CustomTagDefinition<T>): void {
    this.registry.set(definition.name.toLowerCase(), definition as CustomTagDefinition);
  }

  public unregister(tagName: string): boolean {
    return this.registry.delete(tagName.toLowerCase());
  }

  public get(tagName: string): CustomTagDefinition | undefined {
    return this.registry.get(tagName.toLowerCase());
  }

  public getAllTagNames(): string[] {
    return Array.from(this.registry.keys());
  }

  public isRegistered(tagName: string): boolean {
    return this.registry.has(tagName.toLowerCase());
  }

  public clear(): void {
    this.registry.clear();
  }
}

/**
 * 将大模型输出的原始字符串属性转换为标准强类型 Props (kebab-case -> camelCase, boolean, number, JSON)
 */
export function parseComponentAttributes<T extends Record<string, any> = Record<string, any>>(
  rawProperties?: Record<string, any> | null
): T {
  if (!rawProperties || typeof rawProperties !== 'object') {
    return {} as T;
  }

  const result: Record<string, any> = {};

  for (const [key, rawValue] of Object.entries(rawProperties)) {
    // 1. kebab-case 转 camelCase
    const camelKey = key.replace(/-([a-z0-9])/gi, (_, letter) => letter.toUpperCase());

    // 2. 布尔属性标准化
    if (rawValue === '' || rawValue === true || rawValue === 'true') {
      result[camelKey] = true;
      continue;
    }
    if (rawValue === false || rawValue === 'false') {
      result[camelKey] = false;
      continue;
    }

    // 3. 数字转换
    if (typeof rawValue === 'number') {
      result[camelKey] = rawValue;
      continue;
    }
    if (typeof rawValue === 'string' && /^-?\d+(\.\d+)?$/.test(rawValue.trim())) {
      result[camelKey] = Number(rawValue.trim());
      continue;
    }

    // 4. JSON 字符串反序列化
    if (
      typeof rawValue === 'string' &&
      ((rawValue.startsWith('{') && rawValue.endsWith('}')) ||
        (rawValue.startsWith('[') && rawValue.endsWith(']')))
    ) {
      try {
        result[camelKey] = JSON.parse(rawValue);
        continue;
      } catch {
        result[camelKey] = rawValue;
        continue;
      }
    }

    result[camelKey] = rawValue;
  }

  return result as T;
}

// 4 层 XSS 纵深防御常量与策略

export const DISALLOWED_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'base',
  'form',
  'template',
  'link',
  'style',
  'meta',
  'applet',
]);

export const SAFE_PROTOCOLS = /^(https?|mailto|conex|crish-local):/i;
export const MAX_ATTR_LENGTH = 10000;
const DANGEROUS_ATTR_PREFIXES = [/^on/i, /^formaction/i];

export function isSafeProtocol(url: string): boolean {
  const trimmed = String(url ?? '').trim();
  if (!trimmed) return true;
  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return true;
  }
  return SAFE_PROTOCOLS.test(trimmed);
}

/**
 * 针对自定义组件属性的清洗处理器（Tier 2 & Tier 3 防护）
 */
export function sanitizeCustomTagAttributes(
  rawAttrs: Record<string, any>
): Record<string, any> {
  const cleanAttrs: Record<string, any> = {};
  for (const [key, val] of Object.entries(rawAttrs)) {
    // Tier 2: 剔除 on* / formaction 危险事件
    if (DANGEROUS_ATTR_PREFIXES.some((re) => re.test(key))) {
      continue;
    }

    const strVal = typeof val === 'string' ? val : String(val ?? '');

    // Tier 2: 长度熔断 (防 ReDoS 与超长缓冲区溢出)
    if (strVal.length > MAX_ATTR_LENGTH) {
      continue;
    }

    // Tier 3: 协议白名单校验
    if (key === 'href' || key === 'src' || key === 'url') {
      if (!isSafeProtocol(strVal)) {
        continue;
      }
    }

    // Tier 2: 危险内联遮罩与样式校验
    if (key === 'style' && typeof val === 'string') {
      if (
        /position\s*:\s*(fixed|absolute)/i.test(val) &&
        /z-index\s*:\s*99/i.test(val)
      ) {
        continue;
      }
      if (/opacity\s*:\s*0(\.0*)?;/i.test(val)) {
        continue;
      }
    }

    cleanAttrs[key] = val;
  }
  return cleanAttrs;
}

/**
 * HAST AST 树清洗插件（用于 markdown pipeline AST 阶段）
 */
export interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, any>;
  children?: HastNode[];
  value?: string;
}

export function sanitizeHastTree(
  node: HastNode,
  allowedCustomTags: Set<string>
): HastNode | null {
  if (node.type !== 'element') {
    return node;
  }

  const tagName = (node.tagName || '').toLowerCase();

  // Tier 1: 拦截危险原生标签
  if (DISALLOWED_TAGS.has(tagName)) {
    return null;
  }

  // Tier 1: 自定义标签白名单校验
  const isCustomTag = tagName.includes('-') || tagName.startsWith('ai-');
  if (isCustomTag && !allowedCustomTags.has(tagName)) {
    // 未知自定义标签：安全剥离未知外壳，将其内部子节点平铺展开
    const safeChildren: HastNode[] = [];
    if (node.children) {
      for (const child of node.children) {
        const sanitized = sanitizeHastTree(child, allowedCustomTags);
        if (sanitized) safeChildren.push(sanitized);
      }
    }
    // 返回虚拟容器或首个子节点
    return {
      type: 'element',
      tagName: 'div',
      properties: { className: 'unknown-tag-fallback' },
      children: safeChildren,
    };
  }

  // Tier 2 & Tier 3: 属性清洗
  if (node.properties) {
    node.properties = sanitizeCustomTagAttributes(node.properties);
  }

  // 递归处理子节点
  if (node.children) {
    const nextChildren: HastNode[] = [];
    for (const child of node.children) {
      const sanitized = sanitizeHastTree(child, allowedCustomTags);
      if (sanitized) {
        nextChildren.push(sanitized);
      }
    }
    node.children = nextChildren;
  }

  return node;
}
