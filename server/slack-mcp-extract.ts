import { parseToolResult } from "./extract.js";
import { storeArtifact } from "./run-store.js";
import type {
  EmitEvent,
  ExtractionEvent,
  McpAdapter,
  SlackFileRef,
  SlackNormalizedExport,
  SlackNormalizedMessage,
  SlackRunRecord,
  ToolDescriptor,
} from "./types.js";

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/^mcp__[^_]+__/, "").replace(/[-.]/g, "_");
}

function resolveByKeywords(tools: ToolDescriptor[], exact: string[], keywords: string[]): ToolDescriptor | undefined {
  for (const name of exact) {
    const found = tools.find((tool) => normalizedName(tool.name) === name);
    if (found) return found;
  }
  return tools.find((tool) => {
    const corpus = `${normalizedName(tool.name)} ${tool.description ?? ""}`.toLowerCase();
    return keywords.every((keyword) => corpus.includes(keyword));
  });
}

function inputProperties(tool: ToolDescriptor): Set<string> | undefined {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === "object" && !Array.isArray(properties)
    ? new Set(Object.keys(properties as Record<string, unknown>))
    : undefined;
}

function argsFor(tool: ToolDescriptor, values: Record<string, unknown>): Record<string, unknown> {
  const allowed = inputProperties(tool);
  if (!allowed) return values;
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => allowed.has(key) && value !== undefined && value !== ""));
}

