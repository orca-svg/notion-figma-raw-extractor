import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ArtifactRef,
  EmitEvent,
  ExtractionEvent,
  ExtractionInput,
  McpAdapter,
  ParsedToolResult,
  StepState,
  ToolDescriptor,
} from "./types.js";

const DATA_SOURCE_RE = /collection:\/\/[0-9a-f-]{32,36}/gi;
const DISCUSSION_RE = /discussion:\/\/[^\s"'<>]+/gi;
const VIEW_URI_RE = /view:\/\/[0-9a-f-]{32,36}/gi;
const NOTION_URL_RE = /https:\/\/(?:www\.|app\.)?(?:notion\.so|notion\.com|[a-z0-9-]+\.notion\.site)\/[^\s"'<>]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/gi;
const ATTACHMENT_TAG_RE = /<(?:file|image|video|audio|pdf)\b[^>]*(?:src|source|url)="([^"]+)"[^>]*>/gi;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function parseToolResult(result: CallToolResult): ParsedToolResult {
  const text = (result.content ?? [])
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return {
    isError: result.isError === true,
    text,
    payload: safeJson(text),
    raw: result,
  };
}

function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^mcp__[^_]+__/, "")
    .replace(/^(?:notion|figma)[-_]/, "")
    .replace(/-/g, "_");
}

export function resolveTool(tools: ToolDescriptor[], canonicalName: string): string | undefined {
  return tools.find((tool) => normalizeToolName(tool.name) === canonicalName)?.name;
}

function stringCorpus(value: unknown): string {
  const strings: string[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) node.forEach(walk);
    else Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return strings.join("\n");
}

export function extractDataSourceUrls(value: unknown): string[] {
  return unique(stringCorpus(value).match(DATA_SOURCE_RE) ?? []);
}

export function extractDiscussionUrls(value: unknown): string[] {
  return unique(stringCorpus(value).match(DISCUSSION_RE) ?? []);
}

