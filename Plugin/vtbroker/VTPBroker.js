/**
 * VTPBroker Plugin Adapter
 * 
 * VCP 工具发现插件适配层
 * 支持两种模式：
 * 1. 内置模式 (ENABLE_BUILTIN_VTBROKER=true): 转发请求到 server.js REST API
 * 2. 独立模式 (ENABLE_BUILTIN_VTBROKER=false): 独立目录扫描
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

// 原生读取env配置
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
  PLUGIN_ROOT: path.join(__dirname, '..'),
  SERVER_HOST: env.SERVER_HOST || '127.0.0.1',
  SERVER_PORT: env.SERVER_PORT || process.env.PORT || 3000,
  API_BASE: null,
  USE_BUILTIN: env.ENABLE_BUILTIN_VTBROKER === 'true'
};

// ==================== 独立模式实现（原有逻辑） ====================

let toolIndex = { byId: {}, byCategory: {}, byName: {}, byTag: {} };
let lastIndexRefresh = 0;
let nameCollisionCount = 0;

async function refreshIndex() {
  const now = Date.now();
  if (now - lastIndexRefresh < CONFIG.INDEX_REFRESH_INTERVAL && Object.keys(toolIndex.byId).length > 0) {
    return;
  }
  toolIndex = { byId: {}, byCategory: {}, byName: {}, byTag: {} };
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

function getPluginCategory(manifest) {
  const name = manifest.name.toLowerCase();
  const desc = manifest.description?.toLowerCase() || '';
  if (name.includes('file') || name.includes('fs') || desc.includes('文件')) return 'file_ops';
  if (name.includes('code') || name.includes('dev') || desc.includes('代码') || desc.includes('开发')) return 'code';
  if (name.includes('search') || desc.includes('搜索')) return 'search';
  if (name.includes('rag') || name.includes('knowledge') || desc.includes('知识')) return 'knowledge';
  if (name.includes('chat') || name.includes('message') || desc.includes('通讯')) return 'collaboration';
  return 'uncategorized';
}

function getPluginTags(manifest) {
  const tags = [];
  if (manifest.capabilities?.invocationCommands) {
    for (const cmd of manifest.capabilities.invocationCommands) {
      const desc = cmd.description?.toLowerCase() || '';
      if (desc.includes('read')) tags.push('read');
      if (desc.includes('write')) tags.push('write');
      if (desc.includes('search')) tags.push('search');
      if (desc.includes('download')) tags.push('download');
    }
  }
  return [...new Set(tags)];
}

// ==================== HTTP 转发实现（内置模式） ====================

function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(JSON.stringify(postData));
    }
    req.end();
  });
}

async function builtinListTools(categoryId) {
  const baseUrl = `http://${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}/vtbroker/api`;
  const url = categoryId && categoryId !== '*' 
    ? `${baseUrl}/tools?category_id=${encodeURIComponent(categoryId)}`
    : `${baseUrl}/tools`;
  const result = await httpRequest({ hostname: CONFIG.SERVER_HOST, port: CONFIG.SERVER_PORT, path: url, method: 'GET' });
  if (result.success) {
    return { status: 'success', result: { total: result.data.length, tools: result.data } };
  }
  return { status: 'error', error: result.error || '请求失败' };
}

async function builtinGetToolSchema(toolId) {
  const baseUrl = `http://${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}/vtbroker/api`;
  const result = await httpRequest({
    hostname: CONFIG.SERVER_HOST,
    port: CONFIG.SERVER_PORT,
    path: `${baseUrl}/schema/${encodeURIComponent(toolId)}`,
    method: 'GET'
  });
  if (result.success) {
    return { status: 'success', result: result.data };
  }
  return { status: 'error', error: result.error || '工具未找到' };
}

async function builtinSearchTools(query, categoryId) {
  const baseUrl = `http://${CONFIG.SERVER_HOST}:${CONFIG.SERVER_PORT}/vtbroker/api`;
  let url = `${baseUrl}/search?query=${encodeURIComponent(query)}`;
  if (categoryId && categoryId !== '*') {
    url += `&category_id=${encodeURIComponent(categoryId)}`;
  }
  const result = await httpRequest({ hostname: CONFIG.SERVER_HOST, port: CONFIG.SERVER_PORT, path: url, method: 'GET' });
  if (result.success) {
    return { status: 'success', result: result.data };
  }
  return { status: 'error', error: result.error || '搜索失败' };
}

// ==================== 独立模式处理器 ====================

function handleListTools(categoryId) {
  if (!categoryId || categoryId === '*') {
    const allTools = Object.values(toolIndex.byId).slice(0, CONFIG.MAX_RESULTS_PER_QUERY);
    return { status: 'success', result: { total: allTools.length, tools: allTools } };
  }
  const tools = toolIndex.byCategory[categoryId]?.slice(0, CONFIG.MAX_RESULTS_PER_QUERY) || [];
  return { status: 'success', result: { category: categoryId, total: tools.length, tools } };
}

function fuzzyMatch(text, query) {
  if (!text || !query) return false;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t.includes(q)) return true;
  const qParts = q.split(/\s+/);
  return qParts.every(part => t.includes(part));
}

function calculateMatchScore(tool, query) {
  const q = query.toLowerCase();
  let score = 0;
  if (tool.name?.toLowerCase().includes(q)) score += 10;
  if (tool.displayName?.toLowerCase().includes(q)) score += 5;
  if (tool.description?.toLowerCase().includes(q)) score += 2;
  if (tool.tags?.some(t => t.toLowerCase().includes(q))) score += 3;
  return score;
}

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

function handleGetToolSchema(toolId) {
  const tool = toolIndex.byId[toolId];
  if (!tool) {
    for (const [id, t] of Object.entries(toolIndex.byId)) {
      if (id.toLowerCase() === toolId.toLowerCase()) {
        return { status: 'success', result: t };
      }
    }
    return { status: 'error', error: `工具ID ${toolId} 未找到` };
  }
  return { status: 'success', result: tool };
}

// ==================== 主入口 ====================

async function main() {
  try {
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
    const useBuiltin = CONFIG.USE_BUILTIN;

    if (args.command === 'list_tools' || args.commandIdentifier === 'list_tools') {
      if (useBuiltin) {
        result = await builtinListTools(args.category_id);
      } else {
        await refreshIndex();
        result = handleListTools(args.category_id);
      }
    } else if (args.command === 'get_tool_schema' || args.commandIdentifier === 'get_tool_schema') {
      if (!args.tool_id) {
        result = { status: 'error', error: '缺少必填参数tool_id' };
      } else if (useBuiltin) {
        result = await builtinGetToolSchema(args.tool_id);
      } else {
        await refreshIndex();
        result = handleGetToolSchema(args.tool_id);
      }
    } else if (args.command === 'search_tools' || args.commandIdentifier === 'search_tools') {
      if (useBuiltin) {
        result = await builtinSearchTools(args.query, args.category_id);
      } else {
        await refreshIndex();
        result = handleSearchTools(args.query, args.category_id);
      }
    } else {
      const unknownCmd = args.command || args.commandIdentifier || 'unknown';
      result = { status: 'error', error: `未知命令 ${unknownCmd}` };
    }

    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', error: e.message }));
    process.exit(1);
  }
}

main();
