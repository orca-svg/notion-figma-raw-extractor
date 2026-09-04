import { strToU8, type Zippable } from "fflate";
import { buildRunZip, createRun, serializeRun, type SerializedRun } from "./run-store.js";
import type { SlackExtractionInput, SlackRunRecord } from "./types.js";

export { addRunToSession, cleanupRuns, upsertRunEvent } from "./run-store.js";

export function createSlackRun(sessionId: string, input: SlackExtractionInput): SlackRunRecord {
  return createRun(sessionId, input);
}

function manifestExtra(run: SlackRunRecord): Record<string, unknown> {
  const normalized = run.normalized;
  return {
    normalized: normalized ? {
      schemaVersion: normalized.schemaVersion,
      source: normalized.source,
      importedAt: normalized.importedAt,
      users: normalized.users.length,
      conversations: normalized.conversations.length,
      messages: normalized.messages.length,
      files: normalized.files.length,
      coverage: normalized.coverage,
      provenance: normalized.provenance,
    } : undefined,
  };
}

export function serializeSlackRun(run: SlackRunRecord): SerializedRun {
  return serializeRun(run, { provider: "slack", manifestExtra: manifestExtra(run) });
}

export function buildSlackRunZip(run: SlackRunRecord): Uint8Array {
  const extraFiles: Zippable = {};
  if (run.normalized) {
    extraFiles["users.json"] = strToU8(JSON.stringify(run.normalized.users, null, 2));
    extraFiles["conversations/index.json"] = strToU8(JSON.stringify(run.normalized.conversations, null, 2));
    extraFiles["files/index.json"] = strToU8(JSON.stringify(run.normalized.files, null, 2));
    for (const conversation of run.normalized.conversations) {
      const messages = run.normalized.messages.filter((message) => message.conversationId === conversation.id);
      const pathId = conversation.id.replace(/[^a-zA-Z0-9_-]+/g, "-");
      extraFiles[`conversations/${pathId}.ndjson`] = strToU8(messages.map((message) => JSON.stringify(message)).join("\n"));
    }
  }
  return buildRunZip(run, {
    provider: "slack",
    manifestExtra: manifestExtra(run),
    extraFiles,
    readme: [
      "# MCP Trace Studio · Slack extraction",
      "",
      `- Run: ${run.id}`,
      `- Started: ${run.startedAt}`,
      `- Mode: ${run.input.mode}`,
      "",
      run.input.mode === "export"
        ? "공식 Slack JSON Export를 로컬에서 정규화했습니다. files/index.json의 링크는 실제 첨부 바이너리가 아닐 수 있습니다."
        : run.input.mode === "web"
          ? "Slack Web API를 이 PC에서 직접 호출해 토큰 소유자가 볼 수 있는 채널 하나만 읽었습니다. 조직 전체 Export가 아닙니다."
          : "공식 Slack MCP OAuth로 인증 사용자가 접근할 수 있는 대화만 읽었습니다. 조직 전체 DM Export가 아닙니다.",
      "",
      run.normalized?.coverage
        ? `- 어디까지 읽었는지는 manifest.json의 normalized.coverage를 보세요. historyTruncated 또는 threadsTruncated가 true면 일부 구간이 빠져 있습니다.`
        : "",
    ],
  });
}
