import { createHash, randomBytes } from "node:crypto";

const MCP_ENDPOINT = "https://mcp.notion.com/mcp";

export type OAuthMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
};

export type ClientCredentials = {
  client_id: string;
  client_secret?: string;
};

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  user_id?: string;
  workspace_id?: string;
  email_domain?: string;
};

function base64Url(value: Buffer): string {
  return value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function createState(): string {
  return randomBytes(32).toString("hex");
}

export async function discoverOAuthMetadata(mcpEndpoint = MCP_ENDPOINT): Promise<OAuthMetadata> {
  const resourceUrl = new URL("/.well-known/oauth-protected-resource", mcpEndpoint);
  const resourceResponse = await fetch(resourceUrl);
  if (!resourceResponse.ok) {
    throw new Error(`OAuth 보호 리소스 확인 실패 (${resourceResponse.status})`);
  }
  const resource = (await resourceResponse.json()) as { authorization_servers?: string[] };
  const authorizationServer = resource.authorization_servers?.[0];
  if (!authorizationServer) {
    throw new Error("Notion OAuth 서버 주소가 응답에 없습니다.");
  }
  const metadataUrl = new URL("/.well-known/oauth-authorization-server", authorizationServer);
  const metadataResponse = await fetch(metadataUrl);
  if (!metadataResponse.ok) {
    throw new Error(`OAuth 메타데이터 확인 실패 (${metadataResponse.status})`);
  }
  const metadata = (await metadataResponse.json()) as OAuthMetadata;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("OAuth 메타데이터에 필수 엔드포인트가 없습니다.");
  }
  return metadata;
}

export async function registerClient(metadata: OAuthMetadata, redirectUri: string, clientUri = "http://127.0.0.1:5173", clientName = "Notion MCP Trace Lab"): Promise<ClientCredentials> {
  if (!metadata.registration_endpoint) {
    throw new Error("Notion OAuth 서버가 동적 클라이언트 등록 주소를 제공하지 않았습니다.");
  }
  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      client_uri: clientUri,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth 클라이언트 등록 실패 (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as ClientCredentials;
}

export function buildAuthorizationUrl(input: {
  metadata: OAuthMetadata;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  if (input.scope) params.set("scope", input.scope);
  return `${input.metadata.authorization_endpoint}?${params.toString()}`;
}

async function tokenRequest(metadata: OAuthMetadata, params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Notion-MCP-Trace-Lab/1.0",
    },
    body: params,
  });
  const text = await response.text();
  if (!response.ok) {
    let reason = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error === "invalid_grant") reason = "REAUTH_REQUIRED";
    } catch {
      // Keep the response text when the server did not return JSON.
    }
    throw new Error(reason);
  }
  const tokens = JSON.parse(text) as TokenResponse;
  if (!tokens.access_token) throw new Error("토큰 응답에 access_token이 없습니다.");
  return tokens;
}

export function exchangeCode(input: {
  code: string;
  verifier: string;
  metadata: OAuthMetadata;
  credentials: ClientCredentials;
  redirectUri: string;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.credentials.client_id,
    redirect_uri: input.redirectUri,
    code_verifier: input.verifier,
  });
  if (input.credentials.client_secret) params.set("client_secret", input.credentials.client_secret);
  return tokenRequest(input.metadata, params);
}

export function refreshToken(input: {
  refreshToken: string;
  metadata: OAuthMetadata;
  credentials: ClientCredentials;
}): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.credentials.client_id,
  });
  if (input.credentials.client_secret) params.set("client_secret", input.credentials.client_secret);
  return tokenRequest(input.metadata, params);
}
