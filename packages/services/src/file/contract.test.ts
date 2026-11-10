import { describe, expect, it } from "vitest";

import type { FileRevision, FileTextEditSnapshot } from "@zcode/shared";

import type { FileTextEditContract } from "./contract.js";
import { fileTextEditModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁。
describe("file-text-edit contract", () => {
  it("声明 managed 模块清单", () => {
    expect(fileTextEditModule.id).toBe("file-text-edit");
    expect(fileTextEditModule.requires).toEqual(["services", "shared"]);
    expect(fileTextEditModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("快照以单一 FileRevision 作为写入基线", () => {
    const revision: FileRevision = {
      id: "mtime:1:size:2",
      mtimeMs: 1,
      sizeBytes: 2,
      hash: "sha256:00",
    };
    const snapshot: FileTextEditSnapshot = {
      path: "/ws/a.ts",
      content: "a\n",
      encoding: "utf8",
      lineEndings: "LF",
      revision,
      totalBytes: 2,
    };
    // 只做编译期形状校验：revision 字段被拆成 mtime+size 影子格式时这里会报错。
    const contract: Pick<FileTextEditContract, "writeTextFile"> = {
      writeTextFile: async (params) => ({ ok: true, revision: params.baseRevision }),
    };

    expect(snapshot.revision).toBe(revision);
    void contract;
  });
});
