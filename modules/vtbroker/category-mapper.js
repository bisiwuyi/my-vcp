/**
 * Category Mapper - 工具类别映射
 * 
 * 将 VCP 工具按功能属性映射到不同类别
 * 
 * 配置加载顺序：
 * 1. 硬编码的默认分类和映射（保证基础功能）
 * 2. config/category-mappings.json 文件（支持运行时修改）
 * 3. 文件中配置优先级高于硬编码
 */

const fs = require('fs');
const path = require('path');

class CategoryMapper {
    constructor() {
        this.categories = new Map();
        this.toolCategories = new Map(); // toolId -> [categoryId]
        this._aliasIndex = new Map();    // 别名 -> 原始插件名
        
        this._configPath = path.join(__dirname, 'config', 'category-mappings.json');
        
        // 初始化
        this._initCategories();       // 硬编码默认分类
        this._initMappingRules();     // 硬编码默认映射
        this._initUncategorized();
        
        // 从配置文件加载（覆盖硬编码）
        this._loadFromConfig();
    }
    
    /**
     * 初始化类别定义
     */
    _initCategories() {
        this.categories.set('search', {
            id: 'search',
            name: '搜索工具',
            desc: '用于在互联网或数据库中搜索信息',
            keywords: ['搜索引擎', '搜索工具', '互联网搜索', '网络搜索', '论文搜索', '学术搜索']
        });
        
        this.categories.set('image_gen', {
            id: 'image_gen',
            name: '图像生成',
            desc: '生成图片或编辑图像',
            keywords: ['图像生成', '图片生成', '文生图', '图生图', 'AI绘画', 'AI画图', 'comfyui', 'stable diffusion']
        });
        
        this.categories.set('video_gen', {
            id: 'video_gen',
            name: '视频生成',
            desc: '生成视频内容',
            keywords: ['视频生成', '视频合成', 'movie', 'clip']
        });
        
        this.categories.set('file_ops', {
            id: 'file_ops',
            name: '文件操作',
            desc: '读取、写入、搜索本地文件',
            keywords: ['文件操作', '文件管理', '本地文件', '文件搜索', '文件传输']
        });
        
        this.categories.set('code', {
            id: 'code',
            name: '代码工具',
            desc: '代码搜索、项目分析',
            keywords: ['代码分析', '代码搜索', '项目分析', '代码审查', 'rust', 'python代码']
        });
        
        this.categories.set('collaboration', {
            id: 'collaboration',
            name: '通讯协作',
            desc: '多Agent协作、消息推送',
            keywords: ['Agent通讯', '多Agent', '协作', '消息推送', '通知']
        });
        
        this.categories.set('knowledge', {
            id: 'knowledge',
            name: '知识检索',
            desc: 'RAG、日记、知识库查询',
            keywords: ['知识库', 'RAG', '日记', '记忆', '向量检索', '语义搜索']
        });
        
        this.categories.set('life', {
            id: 'life',
            name: '生活服务',
            desc: '天气、日程、提醒',
            keywords: ['天气预报', '日程管理', '闹钟提醒', '日程提醒']
        });
        
        this.categories.set('entertainment', {
            id: 'entertainment',
            name: '娱乐',
            desc: '音乐、游戏、占卜',
            keywords: ['音乐生成', '塔罗占卜', '游戏', '娱乐']
        });
    }
    
