'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const API_PREFIX = '/api/v1';

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(limiter);

app.get(`${API_PREFIX}/health`, (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get(`${API_PREFIX}/hello`, (req, res) => {
  const { name, format } = req.query;
  const response = {
    message: `Hello, ${name || 'World'}!`,
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || generateRequestId()
  };

  if (format === 'xml') {
    res.set('Content-Type', 'application/xml');
    res.status(200).send(`<response><message>${response.message}</message><timestamp>${response.timestamp}</timestamp></response>`);
  } else {
    res.status(200).json(response);
  }
});

app.post(`${API_PREFIX}/hello`, (req, res) => {
  const { name } = req.body || {};
  
  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Field "name" is required and must be a string.'
    });
  }

  if (name.length > 100) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Field "name" must not exceed 100 characters.'
    });
  }

  res.status(201).json({
    message: `Hello, ${sanitize(name)}!`,
    timestamp: new Date().toISOString()
  });
});

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found.`
  });
});

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${err.stack}`);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message
  });
});

function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function sanitize(str) {
  return String(str).replace(/[<>\"'&]/g, '').trim();
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Express Hello World API running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}${API_PREFIX}/health`);
    console.log(`Hello GET:  http://localhost:${PORT}${API_PREFIX}/hello?name=YourName`);
    console.log(`Hello POST: http://localhost:${PORT}${API_PREFIX}/hello`);
  });
}

module.exports = app;
