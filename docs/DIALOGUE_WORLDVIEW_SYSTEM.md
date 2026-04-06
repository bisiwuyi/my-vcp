# 对话世界观文档系统 - 技术方案 v2.15

## 概述

本系统为VCP智能体提供"对话世界观文档"能力，自动将用户与AI的对话按时间线聚合成结构化的Markdown文档，便于AI和用户随时查阅历史上下文。

---

## 一、需求规格

### 1.1 核心需求

| 需求 | 说明 |
|------|------|
| 会话话题聚合 | 同一`requestId`的对话自动归为同一话题 |
| 时间线摘要 | 每次对话后自动生成摘要，按时间顺序追加到文档 |
| Token限制 | 文档上限20,000 Tokens，超出时渐进压缩 |
| 动态注入 | 通过`{{VCPWorldview}}`占位符注入system prompt |
| 用户可读 | MD格式文档，用户可直接查看/手动编辑 |
| 前端感知 | 用户可感知世界观更新状态 |

### 1.2 用户配置选项

| 选项 | 选择 |
|------|------|
| 话题识别方式 | 同一会话ID自动归为同一话题 |
| 摘要生成时机 | 第一条消息即生成，后续对话追加 |
| 摘要风格 | 近期重点详细，往期简略 |
| LLM选择 | 用户可自由配置（推荐便宜模型） |
| 历史话题导入 | 前端界面手动选择 |

---

## 二、核心问题与解决方案

### 2.1 读写竞态与并发文件锁

**问题**：Node.js异步非阻塞，同一会话连续快速发送消息时，多次`onConversationEnd`几乎同时触发，导致文件损坏。

**解决方案**：Promise链任务队列（传入闭包执行）

```javascript
// 每个requestId的任务队列
const queues = new Map(); // requestId → Promise链

/**
 * 将任务加入队列执行（任务必须是闭包函数，避免立即执行）
 * @param {string} requestId - 会话ID
 * @param {Function} taskFn - 任务函数（闭包），延迟到.then()时执行
 */
async function enqueue(requestId, taskFn) {
    if (!queues.has(requestId)) {
        queues.set(requestId, Promise.resolve());
    }
    const previousTask = queues.get(requestId);

    // ⚠️ 关键：传入的是函数 taskFn，不是立即执行的任务
    // 这样确保任务在 .then() 链中才真正执行
    const newTask = previousTask
        .then(() => taskFn())
        .finally(() => {
            if (queues.get(requestId) === newTask) {
                queues.delete(requestId);
            }
        });

    queues.set(requestId, newTask);
    return newTask;
}

// 调用示例：
// ✅ 正确：传入闭包，延迟执行
// enqueue(reqId, () => worldviewGenerator.update(...))
//
// ❌ 错误：如果这样写会立即执行，队列失去意义
// enqueue(reqId, somePromise)
```

**优势**：任务B自动挂载到任务A的`.then()`后面，同一会话的文件操作严格串行执行。闭包确保I/O在队列控制下执行。

### 2.2 异步时延导致的"上下文穿透"

**问题**：LLM生成摘要需要几秒，如果用户立刻发起下一轮提问，主Agent读取的是旧版世界观。

**解决方案**：内存暂态缓存（Dirty State）补偿机制

```javascript
// 内存暂态缓存
const pendingSummaries = new Map(); // requestId → {userInput, aiResponse, timestamp, completed}

// onConversationEnd时写入缓存
pendingSummaries.set(requestId, {
    userInput,
    aiResponse,
    timestamp: Date.now(),
    completed: false
});

// getWorldviewContent时检查暂态
async function getWorldviewContent(requestId) {
    let content = await readFile(worldviewPath);

    const pending = pendingSummaries.get(requestId);
    if (pending && !pending.completed) {
        content += `\n\n### [进行中] ${formatTime(pending.timestamp)}\n`;
        content += `**用户**: ${pending.userInput.substring(0, 100)}...\n`;
        content += `**AI**: ${pending.aiResponse.substring(0, 100)}...`;
    }
    return content;
}
```

**清理时机**：物理文件写入完成后执行`pendingSummaries.delete(requestId)`。

### 2.3 错误处理导致"永久失忆"

**问题**：LLM调用失败时跳过摘要，导致时间线永久缺失。

**解决方案**：降级机械摘要

```javascript
async function generateSummaryWithFallback(messages, requestId) {
    try {
        return await llmSummarizer.generate(messages);
    } catch (error) {
        console.error(`[Worldview] LLM摘要失败，降级为机械摘要`);

        // 降级策略：直接截取原始内容
        const userMsg = messages.filter(m => m.role === 'user').pop()?.content || '';
        const aiMsg = messages.filter(m => m.role === 'assistant').pop()?.content || '';

        return {
            timestamp: new Date().toISOString(),
            title: '系统自动记录',
            userIntent: `[摘要生成失败] 用户输入: ${userMsg.substring(0, 50)}...`,
            aiResponse: `AI回复: ${aiMsg.substring(0, 50)}...`,
            isFallback: true // 标记为降级摘要
        };
    }
}
```

### 2.4 日记内容直接引用（v2.11新增）

**问题**：LLM生成的摘要限制字数（≤50字/条），导致AI答复的详细信息被压缩丢失。

**解决方案**：直接引用日记内容作为AI答复

```javascript
// 从 aiResponse 中提取日记块
const dailyNoteRegex = /<<<DailyNoteStart>>>([\s\S]*?)<<<DailyNoteEnd>>>/s;
const diaryMatch = aiResponse.match(dailyNoteRegex);

