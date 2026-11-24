# 终端渲染基准

比较 xterm WebGL 与 Wraith 时，先确认用户允许的提供方和模型。已有合格录制直接回放；新增录制由 `terminal_capture` 采集一次 Codex 请求，默认 `gpt-6.1-terra`。`requestedModel` 必须与原生记录的模型一致，报告生成前同时校验输入哈希和完成状态。

依赖以 [package.json](../assets/renderer-benchmark/package.json) 为准，安装在工作区 `.agent/tmp/<任务>`，由 `terminal_benchmark` 的 `deps` 指向该目录。采集、回放和汇总分别使用 [record-codex-terminal.py](../scripts/record-codex-terminal.py)、[benchmark-terminal-renderers.mjs](../scripts/benchmark-terminal-renderers.mjs) 和 [summarize-terminal-benchmark.py](../scripts/summarize-terminal-benchmark.py)；参数通过引擎 `describe` 或脚本 `--help` 查询。汇总依赖 Python Pillow。

公开 `write` 回放与私有 `parse/renderRows`、GPU fence 压力分别报告。前者包含帧调度等待，后者统计 GPU 完成更新/秒。压力输入本地生成，成对校验输入哈希、终端缓冲及画面；模型生成速度由另一项测试测量。

汇总入口的 `source` 使用下面的批次目录，每个目录包含 `results.json` 及其引用的 PNG；`codex-recording.json` 位于 `source` 根。

| 批次 | 用途 |
| --- | --- |
| `full` | 正确性、公开回放与各类压力 |
| `sustained-control` | 持续整屏压力 |
| `dpi-check` | CDP DPR 诊断 |
| `dpi-native-scale` | 原生进程缩放与像素取样 |
| `dense-pixels` | 相同像素尺寸的密集画面 |

缩放采样例如 `--checks-only --dprs 1.5 --native-scale 1.5`。真实桌面复验见 [终端渲染验收](../../superhigh-html/references/terminal-rendering.md)；原生缩放与仿真 DPR 分别判断。

报告的 IUI 通过 `Data` 读取 `table`、`chartLabels`、`chartSeries`、`cpuTable` 和 `limitations`，用于吞吐、CPU 和适用范围比较。`recording` 用于核对实际模型、输入哈希和单次请求用量。结果变化时按需展开 `metrics` 的配对范围、`captures` 的截图及 `pixelChecks` 的坐标；先比较原始批次的 `versions`、`sourceHashes`、字体和缩放条件，再决定是否可直接对比。原生 PTY 的 `chunks` 按需展开，默认只投影所需字段。

采集报告的 `remainingProcesses` 和批次的 `cleanup.remaining` 非空时先按 PID 与创建时间完成进程收尾，再生成报告。认证副本留在临时采集目录；正式保留报告、录制与截图后，按 Agent-Cleaner 的单任务入口清理目录。

报告生成回归用 [test_summarize_terminal_benchmark.py](../scripts/test_summarize_terminal_benchmark.py) 的 `--tmp-root <工作区临时目录>`，覆盖不同模型、吞吐反转、旧缩放证据和未退出进程；不调用模型。
