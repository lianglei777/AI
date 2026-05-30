# FetchChain 深度解析：qclaw-plugin 的 LLM 请求拦截链

> OpenClaw 访问大模型只有一条路：`globalThis.fetch`。qclaw-plugin 用 **FetchChain** 把十几种「改请求、拦响应、假回复」的能力收进**一条**可预测的中间件链——本文专门讲这条链为什么存在、怎么跑、设计上有哪些取舍。  
> 想查模块地图请看 [01](./01-qclaw-plugin-architecture-research.md)；想跟一条消息的时间线请看 [02](./02-qclaw-plugin-data-journey.md)。  
> **本文目标：不读源码也能理解 FetchChain 的原理与扩展方式。**

---

## 写在前面

**qclaw-plugin** 对外是普通 OpenClaw 插件，对内是一套调度框架（见 [01](./01-qclaw-plugin-architecture-research.md)）。框架 core 层里与 Hook 并列的第二条管道，就是 **FetchChain**——它统一替换 `globalThis.fetch`，让各 Package 以中间件形式介入 LLM HTTP 请求。

**本文不讲：**

- OpenClaw 内核如何 emit Hook、UI 如何把 SSE 渲染成气泡（与 [02](./02-qclaw-plugin-data-journey.md) 一致，统一表述为「OpenClaw 在下列时机回调 / 调用 fetch」）。
- 15 个 Package 的完整分工表（见 01 §2.3、§5.4）。

**读完本文，你应能回答：**

- 为什么需要 FetchChain，而不是各 Package 各自包一层 fetch？
- FetchChain 的主要职责是什么，一次请求如何穿过链条？
- 洋葱模型、单例合并、shortCircuit、getOriginalFetch 等设计各自解决什么问题？
- 如何为 qclaw-plugin 新增一个 FetchMiddleware？

---

## 一、问题从何而来：为什么要有 FetchChain？

### 1.1 LLM 请求是唯一的 HTTP 出口

OpenClaw Agent 调用大模型时，走的是 Node/Electron 环境下的 **`globalThis.fetch`**。凡是「发出去之前改 body / header」「回来之后改 SSE 流」「网络失败时伪造响应」的逻辑，都必须挂在这条链上——Hook 管不了 request body，因为 Hook 发生在 OpenClaw 生命周期节点，例如 `llm_input` 能拿到 `sessionKey`，但拿不到即将 POST 的 `messages` 数组。

qclaw-plugin 因此把能力拆成 **两条管道**（[02](./02-qclaw-plugin-data-journey.md) 有完整旅程，这里只抽象分工）：

| 管道 | 框架组件 | 典型数据 | 典型动作 |
|------|---------|---------|---------|
| 生命周期 | HookProxy | sessionKey、toolName、runId | 审核上下文、排队入队、Span 采集 |
| 访问大模型 | FetchChain | URL、RequestInit.body、Response 流 | 改 messages、注入 header、流式审核、短路假回复 |

```mermaid
flowchart TB
  subgraph hookPipe [生命周期管道 HookProxy]
    H1[llm_input 排队上下文入队]
    H2[before_tool_call 授权]
  end
  subgraph fetchPipe [访问大模型管道 FetchChain]
    F1[改 messages / header]
    F2[审核 / 排队 / 优化]
    F3[originalFetch]
  end
  Agent[OpenClaw Agent] --> hookPipe
  Agent --> fetchPipe
  fetchPipe --> LLM[大模型服务]
```

没有 FetchChain 时，每个需要动 LLM 请求的 Package 只能自己 `globalThis.fetch = wrapper(globalThis.fetch)`。十几个模块叠在一起，顺序等于加载顺序，无法文档化，也无法保证「只包一层」。

### 1.2 无统一链时的三类工程灾难

| 问题 | 无框架时 | FetchChain 后 |
|------|---------|--------------|
| 拦截顺序 | 各 Package 各自包裹 fetch，嵌套顺序 = 模块加载顺序 | 单层链，`priority` 显式排序 |
| 重复包裹 | OpenClaw 为多 Agent / Gateway **多次**调用 `register()`，N 次 install → 同一请求被中间件处理 N 遍 | 进程级单例，后续实例**合并中间件**，不再替换 `globalThis.fetch` |
| 自拦截 | 中间件内部再 `fetch` 拉配置/上报，会被自己的链拦住甚至递归 | `ctx.getOriginalFetch()` 绕过链 |

