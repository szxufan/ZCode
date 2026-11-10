import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import iconv from "iconv-lite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileTextEditSnapshot } from "@zcode/shared";
import { createFileService } from "../src/file/fileService.js";
import {
  analyzeLineEndings,
  applyLineEndings,
  decodeLosslessly,
  hashBytes,
} from "../src/file/textEdit.js";

let root = "";
const service = createFileService();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-text-edit-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}

function writeParams(
  snapshot: FileTextEditSnapshot,
  content: string,
): Parameters<typeof service.writeTextFile>[0] {
  return {
    path: snapshot.path,
    content,
    encoding: snapshot.encoding,
    lineEndings: snapshot.lineEndings,
    baseRevision: snapshot.revision,
  };
}

describe("文本编码与换行判定", () => {
  it("UTF-8 BOM 参与往返校验", () => {
    const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello\n", "utf8")]);
    const decoded = decodeLosslessly(buffer);
    expect(decoded?.encoding).toBe("utf8");
    expect(Buffer.from(decoded?.content ?? "", "utf8").equals(buffer)).toBe(true);
  });

  it("GBK 文本解码后能重新编码为原始字节", () => {
    const buffer = iconv.encode("中文\n", "gbk");
    const decoded = decodeLosslessly(buffer);
    expect(decoded?.encoding).toMatch(/^gb/);
    expect(iconv.encode(decoded?.content ?? "", decoded?.encoding as "gbk").equals(buffer)).toBe(
      true,
    );
  });

  it("混合换行被标记为不可编辑", () => {
    expect(analyzeLineEndings("a\r\nb\nc")).toEqual({ lineEndings: "CRLF", mixed: true });
    expect(analyzeLineEndings("a\r\nb\r\n")).toEqual({ lineEndings: "CRLF", mixed: false });
    expect(analyzeLineEndings("a\nb\n")).toEqual({ lineEndings: "LF", mixed: false });
  });

  it("空文件与无换行文本按 LF 作为基线", () => {
    expect(analyzeLineEndings("")).toEqual({ lineEndings: "LF", mixed: false });
    expect(analyzeLineEndings("single line")).toEqual({ lineEndings: "LF", mixed: false });
  });

  it("保存时按基线换行还原", () => {
    expect(applyLineEndings("a\nb\n", "CRLF")).toBe("a\r\nb\r\n");
    expect(applyLineEndings("a\r\nb\r\n", "LF")).toBe("a\nb\n");
  });
});

describe("readTextEditSnapshot", () => {
  it("内容统一为 LF，并返回基线版本", async () => {
    const path = join(root, "crlf.ts");
    await writeTextFile(path, "const a = 1;\r\nconst b = 2;\r\n");

    const snapshot = await service.readTextEditSnapshot({ path });
    expect(snapshot.content).toBe("const a = 1;\nconst b = 2;\n");
    expect(snapshot.lineEndings).toBe("CRLF");
    expect(snapshot.encoding).toBe("utf8");
    expect(snapshot.revision.hash).toMatch(/^sha256:/);
  });

  it("混合换行文件拒绝进入编辑态", async () => {
    const path = join(root, "mixed.txt");
    await writeTextFile(path, "a\r\nb\nc");
    await expect(service.readTextEditSnapshot({ path })).rejects.toThrow(/mixed-line-endings/);
  });

  it("二进制文件拒绝进入编辑态", async () => {
    const path = join(root, "binary.bin");
    await writeFile(path, Buffer.from([0, 1, 2, 3, 4]));
    await expect(service.readTextEditSnapshot({ path })).rejects.toThrow(/Binary/);
  });
});

