/**
 * 对话世界观文档系统 - LLM摘要生成模块
 * 
 * 负责调用LLM生成对话摘要，包含降级策略（当LLM失败时生成机械摘要）。
 */

const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';

const { estimateTokens } = require('./utils/tokenCounter');

const config = {
    model: process.env.VCP_WORLDVIEW_MODEL || 'gpt-3.5-turbo',
    apiKey: process.env.VCP_WORLDVIEW_LLM_API_KEY || process.env.API_KEY,
    baseURL: process.env.VCP_WORLDVIEW_LLM_BASE_URL || process.env.API_URL || 'https://api.openai.com',
    maxSummaryTokens: 300,
    timeout: 30000
};

const SYSTEM_PROMPT = `你是一个严谨的总结摘要助手。你的任务是从用户与 AI 的最新交互中，精准提取具有长效上下文价值的核心信息，并严格按照模板输出。

### 📋 强制输出模板 (带有(可选)标记的模块若不存在，请直接删除该整行)

**领域标签**: [1-2个核心领域词，如：前端开发、架构设计、闲聊]
**用户意图**: [结合历史上下文，精准描述当前的真实诉求，不超过25字]
**AI答复**:
  - **核心摘要**: [自适应长度概括。若为宏大叙事/长篇文档，提供80-150字包含背景与指标的连贯总结；若为闲聊科普/简短问答，一句话概括核心结论；若为执行工具/代码修改，概括其动作意图。]
  - **关键执行**: [提炼具体的落地动作，如：代码修改(具体函数名)、工具调用(如联网搜索、文件读取)、API请求等。分1-3点列出，每点不超过40字。若完全没有实操动作，此项严格填"无"。]
**(可选) 文件变更**:
  - [操作类型] \`完整文件路径\` (具体函数/行号): [修改的本质逻辑，不超过20字]
**(可选) 避坑与废弃**:
  - [明确被否决的技术方案、不采用的工具或失败的尝试，防止后续重复踩坑]
**(可选) 状态更新**:
  - [ ] 新增待办: [任务描述]
  - [x] 标记完成: [任务描述]
**(可选) 阻塞与追问**:
  - [若 AI 要求补充信息、提供日志或明确拒绝，在此处简要说明]

---

### 🛑 过滤与提取规则 (最高优先级)

1. **静默丢弃 (IGNORE)**：如果输入纯粹是打招呼、语气词、情绪宣泄或空白，**仅输出单词 \`IGNORE\`**，不输出任何其他字符。
2. **拒绝废话与模糊词**：严禁使用"给出了详细解答"、"进行了探讨"等无信息量词汇。必须榨取具体的：**API名称、算法逻辑、架构决定**。
3. **严禁记录任何涉及 dailynote、笔记、日记类文件的变更**（这类动作由系统自动完成，不需记录）。
4. **反向追溯机制**：当用户输入指代不清（如："继续"、"还是报错"），必须结合上下文补全完整意图。

### ⚠️ 输出格式绝对红线
1. **严禁任何开场白或结束语**（如："好的"、"以下是摘要"）。
2. **严禁使用代码块语法包裹输出**（不要在首尾加 \`\`\` 或 \`\`\`markdown）。
3. 你的输出必须以 \`**领域标签**:\` 作为第一个字符开始！`;

function buildPrompt(recentMessages, options = {}) {
    const { isAborted = false } = options;
    
    const formattedMessages = recentMessages
        .map(m => {
            const content = typeof m.content === 'string' ? m.content : '[多模态内容]';
            // AI消息不截断，用户消息限制1000字符
            const truncated = m.role === 'user' ? content.substring(0, 1000) : content;
            return `${m.role === 'user' ? '用户' : 'AI'}: ${truncated}`;
        })
        .join('\n\n');

    let abortWarning = '';
    if (isAborted) {
        abortWarning = '\n\n【系统提示】：此轮对话被用户强行中断，AI未输出完毕。提取结论时请注意：只提取已输出的有效内容，对于未完成的话语不要强行补全或推测结尾。';
    }

    return `请分析以下对话并生成摘要：

${formattedMessages}${abortWarning}

---

请严格按格式输出：`;
}

