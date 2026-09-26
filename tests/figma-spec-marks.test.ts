import { describe, expect, it } from "vitest";
import { SpecMarkCollector, textToMarkdown } from "../server/figma-spec-marks.js";

type Node = Record<string, unknown> & { id: string; children?: Node[] };

const box = (x: number, y: number, width: number, height: number) => ({ absoluteBoundingBox: { x, y, width, height } });
const frame = (id: string, name: string, at: [number, number, number, number], children: Node[] = [], type = "FRAME"): Node => ({ id, name, type, ...box(...at), children });
const text = (id: string, characters: string, at: [number, number, number, number], extra: Record<string, unknown> = {}): Node => ({ id, name: "Text", type: "TEXT", characters, ...box(...at), ...extra });
/** 번호 배지 인스턴스. component가 같으면 같은 종류다. */
const badge = (id: string, label: string, x: number, y: number, component = "badge-desc"): Node => ({
  id, name: "Badge_dark outline", type: "INSTANCE", componentId: component, ...box(x, y, 24, 24),
  children: [text(`${id};t`, label, [x + 4, y + 4, 16, 16])],
});
const outline = (id: string, at: [number, number, number, number]): Node => ({ id, name: "Rectangle", type: "RECTANGLE", ...box(...at), strokes: [{ type: "SOLID" }], fills: [] });
/** 설명 칸 한 줄: 배지와 글만 있다. */
const entry = (id: string, label: string, body: string, x: number, y: number): Node =>
  frame(id, "Content", [x, y, 440, 60], [badge(`${id}-b`, label, x, y), text(`${id}-t`, body, [x + 40, y, 400, 60])]);
/** 화면 하나와, 화면 옆에 겹쳐 놓은 표시 오버레이(배지 + 영역 사각형). */
const board = (id: string, x: number, labels: string[]): Node => frame(id, `03 현재가 > ${id}`, [x, 0, 1000, 2000], [
  frame(`${id}-screen`, "Mobile", [x, 0, 375, 812]),
  frame(`${id}-ov`, "Description", [x - 12, 0, 400, 812], labels.flatMap((label, index) => [
    outline(`${id}-r${index}`, [x, 90 + index * 100, 343, 46]),
    badge(`${id}-m${index}`, label, x - 12, 90 + index * 100 + 8),
  ]), "GROUP"),
]);
const components = {
  "badge-desc": { name: "Dark line=Description", componentSetId: "badge-set" },
  "badge-event": { name: "Dark line=Event", componentSetId: "badge-set" },
  "tag": { name: "종목=인버스", componentSetId: "tag-set" },
};

function collect(root: Node, extraParts: unknown[] = []) {
  const collector = new SpecMarkCollector();
  collector.addPart({ document: root, components, componentSets: { "badge-set": { name: "Badge_dark outline" }, "tag-set": { name: "종목 태그" } } });
  for (const part of extraParts) collector.addPart(part);
  return collector;
}