if (diaryMatch && diaryMatch[1]) {
    // 提取 Content: 后的内容
    const contentMatch = diaryMatch[1].match(/Content:\s*([\s\S]*)$/m);
    diaryContent = contentMatch ? contentMatch[1].trim() : '';
}

// 用户意图处理
if (userContent.length <= 50) {
    // 短消息直接引用
    summary.userIntent = userContent;
} else {
    // 长消息调用LLM生成摘要
    summary.userIntent = llmSummary.userIntent;
}

// AI答复直接使用日记内容，不截断
summary.aiResponse = diaryContent;
```

**日记内容为空时**：降级使用原有LLM摘要逻辑。

### 2.5 Token计算精度

**问题**：中文字符Token消耗在不同模型间差异大，估算偏差可能导致上下文击穿。

**解决方案**：安全水位线 + 估算倍率

```javascript
// config.env
VCP_WORLDVIEW_TOKEN_LIMIT=20000              // 硬顶限制
VCP_WORLDVIEW_TOKEN_SAFETY_BUFFER=1500       // 安全水位线
VCP_WORLDVIEW_TOKEN_ESTIMATE_RATIO=1.5       // 中文字符→Token估算倍率

// 压缩触发阈值 = 20000 - 1500 = 18500
const COMPRESS_THRESHOLD = TOKEN_LIMIT - SAFETY_BUFFER;
```

---

## 三、目录结构

```
VCPDialogueWorldview/                    # 根目录
└── _index/
    └── sessions/
        └── {requestId}/                # 会话ID作为话题目录
            ├── worldview.md            # 该话题的世界观文档
            ├── meta.json               # 元数据
            └── _attachments/           # AI重要输出附件（v2.8新增）
                ├── report_v1.md        # 附件版本文件
                ├── report_v2.md
                └── data_v1.xlsx.desc  # 二进制文件生成指令

VCPDialogueWorldview/_archive/           # 归档目录
└── {year-month}/
    └── {requestId}.json               # 归档的压缩版本
```

---

## 四、文档格式规范

### 4.1 完整文档结构

```markdown
# 🌍 对话世界观文档

> 会话ID: msg_abc123
> 创建时间: 2026-04-04 14:20:00
> 最后更新: 2026-04-04 15:30:00
> Token: 8,234 / 20,000

---

## 📌 当前进行中 (高保真近期区)

### [2026-04-04 15:30] VCP子Agent系统设计
- **用户意图**: 确定后台治理Agent的具体实现方案
- **AI答复**:
  - 介绍了虚拟化上下文、读写分离、异步解耦等设计理念
  - 单节点 + 短时异步 + B级可靠性
  - 采用轻量增强方案，无需引入新依赖

### [2026-04-04 14:20] 上下文管理系统需求
- **用户意图**: 评估外部方案对VCP的适用性
- **AI答复**:
  - 分析了架构耦合度，指出直接迁移成本高
  - 建议提取核心思想，单独设计实现方案

---

## 🗄️ 已归档/被搁置 (极度压缩归档区)

- *2026-03-15*: [Docker部署] 完成环境配置
- *2026-03-10*: [RAG优化] 讨论了向量检索性能
- *2026-03-01*: [插件开发] 开发了第一个VCP插件
```

### 4.2 降级摘要标记

当LLM调用失败时，生成的机械摘要：

```markdown
### [2026-04-04 16:00] 系统自动记录
- **用户意图**: [摘要生成失败] 用户输入: 今天想讨论一下VCP的插件架构...
- **AI答复**: AI回复: VCP的插件系统采用manifest驱动...

---

## 五、系统架构

