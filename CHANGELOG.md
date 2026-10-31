# 更新日志

记录版本的用户可见变化。新发布说明按固定分类提供中文和英文，版本号与 GitHub Release 标签保持一致。

## [0.1.42] - 2026-10-30

### 新增功能

- 聊天模式新增本地模型与推理强度菜单，缓存 Codex 原生模型目录及 Claude Code 已读取的模型列表，选择仍交由原生 CLI 应用；新增上下文窗口、用量圆环和缓存命中率，可按需读取 Claude 原生上下文分类并标明估算，兼容独立会话宿主与旧宿主降级，不覆盖已有 Claude 状态栏。
- 完善 Agent 技能协作：`superhigh-html` 的实际预览与操作证据可用于 IUI 方案比较；按方案版本记录反馈，并在修改后更新原 IUI 的验证结果。
- 移除 VitePress 专用文档预览入口、文档工作区标签与后台检测及服务管理；普通 HTML 文件预览继续保留。
- 移除工作模式的独立对话管理侧栏及其占位；普通和多终端布局直接使用 CLI 会话切换，聊天模式继续提供会话历史侧栏。
- 聊天模式的正文文件引用复用文件图标与代码预览入口，支持行号跳转；每轮展示文件改动及增删行数，输入区提供按目录展开的改动审阅，复用差异编辑器查看并保留或撤销可还原的修改。新增原生日志用量统计，展示可用 Token、费用及按整轮耗时估算的速度，缺失费用保持未知。
- 重做聊天模式：左侧按工作区汇总本机 Claude Code、Codex、DeepSeek Harness 和 OpenCode 历史，支持搜索、智能体筛选与分页；打开历史只读取记录，底部直接输入消息，发送时才恢复原生会话并提交，查看和编辑草稿不启动 CLI，发送失败保留草稿。聊天正文采用连续执行时间线，可展开思考与工具输出，代码及文件按需显示。兼容配置目录覆盖、Codex 归档、DSH 版本化压缩记录和 OpenCode 新旧存储，原始 CLI 数据保持只读。
- 文件搜索支持后缀优先筛选：输入独立的 `.yaml`、`.json` 等后缀时只搜索对应类型，多后缀按任一匹配，剩余文字继续匹配文件；忽略后缀大小写，并在内容读取前跳过其他类型。
- IUI 默认开启独立的界面预览，正文默认渲染 Markdown，支持 `Ansi`、ANSI 代码块及 Markdown 代码块正文渲染；标签页和单选分类按钮支持悬停与键盘聚焦实时预览，移开恢复，点击才保留选择，临时预览不写入状态或提交结果。
- Agent CLI 改由独立会话宿主持有：关闭或重启 Super High 后自动显示可交互的原生终端，重新打开对应工作区或继续对话后隐藏外部窗口并接回原会话和进程；明确终止会话、关闭外部终端或 CLI 自己退出时回收 Agent 与宿主。保留终端回放、计划提问和子 Agent 展示。
- IUI（`.shui`）新增 `Page(children, footer)`：长列表在正文区独立滚动，底部的输入框、表单和确认按钮保持可见。
- 设置新增“自动任务”，支持系统内置、全局和项目三种来源，一次性或每日定时执行；内置定时关机/重启默认禁用。`superhigh-cli automation list/save/delete` 可为工作区登记命令任务，显示下次执行与上次结果；应用运行期间持续调度，退出或休眠错过的时间不补跑。
- IUI（`.shui`）新增 `Video`、`Audio` 和 `Model3D`：可内嵌播放本地音视频，拖动旋转、滚轮缩放 glTF/GLB 模型，并从资源标签跳转原文件；模型支持 glTF 外部缓冲与纹理资源。
- 项目和全局 JS 插件保存后自动去抖重载，覆盖入口、模块、样式与清单变化；保留禁用状态，修复加载错误后可自动恢复。
- IUI（`.shui`）确认和表单提交会将可读结果追加到发起 Agent 会话的输入草稿，由用户检查后手动发送；保留已有草稿，防止重复回填，原会话结束或应用重启后旧界面不再回填。
- 移除 Super-Jev 专用模式和 DSH TUI 启动入口，编辑器不再内置决策模型或其路由逻辑。
- 支持插件在工作区嵌入本机网页，为 DeepSeek Harness 全局插件提供大面积工作区与认证访问。
- 通过本机 CLI 创建的终端也会显示在对应工作区。
- Agent CLI 输入框新增一键清空按钮，可清除当前会话的草稿和附带引用；Codex 异步临时提问会显示管家通知，列出问题与选项并提示回原会话回答。
- 设置“脚本与编辑器”支持为当前工作区引用多个项目，分别启用项目指令、脚本工具和编辑器；当前项目优先，引用不递归、不影响其它工作区。脚本与页面沿用来源项目的文件，执行和文件编辑仍面向当前工作区。
- CLI 输入框新增“定时发送”：预存消息并设置 1 分钟至 6 小时后自动发送到当前 Agent CLI 会话，每个会话最多 5 条；列表显示倒计时与发送时刻，可随时取消。点击预存消息可修改正文、重新调整时间或立即发送，也可直接复制消息；保存修改后从当前时刻重新计时。切换会话或工作区不影响计时，发送时不清空正在输入的草稿，关闭会话即取消其定时消息。经典输入框与聊天视图均可使用。
- Agent CLI 斜杠命令改为读取内置命令目录，不再在输入 `/` 时逐项按键采集终端菜单；设置“终端”新增中文翻译开关，开启时显示中文说明，关闭时显示 CLI 原始英文。命令目录保存在应用数据目录的 `agent-cli-commands.json`，可在设置中直接打开编辑，更新后无需重新构建应用。

### 问题修复

- 修复网络访问 ChatGPT 较慢时，Super High 内启动 Codex CLI 报 `workspace routing discovery timed out` 并直接退出的问题：账号路由查询超时或失败时自动重试，最多等待 90 秒；外部启动的 Codex 不受影响。

- 区分主动关闭与应用退出／重启：终端标签和聊天模式的关闭按钮明确结束会话进程，修复关闭后仍显示外部终端的问题；自动清理、切换工作区和移到外部继续仍保留原会话。

- 修复聊天／工作模式的会话异常跳转：迟到的新建、恢复和设置读取不再覆盖较新的选择与输入，后台接回会话不打断历史草稿，历史草稿在模式往返后仍可恢复。关闭工作区只脱离界面并保留原 CLI，重新继续时接回原进程；主动关闭 Agent 对话会结束对应进程与宿主，失败时保留标签与草稿。

- 聊天模式新增 Codex 异步待答问题入口，按 CLI 当前快捷键展开原会话队列；Plan、多选和其他回答保留完整原生问答表单，支持切题、补充输入与提交，完成后回到聊天。返回聊天不取消待答问题，并阻止普通聊天发送覆盖问答输入；异步回答记录显示可读的问题与答案，隐藏内部 JSON 封装。

- 聊天模式支持拖动会话侧栏、聊天与代码预览、代码预览与资源管理器之间的分割线调整宽度，顶部工具栏随分栏对齐。
- 聊天模式点击已变更文件后直接展开代码预览标签，定位首处改动并显示差异，不再弹窗遮挡聊天；长行横向滚动，支持展开上下文及切换当前源码。`.shui` 默认保留界面渲染，可独立切换源码与差异；普通文件打开清除审阅状态，保留和撤销仍在聊天文件列表操作。
- 聊天模式的文件变更用紧凑矩形中文标签显示“已修改 / 已新增 / 已删除”，替代难懂的 M / A / D 字母；保留增删行数与未确认提示。
- 修复临时 SuperHigh 实例接管同一 Agent 后退出，导致原应用内嵌终端与外部窗口双重显示的问题；保留存活的接管者，并在桌面连接期间持续恢复窗口隐藏状态，兼容旧版终端辅助程序。
- 修复历史聊天或 CLI 退出后粘贴图片未保存为路径、恢复会话后侧栏仍显示历史时间的问题；恢复期间保持原聊天界面等待，切到工作模式先恢复选中的同一会话。隐藏终端停止接收全局输入，切换会话时忽略迟到的输出监听与输入回调，避免聊天和工作模式串会话。
- 聊天模式按每条原生消息确认接收，保留任务中途补充的消息及时间线顺序；连续发送分别核对，暂未确认时保留消息继续检查，不再误报发送失败或自动放回草稿，迟到回执自动消除等待状态。
- 聊天模式持续显示任务中的阶段说明，完成任务或折叠执行详情后仍按原顺序保留；实时会话与历史记录一致，工作模式保持原有行为。
- 修复继承终端强制配色时，GitHub 登录状态和回放仓库列表的 JSON 混入 ANSI 颜色码、导致读取失败的问题。
- CLI 输入草稿按会话即时保存并在应用重启后恢复；图片和文本附件保存文件引用，切换 Git 等页面后仍可恢复，发送、清空和关闭会话时同步清理。
- Git 变更、历史与回放切换时保留差异编辑器和已加载的仓库列表，短时间返回复用状态与差异缓存；回放复用本地仓库状态，过期列表后台刷新，减少反复联网、扫描与重建造成的等待。
- 修复 Agent 外部终端被再次显示后与内嵌终端重复出现的问题，重新接管时立即隐藏外部窗口；保留原会话和进程。
- 修复 IUI 数据文件暂时被占用或读取失败时误报“二进制内容”的问题；短暂失败自动重试，目录重新扫描后刷新数据，并丢弃过期的读取结果。
- 修复 IUI 悬停切换图片或标签页时，正文暂时塌缩导致滚动跳动、反复移入移出和闪烁的问题；临时预览保留原内容高度，恢复页完成加载后释放。
- 修复 HTML 内嵌预览拦截工作区外本地图片的问题，兼容动态图片、`srcset`、文件 URL 和跨目录相对路径，并复用于项目编辑器与手机预览。
- Codex CLI 异步队列问题通知保持显示，并提供返回原会话回答入口；会话退出后关闭通知，避免等待中的问题在 20 秒后消失。
- 修复 IUI 图片在同一路径覆盖后仍显示旧内容的问题，图片变更和界面重载会刷新资源，并丢弃过期读取结果。
- `.yml` 与 `.yaml` 文件统一显示 Notepad++ 图标；本机部署同步产品图标并定向通知 Windows 刷新桌面快捷方式和程序图标。
- 系统图片查看器当前显示的图片被删除后自动关闭；有未保存的编辑时保留保存提示。
- 修复输入框清空按钮未清除 Codex CLI 原生输入区的问题；同时清除 Super High 草稿，保留正在运行的任务。
- 代码预览的 YAML/Markdown 键值面板在切换文件标签时保留搜索词和筛选状态。
- Windows 查看器改用内嵌原生视频引擎直接解码原片，支持 SuperCut RGB 4:4:4 无损录像；不再转码或在视频目录生成 `.superhigh`、预览 MP4 与 JSON。保留播放、暂停、进度定位、音量、全屏与内存截图复制，切换和关闭时释放解码器；禁用播放进度、磁盘和着色器缓存。
- Markdown 文件渲染自动识别正文与行内代码中的本地路径，确认存在后生成跳转链接；文件在代码预览打开，目录在系统资源管理器打开，点击时再次核对目标。
- 修复 Skill 脚本统计漏记 Codex `exec` 包装调用及用户主目录变量路径的问题；升级后回扫现存会话补数，保留已有累计与去重记录，删除原始会话不清空统计。
- 修复 IUI（`.shui`）内点击本地文件链接导致整个应用页面重新加载的问题，链接改为在代码预览中打开；IUI 图片和 Markdown 图片支持点击放大预览、缩放与 Esc 关闭，备忘录图片预览也支持 Esc 退出。

---

### New Features

- Chat mode adds cached local model and reasoning menus backed by the native CLI, plus context-window usage, an animated usage ring, and cache-hit statistics. Claude context categories refresh on demand and retain their estimated source. Independent session hosts forward the data, older hosts fall back safely, and existing Claude status lines are preserved.
- Improved Agent skill coordination: actual previews and interaction evidence from `superhigh-html` support IUI comparisons, with feedback tied to proposal revisions and verification results updated in the original IUI after changes.
- Removed the dedicated VitePress preview entry, documentation workspace tabs, background detection, and server management. HTML file previews remain available.
- Removed the separate conversation management sidebar and its reserved space from work mode. Standard and multi-terminal layouts use CLI session switching, while chat mode retains its conversation history sidebar.
- Chat file references reuse shared file icons and the code preview, including line navigation. Per-turn change totals and a collapsible folder tree expose native edits for diff review, keeping, and safe undo. Native usage records supply available token counts and costs, with average speed estimated from the whole turn; missing costs remain unknown.
- Rebuilt chat mode with workspace-grouped local Claude Code, Codex, DeepSeek Harness, and OpenCode history, search, provider filters, and paging. History opens for reading with a message composer; only sending resumes the native session and submits the message. Reading and drafting never launch a CLI, and failed sends retain the draft. A continuous activity timeline exposes reasoning and tool output, with code and files available on demand. Readers support configuration-directory overrides, archived Codex sessions, versioned compressed DSH logs, and both old and new OpenCode storage without modifying native CLI data.
- File search prioritizes extension filters: standalone suffixes such as `.yaml` and `.json` restrict results to those types, with OR matching across suffixes and the remaining text used as the query. Extensions are case-insensitive, and other file types are skipped before content reads.
- IUI opens in its own rendered preview by default, renders body text as Markdown, and supports `Ansi`, ANSI code blocks, and rendered Markdown code blocks. Tabs and single-choice categories offer live hover and keyboard-focus previews that restore on leave; only clicks retain selections, and temporary previews never enter saved state or submissions.
- Agent CLIs now run in independent session hosts. Closing or restarting Super High shows an interactive native terminal; reopening the workspace or resuming the conversation hides that window and reconnects to the same session and process. Explicitly terminating the session, closing its external terminal, or exiting the CLI reclaims the Agent and host. Terminal replay, plan questions and subagent views remain available.
- IUI (`.shui`) adds `Page(children, footer)`: long content scrolls independently while footer inputs, forms, and confirmation buttons remain visible.
- Added Automatic Tasks settings with built-in, global, and project sources and one-time or daily schedules. The built-in shutdown/restart task is disabled by default. `superhigh-cli automation list/save/delete` registers workspace commands and exposes the next run and latest result. Scheduling continues while the app is running; occurrences missed during exit or sleep are skipped.
- IUI (`.shui`) adds `Video`, `Audio`, and `Model3D` for embedded local media playback, draggable rotation and wheel zoom of glTF/GLB models, and links to the original files. glTF external buffers and textures are supported.
- Project and global JS plugins automatically reload after debounced changes to their entry points, modules, styles, or manifests. Disabled states are preserved, and corrected load errors recover automatically.
- IUI (`.shui`) confirmations and form submissions append readable results to the originating Agent session's draft for manual review and sending. Existing text is preserved, repeated inserts are prevented, and old views stop inserting after the session ends or the app restarts.
- Removed the Super-Jev mode and DSH TUI launcher; the editor no longer embeds a decision model or its routing logic.
- Enabled workspace plugins to embed local pages, including authenticated access for the DeepSeek Harness global plugin.
- Terminals created through the local CLI also appear in their workspace.
- Added a button to clear the current Agent CLI draft and its attachments. Codex asynchronous questions now show a notification with the question and options, directing the user back to the original session to reply.
- Added per-workspace project references in Scripts and Editors settings, with separate toggles for commands, script tools, and editors. Local entries take precedence; references are direct and do not affect other workspaces. Shared scripts and pages load from their source project while execution and file editing target the current workspace.
- Added scheduled sending to the CLI input: queue up to 5 messages per session to be sent to the current Agent CLI conversation after 1 minute to 6 hours, with a live countdown, send time, and cancel option. Click a queued message to edit its text, change its delay, or send it immediately; messages can also be copied directly. Saving restarts the countdown from the current time. Timers keep running when switching sessions or workspaces, a scheduled send does not clear the draft being typed, and closing a session cancels its pending messages. Available in both the classic input and the chat view.
- Agent CLI slash commands now come from a built-in command catalog instead of pressing through the terminal menu each time `/` is typed. Terminal settings add a Chinese translation switch: on shows Chinese descriptions, off restores the CLI's original English. The catalog lives at `agent-cli-commands.json` in the app data directory and can be opened and edited from settings without rebuilding the app.

### Bug Fixes

- Fix Codex CLI exiting with `workspace routing discovery timed out` when launched inside Super High over a slow connection to ChatGPT: account routing lookups that time out or fail are retried for up to 90 seconds; externally launched Codex is unaffected.

- Distinguish explicit session closure from app exit/restart: terminal and chat close buttons terminate the session process instead of exposing an external console; automatic cleanup, workspace changes and external handoff continue to preserve the session.

