import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const server = createServer();
const wss = new WebSocketServer({ server });

const activeConnections = new Set();
const pendingApprovals = new Map();
const activeSubagents = new Map();

wss.on('connection', (ws) => {
  activeConnections.add(ws);

  ws.on('message', (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      handleMessage(ws, msg);
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: err.message }));
    }
  });

  ws.on('close', () => {
    activeConnections.delete(ws);
  });
});

function handleMessage(ws, msg) {
  const { type, runId, toolCallId, subagentRunId, prompt, message, correlationId } = msg;
  const correlate = (obj) => (correlationId ? { ...obj, correlationId } : obj);

  switch (type) {
    case 'ping':
      ws.send(JSON.stringify(correlate({ type: 'pong', timestamp: Date.now() })));
      break;

    case 'run-task':
      if (prompt && prompt.includes('trigger-approval')) {
        ws.send(JSON.stringify(correlate({ type: 'run-started', runId })));
        const targetToolCallId = toolCallId || 'call-approve-1';
        pendingApprovals.set(targetToolCallId, { ws, runId });
        ws.send(
          JSON.stringify(
            correlate({
              type: 'approval-requested',
              runId,
              toolCallId: targetToolCallId,
              toolName: 'execute_sensitive_command',
              input: { command: 'sudo rm -rf /var/log' },
              summary: 'Requires admin permission to delete system logs',
              timeoutMs: 30000,
              expiresAt: Date.now() + 30000,
              remainingMs: 30000,
              risk: 'high',
            })
          )
        );
      } else if (prompt && prompt.includes('trigger-subagent')) {
        const targetSubagentRunId = subagentRunId || 'sub-run-100';
        activeSubagents.set(targetSubagentRunId, { status: 'running', runId });

        ws.send(JSON.stringify(correlate({ type: 'run-started', runId })));
        ws.send(
          JSON.stringify(
            correlate({
              type: 'subagent-started',
              runId,
              subagentId: 'sub-1',
              subagentRunId: targetSubagentRunId,
              parentToolCallId: 'tool-sub-1',
              description: 'Child agent task execution',
              mode: 'standard',
            })
          )
        );
        ws.send(
          JSON.stringify(
            correlate({
              type: 'subagent-event',
              runId,
              subagentId: 'sub-1',
              subagentRunId: targetSubagentRunId,
              parentToolCallId: 'tool-sub-1',
              event: { type: 'agent-chunk', text: 'Subagent processing subtask...' },
            })
          )
        );
      } else {
        ws.send(JSON.stringify(correlate({ type: 'run-started', runId })));
        ws.send(
          JSON.stringify(
            correlate({
              type: 'stream-chunk',
              runId,
              chunk: `Processing task: ${prompt}`,
            })
          )
        );
        ws.send(
          JSON.stringify(
            correlate({
              type: 'run-completed',
              runId,
              status: 'completed',
              result: 'Task executed successfully',
            })
          )
        );
      }
      break;

    case 'approve-tool': {
      const pending = pendingApprovals.get(toolCallId);
      ws.send(
        JSON.stringify(
          correlate({
            type: 'approval-resolved',
            toolCallId,
            decision: 'approved',
            reason: 'user-approved',
          })
        )
      );
      if (pending) {
        pendingApprovals.delete(toolCallId);
        pending.ws.send(
          JSON.stringify(
            correlate({
              type: 'stream-chunk',
              runId: pending.runId,
              chunk: 'Approved action executed.',
            })
          )
        );
        pending.ws.send(
          JSON.stringify(
            correlate({
              type: 'run-completed',
              runId: pending.runId,
              status: 'completed',
            })
          )
        );
      }
      break;
    }

    case 'deny-tool': {
      const pending = pendingApprovals.get(toolCallId);
      ws.send(
        JSON.stringify(
          correlate({
            type: 'approval-resolved',
            toolCallId,
            decision: 'denied',
            reason: 'user-denied',
          })
        )
      );
      if (pending) {
        pendingApprovals.delete(toolCallId);
        pending.ws.send(
          JSON.stringify(
            correlate({
              type: 'run-completed',
              runId: pending.runId,
              status: 'failed',
              error: 'User denied permission',
            })
          )
        );
      }
      break;
    }

    case 'send-to-subagent': {
      const subagent = activeSubagents.get(subagentRunId);
      ws.send(
        JSON.stringify(
          correlate({
            type: 'subagent-message-sent',
            subagentRunId,
            accepted: !!subagent,
          })
        )
      );
      if (subagent) {
        ws.send(
          JSON.stringify(
            correlate({
              type: 'subagent-ended',
              runId: subagent.runId,
              subagentId: 'sub-1',
              subagentRunId,
              parentToolCallId: 'tool-sub-1',
              status: 'completed',
              summary: `Finished processing: ${message}`,
            })
          )
        );
        ws.send(
          JSON.stringify(
            correlate({
              type: 'run-completed',
              runId: subagent.runId,
              status: 'completed',
            })
          )
        );
        activeSubagents.delete(subagentRunId);
      }
      break;
    }

    case 'get-subagent-status': {
      const subagent = activeSubagents.get(subagentRunId);
      ws.send(
        JSON.stringify(
          correlate({
            type: 'subagent-status',
            subagentRunId,
            status: subagent ? subagent.status : 'completed',
            activeCount: subagent ? 1 : 0,
          })
        )
      );
      break;
    }

    default:
      ws.send(
        JSON.stringify(
          correlate({
            type: 'error',
            code: 'UNKNOWN_MESSAGE_TYPE',
            message: `Unhandled type: ${type}`,
          })
        )
      );
      break;
  }
}

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(JSON.stringify({ type: 'daemon-ready', port, pid: process.pid, protocolVersion: '0.1.0' }));
});

process.on('SIGTERM', () => {
  server.close(() => {
    process.exit(0);
  });
});
