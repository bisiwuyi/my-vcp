'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000'];

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

app.use(helmet());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS policy violation: Origin not allowed'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(limiter);

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.status(200).json({
    message: 'Hello World! Welcome to the REST API',
    version: '1.0.0',
    endpoints: {
      health: '/health',
      hello: '/api/v1/hello',
      helloWithName: '/api/v1/hello/:name'
    }
  });
});

app.get('/api/v1/hello', (req, res) => {
  res.status(200).json({
    success: true,
    data: {
      message: 'Hello World!',
      timestamp: new Date().toISOString()
    }
  });
});

app.get('/api/v1/hello/:name', (req, res) => {
  const { name } = req.params;

  if (!name || typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_PARAMETER',
        message: 'Name parameter is required and must be 1-100 characters'
      }
    });
  }

  const sanitizedName = name.replace(/[<>\"'&]/g, '');

  res.status(200).json({
    success: true,
    data: {
      message: `Hello, ${sanitizedName}!`,
      timestamp: new Date().toISOString()
    }
  });
});

app.post('/api/v1/hello', (req, res) => {
  const { name, greeting } = req.body;

  if (!name || typeof name !== 'string' || name.length > 100) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_REQUEST',
        message: 'Name is required and must be 1-100 characters'
      }
    });
  }

  const sanitizedName = name.replace(/[<>\"'&]/g, '');
  const customGreeting = (greeting && typeof greeting === 'string' && greeting.length <= 50)
    ? greeting.replace(/[<>\"'&]/g, '')
    : 'Hello';

  res.status(201).json({
    success: true,
    data: {
      message: `${customGreeting}, ${sanitizedName}!`,
      timestamp: new Date().toISOString()
    }
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`
    }
  });
});

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.stack}`);

  if (err.message === 'CORS policy violation: Origin not allowed') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'CORS_VIOLATION',
        message: 'Origin not allowed by CORS policy'
      }
    });
  }

  res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred'
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SERVER] Hello World API running on port ${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/health`);
  });
}

module.exports = app;
