import { runRelayV3DeviceAuthFlow } from "./deviceAuth.js";

// `zcode server login`（R4，§5.5）：终端显示输入码与授权地址，批准后凭据落
// server root（重启免重登；任何同账号已认证设备可删除该设备实现远程吊销）。

export interface RelayV3LoginIo {
  stdout?: { write(value: string): void };
  stderr?: { write(value: string): void };
}

export async function runRelayV3LoginCommand(
  io: RelayV3LoginIo,
  json: boolean,
  serverRoot: string,
  relayOrigin: string,
): Promise<number> {
  const out = io.stdout ?? process.stdout;
  const err = io.stderr ?? process.stderr;
  try {
    const result = await runRelayV3DeviceAuthFlow({
      relayOrigin,
      serverRoot,
      display: (info) => {
        if (json) {
          out.write(
            `${JSON.stringify({
              ok: true,
              stage: "pending-approval",
              userCode: info.userCode,
              fingerprint: info.fingerprint,
              authUrl: info.authUrl,
            })}\n`,
          );
          return;
        }
        out.write(
          [
            "Relay V3 设备授权 / Device authorization",
            `  输入码 / User code: ${info.userCode}`,
            `  公钥指纹 / Key fingerprint: ${info.fingerprint}`,
            `  授权地址 / Approve at: ${info.authUrl}`,
            "在任一已登录设备上批准后继续…… / Waiting for approval…",
            "",
          ].join("\n"),
        );
      },
    });
    if (json) {
      out.write(
        `${JSON.stringify({
          ok: true,
          stage: "approved",
          deviceSid: result.credentials.deviceSid,
          account: result.credentials.account,
        })}\n`,
      );
    } else {
      out.write(
        `已接入 / Registered: ${result.credentials.deviceSid} (${result.credentials.account.phone_masked})\n`,
      );
    }
    return 0;
  } catch (error) {
    if (json) {
      out.write(
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    } else {
      err?.write(
        `设备授权失败 / Device authorization failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return 1;
  }
}
