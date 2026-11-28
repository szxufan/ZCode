import { watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  ModelConfigRules,
  ProviderTemplateMap,
  type ProviderConfigLayerSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import {
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
  serializeZCodeBuiltinRelease,
  type ZCodeBuiltinRelease,
} from "./zcode-builtin-release.js";

export interface NodeZCodeBuiltinProviderConfigSourceOptions {
  readonly bundledFilePath: string;
  readonly activeFilePath?: string;
  readonly watch?: boolean;
}

export type ApplyZCodeBuiltinReleaseResult = "updated" | "unchanged" | "stale";

/** Bundled、Active/LKG 与 Remote 共用同一 Release，并最终发布为现有 Config Snapshot。 */
export class NodeZCodeBuiltinProviderConfigSource implements ProviderSource<ProviderConfigLayerSnapshot> {
  readonly #bundledFilePath: string;
  readonly #activeFilePath: string;
  readonly #sourceKey: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedSignature: string | null = null;
  #watchRefresh = Promise.resolve();
  #disposed = false;

  constructor(options: NodeZCodeBuiltinProviderConfigSourceOptions) {
    const bundledFilePath = options.bundledFilePath.trim();
    if (!bundledFilePath) throw new Error("ZCode Built-in bundledFilePath 不能为空");
    this.#bundledFilePath = bundledFilePath;
    this.#activeFilePath = options.activeFilePath?.trim() || bundledFilePath;
    // 旧标识只有发布序号，不同 Endpoint 同序号会让 Registry 误复用上一来源。
    // Active 路径已含规范化 Endpoint 隔离范围；Worker 收到同一路径，不另拼账号事实。
    this.#sourceKey = createHash("sha256").update(resolve(this.#activeFilePath)).digest("hex");
    this.#watchEnabled = options.watch !== false;
  }

  get activeFilePath(): string {
    return this.#activeFilePath;
  }

  async read(): Promise<ProviderConfigLayerSnapshot> {
    this.#assertNotDisposed();
    let release: ZCodeBuiltinRelease;
    try {
      await this.#ensureWatcher();
      release = await withFileLock(this.#activeFilePath, () => this.#readAndMaterializeLocked());
    } catch {
      // Active 只是可丢弃缓存，目录锁、监听或原子物化失败不能阻断
      // Bundled 基线。缓存边界不可用时绕过 Active；Bundled 自身无效仍会在这里抛错。
      const bundled = await readBundledReleaseCandidate(this.#bundledFilePath);
      release = overlayForkTemplates(selectReleaseCandidate(bundled, null), bundled.release);
    }
    this.#observedSignature ??= signatureOf(release);
    return snapshotFromRelease(release, this.#sourceKey);
  }

  async applyRemoteRelease(release: ZCodeBuiltinRelease): Promise<ApplyZCodeBuiltinReleaseResult> {
    this.#assertNotDisposed();
    await this.#ensureWatcher();
    const result = await withFileLock(this.#activeFilePath, async () => {
      this.#assertNotDisposed();
      const current = await this.#readAndMaterializeLocked();
      this.#assertNotDisposed();
      // 远端 Release 不能删除 fork 自有模板；比较与写入都用叠加后的完整内容。
      const bundled = await readBundledReleaseCandidate(this.#bundledFilePath);
      const effective = overlayForkTemplates(release, bundled.release);
      if (effective.revision < current.revision) return "stale" as const;
      if (effective.revision === current.revision) {
        if (serializeZCodeBuiltinRelease(effective) === serializeZCodeBuiltinRelease(current)) {
          return "unchanged" as const;
        }
        throw new Error(`ZCode Built-in 相同 revision ${effective.revision} 对应不同内容`);
      }
      await this.#writeActiveLocked(effective);
      this.#observedSignature = signatureOf(effective);
      return "updated" as const;
    });
    if (result === "updated" && !this.#disposed) this.#emit("remote-updated");
    return result;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  async #readAndMaterializeLocked(): Promise<ZCodeBuiltinRelease> {
    const [bundled, active] = await Promise.all([
      readBundledReleaseCandidate(this.#bundledFilePath),
      this.#activeFilePath === this.#bundledFilePath
        ? Promise.resolve(null)
        : readReleaseCandidate(this.#activeFilePath),
    ]);
    const selected = overlayForkTemplates(selectReleaseCandidate(bundled, active), bundled.release);
    if (this.#activeFilePath !== this.#bundledFilePath) {
      const activeSignature = active?.release ? signatureOf(active.release) : null;
      if (activeSignature !== signatureOf(selected)) await this.#writeActiveLocked(selected);
    }
    return selected;
  }

  async #writeActiveLocked(release: ZCodeBuiltinRelease): Promise<void> {
    this.#assertNotDisposed();
    await atomicWritePrivateTextFile(
      this.#activeFilePath,
      JSON.stringify(encodeZCodeBuiltinRelease(release), null, 2),
    );
  }

  async #ensureWatcher(): Promise<void> {
    await mkdir(dirname(this.#activeFilePath), { recursive: true });
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    const target = basename(this.#activeFilePath);
    this.#watcher = watch(dirname(this.#activeFilePath), (_eventType, fileName) => {
      if (fileName === null || fileName.toString() === target) this.#scheduleWatchRefresh();
    });
    this.#watcher.on("error", () => this.#emit("watch-error"));
  }

  #scheduleWatchRefresh(): void {
    this.#watchRefresh = this.#watchRefresh.then(async () => {
      if (this.#disposed) return;
      try {
        const release = await withFileLock(this.#activeFilePath, () =>
          this.#readAndMaterializeLocked(),
        );
        const signature = signatureOf(release);
        if (this.#disposed || signature === this.#observedSignature) return;
        this.#observedSignature = signature;
        this.#emit("file-changed");
      } catch {
        this.#emit("watch-error");
      }
    });
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeZCodeBuiltinProviderConfigSource 已 dispose");
  }
}

export function createNodeZCodeBuiltinProviderConfigSource(
  options: NodeZCodeBuiltinProviderConfigSourceOptions,
): NodeZCodeBuiltinProviderConfigSource {
  return new NodeZCodeBuiltinProviderConfigSource(options);
}

interface ReleaseCandidate {
  readonly release?: ZCodeBuiltinRelease;
  readonly error?: unknown;
}

/**
 * Bug 原因：远端 Core 只在启动时把构建内嵌的 Bundled 物化到 `runtime/provider/bundled`，
 * 运行中该目录与 Endpoint Active 一起被删除后，每次读取都拿到两个 ENOENT，Provisioning
 * 同步持续失败到 Core 重启。Bundled 在进程生命周期内不可变（升级以退出旧进程为前提），
 * 因此按路径记住本进程最近一次成功解析的 Bundled，仅在文件缺失时作为基线；随后照常由
 * 选中的候选重建 Active。不回写 Bundled 路径：Desktop 的 Bundled 位于只读安装资源内。
 * 用模块级缓存而非实例字段，是因为 Endpoint 切换会新建 Source 实例，也要能读到同一基线。
 * Worker 把 Host 的 Active 当作 Bundled 读取时，这里等价于最近一次成功读取的 LKG。
 */
const lastValidBundledReleaseByPath = new Map<string, ZCodeBuiltinRelease>();

async function readBundledReleaseCandidate(filePath: string): Promise<ReleaseCandidate> {
  const key = resolve(filePath);
  const candidate = await readReleaseCandidate(filePath);
  if (candidate.release) {
    lastValidBundledReleaseByPath.set(key, candidate.release);
    return candidate;
  }
  const baseline = isFileNotFound(candidate.error)
    ? lastValidBundledReleaseByPath.get(key)
    : undefined;
  return baseline ? { release: baseline } : candidate;
}

async function readReleaseCandidate(filePath: string): Promise<ReleaseCandidate> {
  try {
    return { release: decodeZCodeBuiltinRelease(JSON.parse(await readFile(filePath, "utf8"))) };
  } catch (error) {
    // Bug 原因：ENOENT 曾直接返回 null，两份文件都缺失时 AggregateError 的错误列表为空，
    // 日志只剩“均不可用”而没有路径。缺失同样是无效候选，保留原始错误供汇总报告。
    return { error };
  }
}

/**
 * fork 自有模板不是远端产品事实，但不能被更高 revision 的远端 Release 删除。
 * 从随包 Bundled 读取 forkTemplateIds 指定的模板和其 template-model 规则，叠加到任何
 * 已选中 Release；快照 revision 保持被选中 Release 的 revision，不制造新的发布单元。
 */
export function overlayForkTemplates(
  selected: ZCodeBuiltinRelease,
  bundled: ZCodeBuiltinRelease | undefined,
): ZCodeBuiltinRelease {
  const declaredForkTemplateIds = bundled?.forkTemplateIds ?? [];
  if (!bundled || declaredForkTemplateIds.length === 0) return selected;
  const forkTemplateIds = [...new Set(declaredForkTemplateIds)];
  const ids = new Set(forkTemplateIds);
  const templates = new ProviderTemplateMap(
    bundled.config.providerTemplates.entries().filter(([templateId]) => ids.has(templateId)),
  );
  for (const templateId of ids) {
    if (!templates.has(templateId)) {
      throw new Error(`forkTemplateIds 指定的模板不在 Bundled 中: ${templateId}`);
    }
  }
  const rules = bundled.config.modelConfigRules
    .rules()
    .filter((rule) => rule.type === "template-model" && ids.has(rule.templateId));
  // Active 可能已经包含上一次叠加写入的 fork 规则；先移除同一模板的旧规则再追加，
  // 保证 overlay 幂等，避免每次读取都重复规则并重写 Active。
  const retainedRules = selected.config.modelConfigRules
    .rules()
    .filter((rule) => rule.type !== "template-model" || !ids.has(rule.templateId));
  return Object.freeze({
    ...selected,
    forkTemplateIds: Object.freeze([...forkTemplateIds]) as readonly string[],
    config: Object.freeze({
      providers: selected.config.providers,
      providerTemplates: selected.config.providerTemplates.overlay(templates),
      modelConfigRules: new ModelConfigRules([...retainedRules, ...rules]),
    }),
  });
}

function selectReleaseCandidate(
  bundled: ReleaseCandidate | null,
  active: ReleaseCandidate | null,
): ZCodeBuiltinRelease {
  if (
    bundled?.release &&
    active?.release &&
    bundled.release.revision === active.release.revision &&
    serializeZCodeBuiltinRelease(bundled.release) !== serializeZCodeBuiltinRelease(active.release)
  ) {
    // 同 revision 冲突属于 Active 缓存失效，不能反向使可信 Bundled 无法启动。
    // 返回 Bundled 后调用方会在能够写入时原子替换 Active。
    return bundled.release;
  }
  const valid = [bundled?.release, active?.release].filter(
    (candidate): candidate is ZCodeBuiltinRelease => candidate !== undefined,
  );
  if (valid.length === 0) {
    throw new AggregateError(
      [bundled?.error, active?.error].filter((error) => error !== undefined),
      "Bundled 与 Active ZCode Built-in Release 均不可用",
    );
  }
  return valid.reduce((newest, candidate) =>
    candidate.revision > newest.revision ? candidate : newest,
  );
}

function snapshotFromRelease(
  release: ZCodeBuiltinRelease,
  sourceKey: string,
): ProviderConfigLayerSnapshot {
  return Object.freeze({
    revision: `zcode-builtin:${release.revision}:${sourceKey}`,
    providers: release.config.providers,
    providerTemplates: release.config.providerTemplates,
    forkTemplateIds: release.forkTemplateIds,
    models: release.config.modelConfigRules,
  });
}

function signatureOf(release: ZCodeBuiltinRelease): string {
  return `${release.revision}:${serializeZCodeBuiltinRelease(release)}`;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
