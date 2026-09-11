/**
 * FirstRunWizard 纯函数层：校验 / 文案 / 步进元数据 / 完成门闩。
 * 从 FirstRunWizard.tsx 抽出，零渲染，可独立单测。
 *
 * 注意：isFirstRunDone / markFirstRunDone / shouldShowFirstRunWizard 会读写
 * localStorage（完成标记），属「带持久化的门闩函数」，调用时机由壳层负责。
 */
import {
  normalizeModelIds,
  anyProfileHasKey,
  type ProviderProfile,
} from '../api/providerProfiles';
import { networkUserMessage } from '../api/userFacingErrors';

import {
  readFirstRunWizardDone,
  writeFirstRunWizardDone,
} from '../api/cache/runtimeCache';

export function isFirstRunDone(): boolean {
  return readFirstRunWizardDone();
}

export function markFirstRunDone(): void {
  writeFirstRunWizardDone();
}

/**
 * 冷启动是否应挂载向导：正式版、未完成、且本机尚未配密钥。
 * 已有密钥则落盘完成标记（模型可在底栏手填 / 设置页完成）。
 * 无副作用查询请用 isFirstRunDone / anyProfileHasKey；盖层是否打开用 isFirstRunOverlayOpen。
 */
export function shouldShowFirstRunWizard(): boolean {
  if (isFirstRunDone()) return false;
  // 已有密钥视为用户会用，不再强制向导（模型可手填）
  if (anyProfileHasKey()) {
    markFirstRunDone();
    return false;
  }
  return true;
}

/**
 * 手填 / 列表模型 id 规范化：trim。
 * 纯函数，供向导与单测共用；不在此剥离内部空白（留给校验报页内 error）。
 */
export function normalizeHandFilledModelId(raw: string): string {
  return String(raw ?? '').trim();
}

/** 手填模型 id 合理上限（防粘贴整段文档） */
export const WIZARD_MODEL_ID_MAX_LEN = 128;

/** 向导模型 id 校验结果（判别联合，供 UI / 测试共用） */
export type WizardModelIdResult =
  | { ok: true; modelId: string }
  | { ok: false; error: string };

/** 成功支路 type guard：调用侧可安全读 modelId */
export function isWizardModelIdOk(
  r: WizardModelIdResult,
): r is Extract<WizardModelIdResult, { ok: true }> {
  return r.ok === true;
}

/** 失败支路 type guard：调用侧可安全读 error（页内 alert 文案） */
export function isWizardModelIdError(
  r: WizardModelIdResult,
): r is Extract<WizardModelIdResult, { ok: false }> {
  return r.ok === false;
}

/**
 * 校验向导模型步输入（列表选中或手填）。
 * 成功路径不 toast；错误文案仅供页内 role=alert。
 */
export function validateWizardModelId(raw: string): WizardModelIdResult {
  const modelId = normalizeHandFilledModelId(raw);
  if (!modelId) {
    return { ok: false, error: '请手填模型 id，或从上方列表选择' };
  }
  if (/\s/.test(modelId)) {
    return { ok: false, error: '模型 id 不能包含空格' };
  }
  // 控制字符 / 不可见字符（粘贴污染）
  // eslint-disable-next-line no-control-regex -- 有意校验 C0 控制字符
  if (/[\u0000-\u001F\u007F]/.test(modelId)) {
    return { ok: false, error: '模型 id 含有非法字符' };
  }
  if (modelId.length > WIZARD_MODEL_ID_MAX_LEN) {
    return { ok: false, error: `模型 id 过长（最多 ${WIZARD_MODEL_ID_MAX_LEN} 字符）` };
  }
  return { ok: true, modelId };
}

/**
 * 向导模型列表守卫（纯）：trim / 去空 / 去重。
 * 空 catalog → []，绝不发明远程演示 id（如 mimo）。
 */
export function wizardListedModels(
  profile: Pick<ProviderProfile, 'models'> | null | undefined,
): string[] {
  return normalizeModelIds(profile?.models);
}

/** 空列表 / 无服务商时模型步中文提示（纯，页内 hint，不 toast） */
export function wizardEmptyModelCatalogHint(hasProfile: boolean): string {
  if (!hasProfile) {
    return '暂无可用服务商。请稍后在设置中添加，或跳过向导。';
  }
  return '本机目录为空：请手填供应商文档中的 model id，或稍后在设置中「获取列表」。不会预置任何远程演示模型。';
}

/** 中立向导默认协议（仅协议兼容，不绑官方域名） */
export const DEFAULT_WIZARD_PROTOCOL = 'openai/chat';

/** 密钥步页内字段校验（名称必填；URL/密钥按业务规则） */
export type WizardConnectFormResult =
  | {
      ok: true;
      name: string;
      baseUrl: string;
      apiKey: string;
      protocol: string;
    }
  | { ok: false; error: string };

/**
 * 校验向导第 0 步连接表单。
 * 名称必填；Base URL 必填且须为 http(s)；密钥非空；协议回落默认。
 */
