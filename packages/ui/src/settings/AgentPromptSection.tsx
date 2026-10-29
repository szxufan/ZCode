import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_PROMPT_BUILTIN_PROFILE_ID,
  AGENT_PROMPT_PROFILES_MAX,
  composeDefaultAgentPromptBody,
  type AgentPromptProfile,
} from "@zcode/shared";
import {
  AGENT_PROMPT_DRAFT_EMPTY_OUTPUT_CODE,
  AGENT_PROMPT_DRAFT_WORKSPACE_REQUIRED_CODE,
} from "@zcode/services";
import {
  TID_SETTINGS_AGENT_PROMPT_ACTIVATE,
  TID_SETTINGS_AGENT_PROMPT_PROFILE_ITEM,
  TID_SETTINGS_AGENT_PROMPT_SECTION,
} from "@zcode/shared/test-ids";
import {
  CheckIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 系统提示词配置档管理分区（规格：docs/specs/agent-system-prompt-chinese-and-profiles.md）。
 * 内置默认只读；自建档增删改；选中即切换 active（热更新由 useSettingService 的同步分支负责）。
 * 组件不直接持有服务：设置值与更新回调由 SettingsPage 固定经本机 Host 服务注入，
 * 避免远端 workspace 上下文把共享设置写进远端。
 */

interface AgentPromptSectionProps {
  profiles: readonly AgentPromptProfile[];
  activeProfileId: string | undefined;
  onUpdateProfiles: (profiles: AgentPromptProfile[]) => Promise<void>;
  onUpdateActiveProfileId: (profileId: string) => Promise<void>;
  /**
   * AI 生成/修改用的执行上下文：本机当前打开的工作区。undefined（未打开任何工作区）
   * 时 AI 按钮禁用——workspace/generateText 需要一个 workspace ref 来启动 CLI 进程。
   */
  aiWorkspacePath?: string;
  /**
   * 由 SettingsPage 注入：解析本机默认模型（modelSelectionService.getView()
   * .preferredSelection）后转调 zcodeAgentService.generateAgentPromptDraft。
   * 结果只回填草稿，不落盘。
   */
  onGenerateDraft: (input: {
    instruction: string;
    mode: "generate" | "revise";
    baseContent?: string;
  }) => Promise<string>;
}

interface EditorDraft {
  id: string | null; // null = 新建
  name: string;
  content: string;
}

type AgentPromptAiMode = "generate" | "revise";

/**
 * AI 生成协议层 deadline 为 150s（services 侧 AGENT_PROMPT_DRAFT_REQUEST_TIMEOUT_MS），
 * 遥测默认 30s 会把长请求提前记为 abandoned；显式给出覆盖值 + 取消缓冲。
 */
const AGENT_PROMPT_AI_TELEMETRY_TIMEOUT_MS = 150_000 + 10_000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 服务层/注入回调抛出的稳定错误码按码映射 i18n 文案，未知错误（如 RPC 原始异常）原样透出。
 */
function agentPromptDraftErrorText(intl: IntlInstance, message: string): string {
  if (message === AGENT_PROMPT_DRAFT_WORKSPACE_REQUIRED_CODE) {
    return intl.formatMessage({ id: "settings.agentPrompt.ai.workspaceRequired" });
  }
  if (message === AGENT_PROMPT_DRAFT_EMPTY_OUTPUT_CODE) {
    return intl.formatMessage({ id: "settings.agentPrompt.ai.emptyOutput" });
  }
  if (message === "agent-prompt-draft.model-missing") {
    return intl.formatMessage({ id: "settings.agentPrompt.ai.modelMissing" });
  }
  return message;
}

export function AgentPromptSection({
  profiles,
  activeProfileId,
  onUpdateProfiles,
  onUpdateActiveProfileId,
  aiWorkspacePath,
  onGenerateDraft,
}: AgentPromptSectionProps) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiPending, setAiPending] = useState(false);
  const [undoContent, setUndoContent] = useState<string | null>(null);
  // 异步回调里读发起时的草稿实时状态（StrictMode 下 state updater 必须保持纯函数，
  // 不能借用 updater 副作用做判断）。
  const draftRef = useRef<EditorDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const isBuiltinActive = !activeProfileId || activeProfileId === AGENT_PROMPT_BUILTIN_PROFILE_ID;
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId),
    [profiles, activeProfileId],
  );

  // 草稿与撤销点是同一份状态：新建/编辑/关闭都必须经由这里，
  // 避免 undoContent 跨草稿泄漏（取消 A 档后打开 B 档撤销点写进 B 档正文）。
  const resetDraft = (next: EditorDraft | null) => {
    draftRef.current = next;
    setDraft(next);
    setUndoContent(null);
  };

  const startCreate = () => {
    setConfirmingDeleteId(null);
    resetDraft({ id: null, name: "", content: "" });
  };

  const startEdit = (profile: AgentPromptProfile) => {
    setConfirmingDeleteId(null);
    resetDraft({ id: profile.id, name: profile.name, content: profile.content });
  };

  const loadBuiltinIntoDraft = () => {
    setDraft((current) =>
      current ? { ...current, content: composeDefaultAgentPromptBody() } : current,
    );
    setUndoContent(null);
  };

  // AI 生成/修改：结果只回填草稿（覆盖前值保留为一键撤销），是否保存仍由用户决定。
  // pending 期间正文 Textarea 已禁用，完成时再校验草稿未被切换，防止撤销点写入另一份档。
  const runAiDraft = async (mode: AgentPromptAiMode) => {
    const instruction = aiInstruction.trim();
    if (!instruction) {
      setError(intl.formatMessage({ id: "settings.agentPrompt.ai.instructionRequired" }));
      return;
    }
    if (!draft || !aiWorkspacePath) return;
    setAiPending(true);
    setError(null);
    const previousContent = draft.content;
    const draftId = draft.id;
    try {
      await runUserActionAsync({
        input: {
          featureId: "settings.agentPrompt",
          action: mode === "generate" ? "ai_generate" : "ai_revise",
          trigger: "button",
          timeoutMs: AGENT_PROMPT_AI_TELEMETRY_TIMEOUT_MS,
        },
        failureStage: "operation",
        operation: async () => {
          const text = await onGenerateDraft({
            instruction,
            mode,
            ...(mode === "revise" ? { baseContent: previousContent } : {}),
          });
          const isStale = () => {
            const current = draftRef.current;
            return !current || current.id !== draftId;
          };
          if (isStale()) return;
          setDraft((current) => (current ? { ...current, content: text } : current));
          // 撤销点只属于发起时的草稿：pending 期间草稿被取消/切换（resetDraft 已清空 undoContent）
          // 时不写入，避免跨档泄漏。
          setUndoContent(previousContent);
        },
      });
    } catch (cause) {
      setError(agentPromptDraftErrorText(intl, getErrorMessage(cause)));
    } finally {
      setAiPending(false);
    }
  };

  const undoAiDraft = () => {
    if (undoContent === null) return;
    setDraft((current) => (current ? { ...current, content: undoContent } : current));
    setUndoContent(null);
  };

  const saveDraft = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const content = draft.content;
    if (!name) {
      setError(intl.formatMessage({ id: "settings.agentPrompt.error.nameRequired" }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await runUserActionAsync({
        input: { featureId: "settings.agentPrompt", action: "save_profile", trigger: "button" },
        failureStage: "operation",
        operation: async () => {
          const now = new Date().toISOString();
          if (draft.id) {
            const next = profiles.map((profile) =>
              profile.id === draft.id ? { ...profile, name, content, updatedAt: now } : profile,
            );
            await onUpdateProfiles(next);
          } else {
            const created: AgentPromptProfile = {
              id: `prompt_${crypto.randomUUID()}`,
              name,
              content,
              createdAt: now,
              updatedAt: now,
            };
            await onUpdateProfiles([...profiles, created]);
            await onUpdateActiveProfileId(created.id);
          }
        },
      });
      resetDraft(null);
    } catch (cause) {
      setError(agentPromptDraftErrorText(intl, getErrorMessage(cause)));
    } finally {
      setSaving(false);
    }
  };

  const deleteProfile = async (profileId: string) => {
    setSaving(true);
    setError(null);
    try {
      await runUserActionAsync({
        input: { featureId: "settings.agentPrompt", action: "delete_profile", trigger: "button" },
        failureStage: "operation",
        operation: async () => {
          await onUpdateProfiles(profiles.filter((profile) => profile.id !== profileId));
          // 删除 active 档时回落内置：active id 悬空后 resolveAgentPromptOverride 返回
          // undefined，新会话与热同步都按内置处理，无需在此改写 activeProfileId。
        },
      });
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setSaving(false);
      setConfirmingDeleteId(null);
    }
  };

  const activateProfile = async (profileId: string) => {
    setSaving(true);
    setError(null);
    try {
      await runUserActionAsync({
        input: { featureId: "settings.agentPrompt", action: "activate_profile", trigger: "button" },
        failureStage: "operation",
        operation: async () => {
          await onUpdateActiveProfileId(profileId);
        },
      });
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid={TID_SETTINGS_AGENT_PROMPT_SECTION}>
      <p className="text-sm text-muted-foreground">
        {intl.formatMessage({ id: "settings.agentPrompt.description" })}
      </p>

      <SettingsGroupCard>
        <div data-testid={TID_SETTINGS_AGENT_PROMPT_PROFILE_ITEM} data-profile-id="default">
          <SettingsRow
            label={intl.formatMessage({ id: "settings.agentPrompt.builtin.name" })}
            description={intl.formatMessage({ id: "settings.agentPrompt.builtin.description" })}
            control={
              isBuiltinActive ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  <CheckIcon className="size-4" />
                  {intl.formatMessage({ id: "settings.agentPrompt.activeBadge" })}
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || draft !== null}
                  onClick={() => void activateProfile(AGENT_PROMPT_BUILTIN_PROFILE_ID)}
                  data-testid={TID_SETTINGS_AGENT_PROMPT_ACTIVATE}
                  data-profile-id={AGENT_PROMPT_BUILTIN_PROFILE_ID}
                >
                  {intl.formatMessage({ id: "settings.agentPrompt.activate" })}
                </Button>
              )
            }
          />
        </div>
        {profiles.map((profile) => {
          const isActive = profile.id === activeProfileId;
          return (
            <div
              key={profile.id}
              data-testid={TID_SETTINGS_AGENT_PROMPT_PROFILE_ITEM}
              data-profile-id={profile.id}
            >
              <SettingsRow
                label={profile.name}
                description={intl.formatMessage(
                  { id: "settings.agentPrompt.profile.summary" },
                  { chars: profile.content.length },
                )}
                control={
                  <div className="flex items-center gap-1">
                    {isActive ? (
                      <span className="flex items-center gap-1 text-sm text-muted-foreground">
                        <CheckIcon className="size-4" />
                        {intl.formatMessage({ id: "settings.agentPrompt.activeBadge" })}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={saving || draft !== null}
                        onClick={() => void activateProfile(profile.id)}
                        data-testid={TID_SETTINGS_AGENT_PROMPT_ACTIVATE}
                        data-profile-id={profile.id}
                      >
                        {intl.formatMessage({ id: "settings.agentPrompt.activate" })}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={saving}
                      onClick={() => startEdit(profile)}
                      aria-label={intl.formatMessage({ id: "settings.agentPrompt.action.edit" })}
                    >
                      <PencilIcon className="size-4" />
                    </Button>
                    {confirmingDeleteId === profile.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={saving}
                        onClick={() => void deleteProfile(profile.id)}
                      >
                        {intl.formatMessage({ id: "settings.agentPrompt.action.confirmDelete" })}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={saving}
                        onClick={() => setConfirmingDeleteId(profile.id)}
                        aria-label={intl.formatMessage({
                          id: "settings.agentPrompt.action.delete",
                        })}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    )}
                  </div>
                }
              />
            </div>
          );
        })}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.agentPrompt.create.title" })}
          description={intl.formatMessage(
            { id: "settings.agentPrompt.create.description" },
            { count: profiles.length, max: AGENT_PROMPT_PROFILES_MAX },
          )}
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={saving || draft !== null || profiles.length >= AGENT_PROMPT_PROFILES_MAX}
              onClick={startCreate}
            >
              <PlusIcon className="size-4" />
              {intl.formatMessage({ id: "settings.agentPrompt.action.create" })}
            </Button>
          }
        />
      </SettingsGroupCard>

      {draft ? (
        <SettingsGroupCard>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <SparklesIcon className="size-4" />
                {intl.formatMessage({ id: "settings.agentPrompt.ai.title" })}
              </div>
              <Input
                value={aiInstruction}
                placeholder={intl.formatMessage({
                  id: "settings.agentPrompt.ai.instructionPlaceholder",
                })}
                disabled={aiPending}
                onChange={(event) => setAiInstruction(event.target.value)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiPending || !aiWorkspacePath}
                  title={
                    aiWorkspacePath
                      ? undefined
                      : intl.formatMessage({ id: "settings.agentPrompt.ai.workspaceRequired" })
                  }
                  onClick={() => void runAiDraft("generate")}
                >
                  {intl.formatMessage({ id: "settings.agentPrompt.ai.generate" })}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiPending || !aiWorkspacePath || draft.content.trim().length === 0}
                  title={
                    aiWorkspacePath
                      ? undefined
                      : intl.formatMessage({ id: "settings.agentPrompt.ai.workspaceRequired" })
                  }
                  onClick={() => void runAiDraft("revise")}
                >
                  {intl.formatMessage({ id: "settings.agentPrompt.ai.revise" })}
                </Button>
                {aiPending ? (
                  <span className="text-sm text-muted-foreground">
                    {intl.formatMessage({ id: "settings.agentPrompt.ai.pending" })}
                  </span>
                ) : null}
                {undoContent !== null && !aiPending ? (
                  <Button variant="ghost" size="sm" onClick={undoAiDraft}>
                    <Undo2Icon className="size-4" />
                    {intl.formatMessage({ id: "settings.agentPrompt.ai.undo" })}
                  </Button>
                ) : null}
              </div>
              {!aiWorkspacePath ? (
                <p className="text-xs text-muted-foreground">
                  {intl.formatMessage({ id: "settings.agentPrompt.ai.workspaceRequired" })}
                </p>
              ) : null}
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {intl.formatMessage({ id: "settings.agentPrompt.field.name" })}
              </span>
              <Input
                value={draft.name}
                maxLength={100}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, name: event.target.value } : current,
                  )
                }
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                {intl.formatMessage({ id: "settings.agentPrompt.field.content" })}
              </span>
              <Textarea
                value={draft.content}
                rows={16}
                className="font-mono text-xs"
                // AI pending 期间锁正文：防止用户编辑被异步回填的 AI 结果静默覆盖，
                // 也防止过期的 previousContent 被写进撤销点（spec §6 结果语义）。
                disabled={aiPending}
                onChange={(event) => {
                  setUndoContent(null);
                  setDraft((current) =>
                    current ? { ...current, content: event.target.value } : current,
                  );
                }}
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={saving} onClick={() => void saveDraft()}>
                {intl.formatMessage({ id: "settings.agentPrompt.action.save" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={saving || aiPending}
                onClick={() => resetDraft(null)}
              >
                {intl.formatMessage({ id: "settings.agentPrompt.action.cancel" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={loadBuiltinIntoDraft}
                title={intl.formatMessage({ id: "settings.agentPrompt.loadBuiltin.hint" })}
              >
                <RotateCcwIcon className="size-4" />
                {intl.formatMessage({ id: "settings.agentPrompt.action.loadBuiltin" })}
              </Button>
            </div>
          </div>
        </SettingsGroupCard>
      ) : null}
      {error && !draft ? <p className="text-sm text-destructive">{error}</p> : null}
      {activeProfile && !isBuiltinActive ? (
        <p className="text-xs text-muted-foreground">
          {intl.formatMessage({ id: "settings.agentPrompt.activeHint" })}
        </p>
      ) : null}
    </div>
  );
}
