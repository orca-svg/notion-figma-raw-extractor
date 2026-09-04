import { strFromU8, Unzip, UnzipInflate } from "fflate";
import type {
  SlackConversation,
  SlackFileRef,
  SlackNormalizedExport,
  SlackNormalizedMessage,
  SlackUser,
} from "./types.js";

const MAX_COMPRESSED_BYTES = 250 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const MAX_COMPRESSION_RATIO = 200;
const REFERENCE_FILES = new Set(["users.json", "org_users.json", "channels.json", "groups.json", "dms.json", "mpims.json"]);

export type SlackZipEntry = {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
};

function u16(data: Uint8Array, offset: number): number {
  return data[offset] | data[offset + 1] << 8;
}

function u32(data: Uint8Array, offset: number): number {
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0;
}

function safeZipPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  const directory = normalized.endsWith("/");
  const comparable = directory ? normalized.slice(0, -1) : normalized;
  if (!comparable || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || comparable.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`안전하지 않은 ZIP 경로가 있습니다: ${value.slice(0, 160)}`);
  }
  return directory ? `${comparable}/` : comparable;
}

export function inspectSlackExportZip(data: Uint8Array): SlackZipEntry[] {
  if (data.byteLength < 22 || data.byteLength > MAX_COMPRESSED_BYTES) throw new Error("Slack Export ZIP은 250MB 이하여야 합니다.");
  let eocd = -1;
  const start = Math.max(0, data.byteLength - 65_557);
  for (let offset = data.byteLength - 22; offset >= start; offset -= 1) {
    if (u32(data, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("올바른 ZIP 중앙 디렉터리를 찾지 못했습니다.");
  const count = u16(data, eocd + 10);
  const centralSize = u32(data, eocd + 12);
  const centralOffset = u32(data, eocd + 16);
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error("ZIP64 Slack Export는 지원하지 않습니다.");
  if (!count || count > MAX_ENTRIES) throw new Error(`ZIP 파일 수가 허용 범위(1~${MAX_ENTRIES})를 벗어납니다.`);
  if (centralOffset + centralSize > eocd) throw new Error("ZIP 중앙 디렉터리 범위가 잘못되었습니다.");
  const entries: SlackZipEntry[] = [];
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (u32(data, offset) !== 0x02014b50) throw new Error("ZIP 중앙 디렉터리 항목이 손상되었습니다.");
    const compressedBytes = u32(data, offset + 20);
    const uncompressedBytes = u32(data, offset + 24);
    const nameLength = u16(data, offset + 28);
    const extraLength = u16(data, offset + 30);
    const commentLength = u16(data, offset + 32);
    const nameStart = offset + 46;
    const path = safeZipPath(strFromU8(data.subarray(nameStart, nameStart + nameLength)));
    if (!path.endsWith("/")) {
      if (uncompressedBytes > MAX_ENTRY_BYTES) throw new Error(`${path}의 압축 해제 크기가 50MB를 넘습니다.`);
      const ratio = compressedBytes ? uncompressedBytes / compressedBytes : uncompressedBytes ? Number.POSITIVE_INFINITY : 1;
      if (ratio > MAX_COMPRESSION_RATIO) throw new Error(`${path}의 압축비가 비정상적으로 큽니다.`);
      total += uncompressedBytes;
      if (total > MAX_UNCOMPRESSED_BYTES) throw new Error("ZIP 전체 압축 해제 크기가 500MB를 넘습니다.");
      entries.push({ path, compressedBytes, uncompressedBytes });
    }
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseJson<T>(files: Record<string, Uint8Array>, path: string, fallback: T): T {
  const data = files[path];
  if (!data) return fallback;
  try { return JSON.parse(strFromU8(data)) as T; }
  catch { throw new Error(`${path}가 올바른 JSON이 아닙니다.`); }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** MCP 경로도 같은 모양으로 사용자를 정규화한다. */
export function normalizeUsers(values: unknown[]): SlackUser[] {
  return values.map((value) => {
    const item = record(value);
    const profile = record(item.profile);
    return {
      id: string(item.id) ?? string(item.user_id) ?? "unknown",
      name: string(item.name),
      realName: string(item.real_name) ?? string(profile.real_name),
      displayName: string(profile.display_name),
      email: string(profile.email),
      deleted: item.deleted === true,
      raw: value,
    };
  });
}

function normalizeConversation(value: unknown, kind: SlackConversation["kind"]): SlackConversation {
  const item = record(value);
  const members = Array.isArray(item.members) ? item.members.filter((member): member is string => typeof member === "string") : [];
  const id = string(item.id) ?? string(item.channel_id) ?? `${kind}:${members.join("-") || "unknown"}`;
  return {
    id,
    name: string(item.name) ?? string(item.name_normalized) ?? id,
    kind,
    members,
    raw: value,
  };
}

function fileRefs(value: unknown, conversationId: string, messageTs: string): SlackFileRef[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, index) => {
    const item = record(raw);
    return {
      id: string(item.id) ?? string(item.file_id) ?? `${conversationId}:${messageTs}:${index}`,
      name: string(item.name),
      title: string(item.title),
      mimeType: string(item.mimetype),
      url: string(item.url_private_download) ?? string(item.url_private),
      permalink: string(item.permalink),
      conversationId,
      messageTs,
      raw,
    };
  });
}

function folderCandidates(conversation: SlackConversation): string[] {
  return [conversation.name, conversation.id].map((value) => value.replace(/\//g, "")).filter(Boolean);
}

/**
 * 중앙 디렉터리가 신고한 크기는 업로더가 로컬 항목과 무관하게 조작할 수 있다.
 * 그래서 실제로 압축을 풀면서 항목별·전체 상한을 강제한다. 상한을 넘으면 그 자리에서 중단하므로
 * 신고 크기를 작게 속인 압축 폭탄도 메모리를 채우기 전에 걸린다.
 */
function inflateBounded(data: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  let failure: Error | undefined;
  let total = 0;
  unzip.onfile = (file) => {
    if (file.name.endsWith("/")) return;
    let path: string;
    try { path = safeZipPath(file.name); }
    catch (error) { failure ??= error as Error; return; }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (error) { failure = new Error("Slack Export ZIP 압축을 해제하지 못했습니다."); return; }
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_ENTRY_BYTES) { failure = new Error(`${path}의 압축 해제 크기가 50MB를 넘습니다.`); return; }
      if (total > MAX_UNCOMPRESSED_BYTES) { failure = new Error("ZIP 전체 압축 해제 크기가 500MB를 넘습니다."); return; }
      chunks.push(chunk);
      if (!final) return;
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const part of chunks) { merged.set(part, offset); offset += part.length; }
      files[path] = merged;
    };
    file.start();
  };
  try { unzip.push(data, true); }
  catch { throw failure ?? new Error("Slack Export ZIP 압축을 해제하지 못했습니다."); }
  if (failure) throw failure;
  return files;
}

export function parseSlackExportZip(data: Uint8Array): SlackNormalizedExport {
  const inspected = inspectSlackExportZip(data);
  const files = inflateBounded(data);
  const safeFiles: Record<string, Uint8Array> = {};
  const referencePath = inspected.find((entry) => /(^|\/)users\.json$/i.test(entry.path) || /(^|\/)org_users\.json$/i.test(entry.path))?.path;
  const rootPrefix = referencePath?.includes("/") ? referencePath.slice(0, referencePath.lastIndexOf("/") + 1) : "";
  for (const entry of inspected) {
    const value = files[entry.path];
    const normalizedPath = rootPrefix && entry.path.startsWith(rootPrefix) ? entry.path.slice(rootPrefix.length) : entry.path;
    if (value && normalizedPath && value.byteLength === entry.uncompressedBytes) safeFiles[normalizedPath] = value;
  }
  const users = normalizeUsers(parseJson<unknown[]>(safeFiles, safeFiles["users.json"] ? "users.json" : "org_users.json", []));
  const conversations = [
    ...parseJson<unknown[]>(safeFiles, "channels.json", []).map((value) => normalizeConversation(value, "public_channel")),
    ...parseJson<unknown[]>(safeFiles, "groups.json", []).map((value) => normalizeConversation(value, "private_channel")),
    ...parseJson<unknown[]>(safeFiles, "dms.json", []).map((value) => normalizeConversation(value, "dm")),
    ...parseJson<unknown[]>(safeFiles, "mpims.json", []).map((value) => normalizeConversation(value, "mpim")),
  ];
  const byFolder = new Map<string, SlackConversation>();
  for (const conversation of conversations) for (const candidate of folderCandidates(conversation)) byFolder.set(candidate, conversation);
  const byUser = new Map(users.map((user) => [user.id, user]));
  const messages: SlackNormalizedMessage[] = [];
  const allFiles = new Map<string, SlackFileRef>();
  const unknownConversations = new Map<string, SlackConversation>();
  for (const [path, content] of Object.entries(safeFiles)) {
    if (REFERENCE_FILES.has(path) || !/^[^/]+\/[^/]+\.json$/i.test(path)) continue;
    const [folder] = path.split("/");
    const rawMessages = parseJson<unknown[]>(safeFiles, path, []);
    if (!Array.isArray(rawMessages)) continue;
    let conversation = byFolder.get(folder);
    if (!conversation) {
      conversation = unknownConversations.get(folder) ?? { id: `unknown:${folder}`, name: folder, kind: "unknown", members: [], raw: { folder } };
      unknownConversations.set(folder, conversation);
    }
    for (const raw of rawMessages) {
      const item = record(raw);
      const ts = string(item.ts) ?? string(record(item.previous_message).ts);
      if (!ts) continue;
      const userId = string(item.user) ?? string(record(item.message).user) ?? string(record(item.previous_message).user);
      const attached = fileRefs(item.files ?? record(item.message).files ?? record(item.previous_message).files, conversation.id, ts);
      for (const file of attached) allFiles.set(file.id, file);
      const user = userId ? byUser.get(userId) : undefined;
      messages.push({
        conversationId: conversation.id,
        ts,
        userId,
        author: user?.displayName || user?.realName || user?.name,
        text: string(item.text) ?? string(record(item.message).text) ?? string(record(item.previous_message).text) ?? "",
        subtype: string(item.subtype),
        threadTs: string(item.thread_ts),
        parentTs: typeof item.thread_ts === "string" && item.thread_ts !== ts ? item.thread_ts : undefined,
        // message_changed 형태에서는 편집 정보가 item이 아니라 중첩된 message 쪽에 들어온다.
        // text와 같은 경로로 폴백하지 않으면 편집자·편집 시각이 통째로 사라진다.
        edited: item.edited ?? record(item.message).edited ?? record(item.previous_message).edited,
        reactions: item.reactions,
        files: attached.map((file) => file.id),
        raw,
      });
    }
  }
  conversations.push(...unknownConversations.values());
  messages.sort((left, right) => Number(left.ts) - Number(right.ts));
  if (!messages.length) throw new Error("Slack Export에서 메시지 JSON을 찾지 못했습니다.");
  return {
    schemaVersion: 1,
    source: "slack_export",
    importedAt: new Date().toISOString(),
    users,
    conversations,
    messages,
    files: [...allFiles.values()],
    provenance: {
      format: "official_slack_json_export",
      compressedBytes: data.byteLength,
      entries: inspected.length,
      note: "Slack JSON Export의 file 값은 링크와 metadata이며 실제 첨부 바이너리가 아닐 수 있습니다.",
    },
  };
}
