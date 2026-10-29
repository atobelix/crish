// packages/shared-types/src/errors/lookup.ts
// 错误码元信息查询层：注册表本体在 generated/errors/info.ts（契约生成），
// 本文件只负责 titleKey / actionKey 的默认派生规则。
import type { CrishErrorCode } from '../generated/errors/codes';
import type { CrishErrorInfo } from '../generated/errors/info';
import { CRISH_ERROR_REGISTRY } from '../generated/errors/info';

/** 查询错误码元信息，未知码回退到 common.unknown */
export function getErrorInfo(code: CrishErrorCode): CrishErrorInfo {
  const info =
    CRISH_ERROR_REGISTRY[code] ?? CRISH_ERROR_REGISTRY['common.unknown'];
  return {
    ...info,
    titleKey: info.titleKey ?? `error.${info.code}.title`,
    actionKey: info.actionKey ?? info.action,
  };
}
