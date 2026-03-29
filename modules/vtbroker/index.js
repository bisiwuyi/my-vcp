/**
 * VCP Tool Broker (vtbroker)
 * 
 * VCP 原生工具发现中间商
 * 负责按需提供工具信息，不执行实际工具
 * 
 * 核心功能：
 * - list_categories: 获取所有工具分类
 * - list_tools: 获取某分类下的工具摘要
 * - get_tool_schema: 获取工具完整调用格式
 * - get_agent_top_tools: 获取 Agent 常用工具（带热度排序）
 * - get_tool_schemas: 批量获取工具 Schema
 * 
 * 架构说明：
 * - VTPBroker 单例通过订阅 PluginManager 的 pluginsLoaded 事件保持缓存一致
 * - 使用多层索引（_nameIndex, _pluginIndex）加速工具查找
 * - 支持分布式插件标记，帮助 Agent 识别远程工具
 * - 热度统计支持全局/Agent 双维度，时间衰减加权计算
 */

const fs = require('fs');
const path = require('path');
const CategoryMapper = require('./category-mapper');
const SchemaGenerator = require('./schema-generator');

class VTPBroker {
    constructor() {
        this.categoryMapper = CategoryMapper.getInstance();
        this._toolsCache = new Map();      // toolId -> tool info
        this._nameIndex = new Map();       // toolId小写 -> [toolIds]（支持大小写不同的同名工具）
        this._pluginIndex = new Map();     // pluginName小写 -> [toolIds]
        this._initialized = false;
        this._pluginManagerRef = null;
        
        // v2.0 热度统计数据结构
        this._toolUsageStats = new Map();     // agentAlias -> Map<toolId, {count, lastUsed}>
        this._globalToolStats = new Map();    // toolId -> {count, lastUsed}
        this._usageFilePath = path.join(__dirname, 'data', 'tool_usage.json');
    }

    /**
     * 初始化 - 从 PluginManager 加载所有工具
     * @param {Object} pluginManager - PluginManager 实例
     */
    initialize(pluginManager) {
        if (this._initialized) {
            console.warn('[VTPBroker] 已初始化，忽略重复初始化请求');
            return;
        }

        this._pluginManagerRef = pluginManager;
        
        // 订阅 PluginManager 的插件加载事件，保持缓存一致
        if (this._pluginManagerRef && typeof this._pluginManagerRef.on === 'function') {
            this._pluginManagerRef.on('pluginsLoaded', () => {
                console.log('[VTPBroker] 接收到 pluginsLoaded 事件，正在重建工具索引...');
                this.rebuildIndex();
            });
            console.log('[VTPBroker] 已订阅 PluginManager pluginsLoaded 事件');
        }

        // v2.0: 加载热度统计数据
        this._loadUsageStats();
        
        this._loadAllTools();
        this._initialized = true;
        console.log(`[VTPBroker] 初始化完成，共加载 ${this.getTotalToolCount()} 个工具`);
    }

