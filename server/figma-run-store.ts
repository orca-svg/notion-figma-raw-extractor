import { strToU8, type Zippable } from "fflate";
import { buildRunZip, createRun, serializeRun, type SerializedRun } from "./run-store.js";
import type { FigmaExtractionInput, FigmaRunRecord } from "./types.js";

export { addRunToSession, cleanupRuns, storeArtifact, storeBundleFile, upsertRunEvent, MAX_RUN_ARTIFACT_BYTES, RUN_TTL_MS } from "./run-store.js";

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
      `이 번들은 Figma 개발 Plugin snapshot과 artifact${run.input.question ? ", 읽기 전용 Codex 질문 답변" : ""}을 포함합니다. 버전 작성자는 coarse_version_attribution입니다.`,
      ...(run.pagePackage ? [
        "",
        "## 파일 구성",
        "",
        "- `page.json` — 페이지 구조와 프레임 목록. 각 노드의 `parts`가 아래 조각을 가리킵니다.",
        "- `nodes/<프레임>.json` — 프레임 트리의 첫 조각.",
        "- `nodes/<프레임>/NNN-….json` — 트리가 커서 나눈 나머지 조각.",
        "- `screenshots/` — 최상위 프레임별 PNG. 페이지 배치도용이라 긴 변 2048px 이하입니다.",
        ...(run.pagePackage.screens ? [
          "- `screens/<기기>/` — 화면별 PNG(2배). Figma 화면에서 보이는 그대로이며, 뷰포트가 가린 스크롤 영역은 노드 JSON에만 있습니다.",
          "- `groups/` — 화면을 둘 이상 품은 기능 묶음 PNG.",
          "- `screens.html` — 압축을 푼 폴더에서 더블클릭해 화면·기능 묶음·주석 위치를 보는 뷰어. 인터넷 연결 없이 열립니다.",
          "- `screens.json` — 화면·기능 묶음 색인과 학습한 화면 크기, 묶음 이미지 위 화면 좌표, Figma 기본 주석(카테고리·붙은 화면·이미지 위 위치). 이미지 원점 보정값(offset)은 모든 imageRect에 반영되어 있습니다.",
        ] : []),
        "- `assets/` — 원본 이미지와 SVG. 내용이 같으면 파일 하나로 합쳤습니다.",
        "- `assets/index.json` — 각 에셋을 쓰는 노드 목록(`usages`).",
        "- `metadata/` — Figma가 준 작성자·댓글·버전 기록.",
        "",
        "## 조각을 다시 잇는 방법",
        "",
        "트리가 예산을 넘으면 노드 경계에서 나눕니다. 조각마다 그대로 `JSON.parse`가 되며,",
        "떼어낸 자리에는 `{ \"id\", \"type\", \"name\", \"__part\": \"<노드 id>\" }` 스텁이 남습니다.",
        "`__part`의 값과 같은 `document.id`를 가진 조각을 찾아 그 자리에 끼우면 원래 트리가 됩니다.",
        "각 조각의 `partOf`가 몇 번째 조각인지, `parentNodeId`가 어느 노드에서 갈라졌는지 알려줍니다.",
        "",
        "`page.json`의 `partial`이 true면 무엇이 빠졌는지 각 노드의 `omittedNodes`와 `assets`에 적혀 있습니다.",
      ] : []),
    ],
  });
}