export function extractViewUrls(value: unknown, fallbackTarget?: string): string[] {
  const corpus = stringCorpus(value);
  const urls: string[] = corpus.match(VIEW_URI_RE) ?? [];
  urls.push(...(corpus.match(NOTION_URL_RE) ?? []));
  if (fallbackTarget?.includes("?v=")) urls.push(fallbackTarget);
  const normalized = urls.map((url) => url.replace(/&amp;/g, "&")).filter((url) => url.startsWith("view://") || url.includes("?v="));
  const seen = new Set<string>();
  return normalized.filter((url) => {
    let key = url;
    if (url.startsWith("view://")) key = url.slice("view://".length).replace(/-/g, "").toLowerCase();
    else {
      try {
        key = new URL(url).searchParams.get("v")?.replace(/-/g, "").toLowerCase() ?? url;
      } catch {
        key = url;
      }
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function extractAttachments(value: unknown): Array<{ kind: string; url: string }> {
  const text = stringCorpus(value);
  const found: Array<{ kind: string; url: string }> = [];
  for (const match of text.matchAll(ATTACHMENT_TAG_RE)) {
    const tag = match[0].slice(1).split(/[\s>]/)[0] ?? "file";
    found.push({ kind: tag, url: match[1] });
  }
  return found.filter((item, index) => found.findIndex((other) => other.url === item.url) === index);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractIdentity(value: unknown): {
  workspace?: Record<string, unknown>;
  user?: Record<string, unknown>;
  current_tool_access?: Record<string, unknown>;
} {
  const root = asRecord(value);
  const self = asRecord(root?.self);
  return {
    workspace: asRecord(self?.workspace),
    user: asRecord(self?.user),
    current_tool_access: asRecord(self?.current_tool_access),
  };
}

function isLikelyPageUrl(value: string): boolean {
  if (!/(notion\.so|notion\.com|notion\.site)/i.test(value)) return false;
  return /[0-9a-f]{32}/i.test(value.replace(/-/g, ""));
}

export function extractPageTargets(value: unknown): string[] {
  const targets: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    const url = typeof record.url === "string" ? record.url : undefined;
    const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
    const object = typeof record.object === "string" ? record.object.toLowerCase() : "";
    if (url && isLikelyPageUrl(url)) {
      targets.push(url);
    } else if (typeof record.id === "string" && (type === "page" || object === "page" || "properties" in record)) {
      targets.push(record.id);
    }
    Object.values(record).forEach(walk);
  };
  walk(value);
  const corpus = stringCorpus(value);
  for (const match of corpus.matchAll(/<page\b[^>]*url="([^"]+)"/gi)) targets.push(match[1]);
  return unique(targets);
}

function targetId(target: string): string {
  const matches = target.replace(/-/g, "").match(/[0-9a-f]{32}/gi);
  return matches?.[0] ?? target;
}

function getPaging(payload: unknown): { hasMore: boolean; nextCursor?: string } {
  const record = asRecord(payload);
  return {
    hasMore: record?.has_more === true,
    nextCursor: typeof record?.next_cursor === "string" ? record.next_cursor : undefined,
  };
}

function getUnknownBlocks(payload: unknown): string[] {
  const record = asRecord(payload);
  return Array.isArray(record?.unknown_block_ids)
    ? record.unknown_block_ids.filter((id): id is string => typeof id === "string")
    : [];
}

const MAX_ATTACHMENT_DOWNLOADS = 12;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** 서명 URL에는 만료 토큰이 붙어 있어 트레이스에는 쿼리스트링을 지우고 남긴다. */
export function redactSignedUrl(url: string): string {
  // data: URL은 본문 전체가 경로라 그대로 두면 트레이스가 base64로 뒤덮인다.
  if (url.startsWith("data:")) return `${url.slice(0, url.indexOf(",") + 1) || "data:"}…`;
  try {
    const parsed = new URL(url);
    return parsed.search ? `${parsed.origin}${parsed.pathname}?…` : url;
  } catch {
    return url.split("?")[0];
  }
}

function attachmentStem(url: string, kind: string): string {
  // data: URL은 본문 전체가 경로라 파일명으로 쓸 수 없다.
  if (url.startsWith("data:")) return kind;
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).pop();
    const stem = name ? decodeURIComponent(name).replace(/\.[^.]+$/, "") : "";
    return stem ? stem.slice(0, 48) : kind;
  } catch {
    return kind;
  }
}

type AttachmentDownload = { mimeType: string; bytes: number; ref?: ArtifactRef; message?: string };

// 첨부 URL은 페이지 본문에서 온 값이라 서버가 아무 주소나 따라가면 안 된다.
// 서명 URL은 https이고 인라인 이미지는 data:라, 그 둘만 허용하고 사설·loopback 대역은 막는다.
const BLOCKED_ATTACHMENT_HOSTS = /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?fd|\[?fe80:)/i;

function assertFetchableAttachmentUrl(url: string): void {
  if (url.startsWith("data:")) return;
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new Error("첨부 주소를 해석하지 못했습니다."); }
  if (parsed.protocol !== "https:") throw new Error(`https가 아닌 첨부 주소는 내려받지 않습니다. (${parsed.protocol})`);
  if (BLOCKED_ATTACHMENT_HOSTS.test(parsed.hostname)) throw new Error("사설 또는 로컬 주소의 첨부는 내려받지 않습니다.");
}

const ATTACHMENT_TIMEOUT_MS = 30_000;

async function downloadAttachment(
  attachment: { kind: string; url: string },
  sink: ArtifactSink,
  signal?: AbortSignal,
): Promise<AttachmentDownload> {
  assertFetchableAttachmentUrl(attachment.url);
  const timeout = AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS);
  const response = await fetch(attachment.url, {
    redirect: "follow",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`첨부를 받지 못했습니다. HTTP ${response.status}`);
  const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
  // 전부 버퍼링한 뒤 크기를 재면 상한이 무의미하다. 읽으면서 넘는 순간 끊는다.
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ATTACHMENT_BYTES) { overflow = true; await reader.cancel(); break; }
      chunks.push(value);
    }
  }
  if (overflow) {
    return { mimeType, bytes, message: "첨부가 25MB를 넘어 보관하지 않았습니다." };
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  const ref = sink({ data: buffer, mimeType, kind: "asset", stem: attachmentStem(attachment.url, attachment.kind) });
  return { mimeType, bytes: buffer.byteLength, ref, message: ref ? undefined : "실행 artifact 용량 상한에 걸려 보관하지 않았습니다." };
}

