import { buildRunZip, createRun, serializeRun, type SerializedRun } from "./run-store.js";
import type { NotionExtractionInput, NotionRunRecord } from "./types.js";

export { addRunToSession, cleanupRuns, storeArtifact, upsertRunEvent } from "./run-store.js";

export function createNotionRun(sessionId: string, input: NotionExtractionInput): NotionRunRecord {
  return createRun(sessionId, input);
}

export function serializeNotionRun(run: NotionRunRecord): SerializedRun {
  return serializeRun(run, { provider: "notion" });
}

export function buildNotionRunZip(run: NotionRunRecord): Uint8Array {
  return buildRunZip(run, {
    provider: "notion",
    readme: [
      "# MCP Trace Studio · Notion extraction",
      "",
      `- Run: ${run.id}`,
      `- Started: ${run.startedAt}`,
      `- Target: ${run.input.target}`,
      `- Mode: ${run.input.mode ?? "live"}`,
      `- Workspace lookup: ${run.input.includeWorkspace ? "on" : "off"}`,
      "",
      "이 번들은 AI 해석이나 코드 생성을 포함하지 않습니다. trace.ndjson과 responses의 값은 실제 MCP 호출 기록입니다.",
      "artifacts/assets에는 download_attachment로 받은 첨부 원본이 들어 있습니다.",
      run.input.includeWorkspace
        ? "주의: 워크스페이스 조회를 켠 실행이므로 멤버 이름과 이메일이 포함될 수 있습니다."
        : "",
    ].filter(Boolean),
  });
}