async function callLLMWithRetry(prompt, maxRetries = 3, baseDelayMs = 2000) {
    if (!config.apiKey) {
        throw new Error('LLM API密钥未配置，请检查 API_Key 或 VCP_WORLDVIEW_LLM_API_KEY');
    }

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
    ];

    const requestBody = {
        model: config.model,
        messages: messages,
        max_tokens: config.maxSummaryTokens,
        temperature: 0.0
    };

    const url = new URL('/v1/chat/completions', config.baseURL);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    async function makeRequest() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`
                },
                timeout: config.timeout
            };

            const req = transport.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.error) {
                            reject(new Error(parsed.error.message || 'LLM API Error'));
                            return;
                        }
                        const content = parsed.choices?.[0]?.message?.content || '';
                        resolve(content);
                    } catch (e) {
                        reject(new Error(`LLM响应解析失败: ${e.message}`));
                    }
                });
            });

            req.on('error', (e) => {
                reject(new Error(`LLM请求失败: ${e.message}`));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('LLM请求超时'));
            });

            req.write(JSON.stringify(requestBody));
            req.end();
        });
    }

    // 带指数退避的重试机制
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = baseDelayMs * Math.pow(2, attempt - 1); // 2s, 4s, 8s
                if (DEBUG_MODE) {
                    console.log(`[WorldviewLLM] 重试第 ${attempt + 1} 次，等待 ${delay}ms`);
                }
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            return await makeRequest();
        } catch (error) {
            lastError = error;
            if (DEBUG_MODE) {
                console.warn(`[WorldviewLLM] 第 ${attempt + 1} 次尝试失败:`, error.message);
            }
            // 如果是业务错误（如 AI 明确拒绝），不重试
            if (error.message.includes('AI未提供') || error.message.includes('API密钥')) {
                throw error;
            }
        }
    }
    throw lastError;
}

function parseSummaryResponse(responseText) {
    const result = {
        domainTag: '',
        userIntent: '',
        aiResponse: '',
        fileChanges: '',
        pitfalls: '',
        statusUpdate: '',
        globalInstruction: '',
        blockers: '',
        ignore: false
    };

    const trimmedText = responseText.trim();

    if (trimmedText === 'IGNORE') {
        result.ignore = true;
        return result;
    }

    const domainTagMatch = trimmedText.match(/\*\*领域标签\*\*[:：]\s*(.+?)(?=\n|$)/i);
    const userIntentMatch = trimmedText.match(/\*\*用户意图\*\*[:：]\s*(.+?)(?=\n|$)/i);
    const aiResponseMatch = trimmedText.match(/\*\*AI答复\*\*[:：]\s*([\s\S]*?)(?=\n(?:\*\*)?\(?\s*可选|##|\n\n|$)/i);
    
    // 高容错正则：兼容 (可选) **字段**: 或 **(可选) 字段**: 或 (可选) 字段**:
    const optionalFieldPattern = (fieldName) => {
        return new RegExp(`(?:\\*\\*)?\\(?\\s*可选\\s*\\)?(?:\\*\\*)?\\s*${fieldName}(?:\\*\\*)?[:：]\\s*([\\s\\S]*?)(?=\\n(?:\\*\\*)?\\(?\\s*可选|##|\\n\\n|$)`, 'i');
    };
    
    const fileChangesMatch = trimmedText.match(optionalFieldPattern('文件变更'));
    const pitfallsMatch = trimmedText.match(optionalFieldPattern('避坑与废弃'));
    const statusUpdateMatch = trimmedText.match(optionalFieldPattern('状态更新'));
    const blockersMatch = trimmedText.match(optionalFieldPattern('阻塞与追问'));
    const globalInstructionMatch = trimmedText.match(optionalFieldPattern('全局指令'));

    if (domainTagMatch) result.domainTag = domainTagMatch[1].trim();
    if (userIntentMatch) result.userIntent = userIntentMatch[1].trim();
    if (aiResponseMatch) result.aiResponse = aiResponseMatch[1].trim();
    if (fileChangesMatch) result.fileChanges = fileChangesMatch[1].trim();
    if (pitfallsMatch) result.pitfalls = pitfallsMatch[1].trim();
    if (statusUpdateMatch) result.statusUpdate = statusUpdateMatch[1].trim();
    if (blockersMatch) result.blockers = blockersMatch[1].trim();
    if (globalInstructionMatch) {
        let instruction = globalInstructionMatch[1].trim();
        // 过滤掉 AI 输出的占位废话
        if (['无', '无。', '暂无', 'None', '暂无。'].includes(instruction)) {
            instruction = '';
        }
        result.globalInstruction = instruction;
    }

    if (!result.userIntent && !result.aiResponse && !result.ignore) {
        result.userIntent = trimmedText.substring(0, 50);
    }

    return result;
}

