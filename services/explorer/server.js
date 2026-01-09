import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;
const GATEKEEPER_URL = process.env.GATEKEEPER_URL || 'http://gatekeeper-clusterip.development.svc.cluster.local:4224';

console.log(`Gatekeeper URL: ${GATEKEEPER_URL}`);

// Parse JSON bodies
app.use(express.json());

// Manual proxy for /api routes
app.all('/api/*', async (req, res) => {
  const apiPath = req.path.replace(/^\/api/, '');
  const targetUrl = `${GATEKEEPER_URL}${apiPath}${req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : ''}`;
  
  console.log(`[PROXY] ${req.method} ${req.path} -> ${targetUrl}`);

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...req.headers,
        host: new URL(GATEKEEPER_URL).host,
      },
      validateStatus: () => true, // Don't throw on any status code
    });

    // Forward status and headers
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    
    res.send(response.data);
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: 'Proxy error', message: error.message });
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
});