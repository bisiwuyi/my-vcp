/**
 * Token 计算单例模块
 * 统一管理 tiktoken 编码器，避免多实例重复加载
 */

const DEBUG_MODE = process.env.VCP_WORLDVIEW_DEBUG === 'true';
const TOKEN_ESTIMATE_RATIO = parseFloat(process.env.VCP_WORLDVIEW_TOKEN_ESTIMATE_RATIO || '1.5');

let tiktokenEncoder = null;
let initializationFailed = false;

function initialize() {
    if (tiktokenEncoder || initializationFailed) return;
    
    try {
        const tiktoken = require('@dqbd/tiktoken');
        tiktokenEncoder = tiktoken.encoding_for_model('gpt-3.5-turbo');
        if (DEBUG_MODE) {
            console.log('[TokenCounter] tiktoken 编码器初始化成功');
        }
    } catch (e) {
        initializationFailed = true;
        if (DEBUG_MODE) {
            console.warn('[TokenCounter] tiktoken 加载失败，将使用估算法:', e.message);
        }
    }
}

// 立即初始化
initialize();

/**
 * 计算文本的 Token 数量
 * @param {string} content - 要计算的文本
 * @returns {number} - Token 数量
 */
function estimateTokens(content) {
    if (!content) return 0;
    
    if (tiktokenEncoder) {
        try {
            return tiktokenEncoder.encode(content).length;
        } catch (e) {
            if (DEBUG_MODE) {
                console.warn('[TokenCounter] tiktoken 计算失败，使用估算法:', e.message);
            }
        }
    }
    
    // 回退到估算：字符数 * 估算比率
    return Math.ceil(content.length * TOKEN_ESTIMATE_RATIO);
}

/**
 * 获取编码器实例（供高级用途使用）
 * @returns {object|null} - tiktoken 编码器实例
 */
function getEncoder() {
    return tiktokenEncoder;
}

module.exports = {
    estimateTokens,
    getEncoder
};
