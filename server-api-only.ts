import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './server/config';

// Import Routers
import authRouter from './server/routes/auth';
import usersRouter from './server/routes/users';
import clientsRouter from './server/routes/clients';
import tokensRouter from './server/routes/tokens';
import xpanelRouter from './server/routes/xpanel';
import resellersRouter from './server/routes/resellers';
import vouchersRouter from './server/routes/vouchers';
import analyticsRouter from './server/routes/analytics';
import serversRouter from './server/routes/servers';
import docsRouter from './server/routes/docs';
import vpnRouter from './server/routes/vpn';
import adminTokensRouter from './server/routes/admin-tokens';

const app = express();
app.set('trust proxy', 1);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[${new Date().toISOString()}] 📡 ${req.method} ${req.url}`);
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'errors.rate_limit', message: 'Too many requests' },
});
app.use('/api/', limiter);

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/tokens', tokensRouter);
app.use('/api/xpanel', xpanelRouter);
app.use('/api/resellers', resellersRouter);
app.use('/api/vouchers', vouchersRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/servers', serversRouter);
app.use('/api/docs', docsRouter);
app.use('/api/vpn', vpnRouter);
app.use('/api/admin-tokens', adminTokensRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('💥 Error:', err);
  const lang = req.headers['accept-language']?.startsWith('en') ? 'en' : 'fr';
  const isEnglish = lang === 'en';
  res.status(err.status || 500).json({
    error: err.code || 'errors.server.internal',
    message: err.message || (isEnglish ? 'Internal error' : 'Erreur interne'),
  });
});

const PORT = config.PORT;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ SXB VPN Backend API online on PORT ${PORT}`);
});