export function parseSlackConversationTarget(value: string): { id?: string; url?: string } {
  const target = value.trim();
  if (!target) throw new Error("Slack 채널 또는 대화 URL을 입력해 주세요.");
  if (/^[CDG][A-Z0-9]+$/i.test(target)) return { id: target.toUpperCase() };
  try {
    const url = new URL(target);
    if (!/(^|\.)slack\.com$/i.test(url.hostname)) throw new Error("Slack URL이 아닙니다.");
    const id = url.pathname.match(/\/archives\/([A-Z0-9]+)/i)?.[1]?.toUpperCase();
    return { id, url: url.toString() };
  } catch (error) {
    if (error instanceof Error && error.message === "Slack URL이 아닙니다.") throw error;
    throw new Error("Slack 채널 ID 또는 slack.com 대화 URL을 입력해 주세요.");
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function findMessageArrays(value: unknown, found: unknown[][] = []): unknown[][] {
  if (Array.isArray(value)) {
    if (value.some((item) => {
      const candidate = record(item);
      return candidate && (typeof candidate.ts === "string" || typeof candidate.text === "string");
    })) found.push(value);
    else value.forEach((item) => findMessageArrays(item, found));
    return found;
  }
  const item = record(value);
  if (item) Object.values(item).forEach((child) => findMessageArrays(child, found));
  return found;
}

function normalizeMcpMessages(payload: unknown, conversationId: string): { messages: SlackNormalizedMessage[]; files: SlackFileRef[] } {
  const arrays = findMessageArrays(payload);
  const messages = new Map<string, SlackNormalizedMessage>();
  const files = new Map<string, SlackFileRef>();
  for (const values of arrays) {
    for (const raw of values) {
      const item = record(raw);
      if (!item) continue;
      const ts = typeof item.ts === "string" ? item.ts : "";
      if (!ts) continue;
      const rawFiles = Array.isArray(item.files) ? item.files : [];
      const fileIds: string[] = [];
      for (const [index, rawFile] of rawFiles.entries()) {
        const file = record(rawFile) ?? {};
        const id = typeof file.id === "string" ? file.id : `${conversationId}:${ts}:${index}`;
        fileIds.push(id);
        files.set(id, {
          id,
          name: typeof file.name === "string" ? file.name : undefined,
          title: typeof file.title === "string" ? file.title : undefined,
          mimeType: typeof file.mimetype === "string" ? file.mimetype : undefined,
          url: typeof file.url_private_download === "string" ? file.url_private_download : typeof file.url_private === "string" ? file.url_private : undefined,
          permalink: typeof file.permalink === "string" ? file.permalink : undefined,
          conversationId,
          messageTs: ts,
          raw: rawFile,
        });
      }
      messages.set(ts, {
        conversationId,
        ts,
        userId: typeof item.user === "string" ? item.user : undefined,
        author: typeof record(item.user_profile)?.display_name === "string" ? String(record(item.user_profile)?.display_name) : undefined,
        text: typeof item.text === "string" ? item.text : "",
        subtype: typeof item.subtype === "string" ? item.subtype : undefined,
        threadTs: typeof item.thread_ts === "string" ? item.thread_ts : undefined,
        edited: item.edited,
        reactions: item.reactions,
        files: fileIds,
        raw,
      });
    }
  }
  return { messages: [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts)), files: [...files.values()] };
}

export async function runSlackMcpExtraction(
  adapter: McpAdapter,
  run: SlackRunRecord,
  emit: EmitEvent,
): Promise<void> {
  let order = 0;
  const publish = (event: ExtractionEvent) => emit({ ...event, provider: "slack", runId: run.id, origin: event.tool ? "mcp" : "internal" });
  const tools = await adapter.listTools();
  run.tools = tools;
  await publish({
    type: "step",
    id: "01-discovery",
    order: ++order,
    group: "discovery",
    label: "Slack MCP Tool 확인",
    state: "success",
    tool: "tools/list",
    startedAt: new Date().toISOString(),
    response: tools,
    extracted: { count: tools.length, tools: tools.map((tool) => tool.name) },
  });
  const historyTool = resolveByKeywords(
    tools,
    ["conversations_history", "slack_conversations_history", "read_channel", "get_channel_history"],
    ["history"],
  );
  if (!historyTool) throw new Error("이 Slack MCP 연결에는 채널 기록을 읽는 Tool이 없습니다.");
  const repliesTool = resolveByKeywords(
    tools,
    ["conversations_replies", "slack_conversations_replies", "read_thread", "get_thread_replies"],
    ["repl"],
  );
  const target = parseSlackConversationTarget(run.input.target ?? "");
  const requestValues = {
    channel: target.id,
    channel_id: target.id,
    conversation_id: target.id,
    channel_url: target.url,
    url: target.url,
    target: target.url ?? target.id,
    oldest: run.input.oldest,
    latest: run.input.latest,
    limit: 200,
  };
  const historyArgs = argsFor(historyTool, requestValues);
  const historyStarted = performance.now();
  await publish({
    type: "step",
    id: "02-history",
    order: ++order,
    group: "history",
    label: "인증 사용자 범위의 Slack 대화 조회",
    state: "running",
    tool: historyTool.name,
    request: historyArgs,
    startedAt: new Date().toISOString(),
  });
  const history = parseToolResult(await adapter.callTool(historyTool.name, historyArgs));
  if (history.isError) throw new Error(history.text || "Slack 대화 조회에 실패했습니다.");
  const conversationId = target.id ?? "slack-conversation";
  const normalized = normalizeMcpMessages(history.payload, conversationId);
  await publish({
    type: "step",
    id: "02-history",
    order,
    group: "history",
    label: "인증 사용자 범위의 Slack 대화 조회",
    state: "success",
    tool: historyTool.name,
    request: historyArgs,
    response: history.payload,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - historyStarted),
    extracted: { messages: normalized.messages.length, files: normalized.files.length },
  });

  if (repliesTool) {
    const roots = normalized.messages.filter((message) => message.threadTs === message.ts || Number((record(message.raw)?.reply_count)) > 0).slice(0, 50);
    for (const root of roots) {
      const values = {
        ...requestValues,
        ts: root.ts,
        thread_ts: root.ts,
        message_ts: root.ts,
      };
      const args = argsFor(repliesTool, values);
      const parsed = parseToolResult(await adapter.callTool(repliesTool.name, args));
      if (parsed.isError) continue;
      const replies = normalizeMcpMessages(parsed.payload, conversationId);
      for (const message of replies.messages) {
        if (!normalized.messages.some((candidate) => candidate.ts === message.ts)) normalized.messages.push(message);
      }
      for (const file of replies.files) if (!normalized.files.some((candidate) => candidate.id === file.id)) normalized.files.push(file);
    }
    normalized.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
    await publish({
      type: "step",
      id: "03-replies",
      order: ++order,
      group: "replies",
      label: "Slack 스레드 답글 조회",
      state: "success",
      tool: repliesTool.name,
      startedAt: new Date().toISOString(),
      extracted: { messages: normalized.messages.length, roots: roots.length },
    });
  } else {
    await publish({
      type: "step",
      id: "03-replies",
      order: ++order,
      group: "replies",
      label: "Slack 스레드 답글 조회",
      state: "skipped",
      startedAt: new Date().toISOString(),
      message: "이 Slack MCP 연결에는 스레드 답글 Tool이 없습니다.",
    });
  }

  if (run.input.includeFiles && normalized.files.length) {
    const fileTool = resolveByKeywords(tools, ["read_file", "download_file", "slack_read_file"], ["file", "read"]);
    if (!fileTool) {
      await publish({
        type: "step",
        id: "04-files",
        order: ++order,
        group: "files",
        label: "Slack 첨부 파일 읽기",
        state: "skipped",
        startedAt: new Date().toISOString(),
        message: "이 Slack MCP 연결에는 파일 원문을 읽는 Tool이 없습니다. files/index.json에 링크와 metadata만 남깁니다.",
      });
    } else {
      let stored = 0;
      for (const file of normalized.files.slice(0, 20)) {
        const args = argsFor(fileTool, { file_id: file.id, id: file.id, url: file.url ?? file.permalink });
        const raw = await adapter.callTool(fileTool.name, args);
        for (const block of raw.content ?? []) {
          if (block.type !== "image" && block.type !== "audio" && block.type !== "resource") continue;
          const encoded = block.type === "resource" && "blob" in block.resource ? block.resource.blob : "data" in block ? block.data : undefined;
          if (typeof encoded !== "string") continue;
          const mimeType = block.type === "resource" ? block.resource.mimeType ?? file.mimeType ?? "application/octet-stream" : block.mimeType;
          const data = new Uint8Array(Buffer.from(encoded, "base64"));
          const ref = storeArtifact(run, { data, mimeType, kind: mimeType.startsWith("image/") ? "asset" : "binary", stem: file.name ?? file.id });
          if (ref) { file.artifactPath = ref.path; stored += 1; }
          break;
        }
      }
      await publish({
        type: "step",
        id: "04-files",
        order: ++order,
        group: "files",
        label: "Slack 첨부 파일 읽기",
        state: stored === normalized.files.length ? "success" : "warning",
        tool: fileTool.name,
        startedAt: new Date().toISOString(),
        extracted: { candidates: normalized.files.length, stored },
        message: stored < normalized.files.length ? "일부 파일은 MCP 응답에 바이너리가 없거나 접근 권한이 없어 metadata만 남겼습니다." : undefined,
      });
    }
  }

  const result: SlackNormalizedExport = {
    schemaVersion: 1,
    source: "slack_mcp",
    importedAt: new Date().toISOString(),
    users: [],
    conversations: [{
      id: conversationId,
      name: target.url ?? conversationId,
      kind: conversationId.startsWith("D") ? "dm" : conversationId.startsWith("G") ? "private_channel" : "public_channel",
      members: [],
      raw: target,
    }],
    messages: normalized.messages,
    files: normalized.files,
    provenance: {
      endpoint: "https://mcp.slack.com/mcp",
      access: "authenticated_user_visible_conversations_only",
      target,
      note: "조직 전체 DM Export가 아닙니다.",
    },
  };
  run.normalized = result;
  await publish({
    type: "complete",
    id: "05-summary",
    order: ++order,
    group: "summary",
    label: "Slack MCP 추출 완료",
    state: "success",
    startedAt: new Date().toISOString(),
    extracted: { messages: result.messages.length, files: result.files.length, target },
    message: "인증 사용자가 접근 가능한 대화만 정규화했습니다.",
  });
}
