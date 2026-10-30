// composer 定时发送浮层：发送键右侧下拉「设为定时」→ 时间选择（可配置预设 + 自定义）。
//
// 一次定时发送 = 一条一次性 automation（recurring=false + relativeDelayMinutes），
// 复用已有 scheduler→CronRun→targetTaskId 链路注入原会话，不新增第二套调度状态。
// 预设偏好归 scheduledSendPresetStore（localStorage）；本组件只做选择、换算与提交。
import { useCallback, useMemo, useState } from "react";
import { AUTOMATION_CREATE_LIMIT, isAutomationCreateLimitError } from "@zcode/shared";
import {
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useAutomationManagementStore } from "@/store/automationManagementStore.js";
import { useScheduledSendPresetStore } from "@/store/scheduledSendPresetStore.js";
import type { ComposerScheduledSendProps, ScheduledSendPreset } from "./contract.js";
import type { ScheduledSendPresetInput } from "@/store/scheduledSendPresetStore.js";
import {
  describeRelativeDay,
  describeRemaining,
  isValidScheduledSendPreset,
  MAX_SCHEDULED_SEND_PRESETS,
  resolvePresetTarget,
  resolveSelectionTarget,
} from "./scheduledSendTime.js";
import { buildScheduledSendAutomationParams } from "./scheduledSendSubmit.js";
import {
  TID_V4_COMPOSER_SCHEDULE_CONFIRM,
  TID_V4_COMPOSER_SCHEDULE_MENU_ITEM,
  TID_V4_COMPOSER_SCHEDULE_PRESET,
  TID_V4_COMPOSER_SCHEDULE_TRIGGER,
} from "@zcode/shared/test-ids";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 目标时刻相对 now 的友好标签：今天/明天/后天 + HH:mm。 */
function useTargetFormatters(locale: string) {
  return useMemo(() => {
    const timeFmt = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const dateTimeFmt = new Intl.DateTimeFormat(locale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const relativeFmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    return { timeFmt, dateTimeFmt, relativeFmt };
  }, [locale]);
}

export function ComposerScheduledSend({
  draftText,
  hasNonTextContext,
  enabled,
  disabledReason,
  agentService,
  workspacePath,
  workspaceIdentity,
  sessionId,
  modelSelection,
  mode,
  onScheduled,
}: ComposerScheduledSendProps) {
  const { intl, locale } = useZCodeIntl();
  const formatters = useTargetFormatters(locale);
  const presets = useScheduledSendPresetStore((state) => state.presets);
  const addPreset = useScheduledSendPresetStore((state) => state.addPreset);
  const removePreset = useScheduledSendPresetStore((state) => state.removePreset);
  const resetDefaults = useScheduledSendPresetStore((state) => state.resetDefaults);

  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [customDate, setCustomDate] = useState(() => toDateInputValue(new Date()));
  const [customTime, setCustomTime] = useState("");
  const [errorKind, setErrorKind] = useState<"invalid" | "tooFar" | null>(null);
  // 新增预设表单
  const [newKind, setNewKind] = useState<"offset" | "dailyTime">("offset");
  const [newOffset, setNewOffset] = useState("60");
  const [newDaily, setNewDaily] = useState("12:00");

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setManaging(false);
    setErrorKind(null);
  }, []);

  const presetLabel = useCallback(
    (preset: ScheduledSendPreset): string =>
      preset.kind === "offset"
        ? intl.formatMessage(
            { id: "chat.composer.schedule.presetKindOffset" },
            { count: preset.offsetMinutes },
          )
        : intl.formatMessage(
            { id: "chat.composer.schedule.presetKindDaily" },
            { time: preset.time },
          ),
    [intl],
  );

  const relativeDayLabel = useCallback(
    (targetMs: number): string => {
      const day = describeRelativeDay(targetMs);
      const time = formatters.timeFmt.format(new Date(targetMs));
      if (day === "today") return intl.formatMessage({ id: "chat.composer.schedule.today" }, { time });
      if (day === "tomorrow")
        return intl.formatMessage({ id: "chat.composer.schedule.tomorrow" }, { time });
      if (day === "dayAfterTomorrow")
        return intl.formatMessage(
          { id: "chat.composer.schedule.dayAfterTomorrow" },
          { time },
        );
      return formatters.dateTimeFmt.format(new Date(targetMs));
    },
    [formatters, intl],
  );

  // 计算当前选择的目标时刻（预设优先，否则自定义）。展示用；确认时经 resolveSelectionTarget 重算。
  const currentTargetMs = useMemo(
    () => resolveSelectionTarget({ selectedPresetId, presets, customDate, customTime }),
    [selectedPresetId, presets, customDate, customTime],
  );

  const trimmedText = draftText.trim();
  const canSubmitDraft = trimmedText.length > 0 && !hasNonTextContext;

  // 预览里的“约 X 后”：按距离选分钟/小时/天，避免长跨度显示成上千分钟。
  const remainingLabel = useMemo(() => {
    if (!currentTargetMs) return null;
    const remaining = describeRemaining(currentTargetMs - Date.now());
    return formatters.relativeFmt.format(remaining.value, remaining.unit);
  }, [currentTargetMs, formatters]);

  const handleConfirm = useCallback(async () => {
    if (submitting) return;
    // 确认时按当前时刻重算目标时刻，不复用渲染期缓存：浮层停留可能跨过预设/自定义
    // 时刻，过期目标必须走 invalidTime 提示，而不是提交一条过去时刻的 automation。
    const targetMs = resolveSelectionTarget({
      selectedPresetId,
      presets,
      customDate,
      customTime,
    });
    if (!targetMs) return;
    const outcome = buildScheduledSendAutomationParams({
      prompt: draftText,
      targetMs,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      sessionId,
      ...(modelSelection ? { modelSelection } : {}),
      ...(mode ? { mode } : {}),
    });
    if (!outcome.ok) {
      if (outcome.reason === "emptyPrompt") return;
      setErrorKind(outcome.reason === "tooFar" ? "tooFar" : "invalid");
      return;
    }
    setErrorKind(null);
    setSubmitting(true);
    try {
      await agentService.createAutomation(outcome.params);
      toast(
        intl.formatMessage(
          { id: "chat.composer.schedule.successToast" },
          { time: formatters.dateTimeFmt.format(new Date(targetMs)) },
        ),
      );
      // best-effort：管理页已初始化同一 workspace 时立即反映新任务；未初始化时 refresh 自动 no-op。
      void useAutomationManagementStore.getState().refresh(agentService);
      onScheduled();
      closePicker();
      setSelectedPresetId(null);
      setCustomTime("");
    } catch (error) {
      if (isAutomationCreateLimitError(error)) {
        toast(
          intl.formatMessage(
            { id: "automations.error.createLimit" },
            { limit: String(AUTOMATION_CREATE_LIMIT) },
          ),
        );
      } else {
        toast(intl.formatMessage({ id: "chat.composer.schedule.failedToast" }));
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    agentService,
    closePicker,
    customDate,
    customTime,
    draftText,
    formatters,
    intl,
    modelSelection,
    mode,
    onScheduled,
    presets,
    selectedPresetId,
    sessionId,
    submitting,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleAddPreset = useCallback(() => {
    // 先校验输入再入 store：addPreset 返回 false 兼具「非法」与「达上限」两种含义，
    // 混用会把清空输入框（parseInt 得 NaN）之类的非法输入误报成「预设最多 N 条」。
    const input: ScheduledSendPresetInput =
      newKind === "offset"
        ? { kind: "offset", offsetMinutes: Number.parseInt(newOffset, 10) }
        : { kind: "dailyTime", time: newDaily };
    if (!isValidScheduledSendPreset({ ...input, id: "" })) {
      toast(intl.formatMessage({ id: "chat.composer.schedule.presetInvalid" }));
      return;
    }
    if (!addPreset(input)) {
      toast(
        intl.formatMessage(
          { id: "chat.composer.schedule.presetLimitReached" },
          { limit: String(MAX_SCHEDULED_SEND_PRESETS) },
        ),
      );
    }
  }, [addPreset, intl, newDaily, newKind, newOffset]);

  const triggerButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={intl.formatMessage({ id: "chat.composer.schedule.menuItem" })}
      data-testid={TID_V4_COMPOSER_SCHEDULE_TRIGGER}
      className="rounded-lg text-foreground-subtle hover:text-foreground"
    >
      <ChevronDownIcon className="size-3.5" />
    </Button>
  );

  return (
    <Popover
      open={pickerOpen}
      onOpenChange={(next) => {
        setPickerOpen(next);
        if (!next) setManaging(false);
      }}
    >
      <PopoverAnchor asChild>
        <span className="inline-flex">
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              {hasNonTextContext || !enabled ? (
                <ControlHintTooltip
                  title={
                    hasNonTextContext
                      ? intl.formatMessage({ id: "chat.composer.schedule.attachmentUnsupported" })
                      : (disabledReason ?? "")
                  }
                >
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled
                      aria-label={intl.formatMessage({ id: "chat.composer.schedule.menuItem" })}
                      data-testid={TID_V4_COMPOSER_SCHEDULE_TRIGGER}
                      className="rounded-lg text-foreground-subtle"
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </Button>
                  </span>
                </ControlHintTooltip>
              ) : (
                triggerButton
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-44">
              <DropdownMenuItem
                data-testid={TID_V4_COMPOSER_SCHEDULE_MENU_ITEM}
                onSelect={() => {
                  setPickerOpen(true);
                  setErrorKind(null);
                }}
              >
                <ClockIcon className="size-3.5" />
                {intl.formatMessage({ id: "chat.composer.schedule.menuItem" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </PopoverAnchor>
      <PopoverContent align="end" side="top" sideOffset={8} className="w-80 gap-3">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.composer.schedule.title" })}
        </div>

        {/* 预设列表 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.composer.schedule.presetsSection" })}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset) => {
              const target = resolvePresetTarget(preset);
              const selected = selectedPresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={TID_V4_COMPOSER_SCHEDULE_PRESET}
                  onClick={() => {
                    setSelectedPresetId(preset.id);
                    setCustomTime("");
                    setErrorKind(null);
                  }}
                  className={cn(
                    "flex flex-col items-start rounded-lg border px-2.5 py-1.5 text-left transition-colors",
                    selected
                      ? "border-brand bg-brand/10 text-foreground"
                      : "border-input-border bg-input text-foreground hover:border-input-border-hover",
                  )}
                >
                  <span className="text-ui-sm font-medium">{presetLabel(preset)}</span>
                  <span className="text-ui-xs text-foreground-subtle">
                    {relativeDayLabel(target)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 自定义时间 */}
        <div className="flex flex-col gap-1.5">
          <div className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.composer.schedule.customSection" })}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              aria-label={intl.formatMessage({ id: "chat.composer.schedule.dateLabel" })}
              value={customDate}
              onChange={(event) => {
                setCustomDate(event.target.value);
                setSelectedPresetId(null);
                setErrorKind(null);
              }}
              className="h-8 flex-1"
            />
            <Input
              type="time"
              aria-label={intl.formatMessage({ id: "chat.composer.schedule.timeLabel" })}
              value={customTime}
              onChange={(event) => {
                setCustomTime(event.target.value);
                setSelectedPresetId(null);
                setErrorKind(null);
              }}
              className="h-8 w-[7.5rem]"
            />
          </div>
        </div>

        {/* 预览 + 错误 */}
        {currentTargetMs ? (
          <div className="text-ui-sm text-foreground-subtle">
            {relativeDayLabel(currentTargetMs)}
            {errorKind === null && remainingLabel ? (
              <span className="ml-1 text-foreground-subtlest">
                ·{" "}
                {intl.formatMessage(
                  { id: "chat.composer.schedule.aboutIn" },
                  { duration: remainingLabel },
                )}
              </span>
            ) : null}
          </div>
        ) : null}
        {errorKind ? (
          <div className="text-ui-sm text-destructive">
            {intl.formatMessage({
              id:
                errorKind === "tooFar"
                  ? "chat.composer.schedule.tooFar"
                  : "chat.composer.schedule.invalidTime",
            })}
          </div>
        ) : null}

        {/* 管理预设 */}
        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setManaging((prev) => !prev)}
              className="text-ui-sm text-foreground-subtle hover:text-foreground"
            >
              {intl.formatMessage({ id: "chat.composer.schedule.managePresets" })}
            </button>
            {managing ? (
              <button
                type="button"
                onClick={resetDefaults}
                className="inline-flex items-center gap-1 text-ui-sm text-foreground-subtle hover:text-foreground"
              >
                <RotateCcwIcon className="size-3" />
                {intl.formatMessage({ id: "chat.composer.schedule.resetDefaults" })}
              </button>
            ) : null}
          </div>
          {managing ? (
            <div className="flex flex-col gap-2">
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {presets.map((preset) => (
                  <div key={preset.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-ui-sm text-foreground">
                      {presetLabel(preset)}
                    </span>
                    <button
                      type="button"
                      aria-label={intl.formatMessage({ id: "chat.composer.schedule.removePreset" })}
                      onClick={() => removePreset(preset.id)}
                      className="shrink-0 text-foreground-subtle hover:text-destructive"
                    >
                      <Trash2Icon className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={newKind}
                  onChange={(event) => setNewKind(event.target.value as "offset" | "dailyTime")}
                  className="h-8 rounded-md border border-input-border bg-input px-2 text-ui-sm text-foreground"
                >
                  <option value="offset">
                    {intl.formatMessage({ id: "chat.composer.schedule.presetKindOffset" }, { count: "N" })}
                  </option>
                  <option value="dailyTime">
                    {intl.formatMessage(
                      { id: "chat.composer.schedule.presetKindDaily" },
                      { time: "HH:mm" },
                    )}
                  </option>
                </select>
                {newKind === "offset" ? (
                  <Input
                    type="number"
                    min={1}
                    value={newOffset}
                    onChange={(event) => setNewOffset(event.target.value)}
                    className="h-8 w-20"
                  />
                ) : (
                  <Input
                    type="time"
                    value={newDaily}
                    onChange={(event) => setNewDaily(event.target.value)}
                    className="h-8 w-28"
                  />
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={handleAddPreset}
                  disabled={presets.length >= MAX_SCHEDULED_SEND_PRESETS}
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {/* 确认 */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-2">
          {!canSubmitDraft ? (
            <span className="mr-auto text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.composer.schedule.attachmentUnsupported" })}
            </span>
          ) : null}
          <Button
            type="button"
            size="sm"
            data-testid={TID_V4_COMPOSER_SCHEDULE_CONFIRM}
            disabled={!currentTargetMs || !canSubmitDraft || submitting || errorKind !== null}
            onClick={() => void handleConfirm()}
            className="gap-1 rounded-lg bg-brand text-foreground-inverse hover:bg-brand/80"
          >
            <CheckIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.composer.schedule.confirm" })}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