    /**
     * 初始化插件到类别的精确映射
     */
    _initMappingRules() {
        // 搜索类插件
        this.addPluginMapping('GoogleSearch', 'search');
        this.addPluginMapping('SerpSearch', 'search');
        this.addPluginMapping('TavilySearch', 'search');
        this.addPluginMapping('ArxivDailyPapers', 'search');
        this.addPluginMapping('CrossRefDailyPapers', 'search');
        this.addPluginMapping('PubMedSearch', 'search');
        this.addPluginMapping('DeepWikiVCP', 'search');
        this.addPluginMapping('VSearch', 'search');
        this.addPluginMapping('ServerSearchController', 'search');
        this.addPluginMapping('KarakeepSearch', 'search');
        
        // 图像生成类插件
        this.addPluginMapping('ComfyUIGen', 'image_gen');
        this.addPluginMapping('NovelAIGen', 'image_gen');
        this.addPluginMapping('DoubaoGen', 'image_gen');
        this.addPluginMapping('DMXDoubaoGen', 'image_gen');
        this.addPluginMapping('FluxGen', 'image_gen');
        this.addPluginMapping('GeminiImageGen', 'image_gen');
        this.addPluginMapping('QwenImageGen', 'image_gen');
        this.addPluginMapping('WebUIGen', 'image_gen');
        this.addPluginMapping('ZImageGen', 'image_gen');
        this.addPluginMapping('ZImageGen2', 'image_gen');
        this.addPluginMapping('ZImageTurboGen', 'image_gen');
        this.addPluginMapping('ArtistMatcher', 'image_gen');
        
        // 视频生成类插件
        this.addPluginMapping('Wan2.1VideoGen', 'video_gen');
        this.addPluginMapping('GrokVideoGen', 'video_gen');
        
        // 搜索类插件（补充）
        this.addPluginMapping('FlashDeepSearch', 'search');
        this.addPluginMapping('KEGGSearch', 'search');
        this.addPluginMapping('BilibiliFetch', 'search');
        this.addPluginMapping('ChromeBridge', 'search');
        
        // 文件操作类插件
        this.addPluginMapping('FileServer', 'file_ops');
        this.addPluginMapping('ServerFileOperator', 'file_ops');
        this.addPluginMapping('FileTreeGenerator', 'file_ops');
        this.addPluginMapping('FileListGenerator', 'file_ops');
        this.addPluginMapping('UrlFetch', 'file_ops');
        
        // 代码工具类插件
        this.addPluginMapping('ServerCodeSearcher', 'code');
        this.addPluginMapping('CodeSearcher', 'code');
        this.addPluginMapping('ProjectAnalyst', 'code');
        this.addPluginMapping('PaperReader', 'code');
        
        // 通讯协作类插件
        this.addPluginMapping('AgentAssistant', 'collaboration');
        this.addPluginMapping('AgentMessage', 'collaboration');
        this.addPluginMapping('MagiAgent', 'collaboration');
        this.addPluginMapping('VCPTavern', 'collaboration');
        this.addPluginMapping('VCPLog', 'collaboration');
        this.addPluginMapping('VCPToolBridge', 'collaboration');
        this.addPluginMapping('ThoughtClusterManager', 'knowledge');
        this.addPluginMapping('PowerShellExecutor', 'collaboration');
        
        // 知识检索类插件
        this.addPluginMapping('RAGDiaryPlugin', 'knowledge');
        this.addPluginMapping('LightMemo', 'knowledge');
        this.addPluginMapping('VCPForum', 'knowledge');
        this.addPluginMapping('VCPForumOnline', 'knowledge');
        
        // 生活服务类插件
        this.addPluginMapping('WeatherReporter', 'life');
        this.addPluginMapping('WeatherInfoNow', 'life');
        this.addPluginMapping('ScheduleManager', 'life');
        this.addPluginMapping('ScheduleBriefing', 'life');
        
        // 娱乐类插件
        this.addPluginMapping('Randomness', 'entertainment');
        this.addPluginMapping('TarotDivination', 'entertainment');
        this.addPluginMapping('SunoGen', 'entertainment');
        this.addPluginMapping('AnimeFinder', 'entertainment');
        this.addPluginMapping('SVCardFinder', 'entertainment');
        this.addPluginMapping('JapaneseHelper', 'entertainment');
    }
    
    /**
     * 初始化未分类类别
     */
    _initUncategorized() {
        this.categories.set('uncategorized', {
            id: 'uncategorized',
            name: '未分类',
            desc: '尚未归类的工具',
            keywords: []
        });
    }
    
    /**
     * 从配置文件加载分类映射
     * 配置文件路径: config/category-mappings.json
     */
    _loadFromConfig() {
        try {
            if (!fs.existsSync(this._configPath)) {
                console.log(`[CategoryMapper] 配置文件不存在，跳过加载: ${this._configPath}`);
                return;
            }
            
            const configContent = fs.readFileSync(this._configPath, 'utf-8');
            const config = JSON.parse(configContent);
            
            // 加载额外分类
            if (config.categories && Array.isArray(config.categories)) {
                for (const cat of config.categories) {
                    if (!this.categories.has(cat.id)) {
                        this.categories.set(cat.id, {
                            id: cat.id,
                            name: cat.name,
                            desc: cat.desc || '',
                            keywords: cat.keywords || []
                        });
                    }
                }
            }
            
            // 加载插件映射
            if (config.mappings && typeof config.mappings === 'object') {
                for (const [pluginName, categoryIds] of Object.entries(config.mappings)) {
                    const catIdArray = Array.isArray(categoryIds) ? categoryIds : [categoryIds];
                    for (const catId of catIdArray) {
                        if (this.categories.has(catId)) {
                            this.addPluginMapping(pluginName, catId);
                        }
                    }
                }
            }
            
            // 加载别名索引
            if (config.aliases && typeof config.aliases === 'object') {
                for (const [alias, originalName] of Object.entries(config.aliases)) {
                    this._aliasIndex.set(alias.toLowerCase(), originalName);
                }
            }
            
            console.log(`[CategoryMapper] 已从配置文件加载映射: ${Object.keys(config.mappings || {}).length} 个插件映射`);
            
        } catch (error) {
            console.warn(`[CategoryMapper] 加载分类配置文件失败，使用硬编码默认值: ${error.message}`);
        }
    }
    
    /**
     * 运行时添加插件映射（不持久化，重启后失效）
     * @param {string} pluginName - 插件名
     * @param {string|array} categoryIds - 分类ID或ID数组
     */
    addMapping(pluginName, categoryIds) {
        const catIdArray = Array.isArray(categoryIds) ? categoryIds : [categoryIds];
        for (const catId of catIdArray) {
            this.addPluginMapping(pluginName, catId);
        }
    }
    
