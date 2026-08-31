import { strToU8, type Zippable } from "fflate";
import { buildRunZip, createRun, serializeRun, type SerializedRun } from "./run-store.js";
import type { FigmaExtractionInput, FigmaRunRecord } from "./types.js";

export { addRunToSession, cleanupRuns, storeArtifact, upsertRunEvent, MAX_RUN_ARTIFACT_BYTES, RUN_TTL_MS } from "./run-store.js";

export function createFigmaRun(sessionId: string, input: FigmaExtractionInput): FigmaRunRecord {
  return { ...createRun(sessionId, input), bundleFiles: new Map() };
}

function figmaManifestExtra(run: FigmaRunRecord): Record<string, unknown> {
  return {
    detectedFileType: run.detectedFileType,
    contextPackage: run.contextPackage,
    pagePackage: run.pagePackage,
    restMetadata: run.restMetadata,
  };
}

export function serializeFigmaRun(run: FigmaRunRecord): SerializedRun {
  return serializeRun(run, { provider: "figma", manifestExtra: figmaManifestExtra(run) });
}

export function buildFigmaRunZip(run: FigmaRunRecord): Uint8Array {
  const extraFiles: Zippable = {};
  if (run.contextPackage) extraFiles["context.json"] = strToU8(JSON.stringify(run.contextPackage, null, 2));
  if (run.pagePackage) extraFiles["page.json"] = strToU8(JSON.stringify(run.pagePackage, null, 2));
  if (run.restMetadata) {
    extraFiles["metadata/file.json"] = strToU8(JSON.stringify(run.restMetadata.file, null, 2));
    extraFiles["metadata/comments.json"] = strToU8(JSON.stringify(run.restMetadata.comments, null, 2));
    extraFiles["metadata/versions.json"] = strToU8(JSON.stringify(run.restMetadata.versions, null, 2));
  }
  for (const [filePath, data] of run.bundleFiles) extraFiles[filePath] = data;
  return buildRunZip(run, {
    provider: "figma",
    manifestExtra: figmaManifestExtra(run),
    extraFiles,
    readme: [
      "# MCP Trace Studio · Figma extraction",
      "",
      `- Run: ${run.id}`,
      `- Started: ${run.startedAt}`,
      `- Transport: ${run.input.transport}`,
      `- Target mode: ${run.input.targetMode}`,
      `- Detected type: ${run.detectedFileType ?? "unknown"}`,
      "",
      run.input.transport === "codex"
        ? "이 번들은 Codex가 중계한 JSONL Tool 이벤트입니다. 직접 MCP content block 원문이 아니며, AI 실행 경로를 포함합니다."
        : run.input.transport === "plugin"
          ? `이 번들은 Figma 개발 Plugin snapshot과 artifact${run.input.question ? ", 읽기 전용 Codex 질문 답변" : ""}을 포함합니다. 버전 작성자는 coarse_version_attribution입니다.`
          : "이 번들은 AI 해석이나 코드 생성을 포함하지 않습니다. trace.ndjson과 responses의 값은 실제 MCP 호출 기록입니다.",
    ],
  });
}
