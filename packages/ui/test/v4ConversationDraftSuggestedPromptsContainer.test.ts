// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { SWRConfig } from "swr";
import { cleanup, render as renderWithTestingLibrary } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationDraftSuggestedPromptsContainer } from "@/v4/ConversationDraftSuggestedPromptsContainer.js";

const toast = vi.hoisted(() => vi.fn());
const dismissToast = vi.hoisted(() => vi.fn());

function render(ui: ReactNode) {
  return renderWithTestingLibrary(
    createElement(
      SWRConfig,
      {
        value: {
          provider: () => new Map(),
          revalidateOnFocus: false,
          revalidateOnReconnect: false,
        },
      },
      ui,
    ),
  );
}

vi.mock("@/components/ui/toast.js", () => ({ dismissToast, toast }));

// 推荐容器新增共享偏好读取；单测沿用独立 hook mock，避免依赖真实 ServiceProvider。
vi.mock("@/hooks/useSettingService.js", () => {
  const value = {
    settings: { proactiveSuggestionsEnabled: false, onboardingOccupation: null },
    update: vi.fn(),
  };
  return { useSettings: () => value };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => {
  // 生产 hook 会 memoize resolution/services；测试也必须保持引用稳定。
  const services = {
    pluginManagementService: {},
    zcodeSessionService: {},
  };
  return {
    useWorkspaceServicesResolution: (
      _workspacePath: string,
      preferredRemoteSessionId?: string,
    ) => ({
      services,
      remoteSessionId: preferredRemoteSessionId ?? null,
      isRemoteTarget: false,
      connectionKind: "local-ready",
      rpcReady: true,
    }),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

describe("ConversationDraftSuggestedPromptsContainer", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps the slot mounted with an empty list after Client Scenes retirement", () => {
    const view = render(
      createElement(ConversationDraftSuggestedPromptsContainer, {
        className: "mt-3",
        workspacePath: "/tmp/suggested-prompt-empty-slot",
      }),
    );

    const slot = view.container.firstElementChild;
    expect(slot?.getAttribute("data-v4-draft-suggested-prompts-slot")).toBe("true");
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
  });
});
