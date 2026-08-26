import { redactSecrets } from './utils/redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  scope: string;
  level?: LogLevel;
  /** JSON lines are what the dashboard's live-log stream consumes in Phase 3. */
  json?: boolean;
}

export class Logger {
  private readonly scope: string;
  private readonly level: LogLevel;
  private readonly json: boolean;

  constructor(options: LoggerOptions) {
    this.scope = options.scope;
    this.level = options.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
    this.json = options.json ?? process.env.LOG_FORMAT === 'json';
  }

  child(scope: string): Logger {
    return new Logger({ scope: `${this.scope}:${scope}`, level: this.level, json: this.json });
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.write('error', message, meta);
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const safeMeta = meta ? (redactSecrets(meta) as Record<string, unknown>) : undefined;
    const timestamp = new Date().toISOString();

    if (this.json) {
      process.stdout.write(
        `${JSON.stringify({ timestamp, level, scope: this.scope, message, ...safeMeta })}\n`,
      );
      return;
    }
    const suffix = safeMeta && Object.keys(safeMeta).length ? ` ${JSON.stringify(safeMeta)}` : '';
    process.stdout.write(
      `${timestamp} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${message}${suffix}\n`,
    );
  }
}

export const rootLogger = new Logger({ scope: 'aitp' });
