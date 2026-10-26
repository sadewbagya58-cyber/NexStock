import type { ErrorCode, ProblemDetails } from '@nexstock/contracts';

export class AppError extends Error {
  readonly statusCode: number;
  readonly errorCode: ErrorCode;
  readonly title: string;
  readonly typeUri: string;
  readonly extensions?: Record<string, unknown> | undefined;

  constructor(params: {
    statusCode: number;
    errorCode: ErrorCode;
    title: string;
    detail: string;
    typeUri?: string;
    extensions?: Record<string, unknown>;
  }) {
    super(params.detail);
    this.name = 'AppError';
    this.statusCode = params.statusCode;
    this.errorCode = params.errorCode;
    this.title = params.title;
    this.typeUri =
      params.typeUri ??
      `https://api.nexstock.io/errors/${params.errorCode.toLowerCase().replace(/_/g, '-')}`;
    this.extensions = params.extensions;
  }

  toProblemDetails(traceId: string, instance?: string): ProblemDetails {
    return {
      type: this.typeUri,
      title: this.title,
      status: this.statusCode,
      detail: this.message,
      ...(instance ? { instance } : {}),
      errorCode: this.errorCode,
      traceId,
      ...(this.extensions ? { extensions: this.extensions } : {}),
    };
  }
}

export class SecurityConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityConfigurationError';
  }
}
