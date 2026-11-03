import { readFileSync } from "node:fs";

import { addUser, deleteUser, listDevices, listUsersView, setPassword } from "./operations.js";
import { openRelayDatabase } from "../db.js";
import { loadRelayConfig, RelayConfigError } from "../config.js";

// relay-admin CLI（§8）：list-users | add-user --phone [--password-stdin] |
// delete-user --phone | set-password --phone --password-stdin | list-devices --phone。
// 数据库路径取 --db 或 RELAY_DB_PATH（fail closed）。

interface CliArgs {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): CliArgs {
  const [command = "", ...rest] = argv;
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      index += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

function readPasswordFromStdin(): string {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    console.error("无法从 stdin 读取密码");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  let dbPath = typeof flags.get("db") === "string" ? (flags.get("db") as string) : "";
  if (!dbPath) {
    try {
      dbPath = loadRelayConfig().dbPath;
    } catch (error) {
      if (error instanceof RelayConfigError) {
        console.error(`缺少数据库路径：请设置 --db 或 RELAY_DB_PATH（${error.message}）`);
        process.exit(1);
      }
      throw error;
    }
  }
  const db = openRelayDatabase(dbPath);
  const phone = typeof flags.get("phone") === "string" ? (flags.get("phone") as string) : "";
  switch (command) {
    case "list-users": {
      for (const user of listUsersView(db)) {
        console.log(
          `${user.phone_e164}\t${user.status}\t${user.has_password ? "password" : "-"}\t${user.id}`,
        );
      }
      break;
    }
    case "add-user": {
      if (!phone) {
        console.error("用法：relay-admin add-user --phone <E.164> [--password-stdin]");
        process.exit(1);
      }
      const password = flags.has("password-stdin") ? readPasswordFromStdin() : undefined;
      const user = addUser(db, { phone, password });
      console.log(`created ${user.phone_e164} ${user.id}`);
      break;
    }
    case "delete-user": {
      if (!phone) {
        console.error("用法：relay-admin delete-user --phone <E.164>");
        process.exit(1);
      }
      console.log(deleteUser(db, phone) ? `deleted ${phone}` : `not found: ${phone}`);
      break;
    }
    case "set-password": {
      if (!phone || !flags.has("password-stdin")) {
        console.error("用法：relay-admin set-password --phone <E.164> --password-stdin");
        process.exit(1);
      }
      console.log(setPassword(db, phone, readPasswordFromStdin()) ? "ok" : `not found: ${phone}`);
      break;
    }
    case "list-devices": {
      if (!phone) {
        console.error("用法：relay-admin list-devices --phone <E.164>");
        process.exit(1);
      }
      for (const device of listDevices(db, phone)) {
        console.log(
          `${device.sid}\t${device.device_mid}\t${device.public_key.slice(0, 12)}…\t${device.deleted ? "deleted" : "active"}`,
        );
      }
      break;
    }
    default:
      console.error(
        [
          "用法：relay-admin <command> [--db <path>]",
          "  list-users",
          "  add-user --phone <E.164> [--password-stdin]",
          "  delete-user --phone <E.164>",
          "  set-password --phone <E.164> --password-stdin",
          "  list-devices --phone <E.164>",
        ].join("\n"),
      );
      process.exit(1);
  }
  db.close();
}

await main();
