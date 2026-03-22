type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function emit(
  level: LogLevel,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;

  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (metadata !== undefined && Object.keys(metadata).length > 0) {
    entry.metadata = metadata;
  }

  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (message: string, metadata?: Record<string, unknown>) =>
    emit("debug", message, metadata),
  info: (message: string, metadata?: Record<string, unknown>) =>
    emit("info", message, metadata),
  warn: (message: string, metadata?: Record<string, unknown>) =>
    emit("warn", message, metadata),
  error: (message: string, metadata?: Record<string, unknown>) =>
    emit("error", message, metadata),
};
