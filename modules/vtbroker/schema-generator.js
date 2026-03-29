/**
 * Schema Generator SDK
 * 
 * 从 VCP plugin-manifest.json 自动生成 MCP Schema
 * 支持零改造适配 VCP 现有插件
 */

const fs = require('fs');
const path = require('path');

class SchemaGenerator {
    /**
     * 从 plugin manifest 生成 MCP Schema
     * @param {Object} manifest - plugin-manifest.json 对象
     * @param {Object} options - 生成选项
     * @returns {Object} MCP Schema 对象
     */
    static generate(manifest, options = {}) {
        const {
            prefix = '',
            includeDeprecated = false,
            transformName = true
        } = options;

        if (!manifest || !manifest.name) {
            throw new Error('Invalid manifest: missing name');
        }

        const schema = {
            name: transformName ? this.transformToolName(manifest.name, prefix) : manifest.name,
            description: manifest.description || `${manifest.displayName || manifest.name} tool`,
            version: manifest.version || '1.0.0',
            tools: []
        };

        // 从 invocationCommands 生成 tools
        // 支持 root level 和 capabilities.invocationCommands 两种格式
        const invocationCommands = manifest.invocationCommands || manifest.capabilities?.invocationCommands;
        if (invocationCommands) {
            for (const cmd of invocationCommands) {
                if (!includeDeprecated && cmd.deprecated) continue;
                
                const tool = this.generateTool(manifest.name, cmd, options);
                schema.tools.push(tool);
            }
        }

        return schema;
    }

    /**
     * 生成单个工具的 MCP Schema
     */
    static generateTool(pluginName, command, options = {}) {
        const { prefix = '', transformName = true } = options;
        
        const cmdId = command.command || command.commandIdentifier;

        const toolName = transformName 
            ? this.transformToolName(`${pluginName}_${cmdId}`, prefix)
            : `${pluginName}_${cmdId}`;

        const tool = {
            name: toolName,
            description: command.description || `Execute ${cmdId} on ${pluginName}`,
            inputSchema: {
                type: 'object',
                properties: {},
                required: []
            }
        };

        // 解析 parameters
        if (command.parameters) {
            for (const [paramName, paramDef] of Object.entries(command.parameters)) {
                const schemaProp = this.convertParameter(paramName, paramDef);
                if (schemaProp) {
                    tool.inputSchema.properties[paramName] = schemaProp;
                    if (paramDef.required || paramDef.required === true) {
                        tool.inputSchema.required.push(paramName);
                    }
                }
            }
        }

        return tool;
    }

    /**
     * 转换参数定义为 JSON Schema 格式
     */
    static convertParameter(name, def) {
        if (!def || typeof def !== 'object') return null;

        const schema = {
            type: this.mapType(def.type),
            description: def.description || ''
        };

        // 添加格式信息
        if (def.default !== undefined) {
            schema.default = def.default;
        }

        if (def.enum) {
            schema.enum = def.enum;
        }

        if (def.minimum !== undefined) {
            schema.minimum = def.minimum;
        }

        if (def.maximum !== undefined) {
            schema.maximum = def.maximum;
        }

        if (def.minLength !== undefined) {
            schema.minLength = def.minLength;
        }

        if (def.maxLength !== undefined) {
            schema.maxLength = def.maxLength;
        }

        if (def.pattern) {
            schema.pattern = def.pattern;
        }

        return schema;
    }

    /**
     * 映射类型字符串到 JSON Schema 类型
     */
    static mapType(type) {
        const typeMap = {
            'string': 'string',
            'number': 'number',
            'integer': 'integer',
            'boolean': 'boolean',
            'array': 'array',
            'object': 'object',
            'null': 'null'
        };

        return typeMap[type] || 'string';
    }

    /**
     * 转换工具名称为统一格式
     */
    static transformToolName(name, prefix = '') {
        const cleanName = name
            .replace(/[^a-zA-Z0-9_]/g, '_')  // 特殊字符转下划线
            .replace(/_+/g, '_')              // 多个下划线合并
            .replace(/^_|_$/g, '');          // 去除首尾下划线

        return prefix ? `${prefix}_${cleanName}` : cleanName.toLowerCase();
    }

