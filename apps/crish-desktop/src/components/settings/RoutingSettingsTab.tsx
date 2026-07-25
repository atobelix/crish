import React, { useState } from "react";
import { Plus, Trash2, GripVertical } from "lucide-react";
import type { ModelRoute, TaskType, ModelRole } from "../../store/provider/types";
import styles from "./RoutingSettingsTab.module.css";

const DEFAULT_ROLES: ModelRole[] = ["primary", "fast", "editor", "embedding"];
const DEFAULT_TASKS: TaskType[] = ["chat", "code", "planning", "vision", "embedding", "tool_use"];

export function RoutingSettingsTab() {
  const [routes, setRoutes] = useState<ModelRoute[]>([]);

  const addRoute = () => {
    const newRoute: ModelRoute = {
      id: `route-${Date.now()}`,
      role: "primary",
      taskTypes: [],
      providerId: "",
      modelId: "",
      priority: 10,
      fallbackChain: [],
      enabled: true,
    };
    setRoutes([...routes, newRoute]);
  };

  return (
    <div className={styles.routingSettingsTab}>
      <div className={styles.tabHeader}>
        <h2>路由规则</h2>
        <button className="settings-btn-primary" onClick={addRoute}>
          <Plus size={16} /> 添加规则
        </button>
      </div>

      <p className={styles.tabDescription}>
        配置不同任务类型使用的模型角色。当主模型失败时，会按回退链逐级降级。
      </p>

      <div className={styles.routeList}>
        {routes.map((route) => (
          <div key={route.id} className={styles.routeCard}>
            <div className={styles.routeCardHeader}>
              <GripVertical size={16} className={styles.dragHandle} />
              <span className={styles.routeRoleBadge} data-role={route.role}>{route.role}</span>
              <input
                type="text"
                className={styles.routeProviderSelect}
                placeholder="选择 Provider..."
                value={route.providerId}
                onChange={(e) => {
                  const newRoutes = routes.map(r => r.id === route.id ? { ...r, providerId: e.target.value } : r);
                  setRoutes(newRoutes);
                }}
              />
              <span className={styles.routeSeparator}>/</span>
              <input
                type="text"
                className={styles.routeModelSelect}
                placeholder="选择模型..."
                value={route.modelId}
                onChange={(e) => {
                  const newRoutes = routes.map(r => r.id === route.id ? { ...r, modelId: e.target.value } : r);
                  setRoutes(newRoutes);
                }}
              />
              <div className={styles.routeTaskTags}>
                {DEFAULT_TASKS.map(task => (
                  <label key={task} className={`${styles.taskTag} ${route.taskTypes.includes(task) ? styles.active : ''}`}>
                    <input
                      type="checkbox"
                      checked={route.taskTypes.includes(task)}
                      onChange={() => {
                        const newTasks = route.taskTypes.includes(task)
                          ? route.taskTypes.filter(t => t !== task)
                          : [...route.taskTypes, task];
                        const newRoutes = routes.map(r => r.id === route.id ? { ...r, taskTypes: newTasks } : r);
                        setRoutes(newRoutes);
                      }}
                    />
                    {task}
                  </label>
                ))}
              </div>
              <input
                type="number"
                className={styles.routePriority}
                value={route.priority}
                title="优先级（越高越优先）"
                onChange={(e) => {
                  const newRoutes = routes.map(r => r.id === route.id ? { ...r, priority: parseInt(e.target.value) || 0 } : r);
                  setRoutes(newRoutes);
                }}
              />
              <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setRoutes(routes.filter(r => r.id !== route.id))}>
                <Trash2 size={14} />
              </button>
            </div>

            <div className={styles.routeFallbackChain}>
              <span className={styles.fallbackLabel}>回退:</span>
              {route.fallbackChain.map((rule, i) => (
                <span key={i} className={styles.fallbackRule}>
                  {rule.errorType} → {rule.fallbackProviderId}/{rule.fallbackModelId ?? "*"}
                </span>
              ))}
              <button className="ui-btn ui-btn-ghost ui-btn-xs">+ 添加回退</button>
            </div>
          </div>
        ))}

        {routes.length === 0 && (
          <div className={styles.routeListEmpty}>
            暂无路由规则。点击"添加规则"开始配置。
            <p className={styles.hint}>
              提示：如果未配置路由规则，系统将使用默认选择策略。
            </p>
          </div>
        )}
      </div>

      <div className={styles.costOverview}>
        <h3>成本概览</h3>
        <div className={styles.costBar}>
          <div className={styles.costBarFill} style={{ width: "25%" }} />
          <span className={styles.costLabel}>$12.50 / $50.00 本月</span>
        </div>
        <div className={styles.formRow}>
          <label>月预算上限</label>
          <input type="number" defaultValue={50} /> USD
        </div>
      </div>
    </div>
  );
}
