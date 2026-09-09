# Super High 协作说明

本仓库是 Super High 桌面工作区的公开仓库：Vue 3 + Vite + Tauri 2 + Rust，目标环境 Windows 11。

## 常用命令

```powershell
npm run dev        # 前端开发服务器
npm run tauri:dev  # 桌面应用开发模式
npm run build      # 类型检查 + 前端构建
npm test           # 前端测试
cargo test --manifest-path src-tauri/Cargo.toml
npm run cli -- --help
```

## 约定

- 遵循仓库 `AGENTS.md`；技术栈固定为 Vue 3 / Vite / Tauri 2 / Rust。
- 改动保持小而准：不做无关重构，不引入多余抽象。
- 前端控件偏密、偏矩形；使用 `src/lib/theme.ts` 与 `src/styles.css` 的主题变量。
- 项目编辑器 HTML 在 Shadow DOM 中运行，交互必须用 `addEventListener`/事件委托，不能用内联事件。
- 改完运行 `npm run build`，必要时运行测试。
