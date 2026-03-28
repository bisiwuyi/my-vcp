/**
 * Ritsu Diff 分析器
 * 
 * 根据 Diff 分析协议对 OpenCode 生成的代码 Diff 进行安全性和可行性分析
 */

class DiffAnalyzer {
    constructor(options = {}) {
        this.logger = options.logger || console;
        this.strictMode = options.strictMode !== false;
    }

    /**
     * 分析 Diff
     */
    analyze(diffOutput) {
        const checks = {
            dependencySafety: this.checkDependencySafety(diffOutput),
            pathConventions: this.checkPathConventions(diffOutput),
            pluginLifecycle: this.checkPluginLifecycle(diffOutput),
            loggingConventions: this.checkLoggingConventions(diffOutput),
            securityVulnerabilities: this.checkSecurityVulnerabilities(diffOutput),
            codeQuality: this.checkCodeQuality(diffOutput)
        };

        const issues = Object.entries(checks)
            .filter(([, check]) => !check.passed)
            .flatMap(([category, check]) => 
                (check.issues || []).map(issue => ({ ...issue, category }))
            );

        const criticalPassed = !issues.some(i => i.severity === 'critical');
        const highIssueCount = issues.filter(i => i.severity === 'high').length;
        const highPassed = highIssueCount === 0;

        let status = 'approved';
        if (!criticalPassed) {
            status = 'rejected';
        } else if (!highPassed) {
            status = 'needs_review';
        } else if (issues.length > 0) {
            status = this.strictMode ? 'needs_review' : 'approved';
        }

        const safetyScore = this.calculateSafetyScore(checks, issues);

        return {
            status,
            safetyScore,
            checks,
            issues,
            summary: this.generateSummary(status, checks, issues),
            reviewedBy: 'Ritsu',
            reviewedAt: new Date().toISOString()
        };
    }

