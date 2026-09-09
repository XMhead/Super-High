# Super High CLI

`superhigh-cli` 复用桌面应用的 Rust 后端，供命令行、脚本及 Agent 调用。

```powershell
superhigh-cli --help
superhigh-cli tools --help
# 在源码工作区运行：
npm run cli -- --help
```

所有命令支持 `--json`。成功退出码为 0；参数、执行或桥接失败为非零，错误说明写到 stderr。`tools run`、`service`、`terminal` 的执行结果在失败时仍可包含 stdout JSON，请同时检查退出码。

## 命令

| 命令 | 功能 |
| --- | --- |
| `files ls/read/write/touch/mkdir/rename/delete` | 文件及目录操作；删除须带 `--force` |
| `search <query>` | 文件名及文本搜索；`--limit` 限制数量，`--no-text` 只搜索文件名 |
| `memory graph` | 输出项目指令、记忆卡片及文件引用关系 |
| `env cli` | 检测 CLI 命令及安装路径 |
| `service status/start/restart` | 通过桌面应用操作项目服务 |
| `tools list/run` | 发现并执行项目登记的脚本工具 |
| `terminal list/logs` | 查看桌面应用登记的终端及输出缓冲 |

完整参数用 `superhigh-cli <命令组> --help` 查看。`--project` 不是全局参数：`files/env` 不接受它；`service` 必须显式传绝对路径；`terminal` 不传时查询全部项目，传入时也须用绝对路径；其余支持项目路径的命令默认当前目录。

## 项目脚本工具

```powershell
superhigh-cli tools list --project "D:\MyProject" --json
superhigh-cli tools run check-config --project "D:\MyProject" --arg scope=all --json
```

工具来自项目 `.superhigh/script-tools.json` 及其登记目录，沿用现有运行时与参数配置。先用 `list` 查看工具 ID 和 `parameters`，再用可重复的 `--arg 参数ID=值` 传参。布尔参数传 `true` 或 `false`。`run` 返回工具 stdout、stderr 和 exitCode，工具失败时 CLI 也返回非零。实际执行脚本可能修改项目，取决于该工具的功能。

## 终端状态与日志

```powershell
superhigh-cli terminal list --json
superhigh-cli terminal list --project "D:\MyProject" --json
superhigh-cli terminal logs <session-id> --tail 100 --json
```

需要运行本次构建的桌面应用。`list` 读取应用的 TerminalManager 登记表，返回 `holdsPtyChild`、`running` 和 `processId`；项目过滤按终端启动目录及其子目录匹配。`logs` 读取指定会话已有的输出缓冲，不发送终端输入。默认最后 100 行，最多 2000 行且受 32 KiB 上限约束，保留 ANSI 控制序列；JSON 的 `truncated` 和字节偏移说明是否截断。日志是有限缓冲快照，不是完整历史记录或实时订阅。

## 服务

```powershell
superhigh-cli service status --project "D:\MyServer\plugins" --json
superhigh-cli service start --project "D:\MyServer\plugins" --service client --json
superhigh-cli service stop --project "D:\MyServer\plugins" --service client --json
```

服务控制需要桌面应用运行。普通服务 `start` 启动项目配置的服务链，`restart` 使用项目登记的重启动作，多服务项目需要指定服务 ID。
