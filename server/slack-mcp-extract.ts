import { parseToolResult } from "./extract.js";
import { normalizeUsers } from "./slack-export.js";
import { storeArtifact } from "./run-store.js";
import type {
  EmitEvent,
  ExtractionEvent,
  McpAdapter,
  SlackFileRef,
  SlackNormalizedExport,
  SlackNormalizedMessage,
  SlackRunRecord,
  SlackUser,
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

export function normalizeSlackMessages(payload: unknown, conversationId: string): { messages: SlackNormalizedMessage[]; files: SlackFileRef[] } {
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

/** 200개씩 받아 10만 메시지. 서버가 커서를 끝없이 돌려주는 경우를 대비한 안전선이다. */
const MAX_PAGES = 500;

/**
 * Slack은 response_metadata.next_cursor로 페이지를 잇는다. MCP 서버마다 그 응답을 감싸는
 * 모양이 달라 위치를 고정할 수 없으므로 찾아서 쓴다.
 */
function findNextCursor(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNextCursor(child);
      if (found) return found;
    }
    return undefined;
  }
  const item = record(value);
  if (!item) return undefined;
  const direct = record(item.response_metadata)?.next_cursor ?? item.next_cursor;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const child of Object.values(item)) {
    const found = findNextCursor(child);
    if (found) return found;
  }
  return undefined;
}

type PagedResult = { payloads: unknown[]; pages: number; truncated: boolean };

/**
 * 커서를 끝까지 따라간다. 한 번만 부르면 limit을 넘는 채널이 잘린 줄도 모르고 잘린다.
 * 더 갈 수 있는데 멈춘 경우에만 truncated를 세워, 원래 그만큼인 것과 구분한다.
 */
async function collectPages(
  adapter: McpAdapter,
  tool: ToolDescriptor,
  values: Record<string, unknown>,
): Promise<PagedResult> {
  const properties = inputProperties(tool);
  // 스키마를 알 수 없으면 일단 넘겨 본다. 서버가 커서를 돌려주지 않으면 어차피 한 바퀴로 끝난다.
  const supportsCursor = properties ? properties.has("cursor") : true;
  const payloads: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const parsed = parseToolResult(await adapter.callTool(tool.name, argsFor(tool, { ...values, cursor })));
    if (parsed.isError) {
      if (pages === 0) throw new Error(parsed.text || "Slack 대화 조회에 실패했습니다.");
      // 첫 장을 이미 받았다면 부분 결과라도 넘긴다. 다만 완주하지 못했음을 남긴다.
      return { payloads, pages, truncated: true };
    }
    payloads.push(parsed.payload);
    pages += 1;
    const next = supportsCursor ? findNextCursor(parsed.payload) : undefined;
    if (!next) return { payloads, pages, truncated: false };
    // 같은 커서가 다시 오면 서버가 페이지를 넘기지 못하는 것이다. 무한 루프로 들어가지 않는다.
    if (seen.has(next)) return { payloads, pages, truncated: true };
    seen.add(next);
    cursor = next;
    if (pages >= MAX_PAGES) return { payloads, pages, truncated: true };
  }
}

/** 페이지마다 나눠 온 결과를 ts와 file id 기준으로 합친다. */
export function createAccumulator() {
  const messages = new Map<string, SlackNormalizedMessage>();
  const files = new Map<string, SlackFileRef>();
  return {
    add(part: { messages: SlackNormalizedMessage[]; files: SlackFileRef[] }): void {
      for (const message of part.messages) if (!messages.has(message.ts)) messages.set(message.ts, message);
      for (const file of part.files) if (!files.has(file.id)) files.set(file.id, file);
    },
    get messageCount(): number { return messages.size; },
    result(): { messages: SlackNormalizedMessage[]; files: SlackFileRef[] } {
      return {
        messages: [...messages.values()].sort((a, b) => Number(a.ts) - Number(b.ts)),
        files: [...files.values()],
      };
    },
  };
}