/** 워크스페이스 조회 응답의 형태가 연결마다 달라서, 흔한 배열 키를 훑어 개수만 세어 둔다. */
function countCollection(payload: unknown): number | undefined {
  if (Array.isArray(payload)) return payload.length;
  const record = asRecord(payload);
  if (!record) return undefined;
  for (const key of ["results", "users", "members", "teams", "teamspaces", "items"]) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length;
  }
  return undefined;
}

function readableError(parsed: ParsedToolResult): string {
  const record = asRecord(parsed.payload);
  if (typeof record?.message === "string") return record.message;
  if (typeof record?.code === "string") return record.code;
  return parsed.text.slice(0, 320) || "MCP가 오류 응답을 반환했습니다.";
}

type StepRunner = <T>(definition: {
  group: ExtractionEvent["group"];
  label: string;
  tool?: string;
  request?: unknown;
}, action: () => Promise<T>, summarize?: (value: T) => unknown, state?: (value: T) => StepState, artifactsFor?: (value: T) => ArtifactRef[] | undefined) => Promise<T | undefined>;

/** index.ts가 실행 기록에 첨부 원본을 보관할 수 있도록 넘겨주는 저장 통로. 없으면 다운로드 단계를 건너뛴다. */
export type ArtifactSink = (input: {
  data: Uint8Array;
  mimeType: string;
  kind: ArtifactRef["kind"];
  stem: string;
}) => ArtifactRef | undefined;