- Fixed unexpected conversation switches between chat and work modes: late creation, resume, and settings replies no longer override newer selections or input; background restoration preserves history drafts, including across mode changes. Closing a workspace detaches it while keeping its CLI alive, and resuming reconnects the original process. Explicitly closing an Agent conversation ends its process and host; failures preserve the tab and draft.

- Added a chat entry for queued Codex questions using the CLI's current shortcut. Plan, multiple-choice and custom answers retain the complete native form for question navigation, notes and submission, then return to chat. Returning to chat preserves pending questions and ordinary chat sends cannot overwrite form input. Async reply records show readable questions and answers instead of internal JSON envelopes.

- Chat mode supports dragging the dividers between history, chat, code preview, and the file explorer to resize panels, keeping the top toolbar aligned.
- Clicking a changed chat file opens its diff in a code preview tab at the first change, keeping the conversation visible. Long lines scroll horizontally, with expandable context and a source switch. IUI files retain rendered previews with separate source and diff modes; normal file opens clear review state. Keep and undo remain in the chat file list.
- Chat file changes use compact rectangular Chinese status labels for modified, added, and deleted files instead of M / A / D, while preserving line counts and unconfirmed-operation warnings.
- Fixed duplicate embedded and external Agent terminals after a temporary SuperHigh instance reconnects and exits. Live console ownership is preserved, and the connected desktop keeps the external window hidden, including with older console helpers.
- Fixed image pastes in history or after CLI exit not becoming saved paths, and resumed sessions still appearing as history. Resuming keeps the current chat visible while waiting, and switching to work mode resumes the selected conversation first. Hidden terminals no longer accept global input, and stale output listeners and input callbacks are rejected after session switches to prevent cross-session chat/work input.
- Chat mode acknowledges each native user message and preserves mid-task follow-ups in timeline order. Consecutive sends are confirmed separately; unconfirmed messages remain visible while checking continues, without false send failures or automatic draft restoration, and late receipts clear the waiting state.
- Chat mode keeps interim progress messages visible in their original order after completion or collapsing execution details, for both live sessions and history. Work mode behavior is unchanged.
- Fixed GitHub account and replay repository JSON parsing failures caused by inherited terminal settings forcing ANSI colors into CLI output.
- CLI drafts are saved immediately per session and restored after app restarts. Image and text attachment references survive navigation to Git and other panels; sending, clearing or closing a session removes the saved content.
- Git changes, history and replay retain the diff editor and loaded repository list across tabs. Quick reentry reuses status and diff caches; replay shares local repository status and refreshes stale lists in the background, reducing repeated network requests, scans and editor recreation.
- Fixed detached Agent consoles remaining visible alongside embedded terminals after being shown externally. Reattaching immediately hides the native window while preserving the session and process.
- Fixed IUI data reads misreporting temporary file locks and I/O failures as binary content. Transient failures retry automatically, workspace rescans reload data, and stale read results are discarded.
- Fixed flickering during IUI image and tab hover previews caused by temporary content collapse and scroll jumps. Previewing preserves the original content height until the restored page finishes loading.
- Fixed local images outside the workspace being blocked in embedded HTML previews, including dynamic images, `srcset`, file URLs, and relative paths across directories. Project editors and mobile previews share the fix.
- Codex CLI asynchronous question notifications stay available and provide a return-to-session action. They close when the session exits, preventing pending questions from disappearing after 20 seconds.
- Fixed stale IUI images after overwriting the same path. File changes and view reloads refresh images, while outdated reads are discarded.
- Unified `.yml` and `.yaml` files on the Notepad++ icon. Local deployment now copies the product icon and requests targeted Windows refreshes for the desktop shortcut and application icons.
- The system image viewer closes automatically when its current image is deleted, while preserving the prompt for unsaved edits.
- Fixed the clear button leaving text in the native Codex CLI composer; it now clears both drafts without interrupting the running task.
- Kept the YAML/Markdown outline search and filter when switching file tabs in the code preview.
- The Windows viewer now embeds a native engine to decode original videos, including SuperCut RGB 4:4:4 lossless recordings. Playback no longer transcodes or creates `.superhigh`, preview MP4 or JSON files beside videos. Play/pause, seeking, volume, fullscreen and in-memory frame copying remain available. Switching or closing releases the decoder; resume files, disk caches and shader caches are disabled.
- Markdown file previews now link existing local paths in prose and inline code. Files open in the code preview and directories open in the system file manager, with targets checked again on click.
- Fixed missing Skill script counts from Codex `exec` wrappers and home-directory variable paths. Existing sessions are rescanned once to backfill missing calls while preserving totals and deduplication; deleting session logs does not clear recorded counts.
- Fixed local file links in IUI (`.shui`) reloading the entire application; files now open in the code preview. IUI and Markdown images support click-to-preview, zoom, and Escape to close; memo image previews also close with Escape.

## [0.1.41] - 2026-10-25

### 新增功能

- 代码预览新增内置 PowerPoint `.pptx` 预览，支持逐页翻阅、页码跳转、缩放、展开阅读及常见动画播放，无需安装 Office、WPS 或 LibreOffice；支持出现、淡入淡出、飞入、擦除、缩放、旋转和基本运动路径，按点击、同时和之后的顺序播放，可暂停、继续、逐步播放及重播，并支持淡化、推入和擦除切换。旧版二进制 `.ppt`、文本逐段动画和复杂触发器等不兼容效果会明确提示。
- 新增 `examples/PowerPoint预览与动画验收.pptx`，用 9 页覆盖中文、四种入场、同时与之后、强调、路径、退场、图片、图表及页间切换；可运行 `node scripts/create-presentation-preview-demo.mjs` 重新生成。
- 代码预览支持旧版 Excel `.xls` 工作簿，沿用 `.xlsx` 的只读表格预览、工作表切换、合并单元格和分页。
- 设置“终端”页新增 Codex 全局 `AGENTS.md`、Claude Code 全局 `CLAUDE.md` 的实际路径与存在状态，默认展开文件内容并以 Markdown 渲染，点击正文即可直接编辑，输入后自动保存、无需保存按钮或快捷键；每个文件只保留“渲染”开关和“代码预览”跳转按钮；识别自定义 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`。
- CLI 命令输出中的文件跳转支持 `$env:USERPROFILE/...`、`${env:USERPROFILE}/...` 和 `%USERPROFILE%/...` 等环境变量前缀，点击前由本机解析并确认文件或目录存在。

- 新增 SuperHigh Agent 调度接口：`superhigh-cli agent sessions/tasks` 与 `mcp serve` 共用桌面任务表，供本机外部及内部 Codex / Claude Code 创建或继续真实会话、提交任务、查询原生完成结果、分页读取回答、有限等待与请求中断；支持重复提交去重、忙碌会话检查和自身／上游会话防循环。MCP 提供九个 stdio 工具，连接断开不取消任务。

- 代码预览新增 SuperHigh UI（`.shui`）界面预览：Agent 用一行一条的组件语句描述界面，打开文件即渲染成适配窄面板的卡片、指标、表格、图表、步骤、表单、单选和可排序列表等组件；文件边写边刷新，尚未写完的部分显示占位，底栏标出语法问题。组件可拖动重排并自动写回源码，拖到 CLI 面板会把该组件的源码作为引用插入输入框；按钮点击、表单提交和字段值保存到同目录的 `.shui.state.json` 供 Agent 读取。表格支持搜索、按列下拉筛选和分页；`Bind` 让下拉、单选等字段直接驱动指标、图表、表格和面板切换；`Data` 从同目录 JSON/JSONL 读取数据，文件变化后自动刷新；柱状图支持堆叠和百分比堆叠，超过 4 组的系列合并为“其他”。
- 新增 `superhigh-cli files open <路径>`：在桌面代码预览打开当前工作区内的文件，`.shui` 与 `.html` 自动切到预览，Agent 生成界面后可直接呈现给用户。
- 内置 CLI 输入框粘贴超过 500 字符的文本时，自动导出到当前工作区 `.agent/tmp`，以 `SH粘贴-2026年10月21日14时05分33秒.txt` 这类中文时间戳命名，并在输入框显示为文件卡片；发送时附上文件路径交给 Agent CLI。输入 `@` 可从 `.agent/tmp` 中所有带 `SH粘贴-` 标识的文件里选择引用。
- 备忘录操作栏“导入对话框”右侧新增“导出文件”：直接在当前项目工作区根目录下按备忘录标题保存，无需手动选择位置；正文写成 Markdown 文件，图片附件以图片语法附上绝对路径；完整 HTML 备忘录导出为 `.html`。

- 设置新增“使用统计”页，界面参照 ZCode 使用统计：顶部为累计 Token、单日峰值、最长会话、当前连续与最长连续天数；下方是 52 周 Token 活跃度热力图（每日 / 每周 / 累计），以及近 7 日或近 30 日的每日模型用量趋势与模型用量占比。数据只读取 cc-switch 的请求日志和按天汇总，沿用 cc-switch 的含缓存输入归一与会话日志/代理日志去重口径，不写入 cc-switch 数据库。
- 新增 Git 视图：顶部模式栏最左侧的 Git 按钮打开当前工作区的变更与提交历史，右侧使用只读差异预览；显示分支与领先/落后状态，支持刷新和分页加载历史，不会修改仓库。
- 设置新增“账户”页并接入 GitHub：通过 GitHub CLI 显示当前登录账号，在本地终端完成浏览器授权；SuperHigh 不读取或保存 GitHub 令牌。
- Git 视图新增“回放”标签：用 gitlogue 把提交按打字动画重新播放。左侧列出当前项目和已登录 GitHub 账号下的全部仓库，点选即播放；其它仓库首次使用时克隆到应用数据目录的 `git-replay` 缓存（不检出文件），之后只增量拉取。可选回放顺序、打字速度和仅看自己的提交，自动跳过锁文件；需先安装 gitlogue（`cargo install gitlogue --locked`）。
- 顶部“搜索”菜单的“查找”和“替换”改为独立的桌面式查找对话框：提供查找、替换、文件中查找、项目中查找、标记五个标签，支持普通、扩展与正则表达式、全词匹配、匹配大小写、反向和循环查找、选区内替换、替换所有打开文件、结果列表跳转、透明度调节与窗口拖动。
- 资源管理器新增返回顶部按钮；外观设置可隐藏侧边活动栏。导入文件内容到备忘录后显示可操作提示，可选择将源文件移到系统回收站；完整 HTML 备忘录在预览模式中按页面渲染。

- 新增为 vibecoding 定制的 SuperHigh Vibe 主题，在设置“界面主题”下拉中单列为 SuperHigh 分类：启用后启动画面换成专属开场——星流跃迁、能量向核心聚拢后冲击定格，冲击波、火花与电弧外放，标志带色散残影砸入，标题逐字解码，充能条在数据加载期间扫描、就绪后充满，随后光圈从核心打开露出工作区；冲击定格后可点击提前进入，开启系统“减少动态效果”时只显示静态画面。其余主题沿用原启动画面。界面上靛墨玻璃面板下缓慢漂移的极光背景，窗口失焦时自动暂停；Agent CLI 输出期间终端顶部流动渐变线、当前会话图标呼吸，停止输出后自动收起。活动栏、标签、工作区与会话卡片使用统一的渐变指示，输入框聚焦显示渐变描边，发送与确认按钮改为渐变底；菜单、补全和对话框带磨砂底与短入场动画，并遵循系统“减少动态效果”设置。其它主题外观不变。

- 编辑器分为系统、全局、项目三级：全局编辑器登记在应用数据目录的 `editor/editor.json`，项目编辑器保持原有位置。按 F4 打开编辑器选择，可搜索、按来源切换并快速回到最近使用的编辑器；设置新增“编辑器”页查看与打开三级编辑器。

- YAML/MD 键值面板新增搜索框，可快速过滤键值；外观设置新增“YAML 键值 RGBA 标题配色”开关，开启后键值面板按 RGBA 标题配色规律为每个键分配稳定颜色，编辑器正文仍保持常规键值配色。

- 外观设置的“Markdown 标题颜色”改为“RGBA 标题配色”开关：开启时 Markdown 渲染标题按标题文字使用与 YAML 键值相同的 RGBA 标题色板，同名标题同色；关闭后使用主题文字色。切换状态会保存并在下次启动时恢复。

- 内置系统编辑器“Skill 概览”：汇总当前项目与全局 Skill 的数量、描述和正文，估算每次会话常驻的描述 token 与调用时加载的正文 token；Skill 扫描新增 `.agent`、`.cursor`、`.codebuddy`、`.kimi`、`.opencode` 目录。

- 服务端和 Minecraft 客户端使用独立控制台运行。Super High 只读监测日志，保留启动和重启按钮；退出或更新应用后进程继续运行并恢复原生窗口，重新打开工作区自动恢复监测。

- Codex 聊天模式新增子 Agent 工作视图：按任务显示真实状态、模型和耗时，展开查看实时文字、命令输出、工具调用与文件修改，并恢复已有子会话记录。

- CLI 区顶栏新增“聊天 / 工作”切换。聊天模式把 Claude Code、Codex 会话显示为对话：工具调用折叠为思考步骤，最终回答按管家通知样式展示并记录耗时与完成时间；模型按钮和输入 `/` 直接调用 CLI 真实的 `/model` 菜单与命令列表。工作模式保持原终端。

- 设置“插件”页新增“Skill 脚本使用统计”，沿用“使用统计”页的摘要条、52 周活跃度热力图、近 7 / 30 日每日调用趋势与占比，并列出当前项目与全局 skill 的全部脚本（含从未调用的）及次数、最近使用时间、来源和过时线索（已不存在、文档未提及、被同 skill 其它脚本引用）。只统计 skill 目录（含 `SKILL.md`）下 `scripts/` 内的脚本，普通项目脚本与 `.agent/tmp` 不计入；经 `.agents`、`.claude`、`.codex` 等软链接调用的同一 skill 脚本合并计数。次数自动从 Claude Code、Codex 的原生会话记录增量统计（SuperHigh 内外的对话都会计入），脚本工具面板的运行直接计入；计数保存在应用数据目录，会话记录被 CLI 清理后仍保留。
- 新增 `superhigh-cli skills usage`，供 Agent 查询 skill 脚本调用次数：支持 `--skill`、`--unused`、`--idle-days`、`--all`、`--daily` 与 `--json`，用于判断哪些 skill 脚本已过时。

### 体验优化

- 文件管理网格改为按可见行绘制，缩略图仅按视口加载、限制并发及缓存大小；目录排序复用预计算键，文件名搜索统一防抖，减少大目录渲染和输入等待。
- 代码预览按文件保留独立编辑模型、撤销历史与滚动位置，关闭时释放，闲置模型按预算淘汰；大型文本关闭昂贵建议与折叠，大型 YAML 跳过全量语法检查。项目内容搜索改为受限并行、分批显示，先执行文件过滤和完整匹配再计入结果上限。
- 切换代码标签不再重复重设全局主题或同步同一模型；YAML 键值面板只扫描根键并按文件版本复用结果，避免切换时构建整份嵌套导航索引。
- 移除 Agent 对话的文件变更面板、增删行统计、差异历史与相关 CLI 接口，停止为对话建立文件基线和扫描工作区；会话识别、聊天记录、任务完成及计划提醒独立保留。

- 自动补建 `.superhigh` 默认注册表、模板及缓存目录前，要求当前工作区自身包含 `AGENTS.md`、`CLAUDE.md` 或本地 Agent Skill，避免打开盘符根目录、普通目录时反复生成项目产物；已有配置仍可读取。

- 移除 CLI 输入框的空格整理和 Codex 提示词增强按钮，同时清理撤销、状态提示、离线资源下载与专用 CLI/后端代码。

- 大数据性能优化：备忘录改为每页最多 80 条摘要、选中后读取正文，支持跨页恢复与完整正文搜索；文件树和目录搜索只绘制可见行，保留滚动锚点、多选和键盘操作。
- 聊天先显示最近 40 轮，向上滚动或点击可加载更早记录；按修订只传变化的回答，历史 Markdown 复用缓存，隐藏面板暂停普通轮询，发送确认仍正常运行。
- YAML 语法检查移入后台 Worker，大文件停笔后再检查，过期任务自动终止；打开与编辑大文件不再等待整份语法解析，正文即时同步，保存使用最新内容，颜色及键值装饰按可见范围更新。
- 文件搜索按路径维护索引，普通写入只更新已有文件的修改时间，被忽略文件的持续写入不再触发扫描；新增、删除、重命名和忽略规则变更仍及时更新。搜索保留前列候选、取消过期查询并限制并发，复杂正则先验证完整行再截短展示。

- 备忘录拖动和缩放按画面帧合并更新，松手后保存位置；缓存每条笔记的标题、摘要和颜色，避免拖动时反复扫描全部正文。

- Git 视图重排：变更与提交文件改为单行紧凑行，直接显示目录和增删行数，去掉差异上方重复的文件路径栏；历史按版本分组（识别版本标签和“release / prepare vX.Y.Z”类发布提交），点版本即显示仓库 CHANGELOG.md 中该版本的更新内容，待发布分组标注下一版本号；查看提交时分为提交列表、提交说明与文件、差异三栏，并显示提交正文。差异只显示改动附近的上下文，未改动的大段代码可点击展开。

- 顶部设置入口移到最上方工具栏；布局和对话图入口改为带图标的文字按钮；资源管理器标题栏收紧间距并完整显示标题。

- 资源管理器标题栏中“返回顶部”与“收起所有文件夹”按钮互换位置。

- YAML/MD 键值面板按当前最长键名自适应宽度，不再固定占满预览区域；备忘录的“复制路径”与“导入对话框”按钮互换位置。

- 顶部预览工具栏新增带图标的“设置”文字按钮；隐藏侧边活动栏后仍可从顶部进入设置。

- 统一系统、全局、项目的来源含义：分别指 SuperHigh 源码自带、用户全局注册、用户在当前工作区注册。来源标识和分类按钮提供一致说明；SuperHigh 源码目录同样视为工作区。

- 左上角品牌标识改为应用图标；模式按钮明确显示“聊天模式”和“工作模式”。聊天模式支持全部已集成 Agent CLI，并读取 Kimi、Grok、Gemini、OpenCode 和 CodeBuddy 的原生对话。

- 手机输入框默认单行，并随内容自动增高；压缩操作栏、按键栏和底部留白，限制菜单高度，为终端保留更多显示空间。

- 聊天模式响应更快：发送后立即显示消息，任务进行中更频繁地刷新回复；内容未变化时不再重绘，查看历史时不被拉回底部，加载会话时不闪现欢迎页，原生面板不再反复切换；完整读取命令列表后，再次输入 `/` 不会重复向 CLI 发送方向键。

### 问题修复

- 修复保存期间继续输入被错误标为已保存、并发保存覆盖顺序、较慢旧打开请求抢回焦点及重复标签；修复清空文件搜索后旧定时器重新发起查询。
- 修复项目正则查找分支和字符类漏报、文件过滤在候选截断后执行导致漏报；文件监听出错、失步或路径超限后重新校验已加载目录与打开文件，避免静默丢失刷新。
- 修复 Claude Code 迁移至原生安装后无法启动的问题：自动识别用户目录下的 `.local/bin`，即使 SuperHigh 尚未继承更新后的 PATH 也能发现并启动；安装来源显示为“原生安装目录”。

- 修复从 Agent 会话重启 SuperHigh 后，新开的 CLI 继承旧模型与会话环境的问题：内嵌终端和外部 CMD 统一清理 Claude 模型选择、子 Agent 模型、Codex 线程及 Gemini 模型变量，保留认证、代理和配置目录。

- 修复打开 Super High 或图片查看器时自动显示小管家的问题；启动时保持隐藏，设置中的“` 唤起时默认展开面板”仅在手动按反引号键唤起时生效。

