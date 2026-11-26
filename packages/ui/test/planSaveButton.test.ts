// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { IPlatformService, SaveFileRequest, SaveFileResult } from "@zcode/shared";
import { PlanSaveButton } from "@/plan-approval/index.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

const MARKDOWN = "# 修复登录超时\n\n## Context\n\n正文";
const LOCAL_SCOPE = { workspacePath: "/work/app", remote: false };

type SaveFileMock = Mock<(request: SaveFileRequest) => Promise<SaveFileResult>>;

function createPlatform(saveFile: SaveFileMock): IPlatformService {
  return { canOpenLocalFiles: true, saveFile } as unknown as IPlatformService;
}

function renderButton(options: {
  platform: IPlatformService;
  scope?: { workspacePath?: string; remote: boolean };
  disabled?: boolean;
}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        PlatformProvider,
        { platform: options.platform },
        createElement(
          TooltipProvider,
          null,
          createElement(PlanSaveButton, {
            markdown: MARKDOWN,
            scope: options.scope ?? LOCAL_SCOPE,
            testId: "plan-save",
            ...(options.disabled ? { disabled: true } : {}),
          }),
        ),
      ),
    ),
  );
}

async function savedRequest(saveFile: SaveFileMock): Promise<SaveFileRequest> {
  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  const request = saveFile.mock.calls[0]?.[0];
  if (!request) throw new Error("saveFile was not called with a request");
  return request;
}

afterEach(() => {
  cleanup();
  mocks.toast.mockClear();
});

// 计划卡片的「保存计划」（docs/ui/plan-detail-side-pane.md）：正文原样编码，文件名与目录候选
// 由 planSave 的纯函数给出；取消静默，失败提示。

describe("PlanSaveButton", () => {
  it("把计划原文、建议文件名和目录候选交给另存为，成功后提示已保存", async () => {
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(async () => ({
      success: true,
      path: "/work/out.md",
    }));
    renderButton({ platform: createPlatform(saveFile) });

    fireEvent.click(screen.getByTestId("plan-save"));

    const request = await savedRequest(saveFile);
    expect(request.data && new TextDecoder().decode(request.data)).toBe(MARKDOWN);
    expect(request.suggestedName).toMatch(/^\d{4}-\d{2}-\d{2}-修复登录超时\.md$/);
    expect(request.defaultDirectoryCandidates).toEqual([
      "/work/app/docs/superpowers/plans",
      "/work/app",
    ]);
    expect(mocks.toast).toHaveBeenCalledWith("Saved");
  });

  it("无障碍名称是「Save plan」", () => {
    renderButton({
      platform: createPlatform(vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>()),
    });
    expect(screen.getByTestId("plan-save").getAttribute("aria-label")).toBe("Save plan");
  });

  it("远程工作区不传候选目录", async () => {
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(async () => ({
      success: true,
    }));
    renderButton({
      platform: createPlatform(saveFile),
      scope: { workspacePath: "/remote/app", remote: true },
    });

    fireEvent.click(screen.getByTestId("plan-save"));

    const request = await savedRequest(saveFile);
    expect(request.defaultDirectoryCandidates).toBeUndefined();
  });

  it("取消另存为时不提示", async () => {
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(async () => ({
      success: false,
      canceled: true,
    }));
    renderButton({ platform: createPlatform(saveFile) });

    fireEvent.click(screen.getByTestId("plan-save"));

    await waitFor(() =>
      expect((screen.getByTestId("plan-save") as HTMLButtonElement).disabled).toBe(false),
    );
    expect(saveFile).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("写入失败时提示保存失败", async () => {
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(async () => ({
      success: false,
      error: "write_failed",
    }));
    renderButton({ platform: createPlatform(saveFile) });

    fireEvent.click(screen.getByTestId("plan-save"));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.toast).toHaveBeenCalledWith(
      "Could not save this file. Check the source connection and try again.",
    );
  });

  it("保存进行中不重复弹出另存为", async () => {
    let resolveSave: ((result: SaveFileResult) => void) | undefined;
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(
      () =>
        new Promise<SaveFileResult>((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderButton({ platform: createPlatform(saveFile) });

    fireEvent.click(screen.getByTestId("plan-save"));
    fireEvent.click(screen.getByTestId("plan-save"));

    expect(saveFile).toHaveBeenCalledOnce();
    resolveSave?.({ success: true });
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Saved"));
  });

  it("外部禁用时不可点击", () => {
    const saveFile = vi.fn<(request: SaveFileRequest) => Promise<SaveFileResult>>(async () => ({
      success: true,
    }));
    renderButton({ platform: createPlatform(saveFile), disabled: true });

    fireEvent.click(screen.getByTestId("plan-save"));

    expect(saveFile).not.toHaveBeenCalled();
  });

  it("平台没有另存为能力时不渲染", () => {
    renderButton({ platform: { canOpenLocalFiles: false } as unknown as IPlatformService });
    expect(screen.queryByTestId("plan-save")).toBeNull();
  });
});
