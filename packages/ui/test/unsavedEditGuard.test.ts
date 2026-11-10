// @vitest-environment jsdom
// beforeunload / window.close 属于浏览器能力，unit 工程默认是 node 环境，
// 关窗保护那一组用例必须在 jsdom 下才能真正触发守卫。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmAllUnsavedSessions,
  hasUnsavedEdits,
  registerUnsavedEditSession,
  resetUnsavedEditGuardForTests,
  type UnsavedEditDecision,
  type UnsavedEditSession,
} from "@/preview-pane/index.js";

function makeSession(path: string, dirty: boolean, decision: UnsavedEditDecision, sessionId = path) {
  const confirmClose = vi.fn(async () => decision);
  const focus = vi.fn();
  const session: UnsavedEditSession = {
    path,
    sessionId,
    isDirty: () => dirty,
    confirmClose,
    focus,
  };
  return { session, confirmClose, focus };
}

/** 可控的脏会话：confirmClose 由测试手动 resolve，用于验证异步确认时序。 */
function makeDeferredSession(path: string, sessionId = path) {
  const resolvers: Array<(decision: UnsavedEditDecision) => void> = [];
  const focus = vi.fn();
  const session: UnsavedEditSession = {
    path,
    sessionId,
    isDirty: () => true,
    confirmClose: () => new Promise<UnsavedEditDecision>((resolve) => resolvers.push(resolve)),
    focus,
  };
  return { session, resolvers, focus };
}

afterEach(() => {
  resetUnsavedEditGuardForTests();
});

describe("unsavedEditGuard", () => {
  it("没有会话或会话都是 clean 时直接放行", async () => {
    const clean = makeSession("clean.ts", false, "saved");
    registerUnsavedEditSession(clean.session);

    expect(hasUnsavedEdits()).toBe(false);
    await expect(confirmAllUnsavedSessions()).resolves.toBe(true);
    expect(clean.confirmClose).not.toHaveBeenCalled();
  });

  it("只确认脏会话，并在确认前聚焦编辑器", async () => {
    const clean = makeSession("clean.ts", false, "saved");
    const dirty = makeSession("dirty.ts", true, "discarded");
    registerUnsavedEditSession(clean.session);
    registerUnsavedEditSession(dirty.session);

    expect(hasUnsavedEdits()).toBe(true);
    await expect(confirmAllUnsavedSessions()).resolves.toBe(true);
    expect(dirty.focus).toHaveBeenCalledTimes(1);
    expect(dirty.confirmClose).toHaveBeenCalledTimes(1);
    expect(clean.confirmClose).not.toHaveBeenCalled();
  });

  it("任一会话取消即中止，不再确认后续会话", async () => {
    const first = makeSession("a.ts", true, "cancel");
    const second = makeSession("b.ts", true, "saved");
    registerUnsavedEditSession(first.session);
    registerUnsavedEditSession(second.session);

    await expect(confirmAllUnsavedSessions()).resolves.toBe(false);
    expect(first.confirmClose).toHaveBeenCalledTimes(1);
    expect(second.confirmClose).not.toHaveBeenCalled();
  });

  it("并发调用复用同一次确认，避免重复弹框", async () => {
    const { session, resolvers } = makeDeferredSession("a.ts");
    registerUnsavedEditSession(session);

    const first = confirmAllUnsavedSessions();
    const second = confirmAllUnsavedSessions();
    expect(second).toBe(first);
    expect(resolvers).toHaveLength(1);

    resolvers[0]?.("saved");
    await expect(first).resolves.toBe(true);
  });

  it("注销后的会话不再参与确认", async () => {
    const dirty = makeSession("dirty.ts", true, "saved");
    const unregister = registerUnsavedEditSession(dirty.session);
    unregister();

    expect(hasUnsavedEdits()).toBe(false);
    await expect(confirmAllUnsavedSessions()).resolves.toBe(true);
    expect(dirty.confirmClose).not.toHaveBeenCalled();
  });

  it("同一文件的多个会话各自独立追踪，不会互相顶掉", async () => {
    // 同一 path 在多个 tab 中并存时，用 path 做注册表 key 会让后注册的会话
    // 顶掉前一个，导致前一个的脏改动无人确认。
    const first = makeSession("same.ts", true, "saved", "session-1");
    const second = makeSession("same.ts", true, "saved", "session-2");
    registerUnsavedEditSession(first.session);
    registerUnsavedEditSession(second.session);

    await expect(confirmAllUnsavedSessions()).resolves.toBe(true);
    expect(first.confirmClose).toHaveBeenCalledTimes(1);
    expect(second.confirmClose).toHaveBeenCalledTimes(1);
  });

  it("注销只移除自己那一份，不误删同 path 的其他会话", async () => {
    const first = makeSession("same.ts", true, "saved", "session-1");
    const second = makeSession("same.ts", true, "saved", "session-2");
    const unregisterFirst = registerUnsavedEditSession(first.session);
    registerUnsavedEditSession(second.session);
    unregisterFirst();

    await expect(confirmAllUnsavedSessions()).resolves.toBe(true);
    expect(first.confirmClose).not.toHaveBeenCalled();
    expect(second.confirmClose).toHaveBeenCalledTimes(1);
  });
});

