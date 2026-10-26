# Desktop GitHub Release

GitHub 仓库（`zai-org/ZCode`）上的自动发版流水线，入口是 `.github/workflows/release.yml`。它复用仓库既有的 `pnpm release`（release-it）发版机制：版本号、`CHANGELOG.md`、发版提交（`chore: release v${version}`）和 `v*` tag 都由 release-it 在本地完成并推送；GitHub Actions 只负责 tag 之后的构建与发布。内部 GitLab 链路（OSS 上传、CDN 预热、后端灰度/全量发布、飞书通知，见 `docs/desktop-ci-cd.md`）不在 GitHub 上复现，两条链路互不依赖。

## 触发方式

| 触发                          | 行为                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| push tag `v*`                 | 完整发版：verify -> 三平台构建 -> 创建 GitHub Release 并上传安装包与 SHA256SUMS             |
| `workflow_dispatch`（手动）   | 构建验证。默认全平台；可通过 `platforms` 输入只构建一个平台。仅在 tag ref 上才创建 Release   |

tag 推送由 `pnpm release` 自动完成（release-it 配置 `git.push: true`，tag 规则 `v${version}`）；也可以对历史提交手动补 tag，流水线同样接管。

## 流水线阶段

```text
push tag v3.16.2
  |-- plan      计算构建矩阵（tag = 全部平台；dispatch = 按 inputs.platforms 过滤）
  |-- verify    ubuntu：pnpm install -> pnpm lint -> pnpm typecheck（快速失败）
  |-- build     矩阵并行，任一失败不取消其余平台；全部成功才进入 release
  |     windows-latest  pnpm bundle:desktop -- --win --x64
  |     macos-latest    pnpm bundle:desktop -- --mac --arm64
  |     ubuntu-latest   pnpm bundle:desktop -- --linux --x64
  `-- release   仅 v* tag ref：下载产物 -> 校验 tag 与 package.json 版本一致
                -> 从 CHANGELOG.md 提取该版本说明（scripts/release-it/github-release-notes.mjs）
                -> 生成 SHA256SUMS.txt -> softprops/action-gh-release@v2 创建 Release
```

- `verify` 不重复运行受影响单测：单测沿用本地 pre-push 门禁（`docs/testing/pre-push-hook.md`），发版流水线只做静态检查兜底。
- `build` 的 `pnpm bundle:desktop` 自包含：内部执行 `prepare:runtime-assets`（agent bundle、官方插件 runtime、native-search 仓库内置离线归档）与桌面生产构建，不依赖额外前置 build。Node/pnpm 版本锁定为 `mise.toml` / `packageManager` 的值（Node 24.14.0、pnpm 10.33.2）。
- `ZCODE_ENV=production` 在 workflow 顶层 env 显式声明：`ZCODE_ENV` 未设置时桌面打包默认解析为 test 后端（`packages/desktop/scripts/desktop-product-identity.mjs`），漏设会把测试后端安装包发出去。
- `release` 校验 tag 版本与根 `package.json` 一致后才创建 Release，防止手动打错 tag。Release 说明取 `CHANGELOG.md` 中该版本的段落；段落缺失（历史补 tag、CHANGELOG 未生成）时回退为默认说明，不阻塞发版。

## 产物

每个平台上传 workflow artifact（保留 14 天），最终随 GitHub Release 发布：

| 平台        | 文件                                                                    |
| ----------- | ----------------------------------------------------------------------- |
| windows-x64 | `ZCode-<version>-win-x64.exe`（NSIS）及 `.blockmap`                     |
| macos-arm64 | `ZCode-<version>-macos-arm64.dmg` / `.zip`                              |
| linux-x64   | `ZCode-<version>-linux-x64.AppImage` / `.deb` / `.rpm`                  |
| 汇总        | `SHA256SUMS.txt`（对以上所有文件做 sha256）                              |

产物命名来自 `packages/desktop/electron-builder.config.js` 的 `artifactName`（`${productName}-${version}-${platform}-${arch}`），workflow 按扩展名 glob 收集，不依赖具体文件名。

## 签名与公证（当前未配置）

默认产出**未签名**安装包：Windows 会有 SmartScreen 提示，macOS 首次打开需右键绕过 Gatekeeper，Linux 无影响。打包链路已预留签名开关，接入时只需在 workflow 的 bundle 步骤补充环境变量或前置导入步骤，不需要改打包脚本：

- macOS：`ZCODE_ENABLE_MAC_SIGN=1` + `APPLE_SIGNING_IDENTITY`（或 `CSC_NAME`），并先行向 runner 钥匙串导入证书；DMG 公证按需追加 afterSign 钩子。
- Windows：electron-builder 的 `CSC_LINK` / `CSC_KEY_PASSWORD`。

## 已知边界

- **fork 仓库推首个 tag 会被 pre-push 门禁拦截**：受影响单测对“仓库中不存在的新 ref”走 `firstPushBase`（`scripts/affected-unit-tests/scope.mjs`），硬性要求 `origin/staging` 做集成分支基线；内部仓库有 staging，fork 没有。受支持的绕行方式是推送 tag 时显式指定基线（scope 解析优先读取该变量）：`ZCODE_AFFECTED_TEST_BASE=<上一版本对应的 main sha> git push origin vX.Y.Z`。分支推送不受影响（自动用远端分支 sha 作基线）。
- Release 直接发布为 latest（非 draft）。需要人工确认时，在 release job 的 `softprops/action-gh-release` 步骤加 `draft: true`。
- 未配置 electron-builder 的 GitHub publish provider，因此不产出 `latest.yml` 自动更新清单；客户端自动更新对接 GitHub Releases 属于后续产品决策，不在本流水线范围。
- 构建矩阵平台清单维护在 workflow `plan` job 中（`windows-x64` / `macos-arm64` / `linux-x64`）。新增平台（如 macos-x64、linux-arm64）时同步扩展该矩阵与 `platforms` 输入选项，`bundle:desktop` 参数按 `--mac/--win/--linux` + `--x64/--arm64` 组合填写。
- GitHub hosted runner 上构建不设置 `ELECTRON_MIRROR`（那是 mise 提供的国内镜像），Electron 与 electron-builder 资源默认走官方源，bundle 脚本自带的镜像回退与重试逻辑保持不变。
