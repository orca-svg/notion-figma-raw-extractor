import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../server/index.js";

let server: Server;
let origin: string;

beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(() => resolve(undefined))));

async function browserSession() {
  const response = await fetch(`${origin}/api/session`);
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return {
    cookie,
    headers: { cookie, "X-MCP-Trace-CSRF": csrfToken, Origin: "http://127.0.0.1:5173" },
  };
}

async function pairPlugin() {
  const session = await browserSession();
  const started = await fetch(`${origin}/api/figma/plugin/pair/start`, { method: "POST", headers: session.headers });
  const { code } = (await started.json()) as { code: string };
  const completed = await fetch(`${origin}/api/figma/plugin/pair/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, meta: { pluginVersion: "1.1.0", editorType: "figma" } }),
  });
  return { session, token: ((await completed.json()) as { sessionToken: string }).sessionToken };
}

async function pairedPluginToken() {
  return (await pairPlugin()).token;
}

describe("플러그인 연결 해제", () => {
  it("해제하면 상태가 끊기고 플러그인의 다음 poll이 401을 받는다", async () => {
    const { session, token } = await pairPlugin();
    expect(((await (await fetch(`${origin}/api/figma/plugin/status`, { headers: { cookie: session.cookie } })).json()) as { connected: boolean }).connected).toBe(true);

    const dropped = await fetch(`${origin}/api/figma/plugin/disconnect`, { method: "POST", headers: session.headers });
    expect(((await dropped.json()) as { disconnected: boolean }).disconnected).toBe(true);

    expect(((await (await fetch(`${origin}/api/figma/plugin/status`, { headers: { cookie: session.cookie } })).json()) as { connected: boolean }).connected).toBe(false);
    // 이 401이 플러그인을 페어링 화면으로 되돌리는 신호다.
    const polled = await fetch(`${origin}/api/figma/plugin/jobs/next`, { headers: { Authorization: `Bearer ${token}` } });
    expect(polled.status).toBe(401);
    expect(((await polled.json()) as { message: string }).message).toMatch(/세션이 만료/);
  });
});

describe("플러그인 artifact 업로드 본문 한도", () => {
  it("64KiB를 넘는 JSON 프레임이 전역 파서에 막히지 않고 라우트까지 간다", async () => {
    const token = await pairedPluginToken();
    const response = await fetch(`${origin}/api/figma/plugin/jobs/none/artifacts/node-json-17`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }),
    });
    // 작업이 없으니 400인 건 정상이다. 중요한 건 "request entity too large"가 아니라는 점이다.
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/작업이 없거나/);
  });

  it("PNG artifact도 같은 경로로 20MB까지 받는다", async () => {
    const token = await pairedPluginToken();
    const response = await fetch(`${origin}/api/figma/plugin/jobs/none/artifacts/frame-png-17`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
      body: new Uint8Array(2 * 1024 * 1024),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toMatch(/작업이 없거나/);
  });

  it("플러그인 밖의 일반 API는 64KB 본문 상한을 그대로 지킨다", async () => {
    const session = await browserSession();
    const response = await fetch(`${origin}/api/notion/auth/pat`, {
      method: "POST",
      headers: { ...session.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedEmail: "a@b.c", token: "x".repeat(100_000) }),
    });
    expect(((await response.json()) as { message: string }).message).toMatch(/too large/i);
  });
});
