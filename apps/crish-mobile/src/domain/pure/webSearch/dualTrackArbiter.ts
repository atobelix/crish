/**
 * 移动端双轨路由仲裁器（Dual-Track Arbiter）
 *
 * 依据文档：
 * - docs/mobile-web-search-and-sandbox/01-分维-双轨仲裁与模型原生搜索方言对接方案.md §3, §4
 * - docs/mobile-web-search-and-sandbox/06-分维-状态机演进与SQLite持久化及设置方案.md §1
 *
 * 核心目标：
 * 在每次对话请求前，根据模型原生能力声明、用户偏好、会话开关与外部工具健康度，
 * 纯函数严谨推导出最终的路由策略（server | client | none），并严格实施客户端工具的
 * 物理屏蔽（Withholding）与防提示词冲突机制。
 */

import type {
  ClientWebToolAvailability,
  NativeWebCapability,
  PiWebDialect,
  WebSearchRoute,
} from '../../types/webSearch';

/**
 * 默认端侧客户端搜索工具定义（OpenAI Function Calling 规范）
 */
export const DEFAULT_CLIENT_WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      '通过网页搜索引擎实时检索互联网最新信息、新闻、技术文档与事实。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '自包含的搜索关键词，请勿使用代词。如 "React Native 0.86 新特性"。',
        },
      },
      required: ['query'],
    },
  },
};

/**
 * 默认端侧客户端网页抓取工具定义
 */
export const DEFAULT_CLIENT_WEB_FETCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_fetch',
    description: '深入提取指定 HTTP(S) URL 的网页正文内容与结构化 Markdown。',
    parameters: {
      type: 'object',
      properties: {
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: '需要抓取正文的网页绝对 URL 列表，一次最多 5 个。',
        },
      },
      required: ['urls'],
    },
  },
};

/**
 * 提取工具名称（兼容 OpenAI function 包装形态与扁平对象形态）
 */
export function getToolName(tool: any): string {
  if (!tool) return '';
  if (typeof tool === 'string') return tool;
  if (typeof tool.name === 'string') return tool.name;
  if (tool.function && typeof tool.function.name === 'string')
    return tool.function.name;
  if (typeof tool.type === 'string' && tool.type !== 'function')
    return tool.type;
  return '';
}

/**
 * 判定指定工具是否为客户端网页搜索工具（web_search）
 */
export function isWebSearchTool(tool: any): boolean {
  const name = getToolName(tool);
  return name === 'web_search' || name === 'client_web_search';
}

/**
 * 判定指定工具是否为客户端网页正文抓取工具（web_fetch）
 */
export function isWebFetchTool(tool: any): boolean {
  const name = getToolName(tool);
  return (
    name === 'web_fetch' || name === 'client_web_fetch' || name === 'fetch_url'
  );
}

/**
 * 从多形态的 modelSpec 输入中无损提取原生搜索能力声明
 */
export function extractNativeCapability(
  modelSpec: any
): NativeWebCapability | undefined {
  if (!modelSpec || typeof modelSpec !== 'object') {
    return undefined;
  }
  if (modelSpec.nativeWeb && typeof modelSpec.nativeWeb === 'object') {
    return modelSpec.nativeWeb as NativeWebCapability;
  }
  if (
    modelSpec.nativeCapabilities &&
    typeof modelSpec.nativeCapabilities === 'object'
  ) {
    return modelSpec.nativeCapabilities as NativeWebCapability;
  }
  if (
    modelSpec.compat?.nativeWeb &&
    typeof modelSpec.compat?.nativeWeb === 'object'
  ) {
    return modelSpec.compat.nativeWeb as NativeWebCapability;
  }
  if ('supportsSearch' in modelSpec || 'supportsNativeWebSearch' in modelSpec) {
    return {
      supportsSearch: Boolean(
        modelSpec.supportsSearch ?? modelSpec.supportsNativeWebSearch
      ),
      supportsFetch: Boolean(modelSpec.supportsFetch),
      functionToolMixing: modelSpec.functionToolMixing ?? true,
      dialect: modelSpec.dialect,
      customOptions: modelSpec.customOptions,
    };
  }
  return undefined;
}

/**
 * 根据方言标识构造原生请求注入载荷（对齐文档 01 §4）
 */
