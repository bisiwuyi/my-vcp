# VTPBroker 模块文档

## 概述

VTPBroker (VCP Tool Broker) 是 VCP 原生工具发现的中间代理模块，负责按需提供工具信息，但不执行实际工具。

## 核心功能

| 方法 | 说明 |
|------|------|
| `list_categories()` | 获取所有工具分类及每个分类下的工具数量 |
| `list_tools(categoryId)` | 获取指定分类下的工具摘要列表，不指定则返回全部 |
| `get_tool_schema(toolId)` | 获取工具完整调用格式，包括参数 Schema 和调用示例 |
| `get_agent_top_tools(agentAlias, limit)` | 获取 Agent 常用工具（带热度排序） |
| `get_tool_schemas(toolIds)` | 批量获取工具 Schema |

## 架构设计

```
┌─────────────────────────────────────────┐
│           Agent (AI)                    │
│  调用 vtbroker_list_tools / get_tool_schema 发现工具
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│           VTPBroker                     │
│  - 单例模式                             │
│  - 订阅 PluginManager 事件保持同步      │
│  - 多层索引加速查找                     │
│  - 热度统计（全局/Agent 双维度）       │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         PluginManager                   │
│  管理所有插件生命周期                   │
└─────────────────────────────────────────┘
```

## 目录结构

```
modules/vtbroker/
├── index.js              # 主模块，实现 VTPBroker 类
├── category-mapper.js    # 工具分类映射
├── schema-generator.js   # 生成工具 Schema
├── tool-summary-index.js # 工具摘要索引
├── module.js             # 模块导出
├── data/                 # 热度统计数据目录
│   └── tool_usage.json   # 热度统计数据文件
└── config/
    └── category-mappings.json  # 分类映射配置文件
```

## v2.0 新功能

### 热度统计与智能排序

VTPBroker v2.0 支持工具使用热度统计和智能排序功能：

- **全局热度统计**：记录所有工具的使用次数
- **Agent 维度统计**：按 Agent 别名分别统计工具使用
- **时间衰减加权**：最近使用权重更高，使用 `exp(-days * 0.1)` 计算
- **冷启动兜底**：新 Agent 或数据不足时回退到全局热门

#### 热度计算公式

```
score = count * exp(-days_since_used * 0.1)
```

其中：
- `count`：使用次数
- `days_since_used`：距离上次使用天数
- 7 天内数据参与排名，超过 7 天视为过期

#### 数据持久化

热度统计数据存储在 `modules/vtbroker/data/tool_usage.json`，启动时自动加载。

### 常用工具接口

```javascript
// 获取 Agent 的常用工具
const topTools = broker.get_agent_top_tools('myAgent', 5);
// 返回格式：
// [
//   { toolId, name, description, callExample },
//   ...
// ]

// 获取全局热门工具
const globalTop = broker.get_agent_top_tools(null, 5);
```

### 批量 Schema 获取

```javascript
// 一次获取多个工具的 Schema
const schemas = broker.get_tool_schemas(['tool1', 'tool2', 'tool3']);
// 返回数组，未找到的工具返回 null
```

## 配置管理

### category-mappings.json

分类映射配置文件，位于 `modules/vtbroker/config/category-mappings.json`。

**配置格式**：

```json
{
    "version": "1.0",
    "categories": [
        {
            "id": "search",
            "name": "搜索工具",
            "desc": "用于搜索信息",
            "keywords": ["搜索", "查询"]
        }
    ],
    "mappings": {
        "GoogleSearch": ["search"],
        "ArxivDailyPapers": ["search"]
    },
    "aliases": {
        "googlesearch": "GoogleSearch"
    }
}
```

### 运行时动态配置

支持运行时添加映射（不持久化，重启后失效）：

```javascript
const CategoryMapper = require('./category-mapper');
const mapper = CategoryMapper.getInstance();

// 添加映射
mapper.addMapping('NewPlugin', ['search', 'knowledge']);

// 添加新分类
mapper.addCategory('new_category', '新分类', '描述', ['关键词']);

// 重新加载配置文件
mapper.reloadConfig();
```

## 工具 Schema 格式

`get_tool_schema()` 返回格式：

```json
{
    "toolId": "googlesearch_googlesearch",
    "name": "googlesearch_googlesearch",
    "originalName": "GoogleSearch",
    "description": "Google 搜索工具",
    "pluginName": "GoogleSearch",
    "categories": ["search"],
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "搜索关键词"
            }
        },
        "required": ["query"]
    },
    "callExample": "<<<[TOOL_REQUEST]>>>\ntool_name:「始」GoogleSearch「末」\nquery:「始」关键词「末」\n<<<[END_TOOL_REQUEST]>>>",
    "isDistributed": false,
    "serverId": null,
    "executionHint": "该工具为本地工具，可直接执行"
}
```

## 缓存一致性

VTPBroker 通过订阅 PluginManager 的 `pluginsLoaded` 事件自动保持缓存同步。

当管理员在后台热重载插件时：
1. PluginManager 重新加载插件
2. 触发 `pluginsLoaded` 事件
3. VTPBroker 自动调用 `rebuildIndex()` 重建索引

## 多层索引查找策略

`get_tool_schema()` 使用以下匹配策略（按优先级）：

1. **精确匹配**：`toolId === cacheKey`
2. **索引匹配**：toolId 小写 → nameIndex → 原名
3. **插件前缀匹配**：`toolId` 以 `pluginName_` 开头
4. **宽松包含匹配**：toolId 与 cacheKey 互相包含