describe("beforeunload 关窗保护", () => {
  let closeSpy: ReturnType<typeof vi.spyOn>;

  /**
   * jsdom 的 Event 不带 beforeunload 的 returnValue 语义，
   * 这里在实例上覆盖成可读写属性，以断言守卫确实写入了非空值。
   */
  function dispatchBeforeUnload(): { defaultPrevented: boolean; returnValue: unknown } {
    const event = new Event("beforeunload", { cancelable: true });
    let returnValue: unknown;
    Object.defineProperty(event, "returnValue", {
      configurable: true,
      get: () => returnValue,
      set: (value: unknown) => {
        returnValue = value;
      },
    });
    window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, returnValue };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
  });

  afterEach(() => {
    closeSpy.mockRestore();
    vi.useRealTimers();
  });

  it("没有脏会话时放行，不写 returnValue", () => {
    registerUnsavedEditSession(makeSession("clean.ts", false, "saved").session);

    const result = dispatchBeforeUnload();

    expect(result.defaultPrevented).toBe(false);
    expect(result.returnValue).toBeUndefined();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("有脏会话时取消本次关闭，用户保存后重新发起 window.close", async () => {
    const { session, resolvers } = makeDeferredSession("dirty.ts");
    registerUnsavedEditSession(session);

    const result = dispatchBeforeUnload();
    expect(result.defaultPrevented).toBe(true);
    expect(result.returnValue).toBe("unsaved-edits");
    // 确认还没结束，不能提前放行关闭。
    expect(closeSpy).not.toHaveBeenCalled();

    resolvers[0]?.("saved");
    await vi.advanceTimersByTimeAsync(0);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("用户放弃改动后同样放行关闭", async () => {
    const { session, resolvers } = makeDeferredSession("dirty.ts");
    registerUnsavedEditSession(session);

    dispatchBeforeUnload();
    resolvers[0]?.("discarded");
    await vi.advanceTimersByTimeAsync(0);

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("用户取消时保持窗口，不调用 window.close", async () => {
    const { session, resolvers } = makeDeferredSession("dirty.ts");
    registerUnsavedEditSession(session);

    const result = dispatchBeforeUnload();
    resolvers[0]?.("cancel");
    await vi.advanceTimersByTimeAsync(0);

    expect(result.defaultPrevented).toBe(true);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("放行标记是一次性的，超时后恢复默认拦截", async () => {
    const { session, resolvers } = makeDeferredSession("dirty.ts");
    registerUnsavedEditSession(session);

    dispatchBeforeUnload();
    resolvers[0]?.("discarded");
    await vi.advanceTimersByTimeAsync(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // 会话仍然脏（放弃只是用户的选择，会话并未卸载），
    // 放行标记过期后再次关窗必须重新拦截，否则第二次关窗会静默丢改动。
    await vi.advanceTimersByTimeAsync(1000);
    const second = dispatchBeforeUnload();
    expect(second.defaultPrevented).toBe(true);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    resolvers[1]?.("discarded");
    await vi.advanceTimersByTimeAsync(0);
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });
});
