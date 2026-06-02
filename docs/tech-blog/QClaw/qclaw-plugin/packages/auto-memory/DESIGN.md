# auto-memory 插件技术方案

> 创建日期: 2026-04-05
> 状态: 实施中

## 核心目标

在 `qclaw-plugin/packages/` 下实现 `auto-memory` package，通过 Hook 采集对话、LLM 提取记忆事实，**异步**写入各 agent 独立 workspace 的 MEMORY.md 和 memory/YYYY-MM-DD.md。

## 核心认知

1. **MEMORY.md 是给大模型读的** — AI 在 session 启动时通过 `read_file` 工具读取，格式以大模型可读性为第一优先级
2. **MEMORY.md 支持更新（修改/删除/合并）** — OpenClaw AGENTS.md 模板明确说 "You can read, edit, and update MEMORY.md freely"
3. **memory/YYYY-MM-DD.md 是 append-only** — healthcheck skill 明确要求 "Append-only: never overwrite existing entries"
4. **完全异步、不阻塞对话** — 记忆提取全程 fire-and-forget，零延迟影响

---

## 1. 工作区隔离

| Agent | workspace 目录 | 路径计算 |
|-------|---------------|---------|
| main | `~/.qclaw/workspace/` | `OPENCLAW_STATE_DIR/workspace` |
| agent-xxx | `~/.qclaw/workspace-agent-xxx/` | `OPENCLAW_STATE_DIR/workspace-${agentId}` |

通过 hook context 的 `ctx.agentId` + `reader.ts` 中的 `getWorkspaceDirName()` 逻辑保持一致。

---

## 2. 文件格式

### MEMORY.md — 面向大模型的自由格式

```markdown
# Long-Term Memory

## 用户身份与偏好
- 用户偏好中文回复，简洁直接
- 用户是 QClaw 项目的核心开发者

## 当前项目与关注
- 正在开发 auto-memory 自动记忆提取插件

## 经验与决策
- 纯 AGENTS.md prompt 引导无法 100% 保证模型执行记忆写入
```

### memory/YYYY-MM-DD.md — 面向大模型的日工作记录

```markdown
# 2026-04-05 工作记录

## 完成的工作
- 分析了 lossless-claw 压缩率改动

## 讨论与决策
- 确认 AGENTS.md 纯 prompt 方案不可靠，决定用插件层处理

## 待跟进
- 实现 auto-memory 插件
```

---

## 3. 两路 LLM 提取

### Prompt A — 长期记忆（→ MEMORY.md）

- 输出 JSON：`{ add: [...], update: [...], remove: [...] }`
- 传入当前 MEMORY.md 内容，LLM 判断重复、更新、删除
- 支持三种操作：新增 / 修改旧条目 / 删除过时条目

### Prompt B — 实质工作记录（→ memory/YYYY-MM-DD.md）

- 输出纯文本标签行：`[完成]`、`[讨论]`、`[待跟进]`
- append-only 写入

---

## 4. 异步执行策略

- `llm_input` / `llm_output`: 同步 buffer push，O(1)
- `agent_end`: 同步判断 + fire-and-forget Promise
- LLM 调用 + 文件写入在后台 Promise 链中完成
- 失败静默降级，只 log warning
- 同一 agent 写入操作串行化（写入锁），不同 agent 互不影响
- 整体超时 30 秒

---

## 5. 触发条件

- 每 N 轮触发（N=3，可配置）
- agent_end 兜底（≥1 轮未处理 turns）
- 同一 session 最短间隔 60 秒
- 两路提取并行（Promise.allSettled）

---

## 6. 预筛策略

- 单轮且双方都极短（< 20 字）的纯寒暄 → 跳过
- assistant 回复全部无自然语言内容（纯工具输出）→ 跳过
- 不按字符数过滤（短消息也可能有价值）

---

## 7. LLM 调用

通过本地 gateway 调用（复用 modelroute）：
- `ctx.getOriginalFetch()` → `http://127.0.0.1:{port}/v1/chat/completions`
- model: `qclaw/modelroute`
- temperature: 0

---

## 8. 文件结构

```
packages/auto-memory/
├── DESIGN.md             # 本文件
├── index.ts              # QClawPackage 入口
└── src/
    ├── types.ts          # 配置、SessionBuffer、MemoryOperation
    ├── collector.ts      # llm_input/llm_output hook → buffer
    ├── extractor.ts      # 两路 LLM 调用 + prompt + JSON 解析
    ├── writer.ts         # MEMORY.md 智能更新 + daily append-only
    ├── filter.ts         # 预筛逻辑
    └── consolidator.ts   # 定时固化器（路径 C）
```

---

## 9. 配置项

```typescript
interface AutoMemoryConfig {
  enabled?: boolean                    // 默认 true
  triggerEveryNTurns?: number         // 默认 3
  minTriggerIntervalSeconds?: number  // 默认 60
  writeLongTermMemory?: boolean       // 写 MEMORY.md，默认 true
  writeDailyMemory?: boolean          // 写 memory/日期.md，默认 true
  consolidateIntervalMinutes?: number // 固化间隔（分钟），默认 720（12 小时）
  consolidateLookbackDays?: number    // 固化回看天数，默认 2
  enableConsolidation?: boolean       // 启用定时固化，默认 true
}
```

---

## 10. 路径 C — 定时固化器（Consolidator）

### 定位

路径 C 是对路径 A（实时长期记忆提取）的**补充**，不替代 A。

- **路径 A**：每 N 轮对话 → LLM 即时从对话内容提取 → 写入 MEMORY.md（反应快，视野窄）
- **路径 B**：每 N 轮对话 → LLM 从对话内容提取 → 写入 memory/YYYY-MM-DD.md（日记）
- **路径 C**：定时器 → 综合近 N 天日记 + MEMORY.md → LLM 补充遗漏 → 写入 MEMORY.md（视野广，固化补充）

### 核心原则

1. **只做补充（add）** — 不修改、不删除已有 MEMORY.md 中的记忆
2. **MEMORY.md 作为去重上下文** — 将完整 MEMORY.md 传入 Prompt C，LLM 看到已有记忆后自行跳过重复内容
3. **全量读取近 N 天日记** — 不使用水位线机制，靠 MEMORY.md 上下文去重

### 触发机制

- `setInterval` 定时器，每 X 分钟执行一次（默认 10 分钟）
- 首次延迟 2 分钟执行（等系统稳定）
- 在 `setup()` 中启动，在 `teardown()` 中清理
- 遍历 stateDir 下所有 workspace* 目录（支持多 agent）

### 防冲突

路径 A 和路径 C 都通过 `applyMemoryOperations` → `withWriteLock` 写入 MEMORY.md，串行保证，天然防冲突。

### 跳过条件

- 日记内容长度 < 50 字 → 跳过（内容太少不值得 LLM 调用）
- 无法解析 gateway 信息 → 跳过
