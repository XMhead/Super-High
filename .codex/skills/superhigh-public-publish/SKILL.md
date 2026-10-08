---
name: superhigh-public-publish
description: 将 Super High 脱敏后发布到 GitHub。用户说“发布到 GitHub”“推送公开仓库”“开源发布”“同步 public/main”，或要检查公开分支敏感内容时使用。
---

# Super High 开源发布

## 目标

账号、仓库、版本号、双语更新日志和签名约定见 [superhigh-github](../superhigh-github/SKILL.md)。本技能负责从私有源码生成可发布的公开版本。

项目 `.codex` 技能与源码一起公开；只过滤实际的私有资料。本地 `private` 保留原始文件和历史，GitHub `main` 接收脱敏快照，不携带私有提交历史。

## 源码脱敏同步

源码同步默认只生成公开树、扫描并推送，不构建安装包。功能修改先完成受影响部分的本机验收；只改说明或项目技能时核对内容和脚本即可。交付范围以根 [AGENTS.md](../../../AGENTS.md) 为准；仅同步任务到远端源码验收即完成，发布 Release 时才进入下节。

公开树检查按尚未覆盖的改动选择 `-Checks`：桌面前端用 `Desktop`，手机页面用 `Mobile`，共享前端用 `Frontend`，Rust 用 `Rust`，跨层依赖或无法确定影响范围用 `All`。脱敏排除或替换改变编译输入时补相应检查；源码与已通过验收的输入一致时复用结果。紧接正式打包时，由正式构建覆盖对应编译检查，避免同步阶段先重复构建。仅同步代码且缺少验收证据时先完成所需检查再推送。

选用 `Rust` 或 `All` 时，`cargo check` 共用仓库 `src-tauri/target`，须与本机构建及其缓存清理串行。

1. 确认当前工作区状态：
   - 在仓库根目录执行 `git status --short`。
   - 如有未提交改动，确认构建缓存、临时目录和私钥被忽略后，按现状提交到 `private`（“快照当前状态”即可，不要只挑本轮改动）。不要删除本机缓存或未跟踪交接材料。
   - 记录本次 `git rev-parse private`，核对用户要求同步的通用功能已进入该快照；脚本只取提交，不取工作区未提交内容。原文件是唯一源码，脱敏只排除私有文件或精准处理其中的私有内容，不维护整文件公开替代版。
   - 发现另一任务已生成待发布快照时，由原发布执行者整合本次提交与缺失文件，统一推送；不接管其工作树或争抢 main。以明确交接或远端验收收口，未完成则报告待同步。