describe("번호 배지 표시와 설명 칸 잇기", () => {
  it("Figma 목록 서식을 중첩 목록으로 되살린다", () => {
    expect(textToMarkdown("□ 상단 정보 영역\n주요 이슈 영역\n국내 케이스\n거래정지", ["NONE", "UNORDERED", "UNORDERED", "UNORDERED"], [0, 1, 2, 3]))
      .toBe("□ 상단 정보 영역\n- 주요 이슈 영역\n  - 국내 케이스\n    - 거래정지");
  });

  it("보드마다 설명 열을 둔 배치에서는 가장 가까운 보드의 설명에 잇고, 설명 열이 없는 보드는 확정하지 않는다", () => {
    const section = frame("S", "02/03 현재가 산출물 정리", [0, 0, 9000, 2000], [
      board("A", 0, ["01", "E1"]),
      frame("colA", "Description", [1050, 0, 480, 500], [entry("ca1", "01", "□ 상단 정보 영역", 1050, 0), entry("ca2", "E1", "□ 검색창 호출", 1050, 80)]),
      board("B", 3000, ["01"]),
      frame("colB", "Description", [4050, 0, 480, 500], [entry("cb1", "01", "□ 호가 영역", 4050, 0)]),
      board("C", 6000, ["01"]),
    ], "SECTION");
    const index = collect(section).build({ screens: ["A", "B", "C"].map((id) => ({ nodeId: `${id}-screen`, image: { scale: 2, offset: { x: 4, y: 0 } } })) });

    expect(index.badgeComponents.map((component) => component.name)).toEqual(["Badge_dark outline"]);
    expect(index.legends.map((legend) => legend.label).sort()).toEqual(["01", "01", "E1"]);
    const mark = (id: string) => index.marks.find((item) => item.nodeId === id)!;
    expect(mark("A-m0")).toMatchObject({ status: "linked", legendNodeId: "ca1-b", evidence: "scope" });
    expect(mark("B-m0")).toMatchObject({ status: "linked", legendNodeId: "cb1-b", evidence: "scope" });
    // C에는 설명 열이 없다. A·B 옆의 열은 그 보드 몫이라 참고 후보로만 남기고 잇지 않는다.
    expect(mark("C-m0")).toMatchObject({ status: "unlinked", legendNodeId: undefined });
    expect(mark("C-m0").candidates.map((candidate) => candidate.inScope)).toEqual([false, false]);
    // 영역 사각형을 화면 원점 기준 좌표와 2배 이미지 픽셀(원점 보정 포함)로 준다.
    expect(mark("A-m0")).toMatchObject({ screenNodeId: "A-screen", regionNodeId: "A-r0", rect: { x: 0, y: 90, width: 343, height: 46 }, imageRect: { x: 4, y: 180, width: 686, height: 92 } });
    expect(mark("A-m1")).toMatchObject({ label: "E1", kind: "event", status: "linked", legendNodeId: "ca2-b", evidence: "only" });
    expect(index.summary).toMatchObject({ legends: 3, marks: 4, linked: 3, ambiguous: 0, unlinked: 1 });
  });

  it("따로 선 설명 열은 파일에서 배운 방향의 띠를 맡는다. 가장 가까운 영역이 아니어도 그렇다", () => {
    // Z 보드 안의 설명 열이 표시들의 오른쪽에 붙어 있다 → 이 파일은 "설명이 오른쪽"이다.
    const section = frame("S", "섹션", [-4000, 0, 8000, 2000], [
      frame("Z", "03 현재가 > 공통정의", [-4000, 0, 2600, 2000], [
        board("Z1", -4000, ["01"]),
        frame("colZ", "Description", [-1900, 0, 480, 300], [entry("cz1", "01", "□ 공통 헤더", -1900, 0), entry("cz2", "02", "□ 공통 차트", -1900, 80)]),
      ]),
      board("X", 0, ["01"]),
      frame("K1", "Description", [1050, 0, 480, 300], [entry("k1", "01", "□ X의 헤더", 1050, 0)]),
      // Y는 K1에 더 가깝지만(30) K1의 오른쪽에 있으므로 K2 몫이다.
      board("Y", 1560, ["01"]),
      frame("K2", "Description", [2700, 0, 480, 300], [entry("k2", "01", "□ Y의 헤더", 2700, 0)]),
    ], "SECTION");
    const index = collect(section).build({ screens: [] });
    expect(index.layout).toEqual({ side: "right", examples: 1 });
    const mark = (id: string) => index.marks.find((item) => item.nodeId === id)!;
    expect(mark("X-m0")).toMatchObject({ status: "linked", legendNodeId: "k1-b", evidence: "scope" });
    expect(mark("Y-m0")).toMatchObject({ status: "linked", legendNodeId: "k2-b", evidence: "scope" });
    expect(mark("Z1-m0")).toMatchObject({ status: "linked", legendNodeId: "cz1-b" });
  });

  it("보드 안의 설명 열 하나는 그 보드의 모든 영역을 설명한다", () => {
    const boardD = frame("D", "03 현재가 > 031 공통정의", [0, 0, 5000, 2000], [
      board("D1", 0, ["01", "02"]),
      board("D2", 2000, ["01"]),
      frame("colD", "Description", [4400, 0, 480, 300], [entry("cd1", "01", "□ 스크롤 전 헤더", 4400, 0), entry("cd2", "02", "□ 상단 정보 영역", 4400, 80)]),
    ]);
    const index = collect(boardD).build({ screens: [] });
    // 열이 D2보다 D1에서 훨씬 멀어도, 보드 안의 열 하나는 보드 전체의 설명이다.
    expect(index.marks.map((item) => [item.nodeId, item.status, item.legendNodeId])).toEqual(expect.arrayContaining([
      ["D1-m0", "linked", "cd1-b"],
      ["D2-m0", "linked", "cd1-b"],
      ["D1-m1", "linked", "cd2-b"],
    ]));
  });

  it("화면 안에 바로 놓인 배지는 곁에 UI가 있어 설명 칸으로 읽지 않는다", () => {
    const root = frame("R", "Page", [0, 0, 3000, 2000], [
      frame("scr", "Step 01", [0, 0, 375, 812], [
        frame("status", "Status bar", [0, 0, 375, 44], [text("clock", "9:41 오전 배터리", [10, 10, 60, 20]), { id: "icon", name: "Battery", type: "VECTOR", ...box(300, 10, 20, 10) }]),
        badge("inside", "01", 0, 100),
      ]),
      frame("col", "Description", [500, 0, 480, 300], [entry("c1", "01", "□ 상단 정보 영역", 500, 0), entry("c2", "02", "□ 차트 영역", 500, 80)]),
      frame("ov", "Description", [0, 300, 40, 40], [badge("m2", "02", 0, 300)], "GROUP"),
    ]);
    const index = collect(root).build({ screens: [{ nodeId: "scr" }] });
    expect(index.legends.map((legend) => legend.title)).toEqual(["□ 상단 정보 영역", "□ 차트 영역"]);
    expect(index.marks.find((item) => item.nodeId === "inside")).toMatchObject({ status: "linked", legendNodeId: "c1-b", screenNodeId: "scr" });
  });

  it("생김새만 비슷한 UI 태그는 명세 배지로 고르지 않는다", () => {
    const row = (id: string, label: string, name: string, y: number) =>
      frame(id, "row", [0, y, 300, 40], [badge(`${id}-tag`, label, 0, y, "tag"), text(`${id}-name`, name, [30, y, 200, 20])]);
    const root = frame("R", "Page", [0, 0, 2000, 2000], [
      row("r1", "12", "KODEX 200선물인버스2X", 0),
      row("r2", "13", "TIGER 미국나스닥100", 50),
      badge("loose", "3", 500, 500, "tag"),
    ]);
    const index = collect(root).build({ screens: [] });
    expect(index.badgeComponents).toEqual([]);
    expect(index.marks).toEqual([]);
  });

  it("조각으로 나뉜 트리를 parentNodeId와 __part 스텁으로 다시 잇는다", () => {
    const column = frame("colP", "Description", [1050, 0, 480, 300], [entry("p1", "01", "□ 상단 정보 영역", 1050, 0), entry("p2", "02", "□ 차트 영역", 1050, 80)]);
    const root = frame("P", "03 현재가 > 031 공통정의", [0, 0, 2000, 2000], [
      board("P1", 0, ["01", "02"]),
      { id: "colP", name: "Description", type: "FRAME", __part: "colP" },
    ]);
    const index = collect(root, [{ document: column, parentNodeId: "P", partOf: { nodeId: "P", index: 2, total: 2 } }]).build({ screens: [] });
    expect(index.marks.map((item) => [item.label, item.status, item.legendNodeId])).toEqual([["01", "linked", "p1-b"], ["02", "linked", "p2-b"]]);
  });
});
