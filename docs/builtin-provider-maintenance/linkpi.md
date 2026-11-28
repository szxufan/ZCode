# 连接派（LinkPi）接入规格

Status: in-progress
Date: 2026-11-26

## 目标行为

新增普通 API Key 供应商模板 `linkpi`，展示名 zh-CN「连接派」/ en-US「LinkPi」，使用
`openai-chat-completions` 协议，默认 Base URL `https://new-api.test.mylinkpi.com/v1`。模板
`builtinModelIds` 为空；模型由用户在设置页手动拉取 `/models`、筛选勾选确认后写入 Personal Exact Rules。
拉取能力对所有 API Key + OpenAI Chat 供应商开放（见
[模型拉取预览与二次选择导入](../working-memory/provider-refactor/design/registry/settings.md)）。

## 来源证据（2026-11-26 实测）

对 `https://new-api.test.mylinkpi.com/v1/models`（使用维护者提供的测试密钥）进行了一次只读请求，得到：

- Envelope：`{success: boolean, object: "list", data: [...]}`；`data` 数组 76 条。
- 每条必有字段：`id`（原始模型 ID）、`object: "model"`、`created`、`owned_by`、`supported_endpoint_types`。
- 可选元数据字段分布：

| 字段                    | 出现次数 | 含义                     | 映射目标                                        |
| ----------------------- | -------: | ------------------------ | ----------------------------------------------- |
| `context_length`        |       36 | 上下文长度               | `properties.contextWindow`（正整数）             |
| `max_output_tokens`     |       36 | 最大输出 Token           | `optionSpecs.maxOutputTokens.max`（正整数）      |
| `reasoning_options`     |       27 | 推理档位字符串数组       | 不映射（不伪造 reasoning values/map）            |
| `support_image_input`   |       27 | 支持图片输入             | `properties.inputFormat.supportsImage`           |
| `support_video_input`   |        8 | 支持视频输入             | `properties.inputFormat.supportsVideo`           |
| `purposes`              |       15 | 用途标签                 | 不映射                                           |

- `supported_endpoint_types` 含 `openai`（对话）、`jina-rerank`、`embeddings`、`asr`、`tts`、
  `image-generation` 等非对话端点；缺少 `openai` 端点的候选在预览中禁选。
- Text/PDF/Audio 输入和输出模态未在响应中声明，保持未覆盖（继承现有 Built-in 兜底）。
- 测试密钥未写入仓库；真实响应中的模型 ID 保留原始大小写和标点。

## 非目标

- 不为连接派内置静态模型目录或 `templateModelRules`；拉取导入的模型写入 Personal 层。
- 不实现后台同步、周期刷新或远端消失模型自动删除。
- 不修改 OpenAI Adapter、连接测试 RPC 或共享协议。
- 不新增品牌 Logo 资源；缺失时沿用通用图标回退。

## 验收

- 连接派模板在 Release 根部 `forkTemplateIds` 中声明，Source 对所有候选叠加；即使远端 Release
  revision 更高且不含 linkpi，模板也不会丢失。
- 连接派模板在"添加供应商"独立分组"连接派"中置顶，不进"其他"；创建实例后 Base URL 和 API 类型正确继承。
- 设置页显示"拉取模型"按钮；点击后打开筛选多选弹窗，不直接写入配置。
- 确认导入选中的新模型后，模型出现在列表中并进入 Registry；取消则无副作用。
- E2E 候选用例 `provider-model-discovery.test.ts` 4/4 通过（保持 `manual-review/pending` 直到人工 review）。
  运行产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20261128050654624-p1748-17ff5a8357c81aeb`（Windows Electron，2026-11-28）。
- 真实 `/models` 解析（76 条，61 个对话端点）和 `glm-5.3-flash` 低预算 `/chat/completions` 冒烟通过
  （finish=length，16 completion tokens；密钥不入库）。

## Comments

- 2026-11-26 验证记录：导入写入与 revision 语义在一轮 E2E 中收口——全局 registry revision 不作为导入
  冲突判据（无关供应商的后台刷新会误伤在途弹窗），改用连接事实指纹（baseUrl+Key）拒绝迟到请求；
  成员新鲜度由写入时快照与 `membership.personalRevision` 断言保证。该裁决已同步
  [settings.md](../working-memory/provider-refactor/design/registry/settings.md)。
