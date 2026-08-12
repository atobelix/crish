import React from 'react';
import styles from './OverviewCard.module.css';
import { Button, Tooltip } from '../ui';
import { Bot, ChevronDown } from 'lucide-react';
import { openAgentInSidePanel } from '../../api/openAgentPanel';
import { agentOneLineLabel, agentStatusLabel } from './helpers';
import type { SessionAgent } from '../../store/types';

interface AgentSectionProps {
  open: boolean;
  agents: SessionAgent[];
  runningAgentCount: number;
  activeSessionId: string | undefined;
  onToggle: () => void;
}

export const AgentSection = React.memo(function AgentSection({
  open,
  agents,
  runningAgentCount,
  activeSessionId,
  onToggle,
}: AgentSectionProps) {
  const sortedAgents = React.useMemo(() => {
    return [...agents].sort((a, b) => {
      const ar = a.status === 'running' ? 0 : 1;
      const br = b.status === 'running' ? 0 : 1;
      if (ar !== br) return ar - br;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });
  }, [agents]);

  return (
    <section className={styles.sec} aria-labelledby="overview-sec-agents">
      <button
        type="button"
        id="overview-sec-agents"
        className={styles.secH}
        aria-expanded={open}
        aria-controls="overview-sec-agents-b"
        onClick={onToggle}
      >
        <Bot size={15} strokeWidth={1.75} aria-hidden />
        <span>协作体</span>
        {sortedAgents.length > 0 ? (
          <span className={styles.pill}>
            {runningAgentCount > 0
              ? `${runningAgentCount} 运行`
              : sortedAgents.length}
          </span>
        ) : null}
        <ChevronDown
          size={14}
          className={`${styles.chev} ${open ? styles.open : ''}`}
          aria-hidden
        />
      </button>
      {open ? (
        <div className={styles.secB} id="overview-sec-agents-b">
          {sortedAgents.length > 0 ? (
            <ul
              className={`${styles.list} ${styles['list--agents']}`}
              aria-label="协作体列表"
            >
              {sortedAgents.map((a) => {
                const name = agentOneLineLabel(a.description, a.id);
                const st = agentStatusLabel(a.status);
                return (
                  <li key={a.id}>
                    <Tooltip content={name}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={`${styles.itemBtn} ${styles['itemBtn--agent']}`}
                        aria-label={`${name}，${st}`}
                        onClick={() => {
                          openAgentInSidePanel(a.id, {
                            sessionId: activeSessionId || undefined,
                          });
                        }}
                      >
                        <span
                          className={`${styles.dot} ${a.status === 'running' ? styles.live : ''}`}
                          aria-hidden="true"
                        />
                        <span className={styles.itemMain}>
                          <span className={styles.itemName}>{name}</span>
                          <em>{st}</em>
                        </span>
                      </Button>
                    </Tooltip>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className={`${styles.empty} ${styles.emptyQuiet}`} role="status">
              无
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
});
