# 手机终端排错

## 直接来源

| 问题 | 来源 |
| --- | --- |
| 字号、手机行列与输入队列 | [MobileSessions.vue](../../../../src/mobile/MobileSessions.vue)、[terminalLayout.ts](../../../../src/mobile/terminalLayout.ts) |
| 原始终端解析、窄屏换行、历史行修补与清屏 | [mobileTerminalRenderer.ts](../../../../src/mobile/mobileTerminalRenderer.ts)；回归测试在同目录 `mobileTerminalRenderer.test.ts` |
| 工作区选择与会话客户端切换 | [MobileApp.vue](../../../../src/mobile/MobileApp.vue)、[hostApi.ts](../../../../src/lib/hostApi.ts) |
| 桌面实例登记、Host 端口与生命周期 | [mobile_host.rs](../../../../src-tauri/src/mobile_host.rs)、[db.rs](../../../../src-tauri/src/db.rs) |

## 按症状定位

- **重叠或裁切**：分别核对 Host 返回的 PTY 行列、手机显示行列、字体和屏幕实测尺寸。原始控制序列按 PTY 网格解析，再独立重排到手机；手机适配不得调整共享 PTY。验证中文宽字符、颜色、旋转及输入框展开后仍完整显示，电脑行列保持不变。
- **有输出却空白**：先比较源缓冲、显示缓冲和 DOM，并检查 `viewportY` 是否为有限数。xterm 5.5 的 RIS 全重置会暂时将 DOM 行高归零，残留滚动事件可产生 NaN；投影清屏复用 `MOBILE_TERMINAL_CLEAR`，并经 `writeMobileTerminalProjection` 串行写入。只调用滚动到底部不能修复 NaN。
- **长会话卡顿**：覆盖数千行历史与小于实时屏幕的手机视口，连续修改已进入滚动历史的实时行。除读取增量外，还检查实际绘制量及写入耗时；局部更新应走历史行修补，不能每帧重播整段历史。确认修改后的历史行实际可见、颜色与宽字符保留、固定提示不重复，以及调整视口后阅读位置不跳动。
- **切工作区后空白或串内容**：历史工作区来自共享数据库，活跃 PTY 属于各实例自己的 `TerminalManager`。核对所选路径、`workspaceHosts`、请求实际端口和会话 ID；两份真实桌面实例各用本轮测试会话，经历史工作区入口来回切换，再验证输入归属与迟到输出隔离。Host 生命周期改动还需检查端口占用回退、停止后重绑及共享开关同步。

浏览器调试模块须与当前源码一致；热更新后直接重复 `import()` 同一 URL 可能取到缓存旧模块，可刷新页面后再测。浏览器尺寸模拟、真实 Host 验收和实体手机验收分别报告，前两项不能替代真机结果。