### 5.1 组件关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                     VCP 对话处理流程                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  用户消息 → AI回复 → 对话结束                                     │
│                              ↓                                   │
│              ┌─────────────────────────────────────┐           │
│              │  DialogueWorldviewManager            │           │
│              │  onConversationEnd()                │           │
│              │  ├─ Promise链任务队列                │           │
│              │  ├─ pendingSummaries内存暂态        │           │
│              │  └─ enqueue(requestId, taskFn)      │           │
│              └─────────────────────────────────────┘           │
│                              ↓                                   │
│              ┌─────────────────────────────────────┐           │
│              │     DataMasking (脱敏中间件)        │           │
│              │  ├─ AK/SK → ***AK/SK***           │           │
│              │  ├─ Bearer Token → ***TOKEN***     │           │
│              │  └─ Password → ***PASSWORD***      │           │
│              └─────────────────────────────────────┘           │
│                              ↓                                   │
│         ┌────────────────┬────────────────┬─────────────┐       │
│         ↓                ↓                ↓             ↓       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ ┌────────┐ │
│  │ worldview   │  │ worldview   │  │ worldview   │ │ chokidar│ │
│  │ LLM         │  │ Generator   │  │ Compressor  │ │ 文件监听│ │
│  │ Summarizer  │  │             │  │             │ └────────┘ │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│         │                │                │                      │
│         ↓                ↓                ↓                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              VCPDialogueWorldview/_index/                  │  │
│  │                     sessions/{id}/                         │  │
│  │                  worldview.md (MD文档)                      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│              ┌─────────────────────────────────────┐           │
│              │     WorldviewPlugin                  │           │
│              │  {{VCPWorldview}} 占位符           │           │
│              └─────────────────────────────────────┘           │
│                              ↓                                   │
│              ┌─────────────────────────────────────┐           │
│              │    messageProcessor.js               │           │
│              │   注入到 system prompt              │           │
│              └─────────────────────────────────────┘           │
│                                                                  │
│                              ↓                                   │
│              ┌─────────────────────────────────────┐           │
│              │    WebSocketServer.js               │           │
│              │   worldview_updated 广播             │           │
│              └─────────────────────────────────────┘           │
│                              ↓                                   │
│                      🌍 前端小图标反馈                            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 模块职责

| 模块 | 文件路径 | 职责 |
|------|----------|------|
| 数据脱敏 | `modules/worldviewDataMasking.js` | AK/SK、Token、密码等敏感信息脱敏 |
| LLM摘要生成器 | `modules/worldviewLLMSummarizer.js` | 调用LLM生成对话摘要，含降级策略 |
| 文档生成器 | `modules/worldviewGenerator.js` | 创建/更新MD文档，时间线追加 |
| 文档压缩器 | `modules/worldviewCompressor.js` | 超过阈值时渐进压缩归档 |
| 上下文优化器 | `modules/contextOptimizer.js` | 截取最近N轮对话，减少token消耗（v2.9新增） |
| 主管理器 | `modules/DialogueWorldviewManager.js` | 协调各模块，Promise链队列，内存暂态 |
| 静态插件 | `Plugin/WorldviewPlugin/` | 提供`{{VCPWorldview}}`占位符 |
| 文件监听 | chokidar | 热重载，awaitWriteFinish防抖 |

### 5.3 对话引用机制（v2.9新增）

世界观文档通过 `messageId` 关联前端对话历史，实现双向联动。

#### 机制说明

- 后端摘要生成时，从 messages 数组提取 assistant 消息的 `messageId`
- 在世界观条目中以 `**对话引用**: {messageId}` 格式记录
- 用户可通过 messageId 在前端 `history.json` 中精确定位对话原文

#### 保存位置

```
前端: AppData/UserData/{agentId}/topics/{topicId}/history.json
后端: VCPDialogueWorldview/_index/sessions/{topicId}/worldview.md
```

#### 对应关系

```markdown
<!-- 世界观文档 worldview.md -->
### [2026-04-05 10:30] Python演示代码
- **用户意图**: 帮我写Python代码
- **AI答复**:
  - 提供了完整的Python代码示例
  - 包含注释说明关键函数逻辑
- **对话引用**: msg_1775357150858_assistant_mnxtb3n (history.json 第265行)
```

用户可在 `history.json` 中搜索 `msg_1775357150858_assistant_mnxtb3n` 直接找到该条对话原文。

### 5.4 上下文优化器（v2.9新增）

上下文优化器通过截取最近 N 轮对话，减少发送给 AI 的 token 数量。

#### 配置项

```bash
VCP_CONTEXT_OPTIMIZATION_ENABLED=true   # 默认开启
VCP_CONTEXT_OPTIMIZATION_ROUNDS=3        # 保留轮数（每轮=1 User + 1 Assistant）
VCP_CONTEXT_OPTIMIZATION_DEBUG=false      # 调试模式
```

#### 优化效果

| 对话轮数 | 优化前 | 优化后（3轮） |
|----------|--------|---------------|
| 1轮 | 2条消息 | 2条消息 |
| 3轮 | 6条消息 | 6条消息 |
| 5轮 | 10条消息 | 6条消息 |
| 10轮 | 20条消息 | 6条消息 |

#### 实现位置

- `modules/contextOptimizer.js` - 核心截取逻辑
- `modules/handlers/streamHandler.js` - 流式响应集成
- `modules/handlers/nonStreamHandler.js` - 非流式响应集成

#### 工作流程

