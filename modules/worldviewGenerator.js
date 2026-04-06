/**
 * 对话世界观文档系统 - 文档生成模块
 * 
 * 负责创建和更新MD格式的世界观文档，处理时间线追加和格式化。
 */

const fs = require('fs').promises;
const path = require('path');

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const WORLDVIEW_DIR = process.env.VCP_WORLDVIEW_DIR || 'VCPDialogueWorldview';
const TOKEN_LIMIT = parseInt(process.env.VCP_WORLDVIEW_TOKEN_LIMIT || '20000', 10);
const SAFETY_BUFFER = parseInt(process.env.VCP_WORLDVIEW_TOKEN_SAFETY_BUFFER || '1500', 10);
const MAX_ENTRIES = parseInt(process.env.VCP_WORLDVIEW_MAX_ENTRIES || '10', 10);
const VCP_CHAT_BASE_PATH = process.env.VCP_CHAT_BASE_PATH || '';

const { estimateTokens } = require('./utils/tokenCounter');

function estimateContentTokens(content) {
    return estimateTokens(content);
}

function formatTimestamp(date = new Date()) {
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatDateOnly(date = new Date()) {
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getSessionDir(requestId) {
    return path.join(WORLDVIEW_DIR, '_index', 'sessions', requestId);
}

function getWorldviewPath(requestId) {
    return path.join(getSessionDir(requestId), 'worldview.md');
}

function getMetaPath(requestId) {
    return path.join(getSessionDir(requestId), 'meta.json');
}

function buildHeader(sessionId, agentId = null, createdAt = new Date()) {
    const now = formatTimestamp();
    let historyPathLine = '';
    if (agentId && VCP_CHAT_BASE_PATH) {
        const historyPath = path.join(VCP_CHAT_BASE_PATH, 'AppData', 'UserData', agentId, 'topics', sessionId, 'history.json');
        historyPathLine = `\n> 历史文件: ${historyPath}`;
    }
    return `# 🌍 对话世界观文档

> 会话ID: ${sessionId}${historyPathLine}
> 创建时间: ${formatTimestamp(createdAt)}
> 最后更新: ${now}
> Token: 0 / ${TOKEN_LIMIT}

---

> **【全局系统指令】**
> 1. 若存在相似的全局指令，以最新时间戳为准，覆盖旧指令。
> 2. 若需查看更早的完整对话详情，可根据每条摘要中的"对话引用"(history.json 第X行)直接读取对应位置的详细信息。

## 📌 当前进行中 (高保真近期区)

`;
}

function buildArchiveHeader() {
    return `

---

## 🗄️ 已归档/被搁置 (极度压缩归档区)

`;
}

function formatNewEntry(summary, timestamp = new Date()) {
    if (summary.isIgnored) {
        return null;
    }

    const dateStr = formatTimestamp(timestamp);
    const fallbackTag = summary.isFallback ? ' **[摘要生成失败]**' : '';

    let entry = `### [${dateStr}]${fallbackTag}\n`;

    if (summary.userIntent) {
        entry += `- **用户意图**: ${summary.userIntent}\n`;
    }
    if (summary.aiResponse) {
        const lines = summary.aiResponse.trim().split('\n');
        const hasBulletFormat = lines.some(l => l.trim().startsWith('-'));
        if (hasBulletFormat) {
            // 过滤掉可能的 **AI答复**: 等标题行，只保留要点
            const bulletLines = lines.filter(l => !l.includes('**'));
            entry += `- **AI答复**:\n${bulletLines.map(l => `  ${l.trim()}`).join('\n')}\n`;
        } else {
            // 多行内容，每行都缩进
            entry += `- **AI答复**:\n${lines.map(l => `  ${l}`).join('\n')}\n`;
        }
    }
    if (summary.fileChanges) {
        entry += `- **文件变更**:\n  ${summary.fileChanges}\n`;
    }
    if (summary.pitfalls) {
        entry += `- **避坑与废弃**: ${summary.pitfalls}\n`;
    }
    if (summary.statusUpdate) {
        entry += `- **状态更新**:\n  ${summary.statusUpdate}\n`;
    }
    if (summary.blockers) {
        entry += `- **阻塞与追问**: ${summary.blockers}\n`;
    }
    if (summary.globalInstruction) {
        entry += `- **🚨全局指令**: **${summary.globalInstruction}**\n`;
    }
    if (summary.messageId) {
        entry += `- **对话引用**: ${summary.messageId}`;
        if (summary.historyLine) {
            entry += ` (history.json 第${summary.historyLine}行)`;
        }
        entry += '\n';
    }

    return entry;
}

function formatArchiveEntry(summary, originalTimestamp) {
    const dateStr = formatDateOnly(new Date(originalTimestamp));
    return `\n- *${dateStr}*: [${summary.userIntent}] ${summary.aiResponse ? summary.aiResponse.substring(0, 30) : ''}`;
}

function parseExistingContent(content) {
    const result = {
        header: '',
        activeSection: '',
        archiveSection: '',
        activeEntries: [],
        archiveEntries: []
    };

    if (!content) {
        return result;
    }

    const lines = content.split('\n');
    let currentSection = 'header';
    let currentEntry = null;

    // 容错正则：支持 ### [ 或 ## [ 或 # [ 开头的时间戳条目
    // 匹配 ## ## [2026-04-05] 或 ### [2026-04-05] 等变体
    const entryTitlePattern = /^(#{1,3})\s*\[\d{4}-\d{2}-\d{2}.*\]\s*.*$/;

    try {
        for (const line of lines) {
            if (line.startsWith('## 📌')) {
                currentSection = 'active';
                result.header += line + '\n';
            } else if (line.startsWith('## 🗄️')) {
                currentSection = 'archive';
                result.header += line + '\n';
            } else if (entryTitlePattern.test(line) && currentSection === 'active') {
                if (currentEntry) {
                    result.activeEntries.push(currentEntry);
                }
                currentEntry = { title: line, content: line + '\n' };
            } else if (line.startsWith('- *') && currentSection === 'archive') {
                result.archiveEntries.push(line);
            } else if (currentEntry) {
                currentEntry.content += line + '\n';
            } else {
                result.header += line + '\n';
            }
        }

        if (currentEntry) {
            result.activeEntries.push(currentEntry);
        }
    } catch (e) {
        // 解析失败时，保留原始内容，不做任何截断
        if (DEBUG_MODE) {
            console.warn(`[WorldviewGenerator] 文档解析失败，保留原文:`, e.message);
        }
        result.header = content;
        result.activeEntries = [];
        result.archiveEntries = [];
    }

    return result;
}

async function createWorldview(sessionId, agentId = null) {
    const sessionDir = getSessionDir(sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const header = buildHeader(sessionId, agentId);
    const worldviewPath = getWorldviewPath(sessionId);
    const metaPath = getMetaPath(sessionId);

    await fs.writeFile(worldviewPath, header, 'utf-8');

    const meta = {
        sessionId: sessionId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tokenCount: estimateContentTokens(header),
        entryCount: 0,
        status: 'active',
        archivedEntries: 0
    };

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    if (DEBUG_MODE) {
        console.log(`[WorldviewGenerator] 创建世界观文档: ${sessionId}`);
    }

    return { header, meta };
}

async function appendEntry(sessionId, summary, agentId = null) {
    if (DEBUG_MODE) {
        console.log(`[WorldviewGenerator] appendEntry called: sessionId=${sessionId}, agentId=${agentId}, VCP_CHAT_BASE_PATH=${VCP_CHAT_BASE_PATH || '未设置'}`);
    }

    if (summary.isIgnored) {
        if (DEBUG_MODE) {
            console.log(`[WorldviewGenerator] 对话被忽略，跳过记录`);
        }
        return null;
    }

    let worldviewPath = getWorldviewPath(sessionId);
    let metaPath = getMetaPath(sessionId);

    let existingContent = '';
    let meta = null;

    try {
        existingContent = await fs.readFile(worldviewPath, 'utf-8');
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        meta = JSON.parse(metaContent);
        
        // 如果现有header没有历史文件路径，但现在有agentId，则更新header
        if (DEBUG_MODE) {
            console.log(`[WorldviewGenerator] 检查header更新条件: agentId=${agentId}, hasHistoryLine=${existingContent.includes('> 历史文件:')}, VCP_CHAT_BASE_PATH=${VCP_CHAT_BASE_PATH ? '已设置' : '未设置'}`);
        }
        
        if (agentId && !existingContent.includes('> 历史文件:') && VCP_CHAT_BASE_PATH) {
            const newHeader = buildHeader(sessionId, agentId);
            const headerEndIdx = existingContent.indexOf('\n\n---\n\n');
            if (headerEndIdx > -1) {
                existingContent = newHeader + existingContent.substring(headerEndIdx + 9);
                if (DEBUG_MODE) {
                    console.log(`[WorldviewGenerator] 更新世界观Header，添加历史文件路径`);
                }
            }
        }
    } catch (e) {
        if (e.code === 'ENOENT') {
            const created = await createWorldview(sessionId, agentId);
            existingContent = created.header;
            meta = created.meta;
        } else {
            throw e;
        }
    }

    const newEntry = formatNewEntry(summary);

    if (!newEntry) {
        if (DEBUG_MODE) {
            console.log(`[WorldviewGenerator] 无法生成有效条目，跳过`);
        }
        return null;
    }

    let updatedContent;
    const parsed = parseExistingContent(existingContent);

    // 检查是否已有归档区（在 header 中包含 ## 🗄️）
    if (parsed.header.includes('## 🗄️')) {
        const parts = existingContent.split('## 🗄️');
        updatedContent = parts[0] + newEntry + '\n\n## 🗄️' + parts[1];
    } else {
        updatedContent = existingContent + newEntry + '\n';
    }

    await fs.writeFile(worldviewPath, updatedContent, 'utf-8');

    meta.updatedAt = new Date().toISOString();
    meta.tokenCount = estimateContentTokens(updatedContent);
    meta.entryCount = (meta.entryCount || 0) + 1;

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    if (DEBUG_MODE) {
        console.log(`[WorldviewGenerator] 追加条目到 ${sessionId}，当前token: ${meta.tokenCount}`);
    }

    return meta;
}

async function getWorldviewContent(sessionId) {
    const worldviewPath = getWorldviewPath(sessionId);

    try {
        return await fs.readFile(worldviewPath, 'utf-8');
    } catch (e) {
        if (e.code === 'ENOENT') {
            return '';
        }
        throw e;
    }
}

async function getMeta(sessionId) {
    const metaPath = getMetaPath(sessionId);

    try {
        const content = await fs.readFile(metaPath, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return null;
        }
        throw e;
    }
}

async function getAllTopics() {
    const sessionsDir = path.join(WORLDVIEW_DIR, '_index', 'sessions');

    try {
        const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
        const topics = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const meta = await getMeta(entry.name);
                if (meta) {
                    topics.push({
                        sessionId: entry.name,
                        createdAt: meta.createdAt,
                        updatedAt: meta.updatedAt,
                        entryCount: meta.entryCount,
                        status: meta.status
                    });
                }
            }
        }

        topics.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        return topics;
    } catch (e) {
        if (e.code === 'ENOENT') {
            return [];
        }
        throw e;
    }
}

async function archiveOldEntries(sessionId, countToArchive) {
    const worldviewPath = getWorldviewPath(sessionId);
    const metaPath = getMetaPath(sessionId);

    let content = await fs.readFile(worldviewPath, 'utf-8');
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

    const parsed = parseExistingContent(content);

    if (parsed.activeEntries.length <= MAX_ENTRIES) {
        return { archived: 0, newContent: content };
    }

    const entriesToArchive = parsed.activeEntries.slice(0, parsed.activeEntries.length - MAX_ENTRIES);
    const keptEntries = parsed.activeEntries.slice(parsed.activeEntries.length - MAX_ENTRIES);

    let archiveContent = '';
    for (const entry of entriesToArchive) {
        const intentMatch = entry.content.match(/\*\*用户意图\*\*[:：]\s*(.+)/);
        const aiMatch = entry.content.match(/\*\*AI答复\*\*[:：]\s*([\s\S]*?)(?=\n\s*-\s*\*\*|\n\s*##|$)/);
        archiveContent += formatArchiveEntry(
            { 
                userIntent: intentMatch ? intentMatch[1] : entry.title.replace(/^### \[\d{4}-\d{2}-\d{2}\]\s*/, ''), 
                aiResponse: aiMatch ? aiMatch[1].replace(/\n\s*-\s*/g, ' ').trim() : '' 
            },
            entry.title
        );
    }

    const headerEnd = content.indexOf('## 📌');
    const header = content.substring(0, headerEnd);

    let newContent = header + '## 📌 当前进行中 (高保真近期区)\n\n';
    for (const entry of keptEntries) {
        newContent += entry.content + '\n';
    }

    newContent += buildArchiveHeader();
    if (archiveContent) {
        newContent += archiveContent + '\n';
    }

    const existingArchiveLines = parsed.archiveEntries.join('\n');
    if (existingArchiveLines) {
        newContent += existingArchiveLines + '\n';
    }

    await fs.writeFile(worldviewPath, newContent, 'utf-8');

    meta.archivedEntries = (meta.archivedEntries || 0) + entriesToArchive.length;
    meta.tokenCount = estimateContentTokens(newContent);

    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

    if (DEBUG_MODE) {
        console.log(`[WorldviewGenerator] 归档 ${entriesToArchive.length} 条旧条目`);
    }

    return { archived: entriesToArchive.length, newContent };
}

module.exports = {
    createWorldview,
    appendEntry,
    getWorldviewContent,
    getWorldviewPath,
    getMeta,
    getAllTopics,
    archiveOldEntries,
    formatNewEntry,
    estimateContentTokens,
    MAX_ENTRIES,
    TOKEN_LIMIT,
    SAFETY_BUFFER
};
