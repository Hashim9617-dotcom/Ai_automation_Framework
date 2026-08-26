import type { APIRequestContext, APIResponse } from '@playwright/test';
import { rootLogger, redactSecrets } from '@aitp/shared';

export interface ApiCallOptions {
  headers?: Record<string, string>;
  params?: Record<string, string | number | boolean>;
  data?: unknown;
  /** Fail the call when the status is outside this list. Empty = never throw. */
  expectStatus?: number[];
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T;
  headers: Record<string, string>;
  durationMs: number;
}

/**
 * Thin wrapper over Playwright's APIRequestContext used for API-layer tests and,
 * more importantly, for backend validation inside UI tests (the AI Command Box
 * flow validates API + DB state after driving the UI).
 */
export class ApiClient {
  private readonly log = rootLogger.child('api');
  private authHeader?: string;

  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
  ) {}

  withBearer(token: string): this {
    this.authHeader = `Bearer ${token}`;
    return this;
  }

  get<T>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
    return this.call<T>('GET', path, options);
  }
  post<T>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
    return this.call<T>('POST', path, options);
  }
  put<T>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
    return this.call<T>('PUT', path, options);
  }
  patch<T>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
    return this.call<T>('PATCH', path, options);
  }
  delete<T>(path: string, options?: ApiCallOptions): Promise<ApiResult<T>> {
    return this.call<T>('DELETE', path, options);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: ApiCallOptions = {},
  ): Promise<ApiResult<T>> {
    const url = new URL(path, this.baseUrl).toString();
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    if (this.authHeader) headers.authorization = this.authHeader;

    const startedAt = Date.now();
    const response: APIResponse = await this.request.fetch(url, {
      method,
      headers,
      params: options.params,
      data: options.data as never,
    });
    const durationMs = Date.now() - startedAt;

    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response — keep the raw text */
    }

    this.log.info(`${method} ${url}`, {
      status: response.status(),
      durationMs,
      request: redactSecrets(options.data),
    });

    if (options.expectStatus?.length && !options.expectStatus.includes(response.status())) {
      throw new Error(
        `${method} ${url} returned ${response.status()}, expected one of ${options.expectStatus.join(', ')}. Body: ${text.slice(0, 500)}`,
      );
    }

    return {
      status: response.status(),
      ok: response.ok(),
      body: body as T,
      headers: response.headers(),
      durationMs,
    };
  }
}
