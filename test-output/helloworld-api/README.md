# Hello World REST API

Node.js Express 实现的 RESTful Hello World 接口服务

## 功能特性

- RESTful API 设计规范
- 跨域资源共享 (CORS) 配置
- Helmet 安全头保护
- Rate Limiting 防滥用
- 输入验证与XSS防护
- 环境变量配置
- 完整错误处理中间件

## 快速开始

### 环境要求

- Node.js >= 18.0.0
- npm >= 9.0.0

### 安装步骤

```bash
# 1. 进入项目目录
cd helloworld-api

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env

# 4. 编辑 .env 配置
# PORT=3000
# NODE_ENV=development

# 5. 启动服务
npm start

# 开发模式 (热重载)
npm run dev
```

### 生产环境部署

```bash
# 使用 PM2
npm install -g pm2
pm2 start server.js --name helloworld-api

# 查看日志
pm2 logs helloworld-api

# 重启服务
pm2 restart helloworld-api
```

### Docker 部署

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t helloworld-api .
docker run -p 3000:3000 helloworld-api
```

## API 接口文档

### 基地址

```
http://localhost:3000
```

### 健康检查

#### GET /health

服务健康状态

**响应示例**

```json
{
  "status": "ok",
  "timestamp": "2026-03-29T12:00:00.000Z",
  "uptime": 3600.5
}
```

### Hello World

#### GET /api/v1/hello

返回默认问候

**响应示例**

```json
{
  "success": true,
  "data": {
    "message": "Hello World!",
    "timestamp": "2026-03-29T12:00:00.000Z"
  }
}
```

#### GET /api/v1/hello/:name

按名称问候

**参数**

| 参数 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| name | string | 是 | 名称 (1-100字符) |

**请求示例**

```
GET /api/v1/hello/Alice
```

**响应示例**

```json
{
  "success": true,
  "data": {
    "message": "Hello, Alice!",
    "timestamp": "2026-03-29T12:00:00.000Z"
  }
}
```

#### POST /api/v1/hello

自定义问候

**请求体**

```json
{
  "name": "Bob",
  "greeting": "Hi"
}
```

| 字段 | 类型 | 必填 | 说明 |
|-----|------|------|------|
| name | string | 是 | 名称 (1-100字符) |
| greeting | string | 否 | 自定义问候语 (最多50字符) |

**响应示例**

```json
{
  "success": true,
  "data": {
    "message": "Hi, Bob!",
    "timestamp": "2026-03-29T12:00:00.000Z"
  }
}
```

### 错误响应

**格式**

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述信息"
  }
}
```

**状态码**

| 状态码 | 说明 |
|-------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 403 | CORS/权限拒绝 |
| 404 | 路由不存在 |
| 429 | 请求过于频繁 |
| 500 | 服务器内部错误 |

## 配置说明

| 环境变量 | 默认值 | 说明 |
|---------|-------|------|
| PORT | 3000 | 服务端口 |
| NODE_ENV | development | 运行环境 |
| ALLOWED_ORIGINS | localhost:3000 | 允许的CORS源 |
| RATE_LIMIT_WINDOW_MS | 900000 | 限流时间窗口(15分钟) |
| RATE_LIMIT_MAX_REQUESTS | 100 | 时间窗口内最大请求数 |

## 项目结构

```
helloworld-api/
├── server.js          # 主服务文件
├── package.json       # 依赖配置
├── .env.example       # 环境变量模板
├── .eslintrc.json     # ESLint配置
└── README.md          # 本文档
```

## 测试

```bash
# 运行测试
npm test

# 代码检查
npm run lint
```

## 依赖清单

| 依赖 | 版本 | 用途 |
|-----|------|------|
| express | ^4.18.2 | Web框架 |
| cors | ^2.8.5 | 跨域资源共享 |
| helmet | ^7.1.0 | 安全HTTP头 |
| express-rate-limit | ^7.1.5 | 请求限流 |
| dotenv | ^16.3.1 | 环境变量加载 |

## 许可

MIT License
