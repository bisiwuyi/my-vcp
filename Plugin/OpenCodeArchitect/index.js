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

const VCPRoot = path.resolve(__dirname, '../../');
const BACKUP_DIR = path.join(VCPRoot, '.opencode_backups');
const TOPICS_FILE = path.join(VCPRoot, '.opencode_topics.json');

const IS_WINDOWS = process.platform === 'win32';
const OPENCODE_BIN = IS_WINDOWS 
    ? 'opencode.cmd'
    : 'opencode';

const DiffAnalyzer = require('./diff-analyzer');

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
        this.loadTopics();
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
     * 保存话题列表
     */
    saveTopics() {
        try {
            fs.writeFileSync(TOPICS_FILE, JSON.stringify(this.topics, null, 2));
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
     * 调用 OpenCode
     */
    async callOpenCode(message, options = {}) {
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
     * consult - 专家咨询模式
     * 只读分析，返回报告和 Diff 预览，不改动物理文件
     */
    async consult(query, targetFile) {
        const targetPath = path.join(VCPRoot, targetFile);
        const workingDir = path.dirname(targetPath);
        
        if (!fs.existsSync(targetPath)) {
            return {
                status: 'error',
                report: `Target file not found: ${targetFile}`,
                issues: ['FILE_NOT_FOUND']
            };
        }
        
        const normalizedPath = targetFile.replace(/\\/g, '/');
        const fullQuery = query 
            ? `${query}\n\nPlease analyze the file: ${normalizedPath}`
            : `Analyze this file and identify any bugs, issues, or improvement suggestions: ${normalizedPath}`;
        const result = await this.callOpenCode(fullQuery, { targetPath: workingDir });
        
        const analyzer = new DiffAnalyzer();
        const analysis = result.status === 'success' && result.output 
            ? analyzer.analyze(result.output) 
            : { safetyScore: 0, issues: [], status: 'error', summary: '分析执行失败' };
        
        return {
            status: result.status,
            report: result.output || '执行失败，未收到输出',
            diff: result.output || '',
            safetyScore: analysis.safetyScore,
            issues: analysis.issues,
            safetyStatus: result.status === 'success' ? analysis.status : 'error',
            analysisStatus: result.status,
            duration: result.duration
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
            return {
                status: 'error',
                report: `Target file not found: ${targetFile}`,
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
        
        const response = {
            status: result.status,
            filesModified: result.status === 'success' ? [targetFile] : [],
            commitLog: result.output,
            rollbackAvailable: backupPath !== null,
            duration: result.duration
        };
        
        if (result.status === 'success' && result.output) {
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
                    response.status = 'rejected';
                    response.filesModified = [];
                    response.message = '安全检查未通过，已自动回滚。问题：' + analysis.issues.map(i => i.description).join('; ');
                    return response;
                }
            }
            
            if (analysis.status === 'needs_review' && !skipSafetyCheck) {
                response.status = 'needs_review';
                response.message = '存在安全问题需要人工审核。添加 skipSafetyCheck: true 可跳过此检查。';
            }
        }
        
        if ((result.status === 'error' || result.status === 'timeout') && backupPath) {
            this.rollback(backupPath, targetPath);
            response.status = 'rolled_back';
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
     */
    async chat(message, options = {}) {
        const { agentId = 'default', topicId = null, title = null, timeout = this.timeout, activeProcesses = new Map() } = options;
        
        const context = this.getCurrentContext(agentId, topicId);
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
        
        return new Promise((resolve) => {
            const startTime = Date.now();
            const proc = spawn(OPENCODE_BIN, args, {
                cwd: VCPRoot,
                shell: IS_WINDOWS ? 'cmd.exe' : '/bin/sh',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            
            const pid = proc.pid;
            activeProcesses.set(pid, proc);
            
            proc.stdin.end();
            
            let stdout = '';
            let stderr = '';
            let resolved = false;
            
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    this.killProcessTree(proc);
                    activeProcesses.delete(pid);
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
            });
            
            proc.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            proc.on('close', (code) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeoutId);
                activeProcesses.delete(pid);
                this.cleanupProcess(proc);
                
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
                    const topicData = this.topics[agentId]?.[actualTopicId];
                    if (topicData) {
                        const updates = {
                            messageCount: (topicData.messageCount || 0) + 1,
                            lastActive: Date.now()
                        };
                        
                        if (isNewTopic && extractedSessionId) {
                            updates.sessionId = extractedSessionId;
                        }
                        
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
                    isNewTopic
                });
            });
            
            proc.on('error', (error) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timeoutId);
                activeProcesses.delete(pid);
                this.cleanupProcess(proc);
                resolve({
                    status: 'error',
                    answer: error.message,
                    duration: Date.now() - startTime,
                    topicId: actualTopicId,
                    title: context.title
                });
            });
        });
    }
    
    /**
     * interrupt - 中断模式
     */
    interrupt(pid, activeProcesses = new Map()) {
        if (!pid) {
            return { 
                status: 'error', 
                message: '未指定进程 PID' 
            };
        }
        
        const proc = activeProcesses.get(pid);
        if (!proc) {
            return { 
                status: 'error', 
                message: `找不到 PID 为 ${pid} 的运行中进程` 
            };
        }
        
        this.killProcessTree(proc);
        activeProcesses.delete(pid);
        
        return { 
            status: 'success', 
            message: `已终止 PID 为 ${pid} 的 OpenCode 进程` 
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
    
    const activeProcesses = new Map();
    
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
        
        switch (command) {
            case 'chat':
                result = await architect.chat(input.message || '', { 
                    agentId, 
                    topicId, 
                    title,
                    timeout: input.timeout, 
                    activeProcesses 
                });
                const outerStatus = (result.status === 'timeout' || result.status === 'error') ? 'error' : result.status;
                result = { status: outerStatus, result };
                break;
            case 'interrupt':
                result = architect.interrupt(input.pid, activeProcesses);
                result = { status: result.status, result };
                break;
            case 'check':
                result = await architect.checkEnvironment();
                result = { status: result.status, result };
                break;
            case 'consult':
                result = await architect.consult(input.query || '', input.targetFile || '');
                result = { status: result.status, result };
                break;
            case 'apply':
                result = await architect.apply(input.query || '', input.targetFile || '', input.options || {});
                result = { status: result.status, result };
                break;
            case 'initialize':
                result = await architect.initialize(input.targetFile || VCPRoot);
                result = { status: result.status, result };
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
                    : { status: 'error', result: { error: '话题不存在' } };
                break;
            case 'closeTopic':
                const closeResult = architect.closeTopic(agentId, input.topicId);
                result = { status: closeResult.success ? 'success' : 'error', result: closeResult };
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
                result = { status: 'error', message: `Unknown command: ${command}` };
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
