// routes/scheduleRoutes.js
const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const pool = require('../config/database');

// ── Telegram notifier (optional — won't crash if bot not configured) ─────────
function getNotifier() {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) return null;
    const { getNotifier: getCronNotifier } = require('../services/telegramCron');
    const notifier = getCronNotifier();
    if (!notifier) console.warn('⚠️ Telegram notifier not ready yet');
    return notifier;
  } catch (e) {
    console.error('⚠️ TelegramNotifier failed to load:', e.message);
    return null;
  }
}

function notify(changeType, classData, oldData = null) {
  const notifier = getNotifier();
  if (!notifier) {
    console.warn('⚠️ notify() skipped — notifier not available');
    return;
  }
  console.log(`📨 Sending ${changeType} notification for ${classData.course} (${classData.group})`);
  notifier.notifyScheduleChange(changeType, classData, oldData).catch(err => {
    console.error('Telegram notify error:', err.message);
  });
}
// ── GET all schedules ────────────────────────────────────────────────────────
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
        teacher:     row.teacher || '',
        room:        row.room || '',
        subjectType: row.subject_type || 'lecture',
        duration:    row.duration || 1,
      };
    });
    res.json(schedule);
  } catch (err) {
    console.error('GET /schedules error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST save/upsert one class ───────────────────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { group, day, time, course, teacher, room, subjectType, duration } = req.body;
    if (!group || !day || !time || !course)
      return res.status(400).json({ success: false, error: 'group, day, time, course are required' });

    // Check if class already exists (added vs updated)
    const existing = await pool.query(
      `SELECT course, teacher, room, subject_type, duration FROM schedules
       WHERE group_name=$1 AND day=$2 AND time=$3`,
      [group, day, time]
    );
    const isUpdate = existing.rows.length > 0;
    const oldData = isUpdate ? {
      group, day, time,
      course:      existing.rows[0].course,
      teacher:     existing.rows[0].teacher || '',
      room:        existing.rows[0].room || '',
      duration:    existing.rows[0].duration || 1,
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

// ── POST /bulk ───────────────────────────────────────────────────────────────
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
      await client.query(`INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`, [name]);
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

// ── DELETE one class ─────────────────────────────────────────────────────────
router.delete('/', authenticateToken, async (req, res) => {
  try {
    const { group, day, time } = req.body;
    if (!group || !day || !time)
      return res.status(400).json({ success: false, error: 'group, day, time are required' });

    // Fetch before deleting so we can notify
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
      notify('deleted', { group, day, time, course: r.course, teacher: r.teacher || '', room: r.room || '', duration: r.duration || 1 });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /schedules error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;