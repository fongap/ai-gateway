# 文档治理

## 治理总原则

1. 正文中文优先。
2. 文件名统一英文 `kebab-case`。
3. 代码、配置字段、协议名、Git/GitHub 固有术语保留英文。
4. 一个文件一个长期职责。
5. 不创建临时状态型文档。
6. 规则变化直接修改原文件。
7. 已失效文档直接删除。
8. 历史通过 Git、PR、Release 和 CHANGELOG 追溯。

## 文档分类

| 分类 | 目录 | 职责 |
|---|---|---|
| 架构文档 | `docs/architecture/` | 定义长期稳定的系统边界 |
| 治理文档 | `docs/governance/` | 定义开发规则 |
| 运维文档 | `docs/operations/` | 定义具体操作 |

## 治理文件索引

| 文件 | 职责 |
|---|---|
| [development-policy.md](development-policy.md) | 分支、提交、PR、Review 规则 |
| [quality-policy.md](quality-policy.md) | CI、测试、安全扫描、验证要求 |
| [dependency-policy.md](dependency-policy.md) | 依赖更新、Dependabot、自动合并规则 |
| [release-policy.md](release-policy.md) | 版本管理、发布流程、CHANGELOG 规则 |
| [documentation-policy.md](documentation-policy.md) | 文档与代码同步规则、CI 约束 |

## 禁止文件名

以下文件名在 `docs/` 中长期存在时被禁止：

```text
final-report.md
latest-policy.md
new-docs.md
xxx-v2.md
xxx-final.md
misc.md
temp.md
```

## 文档同步要求

代码变化必须同步更新对应文档。详见 [documentation-policy.md](documentation-policy.md)。
