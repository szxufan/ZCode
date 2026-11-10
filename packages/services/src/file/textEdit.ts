import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import iconv from "iconv-lite";
import * as prettier from "prettier";
import * as babelPlugin from "prettier/plugins/babel";
import * as estreePlugin from "prettier/plugins/estree";
import * as typescriptPlugin from "prettier/plugins/typescript";
import * as markdownPlugin from "prettier/plugins/markdown";
import * as yamlPlugin from "prettier/plugins/yaml";
import * as htmlPlugin from "prettier/plugins/html";
import * as postcssPlugin from "prettier/plugins/postcss";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { FILE_TEXT_MAX_BYTES } from "@zcode/shared";
import type {
  FileLineEndings,
  FileRevision,
  FileTextEncoding,
  TextEditBlockReason,
  TextEditCapability,
  TextEditErrorCode,
  TextFormatCapability,
  TextFormatResult,
  WriteTextFileParams,
  WriteTextFileResult,
} from "@zcode/shared";
import { atomicWriteText, withAtomicFileLock } from "../fs/atomicFileUtils.js";

/**
 * 就地编辑与预览共用同一个文本读取上限，单一来源见 `@zcode/shared` 的
 * `FILE_TEXT_MAX_BYTES`；超过后 Monaco 的加载成本也不可接受。
 */
const MAX_EDITABLE_TEXT_BYTES = FILE_TEXT_MAX_BYTES;

const LEGACY_ENCODINGS: readonly FileTextEncoding[] = ["gb18030", "gbk", "gb2312"];
/**
 * 只读静态配置白名单。`prettier.config.js/.cjs/.mjs/.ts` 与 `.prettierrc.js` 等可运行配置
 * 不在列表里——不加载它们就是"不在 Host 内执行仓库代码"这条安全边界的实现方式，
 * 因此这里靠白名单收敛，而不是先列出再逐个排除。
 */
const PRETTIER_CONFIG_FILE_NAMES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
] as const;
const PRETTIER_PLUGINS = [
  babelPlugin,
  estreePlugin,
  typescriptPlugin,
  markdownPlugin,
  yamlPlugin,
  htmlPlugin,
  postcssPlugin,
] as unknown as prettier.Plugin[];

export interface DecodedTextFile {
  encoding: FileTextEncoding;
  /** 保留原始换行，由调用方决定是否归一化。 */
  content: string;
}

export interface TextFileInspection {
  capability: TextEditCapability;
  decoded: DecodedTextFile | null;
  lineEndings: FileLineEndings | null;
}

function bytesEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b);
}

function decodeStrictUtf8(buffer: Buffer): string | null {
  try {
    // ignoreBOM: true 保留 U+FEFF，否则解码会吞掉 BOM，导致往返校验失败并误判为 GBK。
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    return null;
  }
}

/**
 * 找到唯一能"解码后再编码得到原始字节"的编码。
 * 该判据同时覆盖 BOM（UTF-8 解码保留 U+FEFF）和非法字节序列，
 * 保证编辑保存不会改变用户文件的编码。
 */
export function decodeLosslessly(buffer: Buffer): DecodedTextFile | null {
  const utf8 = decodeStrictUtf8(buffer);
  if (utf8 !== null && bytesEqual(Buffer.from(utf8, "utf8"), buffer)) {
    return { encoding: "utf8", content: utf8 };
  }

  for (const encoding of LEGACY_ENCODINGS) {
    try {
      const content = iconv.decode(buffer, encoding);
      if (bytesEqual(iconv.encode(content, encoding), buffer)) {
        return { encoding, content };
      }
    } catch {
      // 单个编码解析失败不影响后续候选。
    }
  }

  return null;
}

export function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return false;
  }
  let suspiciousBytes = 0;
  for (const value of buffer) {
    if (value === 0) {
      return true;
    }
    const isCommonWhitespace = value === 9 || value === 10 || value === 12 || value === 13;
    const isControlChar =
      (value >= 1 && value <= 8) || (value >= 14 && value <= 31) || value === 127;
    if (!isCommonWhitespace && isControlChar) {
      suspiciousBytes += 1;
    }
  }
  return suspiciousBytes / buffer.length > 0.3;
}

