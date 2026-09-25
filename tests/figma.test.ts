import { describe, expect, it } from "vitest";
import { parseFigmaTarget } from "../server/figma-target.js";

describe("Figma target parser", () => {
  it("Design, branch, FigJam 링크를 file key와 node id로 정규화한다", () => {
    expect(parseFigmaTarget("https://www.figma.com/design/abc/File?node-id=12-34")).toMatchObject({ fileKey: "abc", nodeId: "12:34", fileType: "design" });
    expect(parseFigmaTarget("https://figma.com/design/base/branch/branchKey/File?node-id=8%3A9")).toMatchObject({ fileKey: "branchKey", nodeId: "8:9", fileType: "design" });
    expect(parseFigmaTarget("https://www.figma.com/board/jamKey/Map?node-id=1-2")).toMatchObject({ fileKey: "jamKey", nodeId: "1:2", fileType: "figjam" });
  });

  it("파일 전체 링크와 지원하지 않는 유형을 거부한다", () => {
    expect(() => parseFigmaTarget("https://figma.com/design/abc/File")).toThrow(/node-id/);
    expect(() => parseFigmaTarget("https://figma.com/slides/abc/Deck?node-id=1-2")).toThrow(/지원하지/);
  });
});
