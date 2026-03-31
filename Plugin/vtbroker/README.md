# VTPBroker v1.2.0 - VCP工具中介

## 核心定位
VTPBroker是VCP工具发现中间代理层，解耦Agent与PluginManager，仅提供工具元信息不执行工具，屏蔽底层插件加载细节。

## 核心功能
1. **分类查询**：按分类查询工具列表，支持全量查询与分类过滤
2. **工具列表查询**：返回所有已注册工具的基础信息
3. **模糊搜索**：支持按名称、描述、标签进行关键词匹配搜索，支持多词组合
4. **工具Schema查询**：获取指定工具的完整调用格式、参数说明与示例
5. **定时刷新**：按配置的间隔自动刷新索引（默认300秒），支持热更新插件变更
6. **四层索引**：byId/byCategory/byName/byTag四层索引，毫秒级查询响应
7. **双轨兼容**：同时支持 `commandIdentifier` 和旧字段 `command`，确保对旧插件的兼容性
8. **同名去重**：`byName` 索引支持同名工具数组，通过 `byId` 可精确访问

## 架构说明

### 两种运行模式

| 模式 | 配置键 | 说明 |
|------|--------|------|
| 内置模式 | `ENABLE_BUILTIN_VTBROKER=true` | 转发请求到 server.js REST API，共享 PluginManager 实例，支持热度统计 |
| 独立模式 | `ENABLE_BUILTIN_VTBROKER=false` | 独立目录扫描，每次调用重新索引，无热度统计 |

### 内置模式 vs 独立模式功能差异

| 功能 | 内置模式 | 独立模式 |
|------|----------|----------|
| 热度统计 | ✅ 支持 | ❌ 不支持 |
| 插件热重载 | ✅ 事件订阅 | ⚠️ 定时刷新 |
| 工具披露 | ✅ 完整 | ✅ 基础 |
| REST API | ✅ 完整 | ❌ 不可用 |

## 配置参数

### 独立模式 (config.env)
| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| INDEX_REFRESH_INTERVAL | integer | 300 | 工具索引自动刷新间隔（秒） |
| ENABLE_FUZZY_SEARCH | boolean | true | 开启时搜索范围扩展到描述字段 |
| MAX_RESULTS_PER_QUERY | integer | 100 | 单次查询最大返回结果数 |

### 内置模式 (环境变量)
| 参数名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| ENABLE_BUILTIN_VTBROKER | string | 'false' | 启用内置模式 |
| VTBROKER_ENABLE_FUZZY_MATCH | string | 'true' | 开启模糊匹配 |
| VTBROKER_MAX_RESULTS | integer | 100 | 最大返回结果数 |

## 使用示例

### 1. 查询全量工具列表
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTPBroker「末」,
command:「始」list_tools「末」,
category_id:「始」*「末」
<<<[END_TOOL_REQUEST]>>>
```

### 2. 按分类查询
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTPBroker「末」,
command:「始」list_tools「末」,
category_id:「始」search「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3. 模糊搜索工具（开启模糊搜索时）
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTPBroker「末」,
command:「始」search_tools「末」,
query:「始」bilibili 视频「末」
<<<[END_TOOL_REQUEST]>>>
```

### 4. 精确搜索工具（关闭模糊搜索时）
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTPBroker「末」,
command:「始」search_tools「末」,
query:「始」bilibilifetch「末」
<<<[END_TOOL_REQUEST]>>>
```

### 5. 获取工具Schema
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」VTPBroker「末」,
command:「始」get_tool_schema「末」,
tool_id:「始」bilibilifetch_bilibilifetch「末」
<<<[END_TOOL_REQUEST]>>>
```

## 工具ID格式
工具ID格式为 `${pluginName}_${commandName}`，全部小写。

例如：`bilibilifetch_bilibilifetch`、`fileoperator_readfile`

## 索引统计
- 当前索引工具数：60个（持续更新中）
- 支持的分类：file_ops、code、search、knowledge、collaboration、uncategorized

## 注意事项

### 首次调用注入
插件使用注意事项（notice）仅在首次调用时注入，第二次调用不再重复注入。
这是按 `agentAlias + toolId` 组合判断的，用于避免重复提醒。

### 内置模式 REST API
当启用内置模式时，可通过以下端点访问：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/vtbroker/api/tools` | GET | 获取工具列表 |
| `/vtbroker/api/tools?category_id=xxx` | GET | 按分类获取工具 |
| `/vtbroker/api/schema/:toolId` | GET | 获取工具Schema |
| `/vtbroker/api/search?query=xxx` | GET | 模糊搜索工具 |
| `/vtbroker/api/categories` | GET | 获取分类列表 |
| `/vtbroker/api/top-tools` | GET | 获取热门工具 |

## 版本历史
- v1.2.0: 整合内置BuiltinVTPBroker，支持热度统计和渐进式工具披露
- v1.1.0: 添加模糊搜索、多层索引优化
- v1.0.0: 初始版本，基础工具发现功能
