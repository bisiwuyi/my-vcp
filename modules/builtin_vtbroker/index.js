/**
 * Built-in VTPBroker Module
 * 
 * VCP 内置工具发现中间件，整合 modules/vtbroker v2.0.1 与 Plugin/vtbroker v1.2.0 的全部功能
 * 
 * 整合特性：
 * - 单例模式，集成到 server.js
 * - 事件订阅优先 + 目录扫描兜底 双机制
 * - 全局/Agent 双维度热度统计
 * - 可配置 CategoryMapper 分类映射
 * - 完整 fuzzyMatch 模糊搜索实现（精确+模糊双模式自动切换）
 * - resolveAlias 别名解析能力
 * - 全量 REST API 接口
 * - 插件钩子实时同步
 */

const fs = require('fs');
const path = require('path');
const CategoryMapper = require('../vtbroker/category-mapper');
const SchemaGenerator = require('../vtbroker/schema-generator');

const CONFIG = {
    ENABLE_FUZZY_SEARCH: process.env.VTBROKER_ENABLE_FUZZY_MATCH !== 'false',
    MAX_RESULTS_PER_QUERY: parseInt(process.env.VTBROKER_MAX_RESULTS || '100'),
};

class BuiltinVTPBroker {
    constructor() {
        this.categoryMapper = CategoryMapper.getInstance();
        this._toolsCache = new Map();
        this._nameIndex = new Map();
        this._pluginIndex = new Map();
        this._initialized = false;
        this._pluginManagerRef = null;
        this._batchLoading = false;
        this._pendingRebuild = false;
        
        this._toolUsageStats = new Map();
        this._globalToolStats = new Map();
        this._usageFilePath = path.join(__dirname, '..', '..', 'Plugin', 'VTBroker', 'data', 'tool_usage.json');
        
        // 插件注意点按需注入
        this._agentFirstCallCache = new Map();  // agentAlias -> Set<toolId>
        this._pluginUsageNotices = new Map();   // pluginName -> { notice, enabled }
    }

    /**
     * 初始化内置 VTPBroker
     * @param {Object} pluginManager - PluginManager 实例
     */
    initialize(pluginManager) {
        if (this._initialized) {
            console.warn('[BuiltinVTPBroker] 已初始化，忽略重复初始化请求');
            return;
        }

        this._pluginManagerRef = pluginManager;
        
        if (this._pluginManagerRef && typeof this._pluginManagerRef.on === 'function') {
            this._pluginManagerRef.on('pluginsLoaded', () => {
                console.log('[BuiltinVTPBroker] 接收到 pluginsLoaded 事件，正在重建工具索引...');
                this.rebuildIndex();
            });
            
            this._pluginManagerRef.on('pluginLoaded', ({ pluginName, manifest }) => {
                if (this._batchLoading) {
                    this._pendingRebuild = true;
                } else {
                    this._addTool(pluginName, manifest);
                }
            });
            
            this._pluginManagerRef.on('pluginUnloaded', ({ pluginName }) => {
                if (this._batchLoading) {
                    this._pendingRebuild = true;
                } else {
                    this._removeToolsForPlugin(pluginName);
                }
            });
            
            this._pluginManagerRef.on('pluginUpdated', ({ pluginName, manifest }) => {
                if (this._batchLoading) {
                    this._pendingRebuild = true;
                } else {
                    this._removeToolsForPlugin(pluginName);
                    this._addTool(pluginName, manifest);
                }
            });
            
            console.log('[BuiltinVTPBroker] 已订阅 PluginManager 事件 (pluginsLoaded, pluginLoaded, pluginUnloaded, pluginUpdated)');
        }

        this._loadUsageStats();
        
        this._batchLoading = true;
        this._loadAllTools();
        this._batchLoading = false;
        
        if (this._pendingRebuild) {
            this.rebuildIndex();
            this._pendingRebuild = false;
        }
        
        this._initialized = true;
        console.log(`[BuiltinVTPBroker] 初始化完成，共加载 ${this.getTotalToolCount()} 个工具`);
    }

