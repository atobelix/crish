// 连续滑动多选列表容器（向导第 2 步）：
// - 列表容器：支持基于左侧 44dp 专属勾选轨道的连续手势多选；
// - O(1) 网格数学判定：每项高度恒定 H=48dp，间隙 G=8dp，步长 S=56dp；
// - 手势与滚动解耦：基于 react-native-gesture-handler 的 Gesture.Pan().minDistance(8)
//   与卡片点击 Gesture.Tap() 并存。在左侧 44dp 专属滑动轨道上滑动触发连续多选，
//   不阻塞卡片本身的独立点击，也不干扰整体页面的垂直滚动；
// - 齿轮咬合触感：每次划过新项立即触发 haptics.selection()（Haptics.selectionAsync 门面）；
// - 防误触单击解耦：滑动结束 250ms 内防抖抑制单击，彻底消除手势抬起误反选。
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { haptics } from '@/adapters/platform/haptics';
import {
  ModelSelectCard,
  type CanonicalSlotDef,
  type ModelCapabilitiesInput,
} from './ModelSelectCard';

/** 卡片高度恒定 48dp */
export const ITEM_HEIGHT = 48;
/** 卡片间隙恒定 8dp */
export const ITEM_GAP = 8;
/** 步进周期恒定 56dp (48 + 8) */
export const STEP_SIZE = ITEM_HEIGHT + ITEM_GAP; // 56
/** 左侧专属滑动多选热区轨道宽度 44dp */
export const TRACK_WIDTH = 44;

/**
 * 纯数学计算：根据触碰 Y 坐标计算当前所在的网格项索引 (O(1))
 */
export function getItemIndexFromY(
  y: number,
  stepSize: number = STEP_SIZE
): number {
  return Math.floor(y / stepSize);
}

/**
 * 纯数学计算：检查触碰 Y 坐标是否落在卡片有效主体内部（过滤 8dp 间隙 Gap）
 */
export function isInsideCardItem(
  y: number,
  itemHeight: number = ITEM_HEIGHT,
  stepSize: number = STEP_SIZE
): boolean {
  if (y < 0) return false;
  const offsetInStep = ((y % stepSize) + stepSize) % stepSize;
  return offsetInStep <= itemHeight;
}

/**
 * 纯数学判定：解析给定 Y 坐标命中的有效卡片索引，若越界或落在间隙内返回 null (O(1))
 */
export function resolveCardIndexAtY(
  y: number,
  totalCount: number,
  itemHeight: number = ITEM_HEIGHT,
  stepSize: number = STEP_SIZE
): number | null {
  if (totalCount <= 0 || y < 0) return null;
  const idx = getItemIndexFromY(y, stepSize);
  if (idx < 0 || idx >= totalCount) return null;
  if (!isInsideCardItem(y, itemHeight, stepSize)) return null;
  return idx;
}

/**
 * 纯函数：计算两次位移之间跨越的所有卡片索引闭区间（防高速滑动手势丢帧跳项）
 */
export function resolveSwipedRange(fromIdx: number, toIdx: number): number[] {
  const min = Math.min(fromIdx, toIdx);
  const max = Math.max(fromIdx, toIdx);
  const result: number[] = [];
  for (let i = min; i <= max; i++) {
    result.push(i);
  }
  return result;
}

export interface SwipeMultiSelectItem {
  id: string;
  displayName?: string;
  contextLength?: string | number;
  capabilities?: ModelCapabilitiesInput;
  supportsThinking?: boolean;
  disabled?: boolean;
}

export interface SwipeMultiSelectProps<
  T extends SwipeMultiSelectItem = SwipeMultiSelectItem,
> {
  /** 待选模型列表 */
  items: readonly T[];
  /** 已选模型 ID 集合（支持 Set 或只读数组） */
  selectedIds: ReadonlySet<string> | readonly string[];
  /** 选中状态全量变更回调 */
  onSelectionChange: (nextSelectedIds: Set<string>) => void;
  /** 单项状态变更回调（可选） */
  onToggleItem?: (id: string, selected: boolean) => void;
  /** 自定义卡片渲染器（缺省渲染 ModelSelectCard） */
  renderItem?: (
    item: T,
    selected: boolean,
    index: number,
    onToggle: () => void
  ) => React.ReactNode;
  /** 自定义能力槽位配置（传透至缺省 ModelSelectCard） */
  slots?: readonly CanonicalSlotDef[];
  /** 容器自定义样式 */
  style?: StyleProp<ViewStyle>;
  /** 测试 ID */
  testID?: string;
}

