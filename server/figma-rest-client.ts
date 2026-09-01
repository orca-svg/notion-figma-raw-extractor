import { createHash, randomBytes } from "node:crypto";
import type { FigmaRestOAuthSession } from "./types.js";

const FIGMA_API = "https://api.figma.com/v1";

type BrokerTokens = {
  accessToken: string;
  expiresIn: number;
  refreshGrant?: string;
  userId?: string;
};

export class FigmaRestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
    readonly upgradeUrl?: string,
  ) {
    super(message);
  }
}

function brokerOrigin(): string {
  const value = process.env.FIGMA_REST_BROKER_URL?.trim().replace(/\/$/, "");
  if (!value) throw new Error("FIGMA_REST_BROKER_URL 환경 변수가 필요합니다.");
  return value;
}

function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

async function brokerJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${brokerOrigin()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text }; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload ? String((payload as { message: unknown }).message) : `OAuth broker 요청 실패 (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export async function beginFigmaRestOAuth(session: FigmaRestOAuthSession): Promise<string> {
  const codeVerifier = randomBytes(48).toString("base64url");
  const redeemSecret = randomBytes(32).toString("base64url");
  const prepared = await brokerJson<{ authUrl: string }>("/api/oauth/prepare", {
    codeVerifier,
    redeemSecretHash: sha256Base64Url(redeemSecret),
  });
  session.redeemSecret = redeemSecret;
  session.accessToken = undefined;
  session.expiresAt = undefined;
  session.refreshGrant = undefined;
  session.userId = undefined;
  return prepared.authUrl;
}

export async function finishFigmaRestOAuth(session: FigmaRestOAuthSession, ticket: string): Promise<void> {
  if (!session.redeemSecret) throw new Error("Figma REST OAuth 시작 세션이 없습니다.");
  const tokens = await brokerJson<BrokerTokens>("/api/oauth/redeem", { ticket, redeemSecret: session.redeemSecret });
  session.kind = "oauth";
  session.accessToken = tokens.accessToken;
  session.expiresAt = Date.now() + Math.max(30, tokens.expiresIn) * 1000;
  session.refreshGrant = tokens.refreshGrant;
  session.userId = tokens.userId;
}

/**
 * 개인 액세스 토큰으로 연결한다. broker도 client_secret도 필요 없고,
 * 토큰에 담긴 scope가 곧 접근 범위다. /v1/me로 유효성과 사용자만 확인한 뒤 세션에 둔다.
 */
export async function connectFigmaRestPat(session: FigmaRestOAuthSession, token: string): Promise<{ userId?: string }> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Figma 개인 액세스 토큰을 입력해 주세요.");
  clearFigmaRestOAuth(session);
  session.kind = "pat";
  session.accessToken = trimmed;
  try {
    const me = await figmaRestJson<{ id?: string; handle?: string; email?: string }>(session, "/me");
    session.userId = me.id;
    return { userId: me.id };
  } catch (error) {
    clearFigmaRestOAuth(session);
    // /me 단계의 실패는 파일 권한이 아니라 토큰 자체의 문제다. 원문은 뒤에 붙여 진단을 남긴다.
    const detail = error instanceof FigmaRestApiError ? error.message.replace(/^[^.]*\.\s*/, "") : error instanceof Error ? error.message : String(error);
    // 붙여넣은 토큰이 틀렸거나 만료된 것이므로 사용자 입력 오류(400)다. 그대로 500으로 올리면
    // 화면이 서버 장애로 읽고, 다시 발급하라는 안내로 이어지지 못한다.
    throw new FigmaRestApiError(`Figma 개인 액세스 토큰을 확인하지 못했습니다. 토큰과 scope를 다시 확인해 주세요.${detail ? ` (${detail})` : ""}`, 400);
  }
}

export function clearFigmaRestOAuth(session: FigmaRestOAuthSession): void {
  session.kind = undefined;
  session.redeemSecret = undefined;
  session.accessToken = undefined;
  session.expiresAt = undefined;
  session.refreshGrant = undefined;
  session.userId = undefined;
}

export function figmaRestOAuthStatus(session: FigmaRestOAuthSession) {
  return {
    connected: Boolean(session.accessToken || session.refreshGrant),
    userId: session.userId,
    authKind: session.kind,
  };
}

async function ensureAccessToken(session: FigmaRestOAuthSession): Promise<string> {
  if (session.accessToken && (!session.expiresAt || session.expiresAt - Date.now() > 5 * 60 * 1000)) return session.accessToken;
  // PAT는 갱신 개념이 없다. 만료됐다면 사용자가 Figma에서 새로 발급해야 한다.
  if (session.kind === "pat") throw new Error("Figma 개인 액세스 토큰이 만료되었거나 유효하지 않습니다. 새로 발급해 다시 연결해 주세요.");
  if (!session.refreshGrant || !session.redeemSecret) throw new Error("Figma REST OAuth 연결이 필요합니다.");
  try {
    const tokens = await brokerJson<BrokerTokens>("/api/oauth/refresh", {
      refreshGrant: session.refreshGrant,
      redeemSecret: session.redeemSecret,
    });
    session.accessToken = tokens.accessToken;
    session.expiresAt = Date.now() + Math.max(30, tokens.expiresIn) * 1000;
    session.refreshGrant = tokens.refreshGrant ?? session.refreshGrant;
    session.userId = tokens.userId ?? session.userId;
    return session.accessToken;
  } catch (error) {
    clearFigmaRestOAuth(session);
    throw error;
  }
}

export async function figmaRestJson<T>(session: FigmaRestOAuthSession, path: string, signal?: AbortSignal): Promise<T> {
  const accessToken = await ensureAccessToken(session);
  // 개인 액세스 토큰은 X-Figma-Token, OAuth access token은 Bearer로 보낸다.
  const auth = session.kind === "pat"
    ? { "X-Figma-Token": accessToken }
    : { Authorization: `Bearer ${accessToken}` };
  const response = await fetch(`${FIGMA_API}${path}`, {
    headers: { ...auth, Accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    if (response.status === 401) clearFigmaRestOAuth(session);
    const retryAfter = Number(response.headers.get("retry-after")) || undefined;
    const upgradeUrl = response.headers.get("x-figma-upgrade-link") ?? undefined;
    const body = await response.text();
    let detail = body;
    try {
      const parsed = JSON.parse(body) as { message?: string; err?: string };
      detail = parsed.message ?? parsed.err ?? body;
    } catch { /* keep text */ }
    const prefix = response.status === 401 ? "Figma REST 재인증이 필요합니다."
      : response.status === 403 ? "이 Figma 파일 또는 API scope에 접근할 수 없습니다."
        : response.status === 429 ? `Figma REST 요청 한도에 도달했습니다.${retryAfter ? ` ${retryAfter}초 뒤 다시 시도해 주세요.` : ""}`
          : `Figma REST 요청 실패 (${response.status})`;
    throw new FigmaRestApiError(`${prefix}${detail ? ` ${detail}` : ""}${upgradeUrl ? ` 업그레이드 안내: ${upgradeUrl}` : ""}`, response.status, retryAfter, upgradeUrl);
  }
  return response.json() as Promise<T>;
}
