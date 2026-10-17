import express from 'express';
import demoRoutes from './routes.js';

const app = express();

app.use(express.json());

app.set('trust proxy', process.env.TRUST_PROXY || 1);

app.use('/api', demoRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

export default app;
