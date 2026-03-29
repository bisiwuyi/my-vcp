/**
 * Tool Summary Index - 工具摘要索引
 * 
 * 提供工具的快速发现能力：
 * - 按类别查询工具摘要
 * - 获取完整工具 schema
 */

const CategoryMapper = require('./category-mapper');
const SchemaGenerator = require('./schema-generator');

class ToolSummaryIndex {
    constructor(bridge) {
        this.bridge = bridge;
        this.categoryMapper = CategoryMapper.getInstance();
        this.summaryCache = new Map(); // toolId -> { toolId, name, summary, categoryIds }
        this.categoryToolIndex = new Map(); // categoryId -> Set<toolId>
        
        this._initCategoryIndex();
    }
    
    /**
     * 初始化类别索引
     */
    _initCategoryIndex() {
        for (const cat of this.categoryMapper.getAllCategories()) {
            this.categoryToolIndex.set(cat.id, new Set());
        }
    }
    
    /**
     * 从 Bridge 重建索引
     */
    rebuildFromBridge() {
        this.summaryCache.clear();
        this._initCategoryIndex();
        
        if (!this.bridge || !this.bridge.tools) {
            return;
        }
        
        for (const [toolId, tool] of this.bridge.tools) {
            this._indexTool(toolId, tool);
        }
    }
    
    /**
     * 索引单个工具
     */
    _indexTool(toolId, tool) {
        // 提取 summary
        const summary = SchemaGenerator.extractSummary(tool.description || '');
        
        // 获取类别
        const categoryIds = this.categoryMapper.getCategoriesForTool(toolId);
        
        // 如果没有找到类别，尝试从 description 推断
        if (categoryIds.length === 0) {
            const inferred = this.categoryMapper.inferCategoriesFromDescription(toolId, tool.description);
            categoryIds.push(...inferred);
        }
        
        // 如果仍然没有类别，归入 uncategorized
        if (categoryIds.length === 0) {
            categoryIds.push('uncategorized');
            if (!this.categoryToolIndex.has('uncategorized')) {
                this.categoryToolIndex.set('uncategorized', new Set());
            }
        }
        
        // 存储摘要
        this.summaryCache.set(toolId, {
            toolId,
            name: tool.name || toolId,
            summary: summary,
            pluginName: tool.pluginName || 'unknown',
            categoryIds
        });
        
        // 更新类别索引
        for (const catId of categoryIds) {
            if (this.categoryToolIndex.has(catId)) {
                this.categoryToolIndex.get(catId).add(toolId);
            }
        }
    }
    
    /**
     * 获取所有类别及其工具数量
     */
    getCategories() {
        const result = [];
        for (const [catId, toolSet] of this.categoryToolIndex) {
            const catInfo = this.categoryMapper.getCategory(catId);
            result.push({
                id: catId,
                name: catInfo ? catInfo.name : catId,
                toolCount: toolSet.size
            });
        }
        return result;
    }
    
    /**
     * 获取类别的工具摘要列表
     */
    getToolsByCategory(categoryId) {
        const toolIds = this.categoryToolIndex.get(categoryId);
        if (!toolIds) {
            return [];
        }
        
        const tools = [];
        for (const toolId of toolIds) {
            const summary = this.summaryCache.get(toolId);
            if (summary) {
                tools.push({
                    toolId: summary.toolId,
                    name: summary.name,
                    summary: summary.summary,
                    pluginName: summary.pluginName
                });
            }
        }
        return tools;
    }
    
    /**
     * 获取单个工具的完整 schema
     */
    getToolSchema(toolId) {
        // 先从 Bridge 获取
        if (this.bridge && typeof this.bridge.getToolSchema === 'function') {
            const schema = this.bridge.getToolSchema(toolId);
            if (schema) {
                return schema;
            }
        }
        
        // 降级：从 tools map 获取
        if (this.bridge && this.bridge.tools) {
            const tool = this.bridge.tools.get(toolId);
            if (tool) {
                return {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema || { type: 'object', properties: {} }
                };
            }
        }
        
        return null;
    }
    
    /**
     * 获取工具摘要
     */
    getToolSummary(toolId) {
        return this.summaryCache.get(toolId) || null;
    }
    
    /**
     * 获取所有工具摘要
     */
    getAllToolSummaries() {
        return Array.from(this.summaryCache.values());
    }
    
    /**
     * 获取工具总数
     */
    getTotalToolCount() {
        return this.summaryCache.size;
    }
}

module.exports = ToolSummaryIndex;
