# 终端渲染验收

主工作区渲染器、回退原因与生命周期用 [inspect-preview.mjs](../scripts/inspect-preview.mjs) 的 `--view terminal` 取证。沿用技能的桌面 CDP 连接；`--expect-renderer webgpu` 要求可见且已挂载的终端均使用 WebGPU，缺少实例或发生回退时返回非零退出码。DOM 回退验收用 `--expect-renderer dom`。

结果位于 `terminal`。其中 `hosts` 返回 `renderer`、`fallbackReason`、可见性、挂载状态、容器坐标及画布的 CSS／像素尺寸；不读取终端内容或输入。`gpuAvailable` 和 `secureContext` 用于定位初始化失败，启用状态以 `renderer` 为准。`wasm.resources` 返回 Wraith 资源文件名和解码字节数，定位打包资源缺失；`observed=false` 时补查资源加载，零条记录也可能来自资源计时缓冲被清空。

默认选择 `.terminal-host`。其它宿主传 `--selector`，嵌入页面加 `--frame-title`。`remainingHosts`、`remainingCanvases` 或 `wasm.remaining` 非零会标记取证不完整；缩小选择范围或提高 `--limit` 后复查。

缩放验收使用原生窗口与系统缩放，比对 `devicePixelRatio`、容器和画布尺寸，再检查截图中的字形、选区和光标。CDP 设备仿真仅用于诊断；仿真 DPR 与 `devicePixelContentBoxSize` 不一致时，回到原生缩放复验。

生命周期用 [聊天历史验收](chat-history.md#渲染与问答) 的 `--view chat` 检查：返回聊天后终端容器与实例归零，重新进入工作模式后再核对实际渲染器。输入、退格、粘贴、选区和原生命令在本轮测试会话中操作；仅验证输入时保留未提交草稿或使用已确认的本地斜杠命令。需要模型请求时沿用用户指定的提供方和模型。
