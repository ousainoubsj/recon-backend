import { ValidationError } from '../errors.js';

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
