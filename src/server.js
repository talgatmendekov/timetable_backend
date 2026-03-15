const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
require('dotenv').config();

process.on('unhandledRejection', (reason, promise) => {
  console.error('⚠️  Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception:', err);
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  process.exit(1);
});

const authRoutes         = require('./routes/authRoutes');
const scheduleRoutes     = require('./routes/scheduleRoutes');
const bookingRoutes      = require('./routes/bookingRoutes');
const teacherRoutes      = require('./routes/teacherRoutes');
const groupChannelRoutes = require('./routes/groupChannelRoutes');
const groupRoutes        = require('./routes/groupRoutes');        // ← NEW
const broadcastRoutes    = require('./routes/broadcastRoutes');

let startTelegramNotifications = null;
try {
  const telegram = require('./services/telegramCron');
  startTelegramNotifications = telegram.startTelegramNotifications;
  console.log('📦 Telegram module loaded successfully');
} catch (error) {
  console.error('⚠️ Could not load Telegram modules:', error.message);
}

const app  = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(helmet());

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

const bulkImportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: 'Too many bulk import requests, please wait a moment.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
});

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 2000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === 'OPTIONS',
  keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
});

app.use('/api/schedules/bulk', bulkImportLimiter);
app.use('/api/', limiter);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    telegram: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
  });
});

// ── Run urgent migrations on startup ─────────────────────────────────────────
(async () => {
  try {
    const pool = require('./config/database');
    await pool.query(`ALTER TABLE schedules ALTER COLUMN time TYPE VARCHAR(20)`);
    await pool.query(`ALTER TABLE schedules ALTER COLUMN subject_type TYPE VARCHAR(50)`);
    console.log('✅ Column migrations applied');
  } catch(e) {
    console.warn('Migration warning (non-fatal):', e.message);
  }
})();

// ── API routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',             authRoutes);
app.use('/api/schedules',        scheduleRoutes);
app.use('/api/booking-requests', bookingRoutes);
app.use('/api/teachers',         teacherRoutes);
app.use('/api/groups',           groupRoutes);           // ← plain string array
app.use('/api/group-channels',   groupChannelRoutes);    // ← {group_name, chat_id}
app.use('/api/broadcast',        broadcastRoutes);
app.use('/api/announcements', require('./routes/announcementRoutes'));

const settingsRoutes = require('./routes/settingsRoutes');
app.use('/api/settings', settingsRoutes);

const examRoutes = require('./routes/examRoutes');
app.use('/api/exams', examRoutes);

let feedbackRoutes;
try {
  feedbackRoutes = require('./routes/feedbackRoutes');
  app.use('/api/feedback', feedbackRoutes);
  console.log('✅ Feedback routes loaded');
} catch(e) {
  console.warn('⚠️  feedbackRoutes not found, registering inline fallback');
  app.post('/api/feedback', async (req, res) => {
    const { category, subject, message, anonymous, sender_name } = req.body;
    if (!category || !subject || !message?.trim())
      return res.status(400).json({ success: false, error: 'category, subject, message required' });
    try {
      const pool = require('./config/database');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS feedback (
          id SERIAL PRIMARY KEY, category TEXT NOT NULL, subject TEXT NOT NULL,
          message TEXT NOT NULL, anonymous BOOLEAN NOT NULL DEFAULT true,
          telegram_id TEXT, sender_name TEXT,
          status TEXT NOT NULL DEFAULT 'new', created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      const isAnon = anonymous !== false;
      const result = await pool.query(
        `INSERT INTO feedback (category, subject, message, anonymous, sender_name)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [category, subject, message.trim(), isAnon, isAnon ? null : (sender_name || null)]
      );
      res.json({ success: true, data: result.rows[0] });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.get('/api/feedback/stats', async (req, res) => {
    try {
      const pool = require('./config/database');
      const total  = await pool.query('SELECT COUNT(*) FROM feedback');
      const unread = await pool.query("SELECT COUNT(*) FROM feedback WHERE status='new'");
      res.json({ success: true, total: parseInt(total.rows[0].count), unread: parseInt(unread.rows[0].count), byCategory: [], bySubject: [] });
    } catch { res.json({ success: true, total: 0, unread: 0, byCategory: [], bySubject: [] }); }
  });
  app.get('/api/feedback', async (req, res) => {
    try {
      const pool = require('./config/database');
      const r = await pool.query('SELECT * FROM feedback ORDER BY created_at DESC');
      res.json({ success: true, data: r.rows });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

const claudeRoutes = require('./routes/claudeRoutes');
app.use('/api/claude', claudeRoutes);

const publicScheduleRoute = require('./routes/publicScheduleRoute');
app.use('/schedule', publicScheduleRoute);

let _telegramWebhookMiddleware = null;
let _telegramWebhookPath       = null;
app.use((req, res, next) => {
  if (_telegramWebhookPath && req.path === _telegramWebhookPath && req.method === 'POST') {
    return _telegramWebhookMiddleware(req, res, next);
  }
  next();
});
app.setTelegramWebhook = (path, middleware) => {
  _telegramWebhookPath       = path;
  _telegramWebhookMiddleware = middleware;
  console.log(`✅ Telegram webhook route active: ${path}`);
};

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error',
  });
});

const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║   🎓 University Schedule Backend API                  ║
║   Port: ${PORT}  |  Env: ${process.env.NODE_ENV || 'development'}                    ║
║   CORS: Enabled  |  Rate limit: 2000/15min            ║
║   Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '❌ Not configured'}                     ║
╚═══════════════════════════════════════════════════════╝
  `);

  if (startTelegramNotifications) {
    console.log('🔄 Initializing Telegram service...');
    setTimeout(() => {
      try {
        startTelegramNotifications();
        try {
          const { getNotifier } = require('./services/telegramCron');
          setTimeout(() => {
            const notifier = getNotifier();
            if (notifier?.webhookMiddleware && notifier?.webhookPath) {
              app.setTelegramWebhook(notifier.webhookPath, notifier.webhookMiddleware);
            }
          }, 1000);
        } catch(e) { /* ignore */ }
      } catch (error) {
        console.error('❌ Failed to start Telegram service:', error.message);
      }
    }, 1000);
  } else {
    console.log('⚠️ Telegram service not available — server continues without it');
  }
});

const shutdown = (signal) => {
  console.log(`${signal} received: closing HTTP server`);
  try {
    const notifier = require('./services/telegramNotifier');
    const instance = notifier.getInstance ? notifier.getInstance() : null;
    if (instance?.bot) { instance.bot.stop(signal); console.log('Telegram bot stopped'); }
  } catch(e) { }
  server.close(() => { console.log('HTTP server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;