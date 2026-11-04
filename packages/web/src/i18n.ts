// /remote/v4 双语文案（§9 P2：中英文回归）。键集与页面组件对齐。
export type WebLocale = "zh-CN" | "en-US";

const STRINGS = {
  "zh-CN": {
    "app.title": "ZCode",
    "login.title": "登录后继续使用远程控制",
    "login.description": "使用与电脑端相同的手机号登录。",
    "login.phone": "手机号",
    "login.code": "验证码",
    "login.sendCode": "发送验证码",
    "login.resendIn": "{seconds}s 后重发",
    "login.submit": "登录",
    "login.relayOrigin": "Relay 地址",
    "devices.title": "选择电脑",
    "devices.refresh": "刷新",
    "devices.online": "在线",
    "devices.offline": "离线",
    "devices.empty": "暂无设备",
    "devices.emptyHint": "在电脑端 ZCode 登录同一账号并开启远程控制，然后刷新列表。",
    "devices.loadFailed": "无法加载设备，请检查网络后刷新。",
    "devices.unnamed": "未命名设备",
    "devices.connections": "{n} 个连接",
    "connect.connecting": "正在连接",
    "connect.bootstrap": "同步工作区",
    "connect.failed": "连接失败",
    "connect.retry": "重试",
    "connect.backToList": "选择其他设备",
    "chat.workspaces": "工作区",
    "chat.bridge": "已建立加密通道",
    "chat.bridgePending": "正在建立工作区通道",
    "chat.sendPlaceholder": "输入消息…",
    "chat.send": "发送",
    "status.waiting": "等待桌面端配对",
    "status.active": "已连接",
    "common.logout": "退出登录",
    "common.cancel": "取消",
  },
  "en-US": {
    "app.title": "ZCode",
    "login.title": "Sign in to continue",
    "login.description": "Use the same phone number as on your computer.",
    "login.phone": "Phone number",
    "login.code": "Verification code",
    "login.sendCode": "Send code",
    "login.resendIn": "Resend in {seconds}s",
    "login.submit": "Sign in",
    "login.relayOrigin": "Relay origin",
    "devices.title": "Choose a computer",
    "devices.refresh": "Refresh",
    "devices.online": "Online",
    "devices.offline": "Offline",
    "devices.empty": "No devices yet",
    "devices.emptyHint":
      "Sign in with the same account on your computer, enable remote control, then refresh.",
    "devices.loadFailed": "Could not load devices. Check your connection and refresh.",
    "devices.unnamed": "Unnamed device",
    "devices.connections": "{n} connections",
    "connect.connecting": "Connecting to",
    "connect.bootstrap": "Syncing workspaces",
    "connect.failed": "Connection failed",
    "connect.retry": "Try again",
    "connect.backToList": "Choose another device",
    "chat.workspaces": "Workspaces",
    "chat.bridge": "Encrypted bridge established",
    "chat.bridgePending": "Opening workspace bridge",
    "chat.sendPlaceholder": "Type a message…",
    "chat.send": "Send",
    "status.waiting": "Waiting for the desktop to pair",
    "status.active": "Connected",
    "common.logout": "Sign out",
    "common.cancel": "Cancel",
  },
} as const;

export type WebStringKey = keyof (typeof STRINGS)["zh-CN"];

export function formatWebString(locale: WebLocale, key: WebStringKey, params?: Record<string, string | number>): string {
  const template = STRINGS[locale][key] ?? STRINGS["zh-CN"][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

export function detectWebLocale(): WebLocale {
  if (typeof navigator === "undefined") return "zh-CN";
  return navigator.language.startsWith("zh") ? "zh-CN" : "en-US";
}
