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

describe("화면·기능 묶음 스크린샷", () => {
  const png = () => Uint8Array.from([137, 80, 78, 71]);
  // 실제 Figma 노드처럼 테스트마다 absoluteRenderBounds·annotations 등을 덧붙이므로 느슨한 타입으로 둔다.
  function box(id: string, name: string, rect: { x: number; y: number; width: number; height: number }, children: any[] = [], extra: Record<string, unknown> = {}): any {
    return {
      id,
      type: "FRAME",
      name,
      visible: true,
      children,
      fills: [],
      absoluteBoundingBox: rect,
      exportAsync: vi.fn(async (settings: { format: string }) => settings.format === "JSON_REST_V1"
        ? { document: { id, type: "FRAME", name, children: [] } }
        : png()),
      ...extra,
    };
  }

  // Step 안에 모바일 화면 둘. 두 번째 화면은 812 뷰포트가 2,100 길이의 본문을 잘라 보여 준다.
  function fixture() {
    const header = box("3:1", "Header", { x: 400, y: 0, width: 375, height: 100 });
    const body = box("3:2", "Body", { x: 400, y: 100, width: 375, height: 2_000 });
    const scrolling = box("2:2", "관심종목 정렬", { x: 400, y: 0, width: 375, height: 812 }, [header, body], { clipsContent: true });
    const plain = box("2:1", "Mobile", { x: 0, y: 0, width: 375, height: 812 }, [box("3:3", "List", { x: 0, y: 100, width: 375, height: 700 })], { clipsContent: true });
    // 가장 바깥 기기 프레임 규칙: 화면 안의 375폭 섹션은 화면으로 올라오면 안 된다.
    const step = box("1:2", "Step 01", { x: 0, y: 0, width: 900, height: 900 }, [plain, scrolling]);
    return { step, plain, scrolling, body };
  }

  it("이름에서 기기 크기를 배우고 가장 바깥 기기 프레임만 화면으로 찍는다", async () => {
    const { step, plain, scrolling } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const message = plugin.messages.at(-1);
    expect(message.type).toBe("job-result");
    const page = message.result.page;
    expect(page.devices).toEqual([expect.objectContaining({ device: "mobile", width: 375, source: "name", screens: 2 })]);
    expect(page.screens.map((screen: any) => screen.nodeId)).toEqual(["2:1", "2:2"]);
    expect(page.screens.every((screen: any) => screen.device === "mobile" && screen.groupNodeId === "1:2")).toBe(true);
    // 화면은 원본보다 키워서 찍는다. 예전 규칙(min(1, 2048/긴 변))은 375px에서 멈췄다.
    expect(plain.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
    expect(scrolling.exportAsync).toHaveBeenCalledWith({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
  });

  it("잘린 스크롤 화면도 Figma에 보이는 뷰포트 한 장만 찍는다", async () => {
    // 스크린샷의 목적은 Figma 화면에서 보이는 모습을 남기는 것이다. 뷰포트가 가린 본문은 따로 꺼내지 않는다.
    // 가려진 부분의 내용은 노드 JSON에 그대로 있다.
    const { step, body } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const message = plugin.messages.at(-1);
    expect(body.exportAsync).not.toHaveBeenCalled();
    expect(message.result.page.screens.every((screen: any) => screen.scrolls === undefined)).toBe(true);
    expect(message.payloads.map((payload: any) => payload.slot).sort()).toEqual(["frame-png-1", "group-1", "node-json-1", "screen-1", "screen-2"]);
  });

  it("기기 이름이 없어도 세 번 이상 반복되는 프레임 크기를 화면으로 본다", async () => {
    // NH 미니모드는 360×600 창 32개, 스플릿뷰는 1536×1000 프레임 44개인데 이름에 기기 단어가 없어 전부 놓쳤다.
    const windows = [0, 1, 2].map((index) => box(`7:${index}`, "[미니모드] 관심", { x: index * 400, y: 0, width: 360, height: 600 }, [box(`8:${index}`, "List", { x: index * 400, y: 60, width: 360, height: 500 })]));
    const pair = [0, 1].map((index) => box(`9:${index}`, "Popup", { x: index * 600, y: 2_000, width: 500, height: 700 }));
    const page = box("7:9", "미니모드", { x: 0, y: 0, width: 2_000, height: 3_000 }, [...windows, ...pair]);
    const plugin = bootPlugin("figma", page);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices).toContainEqual(expect.objectContaining({ device: "repeated-360x600", width: 360, height: 600, source: "repeat", screens: 3 }));
    expect(result.screens.map((screen: any) => screen.nodeId)).toEqual(["7:0", "7:1", "7:2"]);
    // 두 번뿐인 크기는 화면으로 보지 않는다. 팝업·카드가 우연히 같은 크기인 경우를 막는다.
    expect(result.devices.some((device: any) => device.width === 500)).toBe(false);
  });

  it("다른 반복 크기 프레임을 여럿 품은 반복 크기는 화면이 아니라 묶음으로 본다", async () => {
    // 이름 붙은 화면이 없으면 Step 같은 묶음 프레임도 같은 크기로 반복된다. 그걸 화면으로 보면
    // 가장 바깥 규칙 때문에 안의 진짜 화면을 전부 삼킨다.
    const steps = [0, 1, 2].map((step) => {
      const windows = [0, 1].map((index) => box(`13:${step}${index}`, "창", { x: step * 1_000 + index * 400, y: 0, width: 360, height: 600 }));
      return box(`12:${step}`, `Step ${step}`, { x: step * 1_000, y: 0, width: 900, height: 700 }, windows);
    });
    const page = box("12:9", "흐름", { x: 0, y: 0, width: 3_000, height: 800 }, steps);
    const plugin = bootPlugin("figma", page);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices.map((device: any) => device.device)).toEqual(["repeated-360x600"]);
    expect(result.ignoredDevices).toEqual([expect.objectContaining({ device: "repeated-900x700", reason: expect.stringMatching(/묶음/) })]);
    expect(result.screens).toHaveLength(6);
    expect(result.groups.map((group: any) => group.nodeName)).toEqual(["Step 0", "Step 1", "Step 2"]);
  });

  it("반복 횟수는 프레임만 세고 컴포넌트 인스턴스는 세지 않는다", async () => {
    // NH 스플릿뷰에서 사이드 패널 인스턴스(Comm_leftpanel 320×1040) 84개가 화면 52개로 올라왔다.
    // 화면은 프레임으로 그리고 패널·팝업·위젯은 인스턴스로 가져다 쓴다.
    const panels = [0, 1, 2, 3].map((index) => ({ ...box(`14:${index}`, "Comm_leftpanel", { x: index * 400, y: 0, width: 320, height: 1_040 }), type: "INSTANCE" }));
    const windows = [0, 1, 2].map((index) => box(`15:${index}`, "Frame 2147238496", { x: index * 1_600, y: 2_000, width: 1_536, height: 1_000 }));
    // 인정된 크기의 인스턴스는 화면으로 본다. 미니모드 360×600은 프레임 14개와 인스턴스 20개가 섞여 있었다.
    const instanceWindow = { ...box("15:9", "Frame 2147238496", { x: 5_000, y: 2_000, width: 1_536, height: 1_000 }), type: "INSTANCE" };
    const page = box("14:9", "스플릿뷰", { x: 0, y: 0, width: 7_000, height: 3_000 }, [...panels, ...windows, instanceWindow]);
    const plugin = bootPlugin("figma", page);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices.map((device: any) => device.device)).toEqual(["repeated-1536x1000"]);
    expect(result.screens.map((screen: any) => screen.nodeId)).toEqual(["15:0", "15:1", "15:2", "15:9"]);
  });

  it("scanOnly는 이미지를 찍지 않고 화면 크기 후보와 개수만 돌려준다", async () => {
    // 운영자가 추출 전에 후보를 고르려면 먼저 무엇이 화면으로 잡힐지 빠르게 보여 줘야 한다.
    const { step, plain, scrolling } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: { ...pageJob("design"), options: { ...pageJob("design").options, scanOnly: true } } });
    const message = plugin.messages.at(-1);
    expect(message.type).toBe("job-result");
    expect(message.result.page.devices).toEqual([expect.objectContaining({ device: "mobile", width: 375, source: "name", screens: 2 })]);
    expect(message.result.page.groups.map((group: any) => [group.nodeId, group.screens.map((screen: any) => screen.nodeId), group.slot])).toEqual([["1:2", ["2:1", "2:2"], undefined]]);
    expect(message.payloads).toEqual([]);
    expect(step.exportAsync).not.toHaveBeenCalled();
    expect(plain.exportAsync).not.toHaveBeenCalled();
    expect(scrolling.exportAsync).not.toHaveBeenCalled();
  });

  it("운영자가 고른 크기만 화면으로 찍고 스스로 학습한 크기는 쓰지 않는다", async () => {
    const windows = [0, 1, 2].map((index) => box(`16:${index}`, "[미니모드] 관심", { x: index * 400, y: 0, width: 360, height: 600 }));
    const popups = [0, 1].map((index) => box(`17:${index}`, "Popup", { x: index * 600, y: 2_000, width: 500, height: 700 }));
    const page = box("16:9", "미니모드", { x: 0, y: 0, width: 2_000, height: 3_000 }, [...windows, ...popups]);
    const plugin = bootPlugin("figma", page);
    const chosen = [{ device: "popup", width: 500, height: 700, minWidth: 492, maxWidth: 508, minHeight: 692, maxHeight: 708, source: "repeat", examples: ["Popup"], screens: 0 }];
    await plugin.figma.ui.onmessage({ type: "job", job: { ...pageJob("design"), options: { ...pageJob("design").options, devices: chosen } } });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices).toEqual([expect.objectContaining({ device: "popup", screens: 2, selected: true })]);
    expect(result.screens.map((screen: any) => screen.nodeId)).toEqual(["17:0", "17:1"]);
  });

  it("후보를 찾은 페이지와 지금 열린 페이지가 다르면 추출하지 않는다", async () => {
    // 확인 화면의 후보는 스캔한 페이지 기준이다. 그 사이 다른 페이지로 바꾸면 고른 크기가 맞지 않는다.
    const { step } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: { ...pageJob("design"), options: { ...pageJob("design").options, expectedPageId: "9:9" } } });
    expect(plugin.messages.at(-1)).toMatchObject({ type: "job-error", message: expect.stringMatching(/다시 찾아/) });
    expect(step.exportAsync).not.toHaveBeenCalled();
  });

  it("반복 크기는 이미 찾은 화면 안의 컴포넌트에서 배우지 않는다", async () => {
    // 목록 카드 같은 반복 컴포넌트가 화면 안에 여러 개 있어도 그 크기가 화면이 되면 안 된다.
    const cards = [0, 1, 2].map((index) => box(`11:${index}`, "Card", { x: 16, y: 100 + index * 450, width: 343, height: 432 }));
    const screen = box("10:1", "Mobile", { x: 0, y: 0, width: 375, height: 1_500 }, cards);
    for (const card of cards) (card as any).parent = screen;
    const plugin = bootPlugin("figma", screen);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices.map((device: any) => device.device)).toEqual(["mobile"]);
    expect(result.screens.map((item: any) => item.nodeId)).toEqual(["10:1"]);
  });

  it("다른 화면 안에 든 기기 이름 프레임에서는 기기 크기를 배우지 않는다", async () => {
    // "Fold"는 폴더블 기기이기도 하지만 접기 카드 컴포넌트 이름이기도 하다. 화면 안에 있으면 컴포넌트다.
    const card = box("6:2", "Fold", { x: 16, y: 100, width: 343, height: 432 });
    const screen = box("6:1", "Mobile", { x: 0, y: 0, width: 375, height: 812 }, [card]);
    const standalone = box("6:3", "Fold", { x: 1_000, y: 0, width: 768, height: 852 });
    const page = box("6:0", "Flow", { x: 0, y: 0, width: 2_000, height: 900 }, [screen, standalone]);
    for (const node of [card, screen, standalone]) (node as any).parent = undefined;
    (card as any).parent = screen;
    (screen as any).parent = page;
    (standalone as any).parent = page;
    const plugin = bootPlugin("figma", page);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const result = plugin.messages.at(-1).result.page;
    expect(result.devices.map((device: any) => `${device.device} ${device.width}`)).toEqual(["mobile 375", "fold 768"]);
    expect(result.ignoredDevices).toEqual([expect.objectContaining({ device: "fold", width: 343, reason: expect.stringMatching(/화면 안/) })]);
    expect(result.screens.map((item: any) => item.nodeId)).toEqual(["6:1", "6:3"]);
  });

  // 실제 노드처럼 parent를 잇는다. 주석은 붙은 노드에서 위로 올라가 화면을 찾는다.
  function linkParents(node: any, parent: any = null) {
    node.parent = parent;
    for (const child of node.children ?? []) linkParents(child, node);
    return node;
  }

  it("그림자·넘친 내용으로 이미지가 프레임보다 크면 프레임 원점의 위치를 renderOffset으로 남긴다", async () => {
    // NH 주식 페이지에서 그림자 여백 때문에 375×812 화면이 880×1684 이미지로 나왔다. 원점이 x 31만큼 밀려 있다.
    const { step, plain, scrolling } = fixture();
    plain.absoluteRenderBounds = { x: -31, y: -4, width: 440, height: 842 };
    scrolling.absoluteRenderBounds = { x: 400, y: 0, width: 375, height: 812 };
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const [first, second] = plugin.messages.at(-1).result.page.screens;
    expect(first.renderOffset).toEqual({ x: 31, y: 4 });
    // 그려진 범위와 프레임이 같으면 보정할 것이 없다.
    expect(second.renderOffset).toBeUndefined();
  });

  it("Figma 기본 주석을 붙은 노드의 화면·기능 묶음과 카테고리 id로 모은다", async () => {
    const { step, plain } = fixture();
    const list = plain.children[0];
    list.annotations = [{ label: "국내 종목에만 노출", categoryId: "cat-content", properties: [{ type: "width" }] }];
    // 화면 밖, 묶음 컨테이너에 직접 단 주석은 화면 없이 묶음에 속한다.
    step.annotations = [{ labelMarkdown: "**공통** 정의" }];
    linkParents(step);
    // 주석 노드는 내보낸 노드 JSON에서 찾는다. 실제 JSON_REST_V1처럼 annotations가 붙은 트리를 돌려준다.
    step.exportAsync = vi.fn(async (settings: { format: string }) => settings.format === "JSON_REST_V1"
      ? { document: { id: "1:2", type: "FRAME", name: "Step 01", annotations: [{ label: "공통" }], children: [
        { id: "2:1", type: "FRAME", name: "Mobile", children: [{ id: "3:3", type: "FRAME", name: "List", annotations: [{ label: "국내 종목에만 노출" }] }] },
      ] } }
      : Uint8Array.from([137, 80, 78, 71]));
    const plugin = bootPlugin("figma", step);
    const byId = new Map([["1:2", step], ["3:3", list]]);
    plugin.figma.getNodeByIdAsync = vi.fn(async (id: string) => byId.get(id) ?? null);
    plugin.figma.annotations = { getAnnotationCategoriesAsync: vi.fn(async () => [{ id: "cat-content", label: "콘텐츠", color: "orange", isPreset: false }]) };
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const page = plugin.messages.at(-1).result.page;
    expect(page.annotationCategories).toEqual([{ id: "cat-content", label: "콘텐츠", color: "orange", isPreset: false }]);
    const onScreen = page.annotations.find((item: any) => item.nodeId === "3:3");
    expect(onScreen).toMatchObject({ label: "국내 종목에만 노출", categoryId: "cat-content", properties: ["width"], screenNodeId: "2:1", groupNodeId: "1:2", rect: { x: 0, y: 100, width: 375, height: 700 } });
    const onGroup = page.annotations.find((item: any) => item.nodeId === "1:2");
    expect(onGroup).toMatchObject({ labelMarkdown: "**공통** 정의", groupNodeId: "1:2" });
    expect(onGroup.screenNodeId).toBeUndefined();
  });

  it("노드 JSON에 주석이 없으면 노드를 하나씩 다시 읽지 않는다", async () => {
    const { step } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    expect(plugin.messages.at(-1).type).toBe("job-result");
    expect(plugin.getNode).not.toHaveBeenCalled();
  });

  it("주석이 없으면 카테고리를 조회하지 않고 필드도 비운다", async () => {
    const { step } = fixture();
    const plugin = bootPlugin("figma", step);
    const lookup = vi.fn(async () => []);
    plugin.figma.annotations = { getAnnotationCategoriesAsync: lookup };
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const page = plugin.messages.at(-1).result.page;
    expect(page.annotations).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("화면을 둘 이상 품은 가장 안쪽 컨테이너를 기능 묶음으로 찍고 화면 좌표를 붙인다", async () => {
    const { step } = fixture();
    const plugin = bootPlugin("figma", step);
    await plugin.figma.ui.onmessage({ type: "job", job: pageJob("design") });
    const message = plugin.messages.at(-1);
    const [group] = message.result.page.groups;
    expect(group).toMatchObject({ nodeId: "1:2", nodeName: "Step 01", slot: "group-1", scale: 1 });
    expect(group.screens).toEqual([
      { nodeId: "2:1", x: 0, y: 0, width: 375, height: 812 },
      { nodeId: "2:2", x: 400, y: 0, width: 375, height: 812 },
    ]);
  });
});
