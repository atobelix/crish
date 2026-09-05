import { useState, useRef, useEffect, type ReactElement } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  type LayoutRectangle,
  Dimensions,
  type AccessibilityRole,
} from 'react-native';
import { useTheme } from '@/adapters/platform/theme';

export interface TooltipProps {
  content: string;
  children: ReactElement;
  testID?: string;
  accessibilityRole?: AccessibilityRole;
}

export function Tooltip({
  content,
  children,
  testID,
  accessibilityRole = 'button',
}: TooltipProps) {
  const theme = useTheme();
  const [visible, setVisible] = useState(false);
  const [targetLayout, setTargetLayout] = useState<LayoutRectangle | null>(null);
  const triggerRef = useRef<View>(null);

  const showTooltip = () => {
    setVisible(true);
    if (
      triggerRef.current &&
      typeof triggerRef.current.measureInWindow === 'function'
    ) {
      triggerRef.current.measureInWindow((x, y, width, height) => {
        setTargetLayout({
          x: x ?? 0,
          y: y ?? 0,
          width: width ?? 0,
          height: height ?? 0,
        });
      });
    }
  };

  const dismiss = () => setVisible(false);

  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(dismiss, 2500);
    return () => clearTimeout(timer);
  }, [visible]);

  // 计算气泡位置（优先展示在元素上方，若贴顶则展示在下方）
  const window = Dimensions.get('window');
  const bubbleTop = targetLayout
    ? targetLayout.y - 38 < 44
      ? targetLayout.y + targetLayout.height + 8
      : targetLayout.y - 38
    : 44;

  const bubbleLeft = targetLayout
    ? Math.max(
        16,
        Math.min(window.width - 200, targetLayout.x + targetLayout.width / 2 - 80)
      )
    : 16;

  return (
    <>
      <Pressable
        ref={triggerRef}
        testID={testID}
        onLongPress={showTooltip}
        delayLongPress={350}
        accessibilityRole={accessibilityRole}
        accessibilityHint={`长按查看提示：${content}`}
      >
        {children}
      </Pressable>

      {visible && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable
            testID="tooltip-backdrop"
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
          />
          <View
            testID="tooltip-bubble"
            accessibilityRole="alert"
            style={[
              styles.bubble,
              {
                top: bubbleTop,
                left: bubbleLeft,
                backgroundColor: theme.bgElevated,
                borderColor: theme.hairline,
              },
            ]}
          >
            <Text
              style={[styles.bubbleText, { color: theme.textPrimary }]}
              numberOfLines={2}
            >
              {content}
            </Text>
          </View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    zIndex: 9999,
    maxWidth: 240,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 6,
  },
  bubbleText: {
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
  },
});

export default Tooltip;
