// modules/swarm/context-isolator/index.js
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

const ISOLATION_STRATEGIES = {
    STRICT: 'strict',
    PARTIAL: 'partial',
    SHARED: 'shared'
};

const CONTEXT_SCOPE = {
    PRIVATE: 'private',
    PROTECTED: 'protected',
    PUBLIC: 'public'
};

class ContextSpace {
    constructor(options = {}) {
        this.id = options.id || uuidv4();
        this.name = options.name || `space-${this.id.slice(0, 8)}`;
        this.agentId = options.agentId || null;
        this.messages = [];
        this.metadata = options.metadata || {};
        this.scope = options.scope || CONTEXT_SCOPE.PRIVATE;
        this.isolationStrategy = options.isolationStrategy || ISOLATION_STRATEGIES.STRICT;
        this.maxMessages = options.maxMessages || 100;
        this.maxTokens = options.maxTokens || 50000;
        this.createdAt = Date.now();
        this.lastAccessedAt = Date.now();
        this.tags = new Set(options.tags || []);
        this.parentSpaceId = options.parentSpaceId || null;
        this.linkedSpaceIds = new Set(options.linkedSpaceIds || []);
        this.accessCount = 0;
        this.contextSnapshot = null;
    }

    isExpired(maxAge) {
        return (Date.now() - this.lastAccessedAt) > maxAge;
    }

    updateAccess() {
        this.lastAccessedAt = Date.now();
        this.accessCount++;
    }

    addMessage(message) {
        this.messages.push({
            ...message,
            _spaceId: this.id,
            _timestamp: Date.now()
        });
        this.updateAccess();
        this._enforceLimits();
    }

    _enforceLimits() {
        while (this.messages.length > this.maxMessages) {
            const removed = this.messages.shift();
            if (this.contextSnapshot === null && this.messages.length > 0) {
                this.contextSnapshot = {
                    snapshot: this.messages.slice(0, Math.floor(this.maxMessages * 0.3)),
                    trimmedCount: 1
                };
            }
        }
        if (this.contextSnapshot) {
            this.contextSnapshot.trimmedCount++;
        }
    }

    canAccess(requesterId, requiredScope) {
        if (this.scope === CONTEXT_SCOPE.PUBLIC) return true;
        if (this.scope === CONTEXT_SCOPE.PROTECTED) {
            return this.agentId === requesterId || this.linkedSpaceIds.has(requesterId);
        }
        return this.agentId === requesterId;
    }

    getMessages(requesterId, options = {}) {
        if (!this.canAccess(requesterId, options.requiredScope)) {
            return [];
        }
        if (options.includeSnapshot && this.contextSnapshot) {
            return [...this.contextSnapshot.snapshot, ...this.messages].slice(-options.limit || 100);
        }
        return this.messages.slice(-(options.limit || 100));
    }

    prune(oldestKeep = 1) {
        if (this.messages.length <= oldestKeep) return 0;
        const removed = this.messages.length - oldestKeep;
        this.messages = this.messages.slice(-oldestKeep);
        return removed;
    }

    mergeContext(otherSpace, strategy = 'append') {
        if (this.isolationStrategy === ISOLATION_STRATEGIES.STRICT && otherSpace.isolationStrategy === ISOLATION_STRATEGIES.STRICT) {
            return { success: false, error: 'STRICT isolation prevents merge' };
        }
        if (strategy === 'append') {
            this.messages.push(...otherSpace.messages);
        } else if (strategy === 'interleave') {
            const merged = [];
            const maxLen = Math.max(this.messages.length, otherSpace.messages.length);
            for (let i = 0; i < maxLen; i++) {
                if (i < otherSpace.messages.length) {
                    merged.push(otherSpace.messages[i]);
                }
                if (i < this.messages.length) {
                    merged.push(this.messages[i]);
                }
            }
            this.messages = merged;
        }
        this.updateAccess();
        return { success: true, mergedCount: otherSpace.messages.length };
    }

