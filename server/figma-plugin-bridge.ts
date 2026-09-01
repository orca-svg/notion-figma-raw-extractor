import { randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  FigmaPluginExtractionResult,
  FigmaPluginJob,
  FigmaPluginMeta,
  FigmaTarget,
  FigmaFileType,
} from "./types.js";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const CONNECTION_STALE_MS = 35 * 1000;
/** 총 소요 시간이 아니라 "소식이 끊긴 시간"의 한계다. 업로드·하트비트가 올 때마다 다시 잰다. */
const JOB_IDLE_TTL_MS = 90 * 1000;
const MAX_FAILED_PAIR_ATTEMPTS = 5;
const MAX_ARTIFACT_BYTES = 48 * 1024 * 1024;
// 플러그인 파트 예산(24MB)보다 커야 한다. 같거나 작으면 예산에 딱 맞춘 파트가 전송에서 거부된다.
// 파트 "크기"를 키울 이유는 없다. 트리가 커지면 분할이 파트 "개수"를 늘려 감당한다.
const MAX_JSON_PART_BYTES = 32 * 1024 * 1024;
// NH 실제 파일은 데모(8만 노드)보다 크다. 총량에서 막히면 전량 추출이라는 목적이 무너지므로
// 파트 개수는 사실상 열어 두고, 메모리 한계는 아래 Node 힙 설정으로 받친다.
const MAX_JOB_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

type Pairing = {
  code: string;
  ownerSessionId: string;
  expiresAt: number;
};

type Connection = {
  token: string;
  ownerSessionId: string;
  meta: FigmaPluginMeta;
  lastSeenAt: number;
  queuedJobs: string[];
  waiter?: (job: FigmaPluginJob | undefined) => void;
};

type UploadedArtifact = {
  data: Uint8Array;
  mimeType: string;
};

type PendingJob = {
  job: FigmaPluginJob;
  ownerSessionId: string;
  connectionToken: string;
  artifacts: Map<string, UploadedArtifact>;
  artifactBytes: number;
  resolve: (value: CompletedPluginJob) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};

type FailedAttempts = { count: number; expiresAt: number };

export type CompletedPluginJob = {
  result: FigmaPluginExtractionResult;
  artifacts: Map<string, UploadedArtifact>;
};

function safeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function pairingCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export class FigmaPluginBridge {
  private readonly pairings = new Map<string, Pairing>();
  private readonly connections = new Map<string, Connection>();
  private readonly jobs = new Map<string, PendingJob>();
  private readonly failedAttempts = new Map<string, FailedAttempts>();

  createPairing(ownerSessionId: string): { code: string; expiresAt: string } {
    this.cleanup();
    for (const [code, pairing] of this.pairings) {
      if (pairing.ownerSessionId === ownerSessionId) this.pairings.delete(code);
    }
    let code = pairingCode();
    while (this.pairings.has(code)) code = pairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.pairings.set(code, { code, ownerSessionId, expiresAt });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  completePairing(code: string, meta: FigmaPluginMeta, sourceKey: string): { sessionToken: string; pollUrl: string } {
    this.cleanup();
    const failed = this.failedAttempts.get(sourceKey);
    if (failed && failed.count >= MAX_FAILED_PAIR_ATTEMPTS && failed.expiresAt > Date.now()) {
      throw new Error("페어링 시도가 너무 많습니다. 5분 뒤 다시 시도해 주세요.");
    }
    const pairing = this.pairings.get(code);
    if (!pairing || pairing.expiresAt <= Date.now()) {
      const next = failed && failed.expiresAt > Date.now() ? failed.count + 1 : 1;
      this.failedAttempts.set(sourceKey, { count: next, expiresAt: Date.now() + PAIRING_TTL_MS });
      throw new Error("페어링 코드가 잘못되었거나 만료되었습니다.");
    }
    this.pairings.delete(code);
    this.failedAttempts.delete(sourceKey);
    for (const [token, connection] of this.connections) {
      if (connection.ownerSessionId === pairing.ownerSessionId) this.dropConnection(token, "새 플러그인 연결로 교체되었습니다.");
    }
    const token = randomBytes(32).toString("base64url");
    this.connections.set(token, {
      token,
      ownerSessionId: pairing.ownerSessionId,
      meta,
      lastSeenAt: Date.now(),
      queuedJobs: [],
    });
    return { sessionToken: token, pollUrl: "/api/figma/plugin/jobs/next" };
  }

  status(ownerSessionId: string) {
    this.cleanup();
    const connection = [...this.connections.values()].find((candidate) => candidate.ownerSessionId === ownerSessionId);
    if (!connection) return { connected: false as const };
    return {
      connected: true as const,
      lastSeenAt: new Date(connection.lastSeenAt).toISOString(),
      meta: connection.meta,
    };
  }

  /** Trace Studio에서 끊는다. 플러그인은 다음 poll에서 401을 받아 스스로 페어링 화면으로 돌아간다. */
  disconnect(ownerSessionId: string): boolean {
    const connection = [...this.connections.values()].find((candidate) => candidate.ownerSessionId === ownerSessionId);
    if (!connection) return false;
    this.dropConnection(connection.token, "Trace Studio에서 연결을 끊었습니다.");
    return true;
  }

  authenticate(token: string | undefined): Connection {
    this.cleanup();
    if (!token) throw new Error("플러그인 세션 토큰이 없습니다.");
    const connection = [...this.connections.values()].find((candidate) => safeTokenEqual(token, candidate.token));
    if (!connection) throw new Error("플러그인 세션이 만료되었습니다. 다시 페어링해 주세요.");
    connection.lastSeenAt = Date.now();
    return connection;
  }

  async nextJob(token: string, signal?: AbortSignal, waitMs = 20_000): Promise<FigmaPluginJob | undefined> {
    const connection = this.authenticate(token);
    while (connection.queuedJobs.length) {
      const id = connection.queuedJobs.shift();
      if (!id) break;
      const pending = this.jobs.get(id);
      if (pending && !pending.settled) return pending.job;
    }
    connection.waiter?.(undefined);
    return new Promise<FigmaPluginJob | undefined>((resolve) => {
      let done = false;
      const finish = (job: FigmaPluginJob | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (connection.waiter === finish) connection.waiter = undefined;
        resolve(job);
      };
      const abort = () => finish(undefined);
      const timer = setTimeout(() => finish(undefined), waitMs);
      connection.waiter = finish;
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  requestExtraction(ownerSessionId: string, target: FigmaTarget, signal?: AbortSignal): Promise<CompletedPluginJob> {
    return this.requestJob(ownerSessionId, {
      id: randomUUID(),
      type: "extract_node",
      target,
      options: this.jobOptions(),
    }, signal);
  }

  requestPageExtraction(ownerSessionId: string, fileKey: string, fileType: FigmaFileType, signal?: AbortSignal): Promise<CompletedPluginJob> {
    return this.requestJob(ownerSessionId, {
      id: randomUUID(),
      type: "extract_page",
      fileKey,
      fileType,
      options: this.jobOptions(),
    }, signal);
  }

  private jobOptions() {
    return {
      // 노드 개수가 아니라 바이트가 진짜 예산이다. 개수 상한이 먼저 걸려 바이트의 26%만 쓰던 문제를
      // 없애고, 넘치는 트리는 서브트리 파트로 나눈다.
      // 페이지 경로는 분할이 처리하므로 개수로 자르지 않는다. 노드 단건 추출의 안전판으로만 남긴다.
      maxNodes: 500_000,
      maxJsonBytes: 24 * 1024 * 1024,
      maxDimension: 2_048,
      // 래스터 이미지는 imageHash로만 참조되므로 못 뽑으면 픽셀이 어디에도 남지 않는다.
      // 20개에서 끊으면 조용히 사라지므로 실질 무제한으로 두고, 못 담은 것은 수치로 보고한다.
      maxAssets: 50_000,
      maxAssetBytes: MAX_ARTIFACT_BYTES,
    };
  }

  private requestJob(ownerSessionId: string, job: FigmaPluginJob, signal?: AbortSignal): Promise<CompletedPluginJob> {
    this.cleanup();
    const connection = [...this.connections.values()].find((candidate) => candidate.ownerSessionId === ownerSessionId);
    if (!connection) return Promise.reject(new Error("Figma 플러그인이 연결되어 있지 않습니다."));
    if (Date.now() - connection.lastSeenAt > CONNECTION_STALE_MS) {
      this.dropConnection(connection.token, "Figma 플러그인의 응답이 끊겼습니다.");
      return Promise.reject(new Error("Figma 플러그인의 응답이 끊겼습니다. 플러그인을 다시 열어 주세요."));
    }
    const active = [...this.jobs.values()].find((candidate) => candidate.connectionToken === connection.token && !candidate.settled);
    if (active) return Promise.reject(new Error("이 Figma 플러그인은 이미 다른 추출을 실행 중입니다."));

    return new Promise<CompletedPluginJob>((resolve, reject) => {
      const pending: PendingJob = {
        job,
        ownerSessionId,
        connectionToken: connection.token,
        artifacts: new Map(),
        artifactBytes: 0,
        resolve,
        reject,
        settled: false,
        timer: setTimeout(() => this.failJob(job.id, new Error("Figma 플러그인 추출 시간이 초과되었습니다.")), JOB_IDLE_TTL_MS),
      };
      this.jobs.set(job.id, pending);
      if (connection.waiter) {
        const waiter = connection.waiter;
        connection.waiter = undefined;
        waiter(job);
      } else connection.queuedJobs.push(job.id);

      const abort = () => this.failJob(job.id, new Error("Figma 플러그인 추출이 취소되었습니다."));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  uploadArtifact(token: string, jobId: string, slot: string, mimeType: string, data: Uint8Array): void {
    const connection = this.authenticate(token);
    const pending = this.requireJob(connection, jobId);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(slot)) throw new Error("artifact slot 형식이 잘못되었습니다.");
    const limit = mimeType === "application/json" ? MAX_JSON_PART_BYTES : MAX_ARTIFACT_BYTES;
    if (data.byteLength > limit) throw new Error(`artifact 하나는 ${Math.round(limit / 1024 / 1024)}MB를 넘을 수 없습니다.`);
    const previous = pending.artifacts.get(slot)?.data.byteLength ?? 0;
    if (pending.artifactBytes - previous + data.byteLength > MAX_JOB_ARTIFACT_BYTES) throw new Error(`실행 artifact는 총 ${Math.round(MAX_JOB_ARTIFACT_BYTES / 1024 / 1024)}MB를 넘을 수 없습니다.`);
    pending.artifacts.set(slot, { data, mimeType });
    pending.artifactBytes = pending.artifactBytes - previous + data.byteLength;
    this.touchJob(pending);
  }

  /** 추출이 길어져도 플러그인이 살아 있다고 알려오는 동안에는 작업을 끊지 않는다. */
  heartbeat(token: string, jobId: string): void {
    const connection = this.authenticate(token);
    this.touchJob(this.requireJob(connection, jobId));
  }

  private touchJob(pending: PendingJob): void {
    if (pending.settled) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.failJob(pending.job.id, new Error("Figma 플러그인 추출 시간이 초과되었습니다.")), JOB_IDLE_TTL_MS);
  }

  submitResult(token: string, jobId: string, result: FigmaPluginExtractionResult): void {
    const connection = this.authenticate(token);
    const pending = this.requireJob(connection, jobId);
    const expectedFileKey = pending.job.type === "extract_node" ? pending.job.target.fileKey : pending.job.fileKey;
    if (result.meta.fileKey !== expectedFileKey) {
      this.failJob(jobId, new Error("열린 Figma 파일과 입력한 링크의 file key가 다릅니다."));
      return;
    }
    if (pending.job.type === "extract_node" && result.meta.nodeId !== pending.job.target.nodeId) {
      this.failJob(jobId, new Error("플러그인이 반환한 node ID가 요청과 다릅니다."));
      return;
    }
    if (pending.job.type === "extract_page" && (!result.page || result.scope !== "current_page")) {
      this.failJob(jobId, new Error("플러그인이 현재 페이지 결과를 반환하지 않았습니다."));
      return;
    }
    for (const artifact of result.artifacts) {
      const uploaded = pending.artifacts.get(artifact.slot);
      if (!uploaded || uploaded.data.byteLength !== artifact.bytes) {
        this.failJob(jobId, new Error(`artifact ${artifact.slot} 업로드가 완료되지 않았습니다.`));
        return;
      }
    }
    pending.settled = true;
    clearTimeout(pending.timer);
    this.jobs.delete(jobId);
    pending.resolve({ result, artifacts: pending.artifacts });
  }

  submitError(token: string, jobId: string, message: string): void {
    const connection = this.authenticate(token);
    this.requireJob(connection, jobId);
    this.failJob(jobId, new Error(message || "Figma 플러그인 추출에 실패했습니다."));
  }

  private requireJob(connection: Connection, jobId: string): PendingJob {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.settled || pending.connectionToken !== connection.token) throw new Error("플러그인 작업이 없거나 만료되었습니다.");
    return pending;
  }

  private failJob(jobId: string, error: Error): void {
    const pending = this.jobs.get(jobId);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.jobs.delete(jobId);
    pending.reject(error);
  }

  private dropConnection(token: string, reason: string): void {
    const connection = this.connections.get(token);
    if (!connection) return;
    connection.waiter?.(undefined);
    this.connections.delete(token);
    for (const pending of this.jobs.values()) {
      if (pending.connectionToken === token) this.failJob(pending.job.id, new Error(reason));
    }
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [code, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(code);
    for (const [source, failed] of this.failedAttempts) if (failed.expiresAt <= now) this.failedAttempts.delete(source);
    for (const [token, connection] of this.connections) {
      if (now - connection.lastSeenAt > CONNECTION_STALE_MS) this.dropConnection(token, "Figma 플러그인 연결이 만료되었습니다.");
    }
  }
}

export function bearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}
