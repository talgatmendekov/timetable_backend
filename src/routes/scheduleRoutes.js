// routes/scheduleRoutes.js
const express = require('express');
const router  = express.Router();
const https   = require('https');
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');

// ── Send Telegram message (same as broadcastRoutes — proven to work) ──────────
async function sendMsg(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  let normalizedChatId = chatId;
  if (typeof chatId === 'string' && !chatId.startsWith('@')) {
    const num = parseInt(chatId);
    if (!isNaN(num)) normalizedChatId = num;
  }

  const bodyStr = JSON.stringify({
    chat_id:    normalizedChatId,
    text,
    parse_mode: 'HTML',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            console.log(`✅ Notification sent to ${normalizedChatId}`);
          } else {
            console.error(`❌ Notification failed:`, result.description);
          }
        } catch (e) {
          console.error('Notification parse error:', e.message);
        }
        resolve();
      });
    });
    req.on('error', (e) => {
      console.error('Notification request error:', e.message);
      resolve();
    });
    req.write(bodyStr);
    req.end();
  });
}

// ── Build notification message ────────────────────────────────────────────────
function buildMsg(changeType, data, oldData) {
  const { day, time, course, teacher, room, duration } = data;
  const dur    = duration > 1 ? ` (${duration * 40} min)` : '';
  const base   = `📚 <b>${course}</b>\n👨‍🏫 Lecturer: ${teacher || 'TBA'}\n📅 ${day}  ⏰ ${time}${dur}\n🏫 Room: ${room || 'TBA'}`;
  const header = `🏛 <b>Alatoo International University</b>\n<i>Faculty Administration</i>\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
  const footer = `\n\n━━━━━━━━━━━━━━━━━━━━━━\n<i>— Faculty Administration</i>`;

  if (changeType === 'added')
    return `${header}📅 <b>New Class Added</b>\n\n${base}${footer}`;
  if (changeType === 'deleted')
    return `${header}🗑 <b>Class Cancelled</b>\n\n${base}${footer}`;

  // updated — show diff
  const fields = { course: '📚 Course', room: '🏫 Room', day: '📅 Day', time: '⏰ Time', teacher: '👨‍🏫 Teacher' };
  const diff = oldData
    ? Object.entries(fields)
        .filter(([k]) => oldData[k] !== data[k])
        .map(([k, label]) => `  ${label}: ${oldData[k] || '—'} → ${data[k] || '—'}`)
        .join('\n')
    : '';
  return `${header}✏️ <b>Schedule Update</b>\n\n${base}${diff ? `\n\n<b>Changes:</b>\n${diff}` : ''}${footer}`;
}

// ── Notify group channel ──────────────────────────────────────────────────────
async function notify(changeType, classData, oldData = null) {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const { group } = classData;
  try {
    const { rows } = await pool.query(
      `SELECT chat_id FROM group_channels WHERE group_name = $1`,
      [group]
    );
    if (rows.length > 0 && rows[0].chat_id) {
      await sendMsg(rows[0].chat_id, buildMsg(changeType, classData, oldData));
      console.log(`📨 Notified group channel: ${group}`);
    } else {
      console.warn(`⚠️ No channel found for group: "${group}"`);
    }
  } catch (e) {
    console.error('notify error:', e.message);
  }
}

// ── GET all schedules ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT group_name, day, time, course, teacher, room, subject_type, duration
       FROM schedules ORDER BY day, time, group_name`
    );
    const schedule = {};
    result.rows.forEach(row => {
      const key = `${row.group_name}-${row.day}-${row.time}`;
      schedule[key] = {
        group:       row.group_name,
        day:         row.day,
        time:        row.time,
        course:      row.course,
        teacher:     row.teacher     || '',
        room:        row.room        || '',
        subjectType: row.subject_type || 'lecture',
        duration:    row.duration    || 1,
      };
    });
    res.json(schedule);
  } catch (err) {
    console.error('GET /schedules error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST save/upsert one class ────────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { group, day, time, course, teacher, room, subjectType, duration } = req.body;
    if (!group || !day || !time || !course)
      return res.status(400).json({ success: false, error: 'group, day, time, course are required' });

    // Check if already exists (added vs updated)
    const existing = await pool.query(
      `SELECT course, teacher, room, subject_type, duration FROM schedules
       WHERE group_name=$1 AND day=$2 AND time=$3`,
      [group, day, time]
    );
    const isUpdate = existing.rows.length > 0;
    const oldData  = isUpdate ? {
      group, day, time,
      course:   existing.rows[0].course,
      teacher:  existing.rows[0].teacher  || '',
      room:     existing.rows[0].room     || '',
      duration: existing.rows[0].duration || 1,
    } : null;

    await pool.query(
      `INSERT INTO schedules (group_name, day, time, course, teacher, room, subject_type, duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (group_name, day, time) DO UPDATE SET
         course       = EXCLUDED.course,
         teacher      = EXCLUDED.teacher,
         room         = EXCLUDED.room,
         subject_type = EXCLUDED.subject_type,
         duration     = EXCLUDED.duration,
         updated_at   = CURRENT_TIMESTAMP`,
      [group, day, time, course, teacher || '', room || '', subjectType || 'lecture', duration || 1]
    );

    const classData = { group, day, time, course, teacher: teacher || '', room: room || '', duration: duration || 1 };
    notify(isUpdate ? 'updated' : 'added', classData, oldData);

    res.json({ success: true });
  } catch (err) {
    console.error('POST /schedules error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /bulk ────────────────────────────────────────────────────────────────
router.post('/bulk', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const body = req.body;
    let entries = [];
    let groupNames = new Set();

    if (Array.isArray(body)) {
      entries = body;
    } else if (body.schedule) {
      entries = Object.values(body.schedule);
      if (Array.isArray(body.groups)) body.groups.forEach(g => groupNames.add(g));
    } else {
      return res.status(400).json({ success: false, error: 'Body must be an array or { groups, schedule }' });
    }

    if (entries.length === 0)
      return res.status(400).json({ success: false, error: 'No entries provided' });

    entries.forEach(e => { if (e.group) groupNames.add(e.group); });

    await client.query('BEGIN');
    for (const name of groupNames) {
      await client.query(
        `INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [name]
      );
    }
    let inserted = 0;
    for (const e of entries) {
      if (!e.group || !e.day || !e.time || !e.course) continue;
      await client.query(
        `INSERT INTO schedules (group_name, day, time, course, teacher, room, subject_type, duration)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (group_name, day, time) DO UPDATE SET
           course=$4, teacher=$5, room=$6, subject_type=$7, duration=$8, updated_at=CURRENT_TIMESTAMP`,
        [e.group, e.day, e.time, e.course, e.teacher || '', e.room || '', e.subjectType || 'lecture', e.duration || 1]
      );
      inserted++;
    }
    await client.query('COMMIT');
    console.log(`✅ Bulk import: ${inserted} classes, ${groupNames.size} groups`);
    res.json({ success: true, imported: inserted, groups: groupNames.size });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /schedules/bulk error:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE one class ──────────────────────────────────────────────────────────
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const { group, day, time } = req.body;
    if (!group || !day || !time)
      return res.status(400).json({ success: false, error: 'group, day, time are required' });

    const existing = await pool.query(
      `SELECT course, teacher, room, duration FROM schedules
       WHERE group_name=$1 AND day=$2 AND time=$3`,
      [group, day, time]
    );

    await pool.query(
      `DELETE FROM schedules WHERE group_name=$1 AND day=$2 AND time=$3`,
      [group, day, time]
    );

    if (existing.rows.length > 0) {
      const r = existing.rows[0];
      notify('deleted', {
        group, day, time,
        course:   r.course,
        teacher:  r.teacher  || '',
        room:     r.room     || '',
        duration: r.duration || 1,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /schedules error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;