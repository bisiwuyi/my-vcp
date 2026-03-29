/**
 * VTPBroker Plugin
 * 
 * VCP 工具发现中间商插件
 * 提供工具发现能力，按需返回工具分类、摘要和调用格式
 */

const VTPBroker = require('../../modules/vtbroker');

let broker = null;

function getBroker() {
    if (!broker) {
        broker = VTPBroker.getInstance();
    }
    return broker;
}

async function handleCommand(command, args, context) {
    const cmd = command.toLowerCase();
    
    switch (cmd) {
        case 'list_categories':
            return handleListCategories(args, context);
        case 'list_tools':
            return handleListTools(args, context);
        case 'get_tool_schema':
            return handleGetToolSchema(args, context);
        case 'get_agent_top_tools':
            return handleGetAgentTopTools(args, context);
        default:
            return {
                success: false,
                error: `Unknown command: ${command}`
            };
    }
}

function handleListCategories(args, context) {
    const broker = getBroker();
    const categories = broker.list_categories();
    
    // 格式化输出
    const lines = ['【工具分类列表】\n'];
    for (const cat of categories) {
        lines.push(`${cat.id}: ${cat.name} (${cat.toolCount}个工具)`);
    }
    
    return {
        success: true,
        content: lines.join('\n'),
        data: categories
    };
}

function handleListTools(args, context) {
    const broker = getBroker();
    const categoryId = args.category_id;
    
    if (!categoryId) {
        return {
            success: false,
            error: '缺少参数: category_id'
        };
    }
    
    const tools = broker.list_tools(categoryId);
    
    if (tools.length === 0) {
        return {
            success: true,
            content: `分类 '${categoryId}' 下没有工具`,
            data: []
        };
    }
    
    // 格式化输出
    const lines = [`【${categoryId} 类工具】\n`];
    for (const tool of tools) {
        const desc = tool.description ? tool.description.substring(0, 60) : '无描述';
        lines.push(`- ${tool.name}: ${desc}...`);
    }
    
    return {
        success: true,
        content: lines.join('\n'),
        data: tools
    };
}

function handleGetToolSchema(args, context) {
    const broker = getBroker();
    const toolId = args.tool_id;
    
    if (!toolId) {
        return {
            success: false,
            error: '缺少参数: tool_id'
        };
    }
    
    const schema = broker.get_tool_schema(toolId);
    
    if (!schema) {
        return {
            success: false,
            error: `未找到工具: ${toolId}`
        };
    }
    
    // 格式化输出
    const lines = [
        `【工具调用格式】\n`,
        `工具名: ${schema.name}`,
        `描述: ${schema.description || '无'}`,
        `所属插件: ${schema.pluginName}`,
        `分类: ${schema.categories.join(', ')}`,
        `\n【调用示例】`,
        schema.callExample
    ];
    
    return {
        success: true,
        content: lines.join('\n'),
        data: schema
    };
}

function handleGetAgentTopTools(args, context) {
    const broker = getBroker();
    const agentAlias = args.agent_alias || null;
    const limit = parseInt(args.limit) || 5;
    
    const result = broker.get_agent_top_tools(agentAlias, limit);
    
    if (!result) {
        return {
            success: true,
            content: '暂无常用工具数据',
            data: null
        };
    }
    
    const lines = ['【常用工具列表】（按使用频率排序）\n'];
    for (const tool of result) {
        lines.push(`- ${tool.name}: ${tool.description}`);
        lines.push(`  调用示例: ${tool.callExample}\n`);
    }
    
    return {
        success: true,
        content: lines.join('\n'),
        data: result
    };
}

module.exports = {
    handleCommand
};