export function analyzeLineEndings(content: string): {
  lineEndings: FileLineEndings;
  mixed: boolean;
} {
  let crlfCount = 0;
  let lfCount = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) !== 10) continue;
    if (index > 0 && content.charCodeAt(index - 1) === 13) {
      crlfCount += 1;
    } else {
      lfCount += 1;
    }
  }
  return {
    // 混合换行会被拒绝编辑，这里的取值只用于稳定展示。
    // 没有任何换行符（含空文件）时没有可继承的风格，按 LF 处理，避免首次保存在 macOS/Linux 上写出 CRLF；
    // 两种换行同时出现时按数量取多数，平手取 CRLF。
    lineEndings:
      crlfCount === 0 ? "LF" : lfCount === 0 ? "CRLF" : crlfCount >= lfCount ? "CRLF" : "LF",
    mixed: crlfCount > 0 && lfCount > 0,
  };
}

function normalizeToLf(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function applyLineEndings(content: string, lineEndings: FileLineEndings): string {
  const normalized = normalizeToLf(content);
  return lineEndings === "CRLF" ? normalized.replaceAll("\n", "\r\n") : normalized;
}

function revisionId(mtimeMs: number, sizeBytes: number): string {
  return `mtime:${Math.trunc(mtimeMs)}:size:${sizeBytes}`;
}

export function hashBytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function buildFileRevision(
  info: { mtimeMs: number; size: number },
  hash: string,
): FileRevision {
  return {
    id: revisionId(info.mtimeMs, info.size),
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
    hash,
  };
}

/** 用一次完整读取的结果判定能否无损编辑；不读取文件，便于复用预览已读到的 buffer。 */
export function inspectTextBuffer(buffer: Buffer): TextFileInspection {
  const decoded = decodeLosslessly(buffer);
  if (!decoded) {
    return {
      capability: { editable: false, reason: "not-lossless" },
      decoded: null,
      lineEndings: null,
    };
  }

  const lineEndingInfo = analyzeLineEndings(decoded.content);
  if (lineEndingInfo.mixed) {
    return {
      capability: { editable: false, reason: "mixed-line-endings" },
      decoded: null,
      lineEndings: null,
    };
  }

  return {
    capability: { editable: true },
    decoded,
    lineEndings: lineEndingInfo.lineEndings,
  };
}

export function blockReasonForRead(params: {
  isBinary: boolean;
  truncated: boolean;
  /** 本次读取是否从 0 开始且覆盖全文；分段读取无法判定无损往返。 */
  coversWholeFile: boolean;
}): TextEditBlockReason | null {
  if (params.isBinary) return "binary";
  if (params.truncated) return "too-large";
  // 分段读取不是"Host 版本过低"，用独立原因避免 UI 显示误导性的升级提示。
  if (!params.coversWholeFile) return "partial-read";
  return null;
}

function encodeTextForWrite(params: WriteTextFileParams): Buffer {
  const content = applyLineEndings(params.content, params.lineEndings);
  return params.encoding === "utf8"
    ? Buffer.from(content, "utf8")
    : iconv.encode(content, params.encoding);
}

function errorCodeForWrite(error: unknown): TextEditErrorCode {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "ENOENT") return "file_not_found";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "permission_denied";
  return "io_error";
}

function writeFailure(code: TextEditErrorCode, message: string): WriteTextFileResult {
  return { ok: false, code, message };
}

/** rename 前复查发现内容已变：外部进程不受文件锁约束，只能把覆盖窗口压到最小。 */
class StaleFileBeforeRenameError extends Error {}

