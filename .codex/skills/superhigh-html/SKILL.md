---
name: superhigh-html
description: 开发 Super High 的浏览器热更新预览与可交互模拟；设置场景复用 Vue 设置组件，手机预览连接真实 Host 同步工作区和文件。
---

# SuperHigh HTML

用于边改 Super High 源码边体验真实界面的交互。读取 [UI 约束](../super-high-ui-constraints/SKILL.md)；设置标题不加讲解小字。预览迭代的发布范围沿用用户当前要求，不因模拟成功自行扩大。

## 入口与参数

需要同步当前桌面工作区、查看真实资源或操作手机界面时，执行 `npm run superhigh-html -- --page mobile --no-open`，打开 `http://127.0.0.1:1421/`（手机尺寸容器）或 `/mobile/`（真实 MobileApp）。电脑本机预览自动只读获取 Super High 的手机服务配置并连接，不要求用户填写地址或令牌；代理自动使用配置中的本机端口。此能力只存在于 Vite 开发服务，并仅向本机同源请求提供连接信息。手机局域网访问仍使用正常认证；指定其他 Host 时，在启动前设置 `SUPERHIGH_MOBILE_HOST` 并使用该 Host 的连接凭据。不将令牌写入源码、查询参数或日志。

手机页连接时读取桌面当前路径，之后每 3 秒跟随桌面工作区变化；资源管理器打开时刷新当前目录。手机主动选其他工作区后，保持该选择直到桌面路径再次变化。文件浏览、搜索、图片和会话均调用真实 Host，操作会作用于桌面；保留已有内部会话，不为预览重启应用。未连接时显示真实错误，不回退到假数据。

设置模拟使用以下入口：

在仓库根目录执行（可复用已经运行的同端口服务）：

```powershell
npm run superhigh-html -- --section mobile --scenario ready
```

固定页面为 `http://127.0.0.1:1422/superhigh-html.html`，命令参数会转换成同名 URL 查询参数；可以直接导航已有标签页，例如 `?section=plugins&scenario=error&theme=light&persist=0`。用户以 `superhigh-html section=mobile scenario=error` 布置任务时，转换成对应入口参数。

| 参数 | 值 / 默认 |
| --- | --- |
| `page` | 命令行专用，`settings`（默认）或 `mobile`（真实 Host，不接受设置模拟参数） |
| `section` | `general`（常规，默认）、`appearance`、`config`、`shortcuts`、`mobile`、`cli`、`storage`、`updates`、`plugins`、`channels` |
| `theme` | [theme.ts](../../../src/lib/theme.ts) 中的主题 ID；省略时沿用模拟设置 |
| `scenario` | `ready`（默认，可用数据）、`empty`（空状态）、`error`（失败） |
| `mode` | `simulate`（默认，可交互）、`readonly`（不模拟桌面操作） |
| `persist` | `1`（默认，会话内保存模拟状态）、`0`（可重复的初始场景） |
| `port` | 命令行专用，设置默认 `1422`，手机默认 `1421` |
| `--no-open` | 命令行专用，启动/复用服务并返回链接，不另开浏览器 |

## 实现边界

- HTML 入口 → [SettingsPreview.vue](../../../src/preview/SettingsPreview.vue) → [SettingsDrawer.vue](../../../src/components/SettingsDrawer.vue)，主题与 CSS 共享应用源码。不要维护另一个近似外观页面。
- [simulator.ts](../../../src/preview/simulator.ts) 仅由设置预览入口加载，覆盖 store 动作并截断后端调用。数据和操作回执明确标为模拟，设置模拟不会启动终端、修改本机文件、连接供应商或安装更新。手机入口独立使用真实 MobileApp 和现有 Host API。
- 当前可体验设置导航、主题/保存偏好、终端显示开关、手机服务与令牌、插件搜索/启停/重载、数据路径回执、更新状态流转，以及真实教程组件的重放。管家快捷键显示实际实现；不宣称浏览器拥有 Windows 全局快捷键。
- 修改设置后刷新页面验证会话保留；“重置模拟”只重置本模拟器的状态。场景切换和 `persist=0` 用于复现空状态与错误，不伪造成功。
- 对尚未覆盖的后端动作，先增加对应模拟状态转换与失败反馈，再接真实组件。保持真实后端在桌面入口执行；不要把模拟逻辑注入生产入口，或把前端预览扩成真实系统控制桥。

## 验收

手机预览在 390 px（必要时 360 px）实际点击资源管理器、进入目录、打开文件并返回，核对真实路径与内容；保存源码后确认热更新。工作区同步改动运行 `npm test -- src/mobile/MobileApp.test.ts`。桌面切换或文件变化必须有实际操作证据才能报告实机同步通过；单元测试只能证明对应逻辑，不能代替实际场景。保留用户继续使用的预览服务。

直接在保留的预览页操作控件，确认状态变化、重置及需要的失败分支，并确认保存源码后热更新。只运行改动相关的检查；模拟器动作变更运行 `npm test -- src/preview/simulator.test.ts`，参数解析变更检查有效和无效参数。桌面系统行为仍按项目实际入口及会话保护验收。

交付给出可直接打开的具体场景 URL，保留用户继续使用的服务；说明已覆盖流程及真实桌面验证状态。不要用纯 HTTP 成功或静态截图代替交互验收。
