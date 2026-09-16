---
name: grill-me
description: >
  需求或方案还含糊时，按决策树一轮一轮追问，直到没有静默假设。
  查事实用工具，做决定问用户。未达成共识前不要动手改代码。
disable-model-invocation: true
source: https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md
---

# Grill me

把计划、决策或想法烤清楚。工作方式是一棵**设计树**：每个决定下面挂着依赖它的决定。

## 轮次

**前沿** = 前提已经定下来、现在就能问、不必猜未回答的题。一轮问完整前沿。有预设选项的决策调用 `question`（每题带选项，推荐项放第一并在 label 加 `(Recommended)`；不要自己加「其他」，系统会追加 Type your own answer。多选时它是倒数第二，最后一项是提交答案）。没有合适选项的开放题才写成聊天问句。

```
调用 question：
- header: 短标签
- question: 题干
- options: [{ label, description }, …]
```

用户一答，树就变：已决的点把前沿往外推。本题答案还依赖本轮另一题 → 放到下一轮。

## 规则

- 事实归你：文件系统、代码、报错，自己查或开只读探索，不要问用户能查到的东西。
- 决定归用户：每个分叉都摊开，等确认。
- 前沿空了才结束：每条分支都走过，没有默许假设。
- 用户确认「我们达成共识」之前，不要实现、不要写文件、不要「先做一版再说」。

任务已经非常具体（改哪、怎么测都齐）就不要为了仪式再烤一轮。
