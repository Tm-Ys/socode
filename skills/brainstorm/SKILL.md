---
name: brainstorm
description: >
  写功能、改行为、做设计之前先对齐意图。分类 spike / bounded / architectural，
  先设计并得到用户明确同意，再动手实现。
disable-model-invocation: true
source: https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md
---

# Brainstorm

把想法收成可执行的设计。动手之前先告诉用户你打算怎么做，等到明确同意。

仪式可以随任务缩小，批准门不能省。

## 先分类，并说出来

- **Spike**：可行性问题。2–3 句说明要探什么，点头后用最便宜的方式验证。产出是建议，代码标成抛弃。
- **Bounded**：仓库里已有这条流程，小改（一个 flag、一个小接口、单文件）。聊天里短设计（做法、文件、怎么测），停下来等 yes。不写 spec 文件。
- **Architectural**：新项目、新子系统、改接口或结构。问清楚 → 2–3 个方案和推荐 → 分段设计并逐段确认 → 再实现。

两可时走更重的那条。中途发现更复杂：停、说出来、升级。中途不降级。

「太简单不用设计」是反模式。简单只表示设计可以短到两句，不是跳过批准。

## Bounded / Architectural

1. 先看现有文件、结构和近期改动，跟仓库走，不发明平行体系。
2. 一次一个关键问题（目的、约束、成功标准）。能查的自己查。
3. 给出短设计后再停。同一条回复里「设计完立刻开写」算跳过门。
4. 多个独立子系统时先拆，不要在一个设计里吞掉整个平台。
5. YAGNI：每个方案都删掉现在不需要的。

Architectural 才写书面 spec（用户指定路径，否则不要为了仪式新建 `docs/superpowers/`）。用户要看文件就等文件批准。

## 实现

Spike：只交建议。Bounded：批准后按正常开发做，小步、可验证。Architectural：批准后才能写代码；不要假装已经批准。

用户说先别改、先讨论、先设计时，停在设计。
