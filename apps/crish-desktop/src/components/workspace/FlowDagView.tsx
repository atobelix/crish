/**
 * 编排图区段（T-D-12 前端侧，DAG-2）。
 *
 * DAG 只读可视化（纯 CSS/SVG 风格，零图形库依赖）：
 * - FlowDagGraph：纯展示组件——拓扑分层行渲染节点卡片（token 变量
 *   状态色 + 状态圆点，running 用旋转圆环），层间骨架连接线；
 *   空态不渲染（对齐 SecurityAuditSection 语义）；
 * - FlowDagView：自包含装配——组件可见期间轮询 get_flow_snapshot，
 *   结果经 flowDagStore 入列后订阅渲染；卸载即停（零泄漏）；
 * - 只读约束：无任何写入面；事件驱动刷新为二期增强，本期不做。
 *
 * 开关语义：useFlowDagVisible 在 RuntimePanel 装配层门控，本组件
 * 不感知开关——开关关 → 组件不挂载 → 零请求零订阅（可下线锚点）。
 */
import React, { useEffect } from 'react';
import styles from './FlowDagView.module.css';
import { RuntimeSection } from './RuntimeSection';
import { useFlowDagStore } from './flowDagStore';
import {
  buildEdges,
  dagCountLabel,
  dagEmpty,
  layerNodes,
  sanitizeDagNodes,
  stateColorVar,
  stateLabel,
  type DagNode,
} from './flowDagLayout';
import { invokeTyped } from '../../api/tauriInvoke';
import { getActiveSessionId } from '../../api/storeAccess';

/** 快照轻量轮询间隔（≥2s；首查立即执行，此后按此周期刷新） */
const FLOW_SNAPSHOT_POLL_MS = 3000;

/** 引擎只读查询命令（DAG-1 在 session_commands.rs 实现，载荷形状已冻结） */
const FLOW_SNAPSHOT_CMD = 'get_flow_snapshot';

/**
 * FlowDagGraph：编排图纯展示层（props 注入节点，便于组件单测）。
 * 空态不渲染（无节点 / 尚未获取到数据 → 整段消失）。
 */
export const FlowDagGraph: React.FC<{
  nodes: DagNode[] | null | undefined;
}> = ({ nodes }) => {
  if (dagEmpty(nodes)) return null;

  const list = nodes as DagNode[];
  const layers = layerNodes(list);
  const edges = buildEdges(list);
  const count = dagCountLabel(list);

  return (
    <RuntimeSection titleId="rt-sec-flow" title="编排图" count={count}>
      <div
        className={styles.canvas}
        role="list"
        aria-label={`编排节点图，${edges.length} 条依赖边`}
      >
        {layers.map((layer, li) => (
          <React.Fragment key={li}>
            {li > 0 ? (
              <div
                className={styles.layerConnector}
                data-testid="dag-layer-connector"
                aria-hidden
              />
            ) : null}
            <div className={styles.layer} role="presentation">
              {layer.map((n) => {
                const running = n.state === 'running';
                return (
                  <div
                    key={n.id}
                    className={`${styles.node}${
                      n.state === 'blocked' ? ` ${styles.nodeBlocked}` : ''
                    }`}
                    role="listitem"
                    data-testid="dag-node"
                    data-state={n.state}
                    data-node-id={n.id}
                  >
                    <span
                      className={`${styles.stateDot}${
                        running ? ` ${styles.stateDotSpinner}` : ''
                      }`}
                      style={
                        running
                          ? {
                              borderColor: stateColorVar(n.state),
                              backgroundColor: 'transparent',
                            }
                          : { backgroundColor: stateColorVar(n.state) }
                      }
                      data-state-dot={n.state}
                      aria-hidden
                    />
                    <span className={styles.nodeTitle} title={n.task || n.id}>
                      {n.task || n.id}
                    </span>
                    <span className={styles.nodeMeta}>
                      {stateLabel(n.state)}
                    </span>
                  </div>
                );
              })}
            </div>
          </React.Fragment>
        ))}
      </div>
    </RuntimeSection>
  );
};

/**
 * FlowDagView：编排图区段装配（数据自取）。
 *
 * 数据流（首版）：挂载即查一次快照 + 组件可见期间按
 * FLOW_SNAPSHOT_POLL_MS 轻量轮询（≥2s）；事件驱动刷新为二期增强。
 * - sessionId 每次轮询现读（getActiveSessionId），空会话跳过查询；
 * - 查询失败（missing / error）静默保持上次数据，不重试风暴；
 * - 卸载清理定时器，无事件订阅、无泄漏。
 */
export const FlowDagView: React.FC = () => {
  const nodes = useFlowDagStore((s) => s.nodes);

  useEffect(() => {
    let alive = true;

    const poll = async () => {
      const sessionId = getActiveSessionId();
      if (!sessionId?.trim()) return; // 无活动会话：跳过本轮查询
      const res = await invokeTyped<{ nodes?: DagNode[] }>(FLOW_SNAPSHOT_CMD, {
        sessionId,
      });
      if (!alive) return; // 已卸载：丢弃迟到响应
      if (res.status === 'ok') {
        useFlowDagStore
          .getState()
          .pushNodes(sanitizeDagNodes(res.data));
      }
      // missing / error：保持上次数据（首版兜底，不打扰用户）
    };

    void poll();
    const timer = setInterval(() => void poll(), FLOW_SNAPSHOT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return <FlowDagGraph nodes={nodes} />;
};
