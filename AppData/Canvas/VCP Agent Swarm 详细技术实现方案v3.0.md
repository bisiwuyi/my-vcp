# VCP Agent Swarm 详细技术实现方案 v3.0
> 本方案为全链路落地方案的技术细节补充，所有改动均为低侵入、兼容现有P0版本逻辑，默认参数与原版本完全一致，无破坏性变更。

---
## 🔹 第一部分：核心模块改造（24小时内落地，最高优先级）
### 1.1 子Agent并行上限可配置改造
#### 改造目标
将原写死的10个并行上限改为可配置项，支持用户自由调整，默认保持10兼容原有逻辑
#### 涉及文件
`E:\VCP\VCPToolBox_new\modules\swarm\cluster-orchestrator\index.js`
`E:\VCP\VCPToolBox_new\config.env`
#### 具体改动点
1. **config.env新增配置项**（自动追加，不修改原有配置）
```env
# Agent Swarm 配置
SWARM_MAX_PARALLEL_AGENTS=10 # 子Agent最大并行数，默认10，可自由调整无上限
SWARM_MAX_RETRY_TIMES=3 # 子任务最大重试次数，默认3
```
2. **ClusterOrchestrator构造函数修改**
```javascript
// 新增配置读取逻辑
const dotenv = require('dotenv');
dotenv.config();
class ClusterOrchestrator {
  constructor(options = {}) {
    // 优先取传入参数，其次取环境变量，默认10
    this.maxConcurrentTasks = options.maxParallelAgents || 
      parseInt(process.env.SWARM_MAX_PARALLEL_AGENTS) || 10;
    // 原有其他初始化逻辑不变
    this.nodes = [];
    this.taskQueue = [];
    // ... 原有逻辑
  }
}
```
3. **API扩展**：submitTask新增可选参数`maxParallelAgents`，支持任务级自定义并行上限
```javascript
// 调用示例
const result = await orchestrator.submitTasks(tasks, {
  maxParallelAgents: 15 // 该任务单独使用15并行，覆盖全局配置
});
```
#### 兼容逻辑
- 未配置环境变量、未传参时默认值为10，与原有逻辑完全一致
- 无需重启服务，配置修改后热加载生效（通过dotenv-flow实现）
- 所有现有调用完全兼容，无需修改代码
#### 预估改造时间：20分钟
#### 测试要点：
- 配置改为15后，同时提交20个任务，确认并行执行15个，剩余5个排队
- 不传配置时默认并行10个，与原有逻辑一致
- 任务级传参优先级高于全局配置