```
用户发送消息
    ↓
Handler 接收 originalBody.messages
    ↓
检查 VCP_CONTEXT_OPTIMIZATION_ENABLED
    ↓
true → contextOptimizer.extractRecentRounds(messages, 3)
    ↓
false → 使用完整 messages（向后兼容）
    ↓
发送给 AI 继续处理
```

---

### 5.5 注入优化（v2.13新增）

为避免世界观文档中的最近摘要与上下文优化器的最近对话重复，注入系统提示词时会自动截掉"当前进行中"区域的最近N条摘要。

#### 配置项

```bash
VCP_WORLDVIEW_INJECT_STRIP_RECENT=3   # 默认截掉最近3条，0表示不截断
```

#### 截断规则

| 条件 | 结果 |
|------|------|
| 条目 ≥ 3条 | 截掉最近3条，保留前面的 |
| 条目 < 3条 | 全部截掉 |
| 归档区 | 不参与截断 |

#### 实现位置

- `modules/DialogueWorldviewManager.js` - `getWorldviewContent(requestId, { stripRecent })`
- `modules/messageProcessor.js` - 调用时传递 `stripRecent` 参数

#### 效果示意

**注入前**（5条）：
```
## 📌 当前进行中
### [条目1]  ← 保留
### [条目2]  ← 保留
### [条目3]  ← 截掉
### [条目4]  ← 截掉
### [条目5]  ← 截掉
```

**注入后**：
```
## 📌 当前进行中
### [条目1]
### [条目2]
```

---

## 六、接口设计

### 6.1 DialogueWorldviewManager API

```javascript
const DialogueWorldviewManager = require('./DialogueWorldviewManager');

/**
 * 对话结束后调用 - 更新世界观文档
 * 内部自动处理：
 * - Promise链任务队列（防止竞态）
 * - 内存暂态缓存（防止上下文穿透）
 * - LLM降级策略（防止永久失忆）
 */
await DialogueWorldviewManager.onConversationEnd(
    messages,    // 对话消息数组
    requestId,   // 会话ID
    userInput,   // 用户最新输入
    aiResponse   // AI最新回复
);

/**
 * 获取世界观文档内容（含暂态补偿）
 */
await DialogueWorldviewManager.getWorldviewContent(requestId);

/**
 * 获取指定话题的文档路径
 */
DialogueWorldviewManager.getWorldviewPath(requestId);

/**
 * 获取所有话题列表（供前端手动选择）
 */
await DialogueWorldviewManager.getAllTopics();

/**
 * 导入历史话题（前端选择后调用）
 */
await DialogueWorldviewManager.importTopic(sourceRequestId, targetRequestId);

/**
 * 手动触发压缩
 */
await DialogueWorldviewManager.compressIfNeeded(requestId);
```

### 6.2 LLM摘要器配置

```javascript
// modules/worldviewLLMSummarizer.js
const config = {
    model: process.env.VCP_WORLDVIEW_MODEL || 'gpt-3.5-turbo',
    apiKey: process.env.VCP_WORLDVIEW_LLM_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.VCP_WORLDVIEW_LLM_BASE_URL || process.env.OPENAI_BASE_URL,
    maxSummaryTokens: 300,
    systemPrompt: `你是一个对话摘要助手。请严格按照以下格式提取对话摘要，不要输出任何额外废话：

请严格按照以下格式提取：
- **用户意图**: [用10个字以内概括核心诉求]
- **AI答复**: [提取AI方案的核心逻辑或技术栈]
- **关键结论**: [如果有明确决定，提取结论；如果是闲聊，写"无产出"]

注意事项：
- 不要输出任何解释性文字
- 只输出上述三个字段
- 保持简洁，不要冗余`
};
```

---

## 七、数据结构

### 7.1 元数据格式 (meta.json)

```json
{
    "sessionId": "msg_abc123",
    "createdAt": "2026-04-04T14:20:00+08:00",
    "updatedAt": "2026-04-04T15:30:00+08:00",
    "tokenCount": 8234,
    "entryCount": 15,
    "status": "active",
    "archivedEntries": 3
}
```

### 7.2 内存暂态格式

```javascript
// pendingSummaries Map
{
    requestId: {
        userInput: "今天想讨论VCP的插件架构",
        aiResponse: "VCP采用manifest驱动的插件生命周期...",
        timestamp: 1743744600000,
        completed: false
    }
}
```

### 7.3 归档格式

```json
{
    "sessionId": "msg_abc123",
    "archivedAt": "2026-04-10T08:00:00+08:00",
    "originalEntry": {
        "title": "Docker部署",
        "timestamp": "2026-03-15T10:00:00+08:00",
        "summary": "用户完成了Docker环境配置",
        "detail": "详细的世界观文档内容..."
    },
    "compressedSummary": "2026-03-15: [Docker部署] 完成环境配置"
}
```

---

## 八、热重载机制

### 8.1 文件监听

