import type {
  ConnectionStatus,
  CodexAuthFlow,
  ExtractionEvent,
  ExtractionOptions,
  FigmaConnectionStatus,
  FigmaExtractionOptions,
  FigmaRunPayload,
  PluginPairing,
  FigmaTransport,
  Provider,
  SlackConnectionStatus,
  SlackExtractionOptions,
  SlackImportResult,
} from "./types";

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `요청 실패 (${response.status})`);
  return payload;
}

let csrfTokenPromise: Promise<string> | undefined;
async function csrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch("/api/session", { credentials: "same-origin", cache: "no-store" })
    .then((response) => readJson<{ csrfToken: string }>(response))
    .then((payload) => payload.csrfToken)
    .catch((error) => { csrfTokenPromise = undefined; throw error; });
  return csrfTokenPromise;
}

// 서버 세션은 메모리에만 있어서 재시작 한 번이면 사라진다. 그때 캐시된 토큰을 계속 보내면
// 열려 있던 탭은 새로고침 전까지 모든 요청이 403이 된다. 403을 만나면 토큰을 다시 받아 한 번 재시도한다.
async function mutate(endpoint: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const send = async (token: string) =>
    fetch(endpoint, { ...init, credentials: "same-origin", headers: { ...init.headers, "X-MCP-Trace-CSRF": token } });
  const response = await send(await csrfToken());
  if (response.status !== 403) return response;
  csrfTokenPromise = undefined;
  return send(await csrfToken());
}

async function streamNdjson(
  endpoint: string,
  body: unknown,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await mutate(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const payload = (await response.json()) as { message?: string };
    throw new Error(payload.message ?? `추출 요청 실패 (${response.status})`);
  }
  if (!response.body) throw new Error("서버가 진행 스트림을 보내지 않았습니다.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as ExtractionEvent);
    if (done) break;
  }
  if (pending.trim()) onEvent(JSON.parse(pending) as ExtractionEvent);
}

export async function getStatus(): Promise<ConnectionStatus> {
  const response = await fetch("/api/notion/status", { credentials: "same-origin" });
  return readJson<ConnectionStatus>(response);
}

export async function startOAuth(expectedEmail: string): Promise<string> {
  const response = await mutate("/api/notion/auth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail }),
  });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function connectPat(expectedEmail: string, token: string): Promise<ConnectionStatus> {
  const response = await mutate("/api/notion/auth/pat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedEmail, token }),
  });
  return readJson<ConnectionStatus>(response);
}

export async function disconnect(): Promise<void> {
  const response = await mutate("/api/notion/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("Notion 연결 해제에 실패했습니다.");
}

export function streamExtraction(
  options: ExtractionOptions,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/notion/extract/stream", options, onEvent, signal);
}

export async function getFigmaStatus(transport: FigmaTransport): Promise<FigmaConnectionStatus> {
  const response = await fetch(`/api/figma/status?transport=${transport}`, { credentials: "same-origin" });
  return readJson<FigmaConnectionStatus>(response);
}

export async function startFigmaOAuth(): Promise<string> {
  const response = await mutate("/api/figma/auth/start", { method: "POST" });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function disconnectFigmaRemote(): Promise<void> {
  const response = await mutate("/api/figma/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("Figma Remote 연결 해제에 실패했습니다.");
}

export async function startPluginPairing(): Promise<PluginPairing> {
  const response = await mutate("/api/figma/plugin/pair/start", { method: "POST" });
  return readJson<PluginPairing>(response);
}

export async function disconnectFigmaPlugin(): Promise<void> {
  const response = await mutate("/api/figma/plugin/disconnect", { method: "POST" });
  if (!response.ok) throw new Error("Figma Plugin 연결 해제에 실패했습니다.");
}

export async function startFigmaRestOAuth(): Promise<string> {
  const response = await mutate("/api/figma/rest/auth/start", { method: "POST" });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function connectFigmaRestPat(token: string): Promise<void> {
  const response = await mutate("/api/figma/rest/auth/pat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  await readJson<{ connected: boolean }>(response);
}

export async function disconnectFigmaRest(): Promise<void> {
  const response = await mutate("/api/figma/rest/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("Figma REST 연결 해제에 실패했습니다.");
}

export async function startCodexLogin(): Promise<CodexAuthFlow> {
  const response = await mutate("/api/figma/codex/auth/start", { method: "POST" });
  return (await readJson<{ flow: CodexAuthFlow }>(response)).flow;
}

export async function startCodexFigmaOAuth(): Promise<CodexAuthFlow> {
  const response = await mutate("/api/figma/codex/figma/start", { method: "POST" });
  return (await readJson<{ flow: CodexAuthFlow }>(response)).flow;
}

export async function cancelCodexAuth(): Promise<void> {
  const response = await mutate("/api/figma/codex/auth/cancel", { method: "POST" });
  if (!response.ok) throw new Error("Codex 인증 취소에 실패했습니다.");
}

export function streamFigmaExtraction(
  options: FigmaExtractionOptions,
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/figma/extract/stream", options, onEvent, signal);
}

export function streamFigmaQuestion(
  options: FigmaExtractionOptions & { question: string },
  onEvent: (event: ExtractionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamNdjson("/api/figma/questions/stream", options, onEvent, signal);
}

export async function getSlackStatus(): Promise<SlackConnectionStatus> {
  const response = await fetch("/api/slack/status", { credentials: "same-origin" });
  return readJson<SlackConnectionStatus>(response);
}

export async function startSlackOAuth(): Promise<string> {
  const response = await mutate("/api/slack/auth/start", { method: "POST" });
  return (await readJson<{ authUrl: string }>(response)).authUrl;
}

export async function disconnectSlack(): Promise<void> {
  const response = await mutate("/api/slack/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error("Slack 연결 해제에 실패했습니다.");
}

export async function uploadSlackExport(file: File): Promise<SlackImportResult> {
  const response = await mutate("/api/slack/imports", {
    method: "POST",
    headers: { "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(file.name) },
    body: file,
  });
  return readJson<SlackImportResult>(response);
}

export function streamSlackImport(importId: string, onEvent: (event: ExtractionEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamNdjson(`/api/slack/imports/${encodeURIComponent(importId)}/extract/stream`, {}, onEvent, signal);
}

export function streamSlackExtraction(options: SlackExtractionOptions, onEvent: (event: ExtractionEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamNdjson("/api/slack/extract/stream", options, onEvent, signal);
}

export async function getRun(provider: Provider, runId: string): Promise<FigmaRunPayload> {
  const response = await fetch(`/api/${provider}/runs/${encodeURIComponent(runId)}`, { credentials: "same-origin" });
  return readJson<FigmaRunPayload>(response);
}
