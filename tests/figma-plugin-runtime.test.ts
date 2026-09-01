import vm from "node:vm";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";

type MockPlugin = {
  figma: any;
  messages: any[];
  getNode: ReturnType<typeof vi.fn>;
};

let pluginJavaScript = "";

beforeAll(async () => {
  const source = await readFile(new URL("../plugins/figma-trace/code.ts", import.meta.url), "utf8");
  pluginJavaScript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
});

function createNode(id: string, children: any[] = [], fills: any[] = []) {
  return {
    id,
    type: "FRAME",
    name: `Node ${id}`,
    children,
    fills,
    absoluteBoundingBox: { width: 800, height: 600 },
    exportAsync: vi.fn(async (settings: { format: string }) => settings.format === "JSON_REST_V1"
      ? { id, type: "FRAME", name: `Node ${id}`, children: children.map((child) => ({ id: child.id, type: child.type, name: child.name })) }
      : Uint8Array.from([137, 80, 78, 71])),
  };
}

function bootPlugin(editorType: "figma" | "figjam", node: any, fileKey = "file-key"): MockPlugin {
  const messages: any[] = [];
  const getNode = vi.fn(async () => node);
  const figma = {
    editorType,
    fileKey,
    root: { name: "Fixture" },
    currentPage: { id: "0:1", name: "Page 1", children: [node], loadAsync: vi.fn(async () => undefined) },
    currentUser: { id: "user-1", name: "Alice", photoUrl: null },
    skipInvisibleInstanceChildren: false,
    showUI: vi.fn(),
    getNodeByIdAsync: getNode,
    getImageByHash: vi.fn(() => ({ getBytesAsync: async () => Uint8Array.from([137, 80, 78, 71]) })),
    ui: { onmessage: undefined as undefined | ((message: any) => Promise<void>), postMessage: (message: any) => messages.push(message) },
  };
  vm.runInNewContext(pluginJavaScript, { figma, __html__: "<html></html>", console, Uint8Array, Set, Map, Promise, Error, JSON, Math, Object, Array, String, Number, RegExp });
  return { figma, messages, getNode };
}

function job(fileType: "design" | "figjam", options: Partial<Record<string, number>> = {}) {
  return {
    id: "job-1",
    type: "extract_node",
    target: { fileKey: "file-key", nodeId: "1:2", fileType, sourceUrl: `https://figma.com/${fileType === "design" ? "design" : "board"}/file-key/File?node-id=1-2` },
    options: { maxNodes: 5_000, maxJsonBytes: 20 * 1024 * 1024, maxDimension: 2_048, maxAssets: 20, maxAssetBytes: 10 * 1024 * 1024, ...options },
  };
}

function pageJob(fileType: "design" | "figjam", options: Partial<Record<string, number>> = {}) {
  return {
    id: "page-job-1",
    type: "extract_page",
    fileKey: "file-key",
    fileType,
    options: { maxNodes: 5_000, maxJsonBytes: 20 * 1024 * 1024, maxDimension: 2_048, maxAssets: 20, maxAssetBytes: 10 * 1024 * 1024, ...options },
  };
}

