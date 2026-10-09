---
name: superhigh-theme
description: 维护 Super High 内置颜色主题清单与配色画廊预览；按 key 增删主题、同步测试保留清单并从桌面入口核对分组数量。
---

# SuperHigh Theme

内置主题权威源是 [theme.ts](../../../src/lib/theme.ts) 的 `THEMES`（含末尾 `Object.assign` 里的 glass 条目），保留清单断言在 [theme-catalog.test.ts](../../../src/lib/theme-catalog.test.ts)。

## 入口

```powershell
node .codex/skills/superhigh-theme/scripts/theme-tool.mjs --list
node .codex/skills/superhigh-theme/scripts/theme-tool.mjs --gallery
node .codex/skills/superhigh-theme/scripts/theme-tool.mjs --remove <key,...> [--apply]
node .codex/skills/superhigh-theme/scripts/theme-tool.mjs --keep <key,...> [--apply]
```

`--list` 输出分组后的主题与序号，供人工核对。`--gallery` 用 [画廊模板](scripts/gallery-template.html) 生成 `.superhigh/script-tools/theme-gallery.html`：每个主题一张迷你预览卡，勾选后文本框导出 `keys` 清单，把该清单直接传给 `--remove` / `--keep`。画廊页面在 Super High 内运行时必须使用注入的 `--font-ui`、`--font-content`、`--font-mono` 及对应字重变量，不得写死系统字体族。

`--remove` / `--keep` 默认只打印差异，加 `--apply` 才写 `theme.ts` 并同步测试保留清单；`--keep` 里当前不存在的 key 会从 git 历史恢复（含连整块删除的 glass 段）。传入的 key 顺序即最终 `Object.keys(THEMES)` 顺序，需要保持现有顺序时按 `--list` 给出的顺序传参。

## 约束

- 增删主题只传 key。界面按深色/浅色分组展示，序号随分组变化，用序号做映射会整体错位：曾把浅色组末尾的 `61-64` 当成 glass，导致误删 3 个 glass 并漏删 6 个浅色主题。
- 保留项用 `...THEMES.x` 依赖的主题必须一并保留（glass 依赖其它主题），脚本会在写盘前拦截。
- 写盘后跑 `npx vitest run src/lib/theme-catalog.test.ts src/lib/terminalColors.test.ts`，再从桌面入口核对该分组的实际数量；主题数据变化后重跑 `--gallery` 刷新预览页。