    /**
     * 运行时添加新分类（不持久化，重启后失效）
     * @param {string} categoryId - 分类ID
     * @param {string} name - 分类显示名
     * @param {string} desc - 分类描述
     * @param {array} keywords - 关键词数组
     */
    addCategory(categoryId, name, desc, keywords = []) {
        if (!this.categories.has(categoryId)) {
            this.categories.set(categoryId, {
                id: categoryId,
                name: name,
                desc: desc || '',
                keywords: keywords || []
            });
        }
    }
    
    /**
     * 解析别名
     * @param {string} toolId - 工具ID
     * @returns {string} 原始插件名（如果存在别名）
     */
    resolveAlias(toolId) {
        const toolIdLower = toolId.toLowerCase();
        return this._aliasIndex.get(toolIdLower) || toolId;
    }
    
    /**
     * 校验工具名并记录废弃警告
     * @param {string} toolId - 工具ID
     * @returns {string} 修正后的工具名（如果是废弃名则返回正确名称）
     */
    validateToolName(toolId) {
        const DEPRECATED_TOOLS = {
            'FileOperator': 'ServerFileOperator',
            'fileoperator': 'ServerFileOperator'
        };
        
        if (DEPRECATED_TOOLS[toolId]) {
            console.warn(`[CategoryMapper] ⚠️ 废弃工具名检测: "${toolId}" -> "${DEPRECATED_TOOLS[toolId]}"，请更新调用代码`);
            return DEPRECATED_TOOLS[toolId];
        }
        
        return toolId;
    }
    
    /**
     * 重新加载配置文件
     */
    reloadConfig() {
        // 清除运行时添加的数据
        this.toolCategories.clear();
        this._aliasIndex.clear();
        
        // 重新初始化硬编码
        this._initCategories();
        this._initMappingRules();
        this._initUncategorized();
        
        // 重新加载配置
        this._loadFromConfig();
        
        console.log('[CategoryMapper] 配置文件已重新加载');
    }
    
    /**
     * 添加插件到类别的映射
     */
    addPluginMapping(pluginName, categoryId) {
        if (!this.categories.has(categoryId)) {
            return;
        }
        
        // 存储工具 ID 到类别的映射（工具 ID 通常是 pluginName_lowerCase 或 pluginName_toolName）
        const toolId = pluginName.toLowerCase().replace(/[^a-z0-9]/g, '_');
        
        if (!this.toolCategories.has(toolId)) {
            this.toolCategories.set(toolId, []);
        }
        
        const categories = this.toolCategories.get(toolId);
        if (!categories.includes(categoryId)) {
            categories.push(categoryId);
        }
    }
    
    /**
     * 为工具添加映射
     */
    addToolMapping(toolId, categoryIds) {
        if (!this.toolCategories.has(toolId)) {
            this.toolCategories.set(toolId, []);
        }
        
        const categories = this.toolCategories.get(toolId);
        for (const catId of categoryIds) {
            if (this.categories.has(catId) && !categories.includes(catId)) {
                categories.push(catId);
            }
        }
    }
    
    /**
     * 根据 description 模糊匹配推断类别
     */
    inferCategoriesFromDescription(toolId, description) {
        if (!description) return [];
        
        const descLower = description.toLowerCase();
        const inferred = [];
        
        for (const [catId, cat] of this.categories) {
            if (!cat.keywords || !Array.isArray(cat.keywords)) continue;
            for (const keyword of cat.keywords) {
                if (descLower.includes(keyword.toLowerCase())) {
                    if (!inferred.includes(catId)) {
                        inferred.push(catId);
                    }
                    break;
                }
            }
        }
        
        return inferred;
    }
    
    /**
     * 获取工具所属的所有类别
     * 支持别名解析
     */
    getCategoriesForTool(toolId) {
        // 1. 先解析别名
        const resolvedId = this.resolveAlias(toolId);
        const toolIdLower = resolvedId.toLowerCase();
        
        // 2. 精确匹配 toolId
        if (this.toolCategories.has(toolIdLower)) {
            return this.toolCategories.get(toolIdLower);
        }
        
        // 3. 尝试模糊匹配（toolId 可能包含插件名前缀）
        // 例如: googlesearch_googlesearch -> googlesearch
        for (const [mappedToolId, categories] of this.toolCategories) {
            if (toolIdLower.startsWith(mappedToolId + '_') || 
                toolIdLower.includes('_' + mappedToolId + '_')) {
                return categories;
            }
        }
        
        return [];
    }
    
    /**
     * 获取所有类别列表
     */
    getAllCategories() {
        const result = [];
        for (const [id, cat] of this.categories) {
            result.push({
                id: cat.id,
                name: cat.name,
                desc: cat.desc
            });
        }
        return result;
    }
    
    /**
     * 获取类别信息
     */
    getCategory(categoryId) {
        return this.categories.get(categoryId) || null;
    }
}

// 单例模式
let instance = null;

CategoryMapper.getInstance = function() {
    if (!instance) {
        instance = new CategoryMapper();
    }
    return instance;
};

module.exports = CategoryMapper;
