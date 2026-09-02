import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSafePilotText, isBlockedPilotPath, PILOT_ROOT_FILES } from "../scripts/package-pilot.js";

describe("internal pilot distribution", () => {
  it("double-click setup and start commands are part of the release allowlist", () => {
    expect(PILOT_ROOT_FILES).toContain("setup.command");
    expect(PILOT_ROOT_FILES).toContain("start.command");
    expect(PILOT_ROOT_FILES).toContain("setup.bat");
    expect(PILOT_ROOT_FILES).toContain("start.bat");
    expect(PILOT_ROOT_FILES).toContain("PILOT-START.md");
  });

  it("credentials, local state, dependencies, and non-plugin build output are blocked", () => {
    expect(isBlockedPilotPath(".env")).toBe(true);
    expect(isBlockedPilotPath("oauth-broker/.env.production")).toBe(true);
    expect(isBlockedPilotPath("node_modules/pkg/index.js")).toBe(true);
    expect(isBlockedPilotPath("oauth-broker/node_modules/pkg/index.js")).toBe(true);
    expect(isBlockedPilotPath("dist/index.html")).toBe(true);
    expect(isBlockedPilotPath("plugins/figma-trace/dist")).toBe(false);
    expect(isBlockedPilotPath("plugins/figma-trace/dist/code.js")).toBe(false);
    expect(isBlockedPilotPath("oauth-broker/.env.example")).toBe(false);
  });

  it("credential-like values and personal absolute paths stop packaging", () => {
    expect(() => assertSafePilotText("safe.md", "FIGMA_REST_CLIENT_SECRET=")).not.toThrow();
    expect(() => assertSafePilotText("unsafe.txt", `token=${"ghp_"}${"a".repeat(32)}`)).toThrow(/credential/);
    expect(() => assertSafePilotText("unsafe.txt", path.join("/Users", "someone", "project"))).toThrow(/절대 경로/);
  });
});
