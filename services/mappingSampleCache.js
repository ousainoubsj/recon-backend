// Caches getMappingPreview's bounded row sample in Redis rather than as a
// Postgres JSON column on the Report row. That column used to hold the full
// sample (every column, up to SAMPLE_ROW_CAP rows) — for a wide source file
// (e.g. 92 columns) that grows to several MB. Postgres itself reads a value
// that size in well under a second (confirmed directly against this exact
// column), but *transferring* it back to the app on every debounced
// rule-preview call while the user adjusts sliders/mappings was the actual
// bottleneck. Redis reads are sub-millisecond regardless of payload size, so
// repeated reads during a mapping session stop paying any transfer cost.
import { redis } from '../config/redis.config.js';

// Long enough to cover a realistic mapping session (someone stepping away
// and coming back later shouldn't lose the cache mid-session), short enough
// that an abandoned draft's sample doesn't sit in Redis indefinitely.
const TTL_SECONDS = 24 * 60 * 60;

function cacheKey(reportId, side) {
  return `mapping-sample:${reportId}:${side}`;
}

export async function setSampleRows(reportId, side, rows) {
  await redis.set(cacheKey(reportId, side), JSON.stringify(rows), 'EX', TTL_SECONDS);
}

export async function getSampleRows(reportId, side) {
  const raw = await redis.get(cacheKey(reportId, side));
  return raw ? JSON.parse(raw) : null;
}

// Called once a run completes (persistCompletedRun) — the sample has no
// further use once the real result exists, so this frees the cache
// immediately rather than waiting out the TTL.
export async function clearSampleRows(reportId) {
  await redis.del(cacheKey(reportId, 'A'), cacheKey(reportId, 'B'));
}
