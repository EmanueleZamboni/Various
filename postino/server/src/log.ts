import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(config.logLevel as Level) in order ? (config.logLevel as Level) : 'info'];

function write(level: Level, ctx: unknown, msg?: string): void {
  if (order[level] < min) return;
  const time = new Date().toISOString();
  const data = typeof ctx === 'string' ? { msg: ctx } : { ...(ctx as object), msg };
  const line = `${time} ${level.toUpperCase().padEnd(5)} ${JSON.stringify(data)}`;
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (ctx: unknown, msg?: string) => write('debug', ctx, msg),
  info: (ctx: unknown, msg?: string) => write('info', ctx, msg),
  warn: (ctx: unknown, msg?: string) => write('warn', ctx, msg),
  error: (ctx: unknown, msg?: string) => write('error', ctx, msg),
};
