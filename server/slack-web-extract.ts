import { slackWebCall, SlackWebApiError } from "./slack-web-client.js";
import { createAccumulator, normalizeSlackMessages, parseSlackConversationTarget, usersFromPayloads } from "./slack-mcp-extract.js";
import { storeArtifact } from "./run-store.js";
import type {
  EmitEvent,
  ExtractionEvent,
  SlackConversation,
  SlackNormalizedExport,
  SlackRunRecord,
  SlackUser,
  SlackWebSession,
} from "./types.js";

/** 200개씩 받아 10만 메시지. 서버가 커서를 끝없이 돌려주는 경우를 대비한 안전선이다. */
const MAX_PAGES = 500;
const PAGE_SIZE = 200;
/** 첨부 하나가 이보다 오래 걸리면 링크만 남기고 넘어간다. 전체가 한 파일에 붙잡히지 않게 한다. */
const FILE_TIMEOUT_MS = 20_000;
const FILE_CONCURRENCY = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type PagedResult = { payloads: unknown[]; pages: number; truncated: boolean };

/**
 * Slack은 response_metadata.next_cursor로 페이지를 잇는다. 한 번만 부르면 limit을 넘는 채널이
 * 잘린 줄도 모르고 잘린다. 더 갈 수 있는데 멈춘 경우에만 truncated를 세운다.
 */
async function collectWebPages(
  session: SlackWebSession,
  method: string,
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<PagedResult> {
  const payloads: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const payload = await slackWebCall<Record<string, unknown>>(session, method, { ...params, cursor, limit: PAGE_SIZE }, signal);
    payloads.push(payload);
    pages += 1;
    const next = isRecord(payload.response_metadata) && typeof payload.response_metadata.next_cursor === "string"
      ? payload.response_metadata.next_cursor.trim()
      : "";
    if (!next) return { payloads, pages, truncated: false };
    // 같은 커서가 다시 오면 서버가 페이지를 넘기지 못하는 것이다. 무한 루프로 들어가지 않는다.
    if (seen.has(next)) return { payloads, pages, truncated: true };
    seen.add(next);
    cursor = next;
    if (pages >= MAX_PAGES) return { payloads, pages, truncated: true };
  }
}

function conversationKind(id: string, info: Record<string, unknown>): SlackConversation["kind"] {
  if (info.is_im === true || id.startsWith("D")) return "dm";
  if (info.is_mpim === true) return "mpim";
  if (info.is_private === true || id.startsWith("G")) return "private_channel";
  if (id.startsWith("C")) return "public_channel";
  return "unknown";
}

/**
 * 사용자 토큰으로 Slack Web API를 직접 호출한다. mcp.slack.com을 거치지 않으므로 조직이
 * MCP를 승인하지 않아도 동작하고, 오가는 경로가 이 PC와 slack.com 둘뿐이다.
 */
