import { memo, useEffect, useMemo, useState } from "react";
import { TID_PLAN_DETAIL_COPY, TID_PLAN_DETAIL_SAVE } from "@zcode/shared/test-ids";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { extractPlanToolCallContent } from "@/lib/planToolCall.js";
import type { PlanDetailSidePaneTab } from "@/lib/workspaceSidePane.js";
import { PlanCopyButton, PlanSaveButton } from "@/plan-approval/index.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import { useV4Conversation, V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";

const PlanDetailContent = memo(function PlanDetailContent({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const [lastMarkdown, setLastMarkdown] = useState(tab.markdown);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );

  useEffect(() => {
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  const state = useConversationProjection(lease);

  const liveMarkdown = useMemo(() => {
    const row = state.snapshot?.rows.window.find(
      (candidate) => candidate.kind === "toolCall" && candidate.toolCallId === tab.toolCallId,
    );
    if (!row || row.kind !== "toolCall") return undefined;
    const node = toolCallRowToLegacyNode(row);
    return extractPlanToolCallContent(node.toolCall, tab.workspacePath).markdown;
  }, [state.snapshot, tab.toolCallId, tab.workspacePath]);

  useEffect(() => {
    if (liveMarkdown) setLastMarkdown(liveMarkdown);
  }, [liveMarkdown]);
  useEffect(() => {
    if (tab.markdown) setLastMarkdown(tab.markdown);
  }, [tab.markdown]);

  const markdown = liveMarkdown ?? lastMarkdown;
  // 计划参数仍在流式到达：此时保存会写出半截计划，先禁用（复制不受影响）。
  const planStreaming = useMemo(
    () =>
      state.snapshot?.rows.window.some(
        (candidate) =>
          candidate.kind === "toolCall" &&
          candidate.toolCallId === tab.toolCallId &&
          candidate.status === "inputStreaming",
      ) === true,
    [state.snapshot, tab.toolCallId],
  );
  const planText = markdown ?? "";
  return (
    <div
      data-plan-detail-tool-call-id={tab.toolCallId}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-border px-4">
        <PlanCopyButton markdown={planText} testId={TID_PLAN_DETAIL_COPY} />
        <PlanSaveButton
          markdown={planText}
          scope={{
            workspacePath: tab.workspacePath,
            remote: Boolean(tab.remoteSessionId),
          }}
          disabled={planStreaming}
          testId={TID_PLAN_DETAIL_SAVE}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <MessageResponse
          className="mx-auto w-full max-w-4xl min-w-0 break-words text-foreground"
          workspacePath={tab.workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {markdown}
        </MessageResponse>
      </div>
    </div>
  );
});

export const PlanDetailSidePane = memo(function PlanDetailSidePane({
  tab,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
}: {
  tab: PlanDetailSidePaneTab;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );

  return (
    // provider 接口已收敛为仅按 scope 做连接路由，不再接受
    // isShellWorkspace 参数；side pane 不需要额外的 shell 身份分支。
    <V4PaneConversationProvider scope={scope}>
      <PlanDetailContent
        tab={tab}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
      />
    </V4PaneConversationProvider>
  );
});
