# Release 格式

格式参考 [DeepSeek Harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)，只借用分类与双语组织方式，不复用其产品内容。

## 固定标题与分类

Release 标题：`Super High v<版本>`。CHANGELOG 的版本标题：`## [<版本>] - YYYY-MM-DD`。

分类按下表顺序使用。Agent 根据变更事实自动选取；没有实际内容的分类整节省略，不写“暂无”。同一项只放在最合适的一个分类中。

| 中文标题 | 英文标题 | 适用变化 |
| --- | --- | --- |
| 新增功能 | New Features | 用户以前无法完成、现在可以完成的操作 |
| 体验优化 | Improvements | 已有能力的易用性、性能、反馈或交互改进 |
| 问题修复 | Bug Fixes | 有证据的错误行为及其修复，不把一般新增能力写成修复 |
| 不兼容变更 | Breaking Changes | 会影响现有使用方式、接口或数据兼容性的变化 |
| 升级说明 | Upgrade Notes | 用户必须执行的升级操作、前置条件或已知限制 |
| 其他变更 | Other Changes | 必须对外说明的构建、维护或依赖调整；普通内部实现细节不列出 |

## 双语正文

- 先写完整中文分类，再用 `---` 分隔，按相同顺序写英文分类。
- 分类标题统一使用三级标题 `###`；版本内不使用 `##`，以免与 CHANGELOG 的版本边界混淆。
- 每条以 `- ` 开头，写清用户可见的变化。中文和英文分类、条目数量、顺序、事实及限制一一对应；版本、路径、命令等标识保持一致。
- 不虚构已完成的功能、修复、验证结果或贡献者，不直接堆砌提交信息。发布范围以本次实际快照为准。
- `CHANGELOG.md` 是正文的唯一编辑源；Actions 原样提取目标版本，供 Release 和 `latest.json` 的更新说明使用。

最小示例（演示格式，不代表待发布功能）：

```markdown
## [<版本>] - YYYY-MM-DD

### 新增功能

- 支持在应用内检查新版本。

### 问题修复

- 修复下载失败后无法重试的问题。

---

### New Features

- Check for new versions from within the app.

### Bug Fixes

- Fix retrying a download after it fails.
```

发布前运行 `node scripts/check-update-release.mjs v<版本>` 检查分类、顺序和双语条目配对；Agent 还需核对翻译含义一致。格式检查不能证明内容真实或翻译准确。
