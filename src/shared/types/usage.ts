import { z } from 'zod'

/**
 * Fixed trailing window for the activity heatmap, independent of the range
 * toggle. 52 weeks × 7 days = a full GitHub-style year grid (52 columns).
 */
export const HEATMAP_DAYS = 364

export const ModelUsageSchema = z.object({
  model: z.string(),
  tokens: z.number().int().nonnegative(),
  pct: z.number().nonnegative(),
})
export type ModelUsage = z.infer<typeof ModelUsageSchema>

export const DayBucketSchema = z.object({
  date: z.string(), // 'YYYY-MM-DD' in local time
  tokens: z.number().int().nonnegative(),
})
export type DayBucket = z.infer<typeof DayBucketSchema>

// Per-day, per-model token total (long/sparse format — only non-zero rows).
// The renderer pivots this against `daily`'s date axis into a multi-line chart.
export const DayModelBucketSchema = z.object({
  date: z.string(), // 'YYYY-MM-DD' in local time
  model: z.string(),
  tokens: z.number().int().nonnegative(),
})
export type DayModelBucket = z.infer<typeof DayModelBucketSchema>

export const UsageRangeSchema = z.union([z.literal(7), z.literal(30)])
export type UsageRange = z.infer<typeof UsageRangeSchema>

export const UsageStatsSchema = z.object({
  rangeDays: UsageRangeSchema,
  totals: z.object({
    tokens: z.number().int().nonnegative(),
    /** Sum of cache-hit (read) tokens across tasks in range. */
    cacheRead: z.number().int().nonnegative(),
    usdCents: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
    currentStreak: z.number().int().nonnegative(),
    topModel: ModelUsageSchema.nullable(),
  }),
  daily: z.array(DayBucketSchema),
  dailyByModel: z.array(DayModelBucketSchema),
  byModel: z.array(ModelUsageSchema),
  heatmap: z.array(DayBucketSchema),
})
export type UsageStats = z.infer<typeof UsageStatsSchema>
