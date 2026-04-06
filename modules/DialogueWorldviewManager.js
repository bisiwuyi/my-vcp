/**
 * 对话世界观文档系统 - 主管理器
 * 
 * 协调各子模块，提供统一的API入口。
 * - Promise链任务队列（防竞态）
 * - 内存暂态缓存（防上下文穿透）
 * - 数据脱敏
 * - LLM摘要生成（含降级策略）
 * - 文档更新与压缩
 * - WebSocket广播
 */

const path = require('path');
const chokidar = require('chokidar');

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const WORLDVIEW_DIR = process.env.VCP_WORLDVIEW_DIR || 'VCPDialogueWorldview';
const ENABLED = process.env.VCP_WORLDVIEW_ENABLED !== 'false';
const VCP_CHAT_BASE_PATH = process.env.VCP_CHAT_BASE_PATH || '';
const VCP_WORLDVIEW_INJECT_STRIP_RECENT = parseInt(process.env.VCP_WORLDVIEW_INJECT_STRIP_RECENT || '0', 10);

const dataMasking = require('./worldviewDataMasking');
const llmSummarizer = require('./worldviewLLMSummarizer');
const generator = require('./worldviewGenerator');
const compressor = require('./worldviewCompressor');

let webSocketServer = null;
let fileWatcher = null;

const queues = new Map();

const pendingSummaries = new Map();

const worldviewCache = new Map();

function setWebSocketServer(wss) {
    webSocketServer = wss;
}

async function enqueue(requestId, taskFn) {
    if (!queues.has(requestId)) {
        queues.set(requestId, Promise.resolve());
    }
    const previousTask = queues.get(requestId);

    const newTask = previousTask
        .catch((err) => {
            if (DEBUG_MODE) console.warn(`[Queue] 忽略上个任务的错误，继续执行队列:`, err.message);
        })
        .then(() => taskFn())
        .finally(() => {
            if (queues.get(requestId) === newTask) {
                queues.delete(requestId);
            }
        });

    queues.set(requestId, newTask);
    return newTask;
}

function setPendingSummary(requestId, userInput, aiResponse) {
    pendingSummaries.set(requestId, {
        userInput,
        aiResponse,
        timestamp: Date.now(),
        completed: false
    });
}

function markPendingComplete(requestId) {
    const pending = pendingSummaries.get(requestId);
    if (pending) {
        pending.completed = true;
        pendingSummaries.delete(requestId);
    }
}

function getPendingSummary(requestId) {
    return pendingSummaries.get(requestId);
}

async function getHistoryLineNumber(agentId, topicId, messageId) {
    if (!agentId || !messageId || !VCP_CHAT_BASE_PATH) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] getHistoryLineNumber 跳过: agentId=${agentId}, messageId=${messageId}, VCP_CHAT_BASE_PATH=${VCP_CHAT_BASE_PATH ? '已设置' : '未设置'}`);
        }
        return null;
    }

    const fs = require('fs').promises;
    const historyPath = path.join(VCP_CHAT_BASE_PATH, 'AppData', 'UserData', agentId, 'topics', topicId, 'history.json');

    if (DEBUG_MODE) {
        console.log(`[Worldview] 尝试读取history.json: ${historyPath}`);
    }

    try {
        const content = await fs.readFile(historyPath, 'utf-8');
        const lines = content.split('\n');
        
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`"id": "${messageId}"`)) {
                // content 行在 id 行前面约2行（"content" 在 "timestamp" 前面，"id" 在 "timestamp" 后面）
                // 因此 content 行 = id行索引 - 2
                const contentLineNumber = Math.max(i - 2, 0);
                if (DEBUG_MODE) {
                    console.log(`[Worldview] 找到messageId "${messageId}" 在第 ${i + 1} 行，content 在第 ${contentLineNumber + 1} 行`);
                }
                return contentLineNumber + 1;
            }
        }
        if (DEBUG_MODE) {
            console.log(`[Worldview] 未在history.json中找到messageId "${messageId}"`);
        }
        return null;
    } catch (e) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] 读取history.json失败: ${e.message}`);
        }
        return null;
    }
}