    /**
     * 添加单个工具到索引
     */
    _addTool(pluginName, manifest) {
        const schema = SchemaGenerator.generate(manifest, { prefix: '' });
        
        if (schema.tools && schema.tools.length > 0) {
            for (const tool of schema.tools) {
                const toolId = tool.name;
                const toolIdLower = toolId.toLowerCase();
                const categories = this.categoryMapper.getCategoriesForTool(toolId);
                
                let finalCategories = categories;
                if (finalCategories.length === 0) {
                    finalCategories = this.categoryMapper.inferCategoriesFromDescription(toolId, tool.description);
                }
                if (finalCategories.length === 0) {
                    finalCategories = ['uncategorized'];
                }

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

                if (!this._nameIndex.has(toolIdLower)) {
                    this._nameIndex.set(toolIdLower, []);
                }
                this._nameIndex.get(toolIdLower).push(toolId);
                
                const pluginKey = pluginName.toLowerCase();
                if (!this._pluginIndex.has(pluginKey)) {
                    this._pluginIndex.set(pluginKey, []);
                }
                this._pluginIndex.get(pluginKey).push(toolId);
            }
        }
    }

    /**
     * 移除插件的所有工具
     */
    _removeToolsForPlugin(pluginName) {
        const pluginKey = pluginName.toLowerCase();
        const toolIds = this._pluginIndex.get(pluginKey) || [];
        
        for (const toolId of toolIds) {
            this._toolsCache.delete(toolId);
            
            const toolIdLower = toolId.toLowerCase();
            const nameIndexEntry = this._nameIndex.get(toolIdLower);
            if (nameIndexEntry) {
                const idx = nameIndexEntry.indexOf(toolId);
                if (idx !== -1) {
                    nameIndexEntry.splice(idx, 1);
                }
                if (nameIndexEntry.length === 0) {
                    this._nameIndex.delete(toolIdLower);
                }
            }
        }
        
        this._pluginIndex.delete(pluginKey);
    }

    /**
     * 重建索引
     */
    rebuildIndex() {
        if (!this._pluginManagerRef) {
            console.warn('[BuiltinVTPBroker] rebuildIndex 调用时 PluginManager 未初始化');
            return;
        }
        this._batchLoading = true;
        this._loadAllTools();
        this._batchLoading = false;
        console.log(`[BuiltinVTPBroker] 索引重建完成，当前共 ${this.getTotalToolCount()} 个工具`);
    }

    /**
     * 加载所有工具
     */
    _loadAllTools() {
        this._toolsCache.clear();
        this._nameIndex.clear();
        this._pluginIndex.clear();

        if (!this._pluginManagerRef || !this._pluginManagerRef.plugins) {
            console.warn('[BuiltinVTPBroker] PluginManager 未就绪，无法加载工具');
            return;
        }

        for (const [pluginName, manifest] of this._pluginManagerRef.plugins) {
            this._addTool(pluginName, manifest);
        }
    }

    // ==================== 热度统计功能 ====================

