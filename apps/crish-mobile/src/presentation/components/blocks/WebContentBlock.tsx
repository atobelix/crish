// WebView 内容块（批 E，2026-11-03)：封口公式（KaTeX）/ Mermaid 图块的
// 呈现宿主。文档由 buildWebHtml 在本地拼装（库与字体全内嵌），渲染结果经
// postMessage 回传高度定高；失败 / 超时一律回落原文等宽呈现（与代码块同
// 容器），不空白、不假图。
// 纪律：
// - 只由呈现层对**封口**块挂载（MarkdownText 把关)，source 恒为终态文本，
//   流式尾块不经此处；
// - WebView 禁文件访问 / 禁多窗 / 禁混合内容，页面无任何网络请求面；
// - 高度先占位（下方常量）后由回传实测替换，超时未回传即判失败回落。
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useTheme } from '@/adapters/platform/theme';
import { buildWebHtml, type WebBlockKind } from './webview/buildWebHtml';

/** 首帧占位高（实测回传前；公式一行约 56、图块按 Cherry 192 档近似） */
const INITIAL_HEIGHT: Record<WebBlockKind, number> = {
  math: 56,
  mermaid: 192,
};
/** 高度回传等待上限：超时未回传判失败回落（本地渲染正常在百毫秒级） */
const MEASURE_TIMEOUT_MS = 5_000;
/** 高度钳制：防异常回传把列表行撑爆（公式横滑、图按宽缩放，高度天然有界） */
const MAX_CONTENT_HEIGHT = 2_000;

export interface WebContentBlockProps {
  kind: WebBlockKind;
  source: string;
  testID?: string;
}

export function WebContentBlock({
  kind,
  source,
  testID,
}: WebContentBlockProps) {
  const theme = useTheme();
  const [height, setHeight] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const measuredRef = useRef(false);

  const html = useMemo(
    () =>
      buildWebHtml({
        kind,
        source,
        dark: theme.dark,
        textColor: theme.colors.textPrimary,
      }),
    [kind, source, theme.dark, theme.colors.textPrimary]
  );

  useEffect(() => {
    measuredRef.current = false;
    setHeight(null);
    setFailed(false);
    const timer = setTimeout(() => {
      if (!measuredRef.current) setFailed(true);
    }, MEASURE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [html]);

  const handleMessage = (event: WebViewMessageEvent): void => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as {
        t?: string;
        h?: number;
        m?: string;
      };
      if (data.t === 'h' && typeof data.h === 'number' && data.h > 0) {
        measuredRef.current = true;
        setHeight(Math.min(Math.ceil(data.h), MAX_CONTENT_HEIGHT));
      } else if (data.t === 'err') {
        setFailed(true);
      }
    } catch {
      // 非本协议消息（页面其它 postMessage）忽略，不影响呈现
    }
  };

  if (failed) {
    // 诚实回落：原文等宽呈现（公式 TeX / 图源码），与代码块同容器口径
    return (
      <View
        testID={testID ? `${testID}-fallback` : undefined}
        style={{
          backgroundColor: theme.colors.surfaceGrouped,
          borderRadius: theme.radius.control,
          padding: theme.space.md,
        }}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text
            selectable
            style={[theme.type.mono, { color: theme.colors.textPrimary }]}
          >
            {source}
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      testID={testID}
      style={{
        backgroundColor: theme.colors.surfaceGrouped,
        borderRadius: theme.radius.control,
        padding: theme.space.sm,
      }}
    >
      <WebView
        source={{ html }}
        originWhitelist={['about:blank']}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        mixedContentMode="never"
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        onMessage={handleMessage}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        style={{
          height: height ?? INITIAL_HEIGHT[kind],
          backgroundColor: 'transparent',
        }}
      />
    </View>
  );
}

export default WebContentBlock;
