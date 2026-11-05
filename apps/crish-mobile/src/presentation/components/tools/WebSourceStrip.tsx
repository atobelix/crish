// 网页搜索来源微胶囊横向滑动条（WebSourceStrip）：
// 紧随工具单行或呈现于回答时间线上方，以水平滑动条形式排布 WebSourceCard 微胶囊。
// 支持通过 activeSourceId 或 highlightedIndex / citationIndex 控制高亮呼吸联动；
// 来源数量上限自适应（缺省最多展示 10 个，超出支持横向滑动查看）。
import {
  ScrollView,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';
import type { WebSearchSource } from '@crish/shared-types';
import { WebSourceCard } from './WebSourceCard';

export interface WebSourceStripProps {
  /** 网页搜索来源列表 */
  sources: readonly WebSearchSource[];
  /** 当前处于激活/高亮态的来源 ID */
  activeSourceId?: string | undefined;
  /** 当前处于高亮态的索引下标（0-based，如 0 对应第一项） */
  highlightedIndex?: number | undefined;
  /** 1-based 引用角标序号（如正文点击 [1] 时传入 1，对应第一项） */
  citationIndex?: number | undefined;
  /** 点击某来源卡片的回调（回传数据与 0-based 下标） */
  onPressSource?:
    ((source: WebSearchSource, index: number) => void) | undefined;
  /** 最大展示数量（缺省 10） */
  maxCount?: number | undefined;
  /** 自定义外层样式 */
  style?: StyleProp<ViewStyle> | undefined;
  /** 自定义滚动容器内衬样式 */
  contentContainerStyle?: StyleProp<ViewStyle> | undefined;
  testID?: string | undefined;
}

/** 判断单项来源卡片是否处于高亮态 */
function isSourceHighlighted(
  source: WebSearchSource,
  index: number,
  activeSourceId?: string | undefined,
  highlightedIndex?: number | undefined,
  citationIndex?: number | undefined
): boolean {
  if (activeSourceId && source.id === activeSourceId) {
    return true;
  }
  if (citationIndex !== undefined && citationIndex === index + 1) {
    return true;
  }
  if (highlightedIndex !== undefined) {
    // 匹配 source.id（例如模型生成的 numeric id '1'）
    if (source.id && String(highlightedIndex) === source.id) {
      return true;
    }
    // 0-based 数组下标匹配
    if (highlightedIndex === index) {
      return true;
    }
  }
  return false;
}

export function WebSourceStrip({
  sources,
  activeSourceId,
  highlightedIndex,
  citationIndex,
  onPressSource,
  maxCount = 10,
  style,
  contentContainerStyle,
  testID,
}: WebSourceStripProps) {
  const theme = useTheme();

  if (!sources || sources.length === 0) {
    return null;
  }

  // 来源数量自适应截断（最多展示 maxCount 项，超出支持滑动查看）
  const displayedSources = maxCount > 0 ? sources.slice(0, maxCount) : sources;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={testID ?? 'web-source-strip'}
      style={[styles.scrollContainer, style]}
      contentContainerStyle={[
        styles.contentContainer,
        {
          paddingHorizontal: theme.space.screenX,
        },
        contentContainerStyle,
      ]}
    >
      {displayedSources.map((source, index) => {
        const highlighted = isSourceHighlighted(
          source,
          index,
          activeSourceId,
          highlightedIndex,
          citationIndex
        );

        return (
          <WebSourceCard
            key={source.id || `web-source-${index}`}
            source={source}
            index={index + 1}
            highlighted={highlighted}
            onPress={(item) => onPressSource?.(item, index)}
            testID={`web-source-card-${source.id || index}`}
          />
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollContainer: {
    flexGrow: 0,
  },
  contentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
});

export default WebSourceStrip;
