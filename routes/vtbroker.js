/**
 * VTPBroker API Routes
 * 
 * 提供工具发现的 HTTP API 接口
 * 路径: /vtbroker/api/*
 */

const express = require('express');
const VTPBroker = require('../modules/vtbroker');
const BuiltinVTPBroker = require('../modules/builtin_vtbroker');

function createVTPBrokerRouter() {
    const router = express.Router();

    // 获取 vtbroker 实例（根据配置选择）
    function getBroker() {
        const ENABLE_BUILTIN = process.env.ENABLE_BUILTIN_VTBROKER === 'true';
        if (ENABLE_BUILTIN) {
            return BuiltinVTPBroker.getInstance();
        }
        return VTPBroker.getInstance();
    }

    // 获取所有工具分类
    router.get('/categories', (req, res) => {
        try {
            const broker = getBroker();
            const categories = broker.list_categories();
            
            res.json({
                success: true,
                data: categories
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // 获取指定分类下的工具列表
    router.get('/tools', (req, res) => {
        try {
            const broker = getBroker();
            const categoryId = req.query.category_id || null;
            
            const tools = broker.list_tools(categoryId);
            
            res.json({
                success: true,
                data: tools,
                categoryId: categoryId || 'all'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // 获取工具完整调用格式
    router.get('/schema/:toolId', (req, res) => {
        try {
            const broker = getBroker();
            const { toolId } = req.params;
            
            const schema = broker.get_tool_schema(toolId);
            
            if (!schema) {
                return res.status(404).json({
                    success: false,
                    error: `Tool not found: ${toolId}`
                });
            }
            
            res.json({
                success: true,
                data: schema
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // 获取工具总数
    router.get('/stats', (req, res) => {
        try {
            const broker = getBroker();
            
            res.json({
                success: true,
                data: {
                    totalTools: broker.getTotalToolCount(),
                    categories: broker.list_categories().length
                }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // 健康检查
    router.get('/health', (req, res) => {
        const broker = getBroker();
        res.json({
            success: true,
            initialized: broker._initialized,
            totalTools: broker.getTotalToolCount()
        });
    });

    // 模糊搜索工具（内置 VTPBroker 特有）
    router.get('/search', (req, res) => {
        try {
            const broker = getBroker();
            const { query, category_id } = req.query;
            
            if (!query) {
                return res.status(400).json({
                    success: false,
                    error: '缺少必填参数 query'
                });
            }
            
            if (typeof broker.search_tools !== 'function') {
                return res.status(501).json({
                    success: false,
                    error: '当前模式不支持模糊搜索'
                });
            }
            
            const result = broker.search_tools(query, category_id || null);
            if (result.status === 'success') {
                res.json({
                    success: true,
                    data: result.result
                });
            } else {
                res.status(400).json({
                    success: false,
                    error: result.error
                });
            }
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // v2.0: 批量获取工具 Schema
    router.post('/schemas', (req, res) => {
        try {
            const { toolIds } = req.body;
            if (!Array.isArray(toolIds)) {
                return res.status(400).json({
                    success: false,
                    error: 'toolIds must be an array'
                });
            }

            const broker = getBroker();
            const schemas = broker.get_tool_schemas(toolIds);

            res.json({
                success: true,
                data: schemas,
                count: schemas.length
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    // v2.0: 获取常用工具（带热度排序）
    router.get('/top-tools', (req, res) => {
        try {
            const { agent_alias, limit } = req.query;
            const broker = getBroker();

            const result = broker.get_agent_top_tools(
                agent_alias || null,
                parseInt(limit) || 5
            );

            if (!result) {
                return res.json({
                    success: true,
                    data: [],
                    message: 'No usage data available'
                });
            }

            res.json({
                success: true,
                data: result
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    });

    return router;
}

module.exports = createVTPBrokerRouter;