export function buildNativeDialectPayload(
  dialect?: PiWebDialect | string,
  customOptions?: Record<string, unknown>
): any {
  if (!dialect && !customOptions) {
    return undefined;
  }

  const baseDialect = dialect as PiWebDialect | string | undefined;

  switch (baseDialect) {
    case 'google':
      return {
        tools: [{ googleSearch: {} }],
        ...customOptions,
      };
    case 'openai-responses':
      return {
        tools: [{ type: 'web_search' }],
        ...customOptions,
      };
    case 'openai-preview':
      return {
        tools: [{ type: 'web_search_preview' }],
        ...customOptions,
      };
    case 'openai-chat-search':
      return {
        web_search_options: { search_context_size: 'medium' },
        ...customOptions,
      };
    case 'xai':
      return {
        tools: [
          { type: 'web_search', enable_image_understanding: true },
          { type: 'x_search', enable_image_understanding: true },
        ],
        ...customOptions,
      };
    case 'anthropic':
      return {
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ],
        ...customOptions,
      };
    case 'qwen-anthropic':
      return {
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: 5,
          },
        ],
        systemPrefix: 'x-anthropic-billing-header: cc_entrypoint=cli;',
        ...customOptions,
      };
    case 'zhipu':
      return {
        tools: [
          {
            type: 'web_search',
            web_search: {
              enable: true,
              search_engine: 'search_pro',
              search_result: true,
            },
          },
        ],
        ...customOptions,
      };
    case 'dashscope':
      return {
        enable_search: true,
        search_options: {
          enable_source: true,
          search_strategy: 'agent',
        },
        ...customOptions,
      };
    case 'qwencloud':
      return {
        enable_search: true,
        search_options: {
          search_strategy: 'agent',
        },
        ...customOptions,
      };
    case 'openrouter':
      return {
        tools: [{ type: 'openrouter:web_search' }],
        ...customOptions,
      };
    case 'perplexity':
      return {
        ...customOptions,
      };
    default:
      if (customOptions) {
        return { ...customOptions };
      }
      return dialect ? { type: dialect } : { type: 'web_search' };
  }
}

/**
 * resolveWebToolRoutes 入参契约
 */
export interface ResolveWebToolRoutesParams {
  /** 会话级联网开关（Composer 状态，为 false 时直接阻断所有联网） */
  sessionWebEnabled: boolean;
  /** 是否偏好模型原生搜索（默认 true；为 false 时强制客户端端侧优先） */
  modelToolsPreferred?: boolean;
  /** 模型规格信息（包含 nativeWeb 或直接声明能力） */
  modelSpec?: any;
  /** 客户端搜索能力是否可用（布尔值或可用性结构体） */
  clientWebToolsAvailable: boolean | ClientWebToolAvailability;
  /** 客户端传入的其他工具集（业务工具、已有工具等） */
  otherClientTools?: any[];
}

/**
 * resolveWebToolRoutes 返回结果契约
 */
export interface ResolveWebToolRoutesResult {
  /** 最终裁决的搜索路由 */
  route: WebSearchRoute;
  /** 经过过滤与挂载后的最终有效客户端工具清单 */
  effectiveClientTools: any[];
  /** 当 route === 'server' 时生成的原生方言请求载荷（可选） */
  nativeDialectPayload?: any;
  /** 是否物理屏蔽了客户端 web_search */
  withholdClientSearch?: boolean;
  /** 是否物理屏蔽了客户端 web_fetch */
  withholdClientFetch?: boolean;
}

/**
 * 纯函数：双轨路由仲裁器（Dual-Track Arbiter）
 *
 * 核心仲裁流程：
 * 1. 【前置门禁】：若 `!sessionWebEnabled` -> 阻断所有联网，route = 'none'，保持非搜索工具。
 * 2. 【原生通道判定】：
 *    - 检查模型规格是否声明原生搜索支持（supportsSearch）。
 *    - 检查用户是否偏好原生搜索（modelToolsPreferred 缺省为 true）。
 *    - 【混用冲突门禁（Mixing Conflict Gate）】：若模型声明不允许与客户端函数混用（functionToolMixing === false）
 *      且存在非 Web 客户端业务工具（如计算器、代码沙箱），硬性安全阻断原生通道，主动降级为端侧 client。
 *    - 若通过判定 -> route = 'server'。
 *      【关键红线（Withholding）】：从客户端工具集中物理过滤掉 `web_search`（防止提示词与模型内置冲突）；
 *      若模型允许混用且客户端注册了 `web_fetch`，则保留 `web_fetch`；若不支持混用，则一并过滤 `web_fetch`。
 * 3. 【端侧通道判定】：
 *    - 若模型不支持原生或用户强制端侧优先（modelToolsPreferred === false）：
 *    - 若客户端搜索可用（clientWebToolsAvailable 为 true）-> route = 'client'，挂载客户端工具集（确保 web_search 挂载）。
 *    - 若客户端搜索不可用且模型支持原生 -> 降级走原生 route = 'server'。
 *    - 若两轨皆不可用 -> route = 'none'。
 */
