// 辅助对话历史重开依赖 `session/list` 的 parent 查询
// （docs/ui/conversation-selection-side-chat.md「历史辅助对话」）。这里固定 handler 层合同：
// - 只返回指定 parent 下、taskType 匹配的持久 child，不读取 live registry 补充根会话行；
// - 不带 directory 过滤：辅助对话与父任务共用 cwd，父任务在受管 worktree 时 child.directory
//   不是 workspacePath；workspace 归属改由 resolvePersistedDirectorySession 按 worktree 关系校验；
// - sessionIds 与 parentSessionId 互斥。
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  createProjectId,
  createSessionId,
  type ProjectId,
  type SessionId,
  type SessionTaskType,
} from "@zcode/contracts";
import { listSessions } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

type SessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync(
    "git",
    ["-c", "user.name=ZCode Test", "-c", "user.email=test@example.com", ...args],
    { cwd },
  );
}

async function tempRoot(prefix: string): Promise<string> {
  // macOS 临时目录 /var 是 /private/var 的软链；归属判定按 realpath 比较，fixture 也用 realpath。
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function seed(
  store: SessionStore,
  input: {
    id: SessionId;
    projectID: ProjectId;
    directory: string;
    parentID?: SessionId;
    taskType?: SessionTaskType;
  },
): Promise<void> {
  const slug = String(input.id);
  await store.createSession({ ...input, slug, title: slug, version: "0.1.0" });
}

function workspaceRef(workspacePath: string) {
  return { workspacePath, workspaceKey: workspacePath };
}

function context(
  store: SessionStore,
  options: { env?: NodeJS.ProcessEnv; liveRecord?: unknown } = {},
): ZCodeProtocolAgentServerContext {
  return {
    deps: { sessionStore: store, ...(options.env ? { env: options.env } : {}) },
    sessions: new Map(options.liveRecord ? [["live-root", options.liveRecord]] : []),
  } as unknown as ZCodeProtocolAgentServerContext;
}

describe("session/list parent query", () => {
  it("returns only the requested kind under the parent and never reads the live registry", async () => {
    const root = await tempRoot("zcode-side-chat-list-");
    const workspacePath = join(root, "project");
    await mkdir(workspacePath, { recursive: true });
    const store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
    const parentId = createSessionId("side-chat-parent");
    const sideChatId = createSessionId("side-chat-child");
    const subagentId = createSessionId("subagent-child");
    const projectID = createProjectId("side-chat-list");

    try {
      await seed(store, { id: parentId, projectID, directory: workspacePath });
      await seed(store, {
        id: sideChatId,
        projectID,
        directory: workspacePath,
        parentID: parentId,
        taskType: "selection_side_chat",
      });
      await seed(store, {
        id: subagentId,
        projectID,
        directory: workspacePath,
        parentID: parentId,
        taskType: "subagent_child",
      });

      // 任一 live record 属性被读取都会抛错：parent 查询必须在 live registry 补充循环之前返回。
      const liveRecord = new Proxy(
        {},
        {
          get: () => {
            throw new Error("parent query must not read the live session registry");
          },
        },
      );

      const result = await listSessions(context(store, { liveRecord }), {
        workspace: workspaceRef(workspacePath),
        parentSessionId: parentId,
        sessionKind: "selection_side_chat",
      });

      expect(result.sessions.map((session) => session.sessionId)).toEqual([sideChatId]);
      expect(result.sessions[0]).toMatchObject({
        parentSessionId: parentId,
        sessionKind: "selection_side_chat",
      });
    } finally {
      store.close();
    }
  });

  it("lists a worktree task's side chats for the source workspace, and not for an unrelated one", async () => {
    // 真实 git 仓库 + 受管 worktree 布局 <dataBaseDir>/.zcode/worktrees/<4hex>/<repo>，
    // 与 resolveWorkspaceHookTrustIdentity 的判定同源。
    const root = await tempRoot("zcode-side-chat-worktree-");
    const source = join(root, "projects", "repo");
    const dataBaseDir = join(root, "data");
    const worktree = join(dataBaseDir, ".zcode", "worktrees", "3f2a", "repo");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "README.md"), "repo\n");
    await git(source, "init", "-q");
    await git(source, "add", ".");
    await git(source, "commit", "-q", "-m", "init");
    await mkdir(join(dataBaseDir, ".zcode", "worktrees", "3f2a"), { recursive: true });
    await git(source, "worktree", "add", "-q", "--detach", worktree);

    const store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
    const parentId = createSessionId("worktree-parent");
    const childId = createSessionId("worktree-side-chat");
    const projectID = createProjectId("worktree-parent");

    try {
      // 父任务与辅助对话都在 worktree cwd：辅助对话共用父任务 cwd，不新建 worktree。
      await seed(store, { id: parentId, projectID, directory: worktree });
      await seed(store, {
        id: childId,
        projectID,
        directory: worktree,
        parentID: parentId,
        taskType: "selection_side_chat",
      });
      const host = context(store, { env: { ZCODE_DATA_BASE_DIR: dataBaseDir } });

      await expect(
        listSessions(host, {
          workspace: workspaceRef(source),
          parentSessionId: parentId,
          sessionKind: "selection_side_chat",
        }),
      ).resolves.toMatchObject({
        sessions: [{ sessionId: childId, parentSessionId: parentId }],
      });

      // 同一个父任务换成无关 workspace：worktree 关系不成立，归属校验拒绝。
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere, { recursive: true });
      await expect(
        listSessions(host, {
          workspace: workspaceRef(elsewhere),
          parentSessionId: parentId,
          sessionKind: "selection_side_chat",
        }),
      ).resolves.toEqual({ sessions: [] });
    } finally {
      store.close();
    }
  }, 30_000);

  it("rejects sessionIds combined with parentSessionId", async () => {
    const root = await tempRoot("zcode-side-chat-exclusive-");
    const workspacePath = join(root, "project");
    const store = await createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
    try {
      const sessionId = createSessionId("exclusive");
      await expect(
        listSessions(context(store), {
          workspace: workspaceRef(workspacePath),
          sessionIds: [sessionId],
          parentSessionId: sessionId,
          sessionKind: "selection_side_chat",
        }),
      ).rejects.toThrow(/mutually exclusive/);
    } finally {
      store.close();
    }
  });
});