    /**
     * 依赖安全检查
     */
    checkDependencySafety(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const newRequirePatterns = diffStr.match(/require\s*\(\s*['"][^'"]+['"]\s*\)/g) || [];
        const newImportPatterns = diffStr.match(/import\s+.*?\s+from\s+['"][^'"]+['"]/g) || [];

        if (newRequirePatterns.length > 0 || newImportPatterns.length > 0) {
            issues.push({
                severity: 'high',
                description: `检测到 ${newRequirePatterns.length + newImportPatterns.length} 个新依赖引入`,
                location: 'import/require 语句',
                suggestion: '请确认这些依赖已通过安全审计并在 package.json 中声明'
            });
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '无新依赖引入' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 路径约定检查
     */
    checkPathConventions(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const hardcodedWindowsPaths = diffStr.match(/[A-Z]:\\[^'")\s]+/g) || [];
        const hardcodedUnixPaths = diffStr.match(/(?<![\w/])\/(?:home|usr|etc|var)\/[^\s'")]+/g) || [];

        if (hardcodedWindowsPaths.length > 0) {
            issues.push({
                severity: 'medium',
                description: `检测到 ${hardcodedWindowsPaths.length} 处 Windows 硬编码路径`,
                location: hardcodedWindowsPaths.slice(0, 3).join(', '),
                suggestion: '使用 path.join() 或 path.resolve() 进行路径拼接'
            });
        }

        if (hardcodedUnixPaths.length > 0) {
            issues.push({
                severity: 'medium',
                description: `检测到 ${hardcodedUnixPaths.length} 处 Unix 硬编码路径`,
                location: hardcodedUnixPaths.slice(0, 3).join(', '),
                suggestion: '使用 path 模块的跨平台 API'
            });
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '路径使用跨平台 API' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 插件生命周期检查
     */
    checkPluginLifecycle(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const hasOnLoad = /onLoad\s*[(:]/i.test(diffStr);
        const hasOnUnload = /onUnload\s*[(:]/i.test(diffStr);
        const hasLifecycleHooks = hasOnLoad || hasOnUnload;

        const pluginFiles = diffStr.match(/plugin-manifest\.json|index\.js|plugin\.js/g) || [];

        if (pluginFiles.length > 0 && !hasLifecycleHooks) {
            issues.push({
                severity: 'critical',
                description: '检测到插件文件修改但未声明生命周期钩子',
                location: '插件文件',
                suggestion: '确保实现 onLoad/onUnload 钩子或确认这是正确的'
            });
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '生命周期钩子正确' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 日志规范检查
     */
    checkLoggingConventions(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const consoleLogMatches = diffStr.match(/console\.(log|debug|info|warn|error)\s*\(/g) || [];
        const debugLogMatches = diffStr.match(/\bdebug\s*\(/g) || [];

        const totalLogs = consoleLogMatches.length + debugLogMatches.length;

        if (totalLogs > 5) {
            issues.push({
                severity: 'low',
                description: `检测到 ${totalLogs} 处日志调用`,
                location: 'console/debug 调用',
                suggestion: '考虑使用结构化日志并减少冗余日志'
            });
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '日志使用合理' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 安全漏洞检查
     */
    checkSecurityVulnerabilities(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const sqlInjectionPatterns = [
            /['"`].*?(SELECT|INSERT|UPDATE|DELETE|DROP|UNION|ALTER|CREATE).*?['"`]/gi,
            /(?:string|query|sql|statement)\s*(?:\+|=|\+=).*?['"`]/gi,
            /\$\{.*?\}.*?(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)/gi,
            /`[^`]*\$\{[^}]+\}[^`]*`/gi,
            /execute\s*\(\s*(?:query|sql|statement)/gi,
            /\.query\s*\(\s*['"`]/gi,
            /\.execute\s*\(\s*['"`]/gi
        ];

        const commandInjectionPatterns = [
            /eval\s*\(\s*(?:user|input|request|params)/gi,
            /new\s+Function\s*\(\s*(?:user|input|request|params)/gi,
            /exec\s*\(\s*(?:user|input|request|params|cmd|command)/gi,
            /execFile\s*\(\s*(?:user|input|request|params|cmd|command)/gi,
            /spawn\s*\(\s*(?:['"`]|cmd|command|shell)/gi,
            /spawnSync\s*\(\s*(?:['"`]|cmd|command|shell)/gi
        ];

        const xssPatterns = [
            /innerHTML\s*=\s*(?:user|input|request|params)/gi,
            /document\.write\s*\(\s*(?:user|input|request|params)/gi,
            /\.html\s*\(\s*(?:user|input|request|params)/gi,
            /\.(?:text|html)\s*\(.*?(?:user|input|request|params)/gi
        ];

        for (const pattern of sqlInjectionPatterns) {
            if (pattern.test(diffStr)) {
                issues.push({
                    severity: 'critical',
                    description: '可能的 SQL 注入风险',
                    location: 'SQL 相关代码',
                    suggestion: '使用参数化查询或 ORM'
                });
                break;
            }
        }

        for (const pattern of commandInjectionPatterns) {
            if (pattern.test(diffStr)) {
                issues.push({
                    severity: 'critical',
                    description: '可能的命令注入风险',
                    location: 'child_process/exec/eval 调用',
                    suggestion: '避免使用 shell: true，确保输入验证'
                });
                break;
            }
        }

        for (const pattern of xssPatterns) {
            if (pattern.test(diffStr)) {
                issues.push({
                    severity: 'high',
                    description: '可能的 XSS 风险',
                    location: 'DOM 操作代码',
                    suggestion: '使用 textContent 而非 innerHTML，进行输入转义'
                });
                break;
            }
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '无已知安全漏洞' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 代码质量检查
     */
    checkCodeQuality(diffOutput) {
        const issues = [];
        const diffStr = typeof diffOutput === 'string' ? diffOutput : JSON.stringify(diffOutput);

        const veryLongLines = diffStr.split('\n').filter(line => line.length > 200);
        if (veryLongLines.length > 3) {
            issues.push({
                severity: 'medium',
                description: `检测到 ${veryLongLines.length} 行超长代码 (>200 字符)`,
                location: '超长行',
                suggestion: '考虑拆分长行以提高可读性'
            });
        }

        const todoFixmeMatches = diffStr.match(/\b(TODO|FIXME|HACK|XXX)\b/gi) || [];
        if (todoFixmeMatches.length > 5) {
            issues.push({
                severity: 'low',
                description: `检测到 ${todoFixmeMatches.length} 处 TODO/FIXME 标记`,
                location: '代码注释',
                suggestion: '确保 TODO 不会影响功能，考虑创建 Issue 跟踪'
            });
        }

        return {
            passed: issues.length === 0,
            details: issues.length === 0 ? '代码质量良好' : issues.map(i => i.description).join('; '),
            issues
        };
    }

    /**
     * 计算安全评分
     */
    calculateSafetyScore(checks, issues) {
        let score = 1.0;

        for (const issue of issues) {
            switch (issue.severity) {
                case 'critical':
                    score -= 0.4;
                    break;
                case 'high':
                    score -= 0.2;
                    break;
                case 'medium':
                    score -= 0.1;
                    break;
                case 'low':
                    score -= 0.05;
                    break;
            }
        }

        return Math.max(0, Math.min(1, score));
    }

    /**
     * 生成总结
     */
    generateSummary(status, checks, issues) {
        const passedChecks = Object.values(checks).filter(c => c.passed).length;
        const totalChecks = Object.keys(checks).length;

        if (status === 'approved') {
            return `Diff 分析通过 (${passedChecks}/${totalChecks} 检查项通过)`;
        } else if (status === 'rejected') {
            const criticalIssues = issues.filter(i => i.severity === 'critical');
            return `Diff 分析拒绝 - ${criticalIssues.length} 个关键问题需要修复`;
        } else {
            return `Diff 需要审核 - ${issues.length} 个问题需要确认`;
        }
    }
}

module.exports = DiffAnalyzer;