export async function runExtraction(adapter: McpAdapter, input: ExtractionInput, emit: EmitEvent, sink?: ArtifactSink, signal?: AbortSignal): Promise<void> {
  let order = 0;
  const finalEvents = new Map<string, ExtractionEvent>();
  const runStep: StepRunner = async (definition, action, summarize, stateFor, artifactsFor) => {
    const id = `${String(++order).padStart(2, "0")}-${definition.group}`;
    const started = performance.now();
    const base: ExtractionEvent = {
      type: "step",
      id,
      order,
      group: definition.group,
      label: definition.label,
      state: "running",
      tool: definition.tool,
      request: definition.request,
      startedAt: new Date().toISOString(),
    };
    await emit(base);
    try {
      const value = await action();
      const nextState = stateFor?.(value) ?? "success";
      const event: ExtractionEvent = {
        ...base,
        state: nextState,
        elapsedMs: Math.round(performance.now() - started),
        response: value,
        extracted: summarize?.(value),
        artifacts: artifactsFor?.(value),
      };
      finalEvents.set(id, event);
      await emit(event);
      return value;
    } catch (error) {
      const event: ExtractionEvent = {
        ...base,
        state: "error",
        elapsedMs: Math.round(performance.now() - started),
        message: error instanceof Error ? error.message : String(error),
      };
      finalEvents.set(id, event);
      await emit(event);
      return undefined;
    }
  };

  const tools = await runStep(
    { group: "discovery", label: "사용 가능한 MCP 도구 확인", tool: "tools/list" },
    () => adapter.listTools(),
    (value) => ({ count: value.length, tools: value.map((tool) => tool.name) }),
  );
  if (!tools) throw new Error("MCP 도구 목록을 읽지 못했습니다.");

  const fetchTool = resolveTool(tools, "fetch");
  const searchTool = resolveTool(tools, "search");
  const queryTool = resolveTool(tools, "query_data_sources");
  const legacyViewTool = resolveTool(tools, "query_database_view");
  const commentsTool = resolveTool(tools, "get_comments");
  const usersTool = resolveTool(tools, "get_users");
  const teamsTool = resolveTool(tools, "get_teams");
  if (!fetchTool) throw new Error("이 MCP 연결에는 fetch 도구가 없습니다.");

  const identityResult = await runStep(
    { group: "connection", label: "연결된 계정과 워크스페이스 확인", tool: fetchTool, request: { id: "self" } },
    async () => parseToolResult(await adapter.callTool(fetchTool, { id: "self" })),
    (value) => extractIdentity(value.payload),
    (value) => (value.isError ? "error" : "success"),
  );
  if (!identityResult || identityResult.isError) throw new Error("연결 계정 정보를 읽지 못했습니다.");
  const identity = extractIdentity(identityResult.payload);
  const connectedEmail = typeof identity.user?.email === "string" ? identity.user.email.toLowerCase() : "";
  const expectedEmail = input.expectedEmail?.trim().toLowerCase();
  if (expectedEmail && connectedEmail && expectedEmail !== connectedEmail) {
    const id = `${String(++order).padStart(2, "0")}-connection`;
    await emit({
      type: "fatal",
      id,
      order,
      group: "connection",
      label: "입력한 계정과 연결 계정 대조",
      state: "error",
      startedAt: new Date().toISOString(),
      extracted: { expectedEmail, connectedEmail },
      message: "입력한 이메일과 실제 Notion 연결 계정이 다릅니다. 데이터 조회를 중단했습니다.",
    });
    return;
  }

  // 대상 문서와 무관한 워크스페이스 스코프 조회라 target 단계보다 앞에 둔다.
  const workspaceSummary: { members?: number; teams?: number } = {};
  const skipWorkspace = async (label: string, message: string) => {
    const id = `${String(++order).padStart(2, "0")}-workspace`;
    await emit({ type: "step", id, order, group: "workspace", label, state: "skipped", startedAt: new Date().toISOString(), message });
  };
  if (!input.includeWorkspace) {
    await skipWorkspace("워크스페이스 멤버·팀스페이스 확인", "워크스페이스 옵션이 꺼져 있어 호출하지 않았습니다.");
  } else {
    if (usersTool) {
      const usersResult = await runStep(
        { group: "workspace", label: "워크스페이스 사용자 조회", tool: usersTool, request: {} },
        async () => parseToolResult(await adapter.callTool(usersTool, {})),
        (value) => ({ count: countCollection(value.payload), payload: value.payload }),
        (value) => (value.isError ? "error" : "success"),
      );
      if (usersResult && !usersResult.isError) workspaceSummary.members = countCollection(usersResult.payload);
    } else {
      await skipWorkspace("워크스페이스 사용자 조회", "이 연결에는 get_users 도구가 없습니다.");
    }
    if (teamsTool) {
      const teamsResult = await runStep(
        { group: "workspace", label: "팀스페이스 조회", tool: teamsTool, request: {} },
        async () => parseToolResult(await adapter.callTool(teamsTool, {})),
        (value) => ({ count: countCollection(value.payload), payload: value.payload }),
        (value) => (value.isError ? "error" : "success"),
      );
      if (teamsResult && !teamsResult.isError) workspaceSummary.teams = countCollection(teamsResult.payload);
    } else {
      await skipWorkspace("팀스페이스 조회", "이 연결에는 get_teams 도구가 없습니다.");
    }
  }

  let searchResult: ParsedToolResult | undefined;
  if (searchTool) {
    const query = input.searchQuery?.trim() || targetId(input.target);
    searchResult = await runStep(
      {
        group: "search",
        label: "워크스페이스 의미 검색",
        tool: searchTool,
        request: { query, query_type: "internal", filters: {}, page_size: 10, max_highlight_length: 500 },
      },
      async () => parseToolResult(await adapter.callTool(searchTool, {
        query,
        query_type: "internal",
        filters: {},
        page_size: 10,
        max_highlight_length: 500,
      })),
      (value) => value.payload,
      (value) => (value.isError ? "error" : "success"),
    );
  } else {
    const id = `${String(++order).padStart(2, "0")}-search`;
    await emit({ type: "step", id, order, group: "search", label: "워크스페이스 의미 검색", state: "skipped", startedAt: new Date().toISOString(), message: "이 연결에는 search 도구가 없습니다." });
  }

  const targetRequest = { id: input.target, include_discussions: true, include_transcript: input.includeTranscript };
  const targetResult = await runStep(
    { group: "target", label: "대상 페이지·데이터베이스 직접 조회", tool: fetchTool, request: targetRequest },
    async () => parseToolResult(await adapter.callTool(fetchTool, targetRequest)),
    (value) => ({
      payload: value.payload,
      dataSources: extractDataSourceUrls(value.payload),
      views: extractViewUrls(value.payload, input.target),
      discussions: extractDiscussionUrls(value.payload),
      attachments: extractAttachments(value.payload),
    }),
    (value) => (value.isError ? "error" : "success"),
  );

  if (!targetResult || targetResult.isError) {
    const message = targetResult ? readableError(targetResult) : "대상 조회가 완료되지 않았습니다.";
    for (const [group, label] of [
      ["schema", "데이터 소스 스키마 조회"],
      ["view", "뷰의 활성·보관 행 조회"],
      ["sql", "데이터 소스 SQL 조회"],
      ["page", "각 행 페이지 본문 조회"],
      ["comments", "댓글과 토론 조회"],
    ] as const) {
      const id = `${String(++order).padStart(2, "0")}-${group}`;
      await emit({ type: "step", id, order, group, label, state: "skipped", startedAt: new Date().toISOString(), message: `대상 직접 조회가 실패해 실행하지 않았습니다: ${message}` });
    }
    await emit({
      type: "complete",
      id: `${String(++order).padStart(2, "0")}-summary`,
      order,
      group: "summary",
      label: "추출 종료",
      state: "warning",
      startedAt: new Date().toISOString(),
      extracted: { toolCount: tools.length, targetAccessible: false, search: searchResult?.payload ?? null, calls: finalEvents.size },
      message: "연결은 확인했지만 대상 내용을 읽지 못했습니다.",
    });
    return;
  }

  const dataSources = extractDataSourceUrls(targetResult.payload);
  const viewUrls = extractViewUrls(targetResult.payload, input.target);
  const allQueryPayloads: unknown[] = [];
  const allPageTargets: string[] = [];
  const allAttachments = [...extractAttachments(targetResult.payload)];
  const allDiscussions = [...extractDiscussionUrls(targetResult.payload)];

  for (const blockId of getUnknownBlocks(targetResult.payload).slice(0, input.maxRows)) {
    const subtree = await runStep(
      { group: "page", label: `생략된 블록 ${blockId.slice(0, 8)} 조회`, tool: fetchTool, request: { id: blockId, include_discussions: true, include_transcript: input.includeTranscript } },
      async () => parseToolResult(await adapter.callTool(fetchTool, { id: blockId, include_discussions: true, include_transcript: input.includeTranscript })),
      (value) => value.payload,
      (value) => (value.isError ? "error" : "success"),
    );
    if (subtree && !subtree.isError) {
      allAttachments.push(...extractAttachments(subtree.payload));
      allDiscussions.push(...extractDiscussionUrls(subtree.payload));
    }
  }

  for (const dataSource of dataSources) {
    const schema = await runStep(
      { group: "schema", label: `데이터 소스 스키마 조회`, tool: fetchTool, request: { id: dataSource } },
      async () => parseToolResult(await adapter.callTool(fetchTool, { id: dataSource })),
      (value) => value.payload,
      (value) => (value.isError ? "error" : "success"),
    );
    if (schema && !schema.isError) allAttachments.push(...extractAttachments(schema.payload));
  }

  if (queryTool) {
    for (const viewUrl of viewUrls) {
      for (const archived of input.includeArchived ? [false, true] : [false]) {
        let cursor: string | undefined;
        let pageIndex = 0;
        do {
          const data: Record<string, unknown> = { mode: "view", view_url: viewUrl, is_archived: archived, page_size: Math.min(100, input.maxRows) };
          if (cursor) data.start_cursor = cursor;
          const viewResult = await runStep(
            { group: "view", label: `${archived ? "보관" : "활성"} 뷰 행 조회${pageIndex ? ` · ${pageIndex + 1}쪽` : ""}`, tool: queryTool, request: { data } },
            async () => parseToolResult(await adapter.callTool(queryTool, { data })),
            (value) => value.payload,
            (value) => (value.isError ? "error" : "success"),
          );
          if (!viewResult || viewResult.isError) break;
          allQueryPayloads.push(viewResult.payload);
          allPageTargets.push(...extractPageTargets(viewResult.payload));
          const paging = getPaging(viewResult.payload);
          cursor = paging.hasMore ? paging.nextCursor : undefined;
          pageIndex += 1;
        } while (cursor && allPageTargets.length < input.maxRows);
      }
    }
    for (const dataSource of dataSources) {
      const escapedSource = dataSource.replace(/"/g, '""');
      const data = {
        mode: "sql",
        data_source_urls: [dataSource],
        query: `SELECT * FROM "${escapedSource}" LIMIT ${input.maxRows}`,
      };
      const sqlResult = await runStep(
        { group: "sql", label: "데이터 소스 전체 속성 SQL 조회", tool: queryTool, request: { data } },
        async () => parseToolResult(await adapter.callTool(queryTool, { data })),
        (value) => value.payload,
        (value) => (value.isError ? "error" : "success"),
      );
      if (sqlResult && !sqlResult.isError) {
        allQueryPayloads.push(sqlResult.payload);
        allPageTargets.push(...extractPageTargets(sqlResult.payload));
      }
    }
  } else if (legacyViewTool && viewUrls.length) {
    for (const viewUrl of viewUrls) {
      const request = { view_url: viewUrl, is_archived: false, page_size: Math.min(100, input.maxRows) };
      const legacyResult = await runStep(
        { group: "view", label: "뷰 행 조회 · 호환 모드", tool: legacyViewTool, request },
        async () => parseToolResult(await adapter.callTool(legacyViewTool, request)),
        (value) => value.payload,
        (value) => (value.isError ? "error" : "success"),
      );
      if (legacyResult && !legacyResult.isError) allPageTargets.push(...extractPageTargets(legacyResult.payload));
    }
  }

  const rows = unique(allPageTargets).filter((target) => targetId(target) !== targetId(input.target)).slice(0, input.maxRows);
  const commentPages: string[] = [input.target];
  for (const pageTarget of rows) {
    const request = { id: pageTarget, include_discussions: input.includeComments, include_transcript: input.includeTranscript };
    const pageResult = await runStep(
      { group: "page", label: `행 페이지 ${targetId(pageTarget).slice(0, 8)} 본문 조회`, tool: fetchTool, request },
      async () => parseToolResult(await adapter.callTool(fetchTool, request)),
      (value) => ({ payload: value.payload, attachments: extractAttachments(value.payload), discussions: extractDiscussionUrls(value.payload) }),
      (value) => (value.isError ? "error" : "success"),
    );
    if (pageResult && !pageResult.isError) {
      commentPages.push(pageTarget);
      allAttachments.push(...extractAttachments(pageResult.payload));
      allDiscussions.push(...extractDiscussionUrls(pageResult.payload));
    }
  }

  if (input.includeComments && commentsTool) {
    for (const pageTarget of unique(commentPages).slice(0, input.maxRows + 1)) {
      const pageId = targetId(pageTarget);
      await runStep(
        { group: "comments", label: `페이지 ${pageId.slice(0, 8)} 댓글 조회`, tool: commentsTool, request: { page_id: pageId, include_all_blocks: true, include_resolved: true } },
        async () => parseToolResult(await adapter.callTool(commentsTool, { page_id: pageId, include_all_blocks: true, include_resolved: true })),
        (value) => value.payload,
        (value) => (value.isError ? "error" : "success"),
      );
    }
  }

  // 첨부는 만료되는 서명 URL이라 여기서 즉시 받아 실행 기록에 보관한다.
  // download_attachment는 MCP로 올린 200KiB 이하 텍스트 첨부 전용이라 페이지 이미지에는 쓸 수 없다.
  const uniqueAttachments = allAttachments.filter(
    (item, index) => allAttachments.findIndex((other) => other.url === item.url) === index,
  );
  const storedAttachments: ArtifactRef[] = [];
  if (uniqueAttachments.length && sink) {
    for (const [index, attachment] of uniqueAttachments.slice(0, MAX_ATTACHMENT_DOWNLOADS).entries()) {
      const label = `첨부 ${index + 1} 원본 내려받기`;
      const stored = await runStep(
        { group: "attachment", label, request: { url: redactSignedUrl(attachment.url), kind: attachment.kind } },
        async () => downloadAttachment(attachment, sink, signal),
        (value) => ({ kind: attachment.kind, mimeType: value.mimeType, bytes: value.bytes, stored: Boolean(value.ref) }),
        (value) => (value.ref ? "success" : "warning"),
        (value) => (value.ref ? [value.ref] : undefined),
      );
      if (stored?.ref) storedAttachments.push(stored.ref);
    }
    if (uniqueAttachments.length > MAX_ATTACHMENT_DOWNLOADS) {
      const id = `${String(++order).padStart(2, "0")}-attachment`;
      await emit({
        type: "step",
        id,
        order,
        group: "attachment",
        label: "나머지 첨부 생략",
        state: "skipped",
        startedAt: new Date().toISOString(),
        message: `첨부 ${uniqueAttachments.length}개 중 ${MAX_ATTACHMENT_DOWNLOADS}개만 내려받았습니다.`,
      });
    }
  } else if (uniqueAttachments.length) {
    const id = `${String(++order).padStart(2, "0")}-attachment`;
    await emit({
      type: "step",
      id,
      order,
      group: "attachment",
      label: "첨부 원본 내려받기",
      state: "skipped",
      startedAt: new Date().toISOString(),
      message: "이 실행에는 artifact 저장소가 없어 URL만 기록했습니다.",
    });
  }

  const finished = [...finalEvents.values()];
  await emit({
    type: "complete",
    id: `${String(++order).padStart(2, "0")}-summary`,
    order,
    group: "summary",
    label: "추출 완료",
    state: finished.some((event) => event.state === "error") ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: {
      toolCount: tools.length,
      workspaceMembers: workspaceSummary.members,
      workspaceTeams: workspaceSummary.teams,
      storedAttachments: storedAttachments.length,
      dataSources,
      views: viewUrls,
      queryResponses: allQueryPayloads.length,
      rowPages: rows.length,
      discussions: unique(allDiscussions),
      attachments: allAttachments.filter((item, index) => allAttachments.findIndex((other) => other.url === item.url) === index),
      calls: finished.length,
    },
    message: `데이터 소스 ${dataSources.length}개, 행 페이지 ${rows.length}개를 확인했습니다.`,
  });
}

export function extractUuidCandidates(value: unknown): string[] {
  return unique(stringCorpus(value).match(UUID_RE) ?? []);
}
