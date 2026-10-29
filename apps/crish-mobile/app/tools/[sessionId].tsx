// /tools/[sessionId]：工具调用 formSheet（停靠点见根布局 layout.toolSheetDetents）。
import { router, useLocalSearchParams } from 'expo-router';
import ToolSheetScreen from '@/presentation/screens/toolSheetScreen';

export default function ToolSheetRoute() {
  const { sessionId, focus } = useLocalSearchParams<{
    sessionId: string;
    focus?: string;
  }>();
  return (
    <ToolSheetScreen
      sessionId={sessionId ?? ''}
      focusId={focus}
      onOpenTerminal={(runId) => router.push(`/terminal/${runId}`)}
    />
  );
}
