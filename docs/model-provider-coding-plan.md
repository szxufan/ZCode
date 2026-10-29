# Model Provider Coding Plan

> 2026-10-29 起模型设置已移除全部智谱账号类条目（`Z.AI` / `BigModel` 品牌供应商入口、Start Plan、个人/团队 Coding Plan、Team Plan 及其详情页）。模型设置只剩 API Key / 模板接入；本文仅保留仍存在的购买面板（Coding Plan Upgrade Dialog，由侧栏与聊天链路打开）相关约定，其余章节描述的模型设置行为已成为历史。

## Purchase Panel（仍存在）

购买升级弹窗（`CodingPlanUpgradeDialog`）仍由侧栏/会话内的账号态入口打开，其商品目录、价格展示与购买流程约定继续生效：

## Pricing Cards

- Pricing cards are provider-specific. Z.AI uses the Z.AI USD Coding Plan catalog; BigModel uses the BigModel CNY GLM Coding catalog.
- The visible periods are `Monthly`, `Quarterly`, and `Yearly`. Non-monthly periods show the billed period amount plus the monthly equivalent.
- Plan descriptions are also provider-specific, so BigModel wording is not reused from the Z.AI catalog.

## Signed-out Purchase Choice

When BigModel account-based access is disconnected, the purchase choice banners
show For Individuals and For Teams entries before the user opens the full
purchase panel.
Each entry must include the same price hierarchy used by the plan list, placed
between the title and description:

- For Individuals: `¥49.00 人民币 起`
- For Teams: `¥598.00 人民币 起`

The amount formatting must reuse the shared Coding Plan amount formatter so
Chinese and non-Chinese locales keep the same currency semantics as the package
list.

When `client/configs.codingPlanBillingDiscount` is active, the activity is
announced by the purchase panel banner and upgrade action only. The settings
Plan Card title must not show a separate 150% quota badge, because the banner is
the single source of campaign promotion.

The compact Coding Plan usage panel inside a conversation must not render the
150% quota campaign badge. That panel prioritizes quota values, reset timing,
and reset actions within a narrow surface; campaign promotion remains available
from the Model Provider and purchase surfaces.

The signed-out purchase choice banners are acquisition entries rather than Plan
Card status. When the billing discount is active, the signed-out For Individuals
and For Teams entries both show the compact 150% quota badge next to the title.
Logged-in not-subscribed entries and logged-in enterprise team group entries do
not show this badge.

When Z.ai account-based access is disconnected and no Start/Coding entitlement
is available yet, the same signed-out surface is still shown, but only the Start
entry (when `startPlanPreview` exists) and For Individuals entry are visible.
For Teams is hidden for Z.ai.

The purchase panel follows the same product boundary. When the selected provider
does not support For Teams, such as Z.ai, the panel renders the Individuals plan
content directly and does not show Individuals/Teams audience tabs.
This no-tabs branch must still fill the available panel body height so the plan
cards keep the same stretched layout as the tabbed BigModel view.

When the account state is disconnected, clicking For Individuals or For Teams
must start the provider login flow first. The full purchase panel should only
open from these entries after the provider has an authenticated, not-subscribed
purchase token.
