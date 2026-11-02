# 聊天历史验收

## 定位

SuperHigh 用户使用 cc-switch。CLI 存储兼容优先复用或参考 cc-switch 的读取逻辑，cc-switch 数据库只读；会话正文仍从 CLI 原生数据读取。

| 范围 | 权威实现 |
| --- | --- |
| 全局会话、工作区归属、配置目录、索引缓存 | `src-tauri/src/cli_conversations.rs`：`list_all_conversations`、`historical_chat` |
| 原生标题 | Codex `session_index.jsonl`、只读 `state_N.sqlite`，按会话 ID 关联；缺失时才回退首条用户内容 |
| 正文、思考与工具输出 | `src-tauri/src/cli_chat.rs`；OpenCode 实时完成信号经 `read_opencode_live_chat` 处理 |
| 项目分组、筛选、分页与恢复入口 | `src/components/ChatWorkspace.vue`、`src/lib/chatHistory.ts` |

## 取证

沿用技能的桌面 CDP 连接，运行 `node .codex/skills/superhigh-html/scripts/inspect-preview.mjs --cdp <调试HTTP地址> --page-url <主窗口精确URL> --view chat`。

`chat` 返回当前过滤器、历史/实时模式、已渲染行和回合数、已展开工具的正文长度、输入及恢复入口可见性、错误和分栏坐标。正文只返回长度，会话行不返回标题和路径。侧栏折叠、每组截断和历史分页会限制 DOM 计数；全局数量使用原生读取入口核对。`remainingErrors` 非零时缩小目标范围后再取证。

输入区按可见性判断，隐藏的实时终端仍可能挂在 DOM；可恢复的历史应显示输入区且没有独立恢复按钮。工具输出在展开后取证；零长度只说明当前渲染范围没有内容。`complete` 表示取证覆盖，不证明读取成功、恢复完成或 CLI 已结束任务。

`chat.receipts` 只返回当前视图的计数：`nativeMessages` 为原生日志消息，`supplementalMessages` 为同轮补充，`pendingMessages` 为待确认发送，`unconfirmedMessages` 为已提示暂未确认的发送，`draftCharacters` 为草稿长度。待确认发送不计入 `content.renderedTurns`；接收确认仍须核对原生日志，处理结果须核对实际回答。

## 验收边界

- **读取与恢复**：先覆盖本机存在的 Claude Code、Codex、DSH 和 OpenCode。打开历史和编辑草稿均不切换工作区、不启动 CLI；发送消息时才切换到所属工作区、恢复原生会话并提交。核对失败保留草稿、重复发送拦截，以及恢复期间切换记录不会向旧目标误发。DSH 历史不提供恢复，继续使用原生界面。仅清理本轮创建的验收会话。
- **身份与缓存**：跨工作区、重复会话、改名后刷新、损坏记录、环境变量覆盖和旧存储格式分别核对。索引数量、默认标题或列表出现不能代替正文验收。
- **时间线与分页**：思考、工具输入/输出和最终回答分别检查；实时完成以提供方完成信号为准，历史快照不跑活动时钟。加载更早记录须保留续页标记和滚动锚点，覆盖超过 1000 轮的边界。
- **发送确认**：在本轮新建的真实 CLI 对话工作期间连续补发，覆盖相同内容；逐条核对原生消息回执、同轮时间线和最终回答，再重开历史确认保留。消息写入终端、原生接收和 Agent 处理分别取证；新回合不是同轮补发的接收凭据。暂未确认时保留消息继续核对，迟到回执应消除等待状态，草稿不自动回填。确定写入失败才恢复草稿。
- **布局**：侧栏显隐、代码区开关和原生窄窗口下核对 `chat.layout`；代码区开启时搜索框左边缘应贴合预览边框内沿，排序框右边缘贴合分栏。截图只辅助判断。

单元回归用 `npx vitest run src/components/ChatWorkspace.test.ts src/components/CliChatView.test.ts src/lib/chatHistory.test.ts`；原生读取使用 `cli_conversations` 和 `cli_chat` 的定向 Rust 测试。浏览器模拟只验证界面，真实读取和恢复仍需桌面验收。
