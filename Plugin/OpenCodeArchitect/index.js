/**
 * OpenCodeArchitect - VCP 2.0 自我进化回路桥接器
 * 
 * Ritsu 的职能：诊断系统瓶颈、下达架构指令、分析逻辑可行性、进行最终功能验收
 * OpenCode 的职能：阅读代码上下文、生成 Diff 补丁、执行物理文件写入
 * 
 * 支持多 Agent 多话题管理，每个话题独立的 OpenCode 会话
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const VCPRoot = path.resolve(__dirname, '../../../');
const BACKUP_DIR = path.join(VCPRoot, '.opencode_backups');
const TOPICS_FILE = path.join(VCPRoot, '.opencode_topics.json');

const IS_WINDOWS = process.platform === 'win32';
const OPENCODE_BIN = IS_WINDOWS 
    ? 'opencode.cmd'
    : 'opencode';

const DiffAnalyzer = require('./diff-analyzer');

// 【新增】重试配置
const RETRY_CONFIG = {
    maxAttempts: 3,
    retryInterval: 10000,  // 10秒
    retryableStatuses: ['error', 'timeout']
};

// 【P1-4 新增】标准化错误码定义
const ERROR_CODES = {
    // 命令/参数错误 (1xxx)
    E1001: { category: 'command', message: '未知命令', suggestion: '使用支持的命令：chat, consult, apply, initialize, interrupt, createTopic, listTopics, getTopic, closeTopic, switchTopic' },
    E1002: { category: 'param', message: '参数无效', suggestion: '检查参数类型和格式是否正确' },
    E1003: { category: 'param', message: '缺少必需参数', suggestion: '提供所有必需参数后重试' },
    
    // 文件操作错误 (2xxx)
    E2001: { category: 'file', message: '文件不存在', suggestion: '确认目标文件路径正确' },
    E2002: { category: 'file', message: '备份失败', suggestion: '检查 .opencode_backups 目录权限和磁盘空间' },
    E2003: { category: 'file', message: '回滚失败', suggestion: '手动检查备份文件是否完整' },
    
    // OpenCode 运行时错误 (3xxx)
    E3001: { category: 'runtime', message: 'OpenCode 未安装或不在 PATH 中', suggestion: '运行 opencode --version 确认安装' },
    E3002: { category: 'runtime', message: 'OpenCode 执行超时', suggestion: '增加 timeout 参数，或检查 OpenCode 是否卡住' },
    E3003: { category: 'runtime', message: 'OpenCode 异常退出', suggestion: '检查 OpenCode 日志，查看是否有崩溃' },
    E3004: { category: 'session', message: '会话数据损坏', suggestion: '关闭并重新创建话题' },
    E3005: { category: 'runtime', message: 'OpenCode 执行失败', suggestion: '查看错误详情，或增加 timeout 重试' },
    
    // 安全错误 (4xxx)
    E4001: { category: 'safety', message: '安全检查未通过', suggestion: '查看 safetyReport 中的具体问题' },
    E4002: { category: 'safety', message: '存在安全问题需人工审核', suggestion: '使用 skipSafetyCheck: true 跳过检查（不推荐）' },
    
    // 进程管理错误 (5xxx)
    E5001: { category: 'process', message: '未指定进程 PID', suggestion: '从 chat 响应的 pid 字段获取 PID' },
    E5002: { category: 'process', message: '找不到指定的运行中进程', suggestion: '确认 PID 对应的进程仍在运行' },
    
    // 话题管理错误 (6xxx)
    E6001: { category: 'topic', message: '话题不存在', suggestion: '使用 listTopics 查看可用话题' },
    E6002: { category: 'topic', message: '话题已关闭', suggestion: '使用 createTopic 创建新话题' }
};

// 【P1-4 新增】错误码反向映射（用于未知错误的默认分类）
const ERROR_CATEGORY_DEFAULT = {
    'opencode not found': ERROR_CODES.E3001,
    'timed out': ERROR_CODES.E3002,
    'ENOENT': ERROR_CODES.E2001,
    'session': ERROR_CODES.E3004
};

function getSessionFile(agentId, topicId) {
    return path.join(VCPRoot, `.opencode_session_${agentId}_${topicId}`);
}

class OpenCodeArchitect {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.timeout = options.timeout || 600000;
        this.backupEnabled = options.backupEnabled !== false;
        this.topics = {};
        this.currentAgent = null;
        this.currentTopic = null;
        this.activeProcesses = new Map();  // 【ISSUE #10 FIX】改为实例属性，避免进程追踪泄漏
        // 【P2-1 新增】任务状态追踪
        // taskStates: Map<taskId, { status, pid, agentId, topicId, startTime, pauseTime, progress }>
        this.taskStates = new Map();
        // 【P2-2 新增】分析结果缓存
        // analysisCache: Map<cacheKey, { result, timestamp, ttl, targetFile, query }>
        this.analysisCache = new Map();
        this.cacheTTL = 30 * 60 * 1000;  // 默认30分钟 TTL
        this.loadTopics();
    }
    
    /**
     * 【P1-4 新增】标准化错误格式化
     * 根据错误码返回统一的错误结构
     */
    formatError(errorCode, details = {}) {
        const errorDef = ERROR_CODES[errorCode] || {
            category: 'unknown',
            message: '未知错误',
            suggestion: '查看详细错误信息'
        };
        
        return {
            status: 'error',
            code: errorCode,
            category: errorDef.category,
            message: errorDef.message,
            suggestion: errorDef.suggestion,
            details,
            timestamp: new Date().toISOString()
        };
    }
    
    /**
     * 【P1-4 新增】从错误信息推断错误码
     * 用于将外部错误（如 OpenCode 输出）转换为标准错误码
     */
    inferErrorCode(errorMessage) {
        if (!errorMessage) return 'E3005';
        
        const lowerMsg = errorMessage.toLowerCase();
        
        for (const [pattern, code] of Object.entries(ERROR_CATEGORY_DEFAULT)) {
            if (lowerMsg.includes(pattern.toLowerCase())) {
                return code;
            }
        }
        
        if (lowerMsg.includes('not found') || lowerMsg.includes('不存在')) return 'E2001';
        if (lowerMsg.includes('timeout') || lowerMsg.includes('超时')) return 'E3002';
        if (lowerMsg.includes('enoent')) return 'E2001';
        
        return 'E3005';  // 默认：OpenCode 执行失败
    }
    
    /**
     * 加载话题列表
     */
    loadTopics() {
        try {
            if (fs.existsSync(TOPICS_FILE)) {
                this.topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
                this.logger.info(`[OpenCodeArchitect] Topics loaded: ${Object.keys(this.topics).length} agents`);
            }
        } catch (error) {
            this.logger.error(`[OpenCodeArchitect] Failed to load topics: ${error.message}`);
            this.topics = {};
        }
    }
    
     /**
     * 保存话题列表 - 原子写入
     * 【ISSUE #8 FIX】使用临时文件 + rename 避免多实例并发写入导致文件损坏
     */
    saveTopics() {
        try {
            const data = JSON.stringify(this.topics, null, 2);
            const tmpFile = `${TOPICS_FILE}.tmp.${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
            fs.writeFileSync(tmpFile, data, 'utf8');
            
            if (fs.existsSync(TOPICS_FILE)) {
                fs.unlinkSync(TOPICS_FILE);
            }
            fs.renameSync(tmpFile, TOPICS_FILE);
        } catch (error) {
            this.logger.error(`[OpenCodeArchitect] Failed to save topics: ${error.message}`);
        }
    }
    
    /**
     * 创建新话题
     */
    createTopic(agentId, title = null) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!this.topics[agentId]) {
            this.topics[agentId] = {};
        }
        
        const topicId = `topic-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const topicTitle = title || `话题-${Object.keys(this.topics[agentId]).length + 1}`;
        
        this.topics[agentId][topicId] = {
            sessionId: null,
            sessionTitle: null,
            title: topicTitle,
            summary: '',
            status: 'active',
            messageCount: 0,
            createdAt: Date.now(),
            lastActive: Date.now()
        };
        
        this.saveTopics();
        
        return {
            topicId,
            title: topicTitle
        };
    }
    
    /**
     * 获取话题列表
     */
    listTopics(agentId) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!this.topics[agentId]) {
            return [];
        }
        
        return Object.entries(this.topics[agentId])
            .map(([topicId, topic]) => ({
                topicId,
                title: topic.title,
                summary: topic.summary,
                status: topic.status,
                messageCount: topic.messageCount,
                createdAt: topic.createdAt,
                lastActive: topic.lastActive
            }))
            .sort((a, b) => b.lastActive - a.lastActive);
    }
    
    /**
     * 获取指定话题
     */
    getTopic(agentId, topicId) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!this.topics[agentId] || !this.topics[agentId][topicId]) {
            return null;
        }
        
        return {
            topicId,
            ...this.topics[agentId][topicId]
        };
    }
    
    /**
     * 更新话题
     */
    updateTopic(agentId, topicId, updates) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!this.topics[agentId] || !this.topics[agentId][topicId]) {
            return false;
        }
        
        Object.assign(this.topics[agentId][topicId], updates);
        this.topics[agentId][topicId].lastActive = Date.now();
        this.saveTopics();
        return true;
    }
    
    /**
     * 关闭话题
     */
    closeTopic(agentId, topicId) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!this.topics[agentId] || !this.topics[agentId][topicId]) {
            return { success: false, message: '话题不存在' };
        }
        
        const topic = this.topics[agentId][topicId];
        topic.status = 'closed';
        
        try {
            const sessionFile = getSessionFile(agentId, topicId);
            if (fs.existsSync(sessionFile)) {
                fs.unlinkSync(sessionFile);
            }
        } catch (error) {
            this.logger.warn(`[OpenCodeArchitect] Failed to delete session file: ${error.message}`);
        }
        
        this.saveTopics();
        
        return {
            success: true,
            message: `话题 "${topic.title}" 已关闭`
        };
    }
    
    /**
     * 获取当前话题上下文
     */
    getCurrentContext(agentId, topicId = null) {
        if (!agentId || typeof agentId !== 'string') {
            agentId = 'default';
        }
        if (!topicId) {
            const topics = this.listTopics(agentId);
            const activeTopics = topics.filter(t => t.status === 'active');
            if (activeTopics.length === 0) {
                const newTopic = this.createTopic(agentId);
                return { topicId: newTopic.topicId, title: newTopic.title, isNew: true };
            }
            const latestTopic = activeTopics[0];
            return { topicId: latestTopic.topicId, title: latestTopic.title, isNew: false };
        }
        
        const topic = this.getTopic(agentId, topicId);
        if (!topic) {
            const newTopic = this.createTopic(agentId);
            return { topicId: newTopic.topicId, title: newTopic.title, isNew: true };
        }
        
        if (topic.status === 'closed') {
            const newTopic = this.createTopic(agentId);
            return { topicId: newTopic.topicId, title: newTopic.title, isNew: true };
        }
        
        return { topicId, title: topic.title, isNew: false };
    }
    
    /**
     * 检查 opencode CLI 是否可用
     */
    async checkEnvironment() {
        return new Promise((resolve) => {
            exec(`"${OPENCODE_BIN}" --version`, (error, stdout, stderr) => {
                if (error) {
                    resolve({ status: 'error', available: false, error: error.message });
                } else {
                    const version = (stdout || stderr).trim().split('\n').pop();
                    resolve({ status: 'success', available: true, version });
                }
            });
        });
    }
    
    /**
     * 创建备份
     */
    createBackup(filePath) {
        if (!this.backupEnabled) return null;
        
        try {
            if (!fs.existsSync(BACKUP_DIR)) {
                fs.mkdirSync(BACKUP_DIR, { recursive: true });
            }
            
            const timestamp = Date.now();
            const backupPath = path.join(BACKUP_DIR, `${path.basename(filePath)}.${timestamp}.bak`);
            
            if (fs.existsSync(filePath)) {
                fs.copyFileSync(filePath, backupPath);
                this.logger.info(`[OpenCodeArchitect] Backup created: ${backupPath}`);
                return backupPath;
            }
        } catch (error) {
            this.logger.error(`[OpenCodeArchitect] Backup failed: ${error.message}`);
        }
        return null;
    }
    
    /**
     * 回滚到备份
     */
    rollback(backupPath, targetPath) {
        try {
            if (fs.existsSync(backupPath)) {
                fs.copyFileSync(backupPath, targetPath);
                this.logger.info(`[OpenCodeArchitect] Rolled back: ${targetPath}`);
                return true;
            }
        } catch (error) {
            this.logger.error(`[OpenCodeArchitect] Rollback failed: ${error.message}`);
        }
        return false;
    }
    
    /**
     * 清理进程资源
     */
    cleanupProcess(proc) {
        try {
            proc.stdout.destroy();
            proc.stderr.destroy();
            proc.stdin.destroy();
        } catch (e) {}
    }
    
    /**
     * 终止进程树（Windows 兼容）
     */
    killProcessTree(proc) {
        this.cleanupProcess(proc);
        if (IS_WINDOWS) {
            exec(`taskkill /PID ${proc.pid} /T /F`, (error) => {});
        } else {
            try {
                process.kill(-proc.pid, 'SIGTERM');
            } catch (e) {
                proc.kill('SIGTERM');
            }
        }
    }
    
    /**
     * 调用 OpenCode - 单次执行
     */
    _callOpenCodeOnce(message, options = {}) {
        const { targetPath = VCPRoot, timeout = this.timeout, sessionId = null } = options;
        
        return new Promise((resolve) => {
            const args = ['run', message, '--format', 'json'];
            
            if (sessionId) {
                args.push('--continue', sessionId);
            }
            
            this.logger.info(`[OpenCodeArchitect] Executing: opencode ${args.join(' ')}`);
            
            const startTime = Date.now();
            
            const proc = spawn(OPENCODE_BIN, args, {
                cwd: targetPath,
                shell: IS_WINDOWS ? 'cmd.exe' : '/bin/sh',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            proc.stdin.end();
            
            let stdout = '';
            let stderr = '';
            let resolved = false;
            
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.killProcessTree(proc);
                    resolve({
                        status: 'timeout',
                        output: 'Operation timed out',
                        duration: timeout
                    });
                }
            }, timeout);
            
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            proc.on('close', (code) => {
                clearTimeout(timeoutId);
                if (resolved) return;
                resolved = true;
                
                this.cleanupProcess(proc);
                const duration = Date.now() - startTime;
                
                let parsedOutput = null;
                try {
                    const lines = stdout.split('\n').filter(l => l.trim());
                    for (const line of lines) {
                        try {
                            parsedOutput = JSON.parse(line);
                            break;
                        } catch {}
                    }
                } catch {}
                
                resolve({
                    status: code === 0 ? 'success' : 'error',
                    output: stdout || stderr,
                    parsed: parsedOutput,
                    code,
                    duration
                });
            });
            
            proc.on('error', (error) => {
                clearTimeout(timeoutId);
                if (!resolved) {
                    resolved = true;
                    this.cleanupProcess(proc);
                    resolve({
                        status: 'error',
                        output: error.message,
                        duration: Date.now() - startTime
                    });
                }
            });
        });
    }
    
    /**
     * 调用 OpenCode - 带自动重试
     * 【BUG FIX #4】添加自动重试机制，解决偶发错误导致任务中断的问题
     */
    async callOpenCode(message, options = {}) {
        const { targetPath = VCPRoot, timeout = this.timeout, sessionId = null } = options;
        
        let lastError = null;
        
        for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
            try {
                const result = await this._callOpenCodeOnce(message, { targetPath, timeout, sessionId });
                
                if (result.status === 'success' || !RETRY_CONFIG.retryableStatuses.includes(result.status)) {
                    return result;
                }
                
                lastError = result;
                this.logger.warn(`[OpenCodeArchitect] Attempt ${attempt}/${RETRY_CONFIG.maxAttempts} failed: ${result.status} - ${result.output?.substring(0, 100) || 'no output'}`);
                
                if (attempt < RETRY_CONFIG.maxAttempts) {
                    this.logger.info(`[OpenCodeArchitect] Retrying in ${RETRY_CONFIG.retryInterval / 1000}s...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryInterval));
                }
            } catch (err) {
                lastError = { status: 'error', output: err.message, duration: 0 };
                this.logger.error(`[OpenCodeArchitect] Attempt ${attempt} exception: ${err.message}`);
            }
        }
        
        // 所有重试都失败
        this.logger.error(`[OpenCodeArchitect] All ${RETRY_CONFIG.maxAttempts} attempts failed`);
        return {
            ...lastError,
            retryAttempts: RETRY_CONFIG.maxAttempts,
            message: `执行失败，已重试 ${RETRY_CONFIG.maxAttempts} 次，最后错误：${lastError?.output || '未知错误'}`
        };
    }
    
    /**
     * consult - 专家咨询模式
     * 只读分析，返回报告和 Diff 预览，不改动物理文件
     */
    async consult(query, targetFile) {
        const targetPath = path.join(VCPRoot, targetFile);
        const workingDir = path.dirname(targetPath);
        
        if (!fs.existsSync(targetPath)) {
            // 【P1-4 改进】使用标准化错误
            return {
                ...this.formatError('E2001', { targetFile, operation: 'consult' }),
                report: `Target file not found: ${targetFile}`,
                issues: ['FILE_NOT_FOUND']
            };
        }
        
        // 【P2-2 新增】检查缓存
        const cacheKey = this.getAnalysisCacheKey('consult', targetFile, query);
        const cached = this.getCachedResult(cacheKey);
        if (cached) {
            this.logger.info(`[OpenCodeArchitect] Cache hit for ${cacheKey}`);
            return {
                ...cached,
                cached: true,
                cacheAge: Date.now() - cached.timestamp
            };
        }
        
        const normalizedPath = targetFile.replace(/\\/g, '/');
        const fullQuery = query 
            ? `${query}\n\nPlease analyze the file: ${normalizedPath}`
            : `Analyze this file and identify any bugs, issues, or improvement suggestions: ${normalizedPath}`;
        const result = await this.callOpenCode(fullQuery, { targetPath: workingDir });
        
        // 【P1-4 改进】如果 callOpenCode 失败，使用标准化错误
        if (result.status !== 'success') {
            const errorCode = this.inferErrorCode(result.output || result.message);
            return {
                ...this.formatError(errorCode, { 
                    targetFile, 
                    operation: 'consult',
                    retryAttempts: result.retryAttempts 
                }),
                report: result.output || result.message || '分析执行失败',
                duration: result.duration
            };
        }
        
        const analyzer = new DiffAnalyzer();
        const analysis = analyzer.analyze(result.output);
        
        const response = {
            status: 'success',
            report: result.output,
            diff: result.output || '',
            safetyScore: analysis.safetyScore,
            issues: analysis.issues,
            safetyStatus: analysis.status,
            analysisStatus: 'success',
            duration: result.duration,
            timestamp: Date.now()
        };
        
        // 【P2-2 新增】缓存结果
        this.setCachedResult(cacheKey, response, { targetFile, query });
        
        return response;
    }
    
    /**
     * 【P2-2 新增】生成分析缓存键
     */
    getAnalysisCacheKey(type, targetFile, query) {
        const fileStat = fs.statSync(path.join(VCPRoot, targetFile));
        const fileMtime = fileStat.mtimeMs;
        const normalizedPath = targetFile.replace(/\\/g, '/').toLowerCase();
        const queryHash = query ? require('crypto').createHash('md5').update(query).digest('hex').substring(0, 8) : 'noquery';
        return `${type}:${normalizedPath}:${fileMtime}:${queryHash}`;
    }
    
    /**
     * 【P2-2 新增】获取缓存结果
     */
    getCachedResult(cacheKey) {
        const cached = this.analysisCache.get(cacheKey);
        if (!cached) return null;
        
        // 检查 TTL
        if (Date.now() - cached.timestamp > this.cacheTTL) {
            this.analysisCache.delete(cacheKey);
            return null;
        }
        
        return cached.result;
    }
    
    /**
     * 【P2-2 新增】设置缓存结果
     */
    setCachedResult(cacheKey, result, metadata = {}) {
        this.analysisCache.set(cacheKey, {
            result,
            timestamp: Date.now(),
            metadata
        });
    }
    
    /**
     * 【P2-2 新增】清除缓存
     */
    clearCache(targetFile = null) {
        if (targetFile) {
            const prefix = targetFile.replace(/\\/g, '/').toLowerCase();
            for (const key of this.analysisCache.keys()) {
                if (key.includes(prefix)) {
                    this.analysisCache.delete(key);
                }
            }
            this.logger.info(`[OpenCodeArchitect] Cache cleared for ${targetFile}`);
        } else {
            this.analysisCache.clear();
            this.logger.info(`[OpenCodeArchitect] All analysis cache cleared`);
        }
    }
    
    /**
     * 【P2-3 新增】导出报告为多格式
     * @param {Object} data - 要导出的数据（consult/apply 的结果）
     * @param {string} format - 导出格式：json, markdown, text
     * @param {Object} options - 导出选项
     */
    exportReport(data, format = 'json', options = {}) {
        const { filename = 'report', includeMetadata = true } = options;
        
        switch (format.toLowerCase()) {
            case 'markdown':
            case 'md':
                return this.exportAsMarkdown(data, filename, includeMetadata);
            case 'text':
            case 'txt':
                return this.exportAsText(data, filename, includeMetadata);
            case 'json':
            default:
                return this.exportAsJSON(data, filename, includeMetadata);
        }
    }
    
    /**
     * 【P2-3 新增】导出为 JSON 格式
     */
    exportAsJSON(data, filename, includeMetadata) {
        const result = includeMetadata ? {
            exportedAt: new Date().toISOString(),
            format: 'json',
            data
        } : data;
        
        return {
            filename: `${filename}.json`,
            content: JSON.stringify(result, null, 2),
            mimeType: 'application/json'
        };
    }
    
    /**
     * 【P2-3 新增】导出为 Markdown 格式
     */
    exportAsMarkdown(data, filename, includeMetadata) {
        const lines = [];
        
        if (includeMetadata) {
            lines.push(`# 分析报告`);
            lines.push('');
            lines.push(`**导出时间**: ${new Date().toLocaleString()}`);
            lines.push('');
            lines.push('---');
            lines.push('');
        }
        
        if (data.report) {
            lines.push('## 报告内容');
            lines.push('');
            lines.push(data.report);
            lines.push('');
        }
        
        if (data.issues && data.issues.length > 0) {
            lines.push('## 发现的问题');
            lines.push('');
            for (const issue of data.issues) {
                lines.push(`- **[${issue.severity?.toUpperCase() || 'INFO'}]** ${issue.description || issue}`);
                if (issue.suggestion) {
                    lines.push(`  - 建议: ${issue.suggestion}`);
                }
            }
            lines.push('');
        }
        
        if (data.safetyScore !== undefined) {
            lines.push(`**安全评分**: ${(data.safetyScore * 100).toFixed(1)}%`);
            lines.push('');
        }
        
        if (data.duration) {
            lines.push(`**耗时**: ${data.duration}ms`);
            lines.push('');
        }
        
        return {
            filename: `${filename}.md`,
            content: lines.join('\n'),
            mimeType: 'text/markdown'
        };
    }
    
    /**
     * 【P2-3 新增】导出为纯文本格式
     */
    exportAsText(data, filename, includeMetadata) {
        const lines = [];
        
        if (includeMetadata) {
            lines.push('========================================');
            lines.push('          分析报告');
            lines.push('========================================');
            lines.push(`导出时间: ${new Date().toLocaleString()}`);
            lines.push('');
        }
        
        if (data.report) {
            lines.push('-------- 报告内容 --------');
            lines.push(data.report);
            lines.push('');
        }
        
        if (data.issues && data.issues.length > 0) {
            lines.push('-------- 发现的问题 --------');
            for (const issue of data.issues) {
                lines.push(`[${issue.severity?.toUpperCase() || 'INFO'}] ${issue.description || issue}`);
                if (issue.suggestion) {
                    lines.push(`  -> ${issue.suggestion}`);
                }
            }
            lines.push('');
        }
        
        if (data.safetyScore !== undefined) {
            lines.push(`安全评分: ${(data.safetyScore * 100).toFixed(1)}%`);
        }
        
        if (data.duration) {
            lines.push(`耗时: ${data.duration}ms`);
        }
        
        return {
            filename: `${filename}.txt`,
            content: lines.join('\n'),
            mimeType: 'text/plain'
        };
    }
    
    /**
     * apply - 物理进化模式
     * 在执行前进行安全分析，使用 DiffAnalyzer 检查风险
     */
    async apply(query, targetFile, options = {}) {
        const targetPath = path.join(VCPRoot, targetFile);
        const workingDir = path.dirname(targetPath);
        const autoBackup = options.autoBackup === undefined || options.autoBackup === 'true' || options.autoBackup === true;
        const skipSafetyCheck = options.skipSafetyCheck === true;
        
        if (!fs.existsSync(targetPath)) {
            // 【P1-4 改进】使用标准化错误
            return {
                ...this.formatError('E2001', { targetFile, operation: 'apply' }),
                filesModified: []
            };
        }
        
        let backupPath = null;
        if (autoBackup) {
            backupPath = this.createBackup(targetPath);
        }
        
        const normalizedPath = targetFile.replace(/\\/g, '/');
        const fullQuery = `Apply the following changes to ${normalizedPath}: ${query}`;
        const result = await this.callOpenCode(fullQuery, { targetPath: workingDir });
        
        // 【P1-4 改进】处理 OpenCode 执行失败
        if (result.status !== 'success') {
            const errorCode = this.inferErrorCode(result.output || result.message);
            const response = {
                ...this.formatError(errorCode, { 
                    targetFile, 
                    operation: 'apply',
                    retryAttempts: result.retryAttempts 
                }),
                filesModified: [],
                rollbackAvailable: backupPath !== null,
                duration: result.duration
            };
            
            // 自动回滚
            if (backupPath) {
                this.rollback(backupPath, targetPath);
                response.rolledBack = true;
            }
            
            return response;
        }
        
        const response = {
            status: 'success',
            filesModified: [targetFile],
            commitLog: result.output,
            rollbackAvailable: backupPath !== null,
            duration: result.duration
        };
        
        if (result.output) {
            const analyzer = new DiffAnalyzer({ strictMode: true });
            const analysis = analyzer.analyze(result.output);
            
            response.safetyReport = {
                safetyScore: analysis.safetyScore,
                status: analysis.status,
                issues: analysis.issues,
                summary: analysis.summary
            };
            
            if (analysis.status === 'rejected') {
                this.logger.warn(`[OpenCodeArchitect] Safety check rejected: ${analysis.summary}`);
                if (backupPath) {
                    this.rollback(backupPath, targetPath);
                    return {
                        ...this.formatError('E4001', { targetFile, operation: 'apply', analysisIssues: analysis.issues }),
                        filesModified: [],
                        rollbackAvailable: false,
                        safetyReport: response.safetyReport
                    };
                }
            }
            
            if (analysis.status === 'needs_review' && !skipSafetyCheck) {
                return {
                    ...this.formatError('E4002', { targetFile, operation: 'apply', analysisIssues: analysis.issues }),
                    filesModified: [targetFile],
                    safetyReport: response.safetyReport
                };
            }
        }
        
        return response;
    }
    
    /**
     * initialize - 知识同步
     */
    async initialize(vcpPath = VCPRoot) {
        const result = await this.callOpenCode(
            'Analyze the VCP system structure and summarize the architecture. Count the total number of key files (.js, .json, .md) and provide a summary.',
            { targetPath: vcpPath }
        );
        
        let indexedFiles = 0;
        if (result.output) {
            const match = result.output.match(/(\d+)\s+(?:个|files?|key files?)/i);
            if (match) {
                indexedFiles = parseInt(match[1], 10);
            }
        }
        
        return {
            status: result.status,
            agentsMd: result.output,
            indexedFiles: indexedFiles,
            duration: result.duration
        };
    }
    
    /**
     * chat - 对话模式
     * 与 OpenCode LLM 对话，获取最后总结回答
     * 支持多 Agent 多话题，每个话题独立的 OpenCode 会话
     * 
     * 【P1-3 新增】onProgress 回调：长任务每15秒返回进度状态
     */
    async chat(message, options = {}) {
        // 【P1-5 改进】timeout 参数类型转换和范围限制
        let inputTimeout = this.timeout;
        if (typeof options.timeout === 'number') {
            inputTimeout = options.timeout;
        } else if (typeof options.timeout === 'string') {
            inputTimeout = parseInt(options.timeout, 10) || this.timeout;
        }
        // 限制范围：30秒 ~ 10分钟
        const timeout = Math.max(30000, Math.min(inputTimeout, 600000));
        
        const { agentId = 'default', topicId = null, title = null, onProgress = null } = options;
        
        // 【BUG FIX #1】如果提供了 title，强制创建新话题（会话隔离）
        // 修复：之前 title 只更新话题标题，不会创建新会话，导致上下文污染
        let context;
        if (title) {
            const newTopic = this.createTopic(agentId, title);
            context = { topicId: newTopic.topicId, title: newTopic.title, isNew: true };
        } else {
            context = this.getCurrentContext(agentId, topicId);
        }
        
        const actualTopicId = context.topicId;
        const isNewTopic = context.isNew;
        
        let sessionId = null;
        if (!isNewTopic && this.topics[agentId] && this.topics[agentId][actualTopicId]) {
            sessionId = this.topics[agentId][actualTopicId].sessionId;
        }
        
        const args = ['run', message, '--format', 'json'];
        if (sessionId) {
            args.push('--continue', sessionId);
        }
        
        // 【P1-3 新增】进度阶段检测
        const PROGRESS_INTERVAL = 15000;  // 15秒
        const progressStages = ['初始化', '分析中', '生成报告', '完成'];
        let currentStage = 0;
        let lastProgressReport = 0;
        
        const reportProgress = (stage, extra = {}) => {
            if (onProgress && typeof onProgress === 'function') {
                const elapsed = Date.now() - startTime;
                onProgress({
                    stage,
                    stageIndex: currentStage,
                    elapsed,
                    topicId: actualTopicId,
                    pid,
                    ...extra
                });
            }
        };
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            const proc = spawn(OPENCODE_BIN, args, {
                cwd: VCPRoot,
                shell: IS_WINDOWS ? 'cmd.exe' : '/bin/sh',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            const pid = proc.pid;
            this.activeProcesses.set(pid, proc);
            
            // 【P2-1 新增】注册任务状态
            const taskId = `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
            this.taskStates.set(taskId, {
                taskId,
                status: 'running',
                pid,
                agentId,
                topicId: actualTopicId,
                startTime: Date.now(),
                pauseTime: null,
                progress: { stage: '初始化', stageIndex: 0 }
            });
            
            proc.stdin.end();
            
            let stdout = '';
            let stderr = '';
            let resolved = false;
            
            // 【P1-3 新增】进度定时器
            const progressTimer = setInterval(() => {
                if (!resolved && Date.now() - lastProgressReport >= PROGRESS_INTERVAL) {
                    lastProgressReport = Date.now();
                    const stage = progressStages[Math.min(currentStage, progressStages.length - 1)];
                    reportProgress(stage, { type: 'periodic' });
                }
            }, 5000);  // 每5秒检查一次
            
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    clearInterval(progressTimer);
                    this.killProcessTree(proc);
                    this.activeProcesses.delete(pid);
                    
                    // 【P2-1 新增】更新任务状态为超时
                    const taskState = this.taskStates.get(taskId);
                    if (taskState) {
                        taskState.status = 'timeout';
                        taskState.endTime = Date.now();
                    }
                    
                    reportProgress('超时终止');
                    resolve({
                        status: 'timeout',
                        answer: '对话超时，已终止',
                        duration: timeout,
                        topicId: actualTopicId,
                        title: context.title
                    });
                }
            }, timeout);
            
            proc.stdout.on('data', (data) => {
                stdout += data.toString();
                
                // 【P1-3 新增】基于关键词的进度检测
                const lowerStdout = stdout.toLowerCase();
                if (lowerStdout.includes('reading') || lowerStdout.includes('loading') || lowerStdout.includes('初始化')) {
                    if (currentStage < 1) { currentStage = 1; reportProgress(progressStages[1], { type: 'keyword' }); }
                }
                if (lowerStdout.includes('analyzing') || lowerStdout.includes('分析') || lowerStdout.includes('processing')) {
                    if (currentStage < 2) { currentStage = 2; reportProgress(progressStages[2], { type: 'keyword' }); }
                }
                if (lowerStdout.includes('generating') || lowerStdout.includes('writing') || lowerStdout.includes('生成')) {
                    if (currentStage < 3) { currentStage = 3; reportProgress(progressStages[3], { type: 'keyword' }); }
                }
            });
            
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            proc.on('close', (code) => {
                if (resolved) return;
                resolved = true;
                clearInterval(progressTimer);
                clearTimeout(timeoutId);
                this.activeProcesses.delete(pid);
                this.cleanupProcess(proc);
                
                // 【P2-1 新增】更新任务状态为完成
                const taskState = this.taskStates.get(taskId);
                if (taskState) {
                    taskState.status = code === 0 ? 'completed' : 'failed';
                    taskState.endTime = Date.now();
                    taskState.exitCode = code;
                }
                
                // 【P1-6 新增】残留报错过滤：检查话题是否已被关闭
                const topicData = this.topics[agentId]?.[actualTopicId];
                if (topicData && topicData.status === 'closed') {
                    this.logger.info(`[OpenCodeArchitect] Filtering response for closed topic ${actualTopicId}`);
                    reportProgress('已过滤', { type: 'filtered', reason: 'topic_closed' });
                    resolve({
                        status: 'filtered',
                        answer: null,
                        message: '该话题已关闭，忽略残留响应',
                        topicId: actualTopicId,
                        duration: Date.now() - startTime
                    });
                    return;
                }
                
                // 【P1-3 新增】完成时报告最终进度
                reportProgress(progressStages[3], { type: 'complete', code });
                
                const duration = Date.now() - startTime;
                
                const lines = stdout.split('\n').filter(l => l.trim());
                let lastText = '';
                let extractedSessionId = null;
                
                for (const line of lines) {
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.type === 'text' && parsed.part?.text) {
                            lastText = parsed.part.text;
                        }
                        if (parsed.sessionID && !extractedSessionId) {
                            extractedSessionId = parsed.sessionID;
                        }
                    } catch {
                        if (line.length > 20 && !line.startsWith('{')) {
                            lastText = line;
                        }
                    }
                }
                
                if (!lastText && stderr) {
                    lastText = stderr;
                }
                
                if (code === 0) {
                    // topicData 已在上面定义并检查过，此处复用
                    if (topicData) {
                        const updates = {
                            messageCount: (topicData.messageCount || 0) + 1,
                            lastActive: Date.now()
                        };
                        
                        // 【BUG FIX #3】始终保存 sessionId，不只是新话题时
                        // 修复：之前只在 isNewTopic 时保存，导致复用话题时 sessionId 丢失，无法恢复会话
                        if (extractedSessionId) {
                            updates.sessionId = extractedSessionId;
                        }
                        
                        // 【BUG FIX #1 延续】title 已在入口处强制创建新话题，但此处仍保留更新标题的逻辑以防万一
                        if (title) {
                            updates.title = title;
                        }
                        
                        this.updateTopic(agentId, actualTopicId, updates);
                    }
                }
                
                resolve({
                    status: code === 0 ? 'success' : 'error',
                    answer: lastText || '未收到回复',
                    duration,
                    pid,
                    topicId: actualTopicId,
                    title: context.title,
                    isNewTopic,
                    // 【P2-4 新增】资源占用监控
                    resourceUsage: {
                        startTime,
                        endTime: Date.now(),
                        memoryUsage: process.memoryUsage(),
                        cpuUsage: process.cpuUsage()
                    }
                });
            });
            
            proc.on('error', (error) => {
                if (resolved) return;
                resolved = true;
                clearInterval(progressTimer);
                clearTimeout(timeoutId);
                this.activeProcesses.delete(pid);
                this.cleanupProcess(proc);
                
                // 【P2-1 新增】更新任务状态为错误
                const taskState = this.taskStates.get(taskId);
                if (taskState) {
                    taskState.status = 'error';
                    taskState.endTime = Date.now();
                    taskState.errorMessage = error.message;
                }
                
                reportProgress('错误', { type: 'error', error: error.message });
                resolve({
                    status: 'error',
                    answer: error.message,
                    duration: Date.now() - startTime,
                    topicId: actualTopicId,
                    title: context.title,
                    // 【P2-4 新增】资源占用监控
                    resourceUsage: {
                        startTime,
                        endTime: Date.now(),
                        memoryUsage: process.memoryUsage(),
                        cpuUsage: process.cpuUsage()
                    }
                });
            });
        });
    }
    
    /**
     * interrupt - 中断模式
     * 【ISSUE #10 FIX】使用实例属性 this.activeProcesses，不再需要参数传递
     */
    interrupt(pid) {
        if (!pid) {
            // 【P1-4 改进】使用标准化错误码 E5001
            return this.formatError('E5001');
        }
        
        const proc = this.activeProcesses.get(pid);
        if (!proc) {
            // 【P1-4 改进】使用标准化错误码 E5002
            return {
                ...this.formatError('E5002', { pid }),
                message: `找不到 PID 为 ${pid} 的运行中进程`
            };
        }
        
        this.killProcessTree(proc);
        this.activeProcesses.delete(pid);
        
        return { 
            status: 'success', 
            message: `已终止 PID 为 ${pid} 的 OpenCode 进程` 
        };
    }
    
    /**
     * 【P2-1 新增】pauseTask - 暂停任务
     * 通过向进程发送 SIGSTOP 信号暂停进程（Linux/Mac）
     * Windows 不支持 SIGSTOP，使用 job object 控制
     */
    pauseTask(identifier) {
        // identifier 可以是 taskId 或 pid
        let targetProc = null;
        let targetTaskId = null;
        const idStr = String(identifier);
        
        // 先尝试按 taskId 查找
        if (idStr.startsWith('task-')) {
            const taskState = this.taskStates.get(idStr);
            if (taskState) {
                targetProc = this.activeProcesses.get(taskState.pid);
                targetTaskId = idStr;
            }
        }
        
        // 再尝试按 pid 查找
        if (!targetProc && typeof identifier === 'number') {
            targetProc = this.activeProcesses.get(identifier);
            // 找到对应的 taskId
            for (const [taskId, state] of this.taskStates) {
                if (state.pid === identifier) {
                    targetTaskId = taskId;
                    break;
                }
            }
        }
        
        if (!targetProc) {
            return {
                status: 'error',
                message: `找不到指定的任务或进程`
            };
        }
        
        const taskState = this.taskStates.get(targetTaskId);
        if (taskState && taskState.status === 'paused') {
            return {
                status: 'error',
                message: `任务 ${targetTaskId} 已经是暂停状态`
            };
        }
        
        try {
            if (IS_WINDOWS) {
                // Windows: 使用 pauseResumeChildProcess 或通过 PID 暂停
                exec(`powershell -Command "Suspend-Process -Id ${targetProc.pid}"`, (err) => {
                    if (err) {
                        this.logger.warn(`[OpenCodeArchitect] Windows pause failed: ${err.message}`);
                    }
                });
            } else {
                // Unix: 发送 SIGSTOP
                process.kill(targetProc.pid, 'SIGSTOP');
            }
            
            if (taskState) {
                taskState.status = 'paused';
                taskState.pauseTime = Date.now();
            }
            
            return {
                status: 'success',
                message: `已暂停任务 ${targetTaskId || targetProc.pid}`,
                taskId: targetTaskId,
                pid: targetProc.pid
            };
        } catch (error) {
            return {
                status: 'error',
                message: `暂停失败: ${error.message}`
            };
        }
    }
    
    /**
     * 【P2-1 新增】resumeTask - 恢复任务
     */
    resumeTask(identifier) {
        let targetProc = null;
        let targetTaskId = null;
        const idStr = String(identifier);
        
        if (idStr.startsWith('task-')) {
            const taskState = this.taskStates.get(idStr);
            if (taskState) {
                targetProc = this.activeProcesses.get(taskState.pid);
                targetTaskId = idStr;
            }
        }
        
        if (!targetProc && typeof identifier === 'number') {
            targetProc = this.activeProcesses.get(identifier);
            for (const [taskId, state] of this.taskStates) {
                if (state.pid === identifier) {
                    targetTaskId = taskId;
                    break;
                }
            }
        }
        
        if (!targetProc) {
            return {
                status: 'error',
                message: `找不到指定的任务或进程`
            };
        }
        
        const taskState = this.taskStates.get(targetTaskId);
        if (taskState && taskState.status !== 'paused') {
            return {
                status: 'error',
                message: `任务 ${targetTaskId} 不是暂停状态，无法恢复`
            };
        }
        
        try {
            if (IS_WINDOWS) {
                exec(`powershell -Command "Resume-Process -Id ${targetProc.pid}"`, (err) => {
                    if (err) {
                        this.logger.warn(`[OpenCodeArchitect] Windows resume failed: ${err.message}`);
                    }
                });
            } else {
                process.kill(targetProc.pid, 'SIGCONT');
            }
            
            if (taskState) {
                const pausedDuration = Date.now() - taskState.pauseTime;
                taskState.status = 'running';
                taskState.pauseTime = null;
                taskState.totalPausedTime = (taskState.totalPausedTime || 0) + pausedDuration;
            }
            
            return {
                status: 'success',
                message: `已恢复任务 ${targetTaskId || targetProc.pid}`,
                taskId: targetTaskId,
                pid: targetProc.pid
            };
        } catch (error) {
            return {
                status: 'error',
                message: `恢复失败: ${error.message}`
            };
        }
    }
    
    /**
     * 【P2-1 新增】getTaskStatus - 获取任务状态
     */
    getTaskStatus(taskId, agentId) {
        if (!taskId) {
            return {
                status: 'error',
                message: `未指定 taskId`
            };
        }
        
        const taskState = this.taskStates.get(taskId);
        if (!taskState) {
            return {
                status: 'error',
                message: `找不到任务 ${taskId}`
            };
        }
        
        return {
            status: 'success',
            task: {
                taskId: taskState.taskId,
                status: taskState.status,
                pid: taskState.pid,
                agentId: taskState.agentId,
                topicId: taskState.topicId,
                startTime: taskState.startTime,
                elapsed: Date.now() - taskState.startTime,
                pauseTime: taskState.pauseTime,
                totalPausedTime: taskState.totalPausedTime || 0,
                progress: taskState.progress
            }
        };
    }
    
    /**
     * 【P2-1 新增】listTasks - 列出所有任务
     */
    listTasks(agentId) {
        const tasks = [];
        
        for (const [taskId, state] of this.taskStates) {
            if (agentId && state.agentId !== agentId) {
                continue;
            }
            
            tasks.push({
                taskId,
                status: state.status,
                pid: state.pid,
                agentId: state.agentId,
                topicId: state.topicId,
                startTime: state.startTime,
                elapsed: Date.now() - state.startTime,
                progress: state.progress
            });
        }
        
        // 按开始时间排序（最新的在前）
        tasks.sort((a, b) => b.startTime - a.startTime);
        
        return {
            status: 'success',
            tasks,
            count: tasks.length
        };
    }
    
    /**
     * cleanup - 清理
     */
    cleanup() {
        this.saveTopics();
        this.logger.info('[OpenCodeArchitect] Cleanup completed');
    }
}

async function main() {
    let inputData = '';
    
    const architect = new OpenCodeArchitect({
        logger: {
            info: (...args) => console.error('[INFO]', ...args),
            warn: (...args) => console.error('[WARN]', ...args),
            error: (...args) => console.error('[ERROR]', ...args)
        }
    });
    
    // 【ISSUE #10 FIX】activeProcesses 已改为 OpenCodeArchitect 实例属性，不再需要局部变量
    
    process.stdin.setEncoding('utf8');
    
    process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
            inputData += chunk;
        }
    });
    
    process.stdin.on('end', async () => {
        let input = {};
        
        if (inputData.trim()) {
            try {
                input = JSON.parse(inputData);
            } catch (e) {
                const params = new URLSearchParams(inputData);
                input.command = params.get('command');
                for (const [key, value] of params) {
                    if (key !== 'command') {
                        input[key] = value;
                    }
                }
            }
        }
        
        if (!input.command) {
            const args = process.argv.slice(2);
            input.command = args[0] || 'chat';
            input.message = args.slice(1).join(' ');
        }
        
        const { command = 'chat', agentId = 'default', topicId = null, title = null } = input;
        let result;
        
        // 【新增】自然语言任务解析 - 意图识别映射
        // 支持用户使用自然语言描述任务，如 "analyze_repository" 自动映射到 "consult"
        const INTENT_PATTERNS = {
            'analyze': 'consult',
            'analyze_repository': 'consult',
            'analyzerepository': 'consult',
            'review': 'consult',
            'review_code': 'consult',
            'inspect': 'consult',
            'modify': 'apply',
            'change': 'apply',
            'update': 'apply',
            'edit': 'apply',
            'patch': 'apply',
            'init': 'initialize',
            'sync': 'initialize',
            'initialize': 'initialize',
            'list': 'listTopics',
            'list_topics': 'listTopics',
            'listtopics': 'listTopics',
            'interrupt': 'interrupt',
            'stop': 'interrupt',
            'terminate': 'interrupt',
            'pause': 'pause',
            'suspend': 'pause',
            'resume': 'resume',
            'continue_task': 'resume',
            'create_topic': 'createTopic',
            'createtopic': 'createTopic',
            'new_topic': 'createTopic',
            'get_topic': 'getTopic',
            'gettopic': 'getTopic',
            'close_topic': 'closeTopic',
            'closetopic': 'closeTopic',
            'switch_topic': 'switchTopic',
            'switchtopic': 'switchTopic',
            'task_status': 'getTaskStatus',
            'get_task': 'getTaskStatus',
            'list_all_tasks': 'listTasks'
        };
        
        let actualCommand = command;
        const normalizedCmd = command.toLowerCase().replace(/[_\-]/g, '');
        
        // 检查是否是预定义命令
        const predefinedCommands = ['chat', 'interrupt', 'pause', 'resume', 'check', 'cleanup', 'createTopic', 'listTopics', 'getTopic', 'closeTopic', 'switchTopic', 'getTaskStatus', 'listTasks'];
        
        if (!predefinedCommands.includes(command)) {
            // 尝试匹配意图
            for (const [intent, mappedCmd] of Object.entries(INTENT_PATTERNS)) {
                if (normalizedCmd.includes(intent)) {
                    actualCommand = mappedCmd;
                    console.error(`[Intent Detection] "${command}" → "${mappedCmd}"`);
                    break;
                }
            }
        }
        
        switch (actualCommand) {
            case 'chat':
                result = await architect.chat(input.message || '', { 
                    agentId, 
                    topicId, 
                    title,
                    timeout: input.timeout
                });
                const outerStatus = (result.status === 'timeout' || result.status === 'error') ? 'error' : result.status;
                result = { 
                    status: outerStatus, 
                    error: outerStatus === 'error' ? (result.answer || result.message) : null, 
                    result 
                };
                break;
            case 'interrupt':
                result = architect.interrupt(input.pid);
                result = { 
                    status: result.status, 
                    error: result.status === 'error' ? result.message : null, 
                    result 
                };
                break;
            case 'pause':
                // 【P2-1 新增】暂停任务（通过 SIGSTOP 信号）
                result = architect.pauseTask(input.taskId || input.pid);
                result = {
                    status: result.status,
                    error: result.status === 'error' ? result.message : null,
                    result
                };
                break;
            case 'resume':
                // 【P2-1 新增】恢复任务（通过 SIGCONT 信号）
                result = architect.resumeTask(input.taskId || input.pid);
                result = {
                    status: result.status,
                    error: result.status === 'error' ? result.message : null,
                    result
                };
                break;
            case 'getTaskStatus':
                // 【P2-1 新增】获取任务状态
                result = architect.getTaskStatus(input.taskId, input.agentId);
                result = {
                    status: result.status,
                    error: result.status === 'error' ? result.message : null,
                    result
                };
                break;
            case 'listTasks':
                // 【P2-1 新增】列出所有任务
                result = architect.listTasks(input.agentId);
                result = {
                    status: result.status,
                    error: result.status === 'error' ? result.message : null,
                    result
                };
                break;
            case 'check':
                result = await architect.checkEnvironment();
                result = { 
                    status: result.status, 
                    error: result.status === 'error' ? result.error : null, 
                    result 
                };
                break;
            case 'cleanup':
                architect.cleanup();
                result = { status: 'success', result: null };
                break;
            case 'createTopic':
                const newTopic = architect.createTopic(agentId, input.title);
                result = { status: 'success', result: { topicId: newTopic.topicId, title: newTopic.title } };
                break;
            case 'listTopics':
                result = { status: 'success', result: { topics: architect.listTopics(agentId) } };
                break;
            case 'getTopic':
                const topic = architect.getTopic(agentId, input.topicId);
                result = topic 
                    ? { status: 'success', result: { topic } }
                    : { status: 'error', error: '话题不存在', result: { error: '话题不存在' } };
                break;
            case 'closeTopic':
                const closeResult = architect.closeTopic(agentId, input.topicId);
                result = { 
                    status: closeResult.success ? 'success' : 'error', 
                    error: closeResult.success ? null : closeResult.message,
                    result: closeResult 
                };
                break;
            case 'switchTopic':
                const ctx = architect.getCurrentContext(agentId, input.topicId);
                result = { 
                    status: 'success', 
                    result: {
                        topicId: ctx.topicId, 
                        title: ctx.title,
                        message: `已切换到话题 "${ctx.title}"`
                    }
                };
                break;
            default:
                // 【P1-4 改进】使用标准化错误格式
                const errDef = ERROR_CODES['E1001'];
                result = {
                    status: 'error',
                    code: 'E1001',
                    category: errDef.category,
                    message: `未知命令: ${command}`,
                    suggestion: errDef.suggestion,
                    timestamp: new Date().toISOString()
                };
        }
        
        console.log(JSON.stringify(result, null, 2));
    });
}

if (require.main === module) {
    main().catch((err) => {
        console.error(JSON.stringify({ status: 'error', message: err.message }));
        process.exit(1);
    });
}

module.exports = OpenCodeArchitect;
