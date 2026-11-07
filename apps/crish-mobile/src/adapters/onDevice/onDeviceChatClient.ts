// 端侧（本机）对话客户端（O3）：LocalChatClient 的第二个实现——
// llama.rn + GGUF 本机推理，与 HTTP 客户端同接口同错误分类，由接线层
// （localChatWiring）按供应商 protocol = 'ondevice/gguf' 分发到此。
//
// 口径（用户裁决 2026-11-06，v1 不可动摇）：
// - **纯对话**：tools 一律不下发（本文件是第二道闸；第一道在引擎——
//   协议为 ondevice/gguf 时不取工具声明、系统提示词走无工具版）。
//   无论 input 带什么工具声明都不传给 llama.rn，onComplete 永不带
//   toolCalls，引擎的收敛路径（无 toolCalls 即收尾）天然接住。
// - **零网络**：模型列表/连通性/ping 全部以本机文件真值为据（O2 管理器
//   的 check 口径：文件在位 + 尺寸精确 + verified.json 校验标记在案），
//   延迟字段填本地核对的真实耗时，不伪造网络往返数字。
// - **错误不新造体系**：未下载 → notConfigured；文件在盘但未过就绪校验
//   （未下完/损坏/标记失效）→ unknown + detail 引导删除重下；原生
//   init/生成失败 → unknown + detail 带原始信息。
//
// 原生上下文是单例（§5.3）：1–2 GiB 权重无法按线程多开；惰性 init，
// 切换模型时 release 旧 context。token 回调经 llama.rn 的解析面：
// content 为正文增量、reasoning_content 为独立思考增量（仅在原生真
// 分离时才接 onReasoningDelta）。
import {
  notConfiguredError,
  withErrorMessage,
  type LocalWireMessage,
} from '@/domain/pure/localChatProtocol';
import type { LocalChatError } from '@/domain/types/localChat';
import type {
  CompleteChatInput,
  LocalChatClient,
  StreamChatInput,
} from '../localChat/localChatClient';
import type { LocalModelSpec } from '../localChat/providerPresets';
import type { OnDeviceModelSpec } from './onDeviceModelCatalog';
import type {
  OnDeviceModelManager,
  OnDeviceModelState,
} from './onDeviceModelManager';

/** llama.cpp 上下文大小缺省值（目录 spec.inference.contextSize 覆盖） */
export const DEFAULT_ON_DEVICE_CONTEXT_SIZE = 4096;

// ── llama.rn 窄桥（结构子集；生产实现包真模块，测试注入假实现） ──

/** llama.rn 流式 token 回调数据（TokenData 的本客户端消费子集） */
export interface OnDeviceTokenData {
  token: string;
  /** 解析后的正文增量（与 reasoning/tool_calls 分离后） */
  content?: string;
  /** 解析后的思考增量（推理模型才有） */
  reasoning_content?: string;
}

/** llama.rn completion 结果（NativeCompletionResult 的消费子集） */
export interface OnDeviceCompletionResult {
  /** 全文（未过滤，含思考/工具段原文） */
  text: string;
  /** 正文全文（已滤除 reasoning_content / tool_calls） */
  content: string;
  reasoning_content: string;
  truncated: boolean;
  stopped_eos: boolean;
  stopped_word: string;
  stopped_limit: number;
  interrupted: boolean;
}

/** 一次 completion 的参数（CompletionParams 的消费子集） */
export interface OnDeviceCompletionParams {
  messages: Array<{ role: string; content: string }>;
  n_predict?: number;
  temperature?: number;
  stop?: string[];
  enable_thinking?: boolean;
  chat_template_kwargs?: Record<string, string | number | boolean>;
}

/** llama.rn 上下文句柄（LlamaContext 的消费子集） */
export interface OnDeviceLlamaContext {
  completion(
    params: OnDeviceCompletionParams,
    onToken?: (data: OnDeviceTokenData) => void
  ): Promise<OnDeviceCompletionResult>;
  stopCompletion(): Promise<void>;
  release(): Promise<void>;
}

/** llama.rn 桥：只暴露 initLlama 一个入口 */
export interface OnDeviceLlamaBridge {
  initLlama(params: {
    model: string;
    n_ctx: number;
    n_gpu_layers: number;
    use_mlock: boolean;
  }): Promise<OnDeviceLlamaContext>;
}

/**
 * 生产桥：惰性 require llama.rn——本模块被接线层静态引用，导入期
 * 绝不触碰原生模块（jest / 无原生环境安全），与仓内 expo-notifications
 * 等门面的惰性原生访问同纪律；只在真正发起端侧推理时才加载。
 */