使用chokidar监听 worldview.md 变更，实现用户手动编辑后的热重载：

```javascript
const chokidar = require('chokidar');

const watcher = chokidar.watch(filePath, {
    awaitWriteFinish: {
        stabilityThreshold: 500,  // 500ms内文件大小不再变化才触发
        pollInterval: 100         // 轮询间隔
    }
});

watcher.on('change', (path) => {
    // chokidar已保证这是文件稳定后的唯一一次触发
    // 无需额外setTimeout防抖，awaitWriteFinish已处理
    console.log(`[Worldview] 检测到 ${path} 手动修改，重新加载缓存...`);

    // 从path中提取requestId
    const requestId = extractRequestIdFromPath(path);
    reloadWorldviewCache(requestId);
});
```

**关键点**：
- `awaitWriteFinish.stabilityThreshold: 500` 已确保文件稳定后才触发
- 无需外部setTimeout，chokidar内部已处理防抖
- 监听多个文件时chokidar按路径隔离，无全局污染问题

### 8.2 前端通知

文件变更并reload成功后，通过WebSocket通知前端：

```javascript
// 后端 reloadWorldviewCache 完成后
webSocketServer.broadcast({
    type: 'worldview_updated',
    data: {
        requestId: requestId,
        status: 'saved',
        message: '世界观已保存'
    }
}, 'VCPLog');
```

```javascript
// 前端 WebSocket 处理
ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'worldview_updated') {
        // 在对应消息旁显示 🌍 小图标
        showWorldviewIcon(data.requestId);
    }
};
```

---

## 九、压缩策略

### 9.1 触发条件

- **压缩阈值** = `VCP_WORLDVIEW_TOKEN_LIMIT - VCP_WORLDVIEW_TOKEN_SAFETY_BUFFER`
- 默认：`20000 - 1500 = 18500`

### 9.2 压缩规则

| 区域 | 规则 |
|------|------|
| 当前进行中 | 保留最近10条详细条目 |
| 已归档区 | 超出部分压缩为一句话 |

### 9.3 压缩算法

```
1. 统计当前文档token数
2. 如果 > 压缩阈值(18500)：
   a. 提取"当前进行中"区域的条目列表
   b. 保留最近10条，其余移入归档区
   c. 归档条目压缩为："时间: [话题] 一句话总结"
   d. 重新计算token数
   e. 如果仍 > 阈值，重复步骤b
3. 保存归档文件到 _archive/
```

---

## 十、占位符注入机制

### 10.1 System Prompt中使用

```
你是VCP智能体助手。

{{VCPWorldview}}

---
当前对话：
{{VCPRecentHistory}}
```

### 10.2 注入流程

```
1. DialogueWorldviewManager.getWorldviewContent(requestId)
   ├─ 读取 worldview.md
   └─ 检查 pendingSummaries 暂态
      └─ 如有未完成摘要，追加到内容末尾
2. WorldviewPlugin 通过 getPlaceholderValue() 返回
3. messageProcessor 在处理 system prompt 时替换 {{VCPWorldview}}
```

---

## 十一、历史话题导入

### 11.1 功能说明

用户可在前端界面手动选择历史话题，系统将其世界观文档导入到当前会话。

### 11.2 前端UI

```
┌─────────────────────────────────────┐
│ 导入历史话题                          │
│                                     │
│ ☐ msg_abc123: VCP子Agent系统设计     │
│ ☐ msg_def456: Docker部署讨论          │
│ ☑ msg_ghi789: 数据库表结构设计 (已选) │
│                                     │
│ [取消]              [确认导入]        │
└─────────────────────────────────────┘
```

### 11.3 API

```javascript
// 用户选择后调用
await DialogueWorldviewManager.importTopic(sourceRequestId, targetRequestId);

// 合并逻辑：将源话题的 worldview.md 内容追加到目标话题
```

---

## 十二、文件清单

| 文件路径 | 操作 | 说明 |
|----------|------|------|
| `modules/worldviewDataMasking.js` | 新建 | 敏感信息脱敏（AK/SK/Token/Password） |
| `modules/worldviewLLMSummarizer.js` | 新建 | LLM摘要生成，含降级策略 |
| `modules/worldviewGenerator.js` | 新建 | MD文档生成/更新/追加 |
| `modules/worldviewCompressor.js` | 新建 | 文档压缩，含安全水位线 |
| `modules/contextOptimizer.js` | 新建 | 上下文优化，截取最近N轮对话（v2.9新增） |
| `modules/DialogueWorldviewManager.js` | 新建 | 主管理器，Promise队列，暂态缓存 |
| `Plugin/WorldviewPlugin/plugin-manifest.json` | 新建 | 插件配置（capabilities已置空，不参与占位符解析） |
| `Plugin/WorldviewPlugin/index.js` | 新建 | 辅助工具函数（getAvailableSessions等） |
| `modules/handlers/streamHandler.js` | 修改 | 添加对话结束Hook，传递topicId；集成contextOptimizer |
| `modules/handlers/nonStreamHandler.js` | 修改 | 添加对话结束Hook，传递topicId；集成contextOptimizer |
| `modules/messageProcessor.js` | 修改 | 添加{{VCPWorldview}}特殊处理（直接调用DialogueWorldviewManager） |
| `modules/chatCompletionHandler.js` | 修改 | processingContext添加requestId字段 |
| `config.env.example` | 修改 | 添加世界观和上下文优化配置项 |
| `package.json` | 修改 | 添加chokidar依赖 |

