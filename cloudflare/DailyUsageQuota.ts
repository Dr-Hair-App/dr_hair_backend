/// <reference path="../worker-configuration.d.ts" />
import { DurableObject } from "cloudflare:workers";

type WorkerEnv = Env;

type UsageResult = {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string;
};

/** Serializes a single user's daily usage counter without putting every user
 * through one global coordinator. The per-user object stores only a count. */
export class DailyUsageQuota extends DurableObject<WorkerEnv> {
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS daily_usage (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          usage_date TEXT NOT NULL,
          request_count INTEGER NOT NULL CHECK (request_count >= 0)
        )
      `);
    });
  }

  consume(date: string, limit: number, resetAt: string): UsageResult {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Invalid quota date.");
    const safeLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 1)));
    const rows = this.ctx.storage.sql.exec<{ request_count: number }>(
      `INSERT INTO daily_usage (singleton, usage_date, request_count)
       VALUES (1, ?, 1)
       ON CONFLICT(singleton) DO UPDATE SET
         usage_date = excluded.usage_date,
         request_count = CASE
           WHEN daily_usage.usage_date = excluded.usage_date THEN daily_usage.request_count + 1
           ELSE 1
         END
       WHERE daily_usage.usage_date <> excluded.usage_date
          OR daily_usage.request_count < ?
       RETURNING request_count`,
      date,
      safeLimit,
    ).toArray();

    const row = rows[0];
    const nextDate = new Date(resetAt);
    if (Number.isNaN(nextDate.getTime())) throw new TypeError("Invalid quota reset time.");
    const used = row?.request_count ?? safeLimit;
    return {
      allowed: Boolean(row),
      used,
      limit: safeLimit,
      remaining: Math.max(0, safeLimit - used),
      resetAt: nextDate.toISOString(),
    };
  }
}