- 修复内置 Codex 在插件列表或会话历史的单个 WebSocket 帧超过 16 MiB 时反复断线、重连后提示会话不可用并暂停输入的问题；转发和历史读取允许在原有 64 MiB 消息上限内接收完整单帧。

- 修复 HTML 预览点击页内锚点误开 `tauri.localhost`、本地资源加载失败及复核页空白：锚点在页内滚动，相对文件链接在应用内打开，补齐本地脚本、样式、JSON、工作区图片和隔离的页面存储。
- 修复 CLI 中文在 PTY 分段读取时损坏，以及输出积压时丢失 ANSI 更新造成的残字、刷新错位；保留跨段 UTF-8 字节并在积压时重新同步终端画面。
- 修复多终端对话模式固定 3×3 网格导致终端只占部分区域、下方与右侧大片留空的问题；改为按会话数量和面板尺寸自动选择行列，末行不满时拉伸铺满宽度，过多时纵向滚动。
- 修复 Minecraft 客户端退出后启动脚本停在“按任意键继续”、旧日志标签阻止重新启动的问题；按本次启动的客户端进程退出收起控制台，启动与重启只保留当前日志标签。
- 终端与聊天回答支持带工作区目录名前缀和末尾分隔符的路径；聊天回答及管家通知正文与行内代码中的现存文件、图片和目录可点击跳转，保留 Windows 路径中的反斜杠。
- 修复切换 CLI 标签或长时间运行后，Codex 历史出现残字叠印（如 `Ran` 显示成 `Ra保`）和行错位：回放终端历史时按当时的终端尺寸依次还原，再恢复为当前面板尺寸。
- 修复中文系统下编辑器和差异预览把全角 `，（）：` 等中文标点加框高亮的问题。

- 修复备忘录 Markdown 行内代码中的本地文件路径无法点击，支持中文和空格路径；补全拖动取消、窗口失焦与指针捕获处理。

- 修复隐藏侧边活动栏后 Git 视图左侧空出一列；切换文件不再重建差异编辑器，读取较快时不再闪烁“正在读取”，提交文件差异的 git 进程从约 8 个减到 1 个，离开再返回 Git 视图时保留已读取的内容。

- 修复工作区 `.superhigh/skills` 被归为全局的问题，统一归为项目 Skills。

- 修复聊天模式选择 Default 后模型显示延迟，以及旧日志覆盖当前模型和推理强度；模型菜单关闭时保留已确认的选择，及时同步 CLI 当前状态。

- 聊天模式从 CLI 当前状态栏和最新模型切换结果同步真实模型，避免显示默认项或保留旧模型。模型菜单按实际终端重绘连续处理点击与方向键，点击控件后仍可使用上下键。

- 输入 `/` 后自动采集当前 Agent CLI 的完整原生命令列表，无需手动滚动终端；采集结果按会话隔离，并在输入变化或切换会话时停止。

- 修复聊天模式与工作终端重叠：聊天面板使用不透明背景，权限快捷键不再误触发原生面板；进入 Codex 时读取实际模型，选择推理强度后保留模型名称。

- 修复 Agent CLI 命令描述换行后列表丢项；聊天与工作输入同步真实命令补全，并按顺序提交；原生设置、状态等面板可直接操作，空白会话的补全列表保持可见。发送失败保留草稿并显示错误；未确认接收时停止等待，CLI 错误或返回空闲后结束思考状态。

- Agent CLI 终端即时跟随字体风格、等宽字体映射和字体资源变化；等待字体加载后重新计算尺寸，避免旧字体、错位及快速切换覆盖新设置。

- 修复聊天回答泄漏 ANSI 控制字符、模型按钮未同步当前模型和模型菜单误判；聊天与工作模式共用草稿、Super High 指令、Skills、提示词历史及图片附件，输入 `/` 同时显示 Agent CLI 原生命令。

- 安卓进入或返回应用时隐藏顶部状态栏，释放白色占位区域；安全区使用 Capacitor 提供的实际边距，避免重复预留底部空间。

---

### New Features