export async function runSlackWebExtraction(
  session: SlackWebSession,
  run: SlackRunRecord,
  emit: EmitEvent,
  signal?: AbortSignal,
): Promise<void> {
  let order = 0;
  const publish = (event: ExtractionEvent) => emit({ ...event, provider: "slack", runId: run.id, origin: event.tool ? "rest" : "internal" });
  const target = parseSlackConversationTarget(run.input.target ?? "");
  if (!target.id) throw new Error("채널 ID를 확인하지 못했습니다. C…로 시작하는 ID나 /archives/ 링크를 넣어 주세요.");
  const conversationId = target.id;

  // 1) 채널 정보 — 이름과 종류를 먼저 확인해야 결과물이 ID 뭉치로 남지 않는다.
  const infoStarted = performance.now();
  await publish({
    type: "step",
    id: "01-channel",
    order: ++order,
    group: "discovery",
    label: "채널 정보 조회",
    state: "running",
    tool: "conversations.info",
    request: { channel: conversationId },
    startedAt: new Date().toISOString(),
  });
  const infoResponse = await slackWebCall<{ channel?: Record<string, unknown> }>(session, "conversations.info", { channel: conversationId }, signal);
  const info = infoResponse.channel ?? {};
  const conversation: SlackConversation = {
    id: conversationId,
    name: typeof info.name === "string" ? info.name : conversationId,
    kind: conversationKind(conversationId, info),
    members: [],
    raw: info,
  };
  await publish({
    type: "step",
    id: "01-channel",
    order,
    group: "discovery",
    label: "채널 정보 조회",
    state: "success",
    tool: "conversations.info",
    request: { channel: conversationId },
    response: infoResponse,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - infoStarted),
    extracted: { name: conversation.name, kind: conversation.kind, members: info.num_members },
  });

  // 2) 메시지 — 커서를 끝까지 따라간다.
  const historyRequest = { channel: conversationId, oldest: run.input.oldest, latest: run.input.latest };
  const historyStarted = performance.now();
  await publish({
    type: "step",
    id: "02-history",
    order: ++order,
    group: "history",
    label: "채널 메시지 조회",
    state: "running",
    tool: "conversations.history",
    request: historyRequest,
    startedAt: new Date().toISOString(),
  });
  const accumulator = createAccumulator();
  const history = await collectWebPages(session, "conversations.history", historyRequest, signal);
  for (const payload of history.payloads) accumulator.add(normalizeSlackMessages(payload, conversationId));
  let normalized = accumulator.result();
  await publish({
    type: "step",
    id: "02-history",
    order,
    group: "history",
    label: "채널 메시지 조회",
    state: history.truncated ? "warning" : "success",
    tool: "conversations.history",
    request: historyRequest,
    response: history.payloads.length === 1 ? history.payloads[0] : history.payloads,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - historyStarted),
    extracted: { messages: normalized.messages.length, files: normalized.files.length, pages: history.pages, truncated: history.truncated },
    message: history.truncated ? "커서를 끝까지 따라가지 못했습니다. 오래된 메시지가 빠져 있습니다." : undefined,
  });

  // 3) 스레드 답글 — reply_count가 있는 뿌리는 전부 따라간다.
  const roots = normalized.messages.filter((message) => Number(isRecord(message.raw) ? message.raw.reply_count : 0) > 0);
  let threadsRead = 0;
  let threadsTruncated = false;
  const repliesStarted = performance.now();
  await publish({
    type: "step",
    id: "03-replies",
    order: ++order,
    group: "replies",
    label: "스레드 답글 조회",
    state: "running",
    tool: "conversations.replies",
    startedAt: new Date().toISOString(),
    extracted: { roots: roots.length },
  });
  const repliesPayloads: unknown[] = [];
  for (const root of roots) {
    try {
      const replies = await collectWebPages(session, "conversations.replies", { channel: conversationId, ts: root.ts }, signal);
      if (replies.truncated) threadsTruncated = true;
      for (const payload of replies.payloads) {
        accumulator.add(normalizeSlackMessages(payload, conversationId));
        repliesPayloads.push(payload);
      }
      threadsRead += 1;
    } catch (error) {
      // 스레드 하나가 막혀도 나머지는 계속 읽는다. 다만 완주하지 못했음을 남긴다.
      if (error instanceof SlackWebApiError && error.status === 401) throw error;
      threadsTruncated = true;
    }
  }
  normalized = accumulator.result();
  await publish({
    type: "step",
    id: "03-replies",
    order,
    group: "replies",
    label: "스레드 답글 조회",
    state: threadsTruncated ? "warning" : "success",
    tool: "conversations.replies",
    request: { channel: conversationId },
    response: repliesPayloads.length ? repliesPayloads : undefined,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - repliesStarted),
    extracted: { messages: normalized.messages.length, roots: roots.length, read: threadsRead },
    message: threadsTruncated ? `스레드 ${roots.length - threadsRead}개를 읽지 못했거나 답글이 잘렸습니다.` : undefined,
  });

  // 4) 작성자 — 메시지에는 U012ABCDEF 같은 ID만 남는다.
  const userIds = [...new Set(normalized.messages.map((message) => message.userId).filter((id): id is string => Boolean(id)))];
  const usersStarted = performance.now();
  await publish({
    type: "step",
    id: "04-users",
    order: ++order,
    group: "users",
    label: "작성자 이름 조회",
    state: "running",
    tool: "users.info",
    startedAt: new Date().toISOString(),
    extracted: { authorIds: userIds.length },
  });
  const userPayloads: unknown[] = [];
  for (const id of userIds) {
    try {
      userPayloads.push(await slackWebCall<Record<string, unknown>>(session, "users.info", { user: id }, signal));
    } catch (error) {
      if (error instanceof SlackWebApiError && error.status === 401) throw error;
      // 한 사람을 못 읽어도 나머지는 계속 조회한다.
    }
  }
  const users: SlackUser[] = usersFromPayloads(userPayloads);
  const usersById = new Map(users.map((user) => [user.id, user]));
  for (const message of normalized.messages) {
    if (message.author || !message.userId) continue;
    const user = usersById.get(message.userId);
    if (user) message.author = user.displayName || user.realName || user.name;
  }
  await publish({
    type: "step",
    id: "04-users",
    order,
    group: "users",
    label: "작성자 이름 조회",
    state: users.length < userIds.length ? "warning" : "success",
    tool: "users.info",
    request: { users: userIds.length },
    response: userPayloads.length ? userPayloads : undefined,
    startedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - usersStarted),
    extracted: { authorIds: userIds.length, resolved: users.length },
    message: users.length < userIds.length ? `작성자 ${userIds.length - users.length}명의 이름을 확인하지 못해 ID로 남았습니다.` : undefined,
  });

  // 5) 첨부 — url_private은 토큰을 붙여야 내려받을 수 있다.
  let filesStored = 0;
  let filesSkipped = 0;
  if (run.input.includeFiles && normalized.files.length) {
    const filesStarted = performance.now();
    await publish({
      type: "step",
      id: "05-files",
      order: ++order,
      group: "files",
      label: "첨부 파일 내려받기",
      state: "running",
      startedAt: new Date().toISOString(),
      extracted: { candidates: normalized.files.length },
    });
    let deniedByScope = false;
    let timedOut = 0;
    let done = 0;
    // 하나씩 받으면 느린 파일 하나가 전체를 붙잡는다. 몇 개씩 나눠 동시에 받는다.
    const queue = [...normalized.files];
    const take = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift();
        if (!file) return;
        const url = file.url ?? file.permalink;
        if (!url) { filesSkipped += 1; done += 1; continue; }
        try {
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${session.token}` },
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(FILE_TIMEOUT_MS)])
              : AbortSignal.timeout(FILE_TIMEOUT_MS),
          });
          // 권한이 없으면 Slack은 401이 아니라 로그인 페이지를 돌려준다. 그걸 파일로 저장하면 안 된다.
          const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? file.mimeType ?? "application/octet-stream";
          if (mimeType === "text/html" || response.status === 401 || response.status === 403) deniedByScope = true;
          if (!response.ok || mimeType === "text/html") { filesSkipped += 1; continue; }
          const data = new Uint8Array(await response.arrayBuffer());
          const ref = storeArtifact(run, { data, mimeType, kind: mimeType.startsWith("image/") ? "asset" : "binary", stem: file.name ?? file.id });
          if (ref) { file.artifactPath = ref.path; filesStored += 1; } else filesSkipped += 1;
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") timedOut += 1;
          filesSkipped += 1;
        } finally {
          done += 1;
          // 같은 id로 다시 보내면 화면의 해당 단계가 갱신된다. 어디까지 왔는지 보이게 한다.
          await publish({
            type: "step",
            id: "05-files",
            order,
            group: "files",
            label: "첨부 파일 내려받기",
            state: "running",
            startedAt: new Date().toISOString(),
            extracted: { candidates: normalized.files.length, done, stored: filesStored, skipped: filesSkipped },
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_CONCURRENCY, queue.length) }, take));
    await publish({
      type: "step",
      id: "05-files",
      order,
      group: "files",
      label: "첨부 파일 내려받기",
      state: filesSkipped === 0 ? "success" : "warning",
      startedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - filesStarted),
      extracted: { candidates: normalized.files.length, stored: filesStored, skipped: filesSkipped },
      message: timedOut
        ? `첨부 ${timedOut}개가 ${FILE_TIMEOUT_MS / 1000}초 안에 오지 않아 링크만 남겼습니다.`
        : deniedByScope
        ? "토큰에 files:read 권한이 없어 첨부 원본을 받지 못했습니다. 앱의 사용자 토큰 범위에 files:read를 추가하고 다시 설치하면 받을 수 있습니다. 지금은 files/index.json에 링크와 metadata만 남겼습니다."
        : filesSkipped ? "일부 첨부는 내려받지 못해 files/index.json에 링크만 남겼습니다." : undefined,
    });
  }

  const result: SlackNormalizedExport = {
    schemaVersion: 1,
    source: "slack_web",
    importedAt: new Date().toISOString(),
    users,
    conversations: [conversation],
    messages: normalized.messages,
    files: normalized.files,
    coverage: {
      historyPages: history.pages,
      historyTruncated: history.truncated,
      threadRoots: roots.length,
      threadsRead,
      threadsTruncated,
      users: { authorIds: userIds.length, resolved: users.length, source: "users_info" },
      files: { candidates: normalized.files.length, stored: filesStored, skipped: filesSkipped },
    },
    provenance: {
      endpoint: "https://slack.com/api",
      access: session.tokenType === "bot" ? "bot_token_invited_channels_only" : "user_token_visible_conversations_only",
      workspace: { id: session.teamId, name: session.teamName },
      target,
      note: "토큰 소유자가 볼 수 있는 채널만 읽었습니다. 조직 전체 Export가 아닙니다.",
    },
  };
  run.normalized = result;
  const incomplete = history.truncated || threadsTruncated;
  await publish({
    type: "complete",
    id: "06-summary",
    order: ++order,
    group: "summary",
    label: "Slack 채널 추출 완료",
    state: incomplete ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: { channel: conversation.name, messages: result.messages.length, users: users.length, files: result.files.length, coverage: result.coverage },
    message: incomplete
      ? "일부 구간을 끝까지 읽지 못했습니다. coverage를 확인해 주세요."
      : "채널 메시지·스레드·작성자를 모두 읽었습니다.",
  });
}
