export class ApiRequestError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function apiFetch<T>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
  } catch {
    // Browsers report a dropped connection as e.g. "Load failed" (Safari).
    throw new ApiRequestError("网络连接中断或请求超时，请检查网络后重试。", 0);
  }

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok) {
    throw new ApiRequestError(
      data?.error || `请求失败（${response.status}）`,
      response.status,
      data?.code,
    );
  }
  return data as T;
}