export const SwipeMultiSelect = memo(function SwipeMultiSelect<
  T extends SwipeMultiSelectItem = SwipeMultiSelectItem,
>({
  items,
  selectedIds,
  onSelectionChange,
  onToggleItem,
  renderItem,
  slots,
  style,
  testID = 'swipe-multi-select',
}: SwipeMultiSelectProps<T>) {
  // 规整 selectedIds 为 Set
  const selectedSet = useMemo(() => {
    return selectedIds instanceof Set
      ? (selectedIds as Set<string>)
      : new Set(selectedIds);
  }, [selectedIds]);

  // 手势运行期活跃选择集合引用，避免在密集手势位移中受限于 React 异步更新帧
  const activeSelectedSetRef = useRef<Set<string>>(new Set(selectedSet));
  const isSwipingRef = useRef(false);
  const swipedIndicesRef = useRef<Set<number>>(new Set());
  const swipeTargetStateRef = useRef<boolean>(true);
  const lastTouchedIdxRef = useRef<number>(-1);
  const lastSwipedTimestampRef = useRef<number>(0);

  // 当外部传入的 selectedIds 更新且当前不在滑动手势中时，同步活跃集合
  useEffect(() => {
    if (!isSwipingRef.current) {
      activeSelectedSetRef.current = new Set(selectedSet);
    }
  }, [selectedSet]);

  const totalCount = items.length;
  const totalHeight = totalCount > 0 ? totalCount * STEP_SIZE - ITEM_GAP : 0;

  // 1. 处理滑动开始
  const handleSwipeBegin = useCallback(
    (startIdx: number) => {
      isSwipingRef.current = true;
      swipedIndicesRef.current.clear();
      lastTouchedIdxRef.current = startIdx;

      if (startIdx >= 0 && startIdx < items.length) {
        const item = items[startIdx];
        if (item && !item.disabled) {
          // 若首个触碰项此前已选，则本轮滑动目标为取消勾选；反之则批量勾选
          const currentlySelected = activeSelectedSetRef.current.has(item.id);
          const targetState = !currentlySelected;
          swipeTargetStateRef.current = targetState;

          swipedIndicesRef.current.add(startIdx);
          if (targetState) {
            activeSelectedSetRef.current.add(item.id);
          } else {
            activeSelectedSetRef.current.delete(item.id);
          }

          // 齿轮咬合级微触感
          haptics.selection();
          onToggleItem?.(item.id, targetState);
          onSelectionChange(new Set(activeSelectedSetRef.current));
        }
      }
    },
    [items, onSelectionChange, onToggleItem]
  );

  // 2. 处理滑动经过各项（支持跨帧区间扫选，不漏项）
  const handleSwipeUpdate = useCallback(
    (currentIdx: number) => {
      if (!isSwipingRef.current) return;
      if (currentIdx < 0 || currentIdx >= items.length) return;

      const lastIdx =
        lastTouchedIdxRef.current >= 0 ? lastTouchedIdxRef.current : currentIdx;
      lastTouchedIdxRef.current = currentIdx;

      const range = resolveSwipedRange(lastIdx, currentIdx);
      let stateChanged = false;
      const targetState = swipeTargetStateRef.current;

      for (const idx of range) {
        if (idx < 0 || idx >= items.length) continue;
        if (swipedIndicesRef.current.has(idx)) continue;

        swipedIndicesRef.current.add(idx);
        const item = items[idx];
        if (!item || item.disabled) continue;

        if (targetState) {
          activeSelectedSetRef.current.add(item.id);
        } else {
          activeSelectedSetRef.current.delete(item.id);
        }
        onToggleItem?.(item.id, targetState);
        stateChanged = true;
      }

      if (stateChanged) {
        // 每次划过新项触发微触感
        haptics.selection();
        onSelectionChange(new Set(activeSelectedSetRef.current));
      }
    },
    [items, onSelectionChange, onToggleItem]
  );

  // 3. 处理滑动结束
  const handleSwipeEnd = useCallback(() => {
    if (isSwipingRef.current) {
      lastSwipedTimestampRef.current = Date.now();
    }
    isSwipingRef.current = false;
    swipedIndicesRef.current.clear();
    lastTouchedIdxRef.current = -1;
  }, []);

  // 4. 处理左侧 44dp 轨道上的轻触单击
  const handleTrackTap = useCallback(
    (tapIdx: number) => {
      // 若距上次滑动结束不足 250ms，直接忽略防抖，避免松手误反选
      if (Date.now() - lastSwipedTimestampRef.current < 250) {
        return;
      }
      if (tapIdx < 0 || tapIdx >= items.length) return;
      const item = items[tapIdx];
      if (!item || item.disabled) return;

      const currentlySelected = activeSelectedSetRef.current.has(item.id);
      const nextState = !currentlySelected;

      if (nextState) {
        activeSelectedSetRef.current.add(item.id);
      } else {
        activeSelectedSetRef.current.delete(item.id);
      }

      haptics.selection();
      onToggleItem?.(item.id, nextState);
      onSelectionChange(new Set(activeSelectedSetRef.current));
    },
    [items, onSelectionChange, onToggleItem]
  );

  // 5. 处理右侧卡片区域的普通点击
  const handleCardTap = useCallback(
    (id: string) => {
      if (Date.now() - lastSwipedTimestampRef.current < 250) {
        return;
      }
      const item = items.find((it) => it.id === id);
      if (!item || item.disabled) return;

      const currentlySelected = activeSelectedSetRef.current.has(id);
      const nextState = !currentlySelected;

      if (nextState) {
        activeSelectedSetRef.current.add(id);
      } else {
        activeSelectedSetRef.current.delete(id);
      }

      haptics.selection();
      onToggleItem?.(id, nextState);
      onSelectionChange(new Set(activeSelectedSetRef.current));
    },
    [items, onSelectionChange, onToggleItem]
  );

  // 编排左侧 44dp 专属热区轨道上的 Pan 与 Tap 手势
  const panGesture = useMemo(() => {
    return Gesture.Pan()
      .minDistance(8)
      .onStart((e) => {
        'worklet';
        const inCard = ((e.y % 56) + 56) % 56 <= 48;
        const idx = Math.floor(e.y / 56);
        if (idx >= 0 && idx < totalCount && inCard) {
          runOnJS(handleSwipeBegin)(idx);
        }
      })
      .onUpdate((e) => {
        'worklet';
        const inCard = ((e.y % 56) + 56) % 56 <= 48;
        const idx = Math.floor(e.y / 56);
        if (idx >= 0 && idx < totalCount && inCard) {
          runOnJS(handleSwipeUpdate)(idx);
        }
      })
      .onFinalize(() => {
        'worklet';
        runOnJS(handleSwipeEnd)();
      });
  }, [totalCount, handleSwipeBegin, handleSwipeUpdate, handleSwipeEnd]);

  const tapGesture = useMemo(() => {
    return Gesture.Tap()
      .maxDuration(250)
      .onEnd((e) => {
        'worklet';
        const inCard = ((e.y % 56) + 56) % 56 <= 48;
        const idx = Math.floor(e.y / 56);
        if (idx >= 0 && idx < totalCount && inCard) {
          runOnJS(handleTrackTap)(idx);
        }
      });
  }, [totalCount, handleTrackTap]);

  const trackGesture = useMemo(() => {
    return Gesture.Race(panGesture, tapGesture);
  }, [panGesture, tapGesture]);

  return (
    <View style={[styles.container, style]} testID={testID}>
      {/* 卡片实体列表（卡片高 48dp，间隙 8dp） */}
      <View style={styles.listContainer} testID="swipe-list-container">
        {items.map((item, index) => {
          const isSelected = selectedSet.has(item.id);
          const toggle = () => handleCardTap(item.id);

          return (
            <View
              key={item.id}
              style={styles.itemWrapper}
              testID={`swipe-item-wrapper-${item.id}`}
            >
              {renderItem ? (
                renderItem(item, isSelected, index, toggle)
              ) : (
                <ModelSelectCard
                  id={item.id}
                  displayName={item.displayName}
                  contextLength={item.contextLength}
                  capabilities={item.capabilities}
                  supportsThinking={item.supportsThinking}
                  slots={slots}
                  selected={isSelected}
                  onToggle={toggle}
                  testID={`model-select-card-${item.id}`}
                />
              )}
            </View>
          );
        })}
      </View>

      {/* 左侧 44dp 专属滑动多选热区轨道（通过绝对定位覆盖在复选框上，右侧区域不拦截 ScrollView 纵向滚动） */}
      {totalCount > 0 ? (
        <GestureDetector gesture={trackGesture}>
          <View
            style={[
              styles.gestureTrack,
              {
                width: TRACK_WIDTH,
                height: totalHeight,
              },
            ]}
            testID="swipe-gesture-track"
            collapsable={false}
          />
        </GestureDetector>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    width: '100%',
  },
  listContainer: {
    gap: ITEM_GAP, // 8dp
  },
  itemWrapper: {
    height: ITEM_HEIGHT, // 48dp
    width: '100%',
  },
  gestureTrack: {
    position: 'absolute',
    left: 0,
    top: 0,
    zIndex: 10,
    backgroundColor: 'transparent',
  },
});

export default SwipeMultiSelect;
