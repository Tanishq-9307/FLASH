// Usage percentages (owner requirement 2026-11-24): the meters show
// usage as a percentage of the configured limit, never a hard block.
// Pure helper so the header chip and the Usage panel agree on the
// number. Returns null when the limit is not a positive number — the
// caller then shows no percentage instead of dividing by zero.
export function usagePercent(usage: number, cap: number): number | null {
  if (!Number.isFinite(usage) || !Number.isFinite(cap) || cap <= 0 || usage < 0) {
    return null;
  }
  return Math.round((usage / cap) * 100);
}