    /**
     * 从 PluginManager 加载所有工具
     * 构建多层索引加速查找
     */
    _loadAllTools() {
        this._toolsCache.clear();
        this._nameIndex.clear();
        this._pluginIndex.clear();

        if (!this._pluginManagerRef || !this._pluginManagerRef.plugins) {
            console.warn('[VTPBroker] PluginManager 未就绪，无法加载工具');
            return;
        }

        for (const [pluginName, manifest] of this._pluginManagerRef.plugins) {
            const schema = SchemaGenerator.generate(manifest, { prefix: '' });
            
            if (schema.tools && schema.tools.length > 0) {
                for (const tool of schema.tools) {
                    const toolId = tool.name;
                    const toolIdLower = toolId.toLowerCase();
                    const categories = this.categoryMapper.getCategoriesForTool(toolId);
                    
                    // 如果没有找到类别，尝试从 description 推断
                    let finalCategories = categories;
                    if (finalCategories.length === 0) {
                        finalCategories = this.categoryMapper.inferCategoriesFromDescription(
                            toolId, 
                            tool.description
                        );
                    }
                    
                    // 如果仍然没有类别，归入 uncategorized
                    if (finalCategories.length === 0) {
                        finalCategories = ['uncategorized'];
                    }

                    // 记录分布式插件信息
                    const isDistributed = manifest.isDistributed || false;
                    const serverId = manifest.serverId || null;

                    this._toolsCache.set(toolId, {
                        toolId,
                        name: tool.name,
                        originalName: pluginName,
                        description: tool.description || `${pluginName} tool`,
                        pluginName: pluginName,
                        categories: finalCategories,
                        inputSchema: tool.inputSchema || null,
                        isDistributed,
                        serverId
                    });

                    // 构建索引（支持大小写不同但同名的工具）
                    if (!this._nameIndex.has(toolIdLower)) {
                        this._nameIndex.set(toolIdLower, []);
                    }
                    this._nameIndex.get(toolIdLower).push(toolId);
                    
                    // 按插件名建立反向索引
                    const pluginKey = pluginName.toLowerCase();
                    if (!this._pluginIndex.has(pluginKey)) {
                        this._pluginIndex.set(pluginKey, []);
                    }
                    this._pluginIndex.get(pluginKey).push(toolId);
                }
            }
        }
    }

    /**
     * 重建索引 - 重新从 PluginManager 加载所有工具
     * 用于热重载后的缓存同步
     */
    rebuildIndex() {
        if (!this._pluginManagerRef) {
            console.warn('[VTPBroker] rebuildIndex 调用时 PluginManager 未初始化');
            return;
        }
        this._loadAllTools();
        console.log(`[VTPBroker] 索引重建完成，当前共 ${this.getTotalToolCount()} 个工具`);
    }

    // ==================== v2.0 热度统计功能 ====================

    /**
     * 加载热度统计数据 from JSON file
     */
    _loadUsageStats() {
        try {
            if (fs.existsSync(this._usageFilePath)) {
                const data = JSON.parse(fs.readFileSync(this._usageFilePath, 'utf-8'));
                
                // 恢复 agentStats
                if (data.agentStats) {
                    for (const [agentAlias, tools] of Object.entries(data.agentStats)) {
                        const toolMap = new Map();
                        for (const [toolId, stat] of Object.entries(tools)) {
                            toolMap.set(toolId, stat);
                        }
                        this._toolUsageStats.set(agentAlias, toolMap);
                    }
                }
                
                // 恢复 globalStats
                if (data.globalStats) {
                    for (const [toolId, stat] of Object.entries(data.globalStats)) {
                        this._globalToolStats.set(toolId, stat);
                    }
                }
                
                console.log(`[VTPBroker] 已从文件加载热度统计: ${this._toolUsageStats.size} 个 Agent, ${this._globalToolStats.size} 个工具`);
            }
        } catch (error) {
            console.warn(`[VTPBroker] 加载热度统计失败: ${error.message}`);
        }
    }

