// Clamps an optional ?limit=/?months= query param to a sane positive
// integer, or returns undefined if absent/invalid (caller falls back to
// its own default).
export function parsePositiveInt(value, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return max ? Math.min(n, max) : n;
}
