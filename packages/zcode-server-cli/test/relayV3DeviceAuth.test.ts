import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeRelayV3 } from "@zcode/shared/testing/fake-relay-v3";

import {
  loadOrGenerateRelayV3DaemonIdentity,
  loadRelayV3DaemonCredentials,
  relayV3DeviceAuthPaths,
  runRelayV3DeviceAuthFlow,
} from "../src/relay-v3/deviceAuth.js";

// R4 设备授权端到端（§5.5）：request → pending poll → 批准（同账号已认证设备）
// → poll 交付 {access, refresh, device} → 凭据落 server root；私钥/凭据文件 0600
// 语义（Windows 由目录 ACL 承担）。过期分支：超时后抛业务码。

const PHONE = "+8613800138003";

describe("Relay V3 headless 设备授权（R4，fake relay 集成）", () => {
  let relay: Awaited<ReturnType<typeof createFakeRelayV3>>;
  let serverRoot: string;
  let approverAccess: string;

  beforeAll(async () => {
    relay = await createFakeRelayV3({ accounts: [PHONE] });
    serverRoot = mkdtempSync(join(tmpdir(), "relay-v3-r4-"));
    approverAccess = await login();
  });

  afterAll(async () => {
    await relay.close();
    rmSync(serverRoot, { recursive: true, force: true });
  });

  it("request → 批准 → poll 交付凭据 → 落盘（指纹核对信息展示）", async () => {
    const displayed: { userCode: string; fingerprint: string; authUrl: string }[] = [];
    const flowPromise = runRelayV3DeviceAuthFlow({
      relayOrigin: relay.httpUrl,
      serverRoot,
      pollIntervalMs: 50,
      display: (info) => displayed.push(info),
    });
    // display 回调即「终端展示」接缝：user_code 到达后用已认证账号批准。
    const deadline = Date.now() + 5_000;
    while (displayed.length === 0) {
      if (Date.now() > deadline) throw new Error("user_code not displayed");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const userCode = displayed[0]!.userCode;
    const approveResponse = await fetch(`${relay.httpUrl}/v3/device-auth/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${approverAccess}` },
      body: JSON.stringify({ user_code: userCode }),
    });
    const approveEnvelope = (await approveResponse.json()) as { code: number };
    expect(approveEnvelope.code).toBe(0);

    const result = await flowPromise;
    expect(result.credentials.deviceSid).toBeTruthy();
    expect(result.credentials.access).toBeTruthy();
    // 展示信息含 8 位 hex 指纹与授权地址（§5.5 批准核对必选项）。
    expect(displayed[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(displayed[0]!.authUrl).toContain(relay.httpUrl);
    // 凭据与身份（device_sid 补记）落 server root。
    const stored = loadRelayV3DaemonCredentials(serverRoot);
    expect(stored?.deviceSid).toBe(result.credentials.deviceSid);
    const identity = loadOrGenerateRelayV3DaemonIdentity(serverRoot);
    expect(identity.deviceSid).toBe(result.credentials.deviceSid);
    // 凭据文件不含私钥、私钥文件不含 access（两文件职责分离）。
    const { identityFile, credentialsFile } = relayV3DeviceAuthPaths(serverRoot);
    const identityRaw = readFileSync(identityFile, "utf-8");
    const credentialsRaw = readFileSync(credentialsFile, "utf-8");
    expect(identityRaw).not.toContain(result.credentials.access);
    expect(credentialsRaw).not.toContain(identityRaw);
  }, 20_000);

  it("未批准超时 → 业务码 EXPIRED 语义（换新密钥对重新发起）", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-v3-r4b-"));
    try {
      await expect(
        runRelayV3DeviceAuthFlow({
          relayOrigin: relay.httpUrl,
          serverRoot: root,
          pollIntervalMs: 20,
          deadlineMs: 300,
        }),
      ).rejects.toMatchObject({ code: 9 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("凭据未落盘时 daemon transport 不启动（isConfigured=false）", async () => {
    const { RelayV3DaemonTransport } = await import("../src/relay-v3/deviceTransport.js");
    const emptyRoot = mkdtempSync(join(tmpdir(), "relay-v3-r4c-"));
    try {
      const transport = new RelayV3DaemonTransport({
        relayOrigin: relay.httpUrl,
        serverRoot: emptyRoot,
      });
      expect(transport.isConfigured()).toBe(false);
      transport.start(); // 无凭据：no-op，不抛错。
      transport.stop();
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  async function login(): Promise<string> {
    await fetch(`${relay.httpUrl}/v3/auth/sms-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE }),
    });
    const code = relay.smsCode(PHONE);
    const response = await fetch(`${relay.httpUrl}/v3/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: PHONE, code }),
    });
    const envelope = (await response.json()) as { code: number; data: { access: string } };
    expect(envelope.code).toBe(0);
    return envelope.data.access;
  }
});

