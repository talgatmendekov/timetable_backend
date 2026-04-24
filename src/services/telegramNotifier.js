// Backend: src/services/telegramNotifier.js
const { Telegraf } = require('telegraf');
const pool = require('../config/database');

class TelegramNotifier {
  constructor() {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.warn('⚠️  TelegramNotifier: TELEGRAM_BOT_TOKEN not set — bot disabled');
      this.bot = null;
      return;
    }
    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
    this.setupBot();
    this.setupFeedback();
  }

  setupBot() {
    if (!this.bot) return; // no token — skip

    const webhookDomain = process.env.WEBHOOK_DOMAIN
  || (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null);

    if (webhookDomain) {
      // ── WEBHOOK MODE — no polling, no 409 conflicts ──────────────────────
      const webhookPath = `/telegram-webhook-${process.env.TELEGRAM_BOT_TOKEN.slice(-10)}`;
      this.bot.telegram.setWebhook(`${webhookDomain}${webhookPath}`, {
        drop_pending_updates: true,
      }).then(() => {
        console.log(`✅ Telegram webhook set: ${webhookDomain}${webhookPath}`);
      }).catch(err => {
        console.error('Failed to set webhook:', err.message);
      });
      // Store webhook path so server.js can register the route
      this.webhookPath   = webhookPath;
      this.webhookMiddleware = this.bot.webhookCallback(webhookPath);
      console.log('✅ Telegram bot started (webhook mode)');
    } else {
      // ── POLLING MODE fallback (local dev only) ───────────────────────────
      setTimeout(() => {
        this.bot.telegram.deleteWebhook({ drop_pending_updates: true })
          .then(() => this.bot.telegram.callApi('close').catch(() => {}))
          .then(() => new Promise(r => setTimeout(r, 3000)))
          .then(() => {
            this.bot.launch({ dropPendingUpdates: true });
            console.log('✅ Telegram bot started (polling mode)');
          })
          .catch(err => {
            console.error('Polling launch failed:', err.message);
          });
      }, 5000);
    } // end polling mode

    // ── Security middleware: rate-limit + unknown user protection ──────────
    const userLastSeen = {}; // telegramId → timestamp
    this.bot.use(async (ctx, next) => {
      const id  = ctx.from?.id;
      const now = Date.now();

      // Rate limit: max 1 message per 3 seconds per user
      if (id) {
        if (userLastSeen[id] && now - userLastSeen[id] < 3000) {
          return; // silently drop — no reply encourages spammers
        }
        userLastSeen[id] = now;
      }

      // Allow /start and /feedback for anyone (public commands)
      const text = ctx.message?.text || '';
      if (text.startsWith('/start') || text.startsWith('/feedback')) return next();

      // For all other commands: only allow registered teachers
      if (id) {
        try {
          const r = await pool.query(
            'SELECT id FROM teachers WHERE telegram_id = $1',
            [id.toString()]
          );
          if (r.rows.length > 0) return next(); // registered teacher — allow
        } catch (e) { /* db error — fail safe, allow */ return next(); }
      }

      // Unknown user — silently ignore (no reply = no confirmation bot exists)
      console.log(`Blocked unknown Telegram user: ${id} (@${ctx.from?.username || 'unknown'})`);
    });

    // /chatid — returns the current chat ID (for group setup verification)
    this.bot.command('chatid', (ctx) => {
      const chatId   = ctx.chat?.id;
      const chatType = ctx.chat?.type;
      const chatName = ctx.chat?.title || ctx.chat?.username || 'private';
      ctx.reply(
        `Chat ID: <code>${chatId}</code>
Type: ${chatType}
Name: ${chatName}

Copy this ID into the admin panel for this group.`,
        { parse_mode: 'HTML' }
      );
    });

    // /start — teacher gets their Telegram ID
    this.bot.command('start', async (ctx) => {
      const telegramId = ctx.from.id;
      const username   = ctx.from.username || ctx.from.first_name;
      ctx.reply(
        `Welcome to University Schedule Bot! 🎓\n\n` +
        `Your Telegram ID: <code>${telegramId}</code>\n` +
        `Username: @${username}\n\n` +
        `Please ask your admin to link this ID to your teacher account.`,
        { parse_mode: 'HTML' }
      );
    });

    // /status — check if linked
    this.bot.command('status', async (ctx) => {
      const telegramId = ctx.from.id;
      try {
        const result = await pool.query(
          'SELECT name FROM teachers WHERE telegram_id = $1',
          [telegramId.toString()]
        );
        if (result.rows.length > 0) {
          ctx.reply(`✅ You are registered as <b>${result.rows[0].name}</b>.`, { parse_mode: 'HTML' });
        } else {
          ctx.reply(
            `❌ Not registered yet.\n\nYour Telegram ID: <code>${telegramId}</code>\nAsk your admin to link it.`,
            { parse_mode: 'HTML' }
          );
        }
      } catch {
        ctx.reply('Error checking status. Please try again later.');
      }
    });

  }

  // ── Core send ───────────────────────────────────────────────────────────────

  async sendMessage(chatId, message) {
    try {
      await this.bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
      return true;
    } catch (error) {
      console.error(`Failed to send to ${chatId}:`, error.message);
      return false;
    }
  }

  // ── Schedule change notifications ───────────────────────────────────────────
  // Called from scheduleRoutes whenever a class is added, updated, or deleted.
  // changeType: 'added' | 'updated' | 'deleted'
  // classData:  { group, day, time, course, teacher, room, duration }
  // oldData:    previous classData (only for 'updated')

  async isNotificationsEnabled() {
    try {
      const { rows } = await pool.query(
        "SELECT value FROM app_settings WHERE key = 'notifications_enabled'"
      );
      return rows[0]?.value !== 'false';
    } catch {
      return true; // default to enabled if table doesn't exist yet
    }
  }

  async notifyScheduleChange(changeType, classData, oldData = null) {
    if (!classData) return;

    // Check global notifications master switch
    const enabled = await this.isNotificationsEnabled();
    if (!enabled) {
      console.log('⚠️ Notifications disabled globally — skipping notification');
      return;
    }

    const { group, teacher } = classData;

    // 1. Notify the teacher personally
    try {
      const { rows } = await pool.query(
        `SELECT telegram_id FROM teachers
         WHERE LOWER(name) = LOWER($1)
           AND telegram_id IS NOT NULL
           AND notifications_enabled = true`,
        [teacher || '']
      );
      if (rows.length > 0) {
        await this.sendMessage(rows[0].telegram_id, this._teacherMsg(changeType, classData, oldData));
      }
    } catch (e) {
      console.error('notifyScheduleChange (teacher):', e.message);
    }

    // 2. Notify the group channel
    try {
      const { rows } = await pool.query(
        `SELECT chat_id FROM group_channels WHERE group_name = $1`,
        [group]
      );
      if (rows.length > 0) {
        await this.sendMessage(rows[0].chat_id, this._groupMsg(changeType, classData, oldData));
      }
    } catch (e) {
      console.error('notifyScheduleChange (group):', e.message);
    }
  }

  _teacherMsg(changeType, data, oldData) {
    const { group, day, time, course, room, duration } = data;
    const dur = duration > 1 ? ` (${duration * 40} min)` : '';
    const base = `📚 <b>${course}</b>\n👥 Group: ${group}\n📅 ${day}  ⏰ ${time}${dur}\n🏫 Room: ${room || 'TBA'}`;
    const header = `🏛 <b>Alatoo International University</b>\n<i>Faculty Administration</i>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    const footer = `\n\n━━━━━━━━━━━━━━━━━━━━━━\n<i>— Faculty Administration</i>`;

    if (changeType === 'added')
      return `${header}📅 <b>New Class Added to Your Schedule</b>\n\n${base}${footer}`;
    if (changeType === 'deleted')
      return `${header}🗑 <b>Class Removed from Your Schedule</b>\n\n${base}${footer}`;

    const diff = this._diff(oldData, data);
    return `${header}✏️ <b>Schedule Update</b>\n\n${base}${diff ? `\n\n<b>Changes:</b>\n${diff}` : ''}${footer}`;
  }

  _groupMsg(changeType, data, oldData) {
    const { day, time, course, teacher, room, duration } = data;
    const dur = duration > 1 ? ` (${duration * 40} min)` : '';
    const base = `📚 <b>${course}</b>\n👨‍🏫 Lecturer: ${teacher || 'TBA'}\n📅 ${day}  ⏰ ${time}${dur}\n🏫 Room: ${room || 'TBA'}`;
    const header = `🏛 <b>Alatoo International University</b>\n<i>Faculty Administration</i>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    const footer = `\n\n━━━━━━━━━━━━━━━━━━━━━━\n<i>— Faculty Administration</i>`;

    if (changeType === 'added')
      return `${header}📅 <b>New Class Added to Your Schedule</b>\n\n${base}${footer}`;
    if (changeType === 'deleted')
      return `${header}🗑 <b>Class Cancelled</b>\n\n${base}${footer}`;

    const diff = this._diff(oldData, data);
    return `${header}✏️ <b>Schedule Update</b>\n\n${base}${diff ? `\n\n<b>Changes:</b>\n${diff}` : ''}${footer}`;
  }

  _diff(oldData, newData) {
    if (!oldData) return '';
    const fields = { course: '📚 Course', room: '🏫 Room', day: '📅 Day', time: '⏰ Time', teacher: '👨‍🏫 Teacher' };
    return Object.entries(fields)
      .filter(([k]) => oldData[k] !== newData[k])
      .map(([k, label]) => `  ${label}: ${oldData[k] || '—'} → ${newData[k] || '—'}`)
      .join('\n');
  }

  // ── /feedback — multi-step conversation ──────────────────────────────────
  setupFeedback() {
    if (!this.bot) return;
    const API = process.env.REACT_APP_API_URL ||
                process.env.API_URL           ||
                'https://timetablebackend-production.up.railway.app/api';

    // In-memory conversation state: telegramId → { step, data }
    const sessions = {};

    const CATEGORIES = ['🏛 Room', '👨‍🏫 Teacher', '👥 Group', '📝 General'];
    const CAT_MAP    = { '🏛 Room':'room', '👨‍🏫 Teacher':'teacher', '👥 Group':'group', '📝 General':'general' };

    this.bot.command('feedback', async (ctx) => {
      const id = ctx.from.id.toString();
      sessions[id] = { step: 'category', data: {} };
      await ctx.reply(
        `📝 <b>Submit Feedback</b>

` +
        `Your feedback helps improve the schedule and facilities.

` +
        `<b>Step 1/4</b> — What is your feedback about?`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: CATEGORIES.map(c => [{ text: c }]),
            one_time_keyboard: true,
            resize_keyboard: true,
          },
        }
      );
    });

    // Handle conversation steps
    this.bot.on('text', async (ctx) => {
      const id   = ctx.from.id.toString();
      const text = ctx.message.text.trim();
      const sess = sessions[id];
      if (!sess) return; // no active session — ignore

      // ── Step 1: category ──────────────────────────────────────────────
      if (sess.step === 'category') {
        const catLabel = CATEGORIES.find(c => c === text);
        if (!catLabel) {
          return ctx.reply('Please choose one of the options above.');
        }
        sess.data.category  = CAT_MAP[catLabel];
        sess.data.catLabel  = catLabel;
        sess.step = 'subject';

        let prompt = '';
        if (sess.data.category === 'room')    prompt = 'Which room? (e.g. B201)';
        if (sess.data.category === 'teacher') prompt = 'Which teacher? (enter their name)';
        if (sess.data.category === 'group')   prompt = 'Which group? (e.g. CS-22)';
        if (sess.data.category === 'general') {
          sess.data.subject = 'General';
          sess.step = 'message';
          return ctx.reply(
            `<b>Step 3/4</b> — Write your feedback message:`,
            { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
          );
        }
        await ctx.reply(
          `<b>Step 2/4</b> — ${prompt}`,
          { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
        );

      // ── Step 2: subject ───────────────────────────────────────────────
      } else if (sess.step === 'subject') {
        sess.data.subject = text;
        sess.step = 'message';
        await ctx.reply(
          `<b>Step 3/4</b> — Write your feedback message:
` +
          `<i>Example: "Room is always too cold", "Class was cancelled but not updated", "Teacher always late"</i>`,
          { parse_mode: 'HTML' }
        );

      // ── Step 3: message ───────────────────────────────────────────────
      } else if (sess.step === 'message') {
        if (text.length < 5)
          return ctx.reply('Please write a more detailed message (at least 5 characters).');
        sess.data.message = text;
        sess.step = 'anonymous';
        await ctx.reply(
          `<b>Step 4/4</b> — Submit anonymously or with your name?

` +
          `• <b>Anonymous</b> — admin sees the feedback but not who sent it
` +
          `• <b>With name</b> — admin can follow up with you`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              keyboard: [[{ text: '🔒 Anonymous' }, { text: '👤 With my name' }]],
              one_time_keyboard: true,
              resize_keyboard: true,
            },
          }
        );

      // ── Step 4: anonymous choice ──────────────────────────────────────
      } else if (sess.step === 'anonymous') {
        const isAnon = text.includes('Anonymous') || text.includes('🔒');
        sess.data.anonymous   = isAnon;
        sess.data.telegram_id = ctx.from.id.toString();
        sess.data.sender_name = isAnon ? null
          : (ctx.from.first_name + (ctx.from.last_name ? ' ' + ctx.from.last_name : '') +
             (ctx.from.username ? ` (@${ctx.from.username})` : ''));

        // Submit to API
        try {
          const res = await fetch(`${API}/feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sess.data),
          });
          const json = await res.json();
          if (json.success) {
            await ctx.reply(
              `✅ <b>Feedback submitted!</b>

` +
              `Category: ${sess.data.catLabel}
` +
              `About: ${sess.data.subject}
` +
              (isAnon ? '🔒 Submitted anonymously' : `👤 Submitted as ${sess.data.sender_name}`) +
              `

Thank you — your feedback helps improve the university.`,
              { parse_mode: 'HTML', reply_markup: { remove_keyboard: true } }
            );
          } else {
            await ctx.reply('❌ Failed to submit. Please try again later.');
          }
        } catch (e) {
          await ctx.reply('❌ Server error. Please try again later.');
        }
        delete sessions[id]; // clear session
      }
    });
  }

  stop() {
    if (this.bot) this.bot.stop('SIGTERM');
  }
}

// Singleton so only one bot instance is created
let _instance = null;

TelegramNotifier.getInstance = function() {
  if (!_instance) _instance = new TelegramNotifier();
  return _instance;
};

module.exports = TelegramNotifier;