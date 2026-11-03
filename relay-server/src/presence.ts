// 设备在线态注册表：WS 配对 owner 的只读视图，供 HTTP 设备列表计算 online。
// 写入方唯一为 ws 模块（配对 owner 的唯一事实源，§5.2）。

export interface PresenceConnectionMeta {
  meta: Record<string, unknown>;
}

export interface PresenceEntry {
  device?: PresenceConnectionMeta;
  terminal?: PresenceConnectionMeta;
}

export class RelayPresence {
  private readonly entries = new Map<string, PresenceEntry>();

  setRole(deviceSid: string, role: "device" | "terminal", value: PresenceConnectionMeta): void {
    const entry = this.entries.get(deviceSid) ?? {};
    entry[role] = value;
    this.entries.set(deviceSid, entry);
  }

  /** 仅当该角色当前 owner 与传入连接一致时释放（旧连接异步 close 不得移除新 owner）。 */
  releaseRole(deviceSid: string, role: "device" | "terminal", value: PresenceConnectionMeta): void {
    const entry = this.entries.get(deviceSid);
    if (!entry || entry[role] !== value) return;
    delete entry[role];
    if (!entry.device && !entry.terminal) this.entries.delete(deviceSid);
  }

  isOnline(deviceSid: string): boolean {
    return this.entries.get(deviceSid)?.device !== undefined;
  }

  hasTerminal(deviceSid: string): boolean {
    return this.entries.get(deviceSid)?.terminal !== undefined;
  }
}
