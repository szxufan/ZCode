import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

import engineeringTestFiles from "./scripts/engineering-test-files.json";

// 上游已按 docs/testing/unit-test-quality.md 退役 App 单测，仅保留显式清单的 engineering
// 串行工程；本 fork 保留 unit + fork-isolated 工程承接自有功能的单测（定时发送、提示词
// 配置档等），并接收上游仍同步保留的 .test.ts。两套并存时 engineering 清单内的文件必须
// 从 unit 排除，避免同一文件在 threads 与串行 fork 各跑一遍。
const forkIsolatedTests = [
  // 真实显示进程树的进程生命周期用例；上游删除的同类文件已随之移除。
  "packages/services/test/zcodeAgentService.v4.test.ts",
  "packages/services/test/zcodeAgentProcessManager.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 官方依赖图不追踪 setupFiles；公共配置变化必须明确选中整个工程套件并报告跳过。
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
      // managed worktree 路径含 .codex，globstar 默认不匹配隐藏目录；关键入口用精确绝对路径。
      ...[
        "package.json",
        "vitest.config.ts",
        "vitest.setup.ts",
        "scripts/engineering-test-files.json",
      ].map((file) => resolve(__dirname, file)),
    ],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            // 架构治理要求 managed 模块自带 contract.test.ts（见 architecture-policy.yaml），放在模块目录内。
            "packages/*/src/**/contract.test.ts",
            // Gen UI 目录回归位于源码旁，默认入口也必须执行，避免只在手动定向运行时生效。
            "packages/shared/src/node/genUiPaths.test.ts",
            "packages/services/src/gen-ui/**/*.test.ts",
          ],
          exclude: [
            "packages/desktop/test/e2e/**",
            "packages/zcode-cua/**",
            ...engineeringTestFiles,
            ...forkIsolatedTests,
          ],
          // Node 24/macOS 的 threads 全量运行可触发 V8 SIGSEGV；诊断时切换进程隔离，测试范围不变。
          pool: process.env.ZCODE_TEST_POOL === "forks" ? "forks" : "threads",
          maxWorkers: process.env.ZCODE_TEST_POOL === "forks" ? 2 : 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "fork-isolated",
          include: forkIsolatedTests,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "engineering",
          include: engineeringTestFiles,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      "packages/zcode-cua/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
