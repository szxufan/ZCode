export const MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX = 96;

/** 「打开标签页」里内置的 Sites 入口打开的官方插件（只有一个 surface）。 */
export const SITES_PLUGIN_ID = "zcode-site@zcode-plugins-official";

export type OpenTabLauncherItemId =
  | "sites"
  | "selection-side-conversation"
  | "files"
  | "review"
  | "terminal"
  | "browser"
  | "developer-tools";

export function resolveOpenTabLauncherItemIds({
  developerToolsEnabled,
  hasReviewTab,
  canOpenSelectionSideConversation = false,
  canOpenSites = false,
  supportsEmbeddedBrowser = true,
}: {
  developerToolsEnabled: boolean;
  hasReviewTab: boolean;
  canOpenSelectionSideConversation?: boolean;
  canOpenSites?: boolean;
  supportsEmbeddedBrowser?: boolean;
}): OpenTabLauncherItemId[] {
  const itemIds: OpenTabLauncherItemId[] = ["files"];

  if (supportsEmbeddedBrowser) {
    itemIds.push("browser");
  }

  itemIds.push("terminal");

  if (!hasReviewTab) {
    itemIds.push("review");
  }

  // Sites 面板是官方插件 zcode-site 的 UI surface，产品要求作为内置入口排在辅助对话前。
  if (canOpenSites) {
    itemIds.push("sites");
  }

  if (canOpenSelectionSideConversation) {
    itemIds.push("selection-side-conversation");
  }

  if (developerToolsEnabled) {
    itemIds.push("developer-tools");
  }

  return itemIds;
}

export function shouldOfferSelectionSideConversation({
  activeTaskId,
  isMobileTextInputViewport,
}: {
  activeTaskId: string | null;
  isMobileTextInputViewport: boolean;
}): boolean {
  return Boolean(activeTaskId && !isMobileTextInputViewport);
}

export function resolveAnimatedSidePanePanelLayout() {
  return {
    collapsedSize: "0px",
    defaultSize: "0px",
    maxSize: "65%",
    minSize: "240px",
    useResizablePanel: true,
  };
}

export function shouldRenderPreviewPaneHeavyContent({
  isActiveTab,
  isMediaPreview = false,
  isResizeSettling = false,
  isSidePaneVisible,
  minVisibleInlineSizePx = MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  visibleInlineSizePx,
}: {
  isActiveTab: boolean;
  isMediaPreview?: boolean;
  isResizeSettling?: boolean;
  isSidePaneVisible: boolean;
  minVisibleInlineSizePx?: number;
  visibleInlineSizePx: number | null;
}) {
  if (!isSidePaneVisible || !isActiveTab) {
    return false;
  }

  if (isResizeSettling) {
    // 原生 video/audio 进入 HTML fullscreen 时会触发 resize；如果此时卸载
    // 媒体节点，浏览器会因 fullscreen 元素消失而立即退出全屏。
    return isMediaPreview;
  }

  if (visibleInlineSizePx === null) {
    return true;
  }

  return visibleInlineSizePx >= minVisibleInlineSizePx;
}
