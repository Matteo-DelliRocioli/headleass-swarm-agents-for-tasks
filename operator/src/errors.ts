// ---------------------------------------------------------------------------
// Error classification and retry logic
// ---------------------------------------------------------------------------

export interface ClassifiedError {
  retryable: boolean;
  category: string;
  message: string;
}

export function classifyError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const msg = error.message;

    // OOMKilled
    if (msg.includes("OOMKilled")) {
      return { retryable: false, category: "OOMKilled", message: msg };
    }

    // Evicted
    if (msg.includes("Evicted") || msg.includes("evict")) {
      return { retryable: true, category: "Evicted", message: msg };
    }

    // Timeout
    if (msg.includes("timeout") || msg.includes("ETIMEDOUT") || msg.includes("ESOCKETTIMEDOUT")) {
      return { retryable: true, category: "Timeout", message: msg };
    }

    // Beads CLI failure
    if (msg.includes("bd ") || msg.includes("beads")) {
      return { retryable: true, category: "BeadsFailure", message: msg };
    }

    // K8s API errors
    if (msg.includes("409") || msg.includes("Conflict")) {
      return { retryable: true, category: "K8sConflict", message: msg };
    }
    if (msg.includes("429") || msg.includes("Too Many Requests")) {
      return { retryable: true, category: "K8sRateLimited", message: msg };
    }
    if (msg.includes("500") || msg.includes("Internal Server Error")) {
      return { retryable: true, category: "K8sServerError", message: msg };
    }
    if (msg.includes("503") || msg.includes("Service Unavailable")) {
      return { retryable: true, category: "K8sUnavailable", message: msg };
    }
    if (msg.includes("401") || msg.includes("403") || msg.includes("Forbidden") || msg.includes("Unauthorized")) {
      return { retryable: false, category: "K8sAuthError", message: msg };
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return { retryable: false, category: "K8sNotFound", message: msg };
    }

    return { retryable: false, category: "Unknown", message: msg };
  }

  const message = String(error);
  return { retryable: false, category: "Unknown", message };
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries) {
        break;
      }

      const classified = classifyError(err);
      if (!classified.retryable) {
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