---

## 十三、配置项

### 13.1 config.env 新增项

```bash
# 对话世界观文档配置
VCP_WORLDVIEW_ENABLED=true                    # 是否启用
VCP_WORLDVIEW_DIR=VCPDialogueWorldview        # 文档存储目录
VCP_WORLDVIEW_TOKEN_LIMIT=20000              # Token上限（硬顶）
VCP_WORLDVIEW_TOKEN_SAFETY_BUFFER=1500       # 安全水位线（触发压缩的缓冲）
VCP_WORLDVIEW_TOKEN_ESTIMATE_RATIO=1.5       # 中文字符→Token估算倍率
VCP_WORLDVIEW_MODEL=gpt-3.5-turbo            # 使用的LLM模型
VCP_WORLDVIEW_MAX_ENTRIES=10                 # 当前区域保留条目数
VCP_WORLDVIEW_LLM_BASE_URL=                   # 自定义API地址（可选）
VCP_WORLDVIEW_LLM_API_KEY=                   # API密钥（可选）
VCP_WORLDVIEW_INJECT_STRIP_RECENT=3          # 注入时截掉"当前进行中"最近N条（避免与上下文优化重复）
```

### 13.2 依赖

```bash
npm install chokidar
```

---

## 十四、错误处理

| 场景 | 处理方式 |
|------|----------|
| LLM调用失败 | 降级为机械摘要，标记`[摘要生成失败]` |
| 文件写入失败 | 重试3次，失败后记录到error.log |
| 文档读取失败 | 返回空字符串，前端显示"暂无世界观文档" |
| Token计算错误 | 使用估算值 + 安全水位线缓冲 |
| 并发写冲突 | Promise链队列自动串行化 |
| 暂态数据残留 | 物理文件写入完成后立即清理 |

---

## 十五、日志输出

```javascript
// 日志格式
[Worldview] 初始化完成
[Worldview] 更新话题 msg_abc123 的世界观文档
[Worldview] 生成摘要成功，token: 156
[Worldview] LLM摘要失败，降级为机械摘要
[Worldview] 文档压缩完成，当前token: 18,234
[Worldview] 压缩触发，归档3条旧条目
[Worldview] 检测到 msg_abc123 手动修改，重新加载缓存...
[Worldview] 🌍 世界观已保存，广播前端
[Worldview] 错误: 文件写入失败 - 已达到最大重试次数
```

---

## 十六、实施步骤

### Step 1: 基础设施
- [x] 创建目录结构
- [ ] 安装chokidar依赖
- [ ] 创建元数据读写工具

### Step 2: 核心模块
- [ ] 实现 worldviewLLMSummarizer.js（含降级策略）
- [ ] 实现 worldviewGenerator.js
- [ ] 实现 worldviewCompressor.js（含安全水位线）
- [ ] 实现 DialogueWorldviewManager.js（Promise链+暂态缓存）

### Step 3: 插件集成
- [ ] 创建 WorldviewPlugin
- [ ] 配置 messageProcessor 占位符
- [ ] 配置 chokidar 文件监听

### Step 4: 流程集成
- [ ] Hook到 streamHandler
- [ ] Hook到 nonStreamHandler
- [ ] 配置 WebSocket 广播

### Step 5: 配置与测试
- [ ] 添加 config.env 配置项
- [ ] 功能测试

---

