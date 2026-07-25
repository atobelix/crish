import { z } from 'zod';

// 将单个值协作为数组
export function zCoerceArray<T>(schema: z.ZodType<T>): z.ZodEffects<z.ZodType<T[], z.ZodTypeDef, T[]>> {
  return z.union([schema, z.array(schema)]).transform(v => Array.isArray(v) ? v : [v]) as unknown as z.ZodEffects<z.ZodType<T[], z.ZodTypeDef, T[]>, T[], T[]>;
}

// null/undefined 默认值为空字符串
export function zDefaultEmpty(schema: z.ZodType<string>): z.ZodEffects<z.ZodType<string, z.ZodTypeDef, string>, string, string> {
  return schema.or(z.literal('')).default('') as unknown as z.ZodEffects<z.ZodType<string, z.ZodTypeDef, string>, string, string>;
}

// 将原始类型包装为 { value: ... }
export function zCoerceObject<T>(schema: z.ZodType<T>): z.ZodEffects<z.ZodType<{ value: T }, z.ZodTypeDef, { value: T }>, { value: T }, { value: T }> {
  return z.union([schema, z.object({ value: schema })]).transform(v =>
    v && typeof v === 'object' && 'value' in v ? v : { value: v }
  ) as unknown as z.ZodEffects<z.ZodType<{ value: T }, z.ZodTypeDef, { value: T }>, { value: T }, { value: T }>;
}

export const helloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.number(),
  clientName: z.string().optional(),
  token: z.string().optional(),
});
