/** 统一错误响应，格式与 OpenAI 兼容，便于下游 SDK 直接解析 */

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string | null;
  readonly param: string | null;

  constructor(
    status: number,
    message: string,
    type = 'invalid_request_error',
    code: string | null = null,
    param: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.param = param;
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export const unauthorized = (message = '未提供有效的 API Key'): ApiError =>
  new ApiError(401, message, 'invalid_request_error', 'invalid_api_key');

export const forbidden = (message: string): ApiError =>
  new ApiError(403, message, 'permission_error', 'forbidden');

export const badRequest = (message: string, param: string | null = null): ApiError =>
  new ApiError(400, message, 'invalid_request_error', null, param);

export const notFound = (message: string): ApiError =>
  new ApiError(404, message, 'invalid_request_error', 'not_found');

export const conflict = (message: string): ApiError =>
  new ApiError(409, message, 'invalid_request_error', 'conflict');

export const quotaExceeded = (message: string): ApiError =>
  new ApiError(429, message, 'insufficient_quota', 'insufficient_quota');

export const rateLimited = (message: string): ApiError =>
  new ApiError(429, message, 'rate_limit_exceeded', 'rate_limit_exceeded');

export const upstreamError = (message: string, status = 502): ApiError =>
  new ApiError(status, message, 'api_error', 'upstream_error');

/**
 * 客户端主动断开连接。
 *
 * 与上游故障严格区分：这类中断不计入渠道失败、不触发换渠道重试，也不该熔断渠道。
 * 499 是 nginx 约定的「客户端关闭请求」状态码。
 */
export const clientClosed = (): ApiError =>
  new ApiError(499, '客户端已断开连接', 'api_error', 'client_closed_request');

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(err.toBody(), { status: err.status });
  }
  // 非 ApiError 一律是内部故障：只回通用错误，细节留在日志与用量明细里，不向调用方泄漏
  console.error('[internal]', err);
  return Response.json(
    { error: { message: '服务器内部错误', type: 'api_error', param: null, code: 'internal_error' } },
    { status: 500 },
  );
}
