import { expect, it } from "vitest";
import {
  decodeZCodeBuiltinRelease,
  overlayForkTemplates,
  serializeZCodeBuiltinRelease,
} from "../../provider-node/src/index.js";

const bundled = () =>
  decodeZCodeBuiltinRelease({
    schemaVersion: 1,
    revision: 49,
    forkTemplateIds: ["linkpi"],
    config: {
      providerConfigRules: {
        templateRules: [
          {
            templateId: "linkpi",
            templateNameMap: { "zh-CN": "连接派", "en-US": "LinkPi" },
            config: {
              access: { type: "api-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.test/v1" },
              builtinModelIds: [],
            },
          },
        ],
        providerRules: [],
      },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [
          {
            templateId: "linkpi",
            modelId: "demo",
            config: { enabled: true },
          },
        ],
        builtinProviderModelRules: [],
      },
    },
  });

const remoteHigherRevision = () =>
  decodeZCodeBuiltinRelease({
    schemaVersion: 1,
    revision: 120,
    config: {
      providerConfigRules: { templateRules: [], providerRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  });

it("fork 模板与模板规则在任何更高 revision 的远端 Release 后仍保留", () => {
  const effective = overlayForkTemplates(remoteHigherRevision(), bundled());
  expect(effective.revision).toBe(120);
  expect(effective.forkTemplateIds).toEqual(["linkpi"]);
  expect(effective.config.providerTemplates.get("linkpi")?.config.api?.baseUrl).toBe(
    "https://example.test/v1",
  );
  expect(
    effective.config.modelConfigRules
      .rules()
      .some((rule) => rule.type === "template-model" && rule.templateId === "linkpi"),
  ).toBe(true);
  expect(JSON.parse(serializeZCodeBuiltinRelease(effective)).forkTemplateIds).toEqual(["linkpi"]);
});

it("重复叠加保持幂等，不会累积 fork 模板规则", () => {
  const once = overlayForkTemplates(remoteHigherRevision(), bundled());
  const twice = overlayForkTemplates(once, bundled());
  const countForkRules = (release: typeof once) =>
    release.config.modelConfigRules
      .rules()
      .filter((rule) => rule.type === "template-model" && rule.templateId === "linkpi").length;
  expect(countForkRules(once)).toBe(1);
  expect(countForkRules(twice)).toBe(1);
  expect(serializeZCodeBuiltinRelease(twice)).toBe(serializeZCodeBuiltinRelease(once));
});

it("forkTemplateIds 指向不存在模板时失败而不是静默丢模板", () => {
  expect(() =>
    overlayForkTemplates(remoteHigherRevision(), {
      ...bundled(),
      forkTemplateIds: ["missing-template"],
    }),
  ).toThrow(/forkTemplateIds 指定的模板不在 Bundled 中/u);
});

it("没有 forkTemplateIds 的远端 Release 不被叠加且保持可解析", () => {
  const remote = remoteHigherRevision();
  const effective = overlayForkTemplates(
    remote,
    decodeZCodeBuiltinRelease(
      JSON.parse(
        JSON.stringify({
          schemaVersion: 1,
          revision: 49,
          config: JSON.parse(
            serializeZCodeBuiltinRelease(bundled()).replace(/,"forkTemplateIds":\["linkpi"\]/u, ""),
          ).config,
        }),
      ),
    ),
  );
  expect(serializeZCodeBuiltinRelease(effective)).toBe(serializeZCodeBuiltinRelease(remote));
});
