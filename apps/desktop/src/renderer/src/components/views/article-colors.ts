// Deterministic per-site tint, shared by the article grid card and the detail
// panel's cover thumbnail. Extracted into its own module so the two components
// don't import from each other (no circular dependency).

const SITE_PALETTE = [
  'bg-violet-500/15 text-violet-600',
  'bg-sky-500/15 text-sky-600',
  'bg-emerald-500/15 text-emerald-600',
  'bg-amber-500/15 text-amber-600',
  'bg-rose-500/15 text-rose-600',
]

// Hash the siteName to a stable palette index so a given site always renders
// the same tint. Empty/unknown sites fall back to the first palette entry (violet).
export function colorForSite(siteName: string | null): string {
  if (!siteName) return SITE_PALETTE[0]
  let h = 0
  for (let i = 0; i < siteName.length; i++) h = (h * 31 + siteName.charCodeAt(i)) >>> 0
  return SITE_PALETTE[h % SITE_PALETTE.length]
}