- Code preview now includes built-in PowerPoint `.pptx` viewing with navigation, page jumps, zoom, expanded reading, and common animation playback, without Office, WPS, or LibreOffice. Appear, fade, fly, wipe, zoom, spin, and basic motion paths follow authored click/with/after timing, with pause, resume, step, and replay controls plus fade, push, and wipe transitions. Unsupported legacy binary `.ppt`, text builds, and complex triggers show explicit notices.
- Added `examples/PowerPoint预览与动画验收.pptx`, a nine-slide deck covering Chinese text, four entrance effects, with/after timing, emphasis, motion paths, exits, images, charts, and transitions. Regenerate it with `node scripts/create-presentation-preview-demo.mjs`.
- Code preview now supports legacy Excel `.xls` workbooks with the same read-only tables, sheet switching, merged cells, and pagination as `.xlsx` files.
- Terminal settings now show the actual paths and existence of Codex's global `AGENTS.md` and Claude Code's global `CLAUDE.md`, expanded inline with Markdown rendering by default. Click the content to edit it directly; changes save automatically with no save button or shortcut. Each file keeps only a render switch and a button to open it in the code preview. Custom `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected.
- CLI file links now support environment variable prefixes such as `$env:USERPROFILE/...`, `${env:USERPROFILE}/...`, and `%USERPROFILE%/...`, resolved locally and checked for an existing file or directory before activation.

- Added SuperHigh agent orchestration through `superhigh-cli agent sessions/tasks` and the stdio `mcp serve` entry. External and embedded Codex / Claude Code clients share desktop-owned sessions and tasks, with native completion evidence, answer pagination, bounded waits, interruption requests, retry deduplication, busy-session checks, and self/ancestor cycle prevention. Nine MCP tools expose the same operations; disconnecting does not cancel tasks.

- The code preview renders SuperHigh UI (`.shui`) files: an Agent describes an interface with one component statement per line, and the file renders as components sized for the narrow panel, including cards, stats, tables, charts, steps, forms, choices and sortable lists. The view refreshes while the file is being written, shows placeholders for parts not written yet and lists syntax problems in a status bar. Components can be dragged to reorder, which writes the change back to the source, or dropped on the CLI panel to insert their source as a reference. Button clicks, form submissions and field values are saved to a sibling `.shui.state.json` for the Agent to read. Tables support search, per-column dropdown filters and pagination; `Bind` lets fields such as dropdowns and choices drive stats, charts, tables and panel switching directly; `Data` reads data from a sibling JSON/JSONL file and refreshes when the file changes; bar charts can be stacked or percent-stacked, and series beyond four are merged into "Other".
- Added `superhigh-cli files open <path>`: opens a file of the current workspace in the desktop code preview and switches `.shui` and `.html` files to preview, so an Agent can show a generated interface right away.
- Pasting more than 500 characters into the built-in CLI input now exports the text to the workspace `.agent/tmp` as a file named with a Chinese-unit timestamp (e.g. `SH粘贴-2026年10月21日14时05分33秒.txt`) and shows it as a file card; sending passes the file path to the Agent CLI. Type `@` to reference any `SH粘贴-` marked file in `.agent/tmp`.
- Memos add an "Export file" button to the right of "Import to dialog": save directly in the current project workspace root using the memo title, without choosing a location. The body is saved as Markdown with image attachments appended as image links to their absolute paths; full HTML memos export as `.html`.

- Settings adds a "Usage" page modeled on ZCode's usage statistics: a lifetime summary strip (total tokens, peak day, longest session, current and longest streak), a 52-week token activity heatmap (daily / weekly / cumulative), and per-model daily trends plus a model share chart for the last 7 or 30 days. Data is read only from cc-switch request logs and daily rollups, using cc-switch's own rules for cache-inclusive input normalization and session/proxy de-duplication; the cc-switch database is never written.
- Add a Git view: the Git button at the left end of the top mode strip opens the current workspace's changes and commit history, with a read-only diff preview on the right. It shows branch and ahead/behind state, supports refresh and paged history, and never modifies the repository.
- Add an Account section in Settings with GitHub support: it reads the current account through the GitHub CLI and completes browser authorization in a local terminal; SuperHigh never reads or stores the GitHub token.
- Add a Replay tab to the Git view that plays commits back as typing animations through gitlogue. The left list shows the current project and every repository of the signed-in GitHub account; selecting one starts playback. Other repositories are cloned once into the app data `git-replay` cache without checking out files and only fetched incrementally afterwards. Playback order, typing speed, and an only-my-commits filter are available, and lock files are skipped. Requires gitlogue (`cargo install gitlogue --locked`).
- The “Find” and “Replace” entries in the top Search menu now open a standalone desktop-style dialog with Find, Replace, Find in Files, Find in Projects, and Mark tabs. It supports normal, extended, and regular-expression modes, whole-word and case matching, backward and wrap-around search, replacement within a selection, replacing across open files, result-list navigation, adjustable transparency, and a draggable window.

- Add an Explorer “back to top” button and an Appearance switch for hiding the activity bar. After importing file content into a memo, show an actionable tip that can move the source file to the system Recycle Bin; render complete HTML memos as pages in preview mode.

- Add SuperHigh Vibe, a theme tailored for vibecoding and listed in its own SuperHigh category in the Settings theme menu. It brings a dedicated launch sequence: a hyperspace warp, energy gathering into the core and an impact freeze-frame, then shockwaves, sparks, and electric arcs as the mark slams in with chromatic ghosts. The title decodes letter by letter, and a charge bar scans while data loads and fills once ready. A portal then opens from the core to reveal the workspace. After the impact you can click to enter early, and the system reduced-motion setting shows a still frame instead. Other themes keep the original splash. In the interface it uses indigo glass panels over a slowly drifting aurora that pauses when the window loses focus. While an Agent CLI streams output, a flowing gradient line tops the terminal and the active session icon breathes, settling once output stops. The activity bar, tabs, workspace tabs, and conversation cards share gradient indicators; focused composers get a gradient ring, and send and confirm buttons use a gradient fill. Menus, completions, and dialogs get frosted surfaces with short entrance motion, honoring the system reduced-motion setting. Other themes look unchanged.

- Organize editors into System, Global, and Project tiers. Global editors are registered in `editor/editor.json` under the app data directory, while project editors keep their existing location. Press F4 to open the editor picker with search, source filters, and recent editors; the new Editors settings page lists and opens all three tiers.

- Add a search box to the YAML/MD key-value panel for quick filtering. Add a “YAML key-value RGBA title colors” switch to Appearance; when enabled, each key in the panel gets a stable color from the RGBA title palette, while editor text keeps its normal key/value colors.

- Replace the Appearance “Markdown heading colors” section with an “RGBA title colors” switch: when on, rendered Markdown headings use the same RGBA title palette as YAML keys, keyed by heading text so identical titles share a color; when off, they fall back to theme text colors. The setting persists across restarts.

- Add the built-in "Skill Overview" system editor: it totals project and global skills with their descriptions and bodies, and estimates the description tokens preloaded in every session and the body tokens loaded on invocation. Skill discovery now also scans `.agent`, `.cursor`, `.codebuddy`, `.kimi`, and `.opencode` directories.

- Run project services and Minecraft clients in independent consoles. Keep launch and restart buttons with read-only log monitoring; processes survive app exits and updates, native consoles reappear, and reopening the workspace reconnects monitoring.

- Add child-agent work views to Codex chat: show each task's live status, model, and elapsed time; expand streamed messages, command output, tool calls, and file changes, and restore existing child-thread history.

- Add a Chat / Work switch above the CLI area. Chat mode shows Claude Code and Codex sessions as a conversation: tool calls fold into thinking steps, and final answers use the assistant-notice style with work time and completion time. The model button and `/` input use the CLI's real `/model` menu and command list. Work mode keeps the original terminal.

- Add "Skill Script Usage" to the Plugins settings page. It reuses the Usage page layout (summary strip, 52-week activity heatmap, 7/30-day daily call trend and share) and lists every script of the project and global skills, including never-called ones, with call count, last use, source, and staleness hints (missing, not mentioned in docs, referenced by another script of the same skill). Only scripts under `scripts/` of a skill directory (one containing `SKILL.md`) are counted; ordinary project scripts and `.agent/tmp` are excluded, and calls through `.agents`, `.claude`, `.codex` and other skill symlinks merge into one script. Counts are collected incrementally from Claude Code and Codex native session logs, covering conversations inside and outside SuperHigh, and script tool panel runs are counted directly; counts persist in the app data directory after the CLIs prune old session logs.
- Add `superhigh-cli skills usage` so agents can query skill script call counts, with `--skill`, `--unused`, `--idle-days`, `--all`, `--daily`, and `--json`, to find stale skill scripts.

### Improvements

- Virtualize file-manager tiles and load thumbnails only around the viewport with bounded concurrency and cache size; reuse directory sort keys and one filename-search debounce to reduce large-directory rendering and input delays.
- Retain a separate editor model, undo history and view state per file, release closed models and evict inactive models under a memory budget; disable costly suggestions and folding for large buffers and skip full YAML syntax analysis for very large documents. Project content search uses bounded parallel scanning and incremental results, applying file filters and complete matching before its result limit.
- Avoid redefining the global theme or synchronizing the same model repeatedly when switching editor tabs. The YAML key panel scans only root keys and reuses per-file versioned results instead of rebuilding the complete nested navigation index.
- Removed per-conversation file-change panels, line counts, diff history, and related CLI APIs. Agent sessions no longer capture file baselines or scan workspaces for changes; session identity, chat history, task completion, and plan notifications remain independent.

- Require an `AGENTS.md`, `CLAUDE.md`, or local Agent Skill in the exact workspace before automatically adding default `.superhigh` registries, templates, and cache directories. Opening a drive root or ordinary folder no longer repeatedly generates project artifacts; existing configuration remains readable.

- Removed the CLI input spacing cleanup and Codex prompt enhancement buttons, including undo, status messages, offline resource downloads, and dedicated CLI/backend code.

- Improve large-data handling: memos load up to 80 summaries per page and fetch the selected body on demand, with cross-page restoration and full-body search. File trees and directory search render visible rows while preserving scroll anchors, selection and keyboard navigation.
- Show the latest 40 chat turns first and load older history on demand. Transfer changed turns by revision, reuse Markdown results, and pause ordinary polling while hidden without interrupting send confirmation.
- Move YAML syntax checks to a background Worker, delay large-document checks until typing pauses, and terminate obsolete work. Opening and editing no longer wait for full syntax parsing; saving uses current content, while color and key decorations update only the visible range.
- Maintain file-search entries by path. Ordinary writes update only indexed file timestamps; repeated writes to ignored files no longer trigger scans. Keep creates, deletes, renames and ignore-rule changes current, retain only top candidates, cancel superseded searches, bound concurrency, and validate complex regexes against full lines before clipping previews.

- Coalesce memo dragging and resizing per animation frame and save geometry on release. Cache each note's title, summary and color instead of rescanning all note bodies while dragging.

- Git view relayout: changed files and commit files use compact single-line rows with their folder and added/removed line counts, and the duplicate file path bar above the diff is gone. History is grouped by version (version tags and "release / prepare vX.Y.Z" commits); clicking a version shows that version's section from the repository CHANGELOG.md, and the pending group is labeled with the next version. Viewing a commit uses three columns (commit list, message and files, diff) and shows the full commit body. Diffs show only the context around changes, with unchanged regions expandable.

- Move Settings to the top toolbar, convert layout and conversation-map controls to icon-and-label buttons, and tighten the Explorer header so its title stays visible.

- Swap the Explorer header positions of the Scroll to Top and Collapse All buttons.

- Size the YAML/MD key panel to fit the longest visible key instead of occupying the preview width, and swap the memo Copy Path and Import to Chat buttons.

- Add an icon-and-label Settings button to the top preview toolbar so settings remain reachable after hiding the activity bar.

- Unify source meanings: System ships with SuperHigh source, Global is registered by the user across workspaces, and Project is registered in the current workspace. Share explanations across source badges and filters, and treat the SuperHigh source folder as a workspace too.

- Use the application icon in the top-left corner and label the mode buttons “聊天模式” and “工作模式”. Enable Chat for every integrated Agent CLI, reading native conversations from Kimi, Grok, Gemini, OpenCode, and CodeBuddy.

- Start the mobile composer at one line and grow it with its content. Compact the action and key bars, reduce bottom spacing, and bound menu height to preserve terminal space.

- Make Chat more responsive: show sent messages immediately and refresh replies more often while a turn runs. Skip redraws when nothing changed, keep the scroll position while reading history, avoid flashing the welcome page while loading, and stop native panels from toggling repeatedly. After the command list is fully read, typing `/` again no longer sends arrow keys to the CLI.

### Bug Fixes

- Fix edits made during a save being marked as saved, overlapping write ordering, stale file-open requests stealing focus and duplicate tabs; prevent cleared file searches from being revived by an older timer.
- Fix missing project regex matches for alternations and character classes and matches lost when file filters ran after candidate truncation. Recover from file-watcher errors, lost events and path overflow by revalidating loaded directories and open files.
- Fixed Claude Code failing to launch after migration to the native installer. SuperHigh now discovers `.local/bin` under the user profile even before inheriting an updated PATH, and identifies it as a native installation directory.

- Fixed new CLI sessions inheriting stale model and session variables after SuperHigh was relaunched by an agent. Embedded terminals and external CMD now share cleanup for Claude model selection, subagent models, Codex thread markers, and Gemini models while preserving authentication, proxies, and configuration directories.

- Fixed the butler appearing automatically when opening Super High or its image viewer. It now starts hidden; the default expansion setting applies only when manually summoned with the backtick key.

- Fixed embedded Codex repeatedly disconnecting and pausing input as unavailable when a plugin inventory or thread history arrived in a WebSocket frame larger than 16 MiB. Forwarding and history readers now accept single frames within the existing 64 MiB message limit.

- Fix HTML previews opening `tauri.localhost` for fragment links, failing to load local resources, or showing blank review pages. Scroll fragments in place, open relative file links inside the app, and support local scripts, styles, JSON, workspace images, and isolated page storage.
- Fix corrupted Chinese characters across PTY read boundaries and stale glyphs or misplaced refreshes caused by dropped ANSI updates. Preserve incomplete UTF-8 bytes and resynchronize the terminal when output backs up.
- Fix multi-terminal mode leaving large empty areas because of a fixed 3×3 grid; rows and columns now adapt to the session count and panel size, an incomplete last row stretches to full width, and many sessions scroll vertically.
- Fix Minecraft client restarts blocked by stale log tabs and launcher scripts paused after exit; close the owned console when its client processes exit and retain only the current monitor tab.
- Resolve workspace-prefixed paths and trailing directory separators in terminal output; link existing files, images, and folders in chat and completion notices, including prose and inline code while preserving Windows backslashes.
- Fix overlapping leftover glyphs (such as `Ran` shown as `Ra保`) and misplaced lines in Codex history after switching CLI tabs or long sessions: terminal history now replays at the sizes it was produced with, then fits back to the current pane.
- Fix the editor and diff preview boxing full-width Chinese punctuation such as `，（）：` as ambiguous characters on Chinese systems.

- Fix local file links inside memo Markdown inline code, including paths with Chinese characters and spaces; handle pointer cancellation, window blur and pointer capture during dragging.

- Fixed an empty column on the left of the Git view when the activity bar is hidden. Switching files no longer recreates the diff editor or flashes "loading" on fast reads, commit file diffs spawn 1 git process instead of about 8, and leaving and returning to the Git view keeps what was already loaded.

- Classify workspace `.superhigh/skills` as Project rather than Global.

- Fix delayed model labels after choosing Default in Chat and prevent old logs from overwriting the current model and reasoning effort. Preserve confirmed selections while the picker closes and follow the CLI's current state.

- Sync Chat's model from the CLI's current status line and latest model change, avoiding default aliases and stale selections. Process model-menu clicks and arrow keys after native redraws, and keep Up/Down working after clicking controls.

- Collect the current Agent CLI's complete native slash-command list automatically, without manual terminal scrolling. Keep results scoped to each session and stop collection when input or the active session changes.

- Prevent Chat and Work terminal overlap with an opaque chat surface and correct permission-footer detection. Read the actual Codex model on entry and keep its name when changing reasoning effort.

- Preserve wrapped Agent CLI command descriptions and mirror native slash completion in Chat and Work. Keep native settings and status panels interactive and prevent empty-chat completion from hiding behind the toolbar. Serialize submission, keep drafts on send failure, report unacknowledged messages, and stop thinking when the CLI reports an error or returns idle.

- Update Agent CLI terminals when font styles, monospace mappings, or font assets change. Wait for fonts before measuring cells, and prevent stale loads from overriding newer settings.

- Remove ANSI control sequences from chat answers, keep the model button in sync, and detect model menus with themed backgrounds. Share drafts, Super High commands, Skills, prompt history, and image attachments between Chat and Work; include native Agent CLI commands in the `/` menu.

- Hide the Android status bar when opening or resuming the app to reclaim its white reserved area. Use Capacitor safe-area insets and avoid duplicate bottom padding.

## [0.1.39] - 2026-10-16

### 新增功能

- CLI 输入框中的图片附件支持点击缩略图或文件名，在 SuperHigh 内置图片查看器中预览。

- 输入框支持全局与项目指令注册；打开项目自动补建 `.superhigh/commands.json`，系统自带 `/prompt` 单独归类。

- 文件资源管理器右键文件支持将正文导入备忘录，默认在“全部”中显示。备忘录新增“复制路径”，仅提供分类、稳定 ID 和 CLI 读取、编辑命令，不包含标题或正文。

- 手机端自动识别 CLI 的编号选择菜单（如模型选择、权限确认），在输入框上方显示可点选的选项列表，点按选项或终端中的选项行即可选中并确认，多选列表只移动到该项。

### 体验优化

- `.bbmodel` 文件统一使用 Blockbench 图标，内置编辑器的模型文件大小上限提高至 256 MB。

- `.jar` 文件使用 Java 图标；顶部搜索结果、正文匹配和已打开文件统一显示对应文件类型图标。

- 产品图标统一为暖色四闪电像素图，移除旧图标和安卓默认启动图；桌面启动时旋入定格并显示暖色闪光，支持减少动态效果。

- 指令菜单与已选 Skills 使用 Codex 标题稳定配色；顶部分类栏支持点击与左右箭头循环切换，移除旧分组标题。右键预览文件保留菜单，备忘录三个文字按钮始终显示边框。

- 备忘录创建时间居中，标题和摘要列表加宽 15px；正文操作改为“复制正文”和“导入对话框”文字按钮。

- 手机端按键栏新增 ←、→、空格和 Tab，方向键支持长按连发，可通过输入框的键盘按钮随时打开；按键不再唤起手机输入法。

### 问题修复

- 修复工作区外已打开图片和文件覆盖后预览不刷新的问题；自动监听文件所在目录，关闭标签后释放监听。

- 修复 Skills 文件更新后 `/` 菜单仍显示旧信息的问题；重新打开、返回窗口及菜单保持打开时自动刷新，并保留筛选和选中项。

- 修复项目与全局 Skills 的分享链接路径：右键预览打开真实源文件，文内相对链接从真实目录解析。

- 插件后台命令静默启动 PowerShell，避免模型预览等插件启动时弹出命令窗口。

- 修复代码预览和 CLI 对话区域分隔条偶发在松开鼠标后继续跟随的问题；跨预览页面、窗口失焦或指针取消时结束调整。

- 修复 Claude Code 在任务中进入子目录后，管家通知显示“未读取到最终回答”且缺少标题的问题。

- 修复长时间运行的 Codex 切换标签后滚轮与点击失效、上滚后无法回到底部的问题；回放历史时恢复鼠标上报等输入模式，输入框为空时按 Esc 交给 Codex 回到最新内容。

---

### New Features

- Click an image attachment thumbnail or filename in the CLI input box to preview it in SuperHigh's built-in image viewer.

- Register global and project commands for the input box. Opening a project creates missing `.superhigh/commands.json`; the built-in `/prompt` belongs to System.

- The file explorer can import file contents into memos from its context menu, showing the new memo under All. Copy Path includes only the category, stable ID, and CLI read and edit commands, excluding titles and content.

- The mobile view detects numbered CLI menus such as model pickers and permission prompts and lists their options above the input box. Tapping an option, or its row in the terminal, selects and confirms it; checkbox lists only move to the option.

### Improvements

- Use the Blockbench icon for `.bbmodel` files and increase the built-in editor model file limit to 256 MB.

- Use the Java icon for `.jar` files and show the matching file type icon in top-bar search results, text matches, and open files.

- Replace the product icon with warm pixel lightning and remove the old icon and default Android splash artwork. Desktop startup spins the mark into place with a warm flash and respects reduced motion.

- Commands and selected Skills use stable Codex title colors. The top category bar supports clicks and wrapping left/right arrow navigation, replacing group headings. File previews keep the menu open, and all three memo text buttons show borders.

- Memo creation times are centered and the title and description list is 15px wider. Content actions use Copy Content and Import to Chat text buttons.

- The mobile key bar adds Left, Right, Space, and Tab, repeats arrow keys while held, and opens anytime from the keyboard button by the input box. Key presses no longer raise the phone keyboard.

### Bug Fixes

- Refresh previews when open images or files outside the workspace are overwritten; watch their parent directories and release watches after tabs close.

- Refresh the `/` menu after Skills change, when reopened, when returning to the window, and while it stays open, preserving the current filter and selection.

- Resolve shared links for project and global Skills to their source files, keeping right-click previews and relative Markdown links anchored to the source directory.

- Start plugin PowerShell commands without a console window, including model preview startup.

- Fix code preview and CLI panel dividers occasionally following the mouse after release. Resizing ends across preview frames, window focus loss, and pointer cancellation.

- Fix Butler notices showing "final answer not found" without a title after Claude Code changed into a subdirectory during a task.

- Fix long-running Codex sessions losing wheel and click input after switching tabs, leaving a scrolled-up transcript unable to return to the bottom. History replay restores mouse reporting and other input modes, and Esc in an empty input box is sent to Codex to jump to the latest output.

## [0.1.38] - 2026-10-15

### 新增功能

- SuperHigh 管家支持 Claude Code Plan 模式：`AskUserQuestion` 提问（含多选）和 `ExitPlanMode` 计划审批会弹出通知，可直接选择、补充说明后回复；与终端原生对话框同时可用，先回答的一方生效。
- 手机端可收到电脑上 CLI 回答完成和 Plan 提问的提醒；安卓 App 在后台时以系统消息通知显示，前台和浏览器显示顶部横幅。

### 体验优化

- 管家完成通知显示本轮工作时长，Codex、Claude 使用原生耗时，其他 CLI 按本轮提问到完成计算。
- 手机端 CLI 渲染铺满整行的分隔线和右对齐状态栏时收窄填充而不再折成多行；横屏按可用宽度使用更多列，不再固定 80 列。

- 删除无用的 `superhigh-theme` 项目技能及其配套脚本。

- 确认对话框统一为左确认、右取消。备忘录分类编辑保持名称居中，与未编辑时的位置、字号和行高一致。

- 修复备忘录分类改名时输入框被按钮挤窄的问题；名称独占一行，保存和取消并排显示。普通控件统一使用主题色键盘焦点，消除浏览器原生黑框。

- 备忘录分类支持在侧栏重命名，同步迁移所属笔记并保留当前选择。文件标签展开列表贴合分割线，悬停临时预览、点击切换；与顶部标签共用组件和分割边框。

- 备忘录重新打开时恢复上次分类和笔记；默认标题使用正文第一行，摘要从第二行开始，旧时间戳标题自动恢复为正文标题。标题使用 Codex CLI `/resume` 的 14 色配色与固定 ID 分配规则，改名和重开后保持同色。

---

### New Features

- SuperHigh butler now supports Claude Code plan mode: `AskUserQuestion` prompts (including multi-select) and `ExitPlanMode` plan approval appear as notices that can be answered with a choice and notes. The native terminal dialog stays available, and whichever answers first applies.
- The phone receives desktop CLI completion and plan-question alerts. The Android app shows system notifications while in the background; the foreground app and browser show a top banner.

### Improvements

- Butler completion notices show how long the turn worked. Codex and Claude use their native durations; other CLIs measure from the prompt to completion.
- Mobile CLI rendering narrows padding in full-width separators and right-aligned status lines instead of wrapping them; landscape uses all available columns instead of a fixed 80.

- Removed the unused `superhigh-theme` project skill and its companion scripts.

- Confirmation dialogs place Confirm on the left and Cancel on the right. Memo category editing preserves the centered name position, font size, and line height used in the normal state.

- Memo category renaming now gives the name field its own full-width row, with Save and Cancel side by side below it. Standard controls use theme-colored keyboard focus instead of native black outlines.

- Memo categories can be renamed in the sidebar, moving their notes while preserving the current selection. The open-file list meets the pane divider, previews files on hover, and commits selection on click. It shares its tab component and separators with the editor tab strip.

- Memos restore the last category and note when reopened. Default titles use the first content line, with descriptions starting on the second line. Legacy timestamp titles return to automatic content titles. Titles use the Codex CLI `/resume` 14-color palette and stable ID assignment, preserving colors across renames and reopening.

## [0.1.37] - 2026-10-15

### 新增功能

- 脚本工具支持全局注册表，与项目工具按 ID 合并，项目优先；工具箱显示来源，CLI 可按 scope 查询与运行。

- SuperHigh 管家支持 Codex CLI Plan 问题通知，按 Markdown 显示问题，可直接选择选项、补充回答并回复对应会话；问题在原终端回答或失效后自动停用。

- 资源管理器支持 Ctrl 多选、Shift 连选和 Ctrl+A 全选可见项；文件与文件夹可混选，右键批量删除、复制相对路径或完整路径，每个路径独占一行。
- 工作区自动准备 `.superhigh/cache`，供项目工具保存可重建的派生缓存；历史工作区检查单独报告缓存位置，跳过缓存正文。
- 代码预览右下角新增当前轮变更摘要、文件列表与完整差异阅读，支持增删片段定位。Codex 合并原版终端的原生净差和命令文件变更；Claude 捕获 Edit/Write 提交和 Bash 文件变更。

- SuperHigh 管家在各 Agent CLI 本轮对话完成后播放提示音，并在桌面左下角显示通知；历史会话恢复不重复提醒。
- 设置 → 配置新增默认滚动速度倍率；以各区域现有速度为 100%，每档 25%，最高 250%，保存并恢复上次选择。
- CLI 新增历史工作区与 `.superhigh` 状态查询，跳过图片和未登记模板；脚本工具支持接口契约与定向发现，项目编辑器可原生发现工具并调用 JSON 结果。

- 外观设置新增“外部 CMD 全屏启动”开关；外部启动 CLI 或移到外部继续对话时，可按保存的偏好最大化窗口。
- 顶部文件搜索支持默认、最近修改、最远修改和打开次数排序；排序单选并记住上次选择，文件打开次数按工作区持久记录。
- 外观设置支持关闭侧边对话列表；F1 可切换资源管理器，两者隐藏后仅保留代码预览与 CLI 主区域。
- 备忘录日期筛选新增近 7 天、近 14 天和近 30 天快捷选项，并保留自定义日期范围。
- 备忘录支持从剪贴板批量添加网页链接，自动获取网页标题并按独立行插入可点击链接；获取不到标题时保留原始 URL。
- CLI 背景支持用鼠标侧键循环切换所有 Agent CLI 会话。
- CLI 输入框的 `/` Skills 菜单支持连续选择多个 Skill，已选 Skill 以标签并列显示并可单独移除，发送时一并注入各自的 Skill 文件与目录。
- 备忘录全部操作接入 `superhigh-cli memo`，包括正文、分类、图片附件、网页链接、筛选、窗口、剪贴板和 CLI 草稿插入。
- Markdown 渲染模式内置 ANSI 代码块预览，支持真实 SGR 序列以及 `\\x1b`、`\\u001b`、`\\033` 写法，并跟随当前主题显示终端颜色。
- 备忘录预览模式按 Markdown 渲染标题、列表、引用、表格、代码块和图片；网页链接、本地路径链接与图片点击放大保持可用，原始 HTML 仍按文本显示。
- 设置 → 配置新增“全局 Skill 位置”，可选择 `/` 指令菜单中全局 Skill 排在项目 Skill 的上面或下面；SuperHigh 指令始终置顶。
- Markdown 六级标题分别使用红、黄、绿、青、蓝、紫六种不透明亮色，所有主题和手机端共用；设置 → 外观按实际字号、字重和颜色预览标题，不再附加 H1～H6，正在调整的设置行单独突出。可逐级选择颜色和不透明度并恢复默认，`superhigh-cli appearance headings` 可查询、修改或重置同一设置，应用运行时立即生效。

### 体验优化

- 脚本工具箱改为“全部 / 全局 / 项目”三个等宽来源按钮，点击卡片打开扩展界面，并按工作区记住上次脚本；来源标识与唤起指令共用样式组件。

- 备忘录列表在标题下显示两行正文摘要，适当加宽列表并增大默认窗口；创建时间使用白色，分类按钮文字增大并自适应换行，单行与多行文字块均在按钮内水平、垂直居中，选中色条不挤偏文字。

- MD 键值面板的标题继承对应渲染标题的颜色，移除 H1～H6 标记，保留层级缩进；悬停和聚焦时仍保持标题配色。
- 启用正式产品图标：深色玻璃底板上，一颗陶土橙至靛蓝渐变的四面晶体带顶点高光与柔和辉光；Windows 程序、任务栏与安卓启动图标同步更新。启动时播放约 1 秒的简洁入场动画：晶面依次亮起、晶体升起并闪出高光，工作区就绪后淡出；系统开启减少动态效果或以图片查看器启动时不播放。
- 代码预览变更视图的改动文件使用与代码预览一致的横向文件标签、类型图标、选中下划线和关闭按钮；支持横向滚动及方向键切换，保留上方文件数与增删行汇总。标签只切换对应文件的差异，点击差异正文保持在变更预览中。增删行使用明显的红绿底色并标出行号和 +/- 标记。
- 新增 SuperHigh 专属主题 SuperHigh Night（深色）与 SuperHigh Paper（浅色）：暖中性低眩光底色、约 10:1 的正文对比度、降饱和且亮度均衡的语法色，注释单独使用低调灰；表面保留轻微毛玻璃质感。切换主题时窗口毛玻璃的明暗随主题深浅切换，浅色半透明主题不再透出深色底。
- 文件搜索排除 `.superhigh/cache` 与 `.superhigh/log`，避免缓存和运行日志进入项目结果；项目缓存按工作区隔离，并纳入历史扩展兼容检查流程。
- 将变更显示移至代码预览区域，保留文件标签与未保存内容；删除 CLI 终端浮层及按会话启动快照统计变更的旧链路。
- 完整识别 PowerShell 写入路径时，只统计本轮目标文件，避免并行 Agent 的无关改动干扰。优化大工作区首次采集，并跳过浏览器运行缓存。

- 顶部搜索框贴合代码预览分割线，排序框贴合 CLI 区域起点，并跟随分栏拖动、左右布局及侧栏显隐调整。
- 管家对话提醒读取 Codex 已保存的正式标题，并以 CLI 产品图标和会话固定色条区分任务；通知只保留标题与最终回答，删除重复的请求、来源与状态行，窗口更紧凑，回答直接按 Markdown 滚动阅读。
- 移除内置物品搜索、DragonCore 工具及相关 Minecraft 插件专用代码；项目可通过 `.superhigh` 插件、脚本和 HTML 提供此功能。
- 备忘录打开和新增时默认进入编辑模式。
- 备忘录默认尺寸调整为 960×680，正文提高到 16px，放大列表与控件文字；标题独占一行，操作栏保持横排，收紧列表宽度并将保存状态移至底部。
- 备忘录改为三栏布局：左侧竖排分类并在底部新建分类，中间为标题、操作按钮与正文，右侧顶部放搜索、日期筛选和新增，下方为只显示标题的备忘录标签列表（无标题时以创建时间为标题）。
- Agent CLI 会话标签与侧边列表显示产品图标，并跟随 CLI 的实际终端标题更新；后台会话同步更新，未提供标题时显示产品名称，手动名称优先。
- 统一界面、正文、代码和移动端文字的字重参数；普通文字使用 500，强调文字使用 600，标题使用 700，并保留可切换的旧字重配置。
- Markdown 阅读区提高正文与标题字重，代码块继续使用等宽字重，改善 Anthropic Serif 观感偏细的问题。
- CLI `/` 指令菜单加大并固定高度：按 SuperHigh、项目、全局分组，分组标题使用三种固定颜色，指令名按名称使用独立彩色；每行显示一句描述摘要，右侧详情分条展示完整说明、Skill 位置和操作提示。

### 问题修复

- 修复手机端项目编辑器在 HTTP 或沙盒环境下因缺少 `crypto.randomUUID` 无法加载的问题；文件操作、脚本调用和代码绑定使用不依赖该接口的请求标识。

- 手机连接令牌刷新后立即保存并更新 Host 状态；手机选择历史工作区、打开文件及切换 HTML 预览与电脑双向同步，CLI 会话跟随正确工作区。手机 HTML 复用电脑当前预览及项目编辑器宿主。

- 桌面构建显式指定当前项目路径，避免项目内旧验收工作树被 Tauri 自动发现后误构建旧代码。

- 终端路径跳转兼容 Claude 工具标题中的省略路径（`…` / `...`），仅在本机文件唯一匹配时打开，并支持其差异行号定位。

- 修复项目编辑器 HTML 仅继承字体名称、未加载内置和导入字体资源的问题；编辑器与脚本扩展同步使用宿主字重，并修正新建模板及历史页面的字体覆盖。
- 修复资源管理器中已展开的 `.superhigh/log`、`logs`、`build` 等默认忽略目录内文件被外部改名、删除或新增后，文件树和已打开标签仍显示旧文件、打开时报“系统找不到指定的文件”的问题；现在这些目录在展开或有打开标签时同样实时刷新，未展开时仍忽略以免频繁刷新。
- 修复服务端退出后停在“请按任意键继续”的旧控制台不会被清理、再次启动时不断累积标签和进程的问题；现在启动或重启服务端会先关闭本项目遗留的旧控制台，只保留新唤起的一个。
- 修复 `superhigh-cli terminal list` 在 Super High 未运行时报 `bridge_unavailable` 查询失败；现在直接返回空会话列表并注明应用未运行，其他终端与服务命令返回 `app_not_running`。
- 修复长时间运行的 CLI 对话来回切换后显示错乱：左上角残留 `6h`、`;202m` 等转义碎片，界面空白或底部输入区、状态栏错位。超出历史保留量的会话回放时从完整片段开始，并自动让 CLI 整屏重绘，无需再手动输入 `/` 恢复。
- 修复点击管家完成通知中的文件链接时，通知小窗把整个 Super High 界面加载进自身、看似被缩到极小的问题；现在会唤回主窗口并在代码预览打开该文件（带行号时定位到对应行），网页链接交给系统浏览器。
- 修复首次在工作区唤起 Codex 时偶发 `failed to connect to remote app server ... (os error 10053)`：Codex 冷启动较慢、连接后延迟发送握手时，变更连接不再直接断开。
- 修复鼠标停在 `/` 指令菜单两项交界处时选中项来回闪烁的问题。

- 退出工作区或关闭 CLI 对话时静默结束相关进程，不再弹出一串命令行窗口。
- 修复切换 CLI 对话标签时的卡顿与黑块残影：所有 CLI 标签统一使用同一渲染器，不再在 Claude 与 Codex 之间装卸 WebGL；尺寸未变时不再重复调整 PTY，避免 CLI 整屏重绘。
- 修复内嵌 Codex 提交消息后长时间无响应的问题；文件基线改为后台准备和增量更新，变更分析不再阻塞 CLI 请求与回复。

- 项目编辑器绑定配置时保持页面可见，资源树切换和内容更新会回传当前配置，恢复历史页面的加载与编辑联动。

- 删除终端标签的磁盘保存、启动恢复和失效对话恢复逻辑。CLI、本地终端、服务端与客户端退出后立即销毁标签；重启创建新会话，后台工作区也不再残留已退出标签。

- 修复内嵌 Codex 打开或重复打开会话选择器时无法连接 app-server 的问题；各连接独立转发，请求编号互不干扰，保留当前轮文件变更采集。
- 修复 PowerShell、脚本和 Bash 写入文件时漏显示变更的问题；同轮撤销后净差归零，下一轮重新创建正常计入。
- 修复 Codex 0.162.1 隐藏标题线程覆盖主会话绑定，导致后续轮次漏收文件变更的问题。
- 修复变更行跳转等待资源树展开的问题，先显示目标文件和代码行。
- 修复文件标签列表按钮重复点击时始终展开的问题，恢复打开与关闭的连续切换。
- 修复工作区启动恢复期间项目编辑器 HTML 预览过早加载，导致脚本状态长期停留在“正在读取”的问题。
- 修复 `/` 补全菜单越过 CLI 分栏的问题，列表与说明按输入区宽度自适应，并可完整滚动。
- 删除 CLI 左右方向键切换对话的功能及相关代码，方向键继续交给终端。
- 修复 Markdown 原文与渲染模式切换时滚动位置跳回文件顶部的问题，切换后继续保持当前阅读进度。

---

### New Features

- Script tools now support a global registry merged with project tools by ID. Project entries take precedence; the toolbox shows origins and CLI commands support scope selection.

- The SuperHigh butler now renders Codex CLI Plan questions as Markdown and lets users choose options, add answers, and reply to the matching session. Questions become inactive when answered in the terminal or expired.

- Explorer supports Ctrl multi-selection, Shift range selection and Ctrl+A for visible entries, including mixed files and folders; delete the selection or copy relative/full paths from the context menu, one path per line.
- Prepare `.superhigh/cache` for rebuildable project-tool data; workspace inspection reports its location without reading cached payloads.
- Add current-turn change counts, a compact file list, and full diff viewing in the code preview, with addition/deletion navigation. Codex merges native turn diffs with command file changes; Claude captures Edit/Write commits and Bash file changes.

- SuperHigh Butler plays a sound and shows a notification at the desktop's lower left when an Agent CLI finishes a conversation turn, without replaying alerts for restored history.
- Add a saved default scroll speed multiplier in Settings → Configuration, from 100% of each area's existing speed to 250% in 25% steps.
- Add CLI workspace history and `.superhigh` inspection that skips images and unregistered templates; expose script contracts and scoped discovery, with native editor tool discovery and JSON calls.

- Add an appearance switch to maximize external CMD windows when launching a CLI or continuing a conversation externally, using the saved preference.
- Add single-choice sorting to top file search by default order, newest or oldest modification, and most opens; remember the selected order and persist file open counts per workspace.
- Add an appearance switch for the conversation sidebar and F1 to toggle Explorer; hide both to keep the code preview and CLI main areas.
- Add memo date shortcuts for the last 7, 14, and 30 days while keeping custom date ranges.
- Add multiple webpage links from the clipboard to a memo, fetch their titles, and insert clickable links on separate lines; keep the original URL when a title cannot be fetched.
- Cycle through all Agent CLI sessions with mouse side buttons on the CLI background.
- The `/` Skills menu in the CLI input can select several Skills in a row; selected Skills appear as side-by-side chips that can be removed individually, and each Skill file and directory is injected when sending.
- Expose memo content, categories, image attachments, webpage links, filters, window controls, clipboard actions, and CLI draft insertion through `superhigh-cli memo`.
- Add ANSI code block previews to Markdown rendering, supporting real SGR sequences and `\\x1b`, `\\u001b`, and `\\033` notation with the active terminal theme colors.
- Memo preview mode now renders Markdown headings, lists, quotes, tables, code blocks and images; web links, local path links and click-to-zoom images keep working, and raw HTML still shows as text.
- Add a "Global Skill position" option under Settings → Config to place global skills above or below project skills in the `/` command menu; SuperHigh commands always stay on top.
- The six Markdown heading levels now use distinct opaque bright red, yellow, green, cyan, blue, and purple, shared by all themes and mobile rendering. Settings → Appearance previews the rendered size, weight and color without extra H1–H6 labels and highlights the row being edited. Each color and opacity can be customized or reset; `superhigh-cli appearance headings` reads, changes or resets the same setting and applies changes immediately while the app runs.

### Improvements

- The script toolbox now uses equal-width All / Global / Project filters, opens extensions on card selection, remembers each workspace's last script, and shares source badges with command completion.

- Memo entries show a two-line content summary below each title, with a wider list and larger default window. Creation timestamps use white; category buttons use larger wrapping text, center single-line and multiline text blocks on both axes, and keep the selection stripe from shifting the text.

- MD key-value panel headings inherit their rendered heading colors, remove H1–H6 labels, and keep outline indentation; hover and focus preserve the heading colors.
- New official product icon: a faceted crystal with a terracotta-to-indigo gradient, apex highlight and soft glow on a dark glass tile, applied to the Windows app, taskbar and Android launcher. Startup plays a brief ~1 second entrance animation where the facets light up and the crystal rises with a glint, then fades out once the workspace is ready; it is skipped when reduced motion is enabled or when launched as the image viewer.
- Changed files use the same horizontal tabs, type icons, active underline and close buttons as the code preview, with horizontal scrolling and arrow-key switching; keep the file and line totals above. Tabs only switch the selected diff, and clicking diff content keeps the change preview open. Added and removed rows use clear red/green backgrounds with line numbers and +/- markers.
- Add the SuperHigh signature themes SuperHigh Night (dark) and SuperHigh Paper (light): warm-neutral low-glare surfaces, about 10:1 body text contrast, desaturated syntax colors with balanced brightness, and a dedicated muted comment color; surfaces keep a light frosted-glass texture. The window's acrylic backdrop now follows the theme's light or dark mode, so translucent light themes no longer show a dark base.
- Exclude `.superhigh/cache` and `.superhigh/log` from file search to keep derived data and run logs out of project results; isolate caches by workspace and include existing extensions in compatibility checks.
- Move change viewing into the code preview while preserving file tabs and unsaved edits; remove the CLI overlay and session-start snapshot tracking.
- Limit PowerShell tracking to proven write targets to exclude unrelated changes from parallel agents. Improve initial capture in large workspaces and skip browser runtime data.

- Align the search input edge exactly with the code preview divider and the sort control with the CLI edge, including panel resizing, swapped layouts, and sidebar visibility.
- Butler conversation alerts reuse saved Codex titles and mark each task with its CLI product icon and a stable session color bar; they keep only the title and final answer, drop duplicate request, source and status lines, use a more compact window, and render the answer as scrollable Markdown.
- Remove built-in item search, DragonCore tools, and related Minecraft plugin-specific code; projects can provide this feature through `.superhigh` plugins, scripts, and HTML.
- Enter edit mode when opening or creating memos.
- Resize the default memo window to 960×680, increase body text to 16px, and enlarge list and control text; give the title its own row, keep actions horizontal, narrow the list, and move save status to the footer.
- Rearrange memos into three columns: vertical categories with category creation at the bottom on the left, title, actions and body in the middle, and search, date filter and New on top of a title-only memo tab list on the right (untitled memos use their creation time as the title).
- Show product icons in Agent CLI tabs and the conversation sidebar, and follow live terminal titles for active and background sessions; use product names until a title arrives and respect manual names.
- Normalize text weights across the UI, content, code, and mobile surfaces: regular text uses 500, emphasis uses 600, headings use 700, with the previous profile retained for rollback.
- Increase Markdown reading text and heading weights while keeping code blocks on the monospaced weight, compensating for the lighter visual density of Anthropic Serif.
- Enlarge the CLI `/` command menu with a fixed height: entries are grouped as SuperHigh, project and global with three fixed header colors, command names get their own per-name colors, each row shows a one-line description summary, and the detail pane lists the full description, skill location and actions.

### Bug Fixes

- Fixed mobile project editors failing to load over HTTP or inside sandboxed previews when `crypto.randomUUID` is unavailable; file operations, script calls, and code bindings now use request IDs independent of that API.

- Mobile token changes now persist immediately and update the running Host. Workspace selection, opened files, and HTML preview mode synchronize with the desktop; CLI sessions follow the correct workspace. Mobile HTML uses the current desktop preview and project editor host.

- Desktop builds now pin the current project paths so Tauri cannot accidentally build an older nested verification worktree.

- Terminal links now resolve abbreviated paths (`…` / `...`) in Claude tool headers only when a unique local target exists, including navigation from diff line numbers.

- Fixed project editor HTML inheriting font names without loading built-in or imported font resources. Editors and script extensions now use host font weights, with font overrides corrected in new templates and existing workspace pages.
- Fix the explorer and open tabs still showing stale files after external renames, deletions or additions inside expanded, normally ignored folders such as `.superhigh/log`, `logs` or `build`, which made opening them fail with "file not found"; these folders now refresh live while expanded or holding an open tab, and stay ignored otherwise to avoid constant refreshes.
- Fix old server consoles left at "Press any key to continue" after the server exits piling up as extra tabs and processes on every start; starting or restarting the server now closes the project's leftover consoles first and keeps only the new one.
- Fix `superhigh-cli terminal list` failing with `bridge_unavailable` when Super High is not running; it now returns an empty session list noting the app is not running, and other terminal and service commands report `app_not_running`.
- Fix long-running CLI conversations rendering incorrectly after switching tabs: stray escape fragments such as `6h` or `;202m` in the top-left corner, a blank screen, or a misplaced input area and status bar. Sessions whose output exceeds the kept history now replay from a complete fragment and ask the CLI to repaint the full screen, so typing `/` to recover is no longer needed.
- Fix clicking a file link in a Butler completion notice loading the whole Super High interface into the tiny notice window, which looked like the app had shrunk; the link now brings the main window back and opens the file in the code preview (jumping to the line when one is given), while web links open in the system browser.
- Fix the occasional `failed to connect to remote app server ... (os error 10053)` when Codex first starts in a workspace: the change-tracking connection no longer drops a cold-started Codex that sends its handshake late.
- Fix the selection flickering back and forth when the pointer rests on the boundary between two entries in the `/` command menu.

- Exiting a workspace or closing a CLI conversation now ends its processes silently instead of flashing a series of console windows.
- Fix stutter and black-block artifacts when switching CLI conversation tabs: all CLI tabs share one renderer instead of swapping WebGL between Claude and Codex, and re-reporting an unchanged size no longer resizes the PTY and forces a full CLI repaint.
- Fix long pauses after submitting messages in embedded Codex; prepare file baselines and update changed paths in the background, and keep change analysis off the CLI request and response path.

- Keep project editors visible when binding configuration files, and forward tree selections and content updates to restore loading and editing in existing pages.

- Remove terminal-tab persistence, startup restoration, and ended-session recovery. CLI, shell, server, and client exits now destroy their tabs immediately; restarts create fresh sessions without leaving dead tabs in background workspaces.

- Fix embedded Codex failing to connect to app-server when opening or reopening the session picker. Forward each connection independently and isolate request IDs while preserving current-turn file change capture.
- Detect file writes from PowerShell, scripts, and Bash; return to zero after same-turn reversals and count recreated files in the next turn.
- Keep Codex 0.162.1 hidden title threads from replacing the foreground conversation and dropping file changes in later turns.
- Open changed files and reveal their source lines without waiting for Explorer expansion.
- Restore repeated open/close toggling of the file tab list button instead of reopening it on every click.
- Wait for workspace restoration before loading project editor HTML previews, preventing script status from staying on “Reading…” after startup.
- Fit the `/` completion menu to the CLI input panel and keep its list and details scrollable.
- Remove left/right arrow conversation navigation and pass these keys through to the terminal.
- Preserve the current reading progress when switching between Markdown source and rendered modes instead of jumping to the top of the file.

## [0.1.36] - 2026-10-08

### 新增功能

- 备忘录支持自定义分类、按分类快速筛选，并可直接粘贴图片附件；图片保存为完整路径，预览中点击图片可放大查看。
- 外观设置新增 Tokyo Night Glass、Catppuccin Mocha Glass、Dracula Glass 和 Nord Frosted Glass 终端风格主题，悬停主题选项即可即时预览。
- 外观设置支持导入、导出和下载自定义主题模板；自定义主题保存在应用设置中，可同时作用于界面、Monaco 编辑器和终端。
- 外观设置内置“Anthropic 字体风格”，按界面、正文与标题、等宽内容分配三套字体；也可导入一套或多套字体并为缺失用途使用系统回退。
- 外观设置的主题预览改为显示完整调色板，包含背景、文字、强调色、终端颜色和玻璃表面透明度。
- Glass 主题现在会将主背景层应用为半透明 RGBA，并在 Windows Tauri 窗口启用 Acrylic 毛玻璃效果。
- 项目脚本工具支持将 PowerShell 7 指定为 `pwsh` 运行时。
- CLI 终端中 Claude Code 与 Codex 编辑工具 diff 的行号可点击，在代码预览打开对应文件并跳到该行。
- CLI 输入框上方新增会话改动面板：显示本会话更改的文件数与增删行数，展开后查看文件列表和带行号的 diff，点击行跳到代码预览；测试/生成文件与会话前已有的改动单独折叠。适用于所有 CLI，非 Git 目录按会话启动时的文件快照统计。`superhigh-cli terminal changes` 可读取同一结果。
- 在代码预览的 HTML 预览（含 `.superhigh/editor` 项目编辑器页面）中长按，可将当前文件的绝对路径插入 CLI 输入框。
- 插件可通过 `ctx.editor.registerPreviewProvider` 按扩展名注册文件预览，复用代码预览标签栏的预览开关在代码与预览间切换。
- 图片查看器支持使用 A/D 键或方向键循环切换上一张、下一张媒体，按 ESC 可退出全屏。

### 体验优化

- 代码预览工具栏仅在文件编码不是 UTF-8 时显示编码入口；Markdown 渲染与键值面板合并为“MD 配置”，文件标签操作菜单锚定到标签按钮并可在 CLI 区域使用。
- Anthropic 字体风格和自定义字体现在覆盖桌面界面、正文、Monaco、xterm、SuperHigh Pet 及移动端界面；移动端会跟随电脑端的字体风格和自定义字体资源。
- 代码预览的文件标签新增上一个/下一个按钮，并支持聚焦标签时用 A/D 或左右方向键切换；Markdown 渲染开关移入代码预览工具栏。
- 删除确认、新建和重命名输入改用 Super High 居中弹窗，不再暂停 Claude Code、Codex 等终端的界面刷新；资源管理器删除后保留当前滚动位置。
- 本地终端进程退出后自动清理标签与会话状态，主动关闭时等待后端结束终端进程树。
- 备忘录删除不再弹出确认；粘贴图片作为独立附件保存，正文不再出现图片 Markdown 路径，复制备忘录时才附上图片路径。图片可在全窗口查看，并支持滚轮缩放和拖动浏览；旧备忘录的粘贴图片记录会自动迁移。
- YAML/MD 键值显示开关移到代码预览路径栏右侧，状态跨次启动记忆，首次默认为关闭；每次切换都会将面板位置恢复到初始位置。
- Codex 终端回传的连续同步帧在保持帧边界的前提下合并渲染，长 URL 列表和高频刷新不再逐帧排队。
- CLI 输入框发送 Claude Code、Codex 等交互式 CLI 的长路径和多段文本时，使用串行 PTY 写入、粘贴帧与独立回车，减少输入回显卡顿。
- 小管家的“YAML 键值显示”扩展为“YAML/MD 键值显示”：YAML 保留顶层键导航，README.md 等 Markdown 文件可识别标题并点击跳转。
- Markdown 键值导航会按文档大纲自动选择主层级，显示带 H1/H2/H3 等层级关系的树形面板；渲染模式中的节点可直接跳到对应标题。
- 小管家开启“唤起时默认展开”后，启动 Super High 会自动展开；扫描到项目编辑器时在右侧常驻显示编辑器面板，没有实际编辑器时不显示空面板。
- 外部 CLI 控制台显式设置终端色彩能力，并清除继承的会话标识，改善 Codex 等工具的配色显示。
- 内嵌 Codex 终端按 CLI 原生 VT 更新序列渲染，保留新版同步帧与 transcript 历史，避免重绘被重复转换为滚动记录。
- 已打开的文件在磁盘上被外部修改后，代码预览直接载入最新内容，不再显示冲突提示要求手动“覆盖磁盘”或“重新读取”。
- 文件搜索遵循项目 `.ignore`/`.gitignore` 并行建立索引，打开工作区时后台预热；索引过期后先返回现有结果再后台刷新，大型项目搜索不再每 30 秒卡顿十余秒。

### 问题修复

- 修复内嵌 Gemini CLI 继承 `NO_COLOR` 后又被强制启用色彩，启动时重复输出 Node `NO_COLOR`/`FORCE_COLOR` 冲突警告的问题。
- 修复正式版 HTML 预览中内联点击、勾选事件受 CSP 拦截而导致按钮失灵的问题，恢复下载与模态交互，并支持静态、动态插入及放大查看的相对路径图片。
- 从管理员权限运行的 Super High 在外部启动或恢复 Codex CLI 时，使用直接运行模式，避免 Windows 后台服务拒绝管理员权限而退出。
- 外部保存 `.superhigh/editor` 中的 HTML 后，已打开的 SuperHigh 代码预览会实时载入新内容；其他 `.superhigh` 运行数据仍按原有监听范围处理。
- 修改 NI/MM 物品配置后，项目编辑器页面的物品搜索与键列表会按文件变化重建索引，不再返回启动时缓存的旧结果。
- 主窗口运行期间 WebView2 自动更新后，用 Super High 查看器打开图片或视频不再没有窗口并残留后台进程；查看器改用独立的 WebView2 数据目录。

---

### New Features

- Add custom memo categories with quick filtering, pasteable image attachments saved as absolute paths, and click-to-enlarge image previews.
- Add Tokyo Night Glass, Catppuccin Mocha Glass, Dracula Glass, and Nord Frosted Glass terminal-style themes, with live preview when hovering theme options.
- Add custom theme JSON import/export and a downloadable starter template; custom themes are stored in app settings and apply to the UI, Monaco editor, and terminal together.
- Add the built-in “Anthropic 字体风格” with separate UI, content, and monospaced roles; import one or more fonts and fall back to system fonts for missing roles.
- Show the complete theme palette in appearance settings, including background, text, accents, terminal colors, and glass surface opacity.
- Apply translucent RGBA background layers to Glass themes and enable Acrylic window vibrancy for the Windows Tauri window.
- Allow project script tools to select PowerShell 7 with the `pwsh` runtime.
- Make line numbers in Claude Code and Codex edit diffs clickable in CLI terminals, opening the file in the code preview at that line.
- Add a session changes panel above the CLI input: it shows how many files the session changed with added and removed lines, and expands into a file list and a line-numbered diff whose rows jump to the code preview; test/generated files and edits made before the session are folded separately. It works with every CLI, and non-Git folders are compared with a file snapshot taken when the session started. `superhigh-cli terminal changes` reads the same result.
- Long-press an HTML preview in the code preview, including `.superhigh/editor` project editor pages, to insert the file's absolute path into the CLI input.
- Let plugins register file previews by extension with `ctx.editor.registerPreviewProvider`, switching between code and preview with the existing preview toggle in the code preview tab bar.
- Let the image viewer use A/D or the arrow keys to cycle through media, and press ESC to exit fullscreen.

### Improvements

- Show the encoding entry in the code preview toolbar only for non-UTF-8 files; combine Markdown rendering and key-value controls into “MD 配置”, and anchor the file-tab action menu to its button for use near the CLI pane.
- Apply Anthropic and custom font styles to the desktop UI, document text, Monaco, xterm, SuperHigh Pet, and the mobile UI; sync the selected font style and custom font assets from the computer to mobile.
- Add previous/next file buttons to code preview tabs, with A/D and left/right arrow navigation while a tab has focus; move the Markdown rendering toggle into the code preview toolbar.
- Use centered Super High dialogs for delete confirmation, create, and rename prompts, so terminal output keeps updating; preserve the explorer scroll position after deletion.
- Remove local terminal tabs and session state when their processes exit, and wait for the backend to terminate the process tree when closing a terminal.
- Delete memos directly without a confirmation prompt. Pasted images are stored as separate attachments, keeping Markdown paths out of the body; copying a memo includes the image paths. View images in a full-window preview with wheel zoom and drag-to-pan. Existing pasted-image entries migrate automatically.
- Move the YAML/MD key-value switch to the right side of the code-preview path row, remember its state across launches with an off-by-default first use, and reset the panel position on every toggle.
- Batch consecutive synchronized frames from Codex terminal output without splitting frame boundaries, so long URL lists and high frequency refreshes do not queue one render per frame.
- Send long paths and multiline text from the CLI input to interactive CLIs such as Claude Code and Codex through serialized PTY writes, bracketed paste, and a separate Enter to reduce input echo lag.
- Infer the Markdown navigation root from each document outline, show H1/H2/H3-level relationships in a tree panel, and jump to headings within rendered previews.
- Expand the Butler's "YAML key-value display" to "YAML/MD key-value display": keep top-level YAML navigation and recognize clickable headings in Markdown files such as README.md.
- Automatically expand the Super High Butler on startup when its default expansion option is enabled, and show a persistent editor panel on the right only when project editors are detected.
- Set terminal color capabilities explicitly in external CLI consoles and clear inherited session identifiers to improve colors in tools such as Codex.
- Render embedded Codex output from its native VT updates, preserving synchronized frames and transcript history without turning repaints into duplicate scrollback.
- Load the latest disk content into the code preview when an open file is changed externally, instead of showing a conflict banner that asks to overwrite the disk or reload manually.
- Build the file search index in parallel while honoring the project's `.ignore`/`.gitignore`, prewarm it when a workspace opens, and refresh stale indexes in the background so large projects no longer stall for 10+ seconds every 30 seconds.

### Bug Fixes

- Fix embedded Gemini CLI startup warnings caused by inheriting `NO_COLOR` while Super High enables terminal colors with `FORCE_COLOR`.
- Fix release HTML previews whose inline click and change handlers were blocked by CSP; restore download and modal interactions, and load relative images in static markup, dynamically rendered content, and zoom dialogs.
- Use direct mode when launching or resuming Codex CLI externally from an elevated Super High, avoiding startup failures caused by the Windows background server rejecting administrator privileges.
- Reload open SuperHigh code previews when their HTML files in `.superhigh/editor` are saved externally, while preserving the existing watch scope for other `.superhigh` runtime data.
- Rebuild the item library index when NI/MM item files change, so item search and key lists in project editor pages no longer return stale results cached at startup.
- Give the Super High viewer its own WebView2 data folder, so images and videos still open after WebView2 updates itself while the main window is running, instead of showing no window and leaving a background process behind.

## [0.1.35] - 2026-09-23

### 新增功能

- 备忘录预览复用 CLI 终端的路径识别、存在性校验和跳转规则；网页在默认浏览器打开，文件在代码预览打开，目录在文件资源管理器打开。
- 已退出的 CLI 对话新增恢复按钮，复用原生会话 resume 能力，并保留原对话名称、草稿和输入记录。
- CLI 输入框新增离线空格整理和撤销按钮，处理粘贴文本中的中文异常空格，保留段落与代码；按需运行，用完释放，超时保留原文。

### 体验优化

- SuperHigh HTML 编辑器直接在代码预览的文件标签内运行，可切换 HTML 预览与源码；移除单独的编辑器预览入口和重复布局，备忘录保持原样。

### 问题修复

- 修复正式版 HTML 预览受脚本安全策略影响而停在“正在读取”的问题，保留预览沙箱并正常加载项目页面与文件桥。
- CLI `/` 菜单撤回后再次唤起保留所选项；项目和全局 Skill 左键使用、右键打开文件预览，调用时附带实际文件与目录，正确解析技能相对路径。

---

### New Features

- Reuse the CLI terminal's path detection, existence checks, and navigation rules in memo previews. Open web pages in the default browser, files in the code preview, and folders in the file explorer.
- Add a resume button to exited CLI conversations, using the native session resume flow while preserving the conversation name, draft, and input history.
- Add offline spacing cleanup and undo buttons to the CLI input. Clean abnormal Chinese spacing in pasted text while preserving paragraphs and code; run on demand, release resources afterward, and retain the original on timeout.

### Improvements

- Run SuperHigh HTML editors directly in code-preview file tabs with a preview/source toggle. Remove the separate editor-preview entry and duplicate layout; leave memos unchanged.

### Bug Fixes

- Fix HTML previews getting stuck loading under the release script policy; preserve the preview sandbox while loading project scripts and the file bridge.
- Preserve selection when reopening the CLI `/` menu. Left-click project or global skills to use them and right-click to preview their files; include the actual skill file and directory when invoking them so relative paths resolve correctly.

## [0.1.34] - 2026-09-20

### 新增功能

- 备忘录标题栏新增一键复制正文按钮，支持复制当前编辑内容并显示复制结果。
- 终端输出中的 HTTP(S) 网页地址和 `file:///` 本地文件地址支持点击跳转，自动换行的完整链接也可识别；网页在默认浏览器打开，文件在编辑器内打开。
- 终端支持点击括号或引号内包含空格、中文的相对文件路径，并识别跨行显示的完整路径。