describe("writeTextFile", () => {
  it("成功写回并保留 CRLF", async () => {
    const path = join(root, "keep-crlf.ts");
    await writeTextFile(path, "const a = 1;\r\nconst b = 2;\r\n");
    const snapshot = await service.readTextEditSnapshot({ path });

    const result = await service.writeTextFile(
      writeParams(snapshot, `${snapshot.content}const c = 3;\n`),
    );
    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n");
  });

  it("内容被外部改写时返回 stale_file", async () => {
    const path = join(root, "conflict.ts");
    await writeTextFile(path, "const a = 1;\n");
    const snapshot = await service.readTextEditSnapshot({ path });
    await writeTextFile(path, "const a = 2;\n");

    const result = await service.writeTextFile(writeParams(snapshot, "const a = 3;\n"));
    expect(result).toMatchObject({ ok: false, code: "stale_file" });
    expect(await readFile(path, "utf8")).toBe("const a = 2;\n");
  });

  it("mtime 变化但内容相同不视为冲突", async () => {
    const path = join(root, "same-content.ts");
    await writeTextFile(path, "const a = 1;\n");
    const snapshot = await service.readTextEditSnapshot({ path });
    await writeTextFile(path, "const a = 1;\n");

    const result = await service.writeTextFile(writeParams(snapshot, "const a = 2;\n"));
    expect(result.ok).toBe(true);
  });

  it("文件不存在时返回 file_not_found", async () => {
    const path = join(root, "missing.ts");
    await writeTextFile(path, "const a = 1;\n");
    const snapshot = await service.readTextEditSnapshot({ path });
    await rm(path);

    const result = await service.writeTextFile(writeParams(snapshot, "const a = 2;\n"));
    expect(result).toMatchObject({ ok: false, code: "file_not_found" });
  });

  it.skipIf(process.platform === "win32")("保留原文件的可执行权限位", async () => {
    const path = join(root, "run.sh");
    await writeFile(path, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    await chmod(path, 0o755);
    const snapshot = await service.readTextEditSnapshot({ path });

    const result = await service.writeTextFile(writeParams(snapshot, "#!/bin/sh\necho ok\n"));
    expect(result.ok).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });

  it("拒绝写入软链接", async () => {
    const target = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeTextFile(target, "x\n");
    try {
      await symlink(target, link, "file");
    } catch {
      return;
    }
    const snapshot = await service.readTextEditSnapshot({ path: link });

    const result = await service.writeTextFile(writeParams(snapshot, "y\n"));
    expect(result).toMatchObject({ ok: false, code: "symlink_refused" });
    expect(await readFile(target, "utf8")).toBe("x\n");
  });

  it("空文件可以进入编辑并写回内容", async () => {
    const path = join(root, "empty.txt");
    await writeTextFile(path, "");
    const snapshot = await service.readTextEditSnapshot({ path });
    expect(snapshot.content).toBe("");
    expect(snapshot.lineEndings).toBe("LF");

    const result = await service.writeTextFile(writeParams(snapshot, "hello\n"));
    expect(result.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe("hello\n");
  });

  it("UTF-8 BOM 在保存后原样保留", async () => {
    const path = join(root, "bom.txt");
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    await writeFile(path, Buffer.concat([bom, Buffer.from("hello\n", "utf8")]));
    const snapshot = await service.readTextEditSnapshot({ path });
    expect(snapshot.encoding).toBe("utf8");

    const result = await service.writeTextFile(writeParams(snapshot, `${snapshot.content}world\n`));
    expect(result.ok).toBe(true);

    const bytes = await readFile(path);
    // BOM 必须仍在开头，且正文没有被二次编码破坏。
    expect(bytes.subarray(0, 3)).toEqual(bom);
    expect(bytes.subarray(3).toString("utf8")).toBe("hello\nworld\n");
  });

  it("GBK + CRLF 文件保存后编码与换行同时还原", async () => {
    const path = join(root, "gbk-crlf.txt");
    await writeFile(path, iconv.encode("中文\r\n第二行\r\n", "gbk"));
    const snapshot = await service.readTextEditSnapshot({ path });
    expect(snapshot.encoding).toMatch(/^gb/);
    expect(snapshot.lineEndings).toBe("CRLF");
    // 编辑器内部统一 LF，保存时才按基线还原。
    expect(snapshot.content).toBe("中文\n第二行\n");

    const result = await service.writeTextFile(writeParams(snapshot, `${snapshot.content}第三行\n`));
    expect(result.ok).toBe(true);

    const bytes = await readFile(path);
    expect(iconv.decode(bytes, snapshot.encoding)).toBe("中文\r\n第二行\r\n第三行\r\n");
    // 落盘字节必须仍能被同一编码无损往返，否则等于悄悄改了文件编码。
    expect(
      iconv.encode(iconv.decode(bytes, snapshot.encoding), snapshot.encoding).equals(bytes),
    ).toBe(true);
  });
});

describe("readTextFile 编辑元信息", () => {
  it("完整可解码文本返回可编辑", async () => {
    const path = join(root, "plain.ts");
    await writeTextFile(path, "const a = 1;\n");

    const slice = await service.readTextFile({ path });
    expect(slice.editCapability).toEqual({ editable: true });
    expect(slice.revision?.hash).toMatch(/^sha256:/);
  });

  it("二进制与超限文件返回不可编辑原因", async () => {
    const binaryPath = join(root, "binary.bin");
    await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
    expect((await service.readTextFile({ path: binaryPath })).editCapability).toEqual({
      editable: false,
      reason: "binary",
    });

    const bigPath = join(root, "big.txt");
    await writeTextFile(bigPath, "a".repeat(300 * 1024));
    const bigSlice = await service.readTextFile({ path: bigPath });
    expect(bigSlice.truncated).toBe(true);
    expect(bigSlice.editCapability).toEqual({ editable: false, reason: "too-large" });
  });

  it("空文件同样返回可编辑与基线版本", async () => {
    const path = join(root, "empty.txt");
    await writeTextFile(path, "");

    const slice = await service.readTextFile({ path });
    expect(slice.content).toBe("");
    expect(slice.editCapability).toEqual({ editable: true });
    expect(slice.encoding).toBe("utf8");
    expect(slice.lineEndings).toBe("LF");
    expect(slice.revision?.hash).toBe(hashBytes(Buffer.alloc(0)));
  });

  it("分段读取返回 partial-read，而不是误导性的 host-unsupported", async () => {
    const path = join(root, "multi.txt");
    await writeTextFile(path, "line1\nline2\nline3\n");

    // 从中间读到结尾：既不是二进制也没有截断，但没覆盖全文，无法判定无损往返。
    const slice = await service.readTextFile({ path, offset: 6 });
    expect(slice.truncated).toBe(false);
    expect(slice.isBinary).toBe(false);
    expect(slice.editCapability).toEqual({ editable: false, reason: "partial-read" });
    // 未覆盖全文时不能给基线，否则调用方会拿错误的 revision 去写入。
    expect(slice.revision).toBeUndefined();
  });
});

describe("格式化", () => {
  it("无静态配置时跳过", async () => {
    const path = join(root, "a.ts");
    await writeTextFile(path, 'const a = "x";\n');

    expect(await service.getTextFormatCapability({ path })).toEqual({ formatter: null });
    expect(await service.formatTextContent({ path, content: 'const a = "x";\n' })).toEqual({
      content: null,
      skippedReason: "no-config",
    });
  });

  it("按项目静态配置格式化", async () => {
    await writeTextFile(
      join(root, ".prettierrc"),
      JSON.stringify({ semi: false, singleQuote: true }),
    );
    const path = join(root, "a.ts");
    await writeTextFile(path, 'const a = "x";\n');

    expect((await service.getTextFormatCapability({ path })).formatter).toBe("prettier");
    const result = await service.formatTextContent({ path, content: 'const a = "x";\n' });
    expect(result.content).toBe("const a = 'x'\n");
  });

  it("不加载可执行的 prettier.config.js", async () => {
    await writeTextFile(join(root, "prettier.config.js"), "throw new Error('must not run')\n");
    const path = join(root, "a.ts");
    await writeTextFile(path, "const a = 1;\n");

    expect(await service.getTextFormatCapability({ path })).toEqual({ formatter: null });
  });

  it("不支持的语言类型返回 skipped", async () => {
    await writeTextFile(join(root, ".prettierrc"), "{}");
    const path = join(root, "a.unknown-ext");
    await writeTextFile(path, "whatever\n");

    expect(await service.formatTextContent({ path, content: "whatever\n" })).toEqual({
      content: null,
      skippedReason: "unsupported-language",
    });
  });

  it("格式化抛错时返回 error，让调用方用原文继续保存", async () => {
    await writeTextFile(join(root, ".prettierrc"), "{}");
    const path = join(root, "broken.ts");
    // 语法错误的源码会让 prettier 抛异常；保存链路必须降级而不是失败。
    const broken = "const a = = 1;\n";
    await writeTextFile(path, broken);

    const result = await service.formatTextContent({ path, content: broken });
    expect(result.content).toBeNull();
    expect(result.skippedReason).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it("配置发现不越过 workspacePath 上界", async () => {
    const workspaceRoot = join(root, "ws");
    await mkdir(workspaceRoot, { recursive: true });
    // 配置放在 workspace 之外，模拟用户 home 下的全局 .prettierrc。
    await writeTextFile(join(root, ".prettierrc"), JSON.stringify({ semi: false }));
    const path = join(workspaceRoot, "a.ts");
    const content = 'const a = "x";\n';
    await writeTextFile(path, content);

    // 不传上界时会一路向上读到 workspace 之外的配置。
    expect((await service.getTextFormatCapability({ path })).formatter).toBe("prettier");
    // 传了上界之后必须停在 workspace 根，不得继承外部全局配置。
    expect(await service.getTextFormatCapability({ path, workspacePath: workspaceRoot })).toEqual({
      formatter: null,
    });
    expect(
      await service.formatTextContent({ path, content, workspacePath: workspaceRoot }),
    ).toEqual({ content: null, skippedReason: "no-config" });
  });

  it("workspacePath 之内的配置仍然生效", async () => {
    const workspaceRoot = join(root, "ws-inner");
    await mkdir(workspaceRoot, { recursive: true });
    await writeTextFile(
      join(workspaceRoot, ".prettierrc"),
      JSON.stringify({ semi: false, singleQuote: true }),
    );
    const path = join(workspaceRoot, "nested", "a.ts");
    await mkdir(dirname(path), { recursive: true });
    await writeTextFile(path, 'const a = "x";\n');

    const result = await service.formatTextContent({
      path,
      content: 'const a = "x";\n',
      workspacePath: workspaceRoot,
    });
    expect(result.content).toBe("const a = 'x'\n");
  });
});
