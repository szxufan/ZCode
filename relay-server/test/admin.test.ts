import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addUser,
  deleteUser,
  listDevices,
  listUsersView,
  setPassword,
} from "../src/admin/operations.js";
import { loginTestAccount, startTestRelay, VALID_PUBLIC_KEY, type TestRelay } from "./helpers.js";

// relay-admin 流程（§8）：list-users、add-user、delete-user、set-password、list-devices。
// admin 操作与在线服务共用同一 SQLite（admin 连接不复位内存在线态）。

let relay: TestRelay;

beforeAll(async () => {
  relay = await startTestRelay();
});

afterAll(async () => {
  await relay.close();
});

describe("relay-admin 操作", () => {
  it("add-user 预建账号可直接密码登录", async () => {
    addUser(relay.db, { phone: "+8613800136400", password: "pw-admin" });
    const login = await fetch(`${relay.httpUrl}/v3/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+8613800136400", password: "pw-admin" }),
    });
    expect(((await login.json()) as { code: number }).code).toBe(0);
  });

  it("list-users / set-password / delete-user", () => {
    addUser(relay.db, { phone: "+8613800136401" });
    const users = listUsersView(relay.db);
    const withPassword = users.find((user) => user.phone_e164 === "+8613800136400");
    const withoutPassword = users.find((user) => user.phone_e164 === "+8613800136401");
    expect(withPassword?.has_password).toBe(true);
    expect(withoutPassword?.has_password).toBe(false);
    expect(setPassword(relay.db, "+8613800136401", "new-pw")).toBe(true);
    expect(
      listUsersView(relay.db).find((u) => u.phone_e164 === "+8613800136401")?.has_password,
    ).toBe(true);
    expect(setPassword(relay.db, "+8613999999999", "x")).toBe(false);
    // delete-user 幂等：存在 true，不存在 false。
    expect(deleteUser(relay.db, "+8613800136401")).toBe(true);
    expect(deleteUser(relay.db, "+8613800136401")).toBe(false);
    expect(listUsersView(relay.db).some((u) => u.phone_e164 === "+8613800136401")).toBe(false);
  });

  it("list-devices 列出账号设备", async () => {
    const { access } = await loginTestAccount(relay, "+8613800136400");
    const created = await fetch(`${relay.httpUrl}/v3/device`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access}`,
      },
      body: JSON.stringify({ device_mid: "mid-admin", public_key: VALID_PUBLIC_KEY }),
    });
    expect(((await created.json()) as { code: number }).code).toBe(0);
    const devices = listDevices(relay.db, "+8613800136400");
    expect(devices).toHaveLength(1);
    expect(devices[0]!.device_mid).toBe("mid-admin");
    expect(devices[0]!.deleted).toBe(false);
    // 删除账号级联软删设备。
    deleteUser(relay.db, "+8613800136400");
    expect(listDevices(relay.db, "+8613800136400")).toHaveLength(0);
  });
});