async function onConversationEnd(messages, requestId, userInput, aiResponse, isAborted = false, messageId = null, agentId = null) {
    console.log(`[Worldview Manager] onConversationEnd called, requestId: ${requestId}, messageId: ${messageId}, agentId: ${agentId}, aiResponse length: ${(aiResponse || '').length}, isAborted: ${isAborted}, ENABLED: ${ENABLED}`);

    if (!ENABLED) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] 系统未启用，跳过`);
        }
        return;
    }

    if (!requestId) {
        console.warn(`[Worldview] 缺少requestId，跳过`);
        return;
    }

    // 即使 AI 回复为空或被中断，也尝试总结用户消息
    if (!userInput && !aiResponse) {
        console.log(`[Worldview] userInput 和 aiResponse 都为空，跳过`);
        return;
    }

    return enqueue(requestId, async () => {
        console.log(`[Worldview Manager] 开始处理 ${requestId}`);

        setPendingSummary(requestId, userInput, aiResponse);

        try {
            // 从 aiResponse 中提取日记内容（支持两种格式）
            // 格式1: <<<[TOOL_REQUEST]>>>...Content:「始」...「末」...<<<[END_TOOL_REQUEST]>>>
            // 格式2: <<<DailyNoteStart>>>...Content:...<<<DailyNoteEnd>>>
            let diaryContent = '';
            
            const toolRequestMatch = aiResponse ? aiResponse.match(/<<<\[TOOL_REQUEST\]>>>([\s\S]*?)Content:\s*「始」([\s\S]*?)「末」[\s\S]*?<<<\[END_TOOL_REQUEST\]>>>/s) : null;
            if (toolRequestMatch && toolRequestMatch[2]) {
                diaryContent = toolRequestMatch[2].trim();
            } else {
                const dailyNoteMatch = aiResponse ? aiResponse.match(/<<<DailyNoteStart>>>([\s\S]*?)<<<DailyNoteEnd>>>/s) : null;
                if (dailyNoteMatch && dailyNoteMatch[1]) {
                    const contentMatch = dailyNoteMatch[1].match(/Content:\s*([\s\S]*)$/m);
                    diaryContent = contentMatch ? contentMatch[1].trim() : dailyNoteMatch[1].trim();
                }
            }

            // 获取用户消息原文
            const lastUserMessage = messages.filter(m => m.role === 'user').pop();
            const userContent = userInput || (lastUserMessage ? lastUserMessage.content : '');

            // 构建摘要
            const summary = {
                domainTag: '', // 不使用领域标签
                userIntent: userContent.length <= 50 ? userContent : '', // 短消息直接引用，长消息需要LLM生成
                aiResponse: diaryContent || '', // 使用日记内容
                fileChanges: '',
                pitfalls: '',
                statusUpdate: '',
                globalInstruction: '',
                blockers: '',
                messageId: messageId || null,
                agentId: agentId || null,
                historyLine: null
            };

            // 如果用户消息超过50字，需要LLM生成userIntent摘要
            if (userContent.length > 50) {
                console.log(`[Worldview] 用户消息超过50字(${userContent.length})，调用LLM生成摘要`);
                const thisTurnMessages = [
                    { role: 'user', content: userContent },
                    { role: 'assistant', content: diaryContent || aiResponse }
                ];
                const maskedMessages = dataMasking.maskMessages(thisTurnMessages);
                const llmSummary = await llmSummarizer.generateSummary(maskedMessages, { isAborted });
                summary.userIntent = llmSummary.userIntent || userContent.substring(0, 50);
            }

            // 如果日记内容为空，降级使用原有LLM摘要逻辑
            if (!diaryContent) {
                console.log(`[Worldview] 日记内容为空，降级使用LLM摘要`);
                const thisTurnMessages = [];
                if (lastUserMessage) {
                    thisTurnMessages.push(lastUserMessage);
                } else if (userInput) {
                    thisTurnMessages.push({ role: 'user', content: userInput });
                }
                if (aiResponse) {
                    thisTurnMessages.push({ role: 'assistant', content: aiResponse });
                }
                const maskedMessages = dataMasking.maskMessages(thisTurnMessages);
                const llmSummary = await llmSummarizer.generateSummary(maskedMessages, { isAborted });
                summary.userIntent = llmSummary.userIntent || userContent.substring(0, 50);
                summary.aiResponse = llmSummary.aiResponse || '';
            }

            // 获取 history.json 中该 messageId 对应的行号
            if (messageId) {
                const lineNumber = await getHistoryLineNumber(agentId, requestId, messageId);
                if (lineNumber) {
                    summary.historyLine = lineNumber;
                }
            }

            console.log(`[Worldview] 摘要生成完成: userIntent长度=${summary.userIntent.length}, aiResponse长度=${summary.aiResponse.length}`);

            await generator.appendEntry(requestId, summary, agentId);

            const { compressed } = await compressor.compressIfNeeded(
                requestId,
                await generator.getWorldviewContent(requestId),
                await generator.getMeta(requestId)
            );

            if (compressed) {
                console.log(`[Worldview] ${requestId} 文档已压缩`);
            }

            const updatedContent = await generator.getWorldviewContent(requestId);
            worldviewCache.set(requestId, updatedContent);

            markPendingComplete(requestId);

            broadcastUpdate(requestId, 'success');

            if (DEBUG_MODE) {
                console.log(`[Worldview] 完成处理 ${requestId}`);
            }

        } catch (error) {
            console.error(`[Worldview] 处理失败 ${requestId}:`, error.message);
            markPendingComplete(requestId);
            broadcastUpdate(requestId, 'error', error.message);
            throw error;
        }
    });
}

/**
 * 从"当前进行中"区域截掉最近N条条目
 * @param {string} content - 原始世界观文档内容
 * @param {number} stripCount - 要截掉的条目数量
 * @returns {string} - 截断后的内容
 */
function stripRecentEntries(content, stripCount) {
    if (stripCount <= 0 || !content) return content;
    
    // 找到 "## 📌 当前进行中" 区域开始位置
    const activeSectionMarker = '## 📌 当前进行中';
    const activeSectionStart = content.indexOf(activeSectionMarker);
    if (activeSectionStart === -1) return content;
    
    // 找到 "## 🗄️ 已归档" 或文档末尾
    const archiveSectionMarker = '## 🗄️ 已归档';
    const archiveSectionStart = content.indexOf(archiveSectionMarker, activeSectionStart);
    
    // 当前进行中区域内容
    const beforeActive = content.substring(0, activeSectionStart);
    const activeSectionTitle = activeSectionMarker + (content.charAt(activeSectionStart + activeSectionMarker.length) === '\n' ? '\n' : '');
    let activeSectionContent;
    let afterContent = '';
    
    if (archiveSectionStart !== -1) {
        activeSectionContent = content.substring(activeSectionStart + activeSectionTitle.length, archiveSectionStart);
        afterContent = content.substring(archiveSectionStart);
    } else {
        activeSectionContent = content.substring(activeSectionStart + activeSectionTitle.length);
    }
    
    // 找到所有 ### [...] 条目
    const entryRegex = /### \[[^\]]+\][^\n]*\n(?:(?!### \[)[^\n]*\n)*/g;
    const entries = [];
    let match;
    
    while ((match = entryRegex.exec(activeSectionContent)) !== null) {
        entries.push(match[0]);
    }
    
    console.log(`[Worldview] stripRecentEntries: 找到${entries.length}条条目，截断${stripCount}条`);
    
    // 如果条目数量小于等于 stripCount，全部截掉
    if (entries.length <= stripCount) {
        return beforeActive + activeSectionTitle + afterContent;
    }
    
    // 保留前面的条目，截掉后面的
    const keptEntries = entries.slice(0, entries.length - stripCount);
    const keptContent = keptEntries.join('\n');
    
    return beforeActive + activeSectionTitle + keptContent + '\n' + afterContent;
}

async function getWorldviewContent(requestId, options = {}) {
    const { stripRecent = 0 } = options;
    
    if (worldviewCache.has(requestId)) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] getWorldviewContent 从缓存获取: ${requestId}, 长度: ${worldviewCache.get(requestId).length}`);
        }
        let cachedContent = worldviewCache.get(requestId);
        if (stripRecent > 0) {
            cachedContent = stripRecentEntries(cachedContent, stripRecent);
            if (DEBUG_MODE) {
                console.log(`[Worldview] getWorldviewContent 截断后长度: ${cachedContent.length}`);
            }
        }
        return cachedContent;
    }

    if (DEBUG_MODE) {
        console.log(`[Worldview] getWorldviewContent 缓存未命中, 读取文件: ${requestId}`);
    }
    
    let content = await generator.getWorldviewContent(requestId);
    
    if (DEBUG_MODE) {
        console.log(`[Worldview] getWorldviewContent 文件内容长度: ${content.length}, requestId: ${requestId}`);
    }

    // 检查是否有实际摘要内容（不只是 header），如果没有则不注入
    // header 之后应该有 "## 📌 当前进行中" 或 "### [" 这样的摘要标记
    if (!content || !content.includes('### [')) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] getWorldviewContent 无实际摘要内容，跳过注入`);
        }
        return '';  // 返回空，不注入
    }

    const pending = getPendingSummary(requestId);
    if (pending && !pending.completed) {
        const timestamp = new Date(pending.timestamp);
        const dateStr = `${timestamp.getFullYear()}-${String(timestamp.getMonth() + 1).padStart(2, '0')}-${String(timestamp.getDate()).padStart(2, '0')} ${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`;

        const safeUser = pending.userInput || '';
        const safeAi = pending.aiResponse || '';
        
        content += `\n\n### [进行中] ${dateStr}\n`;
        content += `**用户**: ${safeUser.substring(0, 100)}${safeUser.length > 100 ? '...' : ''}\n`;
        content += `**AI**: ${safeAi.substring(0, 100)}${safeAi.length > 100 ? '...' : ''}\n`;
    }

    // 如果需要截断最近条目
    if (stripRecent > 0) {
        const beforeStrip = content.length;
        content = stripRecentEntries(content, stripRecent);
        console.log(`[Worldview] 截断最近${stripRecent}条: ${beforeStrip} -> ${content.length} 字符`);
    }

    return content;
}

