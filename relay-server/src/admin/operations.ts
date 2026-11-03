import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { hashRelayPassword } from "../passwords.js";
import { revokeFamiliesForAccount } from "../refreshTokens.js";

// relay-admin 的业务操作（§8）：list-users、add-user、delete-user、set-password、
// list-devices。CLI 与测试共用；直连数据库（admin 连接不复位内存在线态）。

export interface AdminAccountView {
  id: string;
  phone_e164: string;
  status: string;
  has_password: boolean;
  created_at: number;
}

export interface AdminDeviceView {
  sid: string;
  device_mid: string;
  public_key: string;
  created_at: number;
  deleted: boolean;
}

export function listUsersView(db: DatabaseSync): AdminAccountView[] {
  const rows = db
    .prepare(
      "SELECT id, phone_e164, status, password_scrypt, created_at FROM accounts ORDER BY created_at",
    )
    .all() as (Omit<AdminAccountView, "has_password"> & { password_scrypt: string | null })[];
  return rows.map((row) => ({
    id: row.id,
    phone_e164: row.phone_e164,
    status: row.status,
    has_password: row.password_scrypt !== null,
    created_at: row.created_at,
  }));
}

export function addUser(
  db: DatabaseSync,
  input: { phone: string; password?: string },
): AdminAccountView {
  const id = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  db.prepare(
    "INSERT INTO accounts (id, phone_e164, password_scrypt, created_at) VALUES (?, ?, ?, ?)",
  ).run(
    id,
    input.phone,
    input.password ? hashRelayPassword(input.password) : null,
    Math.floor(Date.now() / 1000),
  );
  return {
    id,
    phone_e164: input.phone,
    status: "active",
    has_password: input.password !== undefined,
    created_at: Math.floor(Date.now() / 1000),
  };
}

export function deleteUser(db: DatabaseSync, phone: string): boolean {
  const row = db.prepare("SELECT id FROM accounts WHERE phone_e164 = ?").get(phone) as
    | { id: string }
    | undefined;
  if (!row) return false;
  // 账号级联：撤销全部会话、软删设备、删账号。
  revokeFamiliesForAccount(db, row.id);
  db.prepare("UPDATE devices SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL").run(
    Math.floor(Date.now() / 1000),
    row.id,
  );
  db.prepare("DELETE FROM accounts WHERE id = ?").run(row.id);
  return true;
}

/** 设置密码并撤销其他会话（与 OpenBitFun set-password 语义一致）。 */
export function setPassword(db: DatabaseSync, phone: string, password: string): boolean {
  const row = db.prepare("SELECT id FROM accounts WHERE phone_e164 = ?").get(phone) as
    | { id: string }
    | undefined;
  if (!row) return false;
  db.prepare("UPDATE accounts SET password_scrypt = ? WHERE id = ?").run(
    hashRelayPassword(password),
    row.id,
  );
  revokeFamiliesForAccount(db, row.id);
  return true;
}

export function listDevices(db: DatabaseSync, phone: string): AdminDeviceView[] {
  const account = db.prepare("SELECT id FROM accounts WHERE phone_e164 = ?").get(phone) as
    | { id: string }
    | undefined;
  if (!account) return [];
  return (
    db
      .prepare(
        "SELECT sid, device_mid, public_key, created_at, deleted_at FROM devices WHERE account_id = ? ORDER BY created_at",
      )
      .all(account.id) as (Omit<AdminDeviceView, "deleted"> & { deleted_at: number | null })[]
  ).map((row) => ({
    sid: row.sid,
    device_mid: row.device_mid,
    public_key: row.public_key,
    created_at: row.created_at,
    deleted: row.deleted_at !== null,
  }));
}