## 十七、版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-04-04 | 初始版本 |
| v2.0 | 2026-04-04 | 整合所有优化：Promise链队列、内存暂态缓存、降级机械摘要、安全水位线、chokidar热重载、前端小图标反馈、历史话题导入 |
| v2.1 | 2026-04-04 | 修复致命暗坑：Promise队列闭包陷阱、chokidar双重防抖冗余；新增DataMasking脱敏中间件、优化LLM摘要Prompt格式 |
| v2.2 | 2026-04-04 | 修复架构性Bug：WorldviewPlugin改为非静态插件，集成到messageProcessor处理{{VCPWorldview}}占位符；修复worldviewCompressor多行AI答复正则捕获问题 |
| v2.3 | 2026-04-04 | 修复摘要混入历史对话Bug；修复formatNewEntry多行bullet格式化重复问题；修复archiveOldEntries引用已删除字段；修复appendEntry归档区检测逻辑 |
| v2.4 | 2026-04-04 | 修复Regex解析错位（可选字段永远为空）；补充遗漏的globalInstruction提取；添加Chokidar热重载；优化Token估算使用tiktoken；增强文档解析容错性 |
| v2.5 | 2026-04-04 | 修复WorldviewPlugin同步/异步割裂问题；添加isAborted标志位处理中断对话；添加Token预算检查防止上下文撑爆；添加LLM调用指数退避重试机制 |
| v2.6 | 2026-04-04 | 修复globalInstruction数据丢失；修复归档区AI答复为空；确认重试机制已实现 |
| v2.7 | 2026-04-04 | 修复Promise队列断链（添加.catch吞错误）；修复getWorldviewContent空指针；修复Token估算倍率（0.4->1.5）；修复归档区AI答复多行匹配 |
| v2.8 | 2026-04-04 | 新增附件处理器（worldviewAttachmentHandler.js）；支持VCP_SAVE/VCP_DOC标记语法；自动保存AI重要输出到_attachments目录；版本控制（最多5版本）；修复removeSaveMarkers的lastIndex未重置BUG；修复摘要生成时未先清理aiResponse标记的BUG；修复标记语法误放入LLM摘要器SYSTEM_PROMPT（已移至buildHeader）；修复二进制文件扩展名污染BUG；修复版本控制正则无法匹配复合扩展名BUG；修复版本号停滞导致无限覆盖BUG；修复removeSaveMarkers空替换导致LLM摘要幻觉BUG；修复truncateWorldviewIfNeeded截断时丢失header导致Agent收不到标记指令BUG |
| v2.9 | 2026-04-05 | 移除后端附件处理器；改用前端history.json保存完整对话和附件；新增messageId对话引用机制；新增contextOptimizer上下文优化器，支持截取最近N轮对话减少token消耗 |
| v2.10 | 2026-04-05 | 修复Context Optimizer丢失System Prompt的致命BUG；修复Handler传递错误messages数组给onConversationEnd的BUG；确认truncateWorldviewIfNeeded已正确保留header |
| v2.11 | 2026-04-05 | 优化摘要生成逻辑：移除领域标签字段；AI答复直接引用日记完整内容；用户意图≤50字直接引用，>50字调用LLM生成 |
| v2.12 | 2026-04-06 | 支持两种日记格式提取；优化AI答复摘要格式，新增核心摘要+关键执行结构；已验证日记内容正确引用 |
| v2.13 | 2026-04-06 | 新增注入优化：截掉"当前进行中"最近N条摘要，避免与上下文优化器的最近N轮对话重复 |
| v2.14 | 2026-04-06 | 修复多模态内容崩溃Bug；重构Token计算为单例统一管理；过滤全局指令"无"等占位文本 |
| v2.15 | 2026-04-06 | 修复streamHandler.js未传递agentId参数问题；确保agentId正确透传到summary对象 |

---

## 十八、技术架构说明（重要）

### 18.1 {{VCPWorldview}} 占位符处理机制

本系统**不依赖**静态插件（Static Plugin）机制来处理 `{{VCPWorldview}}` 占位符。原因如下：

1. **静态插件的局限性**：静态插件通过子进程Cron定时执行，无法获取请求级别的上下文（requestId/topicId）
2. **设计错误**：WorldviewPlugin 被错误地设计为静态插件，其 `index.js` 是 Node.js 模块而非可执行脚本

**正确的处理流程**：

```
用户消息 → chatCompletionHandler.js
    ↓
创建 processingContext，包含 requestId（从 topicId 或 requestId 或 messageId 派生）
    ↓
messageProcessor.replaceAgentVariables() 处理占位符
    ↓
检测到 {{VCPWorldview}} → 调用 DialogueWorldviewManager.getWorldviewContent(requestId)
    ↓
返回对应话题的世界观文档内容
```

### 18.2 WorldviewPlugin 的实际作用

`Plugin/WorldviewPlugin/index.js` 目前作为辅助模块使用，提供 `getAvailableSessions()` 等工具函数，不参与占位符解析。

### 18.3 前端 topicId 传递链路

```
VCPChat/vcpClient.js:184       → topicId: context?.topicId || null
VCPChat/modules/ipc/chatHandlers.js:766 → topicId: context?.topicId || null
    ↓
VCP backend streamHandler.js:45 → worldviewSessionId = originalBody.topicId || id
VCP backend nonStreamHandler.js:301 → worldviewSessionId = originalBody.topicId || requestId
    ↓
onConversationEnd() 使用 worldviewSessionId 作为文档目录名
    ↓
messageProcessor 处理时 requestId 同样派生自 topicId
```

---

## 十九、已知问题与修复记录