/**
 * 응답 어디에 있든 Slack user 객체를 찾는다. users.list는 배열로, users.info는 단일 객체로 주고
 * MCP 서버마다 그 위에 씌우는 껍데기가 달라 위치를 고정할 수 없다.
 * id와 name만으로 판별하면 첨부 파일 객체가 사용자로 잡히므로 profile·real_name·team_id를 함께 본다.
 */
function findUserRecords(value: unknown, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    value.forEach((item) => findUserRecords(item, found));
    return found;
  }
  const item = record(value);
  if (!item) return found;
  if (typeof item.id === "string" && (record(item.profile) !== undefined || typeof item.real_name === "string" || typeof item.team_id === "string")) {
    found.push(item);
    return found;
  }
  Object.values(item).forEach((child) => findUserRecords(child, found));
  return found;
}

export function usersFromPayloads(payloads: unknown[]): SlackUser[] {
  const byId = new Map<string, SlackUser>();
  for (const payload of payloads) {
    for (const user of normalizeUsers(findUserRecords(payload))) {
      if (user.id !== "unknown" && !byId.has(user.id)) byId.set(user.id, user);
    }
  }
  return [...byId.values()];
}

/**
 * 메시지에 실려 온 user_profile만으로 만든 최소 매핑. 사용자 조회 Tool이 없을 때의 마지막 수단이다.
 */
