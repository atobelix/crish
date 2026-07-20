import { prepareRichInline, measureRichInlineStats, type RichInlineItem } from '@chenglou/pretext/rich-inline';
import { buildPretextFont } from './pretextFontBridge';

export function buildToolBadgeItem(label: string, extraWidth: number): RichInlineItem {
  return {
    text: label,
    font: buildPretextFont('mono', 'medium'),
    break: 'never',
    extraWidth,
  };
}

export function buildMentionChipItem(name: string, extraWidth: number): RichInlineItem {
  return {
    text: `@${name}`,
    font: buildPretextFont('sans', 'medium'),
    break: 'never',
    extraWidth,
  };
}

export function measureRichInlineWidth(items: RichInlineItem[]): number {
  const prepared = prepareRichInline(items);
  const stats = measureRichInlineStats(prepared, Infinity);
  return stats.maxLineWidth;
}
