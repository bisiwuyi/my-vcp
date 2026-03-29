---
Status: Active
Module: Core
Impact: VCP 2.0 自我进化回路核心插件
Ritsu_Action: 需同步到记忆
---

# OpenCodeArchitect 插件开发规范

**版本**: v2.2.0
**创建日期**: 2026-03-27
**最后更新**: 2026-03-29

## 一、 插件核心定位

OpenCodeArchitect 是 VCP 系统的"手术台"。它将 VCP 的中枢意志（Ritsu）与专业级 AI 编码能力（OpenCode）连接起来。

| 角色 | 职能 |
|------|------|
| **Ritsu** | 诊断系统瓶颈、下达架构指令、分析逻辑可行性、进行最终功能验收 |
| **OpenCode** | 阅读代码上下文、生成 Diff 补丁、执行物理文件写入、处理代码依赖 |

## 二、 核心特性：多 Agent 多话题

### 2.1 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenCodeArchitect                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Agent: Ritsu                                               │
│  ├── Topic-001: server.js 优化                              │
│  │   └── OpenCode Session (ses_xxx)                         │
│  │       └── 独立的上下文和历史                             │
│  │                                                          │
│  ├── Topic-002: Plugin.js 分析                              │
│  │   └── OpenCode Session (ses_yyy)                         │
│  │       └── 独立的上下文和历史                             │
│  │                                                          │
│  └── Topic-003: 文档编写                                    │
│      └── OpenCode Session (ses_zzz)                         │
│          └── 独立的上下文和历史                             │
│                                                             │
│  Agent: Nova                                                │
│  └── Topic-001: Nova 的任务                                 │
│      └── OpenCode Session (ses_aaa)                        │
│          └── 独立的上下文和历史                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 话题特性

| 特性 | 说明 |
|------|------|
| **完全隔离** | 每个话题有独立的 OpenCode 会话，上下文不共享 |
| **并发支持** | Agent 可以同时进行多个话题 |
| **持久化** | 话题数据存储在 `.opencode_topics.json` |
| **显式关闭** | 话题不会自动关闭，需要显式调用 `closeTopic` |
| **标题自定义** | 可以为主题设置描述性标题 |

### 2.3 存储结构

```javascript
// .opencode_topics.json
{
  "ritsu": {
    "topic-001": {
      "sessionId": "ses_xxx...",
      "sessionTitle": "VCP-Ritsu-20260328-001",
      "title": "server.js 优化",
      "summary": "",
      "status": "active",
      "messageCount": 5,
      "createdAt": 1743120000000,
      "lastActive": 1743123000000
    }
  },
  "nova": {
    "topic-001": {
      ...
    }
  }
}
```

## 三、 API 指令集

### 3.1 chat - 对话模式（核心）

与 OpenCode LLM 持续对话。**每个话题使用独立的 OpenCode 会话**。

```javascript
await OpenCodeArchitect.chat(message, options)
```

**输入参数**:
| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| message | string | ✅ | 发送给 OpenCode 的消息 |
| agentId | string | ❌ | Agent 标识符，默认 "default" |
| topicId | string | ❌ | 话题 ID，不指定则使用最新活跃话题或创建新话题 |
| title | string | ❌ | 创建新话题时的标题 |
| timeout | number | ❌ | 超时时间（毫秒），默认 600000 |

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "status": "success|error|timeout",
    "answer": "对话回答内容",
    "pid": 12345,
    "topicId": "topic-xxx",
    "title": "server.js 优化",
    "isNewTopic": false,
    "duration": 1234
  }
}
```

> **注意**: `result.status` 可能为 `timeout`，但外层 `status` 会被映射为 `error`，这是 Plugin.js 契约要求（只接受 success/error）。

**使用示例**:
```javascript
// 创建新话题
chat("帮我优化 server.js 的性能", { agentId: "ritsu", title: "server优化" })

// 继续指定话题
chat("继续刚才的分析", { agentId: "ritsu", topicId: "topic-xxx" })

// 使用最新活跃话题
chat("再补充一些内容", { agentId: "ritsu" })
```

---

### 3.2 createTopic - 创建话题

为指定 Agent 创建全新的独立话题。

```javascript
await OpenCodeArchitect.createTopic(agentId, title)
```

**输入参数**:
| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| agentId | string | ✅ | Agent 标识符 |
| title | string | ❌ | 话题标题 |

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "topicId": "topic-xxx",
    "title": "server优化"
  }
}
```

