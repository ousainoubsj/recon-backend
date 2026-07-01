import { AppError } from '../errors.js';

// Operational errors (AppError subclasses) -> RFC 7807. Anything else is a
// programmer error: logged, never leaked to the client, 500.
export function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({
      type: err.type,
      title: err.name,
      status: err.status,
      detail: err.message,
      instance: req.originalUrl,
      ...(err.fieldErrors ? { errors: err.fieldErrors } : {}),
    });
  }

  req.log?.error(err);
  res.status(500).json({
    type: 'https://recon.app/errors/internal-error',
    title: 'InternalError',
    status: 500,
    detail: 'An unexpected error occurred',
    instance: req.originalUrl,
  });
}
