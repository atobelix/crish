// 技能视图模型（G7）：Composer 附件面板「技能」入口与 SkillsSheet 的数据面。
// - 数据面：技能域仓库（GatewaySkillsRepository.listSkills，skillsWiring
//   .getSkillsContext 注入）读宿主技能发现——与桌面「设置 → 扩展 → 技能」
//   页同一真源（活动工作区 + 主目录全局技能目录），每次拉取都是实时
//   投影，本 VM 不缓存技能状态、不落本地；
// - 只读边界：技能启停生效值在桌面 webview 本地（localStorage），宿主
//   无数据面——本 VM 只有浏览语义（列表/计数/重试），没有启停动作，
//   不呈现任何伪造的启用状态；
// - 连接就绪后自动拉取一次（仅为附件面板入口的技能计数），失败落
//   error 态由 Sheet 内重试，不编造数量。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillEntry } from '@crish/shared-types';
import { useConnectionStore } from '@/adapters/hooks/useAppStore';
import {
  SkillsCommandError,
  getSkillsContext,
  type SkillsContext,
} from '@/adapters/RemoteControlFacade';

export type SkillsStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface SkillsVm {
  connected: boolean;
  /** 技能目录（未拉取为 null；宿主投影顺序：作用域序 + 名称序） */
  skills: readonly SkillEntry[] | null;
  status: SkillsStatus;
  /** 最近一次命令错误码（列表失败时供 Sheet 呈现） */
  errorCode: string | null;
  /** 附件面板入口计数：已拉取时 = 目录总数；未拉取/失败 = null（不编造） */
  skillsCount: number | null;
  /** 打开技能 Sheet 时调用：列表缺失或上次失败才刷新 */
  openList: () => void;
  retry: () => void;
}

function errorCodeOf(e: unknown): string {
  return e instanceof SkillsCommandError ? e.code : 'internal';
}

export function useSkillsVm(contextOverride?: SkillsContext | null): SkillsVm {
  const connected = useConnectionStore((s) => s.phase === 'ready');

  const [skills, setSkills] = useState<readonly SkillEntry[] | null>(null);
  const [status, setStatus] = useState<SkillsStatus>('idle');
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const ctxOf = useCallback(
    (): SkillsContext | null => contextOverride ?? getSkillsContext(),
    [contextOverride]
  );

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    const ctx = ctxOf();
    if (!ctx) return;
    loadingRef.current = true;
    setStatus('loading');
    try {
      const res = await ctx.repository.listSkills();
      setSkills(res.skills);
      setErrorCode(null);
      setStatus('loaded');
    } catch (e) {
      setErrorCode(errorCodeOf(e));
      setStatus('error');
    } finally {
      loadingRef.current = false;
    }
  }, [ctxOf]);

  // 连接就绪后为入口计数解析一次列表（只读投影，不做任何写操作）
  useEffect(() => {
    if (connected && skills === null && status === 'idle') {
      void load();
    }
  }, [connected, skills, status, load]);

  const openList = useCallback(() => {
    if (skills === null || status === 'error') {
      void load();
    }
  }, [skills, status, load]);

  const retry = useCallback(() => {
    void load();
  }, [load]);

  return {
    connected,
    skills,
    status,
    errorCode,
    skillsCount: skills ? skills.length : null,
    openList,
    retry,
  };
}