---

### 3.3 listTopics - 列出话题

列出指定 Agent 的所有话题。

```javascript
await OpenCodeArchitect.listTopics(agentId)
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "topics": [
      {
        "topicId": "topic-001",
        "title": "server优化",
        "summary": "",
        "status": "active",
        "messageCount": 5,
        "createdAt": 1743120000000,
        "lastActive": 1743123000000
      }
    ]
  }
}
```

---

### 3.4 getTopic - 获取话题详情

获取指定话题的详细信息。

```javascript
await OpenCodeArchitect.getTopic(agentId, topicId)
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "topic": {
      "topicId": "topic-001",
      "sessionId": "ses_xxx",
      "sessionTitle": "VCP-Ritsu-20260328-001",
      "title": "server优化",
      "summary": "",
      "status": "active",
      "messageCount": 5,
      "createdAt": 1743120000000,
      "lastActive": 1743123000000
    }
  }
}
```

---

### 3.5 switchTopic - 切换话题

切换到指定话题，后续 chat 将使用该话题。

```javascript
await OpenCodeArchitect.switchTopic(agentId, topicId)
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "topicId": "topic-001",
    "title": "server优化",
    "message": "已切换到话题 \"server优化\""
  }
}
```

---

### 3.6 closeTopic - 关闭话题

显式关闭指定话题，释放 OpenCode 会话。

```javascript
await OpenCodeArchitect.closeTopic(agentId, topicId)
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "success": true,
    "message": "话题 \"server优化\" 已关闭"
  }
}
```

---

### 3.7 interrupt - 中断模式

立即关闭 OpenCode 进程，终止当前对话。

```javascript
await OpenCodeArchitect.interrupt(pid)
```

**输入参数**:
| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| pid | number | ✅ | 要中断的进程 PID |

> **注意**: `activeProcesses` 已改为内部实例属性，不再需要外部传递。

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "status": "success",
    "message": "已终止 PID 为 12345 的 OpenCode 进程"
  }
}
```

---

### 3.8 pause - 暂停任务

暂停运行中的任务（通过 SIGSTOP/SIGCONT 信号）。

```javascript
await OpenCodeArchitect.pause(taskId)   // 或 pid
```

**输入参数**:
| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| taskId | string | ❌ | 任务 ID（二选一） |
| pid | number | ❌ | 进程 PID（二选一） |

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "taskId": "task-xxx",
    "pid": 12345,
    "message": "已暂停任务 task-xxx"
  }
}
```

---

### 3.9 resume - 恢复任务

恢复暂停的任务。

```javascript
await OpenCodeArchitect.resume(taskId)  // 或 pid
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "taskId": "task-xxx",
    "pid": 12345,
    "message": "已恢复任务 task-xxx"
  }
}
```

---

### 3.10 getTaskStatus - 获取任务状态

获取指定任务的状态信息。

```javascript
await OpenCodeArchitect.getTaskStatus(taskId)
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "task": {
      "taskId": "task-xxx",
      "status": "running|paused|completed|failed|timeout",
      "pid": 12345,
      "agentId": "ritsu",
      "topicId": "topic-xxx",
      "startTime": 1743120000000,
      "elapsed": 5000,
      "progress": { "stage": "分析中", "stageIndex": 2 }
    }
  }
}
```

---

### 3.11 listTasks - 列出任务

列出所有运行中的任务。

```javascript
await OpenCodeArchitect.listTasks(agentId)  // agentId 可选
```

**输出结果**:
```json
{
  "status": "success",
  "result": {
    "tasks": [...],
    "count": 3
  }
}
```

---

## 四、 VCP 工具调用格式

### 4.1 chat 调用

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」OpenCodeArchitect「末」,
command:「始」chat「末」,
message:「始」帮我分析 server.js 的代码结构「末」,
agentId:「始」ritsu「末」,
title:「始」server.js分析「末」,
timeout:「始」300000「末」
<<<[END_TOOL_REQUEST]>>>
```

### 4.2 话题管理调用

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」OpenCodeArchitect「末」,
command:「始」listTopics「末」,
agentId:「始」ritsu「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」OpenCodeArchitect「末」,
command:「始」createTopic「末」,
agentId:「始」ritsu「末」,
title:「始」新任务「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」OpenCodeArchitect「末」,
command:「始」switchTopic「末」,
agentId:「始」ritsu「末」,
topicId:「始」topic-xxx「末」
<<<[END_TOOL_REQUEST]>>>

<<<[TOOL_REQUEST]>>>
tool_name:「始」OpenCodeArchitect「末」,
command:「始」closeTopic「末」,
agentId:「始」ritsu「末」,
topicId:「始」topic-xxx「末」
<<<[END_TOOL_REQUEST]>>>
```