export function createLlamaRnBridge(): OnDeviceLlamaBridge {
  return {
    async initLlama(params) {
      const mod = require('llama.rn') as typeof import('llama.rn');
      const context = await mod.initLlama({
        model: params.model,
        n_ctx: params.n_ctx,
        n_gpu_layers: params.n_gpu_layers,
        use_mlock: params.use_mlock,
      });
      return context as unknown as OnDeviceLlamaContext;
    },
  };
}

// ── 客户端 ──

export interface OnDeviceChatClientDeps {
  /** 模型管理器面（生产 = O2 单例；只消费就绪检查/占用/目录查询） */
  manager: Pick<
    OnDeviceModelManager,
    'check' | 'checkAll' | 'usageBytes' | 'spec'
  >;
  /** llama.rn 桥（生产 = createLlamaRnBridge()） */
  llama: OnDeviceLlamaBridge;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 原生侧失败 → unknown + 原始信息（不吞、不编） */
function nativeError(action: string, err: unknown): LocalChatError {
  return {
    kind: 'unknown',
    status: null,
    message: '',
    detail: `${action}失败：${errorText(err)}`,
    retryable: false,
  };
}

/**
 * wire 消息 → llama.rn messages（role/content 同构直映射）：
 * - user 的多模态 parts 只取 text 段（端侧模型为纯文本；图片在引擎组
 *   wire 时已按 visionSupported=false 降级为文本注记，不会以 part 形态
 *   到达——此处是防御性兜底，绝不把 image_url 喂给文本模型）；
 * - assistant 只取正文（tool_calls 不进纯对话模板）；
 * - tool 角色消息在纯对话口径下不会出现，出现时跳过（无 tool_calls
 *   上下文的孤立 tool 结果喂模板只会污染语义）。
 */
export function toOnDeviceMessages(
  messages: readonly LocalWireMessage[]
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else if (m.role === 'user') {
      const content =
        typeof m.content === 'string'
          ? m.content
          : m.content
              .filter(
                (p): p is { type: 'text'; text: string } => p.type === 'text'
              )
              .map((p) => p.text)
              .join('');
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: m.content ?? '' });
    }
    // role === 'tool'：跳过（见函数头注）
  }
  return out;
}

/** llama.rn 结束形态 → OpenAI finish_reason 口径（与 HTTP 路径一致） */
function mapFinishReason(result: OnDeviceCompletionResult): string {
  if (result.truncated || result.stopped_limit > 0) return 'length';
  return 'stop';
}

/**
 * 本机模型运行时面（IA §3.8）：已加载状态只存在于客户端内存，
 * 这里只提供只读查询与显式加载/释放——绝不把结果写进 store
 * 当第二真源。详情页与本机首页消费，离开页面不轮询。
 */
export interface OnDeviceRuntime {
  /** 当前已加载的模型 id；未加载为 null（加载进行中以已定格的 active 为准） */
  loadedModelId(): string | null;
  /** 是否有一次加载（initLlama）正在进行 */
  isLoading(): boolean;
  /**
   * 显式加载就绪模型（详情页主动作）：未就绪抛既有诚实错误
   * （LocalChatError 形态，与对话路径同源）；初始化失败抛 unknown。
   */
  loadModel(modelId: string): Promise<void>;
  /**
   * 释放当前上下文；未加载时无操作。释放失败会抛出——删除已加载
   * 模型的流程据此中止删文件（IA §3.4），不吞。
   */
  releaseLoaded(): Promise<void>;
}

/** 端侧对话客户端 = 通用 LocalChatClient + 本机运行时面 */
export type OnDeviceChatClient = LocalChatClient & OnDeviceRuntime;