    /**
     * 批量生成 Schema
     * @param {Map|Array} plugins - plugin manifest 集合
     * @param {Object} options - 生成选项
     * @returns {Map} toolName -> MCP Schema
     */
    static generateAll(plugins, options = {}) {
        const schemaMap = new Map();

        for (const [name, manifest] of plugins) {
            try {
                const schema = this.generate(manifest, options);
                if (schema.tools && schema.tools.length > 0) {
                    for (const tool of schema.tools) {
                        schemaMap.set(tool.name, {
                            ...tool,
                            pluginName: manifest.name,
                            pluginVersion: manifest.version
                        });
                    }
                }
            } catch (error) {
                console.warn(`[SchemaGenerator] Failed to generate schema for ${name}:`, error.message);
            }
        }

        return schemaMap;
    }

    /**
     * 从目录扫描生成 Schema
     * @param {string} pluginDir - Plugin 目录路径
     * @param {Object} options - 生成选项
     * @returns {Map} toolName -> MCP Schema
     */
    static generateFromDirectory(pluginDir, options = {}) {
        const manifestFiles = this.findManifestFiles(pluginDir);
        const plugins = new Map();

        for (const manifestPath of manifestFiles) {
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                if (manifest.name) {
                    plugins.set(manifest.name, manifest);
                }
            } catch (error) {
                console.warn(`[SchemaGenerator] Failed to read manifest ${manifestPath}:`, error.message);
            }
        }

        return this.generateAll(plugins, options);
    }

    /**
     * 查找目录下所有 manifest 文件
     */
    static findManifestFiles(dir, results = []) {
        if (!fs.existsSync(dir)) return results;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                // 检查目录中的 plugin-manifest.json
                const manifestPath = path.join(fullPath, 'plugin-manifest.json');
                if (fs.existsSync(manifestPath)) {
                    results.push(manifestPath);
                }
                // 递归扫描子目录
                this.findManifestFiles(fullPath, results);
            }
        }

        return results;
    }

    /**
     * 验证 manifest 的 invocationCommands
     * @param {Object} manifest - plugin manifest 对象
     * @param {Object} options - 验证选项
     * @returns {Object} 验证结果
     */
    static validate(manifest, options = {}) {
        const SchemaValidator = require('./schema-validator');
        const validator = new SchemaValidator(options);
        return validator.validate(manifest);
    }

    /**
     * 验证并自动修复 manifest
     * @param {Object} manifest - plugin manifest 对象
     * @param {Object} options - 验证选项
     * @returns {Object} 修复结果
     */
    static validateAndFix(manifest, options = {}) {
        const SchemaValidator = require('./schema-validator');
        const validator = new SchemaValidator({ ...options, autoFix: true });
        return validator.autoFix(manifest);
    }

    /**
     * 从 description 提取一句话 summary
     * @param {string} description - 工具描述
     * @returns {string} 一句话摘要
     */
    static extractSummary(description) {
        if (!description) return "";

        // 策略1: 查找包含功能动词的句子
        const functionalPatterns = [
            /搜索\S{0,30}/, /查询\S{0,30}/, /生成\S{0,30}/,
            /获取\S{0,30}/, /读取\S{0,30}/, /写入\S{0,30}/,
            /创建\S{0,30}/, /删除\S{0,30}/, /分析\S{0,30}/,
            /推送\S{0,30}/, /发送\S{0,30}/, /抓取\S{0,30}/,
            /检索\S{0,30}/, /监控\S{0,30}/, /执行\S{0,30}/
        ];

        const sentences = description.split(/[。！？\n]/);

        for (const pattern of functionalPatterns) {
            for (const sentence of sentences) {
                if (pattern.test(sentence)) {
                    const trimmed = sentence.trim();
                    return trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
                }
            }
        }

        // 策略2: 取第一句的前 80 字符
        const firstSentence = sentences[0] || description;
        const trimmed = firstSentence.trim();
        return trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
    }
}

module.exports = SchemaGenerator;
