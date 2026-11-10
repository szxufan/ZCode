/**
 * 未保存编辑会话的聚合守卫。
 * 只负责"是否存在脏会话"和触发各会话自己的确认框，不持有编辑缓冲。
 */

export type UnsavedEditDecision = "saved" | "discarded" | "cancel";

export interface UnsavedEditSession {
  path: string;
  /** 会话唯一标识；同一 path 可能有多个并存会话（多 tab），注册表按 path+sessionId 去重。 */
  sessionId: string;
  isDirty: () => boolean;
  /** 由编辑会话弹出三选一确认并 resolve；必须有用户明确选择时才 resolve。 */
  confirmClose: () => Promise<UnsavedEditDecision>;
  focus: () => void;
}

const sessions = new Map<string, UnsavedEditSession>();
let beforeUnloadInstalled = false;
let allowUnload = false;
let pendingConfirmation: Promise<boolean> | null = null;

function hasDirtySession(): boolean {
  return Array.from(sessions.values()).some((session) => session.isDirty());
}

/**
 * 同步脏检查。用于无法 await 确认的调用点（如工作区切换的 effect）：
 * 先判断是否需要走确认流程，避免为了"大概率没有脏会话"的常态路径付出异步代价。
 */
export function hasUnsavedEdits(): boolean {
  return hasDirtySession();
}

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  if (allowUnload || !hasDirtySession()) {
    return;
  }

  // Electron 中返回非 undefined 会静默取消关闭；随后用应用自己的三选一确认框接管。
  event.preventDefault();
  event.returnValue = "unsaved-edits";

  void confirmAllUnsavedSessions().then((allowed) => {
    if (!allowed) return;
    allowUnload = true;
    // 放行后重新发起关闭；若再次被其它守卫取消，恢复默认拦截。
    window.setTimeout(() => {
      allowUnload = false;
    }, 1000);
    window.close();
  });
}

function ensureBeforeUnloadInstalled(): void {
  if (beforeUnloadInstalled || typeof window === "undefined") {
    return;
  }
  beforeUnloadInstalled = true;
  window.addEventListener("beforeunload", handleBeforeUnload);
}

export function registerUnsavedEditSession(session: UnsavedEditSession): () => void {
  ensureBeforeUnloadInstalled();
  // 以 sessionId 而非 path 为 key：同一文件可能在多个 tab 中各自持有编辑会话，
  // 用 path 做 key 会让后注册的会话顶掉前一个，导致前一个的脏改动无人确认。
  const key = `${session.path}::${session.sessionId}`;
  sessions.set(key, session);
  return () => {
    if (sessions.get(key) === session) {
      sessions.delete(key);
    }
  };
}

/**
 * 依次确认所有脏会话；任一取消即中止。返回 true 表示可以继续（全部保存或放弃）。
 * 供关窗、应用退出、切换文件等会销毁编辑会话的入口复用。
 */
export function confirmAllUnsavedSessions(): Promise<boolean> {
  if (pendingConfirmation) {
    return pendingConfirmation;
  }

  pendingConfirmation = (async () => {
    for (const session of Array.from(sessions.values())) {
      if (!session.isDirty()) continue;
      session.focus();
      const decision = await session.confirmClose();
      if (decision === "cancel") {
        return false;
      }
    }
    return true;
  })().finally(() => {
    pendingConfirmation = null;
  });

  return pendingConfirmation;
}

/** 仅供测试：清理模块级状态，避免用例间互相污染。 */
export function resetUnsavedEditGuardForTests(): void {
  sessions.clear();
  pendingConfirmation = null;
  allowUnload = false;
}
