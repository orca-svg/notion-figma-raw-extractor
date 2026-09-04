import type { SlackWebSession } from "./types.js";

const SLACK_API = "https://slack.com/api";
/** 429를 만나면 Retry-After만큼 쉬고 다시 부른다. 끝없이 매달리지 않도록 횟수를 둔다. */
const MAX_RATE_LIMIT_RETRIES = 5;

export class SlackWebApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly slackError?: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "SlackWebApiError";
  }
}

/**
 * Slack은 실패도 HTTP 200에 {ok:false, error:"..."}로 돌려준다. 그 코드를 그대로 노출하면
 * 무엇을 고쳐야 하는지 알 수 없으므로, 조치가 갈리는 것들만 우리말로 옮긴다.
 */
function describeSlackError(code: string, detail?: { needed?: string; provided?: string }): { message: string; status: number } {
  switch (code) {
    case "invalid_auth":
    case "token_revoked":
    case "token_expired":
      return { message: "Slack 토큰이 유효하지 않거나 회수되었습니다. 새로 발급해 주세요.", status: 401 };
    case "account_inactive":
      return { message: "토큰을 발급한 Slack 계정이 비활성 상태입니다.", status: 401 };
    case "missing_scope":
      return {
        message: `토큰에 권한이 모자랍니다. 필요한 scope: ${detail?.needed ?? "확인 불가"}${detail?.provided ? ` (현재: ${detail.provided})` : ""}`,
        status: 403,
      };
    case "not_allowed_token_type":
      return { message: "이 요청에는 다른 종류의 토큰이 필요합니다. User Token(xoxp-)으로 다시 시도해 주세요.", status: 403 };
    case "channel_not_found":
      return { message: "채널을 찾을 수 없습니다. 채널 ID가 맞는지, 토큰을 발급한 계정이 그 채널에 들어가 있는지 확인해 주세요.", status: 404 };
    case "not_in_channel":
      return { message: "토큰의 주인이 이 채널에 들어가 있지 않습니다. 채널에 참여하거나 봇이라면 /invite로 초대해 주세요.", status: 403 };
    case "is_archived":
      return { message: "보관된(archived) 채널입니다.", status: 403 };
    case "ratelimited":
      return { message: "Slack 요청 한도에 걸렸습니다.", status: 429 };
    default:
      return { message: `Slack API 오류 (${code})`, status: 502 };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function slackWebCall<T>(
  session: SlackWebSession,
  method: string,
  params: Record<string, string | number | undefined> = {},
  signal?: AbortSignal,
): Promise<T> {
  const token = session.token;
  if (!token) throw new SlackWebApiError("Slack 토큰을 먼저 연결해 주세요.", 401);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const url = `${SLACK_API}/${method}${query.size ? `?${query}` : ""}`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 1;
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        throw new SlackWebApiError(`Slack 요청 한도에 도달했습니다. ${retryAfter}초 뒤 다시 시도해 주세요.`, 429, "ratelimited", retryAfter);
      }
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      continue;
    }
    if (!response.ok) throw new SlackWebApiError(`Slack API 요청 실패 (${response.status})`, response.status);
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) throw new SlackWebApiError("Slack API가 예상과 다른 응답을 보냈습니다.", 502);
    if (body.ok === true) return body as T;

    const code = typeof body.error === "string" ? body.error : "unknown_error";
    const described = describeSlackError(code, {
      needed: typeof body.needed === "string" ? body.needed : undefined,
      provided: typeof body.provided === "string" ? body.provided : undefined,
    });
    // 어느 method에서 났는지 남긴다. 여러 호출을 묶어 돌리면 이것 없이는 원인을 좁힐 수 없다.
    throw new SlackWebApiError(`${described.message} (${method})`, described.status, code);
  }
}

/**
 * 토큰 자체가 자격증명이라 중간 서버가 필요 없다. auth.test로 유효성과 소속만 확인하고 세션에 둔다.
 * Figma 개인 액세스 토큰과 같은 구조다.
 */
export async function connectSlackWebToken(session: SlackWebSession, token: string): Promise<SlackWebSession> {
  const trimmed = token.trim();
  if (!trimmed) throw new SlackWebApiError("Slack 토큰을 입력해 주세요.", 400);
  if (!/^xox[bp]-/.test(trimmed)) {
    throw new SlackWebApiError("Slack 토큰은 xoxp-(User) 또는 xoxb-(Bot)로 시작합니다. 값을 다시 확인해 주세요.", 400);
  }
  clearSlackWeb(session);
  session.token = trimmed;
  session.tokenType = trimmed.startsWith("xoxp-") ? "user" : "bot";
  try {
    const me = await slackWebCall<{ team_id?: string; team?: string; user_id?: string; user?: string; url?: string }>(session, "auth.test");
    session.teamId = me.team_id;
    session.teamName = me.team;
    session.userId = me.user_id;
    session.userName = me.user;
    session.workspaceUrl = me.url;
    return session;
  } catch (error) {
    clearSlackWeb(session);
    const detail = error instanceof Error ? error.message : String(error);
    // 붙여넣은 값의 문제이지 서버 장애가 아니다. 400으로 올려야 화면이 재발급 안내로 이어진다.
    throw new SlackWebApiError(`Slack 토큰을 확인하지 못했습니다. (${detail})`, error instanceof SlackWebApiError && error.status === 429 ? 429 : 400);
  }
}

export function clearSlackWeb(session: SlackWebSession): void {
  session.token = undefined;
  session.tokenType = undefined;
  session.teamId = undefined;
  session.teamName = undefined;
  session.userId = undefined;
  session.userName = undefined;
  session.workspaceUrl = undefined;
}

export function slackWebStatus(session: SlackWebSession) {
  return session.token
    ? {
      connected: true as const,
      tokenType: session.tokenType,
      teamId: session.teamId,
      teamName: session.teamName,
      userId: session.userId,
      userName: session.userName,
    }
    : { connected: false as const };
}
