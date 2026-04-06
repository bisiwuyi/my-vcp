/**
 * WorldviewPlugin - 对话世界观文档静态插件
 * 
 * 提供 {{VCPWorldview}} 占位符，注入世界观文档内容到 system prompt。
 * 注意：本插件已被 messageProcessor.js 中的异步处理替代，此处仅作备用。
 */

const path = require('path');
const fs = require('fs');

const WORLDVIEW_DIR = process.env.VCP_WORLDVIEW_DIR || 'VCPDialogueWorldview';

let DialogueWorldviewManager = null;

function setManager(dwm) {
    DialogueWorldviewManager = dwm;
}

async function getPlaceholderValue(requestId) {
    if (!DialogueWorldviewManager) {
        DialogueWorldviewManager = require('../modules/DialogueWorldviewManager');
    }

    try {
        // 优先使用异步方法获取内存缓存（含 pendingSummaries）
        if (DialogueWorldviewManager.getWorldviewContent) {
            const content = await DialogueWorldviewManager.getWorldviewContent(requestId);
            if (content) {
                return content;
            }
        }

        // 降级读取物理文件
        const worldviewPath = path.join(process.cwd(), WORLDVIEW_DIR, '_index', 'sessions', requestId, 'worldview.md');
        const fsPromises = require('fs').promises;
        
        if (fs.existsSync(worldviewPath)) {
            return await fsPromises.readFile(worldviewPath, 'utf-8');
        }

        return '';
    } catch (e) {
        console.error(`[WorldviewPlugin] 获取世界观文档失败:`, e.message);
        return '';
    }
}

function getAvailableSessions() {
    try {
        const sessionsDir = path.join(process.cwd(), WORLDVIEW_DIR, '_index', 'sessions');
        if (!fs.existsSync(sessionsDir)) {
            return [];
        }
        return fs.readdirSync(sessionsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    } catch (e) {
        console.error(`[WorldviewPlugin] 获取会话列表失败:`, e.message);
        return [];
    }
}

module.exports = {
    setManager,
    getPlaceholderValue,
    getAvailableSessions
};
