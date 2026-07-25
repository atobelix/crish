import { useShallow } from '../../store/useShallowSelector';
import { useSessionField, selectActiveSessionId } from '../../store/sessionStore';
import { useLayoutStore } from '../../store/layoutStore';

const EMPTY_ARRAY: never[] = [];

export function useChatCardSelectors() {
  const activeSessionId = useSessionField(selectActiveSessionId);
  const sh = <T,>(fn: (s: any) => T) => useSessionField(useShallow(fn));
  const messages = sh((s) => s.sessionsById[s.activeSessionId]?.messages || EMPTY_ARRAY);
  const agents = sh((s) => s.sessionsById[s.activeSessionId]?.agents || EMPTY_ARRAY);
  const goalMode = sh((s) => s.sessionsById[s.activeSessionId]?.goalMode);
  const hydratedFromEngine = sh((s) => s.sessionsById[s.activeSessionId]?.hydratedFromEngine);
  const engineCursor = sh((s) => s.sessionsById[s.activeSessionId]?.engineCursor);
  const engineLastRunId = sh((s) => s.sessionsById[s.activeSessionId]?.engineLastRunId);
  const activeSessionTitle = sh((s) => s.sessionsById[s.activeSessionId]?.title);
  const s = useLayoutStore;
  const withdrawMessage = s((st) => st.withdrawMessage);
  const appSettings = s(useShallow((st) => st.appSettings));
  const diffFiles = s(useShallow((st) => st.diffFiles));
  const permissionMode = s((st) => st.permissionMode);
  const setPermissionMode = s((st) => st.setPermissionMode);
  const planModeEnabled = s((st) => st.planModeEnabled);
  const planApproved = s((st) => st.planApproved);
  const setPlanApproved = s((st) => st.setPlanApproved);
  const mainSurface = s((st) => st.chatMainSurface || 'chat');
  const setMainSurface = s((st) => st.setChatMainSurface);
  const setComposerDraft = s((st) => st.setComposerDraft);
  const composerDrafts = s(useShallow((st) => st.composerDrafts));
  return { activeSessionId, messages, agents, goalMode, hydratedFromEngine, engineCursor, engineLastRunId, activeSessionTitle, withdrawMessage, appSettings, diffFiles, permissionMode, setPermissionMode, planModeEnabled, planApproved, setPlanApproved, inPlanMode: permissionMode === 'plan' || planModeEnabled, mainSurface, setMainSurface, setComposerDraft, composerDrafts };
}
