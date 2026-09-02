import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync, type Zippable } from "fflate";

export const PILOT_ROOT_FILES = [
  ".env.example",
  ".nvmrc",
  "PILOT-START.md",
  "README.md",
  "index.html",
  "notion_sample_rows_26.csv",
  "package-lock.json",
  "package.json",
  "setup.bat",
  "setup.command",
  "start.bat",
  "start.command",
  "tsconfig.app.json",
  "tsconfig.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vitest.config.ts",
] as const;

export const PILOT_DIRECTORIES = ["oauth-broker", "plugins", "public", "scripts", "server", "src", "tests"] as const;

const TEXT_EXTENSIONS = new Set([".bat", ".command", ".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yml", ".yaml"]);
const CREDENTIAL_PATTERN = /(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|figd_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._-]{24,})/;

export function isBlockedPilotPath(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".git" || segment === "node_modules" || segment === "release")) return true;
  if (segments.some((segment) => segment === ".DS_Store" || segment.endsWith(".log"))) return true;
  if (
    segments.some((segment) => segment === "dist")
    && normalized !== "plugins/figma-trace/dist"
    && !normalized.startsWith("plugins/figma-trace/dist/")
  ) return true;
  if (segments.some((segment) => segment === ".env")) return true;
  if (segments.some((segment) => segment.startsWith(".env.") && segment !== ".env.example")) return true;
  return false;
}

export function assertSafePilotText(relativePath: string, text: string): void {
  if (CREDENTIAL_PATTERN.test(text)) throw new Error(`${relativePath}에 credential 형태의 값이 있어 ZIP 생성을 중단했습니다.`);
  if (/\/(?:Users|home)\/[^/\s]+\//.test(text)) throw new Error(`${relativePath}에 개인 절대 경로가 있어 ZIP 생성을 중단했습니다.`);
}

async function collectDirectory(root: string, relativeDirectory: string, files: string[]): Promise<void> {
  const absoluteDirectory = path.join(root, relativeDirectory);
  for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (isBlockedPilotPath(relativePath)) continue;
    if (entry.isDirectory()) await collectDirectory(root, relativePath, files);
    else if (entry.isFile()) files.push(relativePath);
  }
}

export async function collectPilotFiles(root: string): Promise<string[]> {
  const files = [...PILOT_ROOT_FILES];
  for (const directory of PILOT_DIRECTORIES) await collectDirectory(root, directory, files);
  return [...new Set(files)].sort();
}

export async function createPilotArchive(root: string): Promise<{ outputPath: string; files: string[]; bytes: number }> {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };
  const files = await collectPilotFiles(root);
  for (const required of ["plugins/figma-trace/dist/code.js", "plugins/figma-trace/dist/ui.html"]) {
    if (!files.includes(required)) throw new Error(`${required}가 없습니다. npm run build:plugin을 먼저 실행해 주세요.`);
  }

  const archive: Zippable = {};
  const packageRoot = "mcp-trace-studio-pilot";
  const mtime = new Date("2026-01-01T00:00:00.000Z");
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath);
    const data = new Uint8Array(await readFile(absolutePath));
    if (TEXT_EXTENSIONS.has(path.extname(relativePath)) || path.basename(relativePath).startsWith(".env")) {
      assertSafePilotText(relativePath, new TextDecoder().decode(data));
    }
    const fileStat = await stat(absolutePath);
    const mode = relativePath.endsWith(".command") ? 0o755 : fileStat.mode & 0o777;
    archive[`${packageRoot}/${relativePath.split(path.sep).join("/")}`] = [data, { level: 6, os: 3, attrs: mode << 16, mtime }];
  }
  archive[`${packageRoot}/PILOT-VERSION.txt`] = [strToU8(`${packageJson.version}\n`), { level: 0, os: 3, attrs: 0o644 << 16, mtime }];

  const zipped = zipSync(archive, { level: 6 });
  const outputDirectory = path.join(root, "release");
  const outputPath = path.join(outputDirectory, `mcp-trace-studio-pilot-v${packageJson.version}.zip`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(outputPath, zipped);
  return { outputPath, files, bytes: zipped.byteLength };
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(scriptPath), "..");
  const result = await createPilotArchive(root);
  process.stdout.write(`Pilot ZIP: ${result.outputPath}\nFiles: ${result.files.length + 1}\nBytes: ${result.bytes}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