    createSnapshot() {
        return {
            id: uuidv4(),
            spaceId: this.id,
            messages: [...this.messages],
            metadata: { ...this.metadata },
            tags: [...this.tags],
            createdAt: Date.now()
        };
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            agentId: this.agentId,
            scope: this.scope,
            isolationStrategy: this.isolationStrategy,
            messageCount: this.messages.length,
            maxMessages: this.maxMessages,
            maxTokens: this.maxTokens,
            tags: [...this.tags],
            createdAt: this.createdAt,
            lastAccessedAt: this.lastAccessedAt,
            accessCount: this.accessCount,
            linkedSpaceIds: [...this.linkedSpaceIds]
        };
    }
}

class IsolationBoundary {
    constructor(options = {}) {
        this.id = options.id || uuidv4();
        this.name = options.name || `boundary-${this.id.slice(0, 8)}`;
        this.sourceSpaceId = options.sourceSpaceId;
        this.targetSpaceId = options.targetSpaceId;
        this.direction = options.direction || 'bidirectional';
        this.rules = options.rules || {};
        this.filters = options.filters || [];
        this.isActive = true;
        this.transitLog = [];
        this.maxTransitLog = options.maxTransitLog || 1000;
    }

    canTransit(message, direction) {
        if (!this.isActive) return false;
        if (this.direction !== 'bidirectional' && this.direction !== direction) {
            return false;
        }
        for (const filter of this.filters) {
            if (filter.block && filter.condition(message)) {
                return false;
            }
        }
        return true;
    }

    applyRules(message) {
        let result = { ...message };
        for (const rule of this.rules.transform || []) {
            if (rule.condition && rule.condition(message)) {
                result = rule.transform(result);
            }
        }
        return result;
    }

    logTransit(entry) {
        this.transitLog.push({
            ...entry,
            timestamp: Date.now()
        });
        if (this.transitLog.length > this.maxTransitLog) {
            this.transitLog.shift();
        }
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            sourceSpaceId: this.sourceSpaceId,
            targetSpaceId: this.targetSpaceId,
            direction: this.direction,
            rules: this.rules,
            isActive: this.isActive,
            transitCount: this.transitLog.length
        };
    }
}

class ContextIsolator extends EventEmitter {
    constructor(options = {}) {
        super();
        this.debugMode = options.debugMode || false;
        this.spaces = new Map();
        this.boundaries = new Map();
        this.defaultIsolationStrategy = options.defaultIsolationStrategy || ISOLATION_STRATEGIES.STRICT;
        this.defaultMaxMessages = options.defaultMaxMessages || 100;
        this.defaultMaxTokens = options.defaultMaxTokens || 50000;
        this.spaceCleanupInterval = options.spaceCleanupInterval || 60000;
        this.maxSpaceAge = options.maxSpaceAge || 3600000;
        this.cleanupTimer = null;
        this.isRunning = false;
        this.stats = {
            totalMessagesProcessed: 0,
            totalMerges: 0,
            totalBoundaryTransits: 0,
            blockedTransits: 0
        };
    }

    async initialize() {
        if (this.debugMode) {
            console.log('[ContextIsolator] Initializing...');
        }
        this.startCleanupTimer();
        this.isRunning = true;
        this.emit('initialized');
        if (this.debugMode) {
            console.log(`[ContextIsolator] Ready with ${this.spaces.size} spaces`);
        }
    }

    startCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpiredSpaces();
        }, this.spaceCleanupInterval);
    }

    cleanupExpiredSpaces() {
        let cleaned = 0;
        for (const [spaceId, space] of this.spaces) {
            if (space.isExpired(this.maxSpaceAge)) {
                if (this.debugMode) {
                    console.log(`[ContextIsolator] Cleaning up expired space: ${space.name}`);
                }
                this.spaces.delete(spaceId);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            this.emit('spaces:cleaned', { count: cleaned });
        }
    }

    createSpace(options = {}) {
        const space = new ContextSpace({
            ...options,
            isolationStrategy: options.isolationStrategy || this.defaultIsolationStrategy,
            maxMessages: options.maxMessages || this.defaultMaxMessages,
            maxTokens: options.maxTokens || this.defaultMaxTokens
        });
        this.spaces.set(space.id, space);
        this.emit('space:created', space);
        if (this.debugMode) {
            console.log(`[ContextIsolator] Space created: ${space.name} (${space.id})`);
        }
        return space;
    }

    getSpace(spaceId) {
        const space = this.spaces.get(spaceId);
        if (space) {
            space.updateAccess();
        }
        return space || null;
    }

    deleteSpace(spaceId) {
        const space = this.spaces.get(spaceId);
        if (!space) {
            return false;
        }
        this.spaces.delete(spaceId);
        for (const boundary of this.boundaries.values()) {
            if (boundary.sourceSpaceId === spaceId || boundary.targetSpaceId === spaceId) {
                this.boundaries.delete(boundary.id);
            }
        }
        this.emit('space:deleted', space);
        if (this.debugMode) {
            console.log(`[ContextIsolator] Space deleted: ${space.name}`);
        }
        return true;
    }

    findSpacesByAgent(agentId) {
        const result = [];
        for (const space of this.spaces.values()) {
            if (space.agentId === agentId) {
                result.push(space);
            }
        }
        return result;
    }

    findSpacesByTag(tag) {
        const result = [];
        for (const space of this.spaces.values()) {
            if (space.tags.has(tag)) {
                result.push(space);
            }
        }
        return result;
    }

    linkSpaces(spaceId1, spaceId2, options = {}) {
        const space1 = this.spaces.get(spaceId1);
        const space2 = this.spaces.get(spaceId2);
        if (!space1 || !space2) {
            return { success: false, error: 'Space not found' };
        }
        space1.linkedSpaceIds.add(spaceId2);
        space2.linkedSpaceIds.add(spaceId1);
        if (options.createBoundary) {
            const boundary = this.createBoundary({
                sourceSpaceId: spaceId1,
                targetSpaceId: spaceId2,
                direction: options.direction || 'bidirectional',
                rules: options.rules || {},
                filters: options.filters || []
            });
            return { success: true, boundary };
        }
        return { success: true };
    }

    unlinkSpaces(spaceId1, spaceId2) {
        const space1 = this.spaces.get(spaceId1);
        const space2 = this.spaces.get(spaceId2);
        if (!space1 || !space2) {
            return { success: false, error: 'Space not found' };
        }
        space1.linkedSpaceIds.delete(spaceId2);
        space2.linkedSpaceIds.delete(spaceId1);
        for (const [boundaryId, boundary] of this.boundaries) {
            if ((boundary.sourceSpaceId === spaceId1 && boundary.targetSpaceId === spaceId2) ||
                (boundary.sourceSpaceId === spaceId2 && boundary.targetSpaceId === spaceId1)) {
                this.boundaries.delete(boundaryId);
            }
        }
        return { success: true };
    }

    createBoundary(options) {
        const boundary = new IsolationBoundary(options);
        this.boundaries.set(boundary.id, boundary);
        this.emit('boundary:created', boundary);
        if (this.debugMode) {
            console.log(`[ContextIsolator] Boundary created: ${boundary.name}`);
        }
        return boundary;
    }

    transitMessage(sourceSpaceId, targetSpaceId, message, direction) {
        const boundary = this._findBoundary(sourceSpaceId, targetSpaceId);
        if (!boundary) {
            const sourceSpace = this.spaces.get(sourceSpaceId);
            const targetSpace = this.spaces.get(targetSpaceId);
            if (!sourceSpace || !targetSpace) {
                return { success: false, error: 'Space not found' };
            }
            if (sourceSpace.isolationStrategy === ISOLATION_STRATEGIES.STRICT &&
                targetSpace.isolationStrategy === ISOLATION_STRATEGIES.STRICT) {
                this.stats.blockedTransits++;
                return { success: false, error: 'STRICT isolation blocks transit' };
            }
        } else {
            if (!boundary.canTransit(message, direction)) {
                this.stats.blockedTransits++;
                boundary.logTransit({ type: 'blocked', message, direction });
                return { success: false, error: 'Boundary blocked transit' };
            }
            message = boundary.applyRules(message);
            boundary.logTransit({ type: 'allowed', message, direction });
        }

        const targetSpace = this.spaces.get(targetSpaceId);
        if (targetSpace) {
            targetSpace.addMessage({
                ...message,
                _transit: true,
                _sourceSpaceId: sourceSpaceId,
                _direction: direction
            });
        }
        this.stats.totalBoundaryTransits++;
        this.emit('message:transited', { sourceSpaceId, targetSpaceId, message });
        return { success: true };
    }

    _findBoundary(spaceId1, spaceId2) {
        for (const boundary of this.boundaries.values()) {
            if ((boundary.sourceSpaceId === spaceId1 && boundary.targetSpaceId === spaceId2) ||
                (boundary.sourceSpaceId === spaceId2 && boundary.targetSpaceId === spaceId1)) {
                return boundary;
            }
        }
        return null;
    }

    mergeSpaces(spaceId1, spaceId2, options = {}) {
        const space1 = this.spaces.get(spaceId1);
        const space2 = this.spaces.get(spaceId2);
        if (!space1 || !space2) {
            return { success: false, error: 'Space not found' };
        }
        const result = space1.mergeContext(space2, options.strategy || 'append');
        if (result.success) {
            this.stats.totalMerges++;
            this.emit('spaces:merged', { space1, space2, result });
            if (this.debugMode) {
                console.log(`[ContextIsolator] Merged space ${space2.name} into ${space1.name}`);
            }
        }
        return result;
    }

    addMessageToSpace(spaceId, message, senderId) {
        const space = this.spaces.get(spaceId);
        if (!space) {
            return { success: false, error: 'Space not found' };
        }
        if (!space.canAccess(senderId, CONTEXT_SCOPE.PRIVATE)) {
            return { success: false, error: 'Access denied' };
        }
        space.addMessage(message);
        this.stats.totalMessagesProcessed++;
        this.emit('message:added', { spaceId, message });
        return { success: true };
    }

    getMessagesFromSpace(spaceId, requesterId, options = {}) {
        const space = this.spaces.get(spaceId);
        if (!space) {
            return [];
        }
        return space.getMessages(requesterId, options);
    }

    snapshotSpace(spaceId) {
        const space = this.spaces.get(spaceId);
        if (!space) {
            return null;
        }
        const snapshot = space.createSnapshot();
        this.emit('space:snapshotted', { spaceId, snapshot });
        return snapshot;
    }

    restoreFromSnapshot(snapshotId, snapshot) {
        const space = this.spaces.get(snapshot.spaceId);
        if (space) {
            space.messages = [...snapshot.messages];
            space.metadata = { ...snapshot.metadata };
            space.tags = new Set(snapshot.tags);
            this.emit('space:restored', { spaceId: snapshot.spaceId });
            return true;
        }
        const newSpace = this.createSpace({
            id: snapshot.spaceId,
            messages: snapshot.messages,
            metadata: snapshot.metadata,
            tags: snapshot.tags
        });
        this.emit('space:restored', { spaceId: snapshot.spaceId, newSpace: true });
        return true;
    }

    getIsolatorStatus() {
        const spaces = Array.from(this.spaces.values()).map(s => s.toJSON());
        const boundaries = Array.from(this.boundaries.values()).map(b => b.toJSON());
        return {
            isRunning: this.isRunning,
            spaceCount: this.spaces.size,
            boundaryCount: this.boundaries.size,
            stats: { ...this.stats },
            spaces,
            boundaries,
            config: {
                defaultIsolationStrategy: this.defaultIsolationStrategy,
                defaultMaxMessages: this.defaultMaxMessages,
                defaultMaxTokens: this.defaultMaxTokens,
                maxSpaceAge: this.maxSpaceAge
            }
        };
    }

    checkConflicts(spaceId1, spaceId2) {
        const space1 = this.spaces.get(spaceId1);
        const space2 = this.spaces.get(spaceId2);
        if (!space1 || !space2) {
            return { hasConflicts: false };
        }
        const conflicts = [];
        const ids1 = new Set(space1.messages.map(m => m.id));
        for (const msg of space2.messages) {
            if (ids1.has(msg.id)) {
                conflicts.push({
                    type: 'duplicate_message',
                    messageId: msg.id,
                    space1Timestamp: space1.messages.find(m => m.id === msg.id)?._timestamp,
                    space2Timestamp: msg._timestamp
                });
            }
        }
        return {
            hasConflicts: conflicts.length > 0,
            conflicts
        };
    }

    shutdown() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.isRunning = false;
        this.emit('shutdown');
        if (this.debugMode) {
            console.log('[ContextIsolator] Shutdown complete');
        }
    }
}

module.exports = {
    ContextIsolator,
    ContextSpace,
    IsolationBoundary,
    ISOLATION_STRATEGIES,
    CONTEXT_SCOPE
};