import { spawn } from "node:child_process";
import type { CodexAuthFlow, CodexCliSession, CodexCliStatus } from "./types.js";

/*
 * 노드 질문은 Plugin이 만든 snapshot과 이미지를 로컬 Codex CLI에 넘겨 답을 만든다.
 * 추출은 Plugin만 하므로 Codex에는 Figma MCP나 Figma OAuth가 필요 없고, Codex 계정 로그인만 있으면 된다.
 */
const CODEX_COMMAND = "codex";
const COMMAND_TIMEOUT_MS = 8_000;
const AUTH_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_COMMAND_OUTPUT = 512 * 1024;
const URL_RE = /https:\/\/[^\s<>"']+/g;
const DEVICE_CODE_RE = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){1,3}\b/;

type CommandResult = { code: number | null; stdout: string; stderr: string };

export function createCodexCliSession(): CodexCliSession {
  return {};
}

function appendCapped(current: string, next: string, max = MAX_COMMAND_OUTPUT): string {
  const joined = current + next;
  return joined.length > max ? joined.slice(-max) : joined;
}

function runCommand(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_COMMAND, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendCapped(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendCapped(stderr, chunk.toString()); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function safeFlowMessage(output: string, fallback: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /login|log in|auth|browser|device|code|success|fail|error|https:\/\//i.test(line))
    .map((line) => line.replace(URL_RE, "[인증 URL]"));
  return (lines.at(-1) || fallback).slice(0, 500);
}

function publicFlow(flow: CodexCliSession["flow"]): CodexAuthFlow | undefined {
  if (!flow) return undefined;
  return { state: flow.state, authUrl: flow.authUrl, userCode: flow.userCode, message: flow.message, startedAt: flow.startedAt };
}

export async function inspectCodexCli(session?: CodexCliSession): Promise<CodexCliStatus> {
  let version: CommandResult;
  try {
    version = await runCommand(["--version"]);
  } catch (error) {
    return {
      installed: false,
      authenticated: false,
      authFlow: publicFlow(session?.flow),
      message: error instanceof Error && "code" in error && error.code === "ENOENT"
        ? "Codex CLI가 없습니다. Codex Desktop 또는 CLI를 설치하면 노드 질문을 쓸 수 있습니다."
        : `Codex CLI 상태를 확인하지 못했습니다. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const login = await runCommand(["login", "status"]);
  const authenticated = login.code === 0 && /logged in/i.test(`${login.stdout}\n${login.stderr}`);
  return {
    installed: version.code === 0,
    version: version.stdout.trim() || version.stderr.trim() || undefined,
    authenticated,
    authFlow: publicFlow(session?.flow),
    message: authenticated ? "노드 질문에 쓸 Codex 계정이 준비되었습니다." : "노드 질문을 쓰려면 Codex 계정 로그인이 필요합니다.",
  };
}

function updateFlowFromOutput(session: CodexCliSession, output: string) {
  const flow = session.flow;
  if (!flow || flow.state !== "waiting") return;
  const urls = output.match(URL_RE)?.map((url) => url.replace(/[),.;]+$/, "")) ?? [];
  const preferred = urls.find((url) => /auth|login|device|openai/i.test(url)) ?? urls[0];
  if (preferred) flow.authUrl = preferred;
  flow.userCode = output.match(DEVICE_CODE_RE)?.[0] ?? flow.userCode;
  flow.message = safeFlowMessage(output, "Codex 기기 인증을 기다리고 있습니다.");
}

export async function startCodexLogin(session: CodexCliSession): Promise<CodexAuthFlow> {
  const status = await inspectCodexCli(session);
  if (status.authenticated) {
    session.flow = { state: "complete", startedAt: Date.now(), message: "Codex 계정이 이미 인증되어 있습니다." };
    return publicFlow(session.flow)!;
  }
  if (session.flow?.state === "waiting" && session.process && !session.process.killed) return publicFlow(session.flow)!;
  session.process?.kill("SIGTERM");
  const child = spawn(CODEX_COMMAND, ["login", "--device-auth"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  session.process = child;
  session.flow = { state: "waiting", startedAt: Date.now(), message: "Codex 기기 인증을 시작하는 중입니다." };
  let output = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve(publicFlow(session.flow)!);
      }
    };
    const timer = setTimeout(() => {
      if (session.flow?.state === "waiting") {
        session.flow.state = "error";
        session.flow.message = "인증 대기 시간이 만료되었습니다. 다시 시작해 주세요.";
      }
      child.kill("SIGTERM");
      settle();
    }, AUTH_TIMEOUT_MS);
    const initialTimer = setTimeout(settle, 1_200);
    const onData = (chunk: Buffer) => {
      output = appendCapped(output, chunk.toString(), 64 * 1024);
      updateFlowFromOutput(session, output);
      if (session.flow?.authUrl || session.flow?.userCode) settle();
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(initialTimer);
      if (session.flow) {
        session.flow.state = "error";
        session.flow.message = "code" in error && error.code === "ENOENT" ? "Codex CLI를 찾을 수 없습니다." : error.message;
      }
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(initialTimer);
      if (session.flow) {
        session.flow.state = code === 0 ? "complete" : "error";
        session.flow.message = code === 0 ? "Codex 로그인이 완료되었습니다." : safeFlowMessage(output, `인증 프로세스가 종료되었습니다. (exit ${code ?? "unknown"})`);
      }
      session.process = undefined;
      settle();
    });
  });
}

export function cancelCodexLogin(session: CodexCliSession) {
  session.process?.kill("SIGTERM");
  session.process = undefined;
  if (session.flow?.state === "waiting") {
    session.flow.state = "error";
    session.flow.message = "인증을 취소했습니다.";
  }
}
