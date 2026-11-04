import React from 'react';
import { AnimatedCounter } from './AnimatedCounter';

/** 文本切片：纯文本段 / 可滚动数字段 */
export type NumericSegment =
  | { type: 'text'; text: string }
  | { type: 'number'; value: number; decimals: number };

const NUMBER_RE = /\d+(?:\.\d+)?/g;
/** 超出该位数的数字不进滚轮（Number 精度与列数双重保护） */
const MAX_ROLLING_DIGITS = 12;

/**
 * 把一段已格式化好的文案切成「文本 / 数字」交替的片段（纯函数，可穷举验证）。
 *
 * 只有「语义上是数量」的数字才进滚轮；带前导零的数字串（`05`、`00:07`、
 * 日期时间里的零填充段）进滚轮会丢零、改写原文，一律留在文本段原样输出。
 */
export function splitNumericText(text: string): NumericSegment[] {
  const segments: NumericSegment[] = [];
  let cursor = 0;
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const last = segments[segments.length - 1];
    if (last && last.type === 'text') last.text += chunk;
    else segments.push({ type: 'text', text: chunk });
  };

  for (const match of text.matchAll(NUMBER_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const [intPart = '', fracPart] = raw.split('.');
    const hasLeadingZero = intPart.length > 1 && intPart.startsWith('0');
    const tooLong =
      intPart.length + (fracPart?.length ?? 0) > MAX_ROLLING_DIGITS;
    pushText(text.slice(cursor, start));
    cursor = start + raw.length;
    if (hasLeadingZero || tooLong) {
      pushText(raw);
      continue;
    }
    segments.push({
      type: 'number',
      value: Number(raw),
      decimals: fracPart?.length ?? 0,
    });
  }
  pushText(text.slice(cursor));
  return segments;
}

export interface NumericTextProps {
  /** 已格式化好的整句文案（如 `24 项`、`+32`、`已搜索 2 次`、`1.2s`） */
  text: string;
  /** 首次挂载是否从 0 滚到目标值（实况到达用；历史内容直出终值） */
  animateOnView?: boolean;
  className?: string;
}

/**
 * NumericText：文案内的数字自动变成里程表滚轮，其余字符原样输出。
 *
 * 文案的 SSOT 仍在各自的格式化函数里（processMetricsEngine /
 * toolHeaderPresentation），本组件只负责「把文案里的数字动起来」，
 * 不重写文案、不另算数值。数字段按出现序固定 key，文案中数值变化时
 * 对应滚轮原地滚动而不是重挂载。
 */
export const NumericText: React.FC<NumericTextProps> = ({
  text,
  animateOnView = true,
  className,
}) => {
  const segments = splitNumericText(text);
  if (!segments.some((s) => s.type === 'number')) {
    return <span className={className}>{text}</span>;
  }
  let ordinal = 0;
  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.type === 'text' ? (
          <React.Fragment key={`t${index}`}>{segment.text}</React.Fragment>
        ) : (
          <AnimatedCounter
            key={`n${ordinal++}`}
            value={segment.value}
            decimals={segment.decimals}
            animateOnView={animateOnView}
          />
        )
      )}
    </span>
  );
};

export default NumericText;
