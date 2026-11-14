import type { FileTextEditSnapshot, WriteTextFileFailure } from "@zcode/shared";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getContainingDirectoryPath } from "@/lib/path.js";
import { logger } from "@/logger.js";
import type {
  PreviewPaneDisposable,
  PreviewPaneFilePort,
  PreviewPaneFileWatcherPort,
} from "./contract.js";
import type { TextEditorHandle } from "./monacoEditorRuntime.js";
import { registerUnsavedEditSession, type UnsavedEditDecision } from "./unsavedEditGuard.js";

type SaveOutcome = "saved" | "conflict" | "failed";

function normalizePathForCompare(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

function isSameFile(changedPath: string | undefined, path: string): boolean {
  if (!changedPath) return true;
  return normalizePathForCompare(changedPath) === normalizePathForCompare(path);
}

/**
 * 单文件就地编辑会话：Monaco 懒加载、保存/冲突/外部修改/未保存保护都在这里闭环。
 * 编辑缓冲是组件局部状态，不进入全局 store。
 */
export function PreviewPaneTextEditor({
  path,
  sessionId,
  workspacePath,
  fileService,
  fileWatcherService,
  dark,
  onDirtyChange,
  onExit,
}: {
  path: string;
  sessionId: string;
  workspacePath?: string;
  fileService: PreviewPaneFilePort;
  fileWatcherService: PreviewPaneFileWatcherPort;
  dark: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onExit: () => void;
}) {
  const { intl } = useZCodeIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<TextEditorHandle | null>(null);
  const snapshotRef = useRef<FileTextEditSnapshot | null>(null);
  const baselineRef = useRef("");
  const contentRef = useRef("");
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const darkRef = useRef(dark);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const decisionResolverRef = useRef<((decision: UnsavedEditDecision) => void) | null>(null);
  const saveRef = useRef<() => Promise<SaveOutcome>>(async () => "failed");

  const [, setSnapshotVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formatAvailable, setFormatAvailable] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [externalChange, setExternalChange] = useState(false);
  const [deleted, setDeleted] = useState(false);
  // 外部把文件改成了无法无损往返的形态（编码/混合换行）；与"已删除"分开提示，
  // 因为处置方式不同：这里只能退出编辑或覆盖保存，不能重载。
  const [notLossless, setNotLossless] = useState(false);
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false);

  // 渲染期写 ref 在 concurrent rendering 下会被丢弃或撕裂（渲染可能被中断后重来），
  // 统一放到 layout effect：它在 DOM 变更后、浏览器绘制前同步执行，早于任何用户交互。
  useLayoutEffect(() => {
    darkRef.current = dark;
    onDirtyChangeRef.current = onDirtyChange;
  });

  const applyDirty = useCallback((nextDirty: boolean) => {
    if (dirtyRef.current === nextDirty) return;
    dirtyRef.current = nextDirty;
    setDirty(nextDirty);
    onDirtyChangeRef.current?.(nextDirty);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: FileTextEditSnapshot, content: string) => {
      snapshotRef.current = snapshot;
      baselineRef.current = content;
      contentRef.current = content;
      setSnapshotVersion((value) => value + 1);
      applyDirty(false);
      setConflict(false);
      setExternalChange(false);
      setDeleted(false);
      setNotLossless(false);
    },
    [applyDirty],
  );

  /** 文件是否仍存在：读快照失败时用它区分"已删除"与"变得不可无损编辑"。 */
  const fileStillExists = useCallback(async (): Promise<boolean> => {
    try {
      await fileService.stat({ path });
      return true;
    } catch {
      return false;
    }
  }, [fileService, path]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setLoadError(null);

    void fileService
      .readTextEditSnapshot({ path })
      .then((snapshot) => {
        if (disposed) return;
        applySnapshot(snapshot, snapshot.content);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        logger.error(`[PreviewPaneTextEditor] 读取编辑快照失败 path=${path}`, error);
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });

    void fileService
      .getTextFormatCapability({ path, workspacePath })
      .then((capability) => {
        if (!disposed) setFormatAvailable(capability.formatter !== null);
      })
      .catch(() => {
        if (!disposed) setFormatAvailable(false);
      });

    return () => {
      disposed = true;
    };
  }, [applySnapshot, fileService, path, workspacePath]);

  const snapshotReady = snapshotRef.current !== null;

  useEffect(() => {
    if (!snapshotReady || !containerRef.current) return;
    const container = containerRef.current;
    let disposed = false;
    let handle: TextEditorHandle | null = null;

    void import("./monacoEditorRuntime.js")
      .then((runtime) => {
        if (disposed) return;
        handle = runtime.createTextEditor({
          container,
          value: baselineRef.current,
          language: runtime.resolveMonacoLanguage(path),
          dark: darkRef.current,
          onChange: (value) => {
            contentRef.current = value;
            applyDirty(value !== baselineRef.current);
          },
          onSave: () => {
            void saveRef.current();
          },
        });
        editorRef.current = handle;
      })
      .catch((error: unknown) => {
        // Monaco 懒加载或编辑器创建失败时若不落 loadError，编辑区只会静默空白，
        // 用户无从得知原因（bugfix：defineTheme 收到非法色值抛异常曾走到这里被吞掉）。
        if (disposed) return;
        logger.error(`[PreviewPaneTextEditor] Monaco 编辑器初始化失败 path=${path}`, error);
        setLoadError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      handle?.dispose();
      editorRef.current = null;
    };
    // snapshotReady 只用于等到首次快照完成；后续保存不重建编辑器。
  }, [applyDirty, path, snapshotReady]);

  useEffect(() => {
    if (!editorRef.current) return;
    void import("./monacoEditorRuntime.js").then((runtime) => runtime.setEditorTheme(dark));
  }, [dark]);

  useEffect(() => {
    // 保存中与冲突待决策时锁定输入，避免并发写与决策期间继续编辑。
    editorRef.current?.setReadOnly(saving || decisionDialogOpen || conflict);
  }, [conflict, decisionDialogOpen, saving]);

  const reloadFromDisk = useCallback(async () => {
    try {
      const snapshot = await fileService.readTextEditSnapshot({ path });
      applySnapshot(snapshot, snapshot.content);
      editorRef.current?.setValue(snapshot.content);
    } catch (error) {
      logger.warn(`[PreviewPaneTextEditor] 重新加载失败 path=${path}`, error);
      if (await fileStillExists()) {
        setNotLossless(true);
      } else {
        setDeleted(true);
      }
    }
  }, [applySnapshot, fileService, fileStillExists, path]);

  /**
   * 写入失败按 code 本地化提示。Host 侧已记录 path + code 的服务日志，
   * 这里不再重复打日志，只负责用户可见反馈。
   * 返回 true 表示进入需要用户决策的冲突态。
   */
  const reportWriteFailure = useCallback(
    (result: WriteTextFileFailure): boolean => {
      if (result.code === "stale_file") {
        setConflict(true);
        return true;
      }
      if (result.code === "file_not_found") {
        setDeleted(true);
        toast(intl.formatMessage({ id: "codeViewer.edit.fileDeleted" }));
        return false;
      }
      if (result.code === "not_editable") {
        setNotLossless(true);
        return false;
      }
      const messageId =
        result.code === "symlink_refused"
          ? "codeViewer.edit.symlinkRefused"
          : result.code === "permission_denied"
            ? "codeViewer.edit.permissionDenied"
            : "codeViewer.edit.saveFailed";
      toast(intl.formatMessage({ id: messageId }));
      return false;
    },
    [intl],
  );

  const save = useCallback(async (): Promise<SaveOutcome> => {
    // Ctrl/Cmd+S 在没有改动时不应产生写入副作用。
    if (!dirtyRef.current) return "saved";
    const currentSnapshot = snapshotRef.current;
    if (!currentSnapshot || savingRef.current) return "failed";

    savingRef.current = true;
    setSaving(true);
    try {
      let nextContent = contentRef.current;
      if (formatAvailable) {
        const formatted = await fileService.formatTextContent({
          path,
          content: nextContent,
          workspacePath,
        });
        if (formatted.content !== null) {
          nextContent = formatted.content;
          contentRef.current = formatted.content;
          editorRef.current?.setValue(formatted.content);
        } else if (formatted.error) {
          toast(intl.formatMessage({ id: "codeViewer.edit.formatFailed" }));
        }
      }

      const result = await fileService.writeTextFile({
        path,
        content: nextContent,
        encoding: currentSnapshot.encoding,
        lineEndings: currentSnapshot.lineEndings,
        baseRevision: currentSnapshot.revision,
      });

      if (!result.ok) {
        return reportWriteFailure(result) ? "conflict" : "failed";
      }

      applySnapshot(
        {
          ...currentSnapshot,
          content: nextContent,
          revision: result.revision,
          totalBytes: result.revision.sizeBytes,
        },
        nextContent,
      );
      // Prettier 可能改变了文本，编辑器缓冲必须与磁盘一致。
      editorRef.current?.setValue(nextContent);
      return "saved";
    } catch (error) {
      logger.error(`[PreviewPaneTextEditor] 保存异常 path=${path}`, error);
      toast(intl.formatMessage({ id: "codeViewer.edit.saveFailed" }));
      return "failed";
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applySnapshot, fileService, formatAvailable, intl, path, reportWriteFailure, workspacePath]);
  // save 每轮渲染都是新引用，Monaco 的 Ctrl/Cmd+S 命令只注册一次，
  // 因此通过 ref 转发；写入放在 layout effect 而不是渲染期，避免并发渲染下的撕裂。
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  const overwrite = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const fresh = await fileService.readTextEditSnapshot({ path });
      const result = await fileService.writeTextFile({
        path,
        content: contentRef.current,
        encoding: fresh.encoding,
        lineEndings: fresh.lineEndings,
        baseRevision: fresh.revision,
      });
      if (result.ok) {
        applySnapshot(
          {
            ...fresh,
            content: contentRef.current,
            revision: result.revision,
            totalBytes: result.revision.sizeBytes,
          },
          contentRef.current,
        );
        return;
      }
      reportWriteFailure(result);
    } catch (error) {
      logger.error(`[PreviewPaneTextEditor] 覆盖保存失败 path=${path}`, error);
      toast(intl.formatMessage({ id: "codeViewer.edit.saveFailed" }));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applySnapshot, fileService, intl, path, reportWriteFailure]);

  const formatDocument = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await fileService.formatTextContent({
        path,
        content: contentRef.current,
        workspacePath,
      });
      if (result.content === null) {
        toast(
          intl.formatMessage({
            id: result.error ? "codeViewer.edit.formatFailed" : "codeViewer.edit.formatUnavailable",
          }),
        );
        return;
      }
      contentRef.current = result.content;
      editorRef.current?.setValue(result.content);
      applyDirty(result.content !== baselineRef.current);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applyDirty, fileService, intl, path, workspacePath]);

  const requestDecision = useCallback((): Promise<UnsavedEditDecision> => {
    if (!dirtyRef.current) return Promise.resolve("discarded");
    setDecisionDialogOpen(true);
    return new Promise((resolve) => {
      decisionResolverRef.current = resolve;
    });
  }, []);

  const resolveDecision = useCallback((decision: UnsavedEditDecision) => {
    setDecisionDialogOpen(false);
    const resolve = decisionResolverRef.current;
    decisionResolverRef.current = null;
    resolve?.(decision);
  }, []);

  const handleDialogSave = useCallback(async () => {
    const outcome = await save();
    resolveDecision(outcome === "saved" ? "saved" : "cancel");
  }, [resolveDecision, save]);

  const handleExit = useCallback(async () => {
    const decision = await requestDecision();
    if (decision !== "cancel") {
      onExit();
    }
  }, [onExit, requestDecision]);

  useEffect(() => {
    return registerUnsavedEditSession({
      path,
      sessionId,
      isDirty: () => dirtyRef.current,
      confirmClose: requestDecision,
      focus: () => editorRef.current?.focus(),
    });
  }, [path, requestDecision, sessionId]);

  useEffect(() => {
    let disposed = false;
    let watcherId: string | null = null;
    let subscription: PreviewPaneDisposable | null = null;
    const directoryPath = getContainingDirectoryPath(path);
    if (!directoryPath) return;

    const handleWatchEvent = (changedPath: string | undefined) => {
      if (!isSameFile(changedPath, path)) return;
      void (async () => {
        const current = snapshotRef.current;
        if (!current) return;
        let snapshot: FileTextEditSnapshot;
        try {
          snapshot = await fileService.readTextEditSnapshot({ path });
        } catch (error) {
          if (disposed) return;
          // 读快照失败要区分"文件已删除"和"文件被改成不可无损编辑"，
          // 后者用删除提示会把用户引向错误的处置方式。
          if (!(await fileStillExists())) {
            setDeleted(true);
            return;
          }
          logger.warn(`[PreviewPaneTextEditor] 外部修改后无法无损读取 path=${path}`, error);
          setNotLossless(true);
          return;
        }
        if (disposed) return;
        // 自写回声以内容哈希为准：保存后 watcher 必然触发一次，
        // 用 mtime+size 判定时，外部工具保留 mtime 改写同尺寸内容会被误当成回声而漏掉重载。
        if (snapshot.revision.hash === current.revision.hash) {
          return;
        }
        if (dirtyRef.current) {
          setExternalChange(true);
          return;
        }
        applySnapshot(snapshot, snapshot.content);
        editorRef.current?.setValue(snapshot.content);
      })();
    };

    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;
        subscription = fileWatcherService.onDynamicChange(id)((event) => {
          handleWatchEvent(event.changedPath);
        });
      })
      .catch((error: unknown) => {
        // 监听失败只影响自动刷新，保存仍由 baseRevision 兜底。
        logger.warn(`[PreviewPaneTextEditor] 监听目录失败 path=${path}`, error);
      });

    return () => {
      disposed = true;
      subscription?.dispose();
      if (watcherId) {
        void fileWatcherService.unwatch({ id: watcherId }).catch(() => undefined);
      }
    };
  }, [applySnapshot, fileService, fileStillExists, fileWatcherService, path]);

  const statusLabel = loading
    ? intl.formatMessage({ id: "codeViewer.edit.loading" })
    : dirty
      ? intl.formatMessage({ id: "codeViewer.edit.unsaved" })
      : intl.formatMessage({ id: "codeViewer.edit.saved" });

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface/30 px-3">
        <span
          className={
            dirty ? "size-1.5 rounded-full bg-foreground" : "size-1.5 rounded-full bg-border"
          }
          aria-hidden
        />
        <span className="truncate text-ui-sm text-foreground-subtle">{statusLabel}</span>
        <span className="min-w-0 flex-1" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!formatAvailable || saving || loading}
          title={
            formatAvailable
              ? undefined
              : intl.formatMessage({ id: "codeViewer.edit.formatUnavailable" })
          }
          onClick={() => void formatDocument()}
        >
          {intl.formatMessage({ id: "codeViewer.edit.format" })}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={!dirty || saving || loading || deleted}
          onClick={() => void save()}
        >
          {saving
            ? intl.formatMessage({ id: "codeViewer.edit.saving" })
            : intl.formatMessage({ id: "codeViewer.edit.save" })}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => void handleExit()}>
          {intl.formatMessage({ id: "codeViewer.edit.exit" })}
        </Button>
      </div>

      {deleted ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "codeViewer.edit.fileDeleted" })}
        </div>
      ) : null}

      {notLossless && !deleted ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "codeViewer.edit.notLossless" })}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => void handleExit()}>
            {intl.formatMessage({ id: "codeViewer.edit.exit" })}
          </Button>
        </div>
      ) : null}

      {externalChange && !deleted ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "codeViewer.edit.externalChanged" })}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => void reloadFromDisk()}>
            {intl.formatMessage({ id: "codeViewer.edit.reloadFromDisk" })}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setExternalChange(false)}>
            {intl.formatMessage({ id: "codeViewer.edit.keepLocal" })}
          </Button>
        </div>
      ) : null}

      {conflict ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 text-ui-sm text-foreground-subtle">
          <span className="min-w-0 flex-1">
            {intl.formatMessage({ id: "codeViewer.edit.conflict" })}
          </span>
          <Button type="button" size="sm" variant="ghost" onClick={() => void overwrite()}>
            {intl.formatMessage({ id: "codeViewer.edit.overwrite" })}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => void reloadFromDisk()}>
            {intl.formatMessage({ id: "codeViewer.edit.reloadFromDisk" })}
          </Button>
        </div>
      ) : null}

      {loadError ? (
        <div className="p-4 text-ui-base text-foreground-subtle">{loadError}</div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1" />
      )}

      {decisionDialogOpen ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/60 p-4">
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-4 shadow-lg">
            <p className="text-ui-base text-foreground">
              {intl.formatMessage({ id: "codeViewer.edit.unsavedPrompt" })}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => resolveDecision("cancel")}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => resolveDecision("discarded")}
              >
                {intl.formatMessage({ id: "codeViewer.edit.discard" })}
              </Button>
              <Button type="button" size="sm" onClick={() => void handleDialogSave()}>
                {intl.formatMessage({ id: "codeViewer.edit.save" })}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