export function resolveWebToolRoutes(
  params: ResolveWebToolRoutesParams
): ResolveWebToolRoutesResult {
  const { sessionWebEnabled } = params;
  const rawOtherTools =
    params.otherClientTools ?? (params as any).clientTools ?? [];

  // 1. 前置门禁：若会话联网未开启，阻断所有联网能力
  if (!sessionWebEnabled) {
    const hasWebSearch = rawOtherTools.some(isWebSearchTool);
    const safeTools = hasWebSearch
      ? rawOtherTools.filter((t: any) => !isWebSearchTool(t))
      : rawOtherTools;

    return {
      route: 'none',
      effectiveClientTools: safeTools,
      withholdClientSearch: true,
      withholdClientFetch: true,
    };
  }

  // 提取配置与能力
  const modelToolsPreferred =
    params.modelToolsPreferred ?? (params as any).preferNativeSearch ?? true;
  const nativeCap = extractNativeCapability(params.modelSpec);
  const nativeSupportsSearch = Boolean(
    nativeCap?.supportsSearch ??
    params.modelSpec?.supportsSearch ??
    params.modelSpec?.supportsNativeWebSearch ??
    false
  );
  const functionToolMixing =
    nativeCap?.functionToolMixing ??
    params.modelSpec?.functionToolMixing ??
    true;

  const clientAvailable =
    typeof params.clientWebToolsAvailable === 'boolean'
      ? params.clientWebToolsAvailable
      : Boolean(params.clientWebToolsAvailable?.searchAvailable);

  // 检查是否存在非 Web 客户端函数工具
  const hasNonWebClientTools = rawOtherTools.some(
    (t: any) => !isWebSearchTool(t) && !isWebFetchTool(t)
  );

  // 2. 原生通道与混用冲突判定
  let serverEligible = nativeSupportsSearch;
  if (serverEligible && !functionToolMixing && hasNonWebClientTools) {
    // 存在客户端业务工具但模型不支持混用（如 Gemini 1.5 传入 googleSearch + functionDeclarations 报 HTTP 400）
    // 此时原生搜索不可用，必须降级
    serverEligible = false;
  }

  // 3. 路由选择（依优先偏好裁决）
  let finalRoute: WebSearchRoute;
  if (modelToolsPreferred) {
    if (serverEligible) {
      finalRoute = 'server';
    } else if (clientAvailable) {
      finalRoute = 'client';
    } else {
      finalRoute = 'none';
    }
  } else {
    // 用户显式配置端侧优先
    if (clientAvailable) {
      finalRoute = 'client';
    } else if (serverEligible) {
      finalRoute = 'server';
    } else {
      finalRoute = 'none';
    }
  }

  // 4. 根据最终路由构建有效工具集与 Dialect 载荷
  if (finalRoute === 'server') {
    // 关键红线：物理过滤掉 client web_search
    // 若模型允许混用且客户端注册了 web_fetch，则保留 web_fetch；若不支持混用，则同样过滤 web_fetch
    const effectiveClientTools = rawOtherTools.filter((t: any) => {
      if (isWebSearchTool(t)) {
        return false;
      }
      if (isWebFetchTool(t)) {
        return functionToolMixing;
      }
      return true;
    });

    const nativeDialectPayload = buildNativeDialectPayload(
      nativeCap?.dialect ?? params.modelSpec?.dialect,
      nativeCap?.customOptions ?? params.modelSpec?.customOptions
    );

    return {
      route: 'server',
      effectiveClientTools,
      nativeDialectPayload,
      withholdClientSearch: true,
      withholdClientFetch: !functionToolMixing,
    };
  }

  if (finalRoute === 'client') {
    // 挂载客户端工具集：确保包含 web_search 工具
    const alreadyHasWebSearch = rawOtherTools.some(isWebSearchTool);
    const effectiveClientTools = alreadyHasWebSearch
      ? [...rawOtherTools]
      : [...rawOtherTools, DEFAULT_CLIENT_WEB_SEARCH_TOOL];

    return {
      route: 'client',
      effectiveClientTools,
      nativeDialectPayload: undefined,
      withholdClientSearch: false,
      withholdClientFetch: false,
    };
  }

  // finalRoute === 'none'
  const effectiveClientTools = rawOtherTools.filter(
    (t: any) => !isWebSearchTool(t)
  );
  return {
    route: 'none',
    effectiveClientTools,
    nativeDialectPayload: undefined,
    withholdClientSearch: true,
    withholdClientFetch: true,
  };
}
