/**
 * Errors that are safe to show to clients. Anything else is reported as a
 * generic 500 with details only in the server log.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) =>
  new AppError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooLarge = (message: string) => new AppError(413, 'payload_too_large', message);