export function usersFromMessages(messages: SlackNormalizedMessage[]): SlackUser[] {
  const byId = new Map<string, SlackUser>();
  for (const message of messages) {
    if (!message.userId || byId.has(message.userId)) continue;
    const profile = record(record(message.raw)?.user_profile);
    if (!profile) continue;
    byId.set(message.userId, {
      id: message.userId,
      name: typeof profile.name === "string" ? profile.name : undefined,
      realName: typeof profile.real_name === "string" ? profile.real_name : undefined,
      displayName: typeof profile.display_name === "string" ? profile.display_name : undefined,
      raw: profile,
    });
  }
  return [...byId.values()];
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
  const conversationId = target.id ?? "slack-conversation";
  const accumulator = createAccumulator();
  const history = await collectPages(adapter, historyTool, requestValues);
  for (const payload of history.payloads) accumulator.add(normalizeSlackMessages(payload, conversationId));
  let normalized = accumulator.result();
  await publish({
    type: "step",
    id: "02-history",
    order,
    group: "history",
    label: "인증 사용자 범위의 Slack 대화 조회",
    state: history.truncated ? "warning" : "success",
    tool: historyTool.name,
    request: historyArgs,
    response: history.payloads.length === 1 ? history.payloads[0] : history.payloads,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - historyStarted),
    extracted: { messages: normalized.messages.length, files: normalized.files.length, pages: history.pages, truncated: history.truncated },
    message: history.truncated ? "커서를 끝까지 따라가지 못했습니다. 이 채널의 오래된 메시지가 빠져 있습니다." : undefined,
  });

  // reply_count가 있는 메시지가 스레드 뿌리다. 상한을 두면 활발한 채널일수록 답글이 통째로 빠진다.
  const roots = normalized.messages.filter((message) => message.threadTs === message.ts || Number((record(message.raw)?.reply_count)) > 0);
  let threadsRead = 0;
  let threadsTruncated = false;
  if (repliesTool) {
    const repliesStarted = performance.now();
    await publish({
      type: "step",
      id: "03-replies",
      order: ++order,
      group: "replies",
      label: "Slack 스레드 답글 조회",
      state: "running",
      tool: repliesTool.name,
      startedAt: new Date().toISOString(),
      extracted: { roots: roots.length },
    });
    for (const root of roots) {
      const values = {
        ...requestValues,
        ts: root.ts,
        thread_ts: root.ts,
        message_ts: root.ts,
      };
      try {
        const replies = await collectPages(adapter, repliesTool, values);
        if (replies.truncated) threadsTruncated = true;
        for (const payload of replies.payloads) accumulator.add(normalizeSlackMessages(payload, conversationId));
        threadsRead += 1;
      } catch {
        // 스레드 하나가 막혀도 나머지는 계속 읽는다. 다만 완주하지 못했음을 남긴다.
        threadsTruncated = true;
      }
    }
    normalized = accumulator.result();
    await publish({
      type: "step",
      id: "03-replies",
      order,
      group: "replies",
      label: "Slack 스레드 답글 조회",
      state: threadsTruncated ? "warning" : "success",
      tool: repliesTool.name,
      startedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - repliesStarted),
      extracted: { messages: normalized.messages.length, roots: roots.length, read: threadsRead },
      message: threadsTruncated ? `스레드 ${roots.length - threadsRead}개를 읽지 못했거나 답글이 잘렸습니다.` : undefined,
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
    threadsTruncated = roots.length > 0;
  }

  // 메시지가 남기는 건 U012ABCDEF 같은 ID뿐이다. 사람 이름으로 읽으려면 따로 조회해야 한다.
  const userIds = new Set(normalized.messages.map((message) => message.userId).filter((id): id is string => Boolean(id)));
  const usersStarted = performance.now();
  const usersListTool = resolveByKeywords(tools, ["users_list", "slack_users_list", "list_users"], ["user", "list"]);
  const usersInfoTool = resolveByKeywords(tools, ["users_info", "slack_users_info", "get_user_info", "user_info"], ["user", "info"]);
  let users: SlackUser[] = [];
  let usersSource: "users_list" | "users_info" | "message_profile" | "none" = "none";
  if (userIds.size === 0) {
    users = [];
  } else if (usersListTool) {
    usersSource = "users_list";
    const paged = await collectPages(adapter, usersListTool, { limit: 200 });
    // 워크스페이스 전원이 아니라 이 채널에 실제로 글을 쓴 사람만 남긴다.
    users = usersFromPayloads(paged.payloads).filter((user) => userIds.has(user.id));
  } else if (usersInfoTool) {
    usersSource = "users_info";
    const collected: unknown[] = [];
    for (const id of userIds) {
      try {
        const parsed = parseToolResult(await adapter.callTool(usersInfoTool.name, argsFor(usersInfoTool, { user: id, user_id: id, id })));
        if (!parsed.isError) collected.push(parsed.payload);
      } catch {
        // 한 사람을 못 읽어도 나머지는 계속 조회한다.
      }
    }
    users = usersFromPayloads(collected);
  } else {
    usersSource = "message_profile";
    users = usersFromMessages(normalized.messages);
  }

  // 조회한 이름을 메시지에 붙여, ndjson만 열어도 누가 썼는지 읽히게 한다.
  const usersById = new Map(users.map((user) => [user.id, user]));
  for (const message of normalized.messages) {
    if (message.author || !message.userId) continue;
    const user = usersById.get(message.userId);
    if (user) message.author = user.displayName || user.realName || user.name;
  }
  const resolvedAuthors = normalized.messages.filter((message) => message.author).length;
  await publish({
    type: "step",
    id: "04-users",
    order: ++order,
    group: "users",
    label: "작성자 이름 조회",
    state: userIds.size === 0 ? "skipped" : users.length < userIds.size ? "warning" : "success",
    tool: usersListTool?.name ?? usersInfoTool?.name,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - usersStarted),
    extracted: { source: usersSource, authorIds: userIds.size, resolved: users.length, messagesWithAuthor: resolvedAuthors },
    message: usersSource === "none" && userIds.size
      ? "이 Slack MCP 연결에는 사용자 조회 Tool이 없습니다. 메시지에 실려 온 프로필만 남깁니다."
      : users.length < userIds.size
        ? `작성자 ${userIds.size - users.length}명의 이름을 확인하지 못해 ID로 남았습니다.`
        : undefined,
  });

  let filesStored = 0;
  let filesSkipped = 0;
  if (run.input.includeFiles && normalized.files.length) {
    const fileTool = resolveByKeywords(tools, ["read_file", "download_file", "slack_read_file"], ["file", "read"]);
    if (!fileTool) {
      filesSkipped = normalized.files.length;
      await publish({
        type: "step",
        id: "05-files",
        order: ++order,
        group: "files",
        label: "Slack 첨부 파일 읽기",
        state: "skipped",
        startedAt: new Date().toISOString(),
        message: "이 Slack MCP 연결에는 파일 원문을 읽는 Tool이 없습니다. files/index.json에 링크와 metadata만 남깁니다.",
      });
    } else {
      const filesStarted = performance.now();
      await publish({
        type: "step",
        id: "05-files",
        order: ++order,
        group: "files",
        label: "Slack 첨부 파일 읽기",
        state: "running",
        tool: fileTool.name,
        startedAt: new Date().toISOString(),
        extracted: { candidates: normalized.files.length },
      });
      for (const file of normalized.files) {
        const args = argsFor(fileTool, { file_id: file.id, id: file.id, url: file.url ?? file.permalink });
        let raw;
        try {
          raw = await adapter.callTool(fileTool.name, args);
        } catch {
          filesSkipped += 1;
          continue;
        }
        let stored = false;
        for (const block of raw.content ?? []) {
          if (block.type !== "image" && block.type !== "audio" && block.type !== "resource") continue;
          const encoded = block.type === "resource" && "blob" in block.resource ? block.resource.blob : "data" in block ? block.data : undefined;
          if (typeof encoded !== "string") continue;
          const mimeType = block.type === "resource" ? block.resource.mimeType ?? file.mimeType ?? "application/octet-stream" : block.mimeType;
          const data = new Uint8Array(Buffer.from(encoded, "base64"));
          const ref = storeArtifact(run, { data, mimeType, kind: mimeType.startsWith("image/") ? "asset" : "binary", stem: file.name ?? file.id });
          if (ref) { file.artifactPath = ref.path; filesStored += 1; stored = true; }
          break;
        }
        if (!stored) filesSkipped += 1;
      }
      await publish({
        type: "step",
        id: "05-files",
        order,
        group: "files",
        label: "Slack 첨부 파일 읽기",
        state: filesSkipped === 0 ? "success" : "warning",
        tool: fileTool.name,
        startedAt: new Date().toISOString(),
        elapsedMs: Math.round(performance.now() - filesStarted),
        extracted: { candidates: normalized.files.length, stored: filesStored, skipped: filesSkipped },
        message: filesSkipped ? "일부 파일은 MCP 응답에 바이너리가 없거나 접근 권한이 없어 metadata만 남겼습니다." : undefined,
      });
    }
  }

  const result: SlackNormalizedExport = {
    schemaVersion: 1,
    source: "slack_mcp",
    importedAt: new Date().toISOString(),
    users,
    conversations: [{
      id: conversationId,
      name: target.url ?? conversationId,
      kind: conversationId.startsWith("D") ? "dm" : conversationId.startsWith("G") ? "private_channel" : "public_channel",
      members: [],
      raw: target,
    }],
    messages: normalized.messages,
    files: normalized.files,
    coverage: {
      historyPages: history.pages,
      historyTruncated: history.truncated,
      threadRoots: roots.length,
      threadsRead,
      threadsTruncated,
      users: { authorIds: userIds.size, resolved: users.length, source: usersSource },
      files: { candidates: normalized.files.length, stored: filesStored, skipped: filesSkipped },
    },
    provenance: {
      endpoint: "https://mcp.slack.com/mcp",
      access: "authenticated_user_visible_conversations_only",
      target,
      note: "조직 전체 DM Export가 아닙니다.",
    },
  };
  run.normalized = result;
  const incomplete = history.truncated || threadsTruncated;
  await publish({
    type: "complete",
    id: "06-summary",
    order: ++order,
    group: "summary",
    label: "Slack MCP 추출 완료",
    state: incomplete ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: { messages: result.messages.length, files: result.files.length, target, coverage: result.coverage },
    message: incomplete
      ? "인증 사용자가 접근 가능한 대화만 정규화했습니다. 일부 구간을 끝까지 읽지 못했으니 coverage를 확인해 주세요."
      : "인증 사용자가 접근 가능한 대화만 정규화했습니다.",
  });
}
