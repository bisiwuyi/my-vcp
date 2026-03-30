const fs = require('fs');
const path = require('path');

// 原生读取env配置，移除dotenv依赖
function loadEnv() {
  const envPath = path.join(__dirname, 'config.env');
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf8');
  const env = {};
  content.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const [key, value] = line.split('=').map(s => s.trim());
    if (key && value !== undefined) env[key] = value;
  });
  return env;
}
const env = loadEnv();

// 配置参数
const CONFIG = {
  INDEX_REFRESH_INTERVAL: parseInt(env.INDEX_REFRESH_INTERVAL || 300) * 1000,
  ENABLE_FUZZY_SEARCH: env.ENABLE_FUZZY_SEARCH !== 'false',
  MAX_RESULTS_PER_QUERY: parseInt(env.MAX_RESULTS_PER_QUERY || 100),
  PLUGIN_ROOT: path.join(__dirname, '..')
};

// 全局索引缓存
let toolIndex = { byId: {}, byCategory: {}, byName: {}, byTag: {} };
let lastIndexRefresh = 0;
let nameCollisionCount = 0;

/**
 * 刷新工具索引
 */
async function refreshIndex() {
  const now = Date.now();
  if (now - lastIndexRefresh < CONFIG.INDEX_REFRESH_INTERVAL && Object.keys(toolIndex.byId).length > 0) {
    return;
  }
  // 重置索引
  toolIndex = { byId: {}, byCategory: {}, byName: {}, byTag: {} };
  // 遍历所有插件目录
  const pluginDirs = fs.readdirSync(CONFIG.PLUGIN_ROOT, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);
  for (const pluginName of pluginDirs) {
    const manifestPath = path.join(CONFIG.PLUGIN_ROOT, pluginName, 'plugin-manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const category = getPluginCategory(manifest);
      const tags = getPluginTags(manifest);
      // 遍历所有命令
      if (manifest.capabilities?.invocationCommands) {
        for (const cmd of manifest.capabilities.invocationCommands) {
          const cmdIdentifier = cmd.commandIdentifier || cmd.command;
          if (!cmdIdentifier) continue;
          const toolId = `${pluginName.toLowerCase()}_${cmdIdentifier.toLowerCase()}`;
          const toolInfo = {
            id: toolId,
            name: cmdIdentifier,
            pluginName: manifest.name,
            displayName: manifest.displayName,
            category: category,
            description: cmd.description,
            example: cmd.example,
            tags: tags,
            version: manifest.version
          };
          // 构建四层索引
          toolIndex.byId[toolId] = toolInfo;
          if (!toolIndex.byCategory[category]) toolIndex.byCategory[category] = [];
          toolIndex.byCategory[category].push(toolInfo);
          const nameKey = cmdIdentifier.toLowerCase();
          if (toolIndex.byName[nameKey]) {
            toolIndex.byName[nameKey].push(toolInfo);
            nameCollisionCount++;
          } else {
            toolIndex.byName[nameKey] = [toolInfo];
          }
          for (const tag of tags) {
            const tagKey = tag.toLowerCase();
            if (!toolIndex.byTag[tagKey]) toolIndex.byTag[tagKey] = [];
            toolIndex.byTag[tagKey].push(toolInfo);
          }
        }
      }
    } catch (e) {
      console.error(`加载插件${pluginName}失败:`, e.message);
    }
  }
  lastIndexRefresh = now;
}

/**
 * 自动分类插件
 */
function getPluginCategory(manifest) {
  const name = manifest.name.toLowerCase();
  const desc = manifest.description.toLowerCase();
  if (name.includes('file') || name.includes('fs') || desc.includes('文件')) return 'file_ops';
  if (name.includes('code') || name.includes('dev') || desc.includes('代码') || desc.includes('开发')) return 'code';
  if (name.includes('search') || desc.includes('搜索')) return 'search';
  if (name.includes('rag') || name.includes('knowledge') || desc.includes('知识')) return 'knowledge';
  if (name.includes('chat') || name.includes('message') || desc.includes('通讯')) return 'collaboration';
  return 'uncategorized';
}

/**
 * 提取插件标签
 */