## 五、 使用场景

### 5.1 Ritsu 并行处理多个任务

```
你: Ritsu，帮我同时做两件事：
  1. 优化 server.js 的性能
  2. 分析 Plugin.js 的架构

Ritsu: 
  - 创建话题 "server优化" → topic-001
  - 创建话题 "Plugin分析" → topic-002
  - 并行使用 OpenCode 处理两个话题
```

### 5.2 话题切换

```
你: Ritsu，切换到 "Plugin分析" 话题
Ritsu: 已切换到话题 "Plugin分析" (topic-002)
你: 继续上次的工作
```

### 5.3 话题关闭

```
你: Ritsu，关掉 "server优化" 话题吧
Ritsu: 已关闭话题 "server优化"
```

## 六、 文件结构

```
Plugin/OpenCodeArchitect/
├── plugin-manifest.json    # 插件契约 (v2.1.0)
├── index.js              # 主入口 (1721行，含所有优化)
├── diff-analyzer.js      # Diff 安全分析器
├── PROMPTS.md            # Ritsu Diff 分析协议
└── README.md             # 本文档 (546行)

运行时文件：
├── .opencode_topics.json  # 话题元数据
└── .opencode_session_*   # 各话题的 OpenCode session ID
```

### 插件契约 (v2.1.0)

| 命令 | 说明 |
|------|------|
| chat | 对话模式（核心，所有操作通过自然语言完成） |
| createTopic | 创建话题 |
| listTopics | 列出话题 |
| getTopic | 获取话题详情 |
| switchTopic | 切换话题 |
| closeTopic | 关闭话题 |
| interrupt | 中断模式 |
| pause | 暂停任务 |
| resume | 恢复任务 |
| getTaskStatus | 获取任务状态 |
| listTasks | 列出任务 |

## 七、 已知限制

| 限制 | 说明 |
|------|------|
| 话题不自动清理 | 需要显式调用 closeTopic 关闭话题 |
| session 依赖 OpenCode | 实际会话由 OpenCode 管理 |
| 超长上下文 | OpenCode 有上下文长度限制 |

## 八、 更新日志

### v2.2.0 (2026-03-29) - 简化命令集

#### 重大变更
- 移除 `consult`、`apply`、`initialize` 三个专用命令
- 所有操作统一通过 `chat` 对话模式完成
- 通过自然语言描述即可完成分析、修改、知识同步等操作

#### 保留命令 (11个)
- chat、createTopic、listTopics、getTopic、switchTopic、closeTopic
- interrupt、pause、resume、getTaskStatus、listTasks

### v2.1.0 (2026-03-29) - P2 体验优化

#### Bug 修复 (来自 v2.0.2)
- **BUG #1 修复**: `title` 参数现在正确创建新话题和会话（之前只更新标题不创建会话，导致上下文污染）
- **BUG #3 修复**: `sessionId` 现在无论新旧话题都会正确保存（之前只有 `isNewTopic=true` 时才保存）
- **BUG #4 修复**: 添加自动重试机制（3次重试，间隔10秒），解决偶发错误导致任务中断
- **ISSUE #8 修复**: `saveTopics()` 改为原子写入（临时文件+rename），避免多实例并发写入损坏数据
- **ISSUE #10 修复**: `activeProcesses` 改为实例属性，避免进程追踪泄漏

#### P1 重要优化

##### P1-3: 任务进度实时反馈
- 新增 `onProgress` 回调参数，支持长任务阶段性进度反馈
- 进度阶段：初始化 → 分析中 → 生成报告 → 完成
- 每15秒自动报告一次执行状态
- 基于关键词（reading/analyzing/generating）的自动阶段检测

##### P1-4: 标准化错误体系
- 新增错误码枚举（ERROR_CODES），覆盖命令、文件、运行时、安全、进程、话题6大类
- 新增 `formatError()` 和 `inferErrorCode()` 方法
- 所有命令返回标准化错误结构：{ code, category, message, suggestion, details }
- 所有错误响应包含时间戳

