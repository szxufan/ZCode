import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectId, createSessionId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

/**
 * 回归：sessionStore `listSessions` 的 `parentID` 直接父过滤。
 * 辅助对话（selection_side_chat）等附属 child 不在 TASK_LIST_SESSION_TYPES 中，
 * 历史重开依赖 `parentID` + `taskTypes` 组合从 SQLite 精确列出某类 child；
 * 过滤子句缺失或被 roots 语义吞掉会让启动页「历史辅助对话」查不到数据。
 */
describe("SQLite session store parent filter", () => {
  it("lists only direct children of the given parent filtered by task type", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-store-parent-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const parentSessionId = createSessionId("side-chat-parent");
    const otherParentSessionId = createSessionId("other-parent");
    const olderChildSessionId = createSessionId("side-chat-older");
    const newerChildSessionId = createSessionId("side-chat-newer");
    const subagentChildSessionId = createSessionId("subagent-child");

    try {
      const projectID = createProjectId("parent-filter");
      for (const [id, slug, updated] of [
        [parentSessionId, "side-chat-parent", 1_000],
        [otherParentSessionId, "other-parent", 1_000],
      ] as const) {
        await store.createSession({
          id,
          projectID,
          slug,
          directory: tempRoot,
          title: slug,
          version: "0.1.0",
          time: { created: 1_000, updated },
        });
      }
      await store.createSession({
        id: olderChildSessionId,
        projectID,
        parentID: parentSessionId,
        taskType: "selection_side_chat",
        slug: "side-chat-older",
        directory: tempRoot,
        title: "older side chat",
        version: "0.1.0",
        time: { created: 1_100, updated: 1_100 },
      });
      await store.createSession({
        id: newerChildSessionId,
        projectID,
        parentID: parentSessionId,
        taskType: "selection_side_chat",
        slug: "side-chat-newer",
        directory: tempRoot,
        title: "newer side chat",
        version: "0.1.0",
        time: { created: 1_200, updated: 1_200 },
      });
      // 同父但不同 taskType：按 sessionKind 查询时必须被 taskTypes 过滤掉。
      await store.createSession({
        id: subagentChildSessionId,
        projectID,
        parentID: parentSessionId,
        taskType: "subagent_child",
        slug: "subagent-child",
        directory: tempRoot,
        title: "subagent child",
        version: "0.1.0",
        time: { created: 1_300, updated: 1_300 },
      });

      const children = await store.listSessions({
        directory: tempRoot,
        parentID: parentSessionId,
        taskTypes: ["selection_side_chat"],
      });
      // 按更新时间倒序（与启动页「历史辅助对话」展示顺序一致）。
      expect(children.map((session) => session.id)).toEqual([
        newerChildSessionId,
        olderChildSessionId,
      ]);
      expect(children.every((session) => session.parentID === parentSessionId)).toBe(true);

      // sessionKind 不匹配时返回空，不回落成「全部 child」。
      const mismatched = await store.listSessions({
        directory: tempRoot,
        parentID: parentSessionId,
        taskTypes: ["workflow_child"],
      });
      expect(mismatched).toEqual([]);

      // roots 语义不受影响：根列表只含两个 parent，不包含带 parent 的 child。
      const roots = await store.listSessions({ directory: tempRoot, roots: true });
      expect(roots.map((session) => session.id).sort()).toEqual(
        [otherParentSessionId, parentSessionId].sort(),
      );

      // 不带 taskTypes 时返回该父的全部直接 child（含其他 taskType）。
      const allChildren = await store.listSessions({
        directory: tempRoot,
        parentID: parentSessionId,
      });
      expect(allChildren.map((session) => session.id)).toEqual([
        subagentChildSessionId,
        newerChildSessionId,
        olderChildSessionId,
      ]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("parent filter without directory still finds children stored under another cwd", async () => {
    // 辅助对话与父任务共用 cwd：父任务运行在受管 worktree 时，child.directory 是 worktree 路径，
    // 与 workspace 目录不同。按 parent 查询不能再带 directory，否则这类 child 全部漏掉；
    // 这是 session/list 的 parent 查询在 handler 层不传 directory 的依据。
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-session-store-parent-cwd-"));
    const store = await createSqliteSessionStore({ dbPath: join(tempRoot, "session.sqlite") });
    const parentSessionId = createSessionId("worktree-parent");
    const childSessionId = createSessionId("worktree-side-chat");
    const worktreeCwd = join(tempRoot, "data", ".zcode", "worktrees", "3f2a", "repo");
    const projectID = createProjectId("parent-filter-cwd");

    try {
      await store.createSession({
        id: parentSessionId,
        projectID,
        slug: "worktree-parent",
        directory: worktreeCwd,
        title: "worktree parent",
        version: "0.1.0",
        time: { created: 1_000, updated: 1_000 },
      });
      await store.createSession({
        id: childSessionId,
        projectID,
        parentID: parentSessionId,
        taskType: "selection_side_chat",
        slug: "worktree-side-chat",
        directory: worktreeCwd,
        title: "worktree side chat",
        version: "0.1.0",
        time: { created: 1_100, updated: 1_100 },
      });

      // 不带 directory：仅凭 parentID + taskTypes 命中 worktree 下的 child。
      await expect(
        store.listSessions({ parentID: parentSessionId, taskTypes: ["selection_side_chat"] }),
      ).resolves.toMatchObject([{ id: childSessionId, parentID: parentSessionId }]);
      // 带 workspace 目录：worktree 下的 child 被排除。
      await expect(
        store.listSessions({
          directory: tempRoot,
          parentID: parentSessionId,
          taskTypes: ["selection_side_chat"],
        }),
      ).resolves.toEqual([]);
    } finally {
      store.close();
      await rm(tempRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