### 体验优化

- 多终端模式固定使用 3×3 等大网格，窗口随可用空间调整尺寸；少于 9 个终端时保留空格，末个窗口不再跨格拉伸。
- Markdown 多列表格在窄预览中按记录紧凑排列，短字段集中展示、长说明独占整行，宽预览保留表格；裸 URL 显示为简短域名，展开入口随滚动保持可达，支持展开搜索并固定表头和前两列。

### 问题修复

- 修复切换多终端模式、恢复历史和调整窗口尺寸后偏离最新内容的问题；原本位于底部时继续跟随输出，主动上滚查看历史时保留阅读位置。
- 修复手机 CLI 在宽屏终端下字号过小、字符重叠及偶发整屏空白的问题；手机独立按窄屏换行，保留增量输出和历史滚动位置，不改变电脑终端尺寸。
- 修复多个桌面窗口同时打开不同工作区时，手机切换历史工作区后无法显示对应 CLI 会话的问题；手机会自动连接持有该工作区会话的桌面实例。

### 升级说明

- 多桌面实例的工作区切换修复需要各电脑窗口更新并重启至本版；重启前请先结束或保存其中的 CLI 会话。

---

### New Features

- Add a copy button to the memo heading to copy the current text, including unsaved edits, with success or failure feedback.
- Click HTTP(S) web addresses and `file:///` local file addresses in terminal output, including links wrapped across lines. Web pages open in the default browser, and files open in the editor.
- Click relative file paths containing spaces or Chinese characters inside parentheses or quotes in terminal output, including complete paths displayed across lines.

