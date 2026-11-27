import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

const { scripts } = packageJson;

// 推送门禁只输出错误；完整 warning 诊断仍保留在 pnpm lint 入口。
assert.match(scripts["lint:gate"] ?? "", /^oxlint --quiet &&/);
assert.match(scripts["verify:pre-push"] ?? "", /pnpm run lint:gate/);
assert.doesNotMatch(scripts["verify:pre-push"] ?? "", /pnpm run lint(?!:gate)/);