describe("Figma development plugin API mock", () => {
  it.each([["figma", "design"], ["figjam", "figjam"]] as const)("%s에서 JSON_REST_V1 snapshot과 PNG를 직렬화한다", async (editorType, fileType) => {
    const node = createNode("1:2", [{ id: "1:3", type: "TEXT", name: "Headline" }]);
    const plugin = bootPlugin(editorType, node);
    await plugin.figma.ui.onmessage({ type: "job", job: job(fileType) });
    const message = plugin.messages.at(-1);
    expect(message).toMatchObject({ type: "job-result", result: { nodeCount: 2, partial: false, meta: { editorType, nodeId: "1:2" } } });
    expect(node.exportAsync).toHaveBeenCalledWith({ format: "JSON_REST_V1" });
    expect(message.payloads[0]).toMatchObject({ slot: "screenshot", kind: "screenshot", mimeType: "image/png" });
  });

  it("열린 파일의 file key가 다르면 노드를 읽기 전에 중단한다", async () => {
    const plugin = bootPlugin("figma", createNode("1:2"), "another-file");
    await plugin.figma.ui.onmessage({ type: "job", job: job("design") });
    expect(plugin.messages.at(-1)).toMatchObject({ type: "job-error", message: expect.stringMatching(/file key/) });
    expect(plugin.getNode).not.toHaveBeenCalled();
  });

  it("현재 페이지를 로드하고 최상위 프레임별 JSON과 PNG를 분리한다", async () => {
    const node = createNode("1:2", [{ id: "1:3", type: "TEXT", name: "Headline" }]);
    const plugin = bootPlugin("figma", node);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const message = plugin.messages.at(-1);
    expect(plugin.figma.currentPage.loadAsync).toHaveBeenCalledOnce();
    expect(message).toMatchObject({
      type: "job-result",
      result: { scope: "current_page", page: { id: "0:1", name: "Page 1", nodes: [{ nodeId: "1:2", jsonSlot: "node-json-1", screenshotSlot: "frame-png-1" }] } },
    });
    expect(message.payloads.map((payload: any) => payload.kind)).toEqual(expect.arrayContaining(["json", "screenshot"]));
  });

  it("하위 이미지 후보를 20개로 제한하고 큰 트리를 partial snapshot으로 자른다", async () => {
    const children = Array.from({ length: 14 }, (_, index) => ({ id: `2:${index}`, type: "RECTANGLE", name: `Child ${index}` }));
    const fills = Array.from({ length: 25 }, (_, index) => ({ type: "IMAGE", imageHash: `hash-${index}` }));
    const node = createNode("1:2", children, fills);
    const plugin = bootPlugin("figma", node);
    await plugin.figma.ui.onmessage({ type: "job", job: job("design", { maxNodes: 10 }) });
    const message = plugin.messages.at(-1);
    // 루트 1 + 자식 14 = 15개 중 10개만 보관했으므로 누락은 5개다. 예전에는 스캔이 상한에서
    // 멈춰 총계를 몰랐고, 그래서 얼마를 잃든 항상 1로 적혔다.
    expect(message.result).toMatchObject({ nodeCount: 10, partial: true, omittedNodes: 5 });
    expect(message.payloads.filter((artifact: any) => artifact.kind === "asset")).toHaveLength(20);
    expect(message.payloads.every((artifact: any) => artifact.data.byteLength <= 10 * 1024 * 1024)).toBe(true);
  });

  it("boundVariables의 VARIABLE_ALIAS를 노드로 세지 않는다", async () => {
    // 실제 파일에서 별칭 2,889개가 5,000 예산을 먹어 실제 노드 2,111개만 남고 나머지가 잘렸다.
    // 별칭은 노드가 아니라 속성 바인딩이므로 예산을 소비해서도, 잘려 사라져서도 안 된다.
    const alias = { type: "VARIABLE_ALIAS", id: "VariableID:lib/1:1" };
    const children = Array.from({ length: 3 }, (_, index) => ({
      id: `2:${index}`,
      type: "RECTANGLE",
      name: `Child ${index}`,
      boundVariables: { fills: [alias], color: alias },
    }));
    const node = {
      ...createNode("1:2", children),
      exportAsync: vi.fn(async (settings: { format: string }) => settings.format === "JSON_REST_V1"
        ? { document: { id: "1:2", type: "FRAME", name: "Root", boundVariables: { fills: [alias] }, children } }
        : Uint8Array.from([137, 80, 78, 71])),
    };
    const plugin = bootPlugin("figma", node);
    await plugin.figma.ui.onmessage({ type: "job", job: job("design", { maxNodes: 4 }) });
    const message = plugin.messages.at(-1);
    // 루트 1 + 자식 3 = 4. 별칭 7개는 세지 않으므로 잘리지 않는다.
    expect(message.result).toMatchObject({ nodeCount: 4, partial: false });
    // 별칭이 예산에 걸려 undefined로 잘리면 바인딩 정보 자체가 사라진다.
    expect(message.result.snapshot.document.children).toHaveLength(3);
    expect(message.result.snapshot.document.children[2].boundVariables.fills[0]).toEqual(alias);
  });

  it("예산을 넘는 페이지 트리를 파싱 가능한 서브트리 파트로 나눈다", async () => {
    // 바이트로 자르면 조각이 JSON으로 열리지 않는다. 경계를 노드에 맞추고 자리에는 __part 참조를 남긴다.
    const fat = (id: string) => ({ id, type: "FRAME", name: `Fat ${id}`, blob: "x".repeat(4_000), children: [] });
    const branches = Array.from({ length: 6 }, (_, index) => fat(`3:${index}`));
    const node = {
      ...createNode("1:2", branches),
      exportAsync: vi.fn(async (settings: { format: string }) => settings.format === "JSON_REST_V1"
        ? { document: { id: "1:2", type: "SECTION", name: "Root", children: branches } }
        : Uint8Array.from([137, 80, 78, 71])),
    };
    const plugin = bootPlugin("figma", node);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design", { maxJsonBytes: 9_000 }) });
    const message = plugin.messages.at(-1);
    const jsonParts = message.payloads.filter((artifact: any) => artifact.kind === "json");
    expect(jsonParts.length).toBeGreaterThan(1);
    // 모든 조각이 단독으로 파싱돼야 한다.
    const parsed = jsonParts.map((artifact: any) => JSON.parse(new TextDecoder().decode(artifact.data)));
    expect(parsed.every((part: any) => typeof part.document?.id === "string")).toBe(true);
    // 떼어낸 자리에는 참조 스텁이 남는다.
    const root = parsed.find((part: any) => part.document.id === "1:2");
    const refs = root.document.children.filter((child: any) => typeof child.__part === "string");
    expect(refs.length).toBeGreaterThan(0);
    // 참조가 가리키는 노드는 실제 파트로 존재한다.
    for (const ref of refs) expect(parsed.some((part: any) => part.document.id === ref.__part)).toBe(true);
    expect(message.result.page.nodes[0].parts.length).toBe(jsonParts.length);
  });
});
