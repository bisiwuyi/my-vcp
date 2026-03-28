---
Status: Active
Module: Bridge
Impact: OpenCodeArchitect 插件的 Diff 分析能力
Ritsu_Action: 需同步到记忆
---

# Ritsu Diff 分析协议 (Diff Analysis Protocol)

**版本**: v1.0.0
**创建日期**: 2026-03-27
**最后更新**: 2026-03-27

## 一、协议概述

Ritsu 使用本协议对 OpenCode 生成的代码 Diff 进行安全性和可行性分析，确保系统进化过程中的代码质量和安全。

```
OpenCode 生成 Diff
       ↓
Ritsu 接收 Diff
       ↓
应用分析协议
       ↓
输出分析报告
```

## 二、分析清单 (Diff Analysis Checklist)

### 2.1 依赖安全检查

```markdown
## 依赖安全检查 (Dependency Safety)

检查项目:
- [ ] 是否引入新的第三方依赖？
- [ ] 依赖版本是否指定了安全范围（如 ^1.0.0 而非 1.0.0）？
- [ ] 是否有已知安全漏洞的依赖？

通过标准: 无新依赖 或 依赖已通过安全审计
风险等级: HIGH - 新依赖必须明确授权
```

### 2.2 路径约定检查

```markdown
## 路径约定检查 (Path Conventions)

检查项目:
- [ ] 是否遵守 external-skills/ 相对路径约定？
- [ ] 是否使用 path.join 而非硬编码路径分隔符？
- [ ] 路径是否使用正向斜杠 / 或 path.resolve()？

通过标准: 所有路径使用跨平台 API
风险等级: MEDIUM - 硬编码路径会在其他平台失败
```

### 2.3 插件生命周期检查

```markdown
## 插件生命周期检查 (Plugin Lifecycle)

检查项目:
- [ ] 是否破坏了 VCP 插件生命周期钩子？
- [ ] 是否正确调用了 onLoad/onUnload？
- [ ] 是否在适当位置注册/注销事件监听器？

通过标准: 生命周期钩子完整且正确
风险等级: CRITICAL - 破坏生命周期会导致系统不稳定
```

### 2.4 日志规范检查

```markdown
## 日志规范检查 (Logging Conventions)

检查项目:
- [ ] 是否引入了不必要的 console.log？
- [ ] 是否使用结构化日志（JSON 格式）？
- [ ] 日志级别是否合适（DEBUG/INFO/WARN/ERROR）？

通过标准: 无冗余日志 或 日志已优化
风险等级: LOW - 冗余日志影响性能但不影响功能
```

### 2.5 安全漏洞检查

```markdown
## 安全漏洞检查 (Security Vulnerabilities)

检查项目:
- [ ] 是否有 SQL 注入风险？
- [ ] 是否有 XSS 风险？
- [ ] 是否有命令注入风险（eval, child_process spawn with shell）？
- [ ] 是否正确处理了用户输入？

通过标准: 无已知安全漏洞模式
风险等级: CRITICAL - 安全漏洞必须在上线前修复
```

### 2.6 代码质量检查

```markdown
## 代码质量检查 (Code Quality)

检查项目:
- [ ] 是否有明显的代码异味（duplication, long methods）？
- [ ] 是否遵循项目现有的代码风格？
- [ ] 是否有适当的错误处理？
- [ ] 是否有必要的类型检查？

通过标准: 代码质量达到项目基线
风险等级: MEDIUM - 质量问题应逐步改善
```

## 三、分析报告模板

```json
{
  "status": "approved|rejected|needs_review",
  "safetyScore": 0.0-1.0,
  "checks": {
    "dependencySafety": { "passed": true/false, "details": "..." },
    "pathConventions": { "passed": true/false, "details": "..." },
    "pluginLifecycle": { "passed": true/false, "details": "..." },
    "loggingConventions": { "passed": true/false, "details": "..." },
    "securityVulnerabilities": { "passed": true/false, "details": "..." },
    "codeQuality": { "passed": true/false, "details": "..." }
  },
  "issues": [
    {
      "severity": "critical|high|medium|low",
      "category": "security|quality|compatibility",
      "description": "问题描述",
      "location": "文件:行号 或 模块名",
      "suggestion": "修复建议"
    }
  ],
  "summary": "总结性描述",
  "reviewedBy": "Ritsu",
  "reviewedAt": "ISO8601 时间戳"
}
```

## 四、决策标准

| 决策 | 条件 |
|------|------|
| **approved** | 所有 CRITICAL 检查通过，且 HIGH 检查通过 ≥ 80% |
| **rejected** | 任何 CRITICAL 检查失败 |
| **needs_review** | 存在未解决的 HIGH 或 MEDIUM 问题 |

## 五、使用方法

Ritsu 在接收到 OpenCode 的 Diff 输出后，调用本协议进行分析：

```javascript
const DiffAnalyzer = require('./diff-analyzer');

const analyzer = new DiffAnalyzer();
const report = analyzer.analyze(diffOutput);

if (report.status === 'approved') {
    // 可以安全应用
} else if (report.status === 'rejected') {
    // 需要修改后重新提交
} else {
    // 需要人工审核
}
```

## 六、已知限制

| 限制 | 说明 | 解决方案 |
|------|------|----------|
| 静态分析 | 无法检测运行时行为 | 需要单元测试验证 |
| 模式匹配 | 可能产生误报 | 需要人工确认 |
| 上下文缺失 | 无法理解业务逻辑 | 需要 Ritsu 综合判断 |