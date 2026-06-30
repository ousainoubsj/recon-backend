// Error classes per spec Section 9 (Error Handling Strategy).
// Each maps to an HTTP status and gets serialised as RFC 7807 by
// globalErrorHandler in app.js.

export class AppError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {string} type
   * @param {{field: string, message: string}[]} [fieldErrors]
   */
  constructor(message, status, type, fieldErrors) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.type = type;
    this.fieldErrors = fieldErrors;
  }
}

export class ValidationError extends AppError {
  constructor(message, fieldErrors) {
    super(message, 422, 'https://recon.app/errors/validation-error', fieldErrors);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Missing, expired, or invalid session cookie') {
    super(message, 401, 'https://recon.app/errors/authentication-error');
  }
}

export class AuthorisationError extends AppError {
  constructor(message = 'Valid session but insufficient role') {
    super(message, 403, 'https://recon.app/errors/authorisation-error');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found or does not belong to user') {
    super(message, 404, 'https://recon.app/errors/not-found');
  }
}

export class FileTooLargeError extends AppError {
  constructor(message = 'File exceeds 50 MB limit') {
    super(message, 413, 'https://recon.app/errors/file-too-large');
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'https://recon.app/errors/conflict');
  }
}
