import {
  EMPTY_AUTOMATION_TEMPLATE_CATALOG,
  type AutomationTemplateCatalog,
} from "@/settings/automationTemplateCatalog.js";

export type AutomationTemplateCatalogState = AutomationTemplateCatalog & {
  loading: boolean;
};

/**
 * Client Scenes 远程模板目录已随 scenes 服务下线；
 * 定时/闲时模板目前只剩本地 Customize 入口，远程目录恒为空。
 */
export function useAutomationTemplates(): AutomationTemplateCatalogState {
  return {
    ...EMPTY_AUTOMATION_TEMPLATE_CATALOG,
    loading: false,
  };
}
