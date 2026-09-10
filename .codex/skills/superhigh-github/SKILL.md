---
name: superhigh-github
description: Super High 功能更新的默认 GitHub 发布流程，以及配置、版本号、双语更新日志、Actions、签名与同步排错；衔接项目脱敏发布。
---

# Super High GitHub

## 账号与仓库

- 工作目录：当前 Git 仓库根目录。
- GitHub 用户：`XMhead`；仓库：`XMhead/Super-High`。
- `origin`：`https://github.com/XMhead/Super-High.git`。
- 公开分支：`main`；本机完整开发分支：`private`，不得推送。
- 发布页：`https://github.com/XMhead/Super-High/releases`。
- 更新地址：`https://github.com/XMhead/Super-High/releases/latest/download/latest.json`。

执行前用 `gh auth status`、`gh repo view XMhead/Super-High --json viewerPermission` 和 `git remote -v` 核对现场身份与目标。凭据使用现有 GitHub CLI 登录；文档只记录账号及 Secret 名称，不写令牌、私钥或密码。

## 发布收口

- 源码脱敏同步与安装包发布分阶段执行：前者默认仅过滤、扫描和同步，按 [公开树检查规则](../superhigh-public-publish/SKILL.md#源码脱敏同步) 补缺失验收；后者负责完整构建、签名和分发。说明、项目技能或发布配置调整只核对内容及相关脚本并同步源码，不生成新版安装包。
- 收齐本次修改后按影响范围验收；纯样式和按钮删除只检查目标交互及相关布局，启动、跨页面、失败和退出路径仅在对应逻辑改变时检查。需要记录的更新先统一待发布版本与日志；本机正式构建覆盖前端检查，只有暂时无法正式构建或需要定位失败时单独运行前端构建。
- 验收通过后冻结源码，按授权范围同步或发布。发布入口已完成的构建、扫描和下载校验直接复用；新增改动或失败只补受影响步骤。

## 同步范围与缺失更新排查

- 交付范围以根 [AGENTS.md](../../../AGENTS.md) 为准。仅本机验收与源码同步时，用户可见更新及用户指定记录的变化累积到待发布版本的 CHANGELOG；本机实际入口更新仍按根指令验收。标签、Windows 分发安装包和 APK 仅在发布 Release 时生成。
- 接手续发已有提交时，先核对提交与已有验收证据，只补缺失步骤。按实际实现编写更新说明；发现未完成需求时说明限制，仅处理阻塞本次发布的缺陷。
- 用户反馈更新没到 GitHub 时，先核对 `git status --short`、`private`/`main` 提交、`git ls-remote origin refs/heads/main`、最新 Release 与对应 Actions。以远端实际提交和产物为准，不能只看本地 `main` 或版本号。
- 发布脚本从 `private` 已提交快照取源码，未提交/未跟踪改动不会自动包含；按用户缺失的功能核对源码与脱敏规则，区分未提交、未推送、脱敏排除、未发 Release。
- 汇报交付时给出已完成层级及对应提交或 Release 链接；未同步则说明具体停在哪一步。仅修复技能或发布配置不等于已经同步线上。

## 版本与更新日志

1. 读取 `src-tauri/tauri.conf.json` 的版本，并查询仓库最新 Release 和目标标签。用户指定版本优先；当前版本高于线上且标签未占用时，作为待发布版本持续累积更新。上一版本已发布后，首次需要记录的更新递增补丁号；同一批后续修改沿用待发布版本。
2. 同步 `package.json`、`package-lock.json` 顶层及根 package、`src-tauri/Cargo.toml` 的应用 package、`src-tauri/Cargo.lock` 的 `super-high` package、`src-tauri/tauri.conf.json`。只改应用版本，不替换依赖版本。
3. 按 [Release 格式](references/release-notes.md) 在根目录 `CHANGELOG.md` 顶部创建或补充同一待发布版本，合并重复条目，保留此前已完成的更新。先写完整中文，再写对应英文；省略空分类。源码同步时一并提交版本和日志，交付说明该版本尚未发 Release。
4. 日志修改后运行 `node scripts/check-update-release.mjs v<版本>`。正式发布时使用该待发布版本，核对累积内容与最终源码一致，将日期更新为发布日期，Release 正文与应用更新说明取该版本完整内容；不另升一次版本。此时才创建 `v<版本>` 标签，指向脱敏后的 `origin/main`。已公开的版本和标签不覆盖、不移动。

## 签名配置

- GitHub Actions 仓库 Secret：`TAURI_SIGNING_PRIVATE_KEY`。
- 本机私钥：`%USERPROFILE%\.tauri\super-high-updater.key`；公钥为同路径加 `.pub`，必须与 `tauri.conf.json` 的 `plugins.updater.pubkey` 一致。
- 当前密钥未设密码，不需要额外配置密码 Secret；若日后使用加密密钥，配套 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 用 `gh secret list --repo XMhead/Super-High` 检查名称。用户要求配置签名时，通过标准输入将私钥交给 `gh secret set`，不放进命令行参数或输出。不得为常规发布重新生成或轮换密钥。

## Windows 发布与验收

默认在本机从脱敏后的公开快照构建 Windows 签名安装包和同版 APK，GitHub 负责源码、Release 与下载托管。云端 `release.yml` 仅在用户明确要求时使用，不作为本机失败后的自动回退。

按 [superhigh-public-publish](../superhigh-public-publish/SKILL.md) 完成 private 快照、脱敏扫描及必要的补充检查、main 同步，然后在仓库根目录运行：

```powershell
node scripts/publish-local-release.mjs --source <公开工作树绝对路径> --tag v<版本>
```

公开工作树必须干净且检出本次 `origin/main`；入口校验远端来源与版本标签，使用本机原有签名、独立公开构建缓存，生成安装包、`.sig`、`latest.json` 和 APK，上传草稿并校验后公开。Release 标题固定为 `Super High v<版本>`，正文和更新说明取 `CHANGELOG.md` 的同版完整双语内容。

构建缓存保存在 `.agent/cache/public-release`，与 private 的在用 EXE 和构建目录隔离，常规收尾保留。交付包和恢复记录保存在 `.agent/tmp/local-releases/v<版本>`；续发按原公开标签和记录的源码、包哈希核验，即使远端 main 已推进也不改原标签。上传或草稿操作失败时，先修复该步骤，再带 `--resume` 使用已记录的同来源、同版本且哈希一致的产物续发；不要只为分发失败重建应用、升版或移动标签。应用源码或产物确需改变时，重新验收并按未占用的新版本发布。

完成发布必须核对 Release 非草稿、Windows 安装包及 `.sig`、`latest.json` 的版本/下载地址/签名一致且可下载，并核对正式页含本版新构建 APK；公开直链回下载 SHA256 必须与已验收包一致。本机构建发布不要求 Actions 成功；失败按本次本机日志定向处理，不能绕过构建、脱敏和产物校验。

本机 private 版本可能含公开版没有的功能，不能用公开安装包覆盖它来做升级验收。需要真实安装验证时使用隔离安装目标，并遵守根 `AGENTS.md` 的会话保护。仅维护技能说明时只核对内容；仅发布配置变更时同步配置，不为验收另造版本。

## 安卓提前交付与正式页归并

每次正式 Release 必须从本次已脱敏公开快照重新构建同版本 APK，即使仅页面或 Host 改动也不可省略。仅本机页面调试仍可按 [README 手机页面更新规则](../../../README.md) 更新页面。正式发布执行以下流程：

- 先核对远端版本和标签，再统一应用版本、Android `versionName/versionCode`。功能与必要交互验证通过后再构建交付包，避免验证中反复打完整 APK。
- 本机发布入口在已脱敏的公开工作树调用 `npm run mobile:apk`，常规发布不要另行重复打包；验收实际 APK 的 versionName/versionCode、签名、资源及敏感扫描；附件命名 `SuperHigh-<版本>-android.apk`，签名证书必须与已分发 APK 一致以支持覆盖安装，不得临时生成签名或用其他环境的 debug 签名替代。手机入口会引入共享 CSS/JS，不能用 private 构建包替代公开包。下载分发前完成所需电脑 Host 的本机验收。
- 本机发布入口先构建并校验 APK、Windows 两包，保存恢复记录后开始上传；先创建 `android-v<版本>` 预发布，指向已同步的公开提交，使用 `--prerelease --latest=false`。从公开地址取回核对 SHA256 后给手机可用的直链，再完成正式页归并。
- 本机发布入口使用 `scripts/sync-release-apk.mjs` 的 `--allow-draft --require-apk` 强制归并同版 APK，缺包或摘要异常必须失败。续发时复用已验收的同版安卓包，不重复构建。归并入口的摘要校验、幂等与并发冲突处理以 [脚本](../../../scripts/sync-release-apk.mjs) 为准，不另写上传流程或覆盖已有附件。
- 归并完成后优先交付正式页 APK 直链，并回下载核对 SHA256。保留安卓预发布链接，Windows 安装包、签名、标签及 `latest.json` 保持原样。

## 等待与交付

- 主 Agent 完成本机验收，发布执行者接手完整发布与收尾；有结果或阻塞时回传必要证据，主 Agent 直接使用，不另设状态查询或复核任务。
- 新产物验证可用即交付。用户更新只转述有新证据的阶段或阻塞；会话要求定时响应而暂无新证据时，只简短说明仍在等待，不重复已完成项或推测进度。依赖安装、编译、打包和下载验收按实际步骤区分。
- 验收工具只返回当前判断需要的字段；Host 状态返回运行状态和端口，会话返回 ID、提供商及同步结果，凭据留在执行进程内。
- 交付区分本机修改、公开源码、安装包三个实际状态。待另一任务同步的修改须明确仍待同步，不能用预计后续发布替代远端验收。

## 构建耗时与云端备用

- 本机构建分别记录编译、打包、上传及回下载耗时；保留 `.agent/cache/public-release` 以复用依赖缓存，只有源码或依赖变化、失败或未覆盖风险才重跑相关构建。首次构建和工具链变更仍可能耗时。
- 用户明确要求云端构建时，在公开 `main` 调度 `release.yml`，传入指向当前 main 的未改动版本标签；先准备同版 APK。此分支才验收 Actions 成功。权威工作流位于根目录 `.github/workflows/release.yml`。
- 云端备用继续采用 main 上的 `workflow_dispatch` 以复用分支缓存，不改成标签触发，不额外运行缓存预热。

## 常用操作

| 任务 | 入口 |
| --- | --- |
| 查看当前正式版 | `gh release view --repo XMhead/Super-High --json tagName,url,assets` |
| 查看云端备用任务（仅明确使用时） | `gh run list --repo XMhead/Super-High --workflow release.yml --limit 3` |
| 排查云端备用失败（仅明确使用时） | `gh run view <run-id> --repo XMhead/Super-High --log-failed`，只读取对应失败步骤 |
| 核对签名配置 | `gh secret list --repo XMhead/Super-High`，只核对名称，不读取或输出密钥 |
| 本机正式发布 | `node scripts/publish-local-release.mjs --source <公开工作树> --tag v<版本>`；续发加 `--resume` |
| 仅构建本机签名安装包 | `powershell -NoProfile -File scripts/build-update.ps1`，该命令不会发布 |

授权只涉及发布说明时，可以编辑 Release 标题或正文；安装包、签名、版本标签保持原样。不要为文字调整触发新构建。已发布更新清单的说明如需同步，须在用户明确要求调整线上说明时处理，并保留原版本、下载地址和签名。
