import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const dockerfilePath = fileURLToPath(new URL("../Dockerfile", import.meta.url));

function getStage(dockerfile: string, name: string): string {
  const match = dockerfile.match(
    new RegExp(`^FROM [^\\n]+ AS ${name}\\r?\\n([\\s\\S]*?)(?=^FROM |$(?![\\s\\S]))`, "m"),
  );
  if (!match || match[1] === undefined) throw new Error(`Dockerfile 缺少 ${name} 阶段`);
  return match[1];
}

describe("relay-server Dockerfile", () => {
  it.each(["deps-relay", "deps-web"])("%s 在安装依赖前提供 pnpm 补丁", async (name) => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const stage = getStage(dockerfile, name);
    const copyPatches = "COPY patches ./patches";
    const install = "RUN pnpm install ";

    // pnpm 会读取根配置中的全部 patchedDependencies；缺少 patches/ 时即使过滤安装也会失败。
    expect(stage).toContain(install);
    expect(stage).toContain(copyPatches);
    expect(stage.indexOf(copyPatches)).toBeLessThan(stage.indexOf(install));
  });

  it.each(["deps-relay", "deps-web"])("%s 提供根清单引用的 workspace 包", async (name) => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const stage = getStage(dockerfile, name);

    // frozen-lockfile 会校验根清单，即使 --filter 不安装根包也要求其 workspace 链接可解析。
    for (const packageDir of ["packages/shared", "packages/zcode-cua"]) {
      expect(stage).toContain(`COPY ${packageDir}/package.json ./${packageDir}/package.json`);
    }
  });

  it("build-web 在构建前提供 shared 继承的根 tsconfig", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const stage = getStage(dockerfile, "build-web");
    const copyTsconfig = "COPY tsconfig.base.json ./";
    const build = "RUN pnpm --filter @zcode/web build";

    // Vite 转换 shared 源码时会解析其 extends；缺少根 tsconfig 会报 Tsconfig not found。
    expect(stage).toContain(build);
    expect(stage).toContain(copyTsconfig);
    expect(stage.indexOf(copyTsconfig)).toBeLessThan(stage.indexOf(build));
  });
});
