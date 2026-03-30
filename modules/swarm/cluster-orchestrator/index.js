// modules/swarm/cluster-orchestrator/index.js
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const dotenv = require('dotenv');
dotenv.config();

class ClusterNode {
    constructor(options) {
        this.id = options.id || uuidv4();
        this.name = options.name || `node-${this.id.slice(0, 8)}`;
        this.host = options.host || 'localhost';
        this.port = options.port || 3000;
        this.capabilities = options.capabilities || [];
        this.status = 'offline';
        this.load = 0;
        this.maxLoad = options.maxLoad || 100;
        this.lastHeartbeat = Date.now();
        this.metadata = options.metadata || {};
        this.weight = options.weight || 1;
    }

    isHealthy() {
        const now = Date.now();
        return this.status === 'online' && (now - this.lastHeartbeat) < 30000;
    }

    canAcceptTask() {
        return this.isHealthy() && this.load < this.maxLoad;
    }

    updateHeartbeat() {
        this.lastHeartbeat = Date.now();
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            host: this.host,
            port: this.port,
            capabilities: this.capabilities,
            status: this.status,
            load: this.load,
            maxLoad: this.maxLoad,
            lastHeartbeat: this.lastHeartbeat,
            metadata: this.metadata,
            weight: this.weight
        };
    }
}

class Task {
    constructor(options) {
        this.id = options.id || uuidv4();
        this.type = options.type || 'generic';
        this.priority = options.priority || 5;
        this.payload = options.payload || {};
        this.targetCapabilities = options.targetCapabilities || [];
        this.timeout = options.timeout || 60000;
        this.retries = options.retries || 0;
        this.maxRetries = options.maxRetries || parseInt(process.env.SWARM_MAX_RETRY_TIMES) || 3;
        this.status = 'pending';
        this.assignedNode = null;
        this.createdAt = Date.now();
        this.startedAt = null;
        this.completedAt = null;
        this.result = null;
        this.error = null;
    }

    canRetry() {
        return this.retries < this.maxRetries;
    }

    markRetried() {
        this.retries++;
    }

    toJSON() {
        return {
            id: this.id,
            type: this.type,
            priority: this.priority,
            payload: this.payload,
            targetCapabilities: this.targetCapabilities,
            timeout: this.timeout,
            retries: this.retries,
            maxRetries: this.maxRetries,
            status: this.status,
            assignedNode: this.assignedNode,
            createdAt: this.createdAt,
            startedAt: this.startedAt,
            completedAt: this.completedAt,
            error: this.error
        };
    }
}

