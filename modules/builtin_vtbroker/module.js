/**
 * BuiltinVTPBroker Module Entry
 * 
 * 导出内置 VTPBroker 及其共享模块
 */

const BuiltinVTPBroker = require('./index');
const CategoryMapper = require('../vtbroker/category-mapper');
const SchemaGenerator = require('../vtbroker/schema-generator');

module.exports = {
    BuiltinVTPBroker,
    CategoryMapper,
    SchemaGenerator,
    createBuiltinVTPBroker: () => BuiltinVTPBroker.getInstance()
};
