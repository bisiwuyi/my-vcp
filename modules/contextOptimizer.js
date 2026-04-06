/**
 * 对话上下文优化器
 * 
 * 功能：从完整消息历史中提取最近 N 轮对话，减少 token 消耗
 * 开启后：只传递最近 N 轮对话 + 系统提示词 + RAG 知识库
 * 关闭后：保持原有完整消息传递
 */

const DEBUG_MODE = process.env.VCP_CONTEXT_OPTIMIZATION_DEBUG === 'true';

const ENABLED = process.env.VCP_CONTEXT_OPTIMIZATION_ENABLED !== 'false';
const DEFAULT_ROUNDS = parseInt(process.env.VCP_CONTEXT_OPTIMIZATION_ROUNDS) || 3;

/**
 * 从完整消息数组中提取最近 N 轮对话
 * 重要：永远保留 System Prompt，只截取 User/Assistant 对话
 * 
 * @param {Array} messages - 原始消息数组
 * @param {number} rounds - 保留轮数，默认3
 * @returns {Array} 截取后的消息数组
 */
function extractRecentRounds(messages, rounds = DEFAULT_ROUNDS) {
    if (!messages || messages.length === 0) {
        return [];
    }
    
    if (DEBUG_MODE) {
        console.log(`[ContextOptimizer] 原始消息数: ${messages.length}, 目标轮数: ${rounds}`);
    }
    
    // 1. 永远保留 System 消息
    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');
    
    if (otherMessages.length === 0) {
        return messages;
    }
    
    // 2. 从后往前找，找到第 N 个 user 消息作为截断点
    let userCount = 0;
    let cutOffIndex = 0;
    
    for (let i = otherMessages.length - 1; i >= 0; i--) {
        if (otherMessages[i].role === 'user') {
            userCount++;
            if (userCount === rounds) {
                cutOffIndex = i;
                break;
            }
        }
    }
    
    // 3. 如果实际轮数不足 rounds，则保留全部；否则从 cutOffIndex 切断
    const recentMessages = userCount >= rounds ? otherMessages.slice(cutOffIndex) : otherMessages;
    
    // 4. 拼装返回：System Prompt + 最近N轮完整对话
    const result = [...systemMessages, ...recentMessages];
    
    if (DEBUG_MODE) {
        console.log(`[ContextOptimizer] 截取后消息数: ${result.length}, 轮数: ${recentMessages.filter(m => m.role === 'user').length}`);
        console.log(`[ContextOptimizer] 保留System消息: ${systemMessages.length}`);
    }
    
    return result;
}

/**
 * 检查上下文优化是否启用
 */
function isEnabled() {
    return ENABLED;
}

/**
 * 获取配置的轮数
 */
function getRounds() {
    return DEFAULT_ROUNDS;
}

module.exports = {
    extractRecentRounds,
    isEnabled,
    getRounds
};
