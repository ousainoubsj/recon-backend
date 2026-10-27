import { NotFoundError, ValidationError } from '../errors.js';

/**
 * Per-route Zod schema; returns 422 with structured field errors on failure.
 * @param {import('zod').ZodSchema} schema
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const fieldErrors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(new ValidationError('Request body failed validation', fieldErrors));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Route-param counterpart of validate(). A malformed id names no resource, so it's a 404 rather than a
 * 422, and it never reaches Prisma, which rejects a non-UUID with an unmapped P2007 (a 500).
 * @param {import('zod').ZodSchema} schema
 */
export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) return next(new NotFoundError());
    req.params = result.data;
    next();
  };
}
