const executionLog = [];

export function logExecution(execution, metadata = {}) {
  executionLog.push({
    ...execution,
    metadata,
    timestamp: Date.now()
  });
}

export function getExecutionLog() {
  return executionLog;
}