| 问题 | 严重程度 | 状态 | 修复方式 |
|------|----------|------|----------|
| WorldviewPlugin 静态插件无法获取 requestId | 严重 | 已修复 | 从 manifest 中移除 systemPromptPlaceholders，在 messageProcessor 中特殊处理 |
| worldviewCompressor 正则只捕获 AI 答复第一行 | 中等 | 已修复 | 更新正则表达式以捕获多行内容 |
| LLM 返回 IGNORE 导致无文档创建 | 中等 | 已修复 | 优化 Prompt，过滤规则改为只跳过纯问候语 |
| Promise 队列传入 Promise 而非闭包 | 严重 | 已在 v2.1 修复 | enqueue 函数接收闭包函数延迟执行 |
| 摘要混入上一轮对话内容 | 严重 | 已修复 | 只传本轮对话（用户最新一条+AI回复）而非完整历史 |
| formatNewEntry 多行bullet格式化重复 | 中等 | 已修复 | 过滤掉可能的 `**AI答复**:` 等标题行，只保留要点 |
| archiveOldEntries 引用已删除字段 keyConclusion | 中等 | 已修复 | 改为使用 aiResponse 字段 |
| appendEntry 归档区检测逻辑无效（activeSection永远为空） | 中等 | 已修复 | 改为检查 header.includes('## 🗄️') |
| Regex解析错位（可选字段永远为空） | 致命 | 已修复 | 使用高容错正则，兼容各种格式的 `(可选)` 标记 |
| globalInstruction 字段遗漏 | 致命 | 已修复 | 在 parseSummaryResponse 中补充提取逻辑 |
| 缺少文件热重载机制 | 严重 | 已修复 | 添加 Chokidar 监听，手动编辑 MD 文件后自动刷新缓存 |
| Token估算不精确（简单字符长度乘数） | 中等 | 已修复 | 使用 @dqbd/tiktoken 精确计算，回退到简单估算 |
| 文档解析过于脆弱 | 中等 | 已修复 | 使用容错正则，解析失败时保留原文 |
| WorldviewPlugin 同步方法 getWorldviewContentSync 不存在 | 致命 | 已修复 | 改为异步 getWorldviewContent，修复缓存击穿问题 |
| 中断对话（isAborted）导致半截子记忆 | 严重 | 已修复 | 添加 isAborted 标志位，动态补充系统提示 |
| 世界观文档过大撑爆上下文 | 严重 | 已修复 | 注入前进行 Token 预算检查，超限时只保留当前进行中区域 |
| LLM 调用偶发失败直接降级 | 中等 | 已修复 | 添加指数退避重试机制（2s, 4s, 8s） |
| Promise 队列断链（上一个任务throw导致后续永不执行） | 致命 | 已修复 | 在 .then() 前添加 .catch() 吞掉错误，保证队列畅通 |
| getWorldviewContent 空指针异常 | 致命 | 已修复 | 添加 safeUser/safeAi 防御性默认值保护 |
| messageProcessor Token 估算倍率错误（0.4 应为 1.5） | 严重 | 已修复 | 将中文场景下的估算倍率从 0.4 改为 1.5 |
| 归档区 AI 答复正则无法匹配多行 Markdown 列表 | 中等 | 已修复 | 使用 `[\s\S]*?` 跨行匹配，并清理换行符 |
| removeSaveMarkers 全局正则 lastIndex 未重置 | 中等 | 已修复 | 添加 `lastIndex = 0` 重置 |
| 摘要生成时 aiResponse 标记未清理导致混入摘要 | 严重 | 已修复 | 先调用 processAIContent 清理，再用于摘要生成 |
| worldviewGenerator 存在 duplicate return result 代码块 | 中等 | 已修复 | 删除多余代码块 |
| 标记语法误放入LLM摘要器SYSTEM_PROMPT | 致命 | 已修复 | 删除SYSTEM_PROMPT中的【重要输出标记】段落，移至buildHeader |
| 二进制文件扩展名污染（.xlsx被文本内容覆写） | 致命 | 已修复 | binary模式下强制使用 `${ext}.desc` 作为物理文件扩展名 |
| 版本控制正则无法匹配复合扩展名（如.xlsx.desc） | 严重 | 已修复 | getExistingVersions改用传入extension参数构造精确正则 |
| 版本号停滞导致"无限覆盖"（versions<MAX时未计算正确版本号） | 致命 | 已修复 | 在break前检查versions.length>0并计算maxVersion+1 |
| removeSaveMarkers空替换导致LLM摘要"睁眼瞎" | 致命 | 已修复 | 替换为空字符串改为系统存根`[系统记录：已自动保存文本附件...]` |
| truncateWorldviewIfNeeded截断时丢失header（标记指令） | 致命 | 已修复 | 截断时保留header并预扣token预算 |
| Context Optimizer过滤掉System Prompt导致AI失忆 | 致命 | 已修复 | 永远保留system角色消息，只截取User/Assistant对话 |
| Handler传递originalBody.messages而非currentMessagesForLoop | 严重 | 已修复 | 改为传递累积消息数组currentMessagesForLoop |
