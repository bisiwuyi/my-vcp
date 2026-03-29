/**
 * VTPBroker Module
 * 
 * 导出 VTPBroker 及其相关模块
 */

const VTPBroker = require('./index');
const CategoryMapper = require('./category-mapper');
const SchemaGenerator = require('./schema-generator');

module.exports = {
    VTPBroker,
    CategoryMapper,
    SchemaGenerator,
    createVTPBroker: () => VTPBroker.getInstance()
};
