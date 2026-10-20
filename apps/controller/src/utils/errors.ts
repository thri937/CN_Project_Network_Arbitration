import { ErrorCode } from '@/constants/errorCodes';

/**
 * Application error taxonomy.
 *
 * Every error crossing the HTTP boundary is normalised into an `AppError` by
 * `middleware/errorHandler.ts`. Two properties matter:
 *
 *  - `isOperational` — true for expected, handled conditions (bad input, missing record).
 *    False for programmer errors and unexpected failures, which are logged at `error`
 *    level with a full stack and reported to the operator as a generic message.
 *
 *  - `details` — structured, *safe to expose* context. Never put raw datastore errors,
 *    credentials, or internal paths here.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly isOperational: boolean;
  public readonly details?: unknown;

  constructor(
    message: string,
    statusCode: number,
    code: ErrorCode,
    options: { isOperational?: boolean; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = options.isOperational ?? true;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details?: unknown) {
    super(message, 400, ErrorCode.VALIDATION_FAILED, { details });
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Authentication required', code: ErrorCode = ErrorCode.UNAUTHENTICATED) {
    super(message, 401, code);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action', details?: unknown) {
    super(message, 403, ErrorCode.FORBIDDEN, { details });
  }
}

export class InsufficientRoleError extends AppError {
  constructor(required: string, actual: string) {
    super(
      `This operation requires the ${required} role`,
      403,
      ErrorCode.INSUFFICIENT_ROLE,
      { details: { required, actual } },
    );
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(
      id ? `${resource} '${id}' was not found` : `${resource} was not found`,
      404,
      ErrorCode.NOT_FOUND,
      { details: { resource, ...(id ? { id } : {}) } },
    );
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code: ErrorCode = ErrorCode.CONFLICT, details?: unknown) {
    super(message, 409, code, { details });
  }
}

export class AlreadyExistsError extends ConflictError {
  constructor(resource: string, field: string, value: string) {
    super(`${resource} with ${field} '${value}' already exists`, ErrorCode.ALREADY_EXISTS, {
      resource,
      field,
      value,
    });
  }
}

export class ResourceInUseError extends ConflictError {
  constructor(resource: string, id: string, usedBy: string, count: number) {
    super(
      `${resource} '${id}' cannot be removed because ${count} ${usedBy} still reference it`,
      ErrorCode.RESOURCE_IN_USE,
      { resource, id, usedBy, count },
    );
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(entity: string, from: string, to: string) {
    super(
      `${entity} cannot transition from ${from} to ${to}`,
      400,
      ErrorCode.INVALID_STATE_TRANSITION,
      { details: { entity, from, to } },
    );
  }
}

export class PolicyViolationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, ErrorCode.POLICY_VIOLATION, { details });
  }
}

export class CapacityExceededError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, ErrorCode.CAPACITY_EXCEEDED, { details });
  }
}

export class ArbitrationInfeasibleError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 422, ErrorCode.ARBITRATION_INFEASIBLE, { details });
  }
}

export class DatastoreError extends AppError {
  constructor(operation: string, cause?: unknown) {
    super(`Datastore operation failed: ${operation}`, 503, ErrorCode.DATASTORE_UNAVAILABLE, {
      isOperational: false,
      cause,
      details: { operation },
    });
  }
}

export class TelemetryUnavailableError extends AppError {
  constructor(provider: string, cause?: unknown) {
    super(
      `Telemetry provider '${provider}' is unavailable`,
      503,
      ErrorCode.TELEMETRY_UNAVAILABLE,
      { isOperational: false, cause, details: { provider } },
    );
  }
}

export class NotImplementedError extends AppError {
  constructor(feature: string) {
    super(`${feature} is not implemented in this deployment`, 501, ErrorCode.NOT_IMPLEMENTED, {
      details: { feature },
    });
  }
}

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred', cause?: unknown) {
    super(message, 500, ErrorCode.INTERNAL_ERROR, { isOperational: false, cause });
  }
}

/** Type guard used by the error middleware and by tests. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Normalise any thrown value into an `AppError`. Express handlers can throw anything —
 * a string, a Firestore error, a `TypeError`. Exactly one place converts them.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new InternalError(value.message, value);
  }
  return new InternalError('An unexpected error occurred', value);
}