### Improvements

- Use a fixed 3×3 grid of equally sized panes in multi-terminal mode, resizing panes to fit the available space. Leave unused cells empty with fewer than 9 terminals, and keep the last pane within a single cell.
- Show multi-column Markdown tables as compact records in narrow previews, grouping short fields and giving long descriptions a full row, while retaining tables in wide previews. Display bare URLs as short domain names, keep the expand control accessible while scrolling, and search expanded tables with headers and the first two columns pinned.

### Bug Fixes

- Fix terminals moving away from the latest output when switching to multi-terminal mode, restoring history, or resizing panes. Continue following output when already at the bottom, and preserve the reading position when scrolling up through history.
- Fix tiny or overlapping mobile CLI text with wide desktop terminals and occasional blank screens. Wrap output independently for the phone while retaining incremental updates and historical scroll positions without changing the desktop terminal dimensions.
- Fix missing CLI sessions after switching recent workspaces on the phone when different desktop windows own those workspaces. Automatically connect to the desktop instance that holds the selected workspace's sessions.

### Upgrade Notes

- Cross-instance workspace switching requires each desktop window to update and restart on this version. Finish or save its CLI sessions before restarting.

## [0.1.33] - 2026-09-13

### 体验优化

- 移除图片消息自动附加的本地图片读取说明，减少发送给 Agent 的冗余文字。

