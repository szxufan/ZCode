import type { PurchaseAudience } from "@/settings/model-provider-section/codingPlanEnterpriseTiers.js";

/**
 * Coding Plan 升级弹窗目标。
 *
 * 原「关闭弹窗 → OAuth 登录 → 成功后重开」的恢复链路随应用登录改为 relay 账号而移除；
 * 购买流程现全部在官网 webview 内完成，这里只保留弹窗契约类型。
 */
export interface CodingPlanUpgradeDialogTarget {
  providerId: string;
  initialAudience?: PurchaseAudience;
  initialTeamPlanKey?: string;
  funnelContext?: import("@/lib/codingPlanFunnelTelemetry.js").CodingPlanFunnelContext;
}