##### P1-5: 自定义超时配置
- timeout 参数现在正确传递并生效
- 支持类型自动转换（字符串/数字）
- 范围限制：30秒 ~ 10分钟

##### P1-6: 残留报错过滤
- 已关闭话题（closed）的残留响应不再返回给用户
- 仅在后台日志记录，避免干扰当前会话

#### P2 体验优化

##### P2-1: 任务管理功能
- 新增 `pause` 命令 - 暂停运行中的任务（通过 SIGSTOP/SIGCONT）
- 新增 `resume` 命令 - 恢复暂停的任务
- 新增 `getTaskStatus` 命令 - 获取指定任务的状态
- 新增 `listTasks` 命令 - 列出所有任务
- 新增 `taskStates` 实例属性追踪任务状态（running/paused/completed/failed/timeout）
- Windows 平台使用 PowerShell 命令暂停/恢复进程
- **注意**: 已更新 plugin-manifest.json 添加新命令定义

#### P2-2: 分析结果缓存
- 新增 `analysisCache` 实例属性存储分析结果
- 缓存键基于：操作类型 + 文件路径 + 文件修改时间 + 查询内容哈希
- 默认 TTL 30分钟
- 新增 `getAnalysisCacheKey()`、`getCachedResult()`、`setCachedResult()`、`clearCache()` 方法
- 缓存命中时返回 `{cached: true, cacheAge: ...}`

#### P2-3: 多格式导出
- 新增 `exportReport()` 方法支持导出为 JSON/Markdown/Text 格式
- 新增 `exportAsJSON()`、`exportAsMarkdown()`、`exportAsText()` 导出方法
- 支持自定义文件名和元数据开关

#### P2-4: 资源占用监控
- chat 响应中新增 `resourceUsage` 对象
- 包含：startTime、endTime、memoryUsage、cpuUsage
- 可用于成本核算和性能分析

#### 标准化错误码体系
所有错误响应现在包含标准字段：
```json
{
  "status": "error",
  "code": "E1001",
  "category": "command",
  "message": "未知命令",
  "suggestion": "使用支持的命令列表...",
  "timestamp": "2026-03-29T..."
}
```

错误码分类：
- `E1xxx` - 命令/参数错误
- `E2xxx` - 文件操作错误
- `E3xxx` - OpenCode 运行时错误
- `E4xxx` - 安全错误
- `E5xxx` - 进程管理错误
- `E6xxx` - 话题管理错误

### v2.0.1 (2026-03-28) - Bug 修复
- 修复：所有命令输出格式统一为 `{ status, result }` 以符合 Plugin.js 契约
- 修复：`checkEnvironment()` 返回结果添加 `status` 字段
- 修复：`getTopic` 错误响应格式不一致问题
- 修复：`topicId` 使用 Date.now() 存在碰撞风险，添加随机后缀
- 修复：`chat` 命令中 `this.topics[agentId]` 空指针风险
- 修复：`status: "timeout"` 不被 Plugin.js 接受，映射为 `error`
- 修复：删除未实现的 `lifecycle.onLoad: initialize` 配置
- 修复：`communication.timeout` 位置错误（移至正确位置）
- 优化：代码结构和防御性编程

### v2.0.0 (2026-03-28)
- 新增：多 Agent 多话题支持
- 新增：每个话题独立的 OpenCode 会话
- 新增：createTopic/listTopics/getTopic/switchTopic/closeTopic 命令
- 新增：话题元数据持久化到 .opencode_topics.json
- 移除：旧的单一 session 管理方式（getSession/resetSession）
- 架构重构：从单一会话改为多会话架构

### v1.1.3 (2026-03-28)
- 新增：会话持久化功能，chat 自动使用 --continue 保持上下文
- 新增：会话信息存储到 .opencode_session 文件，重启后自动恢复
- 新增：自动生成会话标题（VCP-Ritsu-YYYYMMDD-序号）
- 新增：getSession 命令获取当前会话信息
- 新增：resetSession 命令重置会话

### v1.1.2 (2026-03-28)
- 修复：consult 假阳性问题
- 修复：spawn 资源泄漏风险
- 修复：DiffAnalyzer SQL 注入检测

### v1.0.1 (2026-03-27)
- 初始版本