---
### 1.2 封闭/开放通信模式任务级开关改造
#### 改造目标
新增任务级通信模式开关，支持两种模式自由切换，默认封闭模式兼容原有逻辑
#### 依赖模块
已开发完成的`inter-agent-protocol`模块（路径：`modules/swarm/inter-agent-protocol/`，已实现点对点/广播通信、消息路由、权限校验能力）
#### 具体改动点
1. **新增任务元数据字段**
```javascript
// submitTask新增可选参数mode，可选值："closed"(默认) / "open"
const result = await orchestrator.submitTasks(tasks, {
  mode: "open" // 启用开放通信模式
});
```
2. **封闭模式逻辑（默认）**
- 完全保留原有逻辑：子Agent仅与母Agent通信，互相不可见，上下文完全隔离
- 无任何额外开销，Token优化指标保持90%+
3. **开放模式逻辑**
```javascript
// 新增初始化逻辑
if (task.mode === "open") {
  // 1. 创建全局共享消息总线上下文
  this.sharedBus = new ContextSpace({ maxMessages: 200 });
  // 2. 为每个子Agent注入通信能力
  tasks.forEach(task => {
    task.agent.prompt += `\n你可以通过sendMessage(role, content)方法给其他角色发送消息，通过broadcast(content)方法广播消息，所有消息会同步到共享上下文。`;
    task.agent.sendMessage = (targetRole, content) => {
      this.messageRouter.route(task.role, targetRole, content);
    };
    task.agent.broadcast = (content) => {
      this.messageRouter.broadcast(task.role, content);
    };
  });
  // 3. 启动消息审计器
  this.messageAuditor = new MessageAuditor({
    blockIrrelevantContent: true, // 过滤偏离任务目标的消息
    maxMessageLength: 500, // 单条消息最大长度限制
    tokenWarnThreshold: 2000 // 额外通信Token超过阈值自动预警
  });
}
```
#### 上下文同步规则（开放模式）
- 点对点消息：仅发送方和接收方将消息同步到自身私有上下文
- 广播消息：所有子Agent将消息同步到自身私有上下文
- 所有消息自动写入共享总线，支持快照回滚
- 自动裁剪规则复用：私有上下文+共享总线均自动裁剪保留30%核心内容，控制Token消耗
#### 防护机制
- 消息审计：自动过滤偏离任务目标、传递幻觉的无效消息
- 每5分钟自动备份共享上下文快照，出现污染时可一键回滚到最近正常快照
- Token预警：额外通信产生的Token超过阈值时自动推送提醒，支持自动关闭通信
#### 预估改造时间：1-2天
#### 测试要点：
- 封闭模式下子Agent无法调用通信方法，与原有逻辑一致
- 开放模式下子Agent可正常收发消息，上下文正确同步
- 无效消息被审计器拦截，污染后可正常回滚

---
## 🔹 第二部分：新增模块开发（1周内完成V1.0版本）
### 2.1 Task Decomposer 自动任务拆解模块
#### 核心实现逻辑
```javascript
class TaskDecomposer {
  async decompose(userTask) {
    // 1. 调用大模型分析任务复杂度、可并行度、角色需求
    const analysis = await llm.call(`
    分析以下任务，拆分为N个子任务，输出JSON格式：
    {
      "subTasks": [{"role": "角色名", "prompt": "子任务描述", "tools": ["所需工具列表"], "dependencies": ["依赖的子任务role"]}],
      "suggestParallelCount": 建议并行数量
    }
    任务：${userTask}
    `);
    // 2. 自动校验依赖关系，避免循环依赖
    this.validateDependencies(analysis.subTasks);
    // 3. 返回拆分结果，Orchestrator按建议数量启动对应子Agent
    return analysis;
  }
}
```
#### 核心规则
- 子任务数量自动根据任务复杂度决定，最小3个，最大不超过全局并行上限
- 自动识别依赖关系，无依赖的子任务并行执行，有依赖的串行执行
- 工具权限自动匹配，仅分配子任务所需的工具
#### 上线时间：Day3-4
#### 验收标准：输入自然语言任务，自动拆分为符合逻辑的子任务，依赖关系正确

---
### 2.2 Role Generator 角色生成模块
#### 核心实现逻辑
```javascript
class RoleGenerator {
  generate(role, taskDesc, tools) {
    // 通用基础提示词（仅10%通用内容）
    const basePrompt = `你是${role}，仅负责完成以下任务，禁止处理无关内容：\n`;
    // 任务专属提示词（90%个性化内容）
    const taskPrompt = `${taskDesc}\n`;
    // 工具权限专属提示词
    const toolsPrompt = `你可以使用以下工具：${tools.join(',')}，禁止使用未列出的工具。\n`;
    // 开放模式下追加通信能力提示词
    const commPrompt = mode === 'open' ? `你可以与其他角色通信协作。` : '';
    // 合并返回总提示词（长度200-500Token，无冗余）
    return basePrompt + taskPrompt + toolsPrompt + commPrompt;
  }
}
```
#### 核心优势
- 每个子Agent提示词完全独立，90%为当前任务专属内容，通用内容仅占10%
- 自动生成的提示词长度控制在200-500Token，无冗余内容，降低Token消耗
#### 上线时间：Day5
#### 验收标准：每个子Agent提示词符合角色定位、包含所有任务要求、无冗余内容

