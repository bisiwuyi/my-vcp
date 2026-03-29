# Express Hello World REST API

A production-ready REST-compliant Node.js Express API service.

## Features

- RESTful API design with versioned endpoints (`/api/v1`)
- CORS support with configurable origin
- Helmet.js security headers
- Rate limiting (100 requests per 15 minutes)
- Input validation and sanitization
- XML/JSON response format support
- Health check endpoint

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4.18.2 | Web framework |
| cors | ^2.8.5 | Cross-origin resource sharing |
| helmet | ^7.1.0 | Security HTTP headers |
| express-rate-limit | ^7.1.5 | Rate limiting middleware |
| dotenv | ^16.3.1 | Environment variable management |

## Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| nodemon | ^3.0.2 | Development auto-reload |
| jest | ^29.7.0 | Testing framework |
| supertest | ^6.3.3 | HTTP assertion library |

## Installation

```bash
# Clone and install
npm install

# Create environment file
cp .env.example .env

# Edit .env with your configuration
```

## Configuration

Create a `.env` file:

```env
PORT=3000
NODE_ENV=development
CORS_ORIGIN=*
```

## Start Scripts

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev

# Run tests
npm test
```

## API Endpoints

### Health Check

```
GET /api/v1/health
```

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-03-29T12:00:00.000Z",
  "uptime": 12345.67
}
```

### GET Hello

```
GET /api/v1/hello?name=YourName&format=json
```

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| name | string | No | Name to greet (default: "World") |
| format | string | No | Response format: "json" or "xml" |

**Response (JSON):**
```json
{
  "message": "Hello, YourName!",
  "timestamp": "2026-03-29T12:00:00.000Z",
  "requestId": "req_123456789_abc123def"
}
```

**Response (XML):**
```xml
<response>
  <message>Hello, YourName!</message>
  <timestamp>2026-03-29T12:00:00.000Z</timestamp>
</response>
```

### POST Hello

```
POST /api/v1/hello
Content-Type: application/json

{"name": "YourName"}
```

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Name to greet (max 100 chars) |

**Response (201 Created):**
```json
{
  "message": "Hello, YourName!",
  "timestamp": "2026-03-29T12:00:00.000Z"
}
```

**Error Response (400 Bad Request):**
```json
{
  "error": "Bad Request",
  "message": "Field \"name\" is required and must be a string."
}
```

## Deployment

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

### PM2

```bash
npm install -g pm2
pm2 start server.js --name hello-api
pm2 save
pm2 startup
```

## Error Codes

| Status | Description |
|--------|-------------|
| 200 | OK - Successful GET request |
| 201 | Created - Successful POST request |
| 400 | Bad Request - Invalid input |
| 404 | Not Found - Unknown route |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## License

MIT
