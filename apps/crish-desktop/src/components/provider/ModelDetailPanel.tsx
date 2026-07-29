import React from "react";
import type { ModelCap, ModelMeta } from "../../store/provider/types";
import styles from "./ModelDetailPanel.module.css";

interface ModelDetailPanelProps {
  model: ModelMeta;
}

export function ModelDetailPanel({ model }: ModelDetailPanelProps) {
  const allCapabilities = ["tool_call", "vision", "reasoning", "code_generation", "embedding", "function_calling"];

  return (
    <div className={styles.panel}>
      <div className={styles.grid}>
        <div className={styles.column}>
          <h4>Token 限制</h4>
          <div className={styles.infoRow}><label>上下文窗口</label><span>{model.contextWindow.toLocaleString()}</span></div>
          <div className={styles.infoRow}><label>最大输出</label><span>{model.maxOutputTokens.toLocaleString()}</span></div>

          <h4>定价</h4>
          {model.pricing?.map((p, i) => (
            <div key={i} className={styles.infoRow}>
              <label>{p.currency}/1K tokens</label>
              <span>输入 ${p.inputPricePer1K} / 输出 ${p.outputPricePer1K}</span>
            </div>
          ))}
          {(!model.pricing || model.pricing.length === 0) && (
            <div className={styles.infoRow}><label>无定价数据</label></div>
          )}
        </div>

        <div className={styles.column}>
          <h4>能力</h4>
          <div className={styles.capabilityGrid}>
            {allCapabilities.map(cap => {
              const enabled = model.capabilities?.includes(cap as ModelCap);
              const labels: Record<string, string> = {
                tool_call: "工具调用",
                vision: "视觉",
                reasoning: "推理",
                code_generation: "代码生成",
                embedding: "嵌入",
                function_calling: "函数调用",
              };
              return (
                <span key={cap} className={styles.capBadge} style={{ opacity: enabled ? 1 : 0.35 }}>
                  {labels[cap] ?? cap}
                </span>
              );
            })}
          </div>

          <h4>思考模式</h4>
          <div className={styles.formRow}>
            <label>启用思考</label>
            <input type="checkbox" checked={model.thinkingConfig?.enabled ?? false} readOnly />
          </div>
          {model.thinkingConfig?.enabled && (
            <>
              <div className={styles.formRow}>
                <label>Effort</label>
                <select value={model.thinkingConfig.effort}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>
              <div className={styles.formRow}>
                <label>显示思考过程</label>
                <input type="checkbox" checked={model.thinkingConfig.displayThinking} readOnly />
              </div>
            </>
          )}

          <h4>版本</h4>
          <div className={styles.infoRow}><label>别名</label><span>{model.aliases?.join(", ") ?? "无"}</span></div>
          {model.releasedAt && <div className={styles.infoRow}><label>发布</label><span>{model.releasedAt}</span></div>}
          {model.isDeprecated && <div className={styles.deprecatedBadge}>已弃用</div>}
        </div>
      </div>
    </div>
  );
}
