---
name: superhigh-wiki
description: 查询和维护 Super High 最新功能 Wiki；为使用教程、功能说明和宣传内容提供操作入口、功能边界与源码证据。
---

# Super High Wiki

维护当前源码的用户功能知识。按问题加载对应页，避免重复扫描整个仓库。
每页记录用户入口、可完成的操作、限制和直接源码。
源码证明功能存在；实际操作证明当前运行实例可用。

## 按需入口

| 需求 | 参考页 |
| --- | --- |
| 定位、版本口径、首次使用 | [产品与入门](references/product-and-start.md) |
| 文件、搜索、编辑、文档和媒体预览 | [工作区与编辑器](references/workspace-and-editor.md) |
| Agent CLI、会话、Skills、终端 | [CLI 与会话](references/cli-and-sessions.md) |
| 脚本工具、HTML、插件、项目服务 | [项目扩展](references/project-extensions.md) |
| 主题、字体、备忘录、管家、手机、渠道 | [个性化与日常功能](references/personalization-and-mobile.md) |
| 更新 Wiki、选择宣传证据、处理模拟边界 | [维护与宣传证据](references/maintenance-and-promotion.md) |

## 维护边界

用户功能说明以这些参考页为维护位置；根 FEATURES.md 提供索引。
CLI 参数以实际 `--help`、CLI.md 和 Rust 分发器为准。
版本以应用版本文件为准；CHANGELOG 的待发布段不表示已发布。
遇到冲突，读取该页的直接源码并原位修正说明。
仅源码检查时标明实测边界；模拟结果不代表真实后端验收。

项目 `.superhigh` schema、脚本桥和 Minecraft 工作区配置遵循现有 `superhigh-workspace-config` skill。
该全局 skill 缺席时读取目标 loader；本 Wiki 不另建协议副本。
浏览器演示、预览空白及依赖加载失败时，读取 [superhigh-html](../superhigh-html/SKILL.md) 的能力边界与验收方法。
界面修改使用 [UI 约束](../super-high-ui-constraints/SKILL.md)。
源码同步与发布使用 [superhigh-github](../superhigh-github/SKILL.md) 和 [公开同步](../superhigh-public-publish/SKILL.md)。
本 Wiki 不改变重启、会话保护或发布授权。
