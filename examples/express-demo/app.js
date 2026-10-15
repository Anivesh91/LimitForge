import express from 'express';
import demoRoutes from './routes.js';

const app = express();

app.use(express.json());

// In production behind reverse proxies (Nginx, ALB, Cloudflare, Render, Railway),
// trust proxy is required to accurately resolve real client IPs via X-Forwarded-For.
app.set('trust proxy', process.env.TRUST_PROXY || 1);

app.use('/api', demoRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

export default app;