2. 执行源码同步（默认 `-Checks None`）：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File ".codex\skills\superhigh-public-publish\scripts\publish-public.ps1" -KeepWorktree
   ```

3. 脚本自动完成：创建临时工作树 → 按 `references/private-manifest.json` 删除排除项 →
   按规则处理保留文件中的私有内容 →
   `verify-public.ps1` 敏感扫描 → 按 `-Checks` 补充检查（有构建时再次扫描公开树）→ 提交无私有历史的公开快照 →
   更新本地 `main` → 推送到 `origin/main` → 保留工作树待回收。
4. 需要推送前复核时，使用 `-NoPush` 完成扫描、所选检查和公开快照，记录生成的 `main` SHA。复核通过且 `main` 仍为该 SHA 时，执行 `git push --force-with-lease origin main`，沿用已完成的验证。`-Continue` 用于恢复未完成的同一快照，并重新传入尚未通过的 `-Checks`；来源已更新或不能确认时，从当前源码重新生成工作树。
5. 发布与产物验收完成后，使用 `agent-cleaner` 清理本次临时工作树：核对绝对路径、类型和链接指向，只摘除 `node_modules` junction，保留根依赖、日志和下载的验收产物。按当前授权选择可恢复回收或永久删除；允许永久删除的已注册工作树使用 `git worktree remove <已确认的绝对路径>`，仅在改动及未跟踪内容均已确认废弃时加 `--force`，核对目录和登记均已移除。要求可恢复时移入所在磁盘的回收站、核对恢复记录并清理该工作树登记；回收失败且仍须可恢复时保留目录与登记，说明限制。

源码同步完成以 `git ls-remote origin refs/heads/main` 与本次生成的 `main` SHA 一致、用户要求的通用改动已在该公开快照为准。仅源码同步到此结束；需要交付新版应用时继续下节正式发布，安装包和 APK 的构建、签名及下载验收由该阶段负责。

## 本机构建与 Release 发布

Windows 和 APK 均从已脱敏、已同步的公开工作树在本机构建。根目录执行：

```powershell
git -C <公开工作树> switch --detach origin/main
node scripts/publish-local-release.mjs --source <公开工作树绝对路径> --tag v<版本>
```

发布脚本生成的公开工作树原提交与 main 的历史结构可能不同；先确认工作树干净且树内容等于 main，再检出 main。入口核对公开工作树 HEAD、远端 main、版本和已有标签；新标签仅创建一次，已有标签不得移动，绝不从 private 发布。

入口使用原有本机签名构建 NSIS 和同版 APK，生成 `latest.json`，从 `CHANGELOG.md` 取正文；草稿附件、签名、APK 归并及公开直链下载校验通过后才公开 Release。缓存、恢复和安装会话保护统一见 [本机发布与验收](../superhigh-github/SKILL.md#windows-发布与验收)。上传失败使用同一入口加 `--resume`，复用校验过的产物，避免重新编译。

云端工作流仅在用户明确要求时备用，权威源为根目录 `.github/workflows/release.yml`。该分支通过 `gh workflow run release.yml --repo XMhead/Super-High --ref main -f tag=v<版本>` 调度；不作为默认收口步骤。

公开版 README 默认中文（`README.md`），英文在 `README.en.md`，功能讲解在 `FEATURES.md`。

## 参数

- `-SourceBranch <name>`：默认 `private`，取快照的源分支。
- `-NoPush`：只更新本地 `main`，不推送 GitHub。
- `-Checks None|Desktop|Mobile|Frontend|Rust|All`：默认 `None`；分别为不补编译、桌面前端、手机页面、两端前端、`cargo check`、全部三项。敏感扫描始终执行。
- `-SkipBuild`：兼容旧调用，等同默认 `-Checks None`，不能与其他检查组合。
- `-KeepWorktree`：默认开启；成功后保留工作树供验收，再按源码同步第 5 步清理。
- `-Continue`：复用失败时保留的工作树，从扫描和所选检查继续；需显式传入尚未完成的 `-Checks`。

## 规则与安全

- **绝不推送 `private` 分支**。本地已安装 `pre-push` 钩子拦截 `refs/heads/private`；
  不要绕过它。
- 公开 `main` 由脚本生成，只允许脚本更新；不要手动在 `main` 上改代码。
- 公开仓库不允许出现：个人磁盘路径、服务器 IP、私服名称、个人 token/密码。
- 新增私有内容时，在 `references/private-manifest.json` 声明必要排除或精准处理规则，保留其余通用内容；运行 `verify-public.ps1` 确认扫描通过。
- 正式发版以本机完整签名构建、脱敏扫描和公开产物下载验证为准；仅前端构建不能代替正式包验收。仅调整发布配置时同步公开配置并完成脚本或静态核对，不为验收另造版本；实际完整流程留待下一次功能发布验证。只有明确使用云端备用时才要求对应 Actions 成功。

## 清单与资源

- `references/private-manifest.json`：权威过滤清单（排除路径、私有内容处理和扫描规则）。
  修改后必须跑 `scripts/verify-public.ps1`。
- `scripts/publish-public.ps1`：发布主流程。
- `scripts/verify-public.ps1`：敏感扫描；硬失败规则命中即退出码 1，警告规则需人工复核。

## 常见失败点

- `npm run build` 失败 → 公开树缺少编译修复，检查新增引用；若报 `xxx is not recognized`
  则是仓库根 `node_modules` 残缺，先 `npm ci` 补全再用 `-Continue -Checks Desktop`（手机或共享前端选择对应项）续跑。
- 本机发布失败 → 读取 `.agent/tmp/local-releases/v<版本>` 的状态和本次构建日志；上传阶段失败用 `--resume` 续发，不重新构建。
- 云端备用（仅明确使用时）失败 → 用 `gh run list --repo XMhead/Super-High --workflow release.yml`
  看状态，`gh run view <run-id> --repo XMhead/Super-High --log-failed` 直接看失败日志（gh 已登录）。
- 敏感扫描失败 → 看输出中的文件路径，修正源文件或过滤清单。
- 推送失败 → 检查网络/GitHub 凭据；`git push --force-with-lease origin main` 只由脚本执行。
- 网络不稳反复推送失败（TCP 通但 HTTPS 断）→ 脚本在推送前已更新本地 `main`，失败后直接
  `git push --force-with-lease origin main` 加重试循环即可，不必重跑整条流水线；
  `Test-NetConnection` 通过不代表 push 能成功。