### 问题修复

- Markdown 中的本地文件链接在编辑器内打开对应文件，修复相对链接错误跳转到浏览器的 tauri.localhost 页面。

---

### Improvements

- Remove the automatically appended local-image reading instructions from image messages to reduce redundant text sent to agents.

### Bug Fixes

- Open local file links in Markdown inside the editor, fixing relative links incorrectly opening tauri.localhost pages in the browser.

## [0.1.32] - 2026-09-12

### 体验优化

- 脚本扩展页面支持实时接收标准输出与错误输出进度，长时间生成任务可以在结束前显示当前进展。

### 问题修复

- Windows 运行脚本工具时隐藏空控制台窗口，Python 输出使用无缓冲模式及时显示进度。

---

### Improvements

- Script extension pages can receive stdout and stderr progress live, showing updates before long-running generation tasks finish.

### Bug Fixes

- Hide empty console windows when running script tools on Windows and use unbuffered Python output for timely progress updates.

## [0.1.31] - 2026-09-12

### 问题修复

- 电脑关闭 CLI 会话后，手机自动移除对应标签并切换到剩余会话，不再停留在结束警告页；电脑新建的会话也会自动同步。
- 手机终端使用完整可用高度显示历史与当前画面，取消整块缩放和双层滚动；修复 CLI 重绘时模型状态文字重叠，滚动查看历史时保持阅读位置。

---

### Bug Fixes

- Automatically remove mobile tabs when their CLI sessions are closed on the desktop and select a remaining session instead of showing an ended-session warning. Newly created desktop sessions also appear automatically.
- Use the full mobile terminal height for history and the current screen, removing whole-terminal scaling and nested scrolling. Fix overlapping model status text during CLI repaints and preserve the reading position when browsing history.

## [0.1.30] - 2026-09-12

### 体验优化

- 手机终端在新输出到达后及时更新，取消每批绘制后的固定等待，并减少 Host 读取历史输出时的重复复制。

### 问题修复

- 修复手机查看共用 CLI 会话后电脑终端错位的问题：手机跟随实际终端行列数调整显示字号，进入、退出、键盘弹起和屏幕变化不再修改电脑终端尺寸。

---

### Improvements

- Update mobile terminals promptly when output arrives, removing the fixed delay after each rendered batch and reducing repeated history copying on the Host.

### Bug Fixes

- Fix desktop terminal corruption after viewing a shared CLI session on a phone. The phone adjusts its font to the actual terminal grid; opening or leaving the view, showing the keyboard, and screen changes no longer resize the desktop terminal.

## [0.1.29] - 2026-09-11

### 新增功能

- CLI 支持创建真实终端会话、发送文本和 Ctrl+C 等按键、调整终端尺寸及关闭指定会话，可结合会话状态与日志完成自动交互测试。

---

### New Features

- The CLI can create real terminal sessions, send text and keys such as Ctrl+C, resize terminals, and close a selected session. Combine these commands with session status and logs for automated interaction testing.

## [0.1.28] - 2026-09-11

### 新增功能

- Windows 交互卸载时可选择同时清理已登记项目的 `.superhigh` 数据，并查看具体目录；默认保留数据，静默卸载和升级不会删除项目数据。项目数据登记独立于最近项目列表，并兼容旧版仍保存的最近项目。

### 升级说明

- 已从旧版最近项目记录移除，或移动后尚未重新打开的项目，需要在新版中重新打开，才能登记其 `.superhigh` 目录供卸载清理。

---

### New Features

- During interactive Windows uninstallation, optionally clean up registered projects' `.superhigh` data and review their directory paths. Data is retained by default and is not deleted during silent uninstallation or upgrades. Project data registration is independent of the recent-project list and also imports recent projects still saved by earlier versions.

### Upgrade Notes

- Reopen projects in the new version if they were removed from an earlier version's recent-project history or moved without being reopened, so their `.superhigh` directories can be registered for uninstall cleanup.

## [0.1.27] - 2026-09-11

### 新增功能

- 更新后首次打开工作区时，在代码预览中自动打开本版本更新日志 Markdown 标签，正常关闭后同版本不再自动打开；设置中可查看当前与历史版本的真实更新内容，浏览器预览直接读取项目更新日志。

### 问题修复

- 缩短手机连接检测与终端同步的超时等待，电脑 Host 恢复后自动刷新会话列表，避免长时间停留在旧会话。
- 修复手机同步和浏览器预连接被误报为“HTTP 请求无效”的问题，正确等待分段到达的请求，避免消息已经发送却出现连接错误提示。
- 内嵌 Codex 关闭 Astra 输入框星点装饰，避免电脑和手机终端出现浮动星点与文字遮挡，保留正常工作状态动画。

---

### New Features

- Open the current release notes as a Markdown tab in the code preview when first opening a workspace after an update; closing the tab prevents it from reopening automatically for that version. Browse actual current and past release notes in settings, with browser previews reading the project changelog directly.

### Bug Fixes

- Shorten mobile connection checks and terminal polling timeouts, and refresh sessions when the computer Host recovers to avoid remaining on stale sessions.
- Fix mobile synchronization and browser preconnections being reported as invalid HTTP requests by waiting for fragmented requests, avoiding connection errors after a message was sent.
- Disable Astra composer sparkles in embedded Codex terminals to prevent floating dots and obscured text on desktop and mobile, while retaining normal working-status animations.

## [0.1.26] - 2026-09-11

### 体验优化

- 手机资源树改为紧凑单行并支持一键收起全部文件夹，历史工作区选择移至资源管理器标题栏，点击直接弹窗选择。
- 手机 CLI 启动按钮移入紧凑标题栏，保留按钮边框，移除重复的工作区名称和连接状态；刷新与历史对话统一收纳至右上角菜单。
- 桌面与手机 CLI 入口使用对应产品图标；手机会话标签改为无间隔方形，直接关闭会话，并在无会话时显示带 CLI 启动按钮的居中卡片。

### 问题修复

- 修复手机代码文件缺少语法高亮的问题，支持 YAML 等代码格式，长行可横向滚动。
- 手机终端根据可用宽度缩小字号，以 80 列为目标适配，减少内容被截断。
- 修复手机新建 CLI 会话后电脑仍停留在上一会话的问题，电脑现在自动选中新建会话。

---

### Improvements

- Use compact single-line mobile resource rows and collapse all folders at once; move workspace history to the resource manager header and open it directly in a selection dialog.
- Move mobile CLI launchers into a compact header with button borders, remove repeated workspace names and connection labels, and group refresh and conversation history in the top-right menu.
- Use product icons for desktop and mobile CLI launchers; use square mobile session tabs without gaps, close sessions directly, and show a centered card with CLI launch buttons when no session is active.

### Bug Fixes

- Fix missing syntax highlighting for mobile code files, including YAML, and allow horizontal scrolling for long lines.
- Scale mobile terminal text to the available width with an 80-column target to reduce clipped content.
- Fix the desktop staying on the previous session after a new CLI session is created on mobile; the desktop now selects the new session automatically.

## [0.1.25] - 2026-09-11

### 体验优化

- 手机资源文件夹支持原地展开与收起，保留同级文件，自动刷新已展开目录；查看文件后返回保留展开状态和滚动位置。
- 手机终端支持点击命令菜单中的斜杠条目填入命令并聚焦，按确认键继续操作 CLI 原生菜单。

### 问题修复

- 修复点击手机终端斜杠或指令操作按钮后键盘焦点未返回终端的问题。
- 修复手机终端快速输入及退格、删除时丢失按键的问题；切换或退出会话后不再发送迟到输入。
- 修复浅色主题下终端选区难以辨认的问题，增强选区背景并保持选中文字清晰，失去焦点后仍可辨认选区。

---

### Improvements

- Expand and collapse mobile resource folders in place, keep sibling files visible, and refresh expanded directories automatically; preserve expansion and scroll position when returning from a file.
- Tap slash entries in the mobile terminal command menu to fill the command and focus input, then confirm to continue through the native CLI menu.

### Bug Fixes

- Fix mobile terminal keyboard focus not returning after tapping slash or command action buttons.
- Fix dropped keystrokes during rapid mobile terminal typing, backspace, and delete; discard late input after switching or leaving a session.
- Fix hard-to-see terminal selections in light themes with stronger selection backgrounds and readable selected text, keeping selections visible when unfocused.

## [0.1.24] - 2026-09-11

### 体验优化

- 手机资源文件夹支持原地展开与收起，保留同级文件，自动刷新已展开目录；查看文件后返回保留展开状态和滚动位置。
- 手机终端支持点击命令菜单中的斜杠条目填入命令并聚焦，按确认键继续操作 CLI 原生菜单。

### 问题修复

- 修复手机终端快速输入及退格、删除时丢失按键的问题；切换或退出会话后不再发送迟到输入。
- 修复浅色主题下终端选区难以辨认的问题，增强选区背景并保持选中文字清晰，失去焦点后仍可辨认选区。

---

### Improvements

- Expand and collapse mobile resource folders in place, keep sibling files visible, and refresh expanded directories automatically; preserve expansion and scroll position when returning from a file.
- Tap slash entries in the mobile terminal command menu to fill the command and focus input, then confirm to continue through the native CLI menu.

### Bug Fixes

- Fix dropped keystrokes during rapid mobile terminal typing, backspace, and delete; discard late input after switching or leaving a session.
- Fix hard-to-see terminal selections in light themes with stronger selection backgrounds and readable selected text, keeping selections visible when unfocused.

## [0.1.23] - 2026-09-11

### 体验优化

- 手机 Markdown 文件支持点击 MARKDOWN 标记切换原文与预览，并记住显示偏好；资源列表和搜索结果使用与桌面一致的文件类型图标。
- 精简手机会话列表，使用单行短会话 ID；斜杠按钮直接打开 CLI 原生命令菜单，并提供上下选择、确认和退出操作。

### 问题修复

- 修复电脑本机 HTML 手机预览仍需手动填写 Host 地址和令牌的问题，现在自动读取本机配置并连接。
- 修复浅色主题下终端文字难以辨认的问题，将 CLI 输出的深色中性背景适配为主题浅色背景，同时保留文字和状态色；桌面和手机终端同步生效，切换主题后已有输出同步更新。

---

### Improvements

- Toggle mobile Markdown files between source and preview with the MARKDOWN badge and remember the preference; use the same file-type icons as desktop in resource lists and search results.
- Simplify the mobile session list with short, single-line session IDs; open the native CLI command menu with the slash button and provide up, down, confirm, and exit controls.

### Bug Fixes

- Fix local HTML mobile previews requiring manual Host addresses and tokens; previews now read the local configuration and connect automatically.
- Fix hard-to-read terminal text in light themes by adapting dark neutral CLI backgrounds to the theme's light background while preserving text and status colors; apply this on desktop and mobile, including existing output after theme changes.

## [0.1.22] - 2026-09-11

### 体验优化

- superhigh-html 增加真实手机预览入口，连接电脑 Host 自动跟随桌面工作区变化，并更新打开的资源目录。

---

### Improvements

- Add a live mobile preview entry to superhigh-html, following desktop workspace changes through the Host and refreshing the visible resource directory.

## [0.1.21] - 2026-09-11

### 体验优化

- 新手教程补充小管家的显示与隐藏开关，以及聊天面板的展开和收起操作。

### 问题修复

- 修复内置终端将 Alt+方向键错误转换为 Ctrl+方向键的问题，恢复 Codex CLI 等终端应用中的对应快捷键。

---

### Improvements

- Expand the beginner tutorial with instructions for showing or hiding the assistant and expanding or collapsing its chat panel.

### Bug Fixes

- Fix the embedded terminal incorrectly converting Alt+arrow keys to Ctrl+arrow keys, restoring the corresponding shortcuts in Codex CLI and other terminal applications.

## [0.1.20] - 2026-09-10

### 体验优化

- 移除左侧活动栏的编辑器预览入口；顶部编辑器预览按钮支持再次点击返回工作区。
- 本地终端增加新建 PowerShell 入口，任意项目均可直接运行命令，无需配置或启动 Minecraft 服务。
- 移除对话工作区顶部的设置标签。
- 移除早期画布功能及其活动栏入口。

### 问题修复

- 修复启动页最近项目较多时顶部内容被裁切的问题，超高内容可滚动，长项目路径自动换行。

### 其他变更

- 发布首个 Windows Beta 包（Beta 1）；此前 Windows Release 标记为 Alpha。

---

### Improvements

- Remove the editor preview entry from the activity bar; click the top editor preview button again to return to the workspace.
- Add a New PowerShell action to local terminals so any project can run commands without configuring or starting Minecraft services.
- Remove the Settings tab from the top of the conversation workspace.
- Remove the early canvas feature and its activity bar entry.

### Bug Fixes

- Fix clipped startup page content when many recent projects are listed; allow scrolling for tall content and wrap long project paths.