    /**
     * 保存热度统计数据 to JSON file
     */
    _saveUsageStats() {
        try {
            const data = {
                agentStats: Object.fromEntries(
                    [...this._toolUsageStats].map(([k, v]) => [k, Object.fromEntries(v)])
                ),
                globalStats: Object.fromEntries(this._globalToolStats),
                savedAt: new Date().toISOString()
            };
            
            const dir = path.dirname(this._usageFilePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(this._usageFilePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.warn(`[VTPBroker] 保存热度统计失败: ${error.message}`);
        }
    }

    /**
     * 记录工具使用
     * @param {string} agentAlias - Agent 别名
     * @param {string} toolId - 工具 ID
     */
    _recordToolUsage(agentAlias, toolId) {
        if (!agentAlias || !toolId) return;
        
        const now = Date.now();
        const dayTimestamp = Math.floor(now / (24 * 60 * 60 * 1000));
        
        // 更新 Agent 维度
        if (!this._toolUsageStats.has(agentAlias)) {
            this._toolUsageStats.set(agentAlias, new Map());
        }
        const agentStats = this._toolUsageStats.get(agentAlias);
        if (!agentStats.has(toolId)) {
            agentStats.set(toolId, { count: 0, lastUsed: dayTimestamp });
        }
        const toolStat = agentStats.get(toolId);
        toolStat.count++;
        toolStat.lastUsed = dayTimestamp;
        
        // 更新全局维度
        if (!this._globalToolStats.has(toolId)) {
            this._globalToolStats.set(toolId, { count: 0, lastUsed: dayTimestamp });
        }
        this._globalToolStats.get(toolId).count++;
        this._globalToolStats.get(toolId).lastUsed = dayTimestamp;
        
        // 延迟保存，避免频繁写盘
        this._debouncedSave();
    }

    /**
     * 防抖保存（5秒内最多保存一次）
     */
    _debouncedSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveUsageStats();
            this._saveTimer = null;
        }, 5000);
    }

    /**
     * 获取 Agent 的 Top N 常用工具（带热度排序）
     * @param {string} agentAlias - Agent 别名
     * @param {number} limit - 返回数量，默认 5
     * @returns {Array} 排序后的 toolId 数组
     */
    _getAgentTopTools(agentAlias, limit = 5) {
        const currentDay = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
        const sevenDaysAgo = currentDay - 7;
        
        // 1. 获取 Agent 7 天内数据
        const agentStats = this._toolUsageStats.get(agentAlias) || new Map();
        const agentTop = [];
        for (const [toolId, stat] of agentStats) {
            if (stat.lastUsed >= sevenDaysAgo) {
                const daysSinceUsed = currentDay - stat.lastUsed;
                const weight = stat.count * Math.exp(-daysSinceUsed * 0.1); // 指数衰减
                agentTop.push({ toolId, score: weight, count: stat.count });
            }
        }
        agentTop.sort((a, b) => b.score - a.score);
        
        // 2. 不足 limit 个时，用全局补充
        if (agentTop.length < limit) {
            const globalTop = this._getGlobalTopTools(limit - agentTop.length, sevenDaysAgo);
            const existingIds = new Set(agentTop.map(t => t.toolId));
            for (const g of globalTop) {
                if (!existingIds.has(g.toolId)) {
                    agentTop.push(g);
                    existingIds.add(g.toolId);
                }
            }
        }
        
        return agentTop.slice(0, limit);
    }

    /**
     * 获取全局 Top N 常用工具
     * @param {number} limit - 返回数量，默认 5
     * @param {number} minDayTimestamp - 最小日期戳（可选，用于与其他方法配合）
     * @returns {Array} 排序后的 {toolId, score, count} 数组
     */
    _getGlobalTopTools(limit = 5, minDayTimestamp = null) {
        const currentDay = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
        const sevenDaysAgo = minDayTimestamp || (currentDay - 7);
        
        const global = [];
        for (const [toolId, stat] of this._globalToolStats) {
            if (stat.lastUsed >= sevenDaysAgo) {
                const daysSinceUsed = currentDay - stat.lastUsed;
                const weight = stat.count * Math.exp(-daysSinceUsed * 0.1);
                global.push({ toolId, score: weight, count: stat.count });
            }
        }
        global.sort((a, b) => b.score - a.score);
        return global.slice(0, limit);
    }

    /**
     * 获取 Agent 的常用工具列表（对外接口）
     * @param {string} agentAlias - Agent 别名（可选，为 null 时返回全局热门）
     * @param {number} limit - 返回数量，默认 5
     * @returns {Array|null} 工具摘要列表，失败返回 null
     */
    get_agent_top_tools(agentAlias = null, limit = 5) {
        // 1. 获取 Top toolIds
        let topTools;
        if (agentAlias) {
            topTools = this._getAgentTopTools(agentAlias, limit);
        } else {
            topTools = this._getGlobalTopTools(limit);
        }
        
        // 2. 如果为空，跳过注入
        if (!topTools || topTools.length === 0) {
            return null;
        }
        
        // 3. 获取完整 Schema
        const result = [];
        for (const toolInfo of topTools) {
            const schema = this.get_tool_schema(toolInfo.toolId);
            if (schema) {
                result.push({
                    toolId: schema.toolId,
                    name: schema.name,
                    description: schema.description,
                    callExample: schema.callExample
                });
            }
        }
        
        return result.length > 0 ? result : null;
    }

    // ==================== 原有功能 ====================

    /**
     * 1. 获取所有工具分类
     */
    list_categories() {
        const categories = this.categoryMapper.getAllCategories();
        const result = [];

        for (const cat of categories) {
            // 计算该分类下的工具数量
            let toolCount = 0;
            for (const [toolId, toolInfo] of this._toolsCache) {
                if (toolInfo.categories.includes(cat.id)) {
                    toolCount++;
                }
            }

            result.push({
                id: cat.id,
                name: cat.name,
                description: cat.desc,
                toolCount: toolCount
            });
        }

        return result;
    }

    /**
     * 2. 获取某分类下的工具摘要列表
     */
    list_tools(categoryId) {
        if (!categoryId) {
            // 返回所有工具
            const result = [];
            for (const [toolId, toolInfo] of this._toolsCache) {
                result.push({
                    toolId: toolInfo.toolId,
                    name: toolInfo.name,
                    description: toolInfo.description,
                    pluginName: toolInfo.pluginName
                });
            }
            return result;
        }

        const result = [];
        for (const [toolId, toolInfo] of this._toolsCache) {
            if (toolInfo.categories.includes(categoryId)) {
                result.push({
                    toolId: toolInfo.toolId,
                    name: toolInfo.name,
                    description: toolInfo.description,
                    pluginName: toolInfo.pluginName
                });
            }
        }
        return result;
    }

    /**
     * 3. 获取工具完整调用格式
     * 
     * 多层匹配策略：
     * 0. 别名解析：先尝试解析别名（如 googlesearch → GoogleSearch）
     * 1. 精确匹配：toolId = cacheKey
     * 2. 索引匹配：toolId小写 = nameIndex.key
     * 3. 插件前缀匹配：toolId 以 pluginName 开头或相等
     * 4. 宽松包含匹配：toolId 是 cacheKey 的子串或超串
     * 
     * @param {string} toolId - 工具 ID
     * @param {string} agentContext - Agent 上下文（可选，用于热度统计）
     */
    get_tool_schema(toolId, agentContext = null) {
        if (!toolId) {
            return null;
        }
        
        // 0. 别名解析
        const resolvedToolId = this.categoryMapper.resolveAlias(toolId);
        
        const toolIdLower = resolvedToolId.toLowerCase();
        
        // 1. 精确匹配（使用解析后的工具名）
        if (this._toolsCache.has(resolvedToolId)) {
            const result = this._formatSchema(this._toolsCache.get(resolvedToolId));
            // v2.0: 记录使用
            if (agentContext && result) {
                this._recordToolUsage(agentContext, resolvedToolId);
            }
            return result;
        }
        
        // 2. 索引匹配（toolId 小写 → [toolIds]）
        const indexedToolIds = this._nameIndex.get(toolIdLower);
        if (indexedToolIds && indexedToolIds.length > 0) {
            const result = this._formatSchema(this._toolsCache.get(indexedToolIds[0]));
            if (agentContext && result) {
                this._recordToolUsage(agentContext, indexedToolIds[0]);
            }
            return result;
        }
        
        // 3. 插件名前缀匹配
        for (const [pluginKey, toolIds] of this._pluginIndex) {
            if (toolIdLower === pluginKey ||
                toolIdLower.startsWith(pluginKey + '_') ||
                toolIdLower.includes('_' + pluginKey + '_') ||
                (pluginKey.startsWith(toolIdLower) && toolIdLower.length >= 3)) {
                
                const result = this._formatSchema(this._toolsCache.get(toolIds[0]));
                if (agentContext && result) {
                    this._recordToolUsage(agentContext, toolIds[0]);
                }
                return result;
            }
        }
        
        // 4. 宽松包含匹配（最后兜底）
        for (const [cachedToolId, toolInfo] of this._toolsCache) {
            if (cachedToolId.toLowerCase().includes(toolIdLower) ||
                toolIdLower.includes(cachedToolId.toLowerCase())) {
                const result = this._formatSchema(toolInfo);
                if (agentContext && result) {
                    this._recordToolUsage(agentContext, cachedToolId);
                }
                return result;
            }
        }
        
        return null;
    }

    /**
     * 4. 批量获取工具 Schema
     * @param {Array<string>} toolIds - 工具 ID 数组
     * @returns {Array} Schema 数组，与输入顺序对应，未找到为 null
     */
    get_tool_schemas(toolIds) {
        if (!Array.isArray(toolIds) || toolIds.length === 0) {
            return [];
        }
        
        const results = [];
        for (const toolId of toolIds) {
            const schema = this.get_tool_schema(toolId);
            results.push(schema);
        }
        return results;
    }

    /**
     * 格式化 Schema 输出
     */
    _formatSchema(toolInfo) {
        const isDistributed = toolInfo.isDistributed || false;
        const serverId = toolInfo.serverId || null;
        
        let executionHint = '该工具为本地工具，可直接执行';
        if (isDistributed) {
            executionHint = serverId 
                ? `该工具为分布式工具，需要远程服务器 ${serverId} 支持`
                : '该工具为分布式工具，需要远程服务器支持';
        }
        
        return {
            toolId: toolInfo.toolId,
            name: toolInfo.name,
            originalName: toolInfo.originalName || toolInfo.pluginName,
            description: toolInfo.description,
            pluginName: toolInfo.pluginName,
            categories: toolInfo.categories,
            inputSchema: toolInfo.inputSchema,
            callExample: this._generateCallExample(toolInfo),
            isDistributed,
            serverId,
            executionHint
        };
    }

    /**
     * 生成调用示例
     */
    _generateCallExample(toolInfo) {
        const lines = ['<<<[TOOL_REQUEST]>>>'];
        const toolName = toolInfo.originalName || toolInfo.pluginName || toolInfo.name;
        lines.push(`tool_name:「始」${toolName}「末」`);
        
        if (toolInfo.inputSchema && toolInfo.inputSchema.properties) {
            for (const [param, schema] of Object.entries(toolInfo.inputSchema.properties)) {
                const type = schema.type || 'string';
                const example = this._getExampleValue(param, type, schema);
                lines.push(`${param}:「始」${example}「末」`);
            }
        }
        
        lines.push('<<<[END_TOOL_REQUEST]>>>');
        return lines.join('\n');
    }

    /**
     * 获取参数示例值
     */
    _getExampleValue(param, type, schema) {
        if (schema.default !== undefined) {
            return schema.default;
        }
        
        switch (type) {
            case 'string':
                if (param.toLowerCase().includes('path')) return '/path/to/file';
                if (param.toLowerCase().includes('url')) return 'https://example.com';
                if (param.toLowerCase().includes('query') || param.toLowerCase().includes('search')) return '搜索关键词';
                if (param.toLowerCase().includes('command')) return 'ls -la';
                if (param.toLowerCase().includes('content') || param.toLowerCase().includes('text')) return '内容文本';
                return `"${param}的值"`;
            case 'number':
            case 'integer':
                return '1';
            case 'boolean':
                return 'true';
            default:
                return `"${param}的值"`;
        }
    }

    /**
     * 获取总工具数
     */
    getTotalToolCount() {
        return this._toolsCache.size;
    }
}

// 单例模式
let instance = null;

VTPBroker.getInstance = function() {
    if (!instance) {
        instance = new VTPBroker();
    }
    return instance;
};

module.exports = VTPBroker;