FetchChain 的设计注释概括了洋葱顺序：**onRequest 按 priority 升序**，到达真实网络后 **onResponse 按 priority 降序**（兜底层 error-response-handler 的 50 在 onResponse 最外）。

OpenClaw 会为不同运行上下文（多 agent + gateway）多次调用插件的 `register()`，每次都会新建 FetchChain 实例。若不做单例保护，每次 install 都在已有拦截器外再套一层，用户发一条消息，审核、排队、优化会各跑 N 遍。

### 1.3 与 HookProxy 的对称设计

FetchChain 不是孤立发明，而是与 **HookProxy** 成对出现的基础设施（见 [01 §3.2](./01-qclaw-plugin-architecture-research.md)）：

- **HookProxy**：对每个 OpenClaw 事件名只调用一次 `api.on()`，内部按 `priority` 调度各 Package 的 handler，统一管理 `block` 语义。
- **FetchChain**：对 `globalThis.fetch` 只替换一次，内部按 `priority` 做洋葱调度，统一管理 `shortCircuitResponse`。

两条管道共享同一套 **priority 产品语义**：观测(100) → 安全(200/250) → 排队(300) → 业务(900) → 调试(950)；兜底层 error-response-handler 的 priority 50 在 **onResponse 逆序时最后执行**（最外层包装 HTTP 错误）。数字表以 [02 附录](./02-qclaw-plugin-data-journey.md#appendix-dev) 为准。

---

## 二、FetchChain 是什么：主要职责

FetchChain 承担三件事：

1. **安装点** — `install()` 保存原始 fetch，用拦截函数替换 `globalThis.fetch`；通过 `Object.assign(interceptor, originalFetch)` 保留 Node.js 22+ 上 fetch 的静态属性（如 `preconnect`）。
2. **注册点** — Package 在 `setup(ctx)` 里调用 `ctx.registerFetchMiddleware()`，框架不直接把 OpenClaw API 暴露给 Package。
3. **执行点** — 每次 `fetch()` 进入私有方法 `execute()`，驱动洋葱链；若无任何匹配的中间件，直调 `originalFetch`。

### 2.1 生命周期：从 register 到 install

插件入口在每次 OpenClaw 调用 `register(api)` 时：

1. 创建 FetchChain 实例
2. 依次为 15 个 Package 创建 `QClawContext` 并执行 `setup(ctx)`（各 Package 在此注册中间件）
3. **最后**无条件 **install()**，替换全局 `fetch`（仅进程内第一次真正替换；后续 register 合并中间件）

Package 通过 `ctx.registerFetchMiddleware(...)` 注册，无需直接操作 `globalThis.fetch`。

```mermaid
sequenceDiagram
  participant OC as OpenClaw register
  participant IDX as index.ts
  participant FC as FetchChain
  participant PKG as Packages

  OC->>IDX: register(api) 可能多次
  IDX->>FC: new FetchChain()
  loop 每个 Package
    PKG->>FC: register(middleware)
  end
  IDX->>FC: install() 仅全局一次有效
  Note over FC: globalInstance 单例 / 后续实例合并
```

启动完成后，控制台 `register() END` 一行会打印已加载中间件及 priority，例如：

`middlewares=[trace-span-reporter(250), content-plugin(200), queue-guard(300), …]`

---

## 三、执行模型：一次 fetch 如何穿过链条

本章是全文技术核心。下列行为由 FetchChain 的 **execute** 流程驱动（匹配中间件 → onRequest → 可选短路 → 真实 fetch → onResponse 逆序）。

**扩展上线前检查清单（实践要点）：**

- 内部 HTTP 是否使用 **`getOriginalFetch()`**？（拉配置、上报、调审核 API）
- `match` 是否窄化到 LLM 请求，并排除自身服务 URL？
- onRequest / onResponse 异常是否 **fail-open**（返回原 ctx / response）？
- 需拦截用户可见回复时，优先 **`shortCircuitResponse`** 而非 throw？
- priority 是否与 content(200)、queue-guard(300)、optimizer(900) 等协调？对照 [02 附录](./02-qclaw-plugin-data-journey.md#appendix-dev)。
- 需对照接口字段时，见 [附录 A（可选）](#附录-a可选fetchmiddleware-接口速查)。

### 3.1 洋葱模型四阶段

| 阶段 | 遍历方向 | 触发条件 |
|------|---------|---------|
| onRequest | priority **升序** | 中间件实现了 `onRequest` |
| originalFetch | — | onRequest 结束后**没有** `ctx.shortCircuitResponse` |
| onResponse | priority **降序** | 中间件实现了 `onResponse`（含短路后的假响应） |
| onError | priority **降序** | `originalFetch` 抛错；**首个**返回 `Response` 的 `onError` 结束链条 |

```mermaid
flowchart LR
  subgraph req [onRequest 正序]
    M100[priority 100]
    M200[priority 200]
    M900[priority 900]
    M100 --> M200 --> M900
  end
  OF[originalFetch]
  subgraph resp [onResponse 逆序]
    R900[priority 900]
    R200[priority 200]
    R50[priority 50]
    R900 --> R200 --> R50
  end
  M900 --> OF --> R900
```

**伪代码摘要：**

```
matched = middlewares.filter(m => !m.match || m.match(input, init))
if matched.empty → return originalFetch(input, init)

ctx = { input, init, extra: {} }
for mw in matched ascending:
  ctx = await mw.onRequest(ctx)  // 异常只打日志，不中断

if ctx.shortCircuitResponse:
  response = ctx.shortCircuitResponse
else:
  try: response = await originalFetch(ctx.input, ctx.init)
  catch: 逆序 onError，有 Recovery 则 return

for mw in matched descending:
  response = await mw.onResponse({ ..., response, extra: ctx.extra })

return response
```

### 3.2 关键机制

| 机制 | 类型定义 | 典型 Package |
|------|---------|-------------|
| `match()` 过滤 | `FetchMiddleware.match?` | queue-guard 跳过 GET；content-plugin 匹配 LLM POST |
| `extra` 跨阶段共享 | `FetchRequestContext.extra` | onRequest 写入，onResponse 同一次请求内读取 |
| `shortCircuitResponse` | `FetchRequestContext` | content-plugin 输入审核 BLOCK；queue-guard 用户取消排队 |
| `onError` 恢复 | `FetchErrorContext` | 单测：network error → 中间件返回 recovered Response |
| 错误不阻断 | `execute` 内 try/catch | onRequest/onResponse 抛错只打 `[diag]` 日志，继续下一个 |

**shortCircuit 与 Hook block 的区别**（[02](./02-qclaw-plugin-data-journey.md) 从用户旅程讲过，这里从 FetchChain 视角重述）：

- Hook `{ block: true }`：同一事件后续 handler **不再执行**。
- Fetch `shortCircuitResponse`：**不发起真实 HTTP**，但仍有 `response` 对象，**继续走 onResponse 逆序**——例如 error-response-handler 仍可在最外层包装错误形态。

### 3.3 execute 流程三步（实现摘要）

1. **匹配**：仅 `match` 为真（或未定义 match）的中间件参与；若无匹配，直接调用原始 fetch。
2. **onRequest 正序**：依次改写 `input` / `init` / `extra`；某步设置 `shortCircuitResponse` 则**跳过真实 HTTP**，但仍进入 onResponse；单步抛错只记诊断日志，不中断链条。
3. **onResponse 逆序**：从大到小 priority 处理响应体；可通知 observer（供 prompt-inspector 等）；error-response-handler(50) 在最外包裹 HTTP 错误为 SSE。

---

## 四、设计特点：FetchChain 的工程取舍

| 特点 | 行为 | 为什么 |
|------|------|--------|
| **进程级单例 + 合并** | 第二次 install 只把中间件并入已安装实例，不再套一层 `globalThis.fetch` | 避免多次 register 导致同一请求跑 N 遍 |
| **共享中间件列表** | 多实例指向同一份 middlewares 数组 | 合并语义要求「后注册的模块进入同一链条」 |
| **priority 显式调度** | 与 PACKAGES 初始化顺序无关 | 架构决策应写在数字上，见 [02 附录](./02-qclaw-plugin-data-journey.md#appendix-dev) |
| **同 id 覆盖** | 重复 register 同 id 中间件时替换旧实例 | 支持热更新、重复 setup |
| **延迟注册** | install 之后仍可 register，下次 fetch 即生效 | 异步 setup 补注册 |
| **错误隔离 + fail-open** | 中间件抛错只记诊断日志，不拖垮 Agent；queue-guard 等异常时放行 | 与 [01 初始化不拖垮整插件](./01-qclaw-plugin-architecture-research.md) 同属「可用性优先」；**不等于**放弃内容审核策略（见 [05](./05-qclaw-content-security-compliance.md)） |
| **getOriginalFetch** | 拉配置、审核、上报等内部 HTTP 必须绕过链条 | 防递归与「审核请求审到自己」；prompt-optimizer、pcmgr、error-response-handler 等 |
| **可观测** | `onMiddlewareExecuted`、启动日志中的 middleware 列表 | prompt-inspector 等调试链；日志 URL 仅打 path 末段 |

---

## 五、实战：7 个 Package 的 FetchMiddleware 如何协作

[02「等模型回复时」](./02-qclaw-plugin-data-journey.md#等模型回复时请求经过哪些关卡) 从用户视角列过关卡表；本节从 **FetchChain 机制** 对照同一张表，并展开三个典型案例。当前活跃 **7 个 Package** 注册了 FetchMiddleware（error-response-handler 几乎只做 onResponse）。

### 5.1 总表

与 [02 §出门](./02-qclaw-plugin-data-journey.md#出门请求一层层过) 一致；有变更时**只改 02 附录**。

| priority | Package | onRequest | onResponse |
|:--------:|---------|-----------|------------|
| 50 | error-response-handler | — | **最后**：HTTP 4xx/5xx → Anthropic SSE 形态 |
| 100 | qmemory | 崩溃恢复时向 `messages` 注入恢复说明 | — |
| 200 | content-plugin | 输入审核；违规设 `shortCircuitResponse` | 流式输出审核（SSE Transform） |
| 250 | trace-span-reporter | 注入 `x-agent-request-id` | — |
| 250 | pcmgr-ai-security | Prompt/Skill AI 审计（Fail-Open） | — |
| 300 | queue-guard | 轮询排队；abort 时 `shortCircuitResponse` | — |
| 900 | prompt-optimizer | 路径占位符、重排 system messages | — |
| 950 | prompt-inspector | — | **最先**：调试环境下抓 raw 响应 |

onRequest 走 priority 升序；onResponse 走降序，故 950 先于 200，50 包在最外层。

### 5.2 案例 A：content-plugin 输入拦截（shortCircuit）

输入审核未通过时，**不调用真实 LLM**：content-plugin 在 onRequest 里组装一段 **SSE 形态的假响应**（HTTP 200 + `text/event-stream`），写入 `shortCircuitResponse` 并返回。

FetchChain 看到短路标记后跳过真实 fetch，但仍走 onResponse 逆序——输出侧仍可继续处理；本例 status 为 200，通常不会触发 error-response-handler 的 HTTP 错误包装。

### 5.3 案例 B：queue-guard 跨层桥接

Fetch 中间件拿不到 Hook 上下文里的 `sessionKey`，queue-guard 在 **`llm_input` Hook（priority 300）** 里 `pushPendingContext(sessionKey, …)` 入 FIFO，在 **Fetch onRequest（priority 300）** 里 `shiftPendingContext()` 取出配对。

- 排队通过：正常 `return reqCtx`，链条继续 `originalFetch`。
- 用户 abort：设置 `shortCircuitResponse` 为模拟 LLM 响应，避免向用户抛 HTTP 错误。
- 排队接口异常：**fail-open**，`return reqCtx` 放行。

这是典型的 **Hook → 内存队列 → Fetch** 桥接模式（详见第六章）。

### 5.4 案例 C：prompt-optimizer 为何排 900

priority 900 使 onRequest **排在安全（200/250）与排队（300）之后**：先完成输入审核与 AI 审计，再改 system messages，避免未审核内容被优化器改写后漏检。

Package 内部拉远端优化策略时使用 `ctx.getOriginalFetch()`，注释明确写明「绕过 FetchChain 避免递归」。`processRequestBody` 异常时降级为放行原始 body，不阻断链条，同样遵循 fail-open。

---

## 六、FetchChain 与 Hook 的协作模式

扩展 Package 时，常需要在两条管道间传递上下文。当前代码里可归纳两种模式：

### 6.1 上下文桥接（Hook 写 → Fetch 读）

| 模块 | Hook 侧 | Fetch 侧 |
|------|---------|---------|
| queue-guard | `llm_input`：`pushPendingContext` | onRequest：`shiftPendingContext`、轮询排队 |
| pcmgr-ai-security | `llm_input`：记录 sessionKey 等 | onRequest：读 session 维度审计上下文 |

```mermaid
sequenceDiagram
  participant HP as HookProxy
  participant QG as queue-guard
  participant FC as FetchChain
  participant LLM as LLM

  HP->>QG: llm_input pushPendingContext
  Note over QG: sessionKey 仅 Hook 层可见
  FC->>QG: onRequest shiftPendingContext
  QG->>LLM: 排队通过后 originalFetch
```

### 6.2 职责拆分（Hook 决策 → Fetch 执行）

**qmemory**：Hook 阶段（`before_prompt_build` / tool 相关 Hook）写 WAL、arm 恢复模式；真正改发往后端的 `messages` 在 Fetch **priority 100** 的 onRequest 里注入恢复说明。Hook 负责「要不要恢复」，Fetch 负责「怎么改 HTTP body」。

设计 implication：若你的功能既需要 session 生命周期又需要改 LLM 请求体，应显式拆成 Hook 段 + Fetch 段，而不是在 Fetch 里猜测 session 状态。

---

## 七、扩展指南：如何新增 FetchMiddleware

在 Package 的 `setup(ctx)` 中调用 `ctx.registerFetchMiddleware({ id, priority, match?, onRequest?, onResponse?, onError? })`：

| 字段 | 要点 |
|------|------|
| `id` | 全局唯一；重复注册覆盖旧实例 |
| `priority` | 对照 [02 附录](./02-qclaw-plugin-data-journey.md#appendix-dev) |
| `match` | 建议窄化到 LLM POST；排除自身审核/配置 URL |
| `onRequest` | 可改 body/header；拦截用 `shortCircuitResponse`，勿轻易 throw |
| `onResponse` | 逆序执行；可包装 SSE 流 |
| `onError` | 可选：originalFetch 失败时返回恢复用 Response |

将 Package 加入 **PACKAGES** 列表即可；检查清单见 [§三 实践要点](#三执行模型一次-fetch-如何穿过链条)；字段契约见 [附录 A（可选）](#附录-a可选fetchmiddleware-接口速查)。

---

## 八、如何验证与调试（无需读单测文件）

1. 启动 QClaw 后，在控制台搜 **`[qclaw-plugin] register() END`**，确认 `middlewares=[id(priority), ...]` 与 [02 附录 B](./02-qclaw-plugin-data-journey.md#b-fetch-middleware-priority升序--onrequest-顺序) 一致。
2. 搜 **`[qclaw-plugin:fetch-chain] [diag]`**：`SHORT_CIRCUIT` 表示未发真实 LLM；`onRequest ERROR` 等表示单步 fail-open 继续。
3. 开发环境可开 **prompt-inspector**（三层门控），观察各中间件对 Response 的修改链。
4. **Hook `block`** 与 **Fetch `shortCircuit`** 是两套机制：前者看 HookProxy 的 `dispatch(...) BLOCKED` 日志。

---

## 九、总结

| 问题 | 答案 |
|------|------|
| **为什么要有 FetchChain？** | 多 Package 共享唯一 `globalThis.fetch` 出口；OpenClaw 多次 `register()` 不能多层嵌套；需要显式 priority、避免自拦截、与 HookProxy 对称的统一调度。 |
| **主要用途是什么？** | 在 LLM HTTP 发出前/返回后串联审核、排队、Prompt 优化、链路追踪、错误翻译等能力；支持短路假响应与 onError 恢复。 |
| **设计特点是什么？** | 洋葱模型（onRequest 升序 / onResponse 降序）；进程级单例与中间件合并；模块级共享列表；id 去重与延迟注册；中间件错误隔离与 fail-open；`getOriginalFetch` 逃生舱；`onMiddlewareExecuted` 可观测。 |

**与系列衔接：**

- 读完本文后，建议回读 [02 §等模型回复时](./02-qclaw-plugin-data-journey.md#等模型回复时请求经过哪些关卡)，把表中每一行对应到本文 execute 三步的某一环。
- 模块全景见 [01](./01-qclaw-plugin-architecture-research.md)；priority 表见 [02 附录](./02-qclaw-plugin-data-journey.md#appendix-dev)。

---

## 附录 A（可选）：FetchMiddleware 接口速查

> 准备**扩展或审计** Fetch 中间件时使用；只读系列正文的读者可跳过。注册步骤见 [§七](#七扩展指南如何新增-fetchmiddleware)。

| 类型 / 字段 | 含义 |
|-------------|------|
| **FetchRequestContext** | `onRequest` 入参：`input`、`init`、`extra`；可设 **`shortCircuitResponse`** 跳过真实 LLM HTTP |
| **FetchResponseContext** | `onResponse` 入参：含 `response`、`extra`（与本次 onRequest 共享） |
| **FetchErrorContext** | `onError` 入参：`error`、`extra`；若返回 `Response` 则结束链条，不再向上抛 |
| **FetchMiddleware.id** | 全局唯一；同 id 再次注册会**覆盖**旧中间件 |
| **FetchMiddleware.priority** | onRequest **升序**；onResponse / onError **降序** |
| **FetchMiddleware.match** | 可选；返回 false 则本中间件不参与本次 fetch |
| **onRequest / onResponse / onError** | 均为可选异步钩子；单步异常应 fail-open，不拖垮 Agent |

---

## 附录 B：概念索引（可选·对照实现）

| 概念 | 在链条中的角色 |
|------|----------------|
| FetchChain | 替换 `globalThis.fetch` 的执行器；install / execute / 单例合并 |
| FetchMiddleware | 可插拔单元：match、onRequest、onResponse、onError |
| QClawContext.registerFetchMiddleware | Package 注册入口 |
| getOriginalFetch | 绕过链条的原始 fetch，防递归 |
| shortCircuitResponse | onRequest 设假响应，跳过真实 LLM HTTP |
| onError | originalFetch 失败时按 priority 降序尝试恢复；首个返回 Response 的钩子结束链条 |
| onMiddlewareExecuted | 调试观测：谁改了 Response |

需要对照具体实现时，再在安装目录 qclaw-plugin 下查看 core 与 packages（0.2.5+ 可能已混淆）。

---

## 附录 C：术语表

| 术语 | 说明 |
|------|------|
| FetchChain | 替换 `globalThis.fetch` 的中间件链执行器 |
| FetchMiddleware | 实现 onRequest/onResponse/onError 的可插拔单元 |
| priority | 数字越小，onRequest 越先执行；onResponse 越后执行 |
| 洋葱模型 | 请求阶段正序、响应阶段逆序的中间件模式 |
| shortCircuitResponse | onRequest 设假 Response，跳过真实 HTTP |
| match | 可选 URL/方法过滤器；false 则跳过该中间件 |
| extra | 同一次 fetch 内 onRequest 与 onResponse 共享的键值 bag |
| getOriginalFetch | 绕过链的原始 fetch，防递归与自拦截 |
| fail-open | 出错或异常时放行请求，避免整助手不可用 |
| originalFetch | FetchChain 保存的、未被替换的 fetch 引用 |

---

*文档基于 QClaw 安装目录下未混淆的 qclaw-plugin 源码整理；若本地版本已压缩，请以同版本安装包内路径为准。*
