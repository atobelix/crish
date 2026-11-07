// 嵌在 Sheet 纵向滚动里的列表窗口。
// 公共 Sheet 的子节点仍在同一方向的 ScrollView 中。
// 没有明确高度时，内部列表会跟着内容撑开，虚拟化不会发生。
// 扣掉的每一项对应面板内边距、把手、标题行和滚动内容底衬。
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/adapters/platform/theme';
import { SHEET_SIZE_RATIOS } from './Sheet';

/** 首屏约一屏行数。超过这个数量才锁高度，短列表仍按内容收缩。 */
export const SHEET_LIST_INITIAL = 8;
export const SHEET_LIST_BATCH = 6;
/** 视口倍数。比时间线更紧，避免把整份目录提前挂上。 */
export const SHEET_LIST_WINDOW = 5;

export interface SheetListChrome {
  windowHeight: number;
  maxHeightRatio: number;
  paddingTop: number;
  handleMarginTop: number;
  handleHeight: number;
  handleMarginBottom: number;
  headerRowHeight: number;
  headerMarginBottom: number;
  paddingBottom: number;
  scrollContentPaddingBottom: number;
}

export function sheetListMaxHeight(chrome: SheetListChrome): number {
  const panelMax = chrome.windowHeight * chrome.maxHeightRatio;
  const chromeHeight =
    chrome.paddingTop +
    chrome.handleMarginTop +
    chrome.handleHeight +
    chrome.handleMarginBottom +
    chrome.headerRowHeight +
    chrome.headerMarginBottom +
    chrome.paddingBottom +
    chrome.scrollContentPaddingBottom;
  return Math.max(0, Math.floor(panelMax - chromeHeight));
}

/** large 档面板里，列表自己滚动时的高度预算。 */
export function useLargeSheetListBudget(): number {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  return sheetListMaxHeight({
    windowHeight,
    maxHeightRatio: SHEET_SIZE_RATIOS.large,
    paddingTop: theme.space.sm,
    handleMarginTop: theme.space.xs,
    handleHeight: theme.size.sheetHandleHeight,
    handleMarginBottom: theme.space.md + theme.space.xxs,
    headerRowHeight: Math.max(
      theme.type.headline.lineHeight,
      theme.size.sheetClose
    ),
    headerMarginBottom: theme.space.lg,
    paddingBottom: Math.max(insets.bottom, theme.space.xxl),
    scrollContentPaddingBottom: theme.space.xs,
  });
}
