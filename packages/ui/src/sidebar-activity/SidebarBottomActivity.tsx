import { GlobalNoticeSurface } from "@/global-notice/GlobalNoticeSurface.js";
import type { GlobalNoticeStore } from "@/global-notice/globalNoticeStore.js";

/**
 * 左下角活动槽位的只读投影：营销触达 banner 已随 ZCode 服务解耦移除，
 * 槽位现在只承载全局通知（highspeed 分享卡等）。未注入 store 时走
 * GlobalNoticeSurface 默认的 browserGlobalNoticeStore；不可见时返回 null，不产生多余 DOM。
 */
export function SidebarBottomActivity({
  noticeStore,
}: {
  noticeStore?: GlobalNoticeStore | null;
} = {}) {
  return <GlobalNoticeSurface store={noticeStore ?? undefined} />;
}