    _loadUsageStats() {
        try {
            if (fs.existsSync(this._usageFilePath)) {
                const data = JSON.parse(fs.readFileSync(this._usageFilePath, 'utf-8'));
                
                if (data.agentStats) {
                    for (const [agentAlias, tools] of Object.entries(data.agentStats)) {
                        const toolMap = new Map();
                        for (const [toolId, stat] of Object.entries(tools)) {
                            toolMap.set(toolId, stat);
                        }
                        this._toolUsageStats.set(agentAlias, toolMap);
                    }
                }
                
                if (data.globalStats) {
                    for (const [toolId, stat] of Object.entries(data.globalStats)) {
                        this._globalToolStats.set(toolId, stat);
                    }
                }
                
                console.log(`[BuiltinVTPBroker] 已加载热度统计: ${this._toolUsageStats.size} 个 Agent, ${this._globalToolStats.size} 个工具`);
            }
        } catch (error) {
            console.warn(`[BuiltinVTPBroker] 加载热度统计失败: ${error.message}`);
        }
    }

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
            console.warn(`[BuiltinVTPBroker] 保存热度统计失败: ${error.message}`);
        }
    }

    _debouncedSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveUsageStats();
            this._saveTimer = null;
        }, 5000);
    }

    _recordToolUsage(agentAlias, toolId) {
        if (!agentAlias || !toolId) return;
        
        const now = Date.now();
        const dayTimestamp = Math.floor(now / (24 * 60 * 60 * 1000));
        
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
        
        if (!this._globalToolStats.has(toolId)) {
            this._globalToolStats.set(toolId, { count: 0, lastUsed: dayTimestamp });
        }
        this._globalToolStats.get(toolId).count++;
        this._globalToolStats.get(toolId).lastUsed = dayTimestamp;
        
        this._debouncedSave();
    }

    _getAgentTopTools(agentAlias, limit = 5) {
        const currentDay = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
        const sevenDaysAgo = currentDay - 7;
        
        const agentStats = this._toolUsageStats.get(agentAlias) || new Map();
        const agentTop = [];
        for (const [toolId, stat] of agentStats) {
            if (stat.lastUsed >= sevenDaysAgo) {
                const daysSinceUsed = currentDay - stat.lastUsed;
                const weight = stat.count * Math.exp(-daysSinceUsed * 0.1);
                agentTop.push({ toolId, score: weight, count: stat.count });
            }
        }
        agentTop.sort((a, b) => b.score - a.score);
        
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

    get_agent_top_tools(agentAlias = null, limit = 5) {
        let topTools;
        if (agentAlias) {
            topTools = this._getAgentTopTools(agentAlias, limit);
        } else {
            topTools = this._getGlobalTopTools(limit);
        }
        
        if (!topTools || topTools.length === 0) {
            return null;
        }
        
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

    // ==================== 模糊搜索功能 ====================

    _fuzzyMatch(text, query) {
        if (!text || !query) return false;
        const t = text.toLowerCase();
        const q = query.toLowerCase();
        if (t.includes(q)) return true;
        const qParts = q.split(/\s+/);
        return qParts.every(part => t.includes(part));
    }

    _calculateMatchScore(tool, query) {
        const q = query.toLowerCase();
        let score = 0;
        if (tool.name.toLowerCase().includes(q)) score += 10;
        if (tool.description.toLowerCase().includes(q)) score += 2;
        return score;
    }

    /**
     * 模糊搜索工具
     */
    search_tools(query, categoryId = null) {
        if (!query) {
            return { status: 'error', error: '缺少必填参数query' };
        }
        
        let candidates = [...this._toolsCache.values()];
        
        if (categoryId && categoryId !== '*') {
            candidates = candidates.filter(t => t.categories.includes(categoryId));
        }
        
        if (CONFIG.ENABLE_FUZZY_SEARCH) {
            candidates = candidates.filter(t => 
                this._fuzzyMatch(t.name, query) || 
                this._fuzzyMatch(t.description, query)
            );
        } else {
            candidates = candidates.filter(t => 
                this._fuzzyMatch(t.name, query)
            );
        }
        
        candidates.sort((a, b) => this._calculateMatchScore(b, query) - this._calculateMatchScore(a, query));
        const results = candidates.slice(0, CONFIG.MAX_RESULTS_PER_QUERY);
        
        return {
            status: 'success',
            result: {
                query,
                total: results.length,
                tools: results.map(t => ({
                    toolId: t.toolId,
                    name: t.name,
                    description: t.description,
                    pluginName: t.pluginName,
                    categories: t.categories
                }))
            }
        };
    }

    // ==================== 原有功能 ====================

    list_categories() {
        const categories = this.categoryMapper.getAllCategories();
        const result = [];

        for (const cat of categories) {
            let toolCount = 0;
            for (const toolInfo of this._toolsCache.values()) {
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

    list_tools(categoryId = null) {
        if (!categoryId) {
            const result = [];
            for (const toolInfo of this._toolsCache.values()) {
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
        for (const toolInfo of this._toolsCache.values()) {
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

    get_tool_schema(toolId, agentContext = null) {
        if (!toolId) {
            return null;
        }
        
        const resolvedToolId = this.categoryMapper.resolveAlias(toolId);
        const toolIdLower = resolvedToolId.toLowerCase();
        
        if (this._toolsCache.has(resolvedToolId)) {
            const result = this._formatSchema(this._toolsCache.get(resolvedToolId));
            if (agentContext && result) {
                this._recordToolUsage(agentContext, resolvedToolId);
            }
            return result;
        }
        
        const indexedToolIds = this._nameIndex.get(toolIdLower);
        if (indexedToolIds && indexedToolIds.length > 0) {
            const result = this._formatSchema(this._toolsCache.get(indexedToolIds[0]));
            if (agentContext && result) {
                this._recordToolUsage(agentContext, indexedToolIds[0]);
            }
            return result;
        }
        
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

    // ==================== 插件注意点按需注入 ====================

    /**
     * 设置插件注意点
     * @param {string} pluginName - 插件名称
     * @param {string} notice - 注意点内容
     * @param {boolean} enabled - 是否启用注入
     */
    setPluginUsageNotice(pluginName, notice, enabled = true) {
        this._pluginUsageNotices.set(pluginName, { notice, enabled });
    }

    /**
     * 获取插件注意点
     * @param {string} pluginName - 插件名称
     * @returns {string|null} 注意点内容
     */
    getPluginUsageNotice(pluginName) {
        const entry = this._pluginUsageNotices.get(pluginName);
        if (!entry || !entry.enabled) {
            return null;
        }
        return entry.notice;
    }

    /**
     * 检查并记录首次调用，用于判断是否需要注入注意点
     * @param {string} agentAlias - Agent 别名
     * @param {string} toolId - 工具 ID
     * @returns {boolean} 是否首次调用
     */
    checkAndRecordFirstCall(agentAlias, toolId) {
        if (!agentAlias) return false;
        
        if (!this._agentFirstCallCache.has(agentAlias)) {
            this._agentFirstCallCache.set(agentAlias, new Set());
        }
        
        const agentCache = this._agentFirstCallCache.get(agentAlias);
        if (agentCache.has(toolId)) {
            return false;
        }
        
        agentCache.add(toolId);
        return true;
    }

    /**
     * 获取带注入注意点的工具 Schema
     * @param {string} toolId - 工具 ID
     * @param {string} agentContext - Agent 上下文
     * @param {boolean} forceInject - 强制注入（忽略首次调用检查）
     * @returns {Object|null} 带注意点的 Schema
     */
    get_tool_schema_with_notice(toolId, agentContext = null, forceInject = false) {
        const schema = this.get_tool_schema(toolId, agentContext);
        if (!schema) {
            return null;
        }
        
        const notice = this.getPluginUsageNotice(schema.pluginName);
        if (!notice) {
            return schema;
        }
        
        const isFirstCall = forceInject || this.checkAndRecordFirstCall(agentContext, schema.toolId);
        if (!isFirstCall) {
            return schema;
        }
        
        return {
            ...schema,
            usageNotice: notice,
            noticeInjectReason: 'first_call'
        };
    }

    /**
     * 清除 Agent 的首次调用记录
     * @param {string} agentAlias - Agent 别名
     */
    clearAgentFirstCallCache(agentAlias) {
        if (agentAlias) {
            this._agentFirstCallCache.delete(agentAlias);
        }
    }

    /**
     * 清除所有首次调用记录
     */
    clearAllFirstCallCache() {
        this._agentFirstCallCache.clear();
    }

    // ==================== 渐进式工具披露引擎 ====================

    /**
     * 获取初始化工具披露（极简 Schema，用于 Agent 初始化）
     * @param {string} agentAlias - Agent 别名
     * @param {number} limit - 返回数量，默认 5
     * @returns {Array} 极简工具披露列表
     */
    getInitialToolsDisclosure(agentAlias = null, limit = 5) {
        const topTools = this.get_agent_top_tools(agentAlias, limit);
        if (!topTools) {
            return [];
        }
        
        return topTools.map(tool => ({
            toolId: tool.toolId,
            name: tool.name,
            briefDescription: this._extractBriefDescription(tool.description),
            callExample: tool.callExample
        }));
    }

    /**
     * 按需获取工具披露（完整 Schema，用于陌生任务）
     * @param {string} query - 查询关键词
     * @param {number} limit - 返回数量，默认 3
     * @returns {Array} 完整工具披露列表
     */
    getOnDemandToolsDisclosure(query, limit = 3) {
        const searchResult = this.search_tools(query, null);
        if (searchResult.status !== 'success') {
            return [];
        }
        
        const tools = searchResult.result.tools.slice(0, limit);
        return tools.map(tool => ({
            toolId: tool.toolId,
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            callExample: tool.callExample,
            categories: tool.categories
        }));
    }

    /**
     * 获取工具参数纠错信息
     * @param {string} toolId - 工具 ID
     * @param {string} errorHint - 错误提示
     * @returns {Object|null} 参数纠错信息
     */
    getToolParamCorrection(toolId, errorHint = null) {
        const schema = this.get_tool_schema(toolId);
        if (!schema) {
            return null;
        }
        
        const correction = {
            toolId: schema.toolId,
            name: schema.name,
            paramHints: []
        };
        
        if (schema.inputSchema && schema.inputSchema.properties) {
            for (const [param, paramSchema] of Object.entries(schema.inputSchema.properties)) {
                correction.paramHints.push({
                    name: param,
                    type: paramSchema.type || 'string',
                    description: paramSchema.description || '',
                    required: schema.inputSchema.required?.includes(param) || false,
                    default: paramSchema.default
                });
            }
        }
        
        if (errorHint) {
            correction.errorHint = errorHint;
        }
        
        return correction;
    }

    _extractBriefDescription(description, maxLength = 50) {
        if (!description) return '';
        if (description.length <= maxLength) return description;
        return description.substring(0, maxLength) + '...';
    }

    getTotalToolCount() {
        return this._toolsCache.size;
    }
}

// 单例模式
let instance = null;

BuiltinVTPBroker.getInstance = function() {
    if (!instance) {
        instance = new BuiltinVTPBroker();
    }
    return instance;
};

module.exports = BuiltinVTPBroker;
