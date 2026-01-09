import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { childLogger } from '@mdip/common/logger';

dotenv.config();
const log = childLogger({ service: 'explorer-server' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const GATEKEEPER_URL = process.env.GATEKEEPER_URL || 'http://gatekeeper-clusterip.development.svc.cluster.local:4224';

console.log(`Gatekeeper URL: ${GATEKEEPER_URL}`);

// Proxy API requests to gatekeeper
app.use('/api', createProxyMiddleware({
  target: GATEKEEPER_URL,
  changeOrigin: true,
  pathRewrite: (path, req) => {
    // Remove /api prefix
    return path.replace(/^\/api/, '');
  },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`[PROXY] ${req.method} ${req.url} -> ${GATEKEEPER_URL}${req.url.replace('/api', '')}`);
  },
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy error', message: err.message });
  },
  logLevel: 'debug'
}));

// Serve static files
app.use(express.static(path.join(__dirname, 'dist')));

// Handle client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Explorer running on http://0.0.0.0:${PORT}`);
  console.log(`Proxying /api requests to ${GATEKEEPER_URL}`);
});
