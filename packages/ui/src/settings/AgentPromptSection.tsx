import { useMemo, useState } from "react";
import {
  AGENT_PROMPT_BUILTIN_PROFILE_ID,
  AGENT_PROMPT_PROFILES_MAX,
  composeDefaultAgentPromptBody,
  type AgentPromptProfile,
} from "@zcode/shared";
import {
  TID_SETTINGS_AGENT_PROMPT_ACTIVATE,
  TID_SETTINGS_AGENT_PROMPT_PROFILE_ITEM,
  TID_SETTINGS_AGENT_PROMPT_SECTION,
} from "@zcode/shared/test-ids";
import { CheckIcon, PencilIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
}

interface EditorDraft {
  id: string | null; // null = 新建
  name: string;
  content: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AgentPromptSection({
  profiles,
  activeProfileId,
  onUpdateProfiles,
  onUpdateActiveProfileId,
}: AgentPromptSectionProps) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const isBuiltinActive = !activeProfileId || activeProfileId === AGENT_PROMPT_BUILTIN_PROFILE_ID;
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId),
    [profiles, activeProfileId],
  );

  const startCreate = () => {
    setConfirmingDeleteId(null);
    setDraft({ id: null, name: "", content: "" });
  };

  const startEdit = (profile: AgentPromptProfile) => {
    setConfirmingDeleteId(null);
    setDraft({ id: profile.id, name: profile.name, content: profile.content });
  };

  const loadBuiltinIntoDraft = () => {
    setDraft((current) =>
      current ? { ...current, content: composeDefaultAgentPromptBody() } : current,
    );
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
      setDraft(null);
    } catch (cause) {
      setError(getErrorMessage(cause));
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
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, content: event.target.value } : current,
                  )
                }
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={saving} onClick={() => void saveDraft()}>
                {intl.formatMessage({ id: "settings.agentPrompt.action.save" })}
              </Button>
              <Button variant="outline" size="sm" disabled={saving} onClick={() => setDraft(null)}>
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