function getPluginTags(manifest) {
  const tags = [];
  if (manifest.capabilities?.invocationCommands) {
    for (const cmd of manifest.capabilities.invocationCommands) {
      const desc = cmd.description.toLowerCase();
      if (desc.includes('read')) tags.push('read');
      if (desc.includes('write')) tags.push('write');
      if (desc.includes('search')) tags.push('search');
      if (desc.includes('download')) tags.push('download');
    }
  }
  return [...new Set(tags)];
}

/**
 * 处理list_tools命令
 */
function handleListTools(categoryId) {
  if (!categoryId || categoryId === '*') {
    const allTools = Object.values(toolIndex.byId).slice(0, CONFIG.MAX_RESULTS_PER_QUERY);
    return { status: 'success', result: { total: allTools.length, tools: allTools } };
  }
  const tools = toolIndex.byCategory[categoryId]?.slice(0, CONFIG.MAX_RESULTS_PER_QUERY) || [];
  return { status: 'success', result: { category: categoryId, total: tools.length, tools } };
}

/**
 * 模糊匹配算法
 */
function fuzzyMatch(text, query) {
  if (!text || !query) return false;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return true;
  const qParts = q.split(/\s+/);
  return qParts.every(part => t.includes(part));
}

/**
 * 计算匹配得分
 */
function calculateMatchScore(tool, query) {
  const q = query.toLowerCase();
  let score = 0;
  if (tool.name.toLowerCase().includes(q)) score += 10;
  if (tool.displayName.toLowerCase().includes(q)) score += 5;
  if (tool.description.toLowerCase().includes(q)) score += 2;
  if (tool.tags?.some(t => t.toLowerCase().includes(q))) score += 3;
  return score;
}

/**
 * 处理search_tools命令（模糊搜索）
 */
function handleSearchTools(query, categoryId) {
  if (!query) {
    return { status: 'error', error: '缺少必填参数query' };
  }
  let candidates = Object.values(toolIndex.byId);
  if (categoryId && categoryId !== '*') {
    candidates = candidates.filter(t => t.category === categoryId);
  }
  if (CONFIG.ENABLE_FUZZY_SEARCH) {
    candidates = candidates.filter(t => fuzzyMatch(t.name, query) || fuzzyMatch(t.displayName, query) || fuzzyMatch(t.description, query));
  } else {
    candidates = candidates.filter(t => fuzzyMatch(t.name, query) || fuzzyMatch(t.displayName, query));
  }
  candidates.sort((a, b) => calculateMatchScore(b, query) - calculateMatchScore(a, query));
  const results = candidates.slice(0, CONFIG.MAX_RESULTS_PER_QUERY);
  return { status: 'success', result: { query, total: results.length, tools: results } };
}

/**
 * 处理get_tool_schema命令
 */
function handleGetToolSchema(toolId) {
  const tool = toolIndex.byId[toolId.toLowerCase()];
  if (!tool) {
    return { status: 'error', error: `工具ID ${toolId} 未找到` };
  }
  return { status: 'success', result: tool };
}

/**
 * 主入口
 */
async function main() {
  try {
    // 刷新索引
    await refreshIndex();
    // 读取输入
    const input = fs.readFileSync(0, 'utf8').trim();
    if (!input) {
      console.log(JSON.stringify({ status: 'error', error: '输入为空' }));
      process.exit(1);
    }
    let args;
    try {
      args = JSON.parse(input);
    } catch (e) {
      console.log(JSON.stringify({ status: 'error', error: '无效的JSON格式' }));
      process.exit(1);
    }
    if (!args.command && !args.commandIdentifier) {
      console.log(JSON.stringify({ status: 'error', error: '缺少command或commandIdentifier字段' }));
      process.exit(1);
    }
    let result;
    if (args.command === 'list_tools' || args.commandIdentifier === 'list_tools') {
      result = handleListTools(args.category_id);
    } else if (args.command === 'get_tool_schema' || args.commandIdentifier === 'get_tool_schema') {
      if (!args.tool_id) {
        result = { status: 'error', error: '缺少必填参数tool_id' };
      } else {
        result = handleGetToolSchema(args.tool_id);
      }
    } else if (args.command === 'search_tools' || args.commandIdentifier === 'search_tools') {
      result = handleSearchTools(args.query, args.category_id);
    } else {
      result = { status: 'error', error: `未知命令 ${args.command}` };
    }
    // 输出结果
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: e.message }));
    process.exit(1);
  }
}

main();