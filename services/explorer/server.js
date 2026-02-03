import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { childLogger } from '@mdip/common/logger';

dotenv.config();
const log = childLogger({ service: 'explorer-server' });
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const GATEKEEPER_URL = process.env.GATEKEEPER_URL || 'http://gatekeeper-clusterip.development.svc.cluster.local:4224';
const SEARCH_SERVER_URL = process.env.SEARCH_SERVER_URL || 'http://localhost:4002';

console.log(`Gatekeeper URL: ${GATEKEEPER_URL}`);
console.log(`Search Server URL: ${SEARCH_SERVER_URL}`);

// Parse JSON bodies
app.use(express.json());

// Proxy for /api routes (gatekeeper)
app.use(/^\/api\/.*/, async (req, res) => {
  const apiPath = req.path.replace(/^\/api/, '');
  const targetUrl = `${GATEKEEPER_URL}${apiPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  
  console.log(`[GATEKEEPER PROXY] ${req.method} ${req.path} -> ${targetUrl}`);

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...req.headers,
        host: new URL(GATEKEEPER_URL).host,
      },
      validateStatus: () => true,
    });

    res.status(response.status);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    
    res.send(response.data);
  } catch (error) {
    console.error('Gatekeeper proxy error:', error.message);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
});

// Proxy for /search-api routes (search server)
app.use(/^\/search-api\/.*/, async (req, res) => {
  const searchPath = req.path.replace(/^\/search-api/, '');
  const targetUrl = `${SEARCH_SERVER_URL}${searchPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  
  console.log(`[SEARCH PROXY] ${req.method} ${req.path} -> ${targetUrl}`);

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...req.headers,
        host: new URL(SEARCH_SERVER_URL).host,
      },
      validateStatus: () => true,
    });

    res.status(response.status);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    
    res.send(response.data);
  } catch (error) {
    console.error('Search proxy error:', error.message);
    res.status(500).json({ error: 'Search proxy error', message: error.message });
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'dist')));

// Handle client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Explorer running on http://0.0.0.0:${PORT}`);
  console.log(`Proxying /api requests to ${GATEKEEPER_URL}`);
  console.log(`Proxying /search-api requests to ${SEARCH_SERVER_URL}`);
});
