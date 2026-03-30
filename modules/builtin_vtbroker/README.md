# BuiltinVTPBroker 模块文档

## 概述

BuiltinVTPBroker 是 VCP 内置的工具发现中间件，整合了 modules/vtbroker v2.0.1 与 Plugin/vtbroker v1.2.0 的全部功能。

## 核心特性

| 特性 | 说明 |
|------|------|
| 单例模式 | 集成到 server.js，与 PluginManager 生命周期绑定 |
| 事件订阅 | 订阅 pluginLoaded/pluginUnloaded/pluginUpdated 事件，零延迟同步 |
| 热度统计 | 全局/Agent 双维度，时间衰减加权 |
| 模糊搜索 | fuzzyMatch 算法，支持多词组合 |
| 别名解析 | resolveAlias 能力，支持工具名别名映射 |
| 分类映射 | CategoryMapper 支持可配置分类 |
| 渐进式披露 | 初始化预注入 + 按需动态检索 + 运行时纠错补全 |
| 注意点注入 | 首次调用自动注入插件注意点 |

## 配置开关

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| ENABLE_BUILTIN_VTBROKER | false | 启用内置模式（替代独立 VTPBroker） |
| VTBROKER_ENABLE_FUZZY_MATCH | true | 启用模糊搜索 |
| VTBROKER_MAX_RESULTS | 100 | 最大返回结果数 |

## 架构设计

```
┌─────────────────────────────────────────────┐
│              server.js                       │
│  根据 ENABLE_BUILTIN_VTBROKER 初始化对应模块  │
└─────────────────┬───────────────────────────┘
                  │
    ┌─────────────┴─────────────┐
    │                           │
    ▼                           ▼
┌───────────────────┐   ┌───────────────────┐
│ modules/vtbroker  │   │modules/builtin_   │
│   (独立模式)       │   │  vtbroker         │
│                   │   │  (内置模式)        │
└───────────────────┘   └───────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ PluginManager   │  │ CategoryMapper  │  │ SchemaGenerator │
│ 钩子事件         │  │ (共享)          │  │ (共享)          │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

## API 接口

### REST API (/vtbroker/api/*)

| 路由 | 方法 | 说明 |
|------|------|------|
| `/categories` | GET | 获取所有分类 |
| `/tools` | GET | 获取工具列表 |
| `/schema/:toolId` | GET | 获取工具 Schema |
| `/schemas` | POST | 批量获取 Schema |
| `/top-tools` | GET | 获取常用工具 |
| `/search` | GET | 模糊搜索工具 |
| `/stats` | GET | 获取统计信息 |
| `/health` | GET | 健康检查 |

### JavaScript API

```javascript
const BuiltinVTPBroker = require('./modules/builtin_vtbroker');
const broker = BuiltinVTPBroker.getInstance();

// 初始化
broker.initialize(pluginManager);

// 获取分类
broker.list_categories();

// 获取工具列表
broker.list_tools('search');

// 获取工具 Schema
broker.get_tool_schema('googlesearch_googlesearch', 'agent1');

// 模糊搜索
broker.search_tools('bilibili', 'search');

// 获取常用工具
broker.get_agent_top_tools('agent1', 5);

// 获取带注意点的 Schema
broker.get_tool_schema_with_notice('toolId', 'agent1');

// 设置插件注意点
broker.setPluginUsageNotice('PluginName', '使用注意事项');

// 渐进式工具披露
broker.getInitialToolsDisclosure('agent1', 5);
broker.getOnDemandToolsDisclosure('陌生任务关键词', 3);
```

## 渐进式工具披露

### 三层机制

1. **初始化预注入**：Agent 生成时返回 Top3~5 常用工具的极简 Schema
2. **按需动态检索**：Agent 遇到陌生任务时返回 1~3 个相关工具的完整 Schema
3. **运行时纠错补全**：工具调用参数错误时返回参数说明片段

### API

```javascript
// 初始化披露（≤200 Token）
const initialTools = broker.getInitialToolsDisclosure('agent1', 5);

// 按需披露（单工具 ≤100 Token）
const onDemandTools = broker.getOnDemandToolsDisclosure('任务描述', 3);

// 参数纠错（≤50 Token）
const correction = broker.getToolParamCorrection('toolId', '参数错误提示');
```

## 插件注意点注入

### 使用方式

```javascript
// 设置注意点
broker.setPluginUsageNotice('PluginName', '使用注意事项内容');

// 获取带注入的 Schema（首次调用自动注入）
const schema = broker.get_tool_schema_with_notice('toolId', 'agent1');

// 强制注入（忽略首次调用检查）
const schemaForced = broker.get_tool_schema_with_notice('toolId', 'agent1', true);
```

### 返回格式

```json
{
  "toolId": "xxx",
  "name": "xxx",
  "description": "...",
  "callExample": "...",
  "usageNotice": "首次调用时注入的注意点",
  "noticeInjectReason": "first_call"
}
```

## 兼容性

- 与 modules/vtbroker API 完全兼容
- Plugin/VTBroker 适配层支持自动切换模式
- 当 ENABLE_BUILTIN_VTBROKER=true 时，插件请求转发到内置模块
- 热度统计数据存储在 `Plugin/VTBroker/data/tool_usage.json`

## AdminPanel 集成

### 插件注意事项配置

在 AdminPanel 的插件配置页面，每个插件现在都有一个新的「插件使用注意事项」配置区域：

1. **启用自动注入**：开关控制是否启用首次调用注入
2. **注意事项内容**：多行文本框，支持 Markdown 格式

### 配置存储

注意点配置存储在插件的 `config.env` 文件中：

```
PLUGIN_USAGE_NOTICE_<插件名>=注意事项内容
PLUGIN_USAGE_NOTICE_ENABLED_<插件名>=true
```

### 临时配置方式

在 AdminPanel 的插件配置页面，点击「添加自定义配置项」：
- 配置名：`PLUGIN_USAGE_NOTICE_<插件名>`
- 配置值：注意点内容（支持多行/Markdown）

### 示例

```
PLUGIN_USAGE_NOTICE_GoogleSearch=使用前请确保已配置有效的 Google API Key
PLUGIN_USAGE_NOTICE_ENABLED_GoogleSearch=true
```

## 文件结构

```
modules/builtin_vtbroker/
├── index.js              # 主模块
├── module.js             # 模块导出
└── config/               # 配置文件（复用 modules/vtbroker/config）

Plugin/VTBroker/
├── VTPBroker.js         # 插件适配层（转发请求到内置模块）
├── plugin-manifest.json  # 插件配置
├── config.env            # 插件配置
├── README.md             # 插件文档
└── data/
    └── tool_usage.json   # 热度统计数据
```
```
