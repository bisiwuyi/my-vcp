/**
 * 对话世界观文档系统 - 附件处理模块
 * 
 * 负责检测、解析、保存 AI 输出的重要文档（MD、代码、Word、Excel、PPT等）
 * 支持版本控制，自动清理最旧版本
 */

const fs = require('fs').promises;
const path = require('path');

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const WORLDVIEW_DIR = process.env.VCP_WORLDVIEW_DIR || 'VCPDialogueWorldview';
const ATTACHMENTS_DIR = '_attachments';
const MAX_VERSIONS = 5;

const TEXT_SAVE_PATTERN = /<!--\s*VCP_SAVE:\s*(.+?)\s*-->([\s\S]*?)<!--\s*VCP_SAVE_END\s*-->/gi;
const DOC_SAVE_PATTERN = /<!--\s*VCP_DOC:\s*(.+?)\s*-->([\s\S]*?)<!--\s*VCP_DOC_END\s*-->/gi;

function getAttachmentsDir(sessionId) {
    return path.join(WORLDVIEW_DIR, '_index', 'sessions', sessionId, ATTACHMENTS_DIR);
}

function sanitizeFilename(filename) {
    return filename.replace(/[<>:"/\\|?*]/g, '_');
}

function getFileBaseName(filename) {
    const lastDot = filename.lastIndexOf('.');
    if (lastDot === -1) {
        return { base: filename, ext: '' };
    }
    return {
        base: filename.substring(0, lastDot),
        ext: filename.substring(lastDot)
    };
}

async function ensureAttachmentsDir(sessionId) {
    const dir = getAttachmentsDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
}

async function getExistingVersions(sessionId, baseName, extension) {
    const dir = getAttachmentsDir(sessionId);
    try {
        const files = await fs.readdir(dir);
        const versions = [];
        
        const regex = new RegExp(`^${escapeRegExp(baseName)}_v(\\d+)${escapeRegExp(extension)}$`);
        
        for (const file of files) {
            const match = file.match(regex);
            if (match) {
                versions.push({ version: parseInt(match[1]), filename: file });
            }
        }
        
        return versions.sort((a, b) => a.version - b.version);
    } catch (e) {
        if (e.code === 'ENOENT') {
            return [];
        }
        throw e;
    }
}

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function deleteOldestVersion(sessionId, baseName, extension) {
    const versions = await getExistingVersions(sessionId, baseName, extension);
    if (versions.length >= MAX_VERSIONS) {
        const oldest = versions[0];
        const dir = getAttachmentsDir(sessionId);
        const filePath = path.join(dir, oldest.filename);
        await fs.unlink(filePath);
        if (DEBUG_MODE) {
            console.log(`[WorldviewAttachment] 删除最旧版本: ${oldest.filename}`);
        }
        return oldest.version;
    }
    return null;
}

async function saveAttachment(sessionId, filename, content, isBinary = false) {
    await ensureAttachmentsDir(sessionId);
    
    const sanitized = sanitizeFilename(filename);
    const { base, ext } = getFileBaseName(sanitized);
    
    const effectiveExt = isBinary ? `${ext}.desc` : (ext || '.txt');
    const effectiveBase = base;
    
    let currentVersion = 1;
    let deletedVersion = null;
    
    while (true) {
        const versions = await getExistingVersions(sessionId, effectiveBase, effectiveExt);
        
        if (versions.length < MAX_VERSIONS) {
            if (versions.length > 0) {
                const maxVersion = Math.max(...versions.map(v => v.version));
                currentVersion = maxVersion + 1;
            }
            break;
        }
        
        deletedVersion = await deleteOldestVersion(sessionId, effectiveBase, effectiveExt);
        const newVersions = await getExistingVersions(sessionId, effectiveBase, effectiveExt);
        
        if (newVersions.length === 0 && deletedVersion !== null) {
            currentVersion = deletedVersion;
            break;
        }
        
        const maxVersion = Math.max(...newVersions.map(v => v.version));
        currentVersion = maxVersion + 1;
        break;
    }
    
    const actualExt = effectiveExt || '.txt';
    const versionFilename = `${effectiveBase}_v${currentVersion}${actualExt}`;
    const filePath = path.join(getAttachmentsDir(sessionId), versionFilename);
    
    if (isBinary) {
        await fs.writeFile(filePath, content, 'utf-8');
    } else {
        await fs.writeFile(filePath, content, 'utf-8');
    }
    
    if (DEBUG_MODE) {
        console.log(`[WorldviewAttachment] 保存附件: ${versionFilename}`);
    }
    
    return {
        filename: versionFilename,
        filepath: filePath,
        version: currentVersion,
        isBinary
    };
}

function extractSaveMarkers(text) {
    const results = [];
    
    let match;
    
    TEXT_SAVE_PATTERN.lastIndex = 0;
    while ((match = TEXT_SAVE_PATTERN.exec(text)) !== null) {
        results.push({
            filename: match[1].trim(),
            content: match[2],
            type: 'text'
        });
    }
    
    DOC_SAVE_PATTERN.lastIndex = 0;
    while ((match = DOC_SAVE_PATTERN.exec(text)) !== null) {
        results.push({
            filename: match[1].trim(),
            content: match[2],
            type: 'binary'
        });
    }
    
    return results;
}

function removeSaveMarkers(text) {
    TEXT_SAVE_PATTERN.lastIndex = 0;
    DOC_SAVE_PATTERN.lastIndex = 0;
    return text
        .replace(TEXT_SAVE_PATTERN, (match, filename) => `[系统记录：已自动保存文本附件 ${filename.trim()}]`)
        .replace(DOC_SAVE_PATTERN, (match, filename) => `[系统记录：已自动生成二进制指令 ${filename.trim()}]`)
        .trim();
}

async function processAIContent(sessionId, aiContent) {
    if (DEBUG_MODE) {
        console.log(`[WorldviewAttachment] processAIContent called, sessionId: ${sessionId}, content length: ${(aiContent || '').length}`);
    }
    
    const markers = extractSaveMarkers(aiContent);
    
    if (DEBUG_MODE) {
        console.log(`[WorldviewAttachment] markers found: ${markers.length}`);
    }
    
    if (markers.length === 0) {
        if (DEBUG_MODE) {
            console.log(`[WorldviewAttachment] No markers found in content, checking for common patterns...`);
            // 检查是否包含类似标记的内容（帮助调试）
            if (aiContent.includes('VCP_SAVE') || aiContent.includes('VCP_DOC')) {
                console.log(`[WorldviewAttachment] WARNING: Content contains VCP_SAVE or VCP_DOC but markers not matched!`);
                console.log(`[WorldviewAttachment] Content sample: ${aiContent.substring(0, 500)}`);
            }
        }
        return {
            cleanedContent: aiContent,
            attachments: []
        };
    }
    
    const attachments = [];
    
    for (const marker of markers) {
        if (DEBUG_MODE) {
            console.log(`[WorldviewAttachment] Processing marker: ${marker.type} - ${marker.filename}`);
        }
        try {
            const result = await saveAttachment(
                sessionId,
                marker.filename,
                marker.content,
                marker.type === 'binary'
            );
            
            if (DEBUG_MODE) {
                console.log(`[WorldviewAttachment] Saved: ${result.filename} to ${result.filepath}`);
            }
            
            attachments.push({
                filename: result.filename,
                filepath: result.filepath,
                version: result.version,
                type: marker.type,
                description: extractDescription(marker.content, marker.type)
            });
        } catch (e) {
            if (DEBUG_MODE) {
                console.error(`[WorldviewAttachment] 保存附件失败: ${marker.filename}`, e.message);
            }
        }
    }
    
    const cleanedContent = removeSaveMarkers(aiContent);
    
    return {
        cleanedContent,
        attachments
    };
}

function extractDescription(content, type) {
    if (type === 'binary') {
        const firstLine = content.split('\n')[0];
        return firstLine ? firstLine.substring(0, 50) : '生成指令';
    }
    
    const lines = content.split('\n').filter(l => l.trim());
    const firstMeaningful = lines.find(l => !l.startsWith('#') && l.trim().length > 0);
    
    if (firstMeaningful) {
        return firstMeaningful.trim().substring(0, 50);
    }
    
    const titleLine = lines.find(l => l.startsWith('#'));
    if (titleLine) {
        return titleLine.replace(/^#+\s*/, '').trim().substring(0, 50);
    }
    
    return content.substring(0, 50).trim();
}

module.exports = {
    processAIContent,
    extractSaveMarkers,
    removeSaveMarkers,
    getAttachmentsDir,
    MAX_VERSIONS
};
