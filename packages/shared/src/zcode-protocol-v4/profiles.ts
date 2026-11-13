// Delivery profile 过滤纯函数。
// 通道层 flush 管线的第一步：filter → coalesce → 打帧。恢复回放走同一函数
// （「先过该订阅者的 profile 过滤器再 coalesce」），保证断线重连的确定性重投递。
//
// 收口不变量（进黄金测试）：被 profile 过滤的事件必须最终被某个不可过滤的事件收口——
// row.delta(inputText) 被滤掉后，工具输入定稿时的 row.upserted 必须携带完整 inputText，
// 否则 replayable 订阅者终态缺数据。任何 reducer 改动破坏该不变量会撞
// 「两 profile 终态逐字节一致」测试。
import type { DeliveryProfile } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow, UserInputRow } from "./rows.js";

export const CONVERSATION_QUERY_PREVIEW_MAX_CHARS = 220;
export const CONVERSATION_QUERY_PREVIEW_MAX_PARAGRAPHS = 2;

/** 问题导航只收录真实用户提交的 query；系统、后台、workflow 与 guide 输入不可导航。 */
export function isNavigableConversationQueryRow(row: ConversationRow): row is UserInputRow {
  return row.kind === "userInput" && row.origin === "realUser";
}

/**
 * 目录预览的规范化截断：合并空白、按空行分段，超过字符/段预算即停止。
 * CLI 服务端目录与 renderer 本地 tail 共用这份语义，避免两侧 preview 漂移。
 */
export function buildConversationQueryPreviewText(
  texts: readonly string[],
  fallback: string,
  maxChars: number = CONVERSATION_QUERY_PREVIEW_MAX_CHARS,
  maxParagraphs: number = CONVERSATION_QUERY_PREVIEW_MAX_PARAGRAPHS,
): string {
  const normalizedMaxChars = Math.max(8, maxChars);
  const normalizedMaxParagraphs = Math.trunc(Math.max(1, maxParagraphs));
  let preview = "";
  let paragraphs = 1;
  let whitespace = false;
  let newlines = 0;
  const truncate = (value: string): string =>
    value.length <= normalizedMaxChars
      ? value
      : `${value.slice(0, normalizedMaxChars - 3).trimEnd()}...`;
  for (const text of texts) {
    if (preview) {
      whitespace = true;
      newlines = 2;
    }
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index]!;
      if (/\s/u.test(character)) {
        whitespace = true;
        if (character === "\n") newlines += 1;
        continue;
      }
      if (whitespace && preview) {
        if (newlines >= 2) {
          if (paragraphs >= normalizedMaxParagraphs) return truncate(preview);
          paragraphs += 1;
          preview += "\n";
        } else {
          preview += " ";
        }
      }
      preview += character;
      whitespace = false;
      newlines = 0;
      if (preview.length > normalizedMaxChars) return truncate(preview);
    }
  }
  return preview || fallback;
}

export function filterConversationRowsForProfile<T extends readonly ConversationRow[]>(
  rows: T,
  _profile: DeliveryProfile,
): T {
  // HookInvocationRow 已收敛为 desktop/mobile 共用的 client-safe summary；当前没有
  // profile-specific 完整行。这里必须免复制直通：rows/range 每页调用时整窗复制会把
  // 分页成本放大成 O(N²/limit)，而调用方只读不修改，readonly 身份即是安全边界。
  return rows;
}

/**
 * 按 profile 的 streamPaths 开关过滤 delta 序列。
 * row.delta 按流式能力过滤；结构性完整行在两个 profile 中保持同一产品事实。
 * 纯函数，不修改入参；输出保持权威日志序。
 */
export function filterConversationDeltasForProfile(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
): ConversationDelta[] {
  return deltas.filter((delta) => {
    if (delta.op === "row.delta") return profile.streamPaths[delta.path];
    return true;
  });
}
