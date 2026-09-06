import { parseSlackExportZip } from "./slack-export.js";
import type { EmitEvent, ExtractionEvent, SlackImportRecord, SlackRunRecord } from "./types.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function runSlackExportExtraction(
  source: SlackImportRecord,
  run: SlackRunRecord,
  emit: EmitEvent,
): Promise<void> {
  let order = 0;
  const publish = async (event: ExtractionEvent) => emit({ ...event, provider: "slack", runId: run.id, origin: "internal" });
  const startedAt = new Date().toISOString();
  await publish({
    type: "step",
    id: "01-validate",
    order: ++order,
    group: "validate",
    label: "Slack Export ZIP 보안 검사",
    state: "running",
    startedAt,
    request: { filename: source.filename, bytes: source.data.byteLength },
  });
  const started = performance.now();
  const normalized = parseSlackExportZip(source.data);
  await publish({
    type: "step",
    id: "01-validate",
    order,
    group: "validate",
    label: "Slack Export ZIP 보안 검사",
    state: "success",
    startedAt,
    elapsedMs: Math.round(performance.now() - started),
    extracted: normalized.provenance,
  });
  run.normalized = normalized;
  // Standard Export든 Corporate Export든 똑같이 읽지만, 담긴 범위는 ZIP마다 다르다.
  // DM이 0건인 것과 애초에 안 담긴 것을 구분해 알려 줘야 담당자가 다시 요청할지 판단할 수 있다.
  const composition = record(normalized.provenance.composition);
  const dmCount = Number(composition?.directMessages ?? 0) + Number(composition?.groupDirectMessages ?? 0);
  const scopeNote = dmCount
    ? `DM ${dmCount}개가 함께 들어왔습니다.`
    : "이 ZIP에는 DM이 들어 있지 않습니다. 공개 채널만 담는 Standard Export일 수 있으며, DM이 필요하면 관리자에게 DM을 포함한 Export를 요청해야 합니다.";
  await publish({
    type: "step",
    id: "02-normalize",
    order: ++order,
    group: "normalize",
    label: "사용자·대화·스레드·파일 참조 정규화",
    state: "success",
    startedAt: new Date().toISOString(),
    extracted: {
      users: normalized.users.length,
      conversations: normalized.conversations.length,
      ...composition,
      messages: normalized.messages.length,
      threads: normalized.messages.filter((message) => Boolean(message.threadTs)).length,
      files: normalized.files.length,
    },
    message: `${scopeNote} Slack JSON Export에는 일반적으로 실제 첨부 바이너리가 아니라 인증이 필요한 파일 링크가 포함됩니다.`,
  });
  await publish({
    type: "complete",
    id: "03-summary",
    order: ++order,
    group: "summary",
    label: "Slack Export 추출 완료",
    state: "success",
    startedAt: new Date().toISOString(),
    extracted: {
      source: "slack_export",
      scope: normalized.provenance.exportScope,
      users: normalized.users.length,
      conversations: normalized.conversations.length,
      ...composition,
      messages: normalized.messages.length,
      files: normalized.files.length,
    },
    message: "정규화한 대화와 provenance를 ZIP으로 받을 수 있습니다.",
  });
}
