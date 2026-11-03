import {
  RelayV3HttpClient,
  type RelayV3Device,
} from "@zcode/shared/remote-relay-v3";

// 设备目录（P2，V2 06 语义的手机侧落地）：同账号设备列表、在线分组、最近设备偏好。
// localStorage 最近 SID/MID 仅是偏好（V2 06），不证明归属或在线。

const LAST_SID_KEY = "zcode-web-remote-last-device-sid";
const LAST_MID_KEY = "zcode-web-remote-last-device-mid";

export interface DeviceCatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createDeviceCatalog(options: {
  resolveOrigin: () => string | null;
  acquireAccessToken: () => Promise<string | null>;
  storage?: DeviceCatalogStorage;
  fetchImpl?: typeof fetch;
}) {
  const storage: DeviceCatalogStorage =
    options.storage ??
    (typeof localStorage !== "undefined"
      ? localStorage
      : { getItem: () => null, setItem: () => {} });

  async function listDevices(): Promise<RelayV3Device[]> {
    const origin = options.resolveOrigin();
    const access = await options.acquireAccessToken();
    if (!origin || !access) {
      throw new Error("relay session unavailable");
    }
    const client = new RelayV3HttpClient({ baseUrl: origin, fetch: options.fetchImpl });
    return client.request("list", { bearer: access });
  }

  function readLastDevice(): { sid: string | null; mid: string | null } {
    return {
      sid: storage.getItem(LAST_SID_KEY),
      mid: storage.getItem(LAST_MID_KEY),
    };
  }

  function rememberDevice(sid: string, mid?: string): void {
    try {
      storage.setItem(LAST_SID_KEY, sid);
      if (mid) storage.setItem(LAST_MID_KEY, mid);
    } catch {
      // 存储失败不阻断连接（V2 06）。
    }
  }

  /**
   * 最近设备落点（V2 06 顺序）：
   * 1. 最近 SID 在线 → 直连；
   * 2. 最近 SID 不在线但同 MID 恰好 1 个在线 SID → 接续该 SID；
   * 3. 其余 → null（展示列表，不任选）。
   */
  function resolveRecentLanding(devices: RelayV3Device[]): RelayV3Device | null {
    const online = devices.filter((device) => device.online);
    const { sid, mid } = readLastDevice();
    if (!sid) return null;
    const bySid = online.find((device) => device.device_sid === sid);
    if (bySid) return bySid;
    if (!mid) return null;
    const sameMid = online.filter((device) => device.device_mid === mid);
    return sameMid.length === 1 ? sameMid[0]! : null;
  }

  return { listDevices, readLastDevice, rememberDevice, resolveRecentLanding };
}
