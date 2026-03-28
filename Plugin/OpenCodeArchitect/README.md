---
Status: Active
Module: Core
Impact: VCP 2.0 自我进化回路核心插件
Ritsu_Action: 需同步到记忆
---

# OpenCodeArchitect 插件开发规范

**版本**: v2.0.1
**创建日期**: 2026-03-27
**最后更新**: 2026-03-28

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
await OpenCodeArchitect.interrupt(pid, activeProcesses)
```

**输入参数**:
| 参数 | 类型 | 必填 | 描述 |
|------|------|------|------|
| pid | number | ✅ | 要中断的进程 PID |

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

### 3.8 consult - 专家咨询模式

只读分析，返回报告和 Diff 预览，不改动物理文件。

```javascript
await OpenCodeArchitect.consult(query, targetFile)
```

---

### 3.9 apply - 物理进化模式

授权 OpenCode 直接修改系统源码，自动进行安全检查。

```javascript
await OpenCodeArchitect.apply(query, targetFile, options)
```

---

### 3.10 initialize - 知识同步

让 OpenCode 重新扫描并理解 VCP 系统结构。

```javascript
await OpenCodeArchitect.initialize(vcpPath)
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
├── plugin-manifest.json    # 插件契约 (v2.0.0)
├── index.js              # 主入口 (多会话管理)
├── diff-analyzer.js      # Diff 安全分析器
├── PROMPTS.md            # Ritsu Diff 分析协议
└── README.md             # 本文档

运行时文件：
├── .opencode_topics.json  # 话题元数据
└── .opencode_session_*   # 各话题的 OpenCode session ID
```

## 七、 已知限制

| 限制 | 说明 |
|------|------|
| 话题不自动清理 | 需要显式调用 closeTopic 关闭话题 |
| session 依赖 OpenCode | 实际会话由 OpenCode 管理 |
| 超长上下文 | OpenCode 有上下文长度限制 |

## 八、 更新日志

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