---
### 2.3 Task Scheduler 统一对外入口
#### 核心调用示例（3行代码）
```javascript
const taskScheduler = require('./modules/swarm/task-scheduler');
// 自然语言直接提交，自动完成全流程
const result = await taskScheduler.submitTask('制作硅基文明简史网页', {
  mode: 'open', // 可选，默认closed
  maxParallelAgents: 15 // 可选，默认全局配置
});
```
#### 内部执行流程
用户提交任务 → Task Decomposer自动拆解 → Role Generator生成子Agent → Orchestrator调度执行 → 结果汇总 → 返回最终交付物
#### 上线时间：Day6
#### 多触发方式支持
- CLI命令：`vcp swarm run "任务描述" --mode open --parallel 15`
- 对话触发：@Swarm 任务描述，自动识别参数
- 面板触发：可视化界面选择参数提交

---
### 2.4 Shared Task Board 共享任务看板
#### 核心API
```javascript
// 查询任务列表
const tasks = await sharedTaskBoard.listTasks('running');
// 查询单个任务详情
const task = await sharedTaskBoard.getTask(taskId);
// 导出执行日志、Token消耗明细
const report = await sharedTaskBoard.exportReport(taskId);
```
#### 实时推送逻辑
- 子任务状态变更时自动推送消息到对话/回调地址
- 进度消息格式：`[Swarm进度] 3/10子任务完成，耗时4分钟，消耗1800Token，当前运行中：插画生成`
#### 上线时间：Day7
#### 验收标准：可实时查询所有任务状态，推送消息及时准确

---
## 🔹 第三部分：OpenFang适配（2周内完成）
### 3.1 主动触发层开发
#### 适配逻辑
- 复用OpenFang现有toml配置规范，无需修改原有配置文件
- 新增定时/事件触发器，匹配配置规则自动启动Swarm执行任务
```toml
# OpenFang任务配置示例，无需修改即可适配
[task.weekly_report]
schedule = "0 0 * * 1" # 每周一零点执行
task = "生成上周行业报告，输出PDF"
mode = "closed"
maxParallel = 8
```
#### 上线时间：2周内
#### 适配场景：31个OpenFang预制场景无需修改配置，直接适配运行

---
## 🔹 第四部分：测试与回滚机制
### 4.1 测试验证方案
| 测试类型 | 验证内容 | 验收标准 |
|----------|----------|----------|
| 功能测试 | 所有新功能正常运行，原有功能不受影响 | 现有试点脚本运行结果与改造前完全一致 |
| 性能测试 | Token优化、效率提升指标达标 | 硅基文明简史任务Token降低≥90%、效率提升≥400% |
| 压力测试 | 并行数拉到50，系统稳定运行 | 总CPU占用≤5%、内存占用≤50MB，无崩溃 |
| 兼容测试 | 所有现有调用无需修改即可正常运行 | 原有代码完全兼容，无破坏性变更 |
### 4.2 回滚机制
- 所有新功能均为可选开关，默认关闭，出现问题一键关闭即可回滚到原有逻辑
- 核心代码修改均保留原有逻辑注释，可快速还原
- 上线前完整备份所有修改文件，出现问题1分钟内回滚完成

---
## 🔹 改动总览
| 模块 | 改动量 | 风险等级 | 兼容情况 |
|------|--------|----------|----------|
| Cluster Orchestrator | 新增100行代码 | 低 | 100%兼容 |
| Inter-Agent Protocol 集成 | 新增200行代码 | 低 | 原有逻辑不变 |
| Task Decomposer | 新增300行代码 | 低 | 全新模块无影响 |
| Role Generator | 新增150行代码 | 低 | 全新模块无影响 |
| Task Scheduler | 新增100行代码 | 低 | 全新模块无影响 |
| Shared Task Board | 新增200行代码 | 低 | 全新模块无影响 |
> 总改动量≤1050行，无核心逻辑重构，风险极低