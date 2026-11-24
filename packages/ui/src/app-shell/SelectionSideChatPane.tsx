import { memo, useCallback, useEffect, useMemo } from "react";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { SelectionSideChatPaneTab } from "@/lib/workspaceSidePane.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { registerSelectionSideChatStop } from "@/lib/selectionSideChatRuntime.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider, useV4Conversation } from "@/v4/V4ConversationContext.js";
import { logger } from "@/logger.js";

/**
 * 关闭辅助对话 tab 时由 close 路径按 childSessionId 调 stop：只停当前 turn，不 close runtime。
 * 必须在 Pane Conversation Provider 内取 sendCommand，才能沿用与 pane 相同的 workspace/remote 路由。
 */
function SelectionSideChatStopBridge({ childSessionId }: { childSessionId: string }) {
  const { sendCommand } = useV4Conversation();
  useEffect(() => {
    return registerSelectionSideChatStop(childSessionId, () => {
      void sendCommand(
        createCommandEnvelope({ type: "stop", sessionId: childSessionId, payload: {} }),
      ).catch((error) => {
        // child 已被 pool 回收或冷恢复未完成时 stop 会失败；detach 不依赖 stop 成功。
        logger.warn("[App] 关闭辅助对话时 stop 失败", {
          childSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }, [childSessionId, sendCommand]);
  return null;
}

export const SelectionSideChatPane = memo(function SelectionSideChatPane({
  tab,
  focused,
  onOpenBrowserUrl,
  onOpenCodeViewer,
  onOpenFileLink,
  onUnavailable,
}: {
  tab: SelectionSideChatPaneTab;
  focused: boolean;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onUnavailable: (tabId: string) => void;
}) {
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  // 父级 tabs.map 原来为每个 memo pane 创建内联闭包，任意父级渲染都会
  // 破坏 onUnavailable 引用稳定性；由叶子按稳定 tab id 收口回调。
  const handleUnavailable = useCallback(() => onUnavailable(tab.id), [onUnavailable, tab.id]);
  return (
    <V4PaneConversationProvider scope={scope}>
      <SelectionSideChatStopBridge childSessionId={tab.childSessionId} />
      <SessionPane
        paneId={tab.id}
        sessionId={tab.childSessionId}
        rootSessionId={tab.parentSessionId}
        openTrigger="selection"
        selectionSideChat
        focused={focused}
        telemetryVisible={focused}
        workspacePath={tab.workspacePath}
        workspaceIdentity={tab.workspaceIdentity}
        remoteSessionId={tab.remoteSessionId}
        onOpenBrowserUrl={onOpenBrowserUrl}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onSelectionSideChatUnavailable={handleUnavailable}
      />
    </V4PaneConversationProvider>
  );
});