function generateFallbackSummary(userInput, aiResponse) {
    return {
        userIntent: `[摘要生成失败] ${userInput?.substring(0, 50) || ''}...`,
        aiResponse: aiResponse ? `AI回复: ${aiResponse.substring(0, 50)}...` : '',
        fileChanges: '',
        pitfalls: '',
        statusUpdate: '',
        blockers: '',
        isFallback: true
    };
}

async function generateSummary(messages, options = {}) {
    const { isAborted = false } = options;
    
    const recentMessages = messages.slice(-4);

    if (recentMessages.length === 0) {
        return {
            userIntent: '空对话',
            aiResponse: '',
            fileChanges: '',
            pitfalls: '',
            statusUpdate: '',
            blockers: ''
        };
    }

    const userMessages = recentMessages.filter(m => m.role === 'user');
    const aiMessages = recentMessages.filter(m => m.role === 'assistant');

    const lastUserMsg = userMessages[userMessages.length - 1]?.content || '';
    const lastAiMsg = aiMessages[aiMessages.length - 1]?.content || '';

    try {
        if (DEBUG_MODE) {
            console.log(`[WorldviewLLM] 开始生成摘要，消息数: ${recentMessages.length}, isAborted: ${isAborted}`);
        }

        const prompt = buildPrompt(recentMessages, { isAborted });
        const responseText = await callLLMWithRetry(prompt);
        if (DEBUG_MODE) {
            console.log(`[WorldviewLLM] LLM原始返回:\n${responseText}`);
        }
        const parsed = parseSummaryResponse(responseText);

        if (DEBUG_MODE) {
            console.log(`[WorldviewLLM] 摘要解析结果:`, parsed);
        }

        if (parsed.ignore) {
            if (DEBUG_MODE) {
                console.log(`[WorldviewLLM] 对话被判定为非生产力内容，跳过记录`);
            }
            return {
                domainTag: '',
                userIntent: '',
                aiResponse: '',
                fileChanges: '',
                pitfalls: '',
                statusUpdate: '',
                blockers: '',
                isIgnored: true
            };
        }

        return {
            domainTag: parsed.domainTag || '',
            userIntent: parsed.userIntent || lastUserMsg.substring(0, 50),
            aiResponse: parsed.aiResponse || lastAiMsg.substring(0, 50),
            fileChanges: parsed.fileChanges || '',
            pitfalls: parsed.pitfalls || '',
            statusUpdate: parsed.statusUpdate || '',
            globalInstruction: parsed.globalInstruction || '',
            blockers: parsed.blockers || '',
            isFallback: false
        };
    } catch (error) {
        console.error(`[WorldviewLLM] 摘要生成失败，降级为机械摘要:`, error.message);

        return generateFallbackSummary(lastUserMsg, lastAiMsg);
    }
}

module.exports = {
    generateSummary,
    generateFallbackSummary,
    parseSummaryResponse,
    estimateTokens,
    config
};
