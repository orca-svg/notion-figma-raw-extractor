import { randomUUID } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import type { ArtifactRef, ExtractionEvent, Provider, RunRecord, StoredArtifact } from "./types.js";

export const RUN_TTL_MS = 60 * 60 * 1000;
// 작업 상한(2GB)과 같은 값이어야 한다. 여기가 낮으면 전송에 성공한 파트가 번들에서 조용히 빠진다.
export const MAX_RUN_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SESSION_RUNS = 3;

/** RunRecord의 provider 무관 최소 형태. 저장소 함수는 이 범위만 건드린다. */
type AnyRun = RunRecord<unknown>;

export function extensionFor(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(";")[0];
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/svg+xml") return "svg";
  if (normalized === "application/pdf") return "pdf";
  if (normalized.includes("/")) return normalized.split("/")[1].replace(/[^a-z0-9]+/g, "") || "bin";
  return "bin";
}

export function createRun<TInput>(sessionId: string, input: TInput): RunRecord<TInput> {
  const now = Date.now();
  return {
    id: randomUUID(),
    sessionId,
    startedAt: new Date(now).toISOString(),
    expiresAt: now + RUN_TTL_MS,
    input,
    tools: [],
    events: [],
    artifacts: new Map(),
    artifactBytes: 0,
  };
}

export function addRunToSession<TRun extends AnyRun>(runs: Map<string, TRun>, run: TRun): void {
  cleanupRuns(runs);
  runs.set(run.id, run);
  const ordered = [...runs.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  while (ordered.length > MAX_SESSION_RUNS) {
    const oldest = ordered.shift();
    if (oldest) runs.delete(oldest.id);
  }
}

export function cleanupRuns<TRun extends AnyRun>(runs: Map<string, TRun>): void {
  const now = Date.now();
  for (const [id, run] of runs) if (run.expiresAt <= now) runs.delete(id);
}

export function upsertRunEvent(run: AnyRun, event: ExtractionEvent): void {
  const index = run.events.findIndex((candidate) => candidate.id === event.id);
  if (index === -1) run.events.push(event);
  else run.events[index] = event;
  run.events.sort((a, b) => a.order - b.order);
  if (event.type === "complete" || event.type === "fatal") run.completedAt = new Date().toISOString();
}

export function storeArtifact(
  run: AnyRun,
  input: { data: Uint8Array; mimeType: string; kind: ArtifactRef["kind"]; stem: string; path?: string },
): ArtifactRef | undefined {
  if (run.artifactBytes + input.data.byteLength > MAX_RUN_ARTIFACT_BYTES) return undefined;
  const id = randomUUID();
  const safeStem = input.stem.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "") || "artifact";
  const folder = input.kind === "screenshot" ? "screenshots" : input.kind === "asset" ? "assets" : "binary";
  const requestedPath = input.path?.replace(/^\/+/, "");
  const path = requestedPath && !requestedPath.split("/").some((part) => part === "..")
    ? requestedPath
    : `artifacts/${folder}/${safeStem}-${id.slice(0, 8)}.${extensionFor(input.mimeType)}`;
  const artifact: StoredArtifact = {
    id,
    path,
    mimeType: input.mimeType,
    bytes: input.data.byteLength,
    kind: input.kind,
    data: input.data,
  };
  run.artifacts.set(id, artifact);
  run.artifactBytes += input.data.byteLength;
  return { id, path, mimeType: artifact.mimeType, bytes: artifact.bytes, kind: artifact.kind };
}

/**
 * bundleFiles에 직접 쓰면 artifactBytes가 늘지 않아 실행당 상한을 우회한다.
 * 파트가 수천 개로 늘어난 뒤로는 이 경로가 메모리를 가장 많이 쓰므로 함께 회계한다.
 */
export function storeBundleFile(run: AnyRun & { bundleFiles: Map<string, Uint8Array> }, path: string, data: Uint8Array): boolean {
  if (run.artifactBytes + data.byteLength > MAX_RUN_ARTIFACT_BYTES) return false;
  run.bundleFiles.set(path, data);
  run.artifactBytes += data.byteLength;
  return true;
}

export type SerializedRun = {
  manifest: Record<string, unknown>;
  events: ExtractionEvent[];
};

/** manifestExtra로 provider 고유 필드(detectedFileType 등)를 얹는다. */
export function serializeRun(
  run: AnyRun,
  options: { provider: Provider; manifestExtra?: Record<string, unknown> },
): SerializedRun {
  return {
    manifest: {
      schemaVersion: 1,
      provider: options.provider,
      runId: run.id,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      expiresAt: new Date(run.expiresAt).toISOString(),
      input: run.input,
      tools: run.tools,
      artifactBytes: run.artifactBytes,
      artifacts: [...run.artifacts.values()].map(({ data: _data, ...artifact }) => artifact),
      ...options.manifestExtra,
    },
    events: run.events,
  };
}

export function buildRunZip(
  run: AnyRun,
  options: { provider: Provider; manifestExtra?: Record<string, unknown>; readme: string[]; extraFiles?: Zippable },
): Uint8Array {
  const payload = serializeRun(run, options);
  const files: Zippable = {
    "manifest.json": strToU8(JSON.stringify(payload.manifest, null, 2)),
    "trace.ndjson": strToU8(run.events.map((event) => JSON.stringify(event)).join("\n")),
    "README.md": strToU8(options.readme.join("\n")),
    ...options.extraFiles,
  };

  for (const event of run.events) {
    if (event.state === "running" || event.response === undefined) continue;
    const tool = (event.tool ?? "internal").replace(/[^a-zA-Z0-9_-]+/g, "-");
    files[`responses/${String(event.order).padStart(2, "0")}-${tool}.json`] = strToU8(JSON.stringify(event.response, null, 2));
  }
  for (const artifact of run.artifacts.values()) files[artifact.path] = artifact.data;
  return zipSync(files, { level: 6 });
}
