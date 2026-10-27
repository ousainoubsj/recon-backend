// The request facts every audit entry records alongside its actor.
export function auditContext(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') ?? null };
}

// Names whose record an entry is about (entityId is opaque); the frontend's
// detailsForLog pins `subject` as the first Details line.
export function withSubject(metadata, subject) {
  const name = typeof subject?.name === 'string' ? subject.name.trim() : '';
  const code = typeof subject?.code === 'string' ? subject.code.trim() : '';
  if (!name && !code) return metadata;
  const cleaned = {};
  if (name) cleaned.name = name;
  if (code) cleaned.code = code;
  return { ...(metadata ?? {}), subject: cleaned };
}