function getWorldviewPath(requestId) {
    return generator.getWorldviewPath(requestId);
}

async function getAllTopics() {
    return generator.getAllTopics();
}

async function importTopic(sourceRequestId, targetRequestId) {
    const sourceContent = await generator.getWorldviewContent(sourceRequestId);

    if (!sourceContent) {
        throw new Error(`源话题 ${sourceRequestId} 不存在`);
    }

    return enqueue(targetRequestId, async () => {
        const header = generator.buildHeader(targetRequestId);
        const separator = '\n\n---\n\n### 导入自话题: ' + sourceRequestId + '\n\n';
        const combined = header + separator + sourceContent;

        const targetPath = generator.getWorldviewPath(targetRequestId);
        const fs = require('fs').promises;
        await fs.writeFile(targetPath, combined, 'utf-8');

        worldviewCache.set(targetRequestId, combined);

        broadcastUpdate(targetRequestId, 'imported');

        if (DEBUG_MODE) {
            console.log(`[Worldview] 导入话题 ${sourceRequestId} 到 ${targetRequestId}`);
        }
    });
}

function reloadWorldviewCache(requestId) {
    worldviewCache.delete(requestId);
    if (DEBUG_MODE) {
        console.log(`[Worldview] 清除缓存: ${requestId}`);
    }
}

