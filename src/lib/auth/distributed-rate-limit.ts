import { resolveDbClient } from "@/lib/db-client";

export async function consumeDistributedRateLimit(input: {
  key: string; limit: number; windowMs: number;
}): Promise<boolean> {
  const now = Date.now();
  const row = await resolveDbClient().get<{ count: number }>(
    `insert into distributed_rate_limits (limiter_key, request_count, window_started_at, window_ends_at)
     values (?, 1, ?, ?)
     on conflict (limiter_key) do update set
       request_count = case when distributed_rate_limits.window_ends_at <= excluded.window_started_at
         then 1 else distributed_rate_limits.request_count + 1 end,
       window_started_at = case when distributed_rate_limits.window_ends_at <= excluded.window_started_at
         then excluded.window_started_at else distributed_rate_limits.window_started_at end,
       window_ends_at = case when distributed_rate_limits.window_ends_at <= excluded.window_started_at
         then excluded.window_ends_at else distributed_rate_limits.window_ends_at end
     returning request_count as count`,
    [input.key, now, now + input.windowMs],
  );
  return !!row && Number(row.count) <= input.limit;
}
