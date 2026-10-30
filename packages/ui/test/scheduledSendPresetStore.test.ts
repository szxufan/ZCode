import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "zcode-scheduled-send-presets:v1";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

/** store 在模块加载时读 localStorage；用动态 import + resetModules 覆盖初始化路径。 */
async function loadStore(storage: MemoryStorage) {
  vi.stubGlobal("window", { localStorage: storage });
  vi.resetModules();
  const module = await import("@/v4/scheduled-send/index.js");
  return module.useScheduledSendPresetStore;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("scheduledSendPresetStore", () => {
  it("无持久化数据时回退默认预设", async () => {
    const store = await loadStore(new MemoryStorage());
    expect(store.getState().presets).toHaveLength(5);
  });

  it("新增预设写入 localStorage 并可读回", async () => {
    const storage = new MemoryStorage();
    const store = await loadStore(storage);
    const ok = store.getState().addPreset({ kind: "offset", offsetMinutes: 45 });
    expect(ok).toBe(true);
    expect(store.getState().presets).toHaveLength(6);
    const persisted = JSON.parse(storage.raw(STORAGE_KEY) ?? "[]") as Array<{
      kind: string;
      offsetMinutes?: number;
    }>;
    expect(persisted.at(-1)).toMatchObject({ kind: "offset", offsetMinutes: 45 });
  });

  it("非法预设被拒绝且不落盘", async () => {
    const storage = new MemoryStorage();
    const store = await loadStore(storage);
    expect(store.getState().addPreset({ kind: "offset", offsetMinutes: 0 })).toBe(false);
    expect(store.getState().addPreset({ kind: "dailyTime", time: "25:00" })).toBe(false);
    expect(store.getState().presets).toHaveLength(5);
    expect(storage.raw(STORAGE_KEY)).toBeNull();
  });

  it("删除与恢复默认同步持久化", async () => {
    const storage = new MemoryStorage();
    const store = await loadStore(storage);
    const first = store.getState().presets[0]!;
    store.getState().removePreset(first.id);
    expect(store.getState().presets.some((preset) => preset.id === first.id)).toBe(false);
    expect(JSON.parse(storage.raw(STORAGE_KEY) ?? "[]")).toHaveLength(4);
    store.getState().resetDefaults();
    expect(store.getState().presets).toHaveLength(5);
  });

  it("达到上限后拒绝新增", async () => {
    const store = await loadStore(new MemoryStorage());
    while (store.getState().presets.length < 10) {
      expect(store.getState().addPreset({ kind: "offset", offsetMinutes: 5 })).toBe(true);
    }
    expect(store.getState().addPreset({ kind: "offset", offsetMinutes: 5 })).toBe(false);
    expect(store.getState().presets).toHaveLength(10);
  });

  it("启动时恢复已持久化预设并丢弃脏条目", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { id: "custom-1", kind: "dailyTime", time: "07:30" },
        { id: "bad-1", kind: "offset", offsetMinutes: 0 },
        { id: "bad-2", kind: "unknown" },
      ]),
    );
    const store = await loadStore(storage);
    expect(store.getState().presets).toEqual([
      { id: "custom-1", kind: "dailyTime", time: "07:30" },
    ]);
  });

  it("持久化内容损坏时回退默认预设", async () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{not-json");
    const store = await loadStore(storage);
    expect(store.getState().presets).toHaveLength(5);
  });
});