### Other Changes

- Publish the first Windows Beta package (Beta 1); label previous Windows releases as Alpha.

## [0.1.19] - 2026-09-10

### 体验优化

- 将渠道检测移至设置，移除重复的分组信息，集中管理渠道状态。
- 精简终端支持、配置入口及其依赖，统一桌面与手机端的可用终端选项。

---

### Improvements

- Move provider checks into Settings and remove duplicate group information to centralize provider status management.
- Simplify terminal support, configuration entry points, and dependencies, with consistent available terminal options on desktop and mobile.

## [0.1.18] - 2026-09-10

### 新增功能

- 设置 → 配置新增系统图片查看器开关，默认关闭；手动启用后，可在 Windows 中选择 Super High 打开图片，关闭后移除该注册。

---

### New Features

- Add a system image viewer toggle under Settings → Configuration, disabled by default. Enable it manually to make Super High available for opening images in Windows; disabling it removes the registration.

## [0.1.16] - 2026-09-10

### 问题修复

- 电脑端记住手机连接服务的开启状态，重启后使用原地址配置和配对令牌恢复服务；主动关闭后保持关闭。
- 手机端在电脑重启或连接中断后自动重试连接，主动退出连接后停止重连。

### 升级说明

- 从旧版升级后，请在新版电脑端开启一次手机连接服务，之后即可随电脑端启动自动恢复。
- 本次只恢复连接，不恢复电脑端重启前的终端进程或任务。

---

### Bug Fixes

- Remember whether the desktop mobile connection service is enabled and restore it with the saved address settings and pairing token after restart; keep it disabled after an explicit stop.
- Automatically retry mobile connections after a desktop restart or connection loss, and stop reconnecting after an explicit disconnect.

### Upgrade Notes

- After upgrading from an older version, enable the mobile connection service once in the new desktop version to allow automatic restoration on subsequent launches.
- This update restores connections only; it does not restore terminal processes or tasks from before a desktop restart.

## [0.1.15] - 2026-09-10

### 体验优化

- 移除 CLI 终端四周的留边，让终端内容贴合面板。
- 移除左侧活动栏的文档预览和终端按钮。

### 问题修复

- 修复 CLI 终端标签之间的间隙导致选中背景显示不完整的问题。

---

### Improvements

- Remove the outer spacing around CLI terminals so their content fits the panel.
- Remove the document preview and terminal buttons from the left activity bar.

### Bug Fixes

- Fix gaps between CLI terminal tabs that made the selected background appear incomplete.

## [0.1.14] - 2026-09-10

### 体验优化

- Android 支持在应用内检查、下载更新并打开系统安装界面，手机应用更新无需连接电脑。
- 手机设置分别显示 Android 应用与电脑更新；旧版安卓外壳和浏览器提供 APK 下载直链，无需在 GitHub 页面寻找附件。

### 问题修复

- 正式 Release 必须包含同版本 Android 安装包，缺少 APK 时阻止发布，避免手机版更新遗漏。

### 升级说明

- 旧版 Android 应用需先下载并安装本版 APK；后续可使用应用内更新，安装仍需在 Android 系统界面确认。

---

### Improvements

- Check and download Android updates in the app, then open the system installer without connecting to a desktop.
- Mobile settings distinguish Android app updates from desktop updates; older Android shells and browsers offer direct APK downloads without searching GitHub release assets.

### Bug Fixes

- Require a matching Android APK before publishing each stable Release to prevent missing mobile updates.

### Upgrade Notes

- Download and install this APK once on older Android versions to enable in-app updates; Android system confirmation is still required for installation.

## [0.1.13] - 2026-09-10

### 问题修复

- 修复桌面 Codex 终端在显示缩放变化后文字缩小、画面偏移的问题。
- 修复终端尺寸计算包含外侧留白导致底部内容被裁切的问题。

---

### Bug Fixes

- Fix shrunken text and shifted content in the desktop Codex terminal after display scaling changes.
- Fix terminal sizing that counted outer spacing as usable space and clipped content at the bottom.

## [0.1.12] - 2026-09-10

### 体验优化

- 文件管理器复用默认工作区的资源管理器，统一文件树样式、展开状态和可调宽度，移除重复的目录标签与根目录行。
- 移除文件管理器的重复标题、路径、选择状态和预览标题行，让文件网格与编辑器顶部对齐，并保持窄窗口下工具栏单行显示。

---

### Improvements

- Reuse the default workspace explorer in the file manager, sharing tree styling, expansion state, and adjustable width while removing duplicate directory tabs and the root row.
- Remove redundant file manager headings, paths, selection status, and preview headings; align the file grid and editor at the top and keep the toolbar on one row in narrow windows.

## [0.1.11] - 2026-09-10

### 新增功能

- 公开版提供 Minecraft 物品搜索、怪物与 DragonCore 等现有工具。

### 体验优化

- 根据当前项目实际存在的插件目录和配置显示相关工具，物品搜索按钮在发现 NI 或 MM 物品目录时显示。

### 问题修复

- 移除物品图标、品质框和怪物库的固定服务器路径回退，避免读取其他项目的数据。

---

### New Features

- Include the existing Minecraft item search, mob and DragonCore tools in the public release.

### Improvements

- Show tools according to the plugin directories and configuration present in the current project. Show item search when an NI or MM item directory is found.

### Bug Fixes

- Remove fixed server path fallbacks for item icons, quality frames and mob libraries to avoid reading another project's data.

## [0.1.10] - 2026-09-10

### 新增功能

- 手机 Markdown 文件支持在渲染预览和原文之间切换。

### 体验优化

- 手机会话改用横向标签栏切换，并在标签内提供关闭入口；刷新和历史对话收进更多菜单，移除独立快捷键行。
- 调整手机输入区与底部安全区域的间距。

### 问题修复

- 手机新建 CLI 会话后立即通知电脑同步会话列表。

### 升级说明

- 会话同步需要更新电脑 Host；手机页面随 Host 更新，现有安卓 App 刷新连接即可加载新界面。
- 自定义指令按钮尚未接入操作，终端画面直接键入仍未接入发送；请继续使用底部输入框发送文本。

---

### New Features

- Switch mobile Markdown files between rendered preview and source text.

### Improvements

- Switch mobile sessions through horizontal tabs with a close action. Move refresh and conversation history into the more menu and remove the separate shortcut row.
- Adjust spacing between the mobile composer and the bottom safe area.

### Bug Fixes

- Notify the desktop immediately after creating a CLI session on mobile so its session list stays synchronized.

### Upgrade Notes

- Update the desktop Host for session synchronization. Mobile pages update with the Host; reconnect the existing Android app to load the new interface.
- The custom command button is not connected yet, and typing directly in the terminal display is not forwarded. Continue sending text through the bottom composer.
## [0.1.9] - 2026-09-10

### 新增功能

- 设置新增 CLI 显示开关，电脑和手机共用设置；关闭后直接隐藏启动入口，保留已有会话。
- 手机输入框加号支持拍照、相册和文件，附件上传到电脑工作区的 `.superhigh/pasted-images`，支持重试、移除和仅发送附件路径。

### 体验优化

- 手机使用 Super High 完整主题列表，连接后跟随电脑主题；手机选择主题也会同步到电脑。
- 附件依次上传，发送失败保留输入和附件；切换工作区或电脑时隔离上传结果与设置响应。

### 升级说明

- 附件上传及共享设置需要更新电脑 Host；安卓拍照与文件选择器改进需安装新版 APK。单个附件最大 32 MiB。

---

### New Features

- Add shared CLI visibility switches for desktop and mobile. Disabled entries are hidden while existing sessions remain accessible.
- The mobile composer plus button opens camera, gallery, and file selection. Attachments are uploaded to the computer workspace's `.superhigh/pasted-images`, with retry, removal, and attachment-only sending.

### Improvements

- Use the full Super High theme catalog on mobile. Connecting applies the computer theme, and mobile theme changes synchronize back to the computer.
- Upload attachments sequentially, retain drafts and attachments on send failure, and isolate upload results and preference responses across workspace or computer changes.

### Upgrade Notes

- Update the desktop Host for uploads and shared preferences, and install the new Android APK for camera and file picker improvements. Each attachment is limited to 32 MiB.

## [0.1.8] - 2026-09-09

### 新增功能

- 手机端默认进入工作区终端，通过资源管理器侧栏访问电脑真实文件，账户省略号进入设置。
- 手机输入框支持上移展开、通过加号唤起 CLI 斜杠命令及安卓系统语音识别，识别结果可编辑后发送。
- 手机设置提供账户连接、数据管理、语言、外观、字号、服务协议与帮助反馈；检查更新统一包含程序与界面。

### 体验优化

- CLI 启动按钮保持终端上方单行横向滚动，手机优先接续电脑当前工作区。

### 问题修复

- 修复 Windows 安装更新主动断开连接时手机误报失败，改为等待电脑重新开启手机连接后自动加载新版界面。
- 修复安卓退出后自动重新登录，以及编辑或切换电脑连接时影响已有终端的问题。

### 升级说明

- 安卓系统语音输入需要安装新版 APK，并由手机提供系统语音识别服务；电脑需更新以支持工作区同步与统一更新接口。

---

### New Features

- Open the workspace terminal by default on mobile, browse real computer files in the explorer sidebar, and open Settings through the account ellipsis.
- Expand and lift the mobile composer, invoke CLI slash commands with the plus button, and fill editable text through Android system speech recognition.
- Add connection, local data, language, appearance, font size, terms, and help settings; combine application and interface updates in one entry.

### Improvements

- Keep CLI launch buttons in a single horizontally scrolling row above the terminal and prefer the computer's active workspace on mobile.

### Bug Fixes

- Handle the expected connection loss during Windows installation and reload the updated interface after mobile access is re-enabled on the desktop.
- Prevent automatic reconnection after Android logout and preserve the active terminal while editing or validating another computer connection.

### Upgrade Notes

- Android system voice input requires the new APK and an available system speech recognition service; update the desktop host for workspace synchronization and unified update APIs.

## [0.1.7] - 2026-09-09

### 新增功能

- 手机端默认进入工作区终端，通过资源管理器侧栏访问电脑真实文件，账户省略号进入设置。
- 手机输入框支持上移展开、通过加号唤起 CLI 斜杠命令及安卓系统语音识别，识别结果可编辑后发送。
- 手机设置提供账户连接、数据管理、语言、外观、字号、服务协议与帮助反馈；检查更新统一包含程序与界面。

### 体验优化

- CLI 启动按钮保持终端上方单行横向滚动，手机优先接续电脑当前工作区。

### 升级说明

- 安卓系统语音输入需要安装新版 APK，并由手机提供系统语音识别服务；电脑需更新以支持工作区同步与统一更新接口。

---

### New Features

- Open the workspace terminal by default on mobile, browse real computer files in the explorer sidebar, and open Settings through the account ellipsis.
- Expand and lift the mobile composer, invoke CLI slash commands with the plus button, and fill editable text through Android system speech recognition.
- Add connection, local data, language, appearance, font size, terms, and help settings; combine application and interface updates in one entry.

### Improvements

- Keep CLI launch buttons in a single horizontally scrolling row above the terminal and prefer the computer's active workspace on mobile.

### Upgrade Notes

- Android system voice input requires the new APK and an available system speech recognition service; update the desktop host for workspace synchronization and unified update APIs.

## [0.1.6] - 2026-09-09

### 新增功能

- 桌面版增加日常使用新手教程，覆盖项目、对话、文件、终端、渠道排错和手机端接续；完成或关闭后不再自动播放，支持在设置中重放。
- 教程支持左右方向键切换步骤、ESC 直接关闭。

### 不兼容变更

- 移除内置 SSH 连接功能及相关设置入口。

---

### New Features

- Add a desktop tutorial for projects, conversations, files, terminals, channel troubleshooting, and mobile access. It stops appearing automatically after completion or dismissal and can be replayed from Settings.
- Navigate tutorial steps with the left and right arrow keys, or close it with ESC.

### Breaking Changes

- Remove the built-in SSH connection feature and its Settings entry.

## [0.1.5] - 2026-09-09

### 新增功能

- 电脑 Host 托管手机网页，安卓 App 连接后加载电脑上的界面；手机浏览器也可直接访问，电脑设置支持预览手机界面。
- 手机页面文件可独立更新，刷新即可加载新版 UI，无需重新构建安装 APK。

### 问题修复

- 修复手机连接推荐地址误选虚拟网卡的问题，并提供明确的中文连接超时提示。
- 安卓安装图标统一为电脑端的蓝紫菱形图标。

### 升级说明

- 使用网页加载方式需更新一次电脑 Host 和安卓 App；后续安卓原生能力或 App 外壳变更仍需安装新版 APK。

---

### New Features

- The desktop Host serves the mobile web UI, which the Android app loads after connecting. Mobile browsers can open it directly, and desktop settings provide a preview.
- Mobile page files can be updated independently; refresh to load the new UI without rebuilding or reinstalling the APK.

### Bug Fixes

- Fixed virtual adapters being selected as the recommended mobile connection address and added a clear Chinese connection timeout message.
- Matched the Android launcher icon to the desktop app's blue-purple diamond icon.

### Upgrade Notes

- Update the desktop Host and Android app once to enable hosted pages. Changes to native Android capabilities or the app shell still require a new APK.

## [0.1.4] - 2026-09-09

### 新增功能

- 安卓手机端新增终端和 AI 对话，可连接电脑会话、发送输入、查看持续输出，并浏览和继续 AI 历史对话；提供 APK 测试安装包。

---

### New Features

- Added Android terminal and AI conversations: connect to desktop sessions, send input, follow live output, and browse or resume AI conversation history; an APK is available for testing.

## [0.1.3] - 2026-09-09

### 新增功能

- 新增 CLI 终端查询，可列出应用内会话并读取近期输出，支持项目筛选与 JSON。
- 新增 CLI 项目脚本工具入口，可查看工具与参数并执行已登记工具。

### 体验优化

- 项目编辑器未登记页面时显示明确的空状态，不再误报编辑器不可用。

### 问题修复

- 修复 Windows 下部分 Node.js 项目脚本因路径格式无法启动的问题。

### 不兼容变更

- 移除远程端功能及配套 CLI 命令、设置中的工作区历史页面和未实现的 Git 导航入口；欢迎页仍保留最近项目。

---

### New Features

- Added CLI commands to list in-app terminal sessions and read recent output, with project filters and JSON output.
- Added CLI commands to inspect project script tools and their parameters, and run registered tools.

### Improvements

- Project editors with no registered pages now show a clear empty state instead of an unavailable error.

### Bug Fixes

- Fixed a Windows path-format issue that prevented some Node.js project scripts from starting.

### Breaking Changes

- Removed remote-end functionality and its CLI commands, the workspace history settings page, and the unimplemented Git navigation entry; recent projects remain on the welcome page.

## [0.1.2] - 2026-09-09

### 新增功能

- 应用内更新：启动后及每隔 4 小时检查正式版，支持后台下载、手动检查和安装后重启。
- 设置中的“应用更新”页面，显示当前版本、下载进度、更新说明和失败重试入口。
- Windows 更新包签名校验，以及 GitHub Actions 的签名构建和更新清单发布流程。
- PDF、Office 文档和媒体预览能力。

### 体验优化

- 安装更新前保护未保存文件和内部终端会话；其他 Super High 窗口仍打开时延后安装。
- 完善 CLI 历史记录、会话展示和终端交互。
- 发布时核对应用版本、标签、安装包和更新清单的一致性。

### 升级说明

- 0.1.0 尚不具备应用内更新能力，需要手动安装一次本版；后续正式版可在应用内更新。
- 0.1.1 未单独发布到 GitHub，其间的开发变化随本版发布。

---

### New Features

- In-app updates: check for stable releases after startup and every four hours, with background downloads, manual checks, and installation followed by a restart.
- An Updates page in Settings showing the current version, download progress, release notes, and retry controls.
- Signature verification for Windows update packages, plus signed builds and update manifest publishing through GitHub Actions.
- PDF, Office document, and media previews.

### Improvements

- Protect unsaved files and internal terminal sessions before installing an update; defer installation while other Super High windows remain open.
- Improve CLI history, session displays, and terminal interactions.
- Validate consistency between application versions, tags, installers, and update manifests before publishing.

### Upgrade Notes

- Version 0.1.0 does not support in-app updates. Install this version manually once; subsequent stable releases can be installed from within the app.
- Version 0.1.1 was not released separately on GitHub. Its development changes are included in this release.

## [0.1.0] - 2026-08-12

- 首次发布 Windows 安装包。

[0.1.3]: https://github.com/XMhead/Super-High/releases/tag/v0.1.3
[0.1.2]: https://github.com/XMhead/Super-High/releases/tag/v0.1.2
[0.1.0]: https://github.com/XMhead/Super-High/releases/tag/v0.1.0
