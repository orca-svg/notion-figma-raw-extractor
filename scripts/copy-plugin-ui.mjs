// build:plugin에서 cp를 쓰면 Windows의 cmd.exe에는 그런 명령이 없어 setup.ps1이 통째로 실패한다.
// tsc는 ui.html을 옮겨 주지 않으므로 복사만 Node로 대신한다.
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(projectRoot, "plugins", "figma-trace", "ui.html");
const target = path.join(projectRoot, "plugins", "figma-trace", "dist", "ui.html");

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
