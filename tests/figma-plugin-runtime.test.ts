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

function pageJob(fileType: "design" | "figjam") {
  return {
    id: "page-job-1",
    type: "extract_page",
    fileKey: "file-key",
    fileType,
    options: { maxNodes: 5_000, maxJsonBytes: 20 * 1024 * 1024, maxDimension: 2_048, maxAssets: 20, maxAssetBytes: 10 * 1024 * 1024 },
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
    expect(message.result).toMatchObject({ nodeCount: 10, partial: true, omittedNodes: 1 });
    expect(message.payloads.filter((artifact: any) => artifact.kind === "asset")).toHaveLength(20);
    expect(message.payloads.every((artifact: any) => artifact.data.byteLength <= 10 * 1024 * 1024)).toBe(true);
  });
});
