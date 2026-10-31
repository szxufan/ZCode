// ---- 闲时任务(Off-Peak Task)遗留常量 ----
// 闲时任务特性已移除；off_peak_tasks 表 schema 与数据迁移按兼容边界原样保留，
// 这里只留下仍被保留代码引用的常量（身份迁移终态集合、Built-in 目录中的隐藏 Provider id）。

/** 终态集合：不可逆出（状态机不变量）。workspace 身份迁移在 rekey 前据此取消冲突活跃绑定。 */
export const OFF_PEAK_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

/**
 * Off-Peak 隐藏 Provider id；Built-in Provider 目录（config/provider/zcode-builtin.json）
 * 仍保留这两条条目供 CLI 运行时读取，provider 框架按 id 识别其 account-offpeak 分类。
 */
/** 服务端将未激活过号和运行超时分码；两者都需要由 Host 收口，不能遗漏 active 超时。 */
export function isOffPeakTicketExpiredCode(code: string | number | undefined): boolean {
  return code === "3102" || code === 3102 || code === "3106" || code === 3106;
}

export const OFF_PEAK_PROVIDER_IDS = {
  zai: "account:zai-offpeak-idle-plan",
  bigmodel: "account:bigmodel-offpeak-idle-plan",
} as const;