class ClusterOrchestrator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.debugMode = options.debugMode || false;
        this.nodes = new Map();
        this.tasks = new Map();
        this.taskQueue = [];
        this.strategy = options.strategy || 'least-loaded';
        this.heartbeatInterval = options.heartbeatInterval || 10000;
        this.taskTimeoutCheckInterval = options.taskTimeoutCheckInterval || 5000;
        this.maxConcurrentTasksPerNode = options.maxConcurrentTasksPerNode || parseInt(process.env.SWARM_MAX_PARALLEL_AGENTS) || 10;
        this.heartbeatTimer = null;
        this.timeoutCheckerTimer = null;
        this.nodeId = options.nodeId || uuidv4();
        this.clusterName = options.clusterName || 'vcp-swarm';
        this.isRunning = false;
    }

    async initialize() {
        if (this.debugMode) {
            console.log('[ClusterOrchestrator] Initializing...');
        }
        this.startHeartbeatMonitor();
        this.startTimeoutChecker();
        this.isRunning = true;
        this.emit('initialized');
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Cluster "${this.clusterName}" ready with ${this.nodes.size} nodes`);
        }
    }

    startHeartbeatMonitor() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        this.heartbeatTimer = setInterval(() => {
            this.processHeartbeats();
        }, this.heartbeatInterval);
    }

    startTimeoutChecker() {
        if (this.timeoutCheckerTimer) {
            clearInterval(this.timeoutCheckerTimer);
        }
        this.timeoutCheckerTimer = setInterval(() => {
            this.checkTaskTimeouts();
        }, this.taskTimeoutCheckInterval);
    }

    processHeartbeats() {
        const now = Date.now();
        let offlineCount = 0;
        for (const [nodeId, node] of this.nodes) {
            if (node.status === 'online' && (now - node.lastHeartbeat) > 30000) {
                node.status = 'offline';
                offlineCount++;
                this.emit('node:offline', node);
                if (this.debugMode) {
                    console.log(`[ClusterOrchestrator] Node ${node.name} marked offline (no heartbeat)`);
                }
            }
        }
    }

    checkTaskTimeouts() {
        const now = Date.now();
        for (const [taskId, task] of this.tasks) {
            if (task.status === 'running' && task.startedAt) {
                if ((now - task.startedAt) > task.timeout) {
                    this.handleTaskTimeout(task);
                }
            }
        }
    }

    handleTaskTimeout(task) {
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Task ${task.id} timed out`);
        }
        task.status = 'timeout';
        task.error = 'Task execution timeout';
        if (task.canRetry()) {
            task.markRetried();
            task.status = 'pending';
            task.assignedNode = null;
            this.taskQueue.push(task);
            this.emit('task:retry', task);
        } else {
            task.status = 'failed';
            this.emit('task:failed', task);
        }
    }

    registerNode(options) {
        const node = new ClusterNode(options);
        this.nodes.set(node.id, node);
        this.emit('node:registered', node);
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Node registered: ${node.name} (${node.id})`);
        }
        return node;
    }

    unregisterNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            return false;
        }
        this.nodes.delete(nodeId);
        this.requeueNodeTasks(nodeId);
        this.emit('node:unregistered', node);
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Node unregistered: ${node.name}`);
        }
        return true;
    }

    requeueNodeTasks(nodeId) {
        for (const [taskId, task] of this.tasks) {
            if (task.assignedNode === nodeId && (task.status === 'running' || task.status === 'pending')) {
                task.assignedNode = null;
                task.status = 'pending';
                if (!this.taskQueue.includes(task)) {
                    this.taskQueue.push(task);
                }
            }
        }
    }

    heartbeat(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            return false;
        }
        node.updateHeartbeat();
        if (node.status !== 'online') {
            node.status = 'online';
            this.emit('node:online', node);
        }
        return true;
    }

    updateNodeLoad(nodeId, load) {
        const node = this.nodes.get(nodeId);
        if (!node) {
            return false;
        }
        node.load = Math.max(0, Math.min(load, node.maxLoad));
        this.emit('node:loadUpdate', node);
        return true;
    }

    selectNode(task) {
        const candidates = [];
        for (const [nodeId, node] of this.nodes) {
            if (!node.canAcceptTask()) {
                continue;
            }
            if (task.targetCapabilities.length > 0) {
                const hasCapability = task.targetCapabilities.every(cap => 
                    node.capabilities.includes(cap)
                );
                if (!hasCapability) {
                    continue;
                }
            }
            candidates.push(node);
        }
        if (candidates.length === 0) {
            return null;
        }
        switch (this.strategy) {
            case 'least-loaded':
                candidates.sort((a, b) => (a.load / a.maxLoad) - (b.load / b.maxLoad));
                break;
            case 'round-robin':
                candidates.sort((a, b) => a.weight - b.weight);
                break;
            case 'random':
                candidates.sort(() => Math.random() - 0.5);
                break;
            case 'capability-weighted':
                candidates.sort((a, b) => {
                    const aScore = a.capabilities.length * a.weight;
                    const bScore = b.capabilities.length * b.weight;
                    return bScore - aScore;
                });
                break;
            default:
                candidates.sort((a, b) => (a.load / a.maxLoad) - (b.load / b.maxLoad));
        }
        return candidates[0];
    }

    submitTask(options) {
        const task = new Task(options);
        this.tasks.set(task.id, task);
        this.taskQueue.push(task);
        this.taskQueue.sort((a, b) => b.priority - a.priority);
        this.emit('task:submitted', task);
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Task submitted: ${task.id} (priority: ${task.priority})`);
        }
        return task;
    }

    async dispatchNextTask() {
        if (this.taskQueue.length === 0) {
            return null;
        }
        const task = this.taskQueue.shift();
        const node = this.selectNode(task);
        if (!node) {
            this.taskQueue.unshift(task);
            this.emit('task:pending', task);
            return null;
        }
        task.assignedNode = node.id;
        task.status = 'running';
        task.startedAt = Date.now();
        node.load++;
        this.emit('task:dispatched', task, node);
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Task ${task.id} dispatched to ${node.name}`);
        }
        return { task, node };
    }

    completeTask(taskId, result) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }
        const node = this.nodes.get(task.assignedNode);
        if (node && node.load > 0) {
            node.load--;
        }
        task.status = 'completed';
        task.result = result;
        task.completedAt = Date.now();
        this.emit('task:completed', task);
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Task ${task.id} completed`);
        }
        return true;
    }

    failTask(taskId, error) {
        const task = this.tasks.get(taskId);
        if (!task) {
            return false;
        }
        const node = this.nodes.get(task.assignedNode);
        if (node && node.load > 0) {
            node.load--;
        }
        if (task.canRetry()) {
            task.markRetried();
            task.assignedNode = null;
            task.status = 'pending';
            task.error = error;
            this.taskQueue.push(task);
            this.emit('task:retry', task);
        } else {
            task.status = 'failed';
            task.error = error;
            task.completedAt = Date.now();
            this.emit('task:failed', task);
        }
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Task ${task.id} failed: ${error}`);
        }
        return true;
    }

    getClusterStatus() {
        const nodes = Array.from(this.nodes.values()).map(n => n.toJSON());
        const tasks = Array.from(this.tasks.values()).map(t => t.toJSON());
        const stats = {
            totalNodes: nodes.length,
            onlineNodes: nodes.filter(n => n.status === 'online').length,
            offlineNodes: nodes.filter(n => n.status === 'offline').length,
            totalTasks: tasks.length,
            pendingTasks: tasks.filter(t => t.status === 'pending').length,
            runningTasks: tasks.filter(t => t.status === 'running').length,
            completedTasks: tasks.filter(t => t.status === 'completed').length,
            failedTasks: tasks.filter(t => t.status === 'failed').length,
            queueLength: this.taskQueue.length
        };
        return {
            clusterName: this.clusterName,
            nodeId: this.nodeId,
            isRunning: this.isRunning,
            strategy: this.strategy,
            nodes,
            tasks,
            stats
        };
    }

    getNode(nodeId) {
        const node = this.nodes.get(nodeId);
        return node ? node.toJSON() : null;
    }

    getTask(taskId) {
        const task = this.tasks.get(taskId);
        return task ? task.toJSON() : null;
    }

    setStrategy(strategy) {
        const validStrategies = ['least-loaded', 'round-robin', 'random', 'capability-weighted'];
        if (!validStrategies.includes(strategy)) {
            throw new Error(`Invalid strategy. Valid: ${validStrategies.join(', ')}`);
        }
        this.strategy = strategy;
        if (this.debugMode) {
            console.log(`[ClusterOrchestrator] Strategy changed to: ${strategy}`);
        }
        this.emit('strategy:changed', strategy);
    }

    shutdown() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.timeoutCheckerTimer) {
            clearInterval(this.timeoutCheckerTimer);
            this.timeoutCheckerTimer = null;
        }
        this.isRunning = false;
        this.emit('shutdown');
        if (this.debugMode) {
            console.log('[ClusterOrchestrator] Shutdown complete');
        }
    }
}

module.exports = { ClusterOrchestrator, ClusterNode, Task };