## API 路由

VTPBroker 提供 REST API（挂载于 `/vtbroker/api`）：

| 路由 | 方法 | 说明 |
|------|------|------|
| `/categories` | GET | 获取所有分类 |
| `/tools` | GET | 获取工具列表，`?category_id=` 筛选 |
| `/schema/:toolId` | GET | 获取工具 Schema |
| `/schemas` | POST | 批量获取工具 Schema，`{toolIds: ["id1", "id2"]}` |
| `/top-tools` | GET | 获取常用工具，`?agent_alias=` `?limit=` |
| `/stats` | GET | 获取统计信息 |
| `/health` | GET | 健康检查 |

### API 示例

```bash
# 批量获取 Schema
curl -X POST http://localhost:3000/vtbroker/api/schemas \
  -H "Content-Type: application/json" \
  -d '{"toolIds": ["googlesearch_googlesearch", "testplugin_test"]}'

# 获取常用工具
curl http://localhost:3000/vtbroker/api/top-tools?agent_alias=myAgent&limit=5
```

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 2.0.1 | 2026-03-29 | 修复 Plugin Handler 遗漏 get_agent_top_tools 命令 |
| 2.0.0 | 2026-03-29 | 新增热度统计、智能排序、批量 Schema 接口 |
| 1.1.3 | 2026-03-29 | 修复别名解析后精确匹配仍使用原始输入的BUG |
| 1.1.2 | 2026-03-29 | 修复 get_tool_schema 缺少别名解析、前缀匹配过于严格的问题 |
| 1.1.1 | 2026-03-29 | 修复大小写不同toolId互相覆盖索引的BUG |
| 1.1.0 | 2026-03-29 | 支持配置文件加载、多层索引、分布式插件标记、PluginManager事件订阅 |
| 1.0.0 | 2026-03-12 | 初始版本 |

## 测试状态

### 基础功能测试（test-vtbroker-modifications.js）

| 测试项 | 状态 | 说明 |
|--------|------|------|
| P0-1 缓存一致性 | ✅ 通过 | PluginManager 事件订阅正常，热重载后索引自动更新 |
| P0-2 分类映射配置 | ✅ 通过 | 配置文件加载正常（59个插件映射），别名解析正常 |
| P1-1 多层索引 | ✅ 通过 | 精确匹配（含别名解析）、索引匹配、前缀匹配均正常 |
| P1-2 分布式标记 | ✅ 通过 | isDistributed、serverId、executionHint 均正确 |

测试结果：**31/31 通过**

### v2.0 新功能测试（test-vtbroker-v2.js）

| 测试项 | 状态 | 说明 |
|--------|------|------|
| 热度统计记录 | ✅ 通过 | 正确记录全局和 Agent 维度使用 |
| get_agent_top_tools | ✅ 通过 | 正确返回排序后的常用工具 |
| 批量 Schema 获取 | ✅ 通过 | get_tool_schemas 正确返回数组 |
| agentContext 传递 | ✅ 通过 | get_tool_schema 带 agentContext 时正确记录 |
| null agentContext 处理 | ✅ 通过 | agentContext 为 null 时不记录但正常返回 |
| 全局兜底逻辑 | ✅ 通过 | Agent 数据不足时用全局补充 |
| 冷启动处理 | ✅ 通过 | 无数据时返回 null |

测试结果：**19/19 通过**

## 代码审查状态

| 审查项 | 状态 | 说明 |
|--------|------|------|
| 语法正确性 | ✅ 通过 | 所有文件通过 Node.js 语法检查 |
| 事件订阅机制 | ✅ 通过 | pluginsLoaded 事件正确处理 |
| 多层索引 | ✅ 通过 | 大小写不同工具不互相覆盖 |
| 别名解析 | ✅ 通过 | get_tool_schema 开头调用 resolveAlias |
| 精确匹配 | ✅ 通过 | 使用 resolvedToolId 而非原始 toolId |
| 前缀匹配 | ✅ 通过 | 支持部分前缀匹配（≥3字符） |
| 配置加载 | ✅ 通过 | JSON 解析、错误处理正常 |
| 分布式标记 | ✅ 通过 | Schema 正确返回分布式信息 |
| 热度统计 | ✅ 通过 | 全局/Agent 双维度，时间衰减正确 |
| 兜底逻辑 | ✅ 通过 | Agent 数据不足时正确回退到全局 |
| 批量接口 | ✅ 通过 | 数组参数校验，返回格式正确 |

**审查结论**：v2.0 代码已通过全面审查，未发现明显的功能错误或 BUG。

## Bug 修复记录

### v2.0.1: Plugin Handler 遗漏 get_agent_top_tools 命令

**问题**：`Plugin/VTPBroker/vtbroker-handler.js` 中未添加 `get_agent_top_tools` 命令处理。

**修复**：在 `handleCommand` switch 语句中添加 `get_agent_top_tools` case，并实现 `handleGetAgentTopTools` 函数。

**影响**：AI 通过 Plugin 协议调用 `vtbroker_get_agent_top_tools` 时会返回 "Unknown command" 错误。

**修复文件**：
- `Plugin/VTPBroker/vtbroker-handler.js`

## 性能优化建议

| 问题 | 位置 | 说明 | 优先级 |
|------|------|------|--------|
| 第4层宽松匹配 O(n²) | index.js | 工具数量 > 200 时可能存在性能问题 | 低 |

如未来工具数量大幅增长，可优化为 `Map` 预缓存别名索引替代嵌套循环。
