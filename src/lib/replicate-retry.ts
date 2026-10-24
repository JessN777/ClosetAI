const MAX_ATTEMPTS = 3;

export function isRetryableReplicateError(error: unknown) {
  let current: unknown = error;
  const visited = new Set<unknown>();

  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const value = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };

    const status = typeof value.response?.status === "number"
      ? value.response.status
      : typeof value.status === "number"
        ? value.status
        : typeof value.statusCode === "number"
          ? value.statusCode
          : null;
    if (status !== null) return status >= 500 && status <= 599;

    const code = typeof value.code === "string" ? value.code : "";
    if (/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|UND_ERR_CONNECT|UND_ERR_SOCKET)$/i.test(code)) {
      return true;
    }

    const message = typeof value.message === "string" ? value.message : "";
    if (/fetch failed|failed to fetch|network error|socket hang up|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|UND_ERR_CONNECT|UND_ERR_SOCKET/i.test(message)) {
      return true;
    }
    if (value.name === "TimeoutError") return true;
    current = value.cause;
  }

  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withReplicateRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1 || !isRetryableReplicateError(error)) throw error;
      await sleep(250 * 2 ** attempt);
    }
  }

  throw new Error("Replicate request failed after retries.");
}
