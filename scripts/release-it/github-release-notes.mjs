#!/usr/bin/env node
// 从 CHANGELOG.md 提取指定版本的说明段落，供 .github/workflows/release.yml 的 release job
// 生成 GitHub Release body。CHANGELOG.md 由 `pnpm release`（release-it）在发版提交中生成并
// 随 tag 一起推送；手动补打历史 tag 或首次发版时文件/对应段落可能缺失，此时回退为默认说明，
// 保证发版流程不因说明缺失而失败（发版产物本身不依赖本段内容）。
//
// 用法：
//   node scripts/release-it/github-release-notes.mjs --version 3.16.2 [--changelog CHANGELOG.md]
import { readFile } from "node:fs/promises";
import process from "node:process";

const usage = `Usage:
  node scripts/release-it/github-release-notes.mjs --version <semver> [--changelog <path>]

Options:
  --version <semver>   Required. Release version, e.g. 3.16.2 (no leading "v").
  --changelog <path>   CHANGELOG file. Defaults to CHANGELOG.md at the repo root.
  --help, -h           Show this help.
`;

function parseArgs(argv) {
  const options = {
    changelogPath: "CHANGELOG.md",
    help: false,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--version" || arg.startsWith("--version=")) {
      options.version = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[(index += 1)];
      continue;
    }
    if (arg === "--changelog" || arg.startsWith("--changelog=")) {
      options.changelogPath = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : argv[(index += 1)];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n${usage}`);
  }

  if (options.help) {
    return options;
  }
  if (!options.version || !/^\d+\.\d+\.\d+/.test(options.version)) {
    throw new Error(`Missing or invalid --version: ${options.version}\n${usage}`);
  }
  return options;
}

// release-it（conventional-changelog）产出的标题形如 "## [3.16.2](compare-url) (date)" 或
// "## 3.16.2"。用 (?![\d.]) 防止 3.16.2 误命中 3.16.20。
function buildHeadingPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^##\\s+\\[?v?${escaped}(?![\\d.])`, "m");
}

function extractSection(markdown, version) {
  const match = markdown.match(buildHeadingPattern(version));
  if (!match) {
    return null;
  }
  const start = match.index;
  const nextHeading = markdown.indexOf("\n## ", start + match[0].length);
  const section = nextHeading === -1 ? markdown.slice(start) : markdown.slice(start, nextHeading);
  return section.trim();
}

function fallbackNotes(version) {
  return [
    `## ZCode ${version}`,
    "",
    "The CHANGELOG section for this version was not found (the release commit may predate",
    "the CHANGELOG or the tag was created manually). See the commit history for details.",
  ].join("\n");
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage);
  process.exit(0);
}

const markdown = await readFile(options.changelogPath, "utf8").catch(() => null);
const section = markdown ? extractSection(markdown, options.version) : null;
console.log(section ?? fallbackNotes(options.version));
