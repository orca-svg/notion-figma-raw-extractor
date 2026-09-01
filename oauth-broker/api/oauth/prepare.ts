import { allowPost, brokerOrigin, requiredEnv, sendError } from "../../lib/http.js";
import { sealTicket, sha256Base64Url } from "../../lib/tickets.js";
import type { BrokerRequest, BrokerResponse } from "../../lib/vercel-types.js";

export default function handler(req: BrokerRequest, res: BrokerResponse) {
  if (!allowPost(req, res)) return;
  try {
    const codeVerifier = typeof req.body?.codeVerifier === "string" ? req.body.codeVerifier : "";
    const redeemSecretHash = typeof req.body?.redeemSecretHash === "string" ? req.body.redeemSecretHash : "";
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(codeVerifier)) throw new Error("PKCE verifier 형식이 잘못되었습니다.");
    if (!/^[A-Za-z0-9_-]{43}$/.test(redeemSecretHash)) throw new Error("redeem secret hash 형식이 잘못되었습니다.");
    const now = Date.now();
    const state = sealTicket({ type: "flow", codeVerifier, redeemSecretHash, createdAt: now, expiresAt: now + 5 * 60 * 1000 }, requiredEnv("BROKER_TICKET_SECRET"));
    const redirectUri = `${brokerOrigin(req)}/api/oauth/callback`;
    const auth = new URL("https://www.figma.com/oauth");
    auth.searchParams.set("client_id", requiredEnv("FIGMA_REST_CLIENT_ID"));
    auth.searchParams.set("redirect_uri", redirectUri);
    auth.searchParams.set("scope", "current_user:read file_content:read file_metadata:read file_comments:read file_versions:read");
    auth.searchParams.set("state", state);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    auth.searchParams.set("code_challenge_method", "S256");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ authUrl: auth.toString() });
  } catch (error) {
    sendError(res, error);
  }
}
