// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGlobalNoticeStore,
  type GlobalNoticeEnvelope,
  type GlobalNoticeStorage,
} from "@/global-notice/globalNoticeStore.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";

// 营销触达 banner 已随特性删除，SidebarBottomActivity 收敛为 GlobalNoticeSurface 的
// 只读透传：未注册的通知类型由 surface 安全忽略，槽位不产生任何多余 DOM。
// 这里按当前实现收敛断言：无论 store 中是否存在可见通知，组件都渲染空容器。

function memoryStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function makeNotice(now = Date.now()): GlobalNoticeEnvelope {
  return {
    noticeId: "notice-1",
    dedupeKey: "demo:latest",
    type: "demo-notice",
    schemaVersion: 1,
    scope: "user",
    priority: "normal",
    interruptPolicy: "passive",
    createdAt: now,
    expiresAt: now + 100_000,
    payload: {},
    actions: [],
    dismissPolicy: { kind: "none" },
    persistencePolicy: "latest-only",
    source: "test",
    revision: 1,
  };
}

function renderActivity(store?: ReturnType<typeof createGlobalNoticeStore> | null) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SidebarBottomActivity, { noticeStore: store }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("SidebarBottomActivity 全局通知透传", () => {
  it("store 无可见通知时槽位为空", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    const { container } = renderActivity(noticeStore);

    expect(container.childElementCount).toBe(0);
    expect(container.textContent).toBe("");
  });

  it("store 有可见通知但类型未注册时安全忽略，不产生多余 DOM", () => {
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage() });
    noticeStore.publish(makeNotice());
    expect(noticeStore.getVisible()).not.toBeNull();

    const { container } = renderActivity(noticeStore);
    expect(container.textContent).toBe("");
    expect(container.querySelectorAll("*").length).toBe(
      container.querySelectorAll(":scope > *").length,
    );
  });

  it("通知过期后仍保持空槽位（store 层不可见 + surface 忽略）", () => {
    let now = 1_000_000;
    const noticeStore = createGlobalNoticeStore({ storage: memoryStorage(), now: () => now });
    noticeStore.publish(makeNotice(now));
    now += 200_000; // 越过 expiresAt
    expect(noticeStore.getVisible()).toBeNull();

    const { container } = renderActivity(noticeStore);
    expect(container.textContent).toBe("");
  });

  it("未注入 store 时走默认 browserGlobalNoticeStore 且不崩溃", () => {
    const { container } = renderActivity(undefined);
    expect(container.textContent).toBe("");
  });

  it("显式传入 null store 时不崩溃且槽位为空", () => {
    const { container } = renderActivity(null);
    expect(container.textContent).toBe("");
  });
});