export function createOnDeviceChatClient(
  deps: OnDeviceChatClientDeps
): OnDeviceChatClient {
  // 单例原生上下文（按 modelId 复用；切换模型 release 旧的）
  let active: { modelId: string; context: OnDeviceLlamaContext } | null =
    null;
  let pendingInit: Promise<OnDeviceLlamaContext> | null = null;

  /**
   * 模型未就绪时的诚实错误（异步：需查磁盘占用以区分未下载/损坏）：
   * - 目录里没有这个 id → notConfigured（未知模型）；
   * - 磁盘上零占用 → notConfigured（尚未下载）；
   * - 磁盘上有文件但未过就绪校验 → unknown + 引导删除重下。
   */
  async function notReadyError(modelId: string): Promise<LocalChatError> {
    const spec = deps.manager.spec(modelId);
    if (!spec) {
      return withErrorMessage({
        ...notConfiguredError(),
        detail: `未知的端侧模型 id「${modelId}」，不在本机模型目录中。`,
      });
    }
    let usage = 0;
    try {
      usage = await deps.manager.usageBytes(modelId);
    } catch {
      usage = 0;
    }
    if (usage > 0) {
      return withErrorMessage({
        kind: 'unknown',
        status: null,
        message: '',
        detail: `本机模型「${spec.displayName}」的文件未通过就绪校验（下载未完成或文件已损坏），请在模型管理中删除后重新下载。`,
        retryable: false,
      });
    }
    return withErrorMessage({
      ...notConfiguredError(),
      detail: `本机模型「${spec.displayName}」尚未下载，请先在模型管理中下载。`,
    });
  }

  /** 就绪模型解析：check 为 ready 才返回目录条目 + 原生路径 */
  async function resolveReadyModel(modelId: string): Promise<{
    spec: OnDeviceModelSpec;
    nativePath: string;
  }> {
    const state: OnDeviceModelState = await deps.manager.check(modelId);
    if (state.kind === 'ready') {
      const spec = deps.manager.spec(modelId);
      if (spec) return { spec, nativePath: state.path };
    }
    throw await notReadyError(modelId);
  }

  /** 惰性 init / 复用单例上下文（切换模型时先 release 旧的） */
  async function ensureContext(
    modelId: string,
    nativePath: string,
    spec: OnDeviceModelSpec
  ): Promise<OnDeviceLlamaContext> {
    if (active?.modelId === modelId) return active.context;
    if (pendingInit) {
      const ctx = await pendingInit;
      if (active?.modelId === modelId) return ctx;
    }
    const init = (async () => {
      const old = active;
      active = null;
      if (old) {
        try {
          await old.context.release();
        } catch {
          // 旧上下文释放失败静默（不阻断新模型加载）
        }
      }
      const context = await deps.llama.initLlama({
        model: nativePath,
        n_ctx: spec.inference?.contextSize ?? DEFAULT_ON_DEVICE_CONTEXT_SIZE,
        // Kirin 990 无可用 GPU 路径（llama.rn 的 Android GPU 仅
        // OpenCL-Adreno / Hexagon），恒 0 是设计基线而非降级。
        n_gpu_layers: 0,
        use_mlock: true,
      });
      active = { modelId, context };
      return context;
    })();
    pendingInit = init;
    try {
      return await init;
    } finally {
      if (pendingInit === init) pendingInit = null;
    }
  }

  /** completion 参数组装：tools 永不出现（纯对话口径的落点） */
  function buildParams(
    input: {
      messages: readonly LocalWireMessage[];
      maxTokens?: number;
      temperature?: number;
    },
    spec: OnDeviceModelSpec
  ): OnDeviceCompletionParams {
    const params: OnDeviceCompletionParams = {
      messages: toOnDeviceMessages(input.messages),
    };
    if (input.maxTokens !== undefined) params.n_predict = input.maxTokens;
    if (input.temperature !== undefined) {
      params.temperature = input.temperature;
    }
    const stop = spec.inference?.stop;
    if (stop && stop.length > 0) params.stop = [...stop];
    if (spec.inference?.enableThinking === false) {
      // Qwen3 关思考：原生开关 + 模板 kwargs 双路下发（模板变体兼容）
      params.enable_thinking = false;
      params.chat_template_kwargs = { enable_thinking: false };
    }
    return params;
  }

  /** 就绪模型对应的 LocalModelSpec（模型面呈现用，最小诚实字段） */
  function readyModelSpecs(
    states: readonly OnDeviceModelState[]
  ): LocalModelSpec[] {
    const out: LocalModelSpec[] = [];
    for (const s of states) {
      if (s.kind !== 'ready') continue;
      const spec = deps.manager.spec(s.modelId);
      if (!spec) continue;
      out.push({ id: spec.id, displayName: spec.displayName, enabled: true });
    }
    return out;
  }

  return {
    streamChatCompletion(input: StreamChatInput, callbacks) {
      let finished = false;
      let context: OnDeviceLlamaContext | null = null;

      const fail = (error: LocalChatError) => {
        if (finished) return;
        finished = true;
        callbacks.onError(withErrorMessage(error));
      };

      void (async () => {
        let ready: { spec: OnDeviceModelSpec; nativePath: string };
        try {
          ready = await resolveReadyModel(input.model);
        } catch (e) {
          fail(e as LocalChatError);
          return;
        }
        if (finished) return;

        let ctx: OnDeviceLlamaContext;
        try {
          ctx = await ensureContext(input.model, ready.nativePath, ready.spec);
        } catch (e) {
          fail(nativeError('加载本机模型', e));
          return;
        }
        context = ctx;
        if (finished) return;

        let content = '';
        let reasoning = '';
        try {
          const result = await ctx.completion(
            buildParams(input, ready.spec),
            (data) => {
              if (finished) return;
              callbacks.onActivity?.();
              if (
                typeof data.reasoning_content === 'string' &&
                data.reasoning_content !== ''
              ) {
                reasoning += data.reasoning_content;
                callbacks.onReasoningDelta?.(data.reasoning_content);
              }
              // content 为解析后的正文增量（权威）；缺失时回退原始 token
              const delta =
                typeof data.content === 'string' ? data.content : data.token;
              if (delta) {
                content += delta;
                callbacks.onTextDelta(delta);
              }
            }
          );
          if (finished) return;
          finished = true;
          if (content === '' && result.content !== '') {
            // token 回调未送达正文时以结果全文兜底（不丢内容）
            content = result.content;
            callbacks.onTextDelta(result.content);
          }
          if (reasoning === '' && result.reasoning_content) {
            reasoning = result.reasoning_content;
          }
          callbacks.onComplete({
            content,
            finishReason: mapFinishReason(result),
            // 纯对话口径：永不带 toolCalls，计数恒 0
            toolCallCount: 0,
            ...(reasoning !== '' ? { reasoning } : {}),
          });
        } catch (e) {
          fail(nativeError('本机模型生成', e));
        }
      })();

      return {
        abort: () => {
          // 与 HTTP 客户端同纪律：先标记完成再停原生，迟到回调一律
          // 忽略；已生成内容由引擎以 stopped 形态收尾（不走 onError）。
          finished = true;
          const ctx = context;
          if (ctx) {
            void ctx.stopCompletion().catch(() => undefined);
          }
        },
      };
    },

    async completeChatCompletion(input: CompleteChatInput) {
      const ready = await resolveReadyModel(input.model);
      let ctx: OnDeviceLlamaContext;
      try {
        ctx = await ensureContext(input.model, ready.nativePath, ready.spec);
      } catch (e) {
        throw withErrorMessage(nativeError('加载本机模型', e));
      }
      let streamed = '';
      let result: OnDeviceCompletionResult;
      try {
        result = await ctx.completion(
          buildParams(
            {
              messages: input.messages,
              // 与 HTTP 实现同缺省（标题量级小调用）
              maxTokens: input.maxTokens ?? 32,
              temperature: input.temperature ?? 0.3,
            },
            ready.spec
          ),
          (data) => {
            const delta =
              typeof data.content === 'string' ? data.content : data.token;
            if (delta) streamed += delta;
          }
        );
      } catch (e) {
        throw withErrorMessage(nativeError('本机模型生成', e));
      }
      return result.content !== '' ? result.content : streamed;
    },

    async fetchProviderModels() {
      // 纯本地零网络：只列已下载且校验在案的模型 id
      const states = await deps.manager.checkAll();
      return states
        .filter((s) => s.kind === 'ready')
        .map((s) => s.modelId);
    },

    async checkConnectivity(input) {
      // 真值 = 指定模型文件在位且校验标记在案；latencyMs 为本地核对
      // 的真实耗时（非网络往返，不伪造）。
      const started = Date.now();
      const state = await deps.manager.check(input.model);
      const latencyMs = Date.now() - started;
      if (state.kind === 'ready') {
        return { ok: true, latencyMs, error: null };
      }
      return { ok: false, latencyMs, error: await notReadyError(input.model) };
    },

    async pingProviderEndpoint() {
      // 供应商 = 本机模型整体：在位状态以「至少一个模型就绪」为真值；
      // latencyMs 同上为本地核对耗时。
      const started = Date.now();
      const states = await deps.manager.checkAll();
      const latencyMs = Date.now() - started;
      const models = readyModelSpecs(states);
      if (models.length === 0) {
        return {
          ok: false,
          latencyMs,
          error: withErrorMessage({
            ...notConfiguredError(),
            detail: '本机模型尚未下载：请先在模型管理中下载至少一个模型。',
          }),
          models: [],
        };
      }
      return { ok: true, latencyMs, error: null, models };
    },

    async fetchProviderModelsRobust() {
      const states = await deps.manager.checkAll();
      return readyModelSpecs(states);
    },

    loadedModelId() {
      return active?.modelId ?? null;
    },

    isLoading() {
      return pendingInit !== null;
    },

    async loadModel(modelId: string) {
      const ready = await resolveReadyModel(modelId);
      try {
        await ensureContext(modelId, ready.nativePath, ready.spec);
      } catch (e) {
        throw withErrorMessage(nativeError('加载本机模型', e));
      }
    },

    async releaseLoaded() {
      if (pendingInit) {
        try {
          await pendingInit;
        } catch {
          // 初始化失败则无上下文可释放，继续走 active 收口
        }
      }
      const current = active;
      active = null;
      if (current) {
        await current.context.release();
      }
    },
  };
}