/**
 * 原子写并保留原文件权限位。调用方必须已持有文件锁（故传 useFileLock: false）。
 * 复用 atomicWriteText 而不是另写一条写入路径，以继承它的 Windows rename 重试
 * （Defender / 索引服务 / 另一个窗口短暂占用目标文件会抛 EPERM/EBUSY/EACCES）
 * 与崩溃残留临时文件清理。
 */
async function writeEditModeFile(
  path: string,
  content: Buffer,
  mode: number,
  baseHash: string,
): Promise<void> {
  await atomicWriteText(path, content, {
    useFileLock: false,
    mode: mode & 0o777,
    syncBeforeRename: true,
    // Agent 等外部写入不经过本文件锁；rename 前再核对一次内容哈希，
    // 避免"锁内校验通过 → 外部改写 → rename 覆盖"的窗口。
    beforeRename: async () => {
      const latest = await readFile(path).catch(() => null);
      if (latest === null || hashBytes(latest) !== baseHash) {
        throw new StaleFileBeforeRenameError(`File changed before rename: ${path}`);
      }
    },
  });
}

export async function writeTextFile(params: WriteTextFileParams): Promise<WriteTextFileResult> {
  try {
    const info = await lstat(params.path);
    if (info.isSymbolicLink()) {
      return writeFailure("symlink_refused", `Refusing to write through symlink: ${params.path}`);
    }
    if (!info.isFile()) {
      return writeFailure("io_error", `Path is not a file: ${params.path}`);
    }

    const bytes = encodeTextForWrite(params);
    return await withAtomicFileLock(params.path, async () => {
      const currentBytes = await readFile(params.path);
      // 内容哈希相同即视为同一版本：mtime 变化但字节未变不应制造冲突。
      if (hashBytes(currentBytes) !== params.baseRevision.hash) {
        return writeFailure("stale_file", `File changed since it was read: ${params.path}`);
      }

      await writeEditModeFile(params.path, bytes, info.mode, params.baseRevision.hash);
      const nextInfo = await stat(params.path);
      return {
        ok: true as const,
        revision: {
          id: revisionId(nextInfo.mtimeMs, nextInfo.size),
          mtimeMs: nextInfo.mtimeMs,
          sizeBytes: nextInfo.size,
          hash: hashBytes(bytes),
        },
      };
    });
  } catch (error) {
    if (error instanceof StaleFileBeforeRenameError) {
      return writeFailure("stale_file", error.message);
    }
    return writeFailure(
      errorCodeForWrite(error),
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function readTextEditSnapshot(params: { path: string }): Promise<{
  path: string;
  content: string;
  encoding: FileTextEncoding;
  lineEndings: FileLineEndings;
  revision: FileRevision;
  totalBytes: number;
}> {
  const info = await stat(params.path);
  if (!info.isFile()) {
    throw new Error(`Path is not a file: ${params.path}`);
  }
  if (info.size > MAX_EDITABLE_TEXT_BYTES) {
    throw new Error(`File is too large to edit: ${params.path}`);
  }

  const buffer = await readFile(params.path);
  if (isProbablyBinary(buffer)) {
    throw new Error(`Binary file cannot be edited: ${params.path}`);
  }

  const inspection = inspectTextBuffer(buffer);
  if (!inspection.decoded || !inspection.lineEndings) {
    throw new Error(
      `File cannot be edited losslessly (${inspection.capability.reason ?? "unknown"}): ${params.path}`,
    );
  }

  return {
    path: params.path,
    // 编辑器内部统一 LF；保存时由 writeTextFile 还原基线换行。
    content: normalizeToLf(inspection.decoded.content),
    encoding: inspection.decoded.encoding,
    lineEndings: inspection.lineEndings,
    revision: buildFileRevision(info, hashBytes(buffer)),
    totalBytes: buffer.byteLength,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStaticConfig(text: string, filePath: string): Record<string, unknown> | null {
  const name = basename(filePath).toLowerCase();
  if (name === "package.json") {
    try {
      const pkg: unknown = JSON.parse(text);
      return isPlainObject(pkg) && isPlainObject(pkg.prettier) ? pkg.prettier : null;
    } catch {
      return null;
    }
  }

  try {
    if (name.endsWith(".toml")) {
      const parsed: unknown = parseToml(text);
      return isPlainObject(parsed) ? parsed : null;
    }
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      const parsed: unknown = parseYaml(text);
      return isPlainObject(parsed) ? parsed : null;
    }
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // 无扩展名的 .prettierrc 允许 YAML 语法。
    if (name === ".prettierrc") {
      try {
        const parsed: unknown = parseYaml(text);
        return isPlainObject(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** directory 是否等于 root 或位于 root 之内；跨盘符时 relative 会返回绝对路径。 */
function isWithinOrEqual(directory: string, root: string): boolean {
  const rel = relative(root, directory);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 向上查找最近的静态 Prettier 配置。
 * `searchRoot` 是遍历上界（含）：配置发现不得越过 workspace 根，否则用户 home 下的
 * 全局 `.prettierrc` 会被强加给所有项目，远端 Host 上还可能读到 `/root` 下的配置。
 */
async function findPrettierConfig(
  filePath: string,
  searchRoot?: string,
): Promise<{ config: Record<string, unknown>; configPath: string } | null> {
  let directory = dirname(filePath);
  for (;;) {
    if (searchRoot && !isWithinOrEqual(directory, searchRoot)) return null;

    const packageJsonPath = join(directory, "package.json");
    try {
      const config = parseStaticConfig(await readFile(packageJsonPath, "utf8"), packageJsonPath);
      if (config) return { config, configPath: packageJsonPath };
    } catch {
      // 没有或无 prettier 字段时继续向上找。
    }

    for (const name of PRETTIER_CONFIG_FILE_NAMES) {
      const configPath = join(directory, name);
      try {
        const config = parseStaticConfig(await readFile(configPath, "utf8"), configPath);
        if (config) return { config, configPath };
      } catch {
        // 文件不存在或不可读，继续下一个候选。
      }
    }

    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function getTextFormatCapability(
  filePath: string,
  searchRoot?: string,
): Promise<TextFormatCapability> {
  const found = await findPrettierConfig(filePath, searchRoot);
  return found ? { formatter: "prettier", configPath: found.configPath } : { formatter: null };
}

function toFormatOptions(config: Record<string, unknown>): prettier.Options {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    // 不加载配置里的 plugins/pluginSearchDirs，也不让配置覆盖 parser/endOfLine。
    if (
      key === "plugins" ||
      key === "pluginSearchDirs" ||
      key === "parser" ||
      key === "filepath" ||
      key === "endOfLine"
    ) {
      continue;
    }
    options[key] = value;
  }
  return options as prettier.Options;
}

export async function formatTextContent(params: {
  path: string;
  content: string;
  /** 配置发现上界，见 findPrettierConfig；缺省时不向上越界保护，调用方应尽量传入。 */
  workspacePath?: string;
}): Promise<TextFormatResult> {
  let found: Awaited<ReturnType<typeof findPrettierConfig>>;
  try {
    found = await findPrettierConfig(params.path, params.workspacePath);
  } catch (error) {
    return { content: null, error: error instanceof Error ? error.message : String(error) };
  }
  if (!found) {
    return { content: null, skippedReason: "no-config" };
  }

  let parser: string | null = null;
  try {
    const fileInfo = await prettier.getFileInfo(params.path, {
      resolveConfig: false,
      plugins: PRETTIER_PLUGINS,
    });
    parser = fileInfo.inferredParser ?? null;
  } catch {
    parser = null;
  }
  if (!parser) {
    return { content: null, skippedReason: "unsupported-language" };
  }

  try {
    const formatted = await prettier.format(params.content, {
      ...toFormatOptions(found.config),
      parser,
      plugins: PRETTIER_PLUGINS,
    });
    return { content: formatted };
  } catch (error) {
    return { content: null, error: error instanceof Error ? error.message : String(error) };
  }
}
