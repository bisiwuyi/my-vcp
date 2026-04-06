/**
 * 对话世界观文档系统 - 文档压缩模块
 * 
 * 当世界观文档超过Token限制时，执行渐进压缩归档策略。
 */

const fs = require('fs').promises;
const path = require('path');

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const WORLDVIEW_DIR = process.env.VCP_WORLDVIEW_DIR || 'VCPDialogueWorldview';
const TOKEN_LIMIT = parseInt(process.env.VCP_WORLDVIEW_TOKEN_LIMIT || '20000', 10);
const SAFETY_BUFFER = parseInt(process.env.VCP_WORLDVIEW_TOKEN_SAFETY_BUFFER || '1500', 10);
const MAX_ENTRIES = parseInt(process.env.VCP_WORLDVIEW_MAX_ENTRIES || '10', 10);

const COMPRESS_THRESHOLD = TOKEN_LIMIT - SAFETY_BUFFER;

const ARCHIVE_DIR = path.join(WORLDVIEW_DIR, '_archive');

const { estimateTokens } = require('./utils/tokenCounter');

function formatTimestamp(date = new Date()) {
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function getArchiveDir(yearMonth = null) {
    if (yearMonth) {
        return path.join(ARCHIVE_DIR, yearMonth);
    }
    const now = new Date();
    const pad = (n, len = 2) => String(n).padStart(len, '0');
    return path.join(ARCHIVE_DIR, `${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
}

async function saveArchiveEntry(sessionId, entry, originalTimestamp) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const archiveDir = getArchiveDir(yearMonth);

    await fs.mkdir(archiveDir, { recursive: true });

    const archiveFile = path.join(archiveDir, `${sessionId}.json`);

    let existingArchives = [];
    try {
        const existing = await fs.readFile(archiveFile, 'utf-8');
        existingArchives = JSON.parse(existing);
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw e;
        }
    }

    const archiveEntry = {
        sessionId: sessionId,
        archivedAt: formatTimestamp(now),
        originalTimestamp: formatTimestamp(new Date(originalTimestamp)),
        originalEntry: {
            title: entry.title,
            content: entry.content,
            summary: extractSummaryFromEntry(entry)
        },
        compressedSummary: compressEntry(entry)
    };

    existingArchives.push(archiveEntry);

    await fs.writeFile(archiveFile, JSON.stringify(existingArchives, null, 2), 'utf-8');

    if (DEBUG_MODE) {
        console.log(`[WorldviewCompressor] 归档条目到 ${archiveFile}`);
    }

    return archiveEntry;
}

function extractSummaryFromEntry(entry) {
    const content = entry.content || '';

    const intentMatch = content.match(/\*\*用户意图\*\*:\s*(.+)/);
    const aiMatch = content.match(/\*\*AI答复\*\*:\s*([\s\S]*?)(?=\n\s*-\s*\*\*|\n\s*###|\n\n|$)/);

    return {
        userIntent: intentMatch ? intentMatch[1].trim() : '',
        aiResponse: aiMatch ? aiMatch[1].trim() : ''
    };
}

function compressEntry(entry) {
    const summary = extractSummaryFromEntry(entry);
    const title = entry.title || '';

    const dateMatch = title.match(/\[(\d{4}-\d{2}-\d{2})\]/);
    const dateStr = dateMatch ? dateMatch[1] : formatTimestamp().split(' ')[0];
    const topic = title.replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, '').replace(/\s*\*\*$/, '');

    return `${dateStr}: [${topic}] ${summary.aiResponse || summary.userIntent}`;
}

async function compressIfNeeded(sessionId, currentContent, meta) {
    const currentTokens = estimateTokens(currentContent);

    if (currentTokens <= COMPRESS_THRESHOLD) {
        if (DEBUG_MODE) {
            console.log(`[WorldviewCompressor] ${sessionId} 无需压缩，当前token: ${currentTokens}`);
        }
        return { compressed: false, newContent: currentContent, archivedCount: 0 };
    }

    if (DEBUG_MODE) {
        console.log(`[WorldviewCompressor] ${sessionId} 触发压缩，当前token: ${currentTokens}，阈值: ${COMPRESS_THRESHOLD}`);
    }

    const { archiveOldEntries } = require('./worldviewGenerator');
    const result = await archiveOldEntries(sessionId, MAX_ENTRIES);

    return {
        compressed: true,
        newContent: result.newContent,
        archivedCount: result.archived,
        newTokenCount: estimateTokens(result.newContent)
    };
}

async function getArchivedEntries(sessionId) {
    try {
        const entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
        const results = [];

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const archiveDir = path.join(ARCHIVE_DIR, entry.name);
                const files = await fs.readdir(archiveDir);

                for (const file of files) {
                    if (file.endsWith('.json') && file.startsWith(sessionId)) {
                        const archiveFile = path.join(archiveDir, file);
                        const content = await fs.readFile(archiveFile, 'utf-8');
                        const archives = JSON.parse(content);
                        results.push(...archives);
                    }
                }
            }
        }

        return results;
    } catch (e) {
        if (e.code === 'ENOENT') {
            return [];
        }
        throw e;
    }
}

async function cleanupOldArchives(daysToKeep = 90) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    try {
        const entries = await fs.readdir(ARCHIVE_DIR, { withFileTypes: true });
        let deletedCount = 0;

        for (const entry of entries) {
            if (entry.isDirectory()) {
                const dirDate = new Date(entry.name);
                if (dirDate < cutoffDate) {
                    const dirPath = path.join(ARCHIVE_DIR, entry.name);
                    await fs.rm(dirPath, { recursive: true });
                    deletedCount++;
                    if (DEBUG_MODE) {
                        console.log(`[WorldviewCompressor] 删除过期归档目录: ${entry.name}`);
                    }
                }
            }
        }

        return deletedCount;
    } catch (e) {
        if (e.code === 'ENOENT') {
            return 0;
        }
        throw e;
    }
}

module.exports = {
    compressIfNeeded,
    saveArchiveEntry,
    getArchivedEntries,
    cleanupOldArchives,
    compressEntry,
    COMPRESS_THRESHOLD,
    TOKEN_LIMIT,
    SAFETY_BUFFER,
    ARCHIVE_DIR
};