export function validateWizardConnectForm(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: string;
}): WizardConnectFormResult {
  const name = String(input.name ?? '').trim();
  const baseUrl = String(input.baseUrl ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const protocol =
    String(input.protocol ?? '').trim() || DEFAULT_WIZARD_PROTOCOL;

  if (!name) {
    return { ok: false, error: '请填写服务商名称' };
  }
  if (!baseUrl) {
    return { ok: false, error: '请填写 Base URL' };
  }
  if (!/^https?:\/\/.+/i.test(baseUrl)) {
    return { ok: false, error: 'Base URL 需以 http:// 或 https:// 开头' };
  }
  if (!apiKey) {
    return { ok: false, error: '请粘贴 API 密钥' };
  }
  return { ok: true, name, baseUrl, apiKey, protocol };
}

/** 密钥步 saveProfileKey 返回的已知 error code（宽字符串兼容未知支路） */
export type WizardKeySaveErrorCode =
  | 'empty_key'
  | 'not_connected'
  | 'profile_not_found'
  | (string & {});

/** 密钥步页内决策：block 停步展示 error；continue 进模型手填步 */
export type WizardKeySaveDecision =
  | { action: 'block'; error: string }
  | { action: 'continue' };

/**
 * 将 saveProfileKey 结果映射为页内决策（判别联合）。
 * empty_key / 关键失败 → block + 页内 error；密钥已落盘的软同步失败 → continue。
 */
export function decideWizardKeySave(res: {
  ok: boolean;
  error?: string;
}): WizardKeySaveDecision {
  if (res.ok) return { action: 'continue' };
  const code = (res.error || '') as WizardKeySaveErrorCode;
  if (code === 'empty_key') {
    return { action: 'block', error: '请粘贴 API 密钥' };
  }
  if (code === 'profile_not_found') {
    return { action: 'block', error: '服务商不存在，请重新选择' };
  }
  if (code === 'not_connected') {
    // 密钥已落盘，但向导需告知引擎未连上（页内，不 toast）
    return { action: 'block', error: networkUserMessage() };
  }
  // 其它引擎同步失败：本地密钥已有，允许继续手填模型
  return { action: 'continue' };
}

/** 模型激活失败时的已知 code */
export type WizardActivateErrorCode =
  | 'not_connected'
  | 'empty_model'
  | 'profile_not_found'
  | (string & {});

/**
 * activateProfileModel 失败 → 页内 error 文案（成功返回 null，调用方不 toast）。
 */
export function wizardActivatePageError(res: {
  ok: boolean;
  error?: string;
}): string | null {
  if (res.ok) return null;
  const code = (res.error || '') as WizardActivateErrorCode;
  if (code === 'not_connected') return networkUserMessage();
  if (code === 'empty_model') return '请填写模型 id';
  if (code === 'profile_not_found') return '服务商不存在，请重新选择';
  return '启用失败，请检查密钥与地址';
}

/**
 * 向导步（字面量联合，禁止任意 number）
 * 0 密钥 → 1 模型 → 2 导入外部对话（可选）→ 3 项目 → 4 开始
 */
export type WizardStep = 0 | 1 | 2 | 3 | 4;

const WIZARD_STEPS: readonly WizardStep[] = [0, 1, 2, 3, 4];

export function isWizardStep(n: number): n is WizardStep {
  return (WIZARD_STEPS as readonly number[]).includes(n);
}

/** 上一步：到 0 为止，无 as 断言 */
export function prevWizardStep(s: WizardStep): WizardStep {
  if (s === 0) return 0;
  const prev = s - 1;
  return isWizardStep(prev) ? prev : 0;
}

/** 下一步：到 4 为止，无 as 断言 */
export function nextWizardStep(s: WizardStep): WizardStep {
  if (s === 4) return 4;
  const next = s + 1;
  return isWizardStep(next) ? next : 4;
}

/** 中文步骤元数据（标题 + 简述；纯，供轨与副标题共用） */
export type WizardStepMeta = {
  id: WizardStep;
  title: string;
  desc: string;
};

export const WIZARD_STEP_META: readonly WizardStepMeta[] = [
  {
    id: 0,
    title: '配置连接',
    desc: '填写名称、Base URL、密钥与协议（不绑定第三方服务商）',
  },
  { id: 1, title: '启用模型', desc: '手填或选择模型 id 并写入引擎' },
  { id: 2, title: '导入对话', desc: '可选：从 Claude Code / Codex 导入' },
  { id: 3, title: '选择项目', desc: '可选，也可稍后选择' },
  { id: 4, title: '开始使用', desc: '进入主界面' },
];

/** 安全取步骤元数据（越界回落首步，无 as） */
export function wizardStepMeta(step: WizardStep): WizardStepMeta {
  const found = WIZARD_STEP_META.find((s) => s.id === step);
  return found ?? WIZARD_STEP_META[0]!;
}

/** 主按钮中文文案（按步密度区分，纯） */
export function wizardPrimaryCtaLabel(step: WizardStep, busy: boolean): string {
  if (busy) return '处理中…';
  if (step === 0) return '保存连接并继续';
  if (step === 1) return '启用并继续';
  if (step === 2) return '继续';
  if (step === 3) return '继续';
  return '进入 Crish';
}
