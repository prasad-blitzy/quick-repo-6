/**
 * Centralized Axios HTTP Client Configuration
 *
 * Configures and exports a pre-configured Axios instance as the single HTTP
 * client for the entire React frontend dashboard. All API hooks in
 * `../hooks/` consume this client or the typed helper functions it provides.
 *
 * Features:
 * - Base URL `/api` — Vite proxy forwards to Express backend in development
 * - 15-second request timeout for financial data endpoints
 * - Request interceptor for JSON content-type enforcement
 * - Response interceptor for centralized error handling (network + API errors)
 * - Typed helper functions (apiGet, apiPost, apiPut, apiDelete)
 * - AbortController / AbortSignal support for cancellable requests
 * - No authentication headers (single-operator dashboard per AAP §0.6.2)
 *
 * @module apps/web/src/lib/api-client
 */

import axios from 'axios';
import type {
  AxiosError,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import type { ApiResponse } from '@trading-intelligence/types';

// ---------------------------------------------------------------------------
// Re-export the ApiResponse type for consumer convenience
// ---------------------------------------------------------------------------

export type { ApiResponse } from '@trading-intelligence/types';

// ---------------------------------------------------------------------------
// Axios Instance — Centralized HTTP Client
// ---------------------------------------------------------------------------

/**
 * Pre-configured Axios instance used by all frontend API communication.
 *
 * Configuration:
 * - `baseURL: '/api'` — All requests are prefixed with `/api`.
 *   In development the Vite dev server proxies `/api/*` to the Express
 *   backend at `http://localhost:3000`. In production (Vercel) API calls
 *   route to the separate backend deployment.
 * - `timeout: 15_000` — 15-second timeout; reasonable for financial data
 *   endpoints that may aggregate multiple upstream sources.
 * - Default `Content-Type` and `Accept` headers set to `application/json`.
 * - No authentication headers — the dashboard is a single-operator tool
 *   without user accounts (AAP §0.6.2).
 */
const apiClient: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 15_000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

// ---------------------------------------------------------------------------
// Request Interceptor — Content-Type Enforcement
// ---------------------------------------------------------------------------

/**
 * Ensures that outgoing requests carrying a body always include the
 * `Content-Type: application/json` header. This guards against edge cases
 * where a consumer calls `apiClient.post()` with a body but omits headers.
 *
 * No authentication token injection is required — the dashboard has no
 * auth system (AAP §0.6.2).
 */
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig): InternalAxiosRequestConfig => {
    if (config.data && !config.headers.get('Content-Type')) {
      config.headers.set('Content-Type', 'application/json');
    }
    return config;
  },
  (error: AxiosError): Promise<never> => {
    return Promise.reject(error);
  },
);

// ---------------------------------------------------------------------------
// Response Interceptor — Centralized Error Handling
// ---------------------------------------------------------------------------

/**
 * Normalises all Axios errors into standard `Error` instances so that
 * downstream hooks and components receive a consistent error shape.
 *
 * Handles two categories:
 * 1. **Network errors** — `error.response` is `undefined` when the server
 *    is unreachable (DNS failure, timeout, CORS block, etc.).
 * 2. **API errors** — The server responded with an HTTP error status.
 *    The error message is extracted from the `ApiResponse` envelope fields
 *    (`error`, then `message`) with a fallback to Axios's own message.
 */
apiClient.interceptors.response.use(
  (response: AxiosResponse): AxiosResponse => {
    return response;
  },
  (error: AxiosError<ApiResponse<unknown>>): Promise<never> => {
    // Case 1: Network-level failure — no response received at all
    if (!error.response) {
      const networkError = new Error(
        'Network error: Unable to reach the server',
      );
      return Promise.reject(networkError);
    }

    // Case 2: Server responded with an error status code
    const apiError = error.response.data;
    const message =
      apiError.error ?? apiError.message ?? error.message;
    return Promise.reject(new Error(message));
  },
);

// ---------------------------------------------------------------------------
// Typed Helper Functions — AbortSignal-Aware
// ---------------------------------------------------------------------------

/**
 * Typed GET request helper.
 *
 * Unwraps the Axios response and returns the `ApiResponse<T>` body directly
 * so consumers avoid the double-`.data` access pattern.
 *
 * @typeParam T - The expected payload type inside `ApiResponse.data`.
 * @param url    - Endpoint path relative to `/api` (e.g., `'/news'`).
 * @param params - Optional query string parameters.
 * @param signal - Optional `AbortSignal` for request cancellation on unmount.
 * @returns The deserialised `ApiResponse<T>` body.
 *
 * @example
 * ```typescript
 * const { data } = await apiGet<NewsArticle[]>('/news', { page: 1, limit: 20 });
 * ```
 */
export async function apiGet<T>(
  url: string,
  params?: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const response = await apiClient.get<ApiResponse<T>>(url, {
    params,
    ...(signal != null ? { signal } : {}),
  });
  return response.data;
}

/**
 * Typed POST request helper.
 *
 * @typeParam T - The expected payload type inside `ApiResponse.data`.
 * @param url    - Endpoint path relative to `/api`.
 * @param data   - Request body (serialised as JSON automatically).
 * @param signal - Optional `AbortSignal` for request cancellation.
 * @returns The deserialised `ApiResponse<T>` body.
 */
export async function apiPost<T>(
  url: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const response = await apiClient.post<ApiResponse<T>>(url, data, {
    ...(signal != null ? { signal } : {}),
  });
  return response.data;
}

/**
 * Typed PUT request helper.
 *
 * @typeParam T - The expected payload type inside `ApiResponse.data`.
 * @param url    - Endpoint path relative to `/api`.
 * @param data   - Request body (serialised as JSON automatically).
 * @param signal - Optional `AbortSignal` for request cancellation.
 * @returns The deserialised `ApiResponse<T>` body.
 */
export async function apiPut<T>(
  url: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const response = await apiClient.put<ApiResponse<T>>(url, data, {
    ...(signal != null ? { signal } : {}),
  });
  return response.data;
}

/**
 * Typed DELETE request helper.
 *
 * @typeParam T - The expected payload type inside `ApiResponse.data`.
 * @param url    - Endpoint path relative to `/api`.
 * @param signal - Optional `AbortSignal` for request cancellation.
 * @returns The deserialised `ApiResponse<T>` body.
 */
export async function apiDelete<T>(
  url: string,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const response = await apiClient.delete<ApiResponse<T>>(url, {
    ...(signal != null ? { signal } : {}),
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Default Export — Raw Axios Instance
// ---------------------------------------------------------------------------

export default apiClient;
