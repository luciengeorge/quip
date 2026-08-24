export interface FetchCall {
  url: string;
  init: RequestInit;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
  headers?: HeadersInit;
}

export function fakeFetch(
  handler: (url: string, init: RequestInit) => FakeResponse | Promise<FakeResponse>,
): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = init ?? {};
    const url = String(input);
    calls.push({ url, init: request });
    const response = await handler(url, request);
    const body =
      response.body === undefined
        ? ""
        : typeof response.body === "string"
          ? response.body
          : JSON.stringify(response.body);
    return new Response(body, { status: response.status ?? 200, headers: response.headers });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls };
}
