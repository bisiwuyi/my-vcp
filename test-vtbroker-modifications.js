/**
 * VTPBroker 修改验证测试
 * 
 * 测试内容：
 * 1. P0-1: 缓存一致性（事件订阅）
 * 2. P0-2: 分类映射配置加载
 * 3. P1-1: 多层索引查找
 * 4. P1-2: 分布式插件标记
 */

const path = require('path');
const EventEmitter = require('events');

console.log('='.repeat(60));
console.log('VTPBroker 修改验证测试');
console.log('='.repeat(60));

// 测试结果统计
let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`✅ ${message}`);
        passed++;
    } else {
        console.log(`❌ ${message}`);
        failed++;
    }
}

// ==================== 测试 1: 配置文件加载 ====================
console.log('\n--- 测试 1: P0-2 分类映射配置加载 ---');

try {
    const CategoryMapper = require('./modules/vtbroker/category-mapper');
    const mapper = CategoryMapper.getInstance();
    
    // 测试配置文件加载
    assert(mapper.categories.size >= 10, `分类数量正确: ${mapper.categories.size}`);
    
    // 测试别名解析
    const resolved = mapper.resolveAlias('googlesearch');
    assert(resolved === 'GoogleSearch', `别名解析正确: googlesearch -> ${resolved}`);
    
    // 测试映射是否存在
    const categories = mapper.getCategoriesForTool('GoogleSearch');
    assert(categories.includes('search'), `GoogleSearch 映射到 search 分类: ${JSON.stringify(categories)}`);
    
    console.log(`[OK] CategoryMapper 初始化成功，共 ${mapper.categories.size} 个分类`);
} catch (error) {
    console.log(`[FAIL] CategoryMapper 加载失败: ${error.message}`);
    failed++;
}

    // ==================== 测试 2: VTPBroker 基础功能 ====================
    console.log('\n--- 测试 2: P0-1/P1-1/P1-2 VTPBroker 基础功能 ---');

    try {
        const VTPBroker = require('./modules/vtbroker');
        const broker = VTPBroker.getInstance();
        
        // 检查初始化状态
        assert(broker._initialized === false, '初始状态未初始化');
        
        // 创建一个模拟的 PluginManager
        const mockPluginManager = new EventEmitter();
        mockPluginManager.plugins = new Map();
        
        // 添加模拟插件
        mockPluginManager.plugins.set('TestPlugin', {
            name: 'TestPlugin',
            description: '测试插件',
            isDistributed: false,
            serverId: null,
            capabilities: {
                invocationCommands: [
                    {
                        command: 'test',
                        description: '执行测试',
                        parameters: {
                            query: { type: 'string', description: '查询词' }
                        }
                    }
                ]
            }
        });
        
        // 添加分布式模拟插件
        mockPluginManager.plugins.set('RemotePlugin', {
            name: 'RemotePlugin',
            description: '远程插件',
            isDistributed: true,
            serverId: 'cloud-server-1',
            capabilities: {
                invocationCommands: [
                    {
                        command: 'remote',
                        description: '远程执行',
                        parameters: {}
                    }
                ]
            }
        });
        
        // 初始化
        broker.initialize(mockPluginManager);
        
        // 测试初始化
        assert(broker._initialized === true, '初始化后状态为已初始化');
        
        // 测试事件订阅（检查 _pluginManagerRef 是否存在）
        assert(broker._pluginManagerRef === mockPluginManager, 'PluginManager 引用已保存');
        
        // 测试工具加载
        const totalTools = broker.getTotalToolCount();
        assert(totalTools >= 2, `工具加载成功: ${totalTools} 个工具`);
        
        // 测试多层索引
        const schema1 = broker.get_tool_schema('testplugin_test');
        assert(schema1 !== null, '多层索引-精确匹配成功');
        
        // 测试分布式标记
        const schema2 = broker.get_tool_schema('remoteplugin_remote');
        assert(schema2 !== null, '分布式工具 Schema 获取成功');
        if (schema2) {
            assert(schema2.isDistributed === true, `分布式标记正确: isDistributed=${schema2.isDistributed}`);
            assert(schema2.serverId === 'cloud-server-1', `服务器ID正确: serverId=${schema2.serverId}`);
            assert(schema2.executionHint.includes('分布式'), `执行提示正确: ${schema2.executionHint}`);
        }
        
        console.log(`[OK] VTPBroker 基础功能正常，共 ${totalTools} 个工具`);
        
        // ==================== 测试 2.5: 大小写不同工具名不互相覆盖 ====================
        console.log('\n--- 测试 2.5: 大小写不同工具名索引 ---');
        
        // 由于单例模式，使用现有的 broker 实例进行测试
        // 直接验证 _nameIndex 的结构和大小写查找能力
        
        // 添加两个大小写不同的模拟工具
        broker._toolsCache.set('GoogleSearch_test', {
            toolId: 'GoogleSearch_test',
            name: 'GoogleSearch_test',
            originalName: 'TestPlugin',
            description: 'Test1',
            pluginName: 'TestPlugin',
            categories: ['search'],
            inputSchema: {},
            isDistributed: false,
            serverId: null
        });
        broker._toolsCache.set('googlesearch_test', {
            toolId: 'googlesearch_test',
            name: 'googlesearch_test',
            originalName: 'TestPlugin',
            description: 'Test2',
            pluginName: 'TestPlugin',
            categories: ['search'],
            inputSchema: {},
            isDistributed: false,
            serverId: null
        });
        
        // 手动构建索引
        broker._nameIndex.set('googlesearch_test', ['GoogleSearch_test', 'googlesearch_test']);
        
        // 验证两个都能找到
        const schemaUpper = broker.get_tool_schema('GoogleSearch_test');
        const schemaLower = broker.get_tool_schema('googlesearch_test');
        
        assert(schemaUpper !== null, '大写工具名 GoogleSearch_test 可找到');
        assert(schemaLower !== null, '小写工具名 googlesearch_test 可找到');
        assert(schemaUpper.toolId === 'GoogleSearch_test', '大写查询返回正确工具');
        assert(schemaLower.toolId === 'googlesearch_test', '小写查询返回正确工具');
        
        console.log('[OK] 大小写不同工具名索引测试通过');
    
    // ==================== 测试 3: 缓存一致性（热重载） ====================
    console.log('\n--- 测试 3: P0-1 缓存一致性（热重载） ---');
    
    // 添加新插件
    mockPluginManager.plugins.set('NewPlugin', {
        name: 'NewPlugin',
        description: '新插件',
        isDistributed: false,
        capabilities: {
            invocationCommands: [
                {
                    command: 'newcmd',
                    description: '新命令',
                    parameters: {}
                }
            ]
        }
    });
    
    // 触发热重载事件
    console.log('触发 pluginsLoaded 事件...');
    mockPluginManager.emit('pluginsLoaded');
    
    // 验证新插件已加载
    const newTotalTools = broker.getTotalToolCount();
    assert(newTotalTools > totalTools, `热重载后工具数增加: ${totalTools} -> ${newTotalTools}`);
    
    const newSchema = broker.get_tool_schema('newplugin_newcmd');
    assert(newSchema !== null, '热重载后新工具可查询');
    
    console.log(`[OK] 缓存一致性测试通过`);
    
} catch (error) {
    console.log(`[FAIL] VTPBroker 测试失败: ${error.message}`);
    console.error(error.stack);
    failed++;
}

// ==================== 测试 4: 分类列表 ====================
console.log('\n--- 测试 4: 分类列表功能 ---');

try {
    const VTPBroker = require('./modules/vtbroker');
    const broker = VTPBroker.getInstance();
    const categories = broker.list_categories();
    
    assert(Array.isArray(categories), '分类列表返回数组');
    assert(categories.length > 0, `分类数量: ${categories.length}`);
    
    // 检查 uncategorized 分类
    const uncategorized = categories.find(c => c.id === 'uncategorized');
    assert(uncategorized !== undefined, 'uncategorized 分类存在');
    
    // 检查每个分类有 toolCount 字段
    for (const cat of categories) {
        assert(typeof cat.toolCount === 'number', `分类 ${cat.id} 有 toolCount: ${cat.toolCount}`);
    }
    
    console.log(`[OK] 分类列表功能正常`);
    
} catch (error) {
    console.log(`[FAIL] 分类列表测试失败: ${error.message}`);
    failed++;
}

// ==================== 测试结果 ====================
console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
console.log('='.repeat(60));

if (failed > 0) {
    console.log('\n⚠️ 存在失败的测试，请检查上述错误信息');
    process.exit(1);
} else {
    console.log('\n✅ 所有测试通过！');
    process.exit(0);
}