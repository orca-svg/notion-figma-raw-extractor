import { useState } from "react";
import { getRun } from "../api";

export function ExportActions({ provider, runId }: { provider: "notion" | "figma" | "slack"; runId?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "loading" | "done" | "error">("idle");
  if (!runId) return null;

  const copy = async () => {
    setCopyState("loading");
    try {
      const payload = await getRun(provider, runId);
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div className="export-actions" aria-label="실행 결과 내보내기">
      <button type="button" onClick={() => void copy()} disabled={copyState === "loading"}>{copyState === "loading" ? "준비 중" : copyState === "done" ? "JSON 복사됨" : copyState === "error" ? "다시 복사" : "전체 JSON 복사"}</button>
      <a href={`/api/${provider}/runs/${encodeURIComponent(runId)}/bundle.zip`} download>ZIP 번들 받기</a>
      <small>실행 후 30분 동안 제공됩니다.</small>
    </div>
  );
}
