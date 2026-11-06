// 内置端侧供应商条目与 models[] 同步（O4）：把 O2 管理器的就绪真值
// （checkAll：文件在位 + 尺寸精确 + verified.json 标记在案）回写为
// localChatStore 里一条由代码构造的内置供应商条目——
// - providerId 固定 'ondevice'、displayName「本机模型」、protocol
//   'ondevice/gguf'；无 baseUrl、无 apiKeyRef、无 vendor（不进供应商
//   向导预置、不经草稿建供应商路径，见 O4 vendor 裁决）；
// - models[] 只含已下载且校验在案的模型——LocalModelSheet 与每线程
//   modelRef 读的都是这份配置，「列出的即可用」由此成立；
// - 同步触发点：管理视图挂载/下载完成/删除之后、供应商列表挂载时
//   （校验失效在 checkAll 时被如实检出并回写）。状态源只有管理器
//   checkAll 一处，不另造轮询、不缓存第二份真值；
// - 回写走 localChatStore.upsertProvider 的既有自愈：活动模型被删时
//   回退到本条目默认模型（推荐档优先）或清空，线程悬挂 modelRef 被
//   解绑回跟随全局——「回退不悬空」不另写一份逻辑。
// - 无就绪模型且条目尚不存在时不造空条目（配置面保持「未配置」
//   诚实形态）；条目已存在后就绪集变空则回写空 models[]（条目在、
//   无可用模型，选择器呈现「暂无可用模型」）。
import { localChatStore } from '@/domain/store/localChatStore';
import type {
  LocalModelSpec,
  LocalProviderSpec,
} from '@/domain/types/localChat';
import type { OnDeviceModelSpec } from './onDeviceModelCatalog';
import type { OnDeviceModelManager } from './onDeviceModelManager';

/** 内置端侧供应商固定 id（路由/列表特殊行/详情守卫共用同一常量） */
export const ON_DEVICE_PROVIDER_ID = 'ondevice';

/** 内置端侧供应商展示名 */
export const ON_DEVICE_PROVIDER_NAME = '本机模型';

/** 同步所需的管理器面（O2 管理器的结构子集，测试可注入假件） */
export type OnDeviceProviderSyncManager = Pick<
  OnDeviceModelManager,
  'checkAll' | 'listSpecs'
>;

/**
 * 由就绪目录条目构造内置供应商 spec（纯函数）：
 * 能力规格只写端侧真值——上下文取目录 inference.contextSize（缺省
 * 4096，与 O3 客户端 initLlama 缺省一致）、纯文本模态、无思考档位
 * （v1 纯对话口径，fail-closed 不宣称未声明的能力）。
 */
export function buildOnDeviceProviderSpec(
  readySpecs: readonly OnDeviceModelSpec[]
): LocalProviderSpec {
  const models: LocalModelSpec[] = readySpecs.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    enabled: true,
    contextWindow: s.inference?.contextSize ?? 4096,
    modalities: { input: ['text'], output: ['text'] },
  }));
  const spec: LocalProviderSpec = {
    displayName: ON_DEVICE_PROVIDER_NAME,
    protocol: 'ondevice/gguf',
    stream: true,
    enabled: true,
    models,
  };
  const defaultId =
    readySpecs.find((s) => s.recommended)?.id ?? readySpecs[0]?.id;
  if (defaultId !== undefined) {
    spec.defaultModelId = defaultId;
  }
  return spec;
}

/**
 * 把管理器就绪真值同步进 localChatStore（见文件头触发点）。
 * 就绪集与现条目 models[] 一致时不回写（避免无谓 kv 落盘）。
 * @returns 当前就绪的模型 id 清单（目录顺序）
 */
export async function syncOnDeviceProvider(
  manager: OnDeviceProviderSyncManager
): Promise<readonly string[]> {
  const states = await manager.checkAll();
  const readyIds = states
    .filter((s) => s.kind === 'ready')
    .map((s) => s.modelId);
  const byId = new Map(manager.listSpecs().map((s) => [s.id, s]));
  const readySpecs = readyIds
    .map((id) => byId.get(id))
    .filter((s): s is OnDeviceModelSpec => s !== undefined);

  const state = localChatStore.getState();
  const current = state.config.providers[ON_DEVICE_PROVIDER_ID];
  if (current === undefined && readySpecs.length === 0) {
    return readyIds;
  }
  const currentIds = (current?.models ?? [])
    .map((m) => m.id)
    .slice()
    .sort();
  const nextIds = readyIds.slice().sort();
  const unchanged =
    current !== undefined &&
    current.protocol === 'ondevice/gguf' &&
    currentIds.length === nextIds.length &&
    currentIds.every((id, i) => id === nextIds[i]);
  if (unchanged) {
    return readyIds;
  }
  await state.upsertProvider(
    ON_DEVICE_PROVIDER_ID,
    buildOnDeviceProviderSpec(readySpecs)
  );
  return readyIds;
}
