import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: vi.fn() },
}));

import { resolveSaveFileDefaultDirectory } from "../src/main/desktopSaveFile.js";

// 另存为对话框的起始目录由 main 判定（docs/ui/plan-detail-side-pane.md「保存计划」）：
// 目录是否存在只有本机知道，渲染进程只给候选。

describe("resolveSaveFileDefaultDirectory", () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(
      created
        .splice(0)
        .map((directory) =>
          rm(directory, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }),
        ),
    );
  });

  async function createTempDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "zcode-save-file-"));
    created.push(directory);
    return directory;
  }

  it("按顺序取第一个存在的目录", async () => {
    const root = await createTempDirectory();
    const plans = join(root, "docs", "superpowers", "plans");
    await mkdir(plans, { recursive: true });

    await expect(
      resolveSaveFileDefaultDirectory([join(root, "missing"), plans, root]),
    ).resolves.toBe(plans);
  });

  it("候选都不存在时返回 undefined，对话框落在系统默认位置", async () => {
    const root = await createTempDirectory();

    await expect(
      resolveSaveFileDefaultDirectory([join(root, "a"), join(root, "b")]),
    ).resolves.toBeUndefined();
  });

  it("跳过相对路径、文件和非数组输入", async () => {
    const root = await createTempDirectory();
    const file = join(root, "notes.md");
    await writeFile(file, "plan");

    await expect(resolveSaveFileDefaultDirectory(["relative/dir", file, root])).resolves.toBe(root);
    await expect(resolveSaveFileDefaultDirectory(undefined)).resolves.toBeUndefined();
    // IPC 边界上的候选不可信：运行时按非数组处理，测试刻意传入非法形状。
    await expect(
      resolveSaveFileDefaultDirectory("relative/dir" as unknown as readonly string[]),
    ).resolves.toBeUndefined();
  });
});
