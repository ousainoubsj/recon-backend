/**
 * Wraps async route handlers so a rejected promise reaches Express's error
 * pipeline automatically, instead of every handler needing its own
 * try/catch + next(err).
 * @param {Function} fn - Async route handler (req, res, next)
 * @returns {Function} Wrapped handler
 */
export const catchAsync = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
