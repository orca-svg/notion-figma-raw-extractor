// NODE_ENV=production을 명령 앞에 붙이는 건 POSIX 셸 문법이라 Windows의 cmd.exe에서는 그대로 실패한다.
// 환경 변수를 여기서 세우고 tsx 로더를 등록한 뒤 서버를 불러온다.
process.env.NODE_ENV ??= "production";

const { register } = await import("tsx/esm/api");
register();

await import("../server/index.ts");
