import { useState, useEffect, useCallback } from 'preact/hooks';
import { tauriBridge } from '../core/tauri-bridge';
import { isBackendDiagnosticResult } from '../core/tauri-command-registry';
import type {
  WorkbenchPlanDocumentSummary,
  WorkbenchPlanDocument,
  WorkbenchPlanDocumentStatus,
} from '../shared/workbench-contract';
import { IconChevronRight, IconRefresh, IconTrash, IconCheck, IconSpinner } from './icons';

// 计划文档状态 -> 中文标签
const STATUS_LABEL: Record<WorkbenchPlanDocumentStatus, string> = {
  draft: '草稿',
  aligning: '对齐中',
  ready: '就绪',
  in_progress: '进行中',
  blocked: '受阻',
  completed: '已完成',
  archived: '已归档',
};

// 计划步骤等条目的最小展示形状（容忍后端字段差异）
interface PlanItemLike {
  id: string;
  title: string;
  status: string;
  detail?: string;
}

function stepProgress(summary: WorkbenchPlanDocumentSummary): { done: number; total: number } {
  const total = summary.steps?.total ?? 0;
  const done = summary.steps?.byStatus?.completed ?? 0;
  return { done, total };
}

// ==================== 计划文档面板（list -> 详情 -> 操作） ====================

export default function PlanDocumentsPanel() {
  const [summaries, setSummaries] = useState<WorkbenchPlanDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkbenchPlanDocument | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await tauriBridge.listPlanDocuments();
      if (isBackendDiagnosticResult(result)) {
        setError(result.diagnostic.message);
        setSummaries([]);
      } else {
        setSummaries(result as WorkbenchPlanDocumentSummary[]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const result = await tauriBridge.getPlanDocument(id);
      if (!isBackendDiagnosticResult(result)) {
        setDetail(result as WorkbenchPlanDocument);
      }
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleDelete = useCallback(
    async (id: string, e: MouseEvent) => {
      e.stopPropagation();
      setDeletingId(id);
      try {
        await tauriBridge.deletePlanDocument(id);
      } catch {
        /* 失败时静默，刷新会还原真实状态 */
      } finally {
        setDeletingId(null);
      }
      if (selectedId === id) {
        setSelectedId(null);
        setDetail(null);
      }
      void load();
    },
    [load, selectedId]
  );

  // ---- 详情视图 ----
  if (selectedId) {
    return (
      <div class="repl-rs-tab-content-inner">
        <div class="repl-rs-section-header">
          <button
            class="repl-rs-btn-icon"
            title="返回列表"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
            }}
          >
            <span class="repl-chevron-flip">
              <IconChevronRight />
            </span>
          </button>
          <span class="repl-rs-section-title">{detail?.title ?? '计划文档'}</span>
        </div>

        {detailLoading && (
          <div class="repl-rs-empty-center">
            <span class="repl-rs-item-icon"><IconSpinner /></span>
            <span class="repl-rs-item-meta">加载中…</span>
          </div>
        )}

        {!detailLoading && !detail && (
          <div class="repl-rs-empty-center">
            <span class="repl-rs-item-meta">无法加载该计划文档</span>
          </div>
        )}

        {!detailLoading && detail && (
          <div class="repl-rs-section">
            <div class="repl-rs-approval-detail repl-rs-mb-sm">{detail.goal}</div>
            <div class="repl-rs-approval-rule repl-rs-mb-md">
              {STATUS_LABEL[detail.status]} · v{detail.version}
            </div>

            <PlanItemGroup title="步骤" items={detail.steps as unknown as PlanItemLike[]} showDetail />
            <PlanItemGroup title="待澄清问题" items={detail.questions as unknown as PlanItemLike[]} />
            <PlanItemGroup title="风险" items={detail.risks as unknown as PlanItemLike[]} />
            <PlanItemGroup title="验收标准" items={detail.acceptance as unknown as PlanItemLike[]} />
          </div>
        )}
      </div>
    );
  }

  // ---- 列表视图 ----
  return (
    <div class="repl-rs-tab-content-inner">
      <div class="repl-rs-section-header">
        <span class="repl-rs-section-title">计划文档</span>
        <button class="repl-rs-btn-icon" title="刷新" onClick={() => void load()} disabled={loading}>
          {loading ? <IconSpinner /> : <IconRefresh />}
        </button>
      </div>

      {loading && summaries.length === 0 && (
        <div class="repl-rs-empty-center">
          <span class="repl-rs-item-icon"><IconSpinner /></span>
          <span class="repl-rs-item-meta">加载中…</span>
        </div>
      )}

      {error && (
        <div class="repl-rs-empty-inline">
          <span class="repl-rs-item-meta">{error}</span>
        </div>
      )}

      {!loading && !error && summaries.length === 0 && (
        <div class="repl-rs-empty-center">
          <span class="repl-rs-item-meta">暂无计划文档</span>
          <span class="repl-rs-item-meta repl-rs-meta-xs">智能体在执行计划任务时会在此生成</span>
        </div>
      )}

      {summaries.length > 0 && (
        <div class="repl-rs-section">
          {summaries.map((s) => {
            const { done, total } = stepProgress(s);
            const openQ = s.questions?.open?.length ?? 0;
            const openR = s.risks?.open?.length ?? 0;
            return (
              <div key={s.id} class="repl-rs-approval-card" onClick={() => void openDetail(s.id)}>
                <div class="repl-rs-approval-header">
                  <span class="repl-rs-approval-tool-name">{s.title}</span>
                  <span class="repl-rs-item-meta">{STATUS_LABEL[s.status]}</span>
                  <button
                    class="repl-rs-btn-icon repl-rs-btn-icon-end"
                    title="删除"
                    onClick={(e) => void handleDelete(s.id, e as unknown as MouseEvent)}
                    disabled={deletingId === s.id}
                  >
                    {deletingId === s.id ? <IconSpinner /> : <IconTrash />}
                  </button>
                </div>
                {s.goal && <div class="repl-rs-approval-detail">{s.goal}</div>}
                <div class="repl-rs-approval-rule">
                  {total > 0 ? `${done}/${total} 步` : '无步骤'}
                  {openQ > 0 ? ` · ${openQ} 问待答` : ''}
                  {openR > 0 ? ` · ${openR} 险未决` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// 通用条目分组：步骤 / 问题 / 风险 / 验收
function PlanItemGroup({ title, items, showDetail }: { title: string; items: PlanItemLike[] | undefined; showDetail?: boolean }) {
  if (!items || items.length === 0) return null;
  return (
    <div class="repl-rs-plan-group">
      <div class="repl-rs-plan-group-title">
        {title} <span class="repl-rs-item-meta">({items.length})</span>
      </div>
      {items.map((it) => {
        const completed = it.status === 'completed';
        return (
          <div key={it.id} class="repl-rs-plan-item">
            <span class={`repl-rs-plan-item-icon${completed ? ' done' : ''}`}>
              {completed ? <IconCheck /> : <IconChevronRight />}
            </span>
            <span class={`repl-rs-plan-item-text${completed ? ' done' : ''}`}>
              {it.title}
              {showDetail && it.detail ? <span class="repl-rs-item-meta"> — {it.detail}</span> : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
