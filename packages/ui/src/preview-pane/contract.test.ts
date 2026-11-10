import { describe, expect, it } from "vitest";

import type { PreviewPaneEditContract, PreviewPaneTextEditorProps } from "./contract.js";
import { uiPreviewEditModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁。
describe("ui-preview-edit contract", () => {
  it("声明 managed 模块清单", () => {
    expect(uiPreviewEditModule.id).toBe("ui-preview-edit");
    expect(uiPreviewEditModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
  });

  it("编辑会话只依赖端口类型，宿主可注入任意实现", async () => {
    const props = {
      path: "/ws/a.ts",
      sessionId: "session-1",
      workspacePath: "/ws",
      fileService: {} as PreviewPaneTextEditorProps["fileService"],
      fileWatcherService: {} as PreviewPaneTextEditorProps["fileWatcherService"],
      dark: false,
      onExit: () => {},
    } satisfies PreviewPaneTextEditorProps;
    const contract: PreviewPaneEditContract = {
      confirmAllUnsavedSessions: async () => true,
      hasUnsavedEdits: () => false,
    };

    expect(props.path).toBe("/ws/a.ts");
    expect(contract.hasUnsavedEdits()).toBe(false);
    await expect(contract.confirmAllUnsavedSessions()).resolves.toBe(true);
  });
});