function broadcastUpdate(requestId, status, errorMessage = null) {
    if (!webSocketServer) {
        if (DEBUG_MODE) {
            console.log(`[Worldview] WebSocketServer 未设置，跳过广播`);
        }
        return;
    }

    webSocketServer.broadcast({
        type: 'worldview_updated',
        data: {
            requestId: requestId,
            status: status,
            message: status === 'success' ? '世界观已更新' :
                     status === 'error' ? `世界观更新失败: ${errorMessage}` :
                     '世界观已导入'
        }
    }, 'VCPLog');
}

async function initialize(_webSocketServer = null) {
    if (_webSocketServer) {
        setWebSocketServer(_webSocketServer);
    }

    if (!ENABLED) {
        console.log(`[Worldview] 对话世界观文档系统已禁用`);
        return;
    }

    const fs = require('fs').promises;
    const worldDir = path.join(process.cwd(), WORLDVIEW_DIR);
    const sessionsDir = path.join(worldDir, '_index', 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(path.join(worldDir, '_archive'), { recursive: true });

    // 设置文件监听器，监听 worldview.md 文件变更
    setupFileWatcher(sessionsDir);

    console.log(`[Worldview] 对话世界观文档系统已初始化`);
    console.log(`[Worldview] 文档目录: ${worldDir}`);
    console.log(`[Worldview] Token限制: ${compressor.TOKEN_LIMIT} (安全水位: ${compressor.SAFETY_BUFFER})`);
}

function setupFileWatcher(sessionsDir) {
    if (fileWatcher) {
        fileWatcher.close();
    }

    fileWatcher = chokidar.watch(sessionsDir, {
        persistent: true,
        ignoreInitial: true,
        depth: 2,
        awaitWriteFinish: {
            stabilityThreshold: 500,
            pollInterval: 100
        }
    });

    fileWatcher.on('change', (filePath) => {
        if (filePath.endsWith('worldview.md')) {
            const sessionId = path.basename(path.dirname(filePath));
            reloadWorldviewCache(sessionId);
            if (DEBUG_MODE) {
                console.log(`[Worldview] 文件变更已刷新缓存: ${sessionId}`);
            }
        }
    });

    fileWatcher.on('add', (filePath) => {
        if (filePath.endsWith('worldview.md')) {
            const sessionId = path.basename(path.dirname(filePath));
            reloadWorldviewCache(sessionId);
            if (DEBUG_MODE) {
                console.log(`[Worldview] 新建文档已刷新缓存: ${sessionId}`);
            }
        }
    });

    if (DEBUG_MODE) {
        console.log(`[Worldview] 文件监听器已启动: ${sessionsDir}`);
    }
}

function closeWatcher() {
    if (fileWatcher) {
        fileWatcher.close();
        fileWatcher = null;
        if (DEBUG_MODE) {
            console.log(`[Worldview] 文件监听器已关闭`);
        }
    }
}

module.exports = {
    initialize,
    closeWatcher,
    onConversationEnd,
    getWorldviewContent,
    getWorldviewPath,
    getAllTopics,
    importTopic,
    reloadWorldviewCache,
    setWebSocketServer,
    pendingSummaries,
    enqueue,
    _setPendingSummary: setPendingSummary,
    _markPendingComplete: markPendingComplete,
    _getPendingSummary: getPendingSummary,
    _queues: queues
};
