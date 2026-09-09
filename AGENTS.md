# AGENTS.md — Super High 协作说明（给维护本仓库的 AI）

本文档约束在本仓库中改代码、改配置、写脚本的智能体：以本文为准，而不是凭记忆或通用最佳实践擅自换栈。

## 固定技术架构（不可擅自更换）

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 前端框架 | **Vue 3**（推荐 Composition API + `<script setup>`） | 禁止在未与用户约定的情况下改回 React / Svelte 等 |
| 构建与开发服务器 | **Vite** | 配置文件以 `vite.config.*` 为准 |
| 桌面壳 | **Tauri 2.x** | Windows 11 桌面应用；与 Rust 侧通过 Tauri 命令 / 事件通信 |
| 原生与系统能力 | **Rust**（`src-tauri`） | 系统 API、文件、进程、窗口等放在 Rust，必要时暴露给前端 |

**目标运行环境**：**Windows 11**

## 项目编辑器（`.superhigh/editor`）

- `src/components/ProjectEditorPanel.vue` 会将项目 HTML 挂载进 Shadow DOM；若需把 CSS 的 `body` 选择器改为 `:host`，只能匹配独立选择器，不能全文替换 `body`。
- 项目 HTML 的脚本通过隔离的 `new Function` 执行；HTML 内不能使用 `onclick`、`oninput`、`onchange` 等内联事件，交互必须使用 `addEventListener`，动态生成内容则在稳定父节点上做事件委托。
- 项目 HTML 通过 `superhigh-editor:fs` 的 `list` 读取目录时，`entry.extension` 由 Rust 返回且带前导点（如 `.yml`）。筛选扩展名必须先去掉前导点或同时兼容带点形式。
- 项目 HTML 读取资源时，禁止并发请求整个目录；必须分页或按可见卡片加载，并限制并发数。
- 修改项目编辑器的挂载或样式转换逻辑时，需用实际 `.superhigh/editor/*.html` 检查带 `body` 的类名仍保持完整，并运行 `npm run build`。

## 工作原则

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- 先明确假设；不确定就问。
- 存在多种解释时全部摆出来，不要默默选择。
- 有更简单的方案就说出来；必要时提出反对意见。
- 不清楚就停下来，说清困惑点，再提问。

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- 不做需求之外的功能。
- 不为单次使用做抽象。
- 不做没被要求的“灵活性”或“可配置性”。
- 如果 200 行能写成 50 行，就重写。

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- 不要顺手“改进”相邻代码、注释或格式。
- 不要重构没坏的东西。
- 匹配现有风格。
- 你的改动产生的孤儿（未使用的导入/变量/函数）必须清掉；预先存在的死代码不要删，除非被要求。

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

- “加校验” → “先写无效输入的测试，再让测试通过”
- “修 bug” → “先写复现测试，再让它通过”
- “重构 X” → “重构前后测试都必须通过”

## 构建与验证

```powershell
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

修改 `tauri.conf.json`、Tauri command、Rust 后端或打包配置后，必须重新构建并重启应用验证；已运行的 `super-high.exe` 不会吸收新的 CSP 或后端代码。
