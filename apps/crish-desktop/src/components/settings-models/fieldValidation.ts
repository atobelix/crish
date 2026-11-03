/**
 * 模型 / 供应商表单族共用的字段校验（F7 推广面）：与 ui FieldError 搭配——
 * 校验只产出「是否合法 / 错误文案」，呈现由 FieldError 统一承载，
 * 各表单不再逐页手搓错误样式与清除逻辑。错误口径：派生自字段当前值，
 * 非法期间常驻字段下方，修正即自动消失。
 */
import { t } from '../../i18n';

/** 正整数文本（上下文长度 / 最大输出等 token 数）：空/缺省 = 未设置（合法）；非空须为 > 0 的整数 */
export function isPositiveIntegerText(
  value: string | null | undefined
): boolean {
  const v = (value ?? '').trim();
  if (!v) return true;
  return /^\d+$/.test(v) && Number(v) > 0;
}

/** 正整数字段当前值的错误文案（合法时返回 null） */
export function positiveIntegerError(
  value: string | null | undefined
): string | null {
  return isPositiveIntegerText(value)
    ? null
    : t('settings.models.field.positiveInteger');
}

/** http(s) URL 文本：空/缺省 = 未设置（合法）；非空须可解析且协议为 http/https */
export function isHttpUrlText(value: string | null | undefined): boolean {
  const v = (value ?? '').trim();
  if (!v) return true;
  try {
    const url = new URL(v);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
