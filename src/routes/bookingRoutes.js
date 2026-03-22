// src/routes/bookingRoutes.js
const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// ── Auto-add columns if missing ──────────────────────────────────────────────
pool.query('ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS entity   VARCHAR(200)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS email    VARCHAR(200)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ADD COLUMN IF NOT EXISTS end_time VARCHAR(20)').catch(()=>{});

// ── Fix column lengths (safe to run every restart, only widens) ──────────────
pool.query('ALTER TABLE booking_requests ALTER COLUMN start_time TYPE VARCHAR(20)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ALTER COLUMN end_time   TYPE VARCHAR(20)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ALTER COLUMN status     TYPE VARCHAR(20)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ALTER COLUMN room       TYPE VARCHAR(100)').catch(()=>{});
pool.query('ALTER TABLE booking_requests ALTER COLUMN phone      TYPE VARCHAR(30)').catch(()=>{});
pool.query('ALTER TABLE schedules        ALTER COLUMN time       TYPE VARCHAR(20)').catch(()=>{});

const deleteExpired = async () => {
  try {
    // end_time is stored as "HH:MM-HH:MM" (full slot string) — extract just the end part
    // e.g. "08:00-08:40" → end is "08:40"
    // Also handle plain "08:40" format
    const expired = await pool.query(`
      SELECT id, entity, name, day, start_time, end_time, room FROM booking_requests
      WHERE status = 'approved'
        AND end_time IS NOT NULL AND end_time != ''
        AND EXTRACT(DOW FROM NOW()) = CASE day
          WHEN 'Monday'    THEN 1 WHEN 'Tuesday'   THEN 2 WHEN 'Wednesday' THEN 3
          WHEN 'Thursday'  THEN 4 WHEN 'Friday'    THEN 5 WHEN 'Saturday'  THEN 6
          ELSE 0 END
    `);

    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const b of expired.rows) {
      // Parse end time — handle both "08:40" and "08:00-08:40" formats
      const rawEnd = String(b.end_time).includes('-')
        ? String(b.end_time).split('-').pop().trim()
        : String(b.end_time).trim();
      const [endH, endM] = rawEnd.split(':').map(Number);
      if (isNaN(endH) || isNaN(endM)) continue;
      const endMins = endH * 60 + endM;

      if (nowMins < endMins) continue; // not expired yet

      const groupName = (b.entity && b.entity.trim()) ? b.entity.trim() : (b.name || 'Booking');
      await pool.query(
        `DELETE FROM schedules WHERE group_name=$1 AND day=$2 AND time=$3 AND room=$4`,
        [groupName, b.day, b.start_time, b.room]
      );
      await pool.query(`DELETE FROM booking_requests WHERE id=$1`, [b.id]);
      console.log(`Auto-expired booking: ${groupName} ${b.day} ${b.start_time} → ${rawEnd}`);
    }
  } catch(e) { console.error('Auto-expire:', e.message); }
};

// ── Run auto-expire every 5 minutes independently (no need for a GET request) ─
setInterval(deleteExpired, 5 * 60 * 1000);
// Also run once on startup
deleteExpired().catch(() => {});

const notifyAdmin = async (b) => {
  try {
    const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
    if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return;
    const notifier = require('../services/telegramNotifier').getInstance();
    await notifier.sendMessage(chatId,
      `<b>New Lab Booking</b>\n\n<b>Name:</b> ${b.name}\n<b>Email:</b> ${b.email}\n<b>Phone:</b> ${b.phone||'—'}\n<b>Entity:</b> ${b.entity||'—'}\n<b>Day:</b> ${b.day}\n<b>Time:</b> ${b.start_time} - ${b.end_time}\n<b>Room:</b> ${b.room}\n<b>Purpose:</b> ${b.purpose}\n\n<i>Go to Lab Bookings to approve/reject.</i>`
    );
  } catch(e) { console.error('Admin notify:',e.message); }
};

// ── GET all bookings ─────────────────────────────────────────────────────────
router.get('/', async (req,res) => {
  try {
    await deleteExpired();
    const r = await pool.query('SELECT * FROM booking_requests ORDER BY created_at DESC');
    res.json({ success:true, data:r.rows });
  } catch(err) { res.status(500).json({ success:false, error:err.message }); }
});

// ── POST new booking request ─────────────────────────────────────────────────
router.post('/', async (req,res) => {
  try {
    const { name, email, phone, entity, day, start_time, end_time, purpose, room } = req.body;

    if (!name)
      return res.status(400).json({ success:false, error:'Name is required' });
    if (!email)
      return res.status(400).json({ success:false, error:'Email is required' });
    if (!String(email).toLowerCase().endsWith('@alatoo.edu.kg'))
      return res.status(400).json({ success:false, error:'Only @alatoo.edu.kg emails are permitted to book' });
    if (!day)
      return res.status(400).json({ success:false, error:'Day is required' });
    if (!start_time)
      return res.status(400).json({ success:false, error:'Start time is required' });
    if (!end_time)
      return res.status(400).json({ success:false, error:'End time is required' });
    if (!room)
      return res.status(400).json({ success:false, error:'Room is required' });
    if (!purpose)
      return res.status(400).json({ success:false, error:'Purpose is required' });

    const r = await pool.query(
      `INSERT INTO booking_requests
        (name, email, phone, entity, day, start_time, end_time, purpose, room, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
       RETURNING *`,
      [name, email, phone||'', entity||'', day, start_time, end_time, purpose, room]
    );

    const booking = r.rows[0];
    notifyAdmin(booking).catch(()=>{});
    res.json({ success:true, data:booking });
  } catch(err) {
    console.error('POST /booking-requests:', err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ── PUT approve / reject ─────────────────────────────────────────────────────
router.put('/:id', authenticateToken, async (req,res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status))
      return res.status(400).json({ success:false, error:'Invalid status' });

    const r = await pool.query(
      'UPDATE booking_requests SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (r.rowCount === 0)
      return res.status(404).json({ success:false, error:'Not found' });

    const b = r.rows[0];

    // Approved → insert into schedules so it appears on the timetable
    if (status === 'approved') {
      try {
        const groupName = (b.entity && b.entity.trim()) ? b.entity.trim() : (b.name || 'Booking');

        await pool.query(
          `INSERT INTO groups (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [groupName]
        );

        await pool.query(
          `INSERT INTO schedules (group_name, day, time, course, teacher, room, subject_type, duration)
           VALUES ($1, $2, $3, $4, $5, $6, 'other', 1)
           ON CONFLICT (group_name, day, time) DO UPDATE
             SET course=$4, teacher=$5, room=$6, subject_type='other', updated_at=NOW()`,
          [groupName, b.day, b.start_time, b.purpose, b.name, b.room]
        );

        console.log(`Booking approved: inserted schedule for ${groupName} on ${b.day} at ${b.start_time}`);
      } catch(schedErr) {
        console.error('Could not insert booking into schedule:', schedErr.message);
      }
    }

    // Rejected → remove from schedule + delete booking record entirely
    if (status === 'rejected') {
      try {
        const groupName = (b.entity && b.entity.trim()) ? b.entity.trim() : (b.name || 'Booking');
        await pool.query(
          `DELETE FROM schedules WHERE group_name=$1 AND day=$2 AND time=$3 AND room=$4`,
          [groupName, b.day, b.start_time, b.room]
        );
      } catch(e) { /* ignore */ }
      await pool.query('DELETE FROM booking_requests WHERE id=$1', [req.params.id]);
      return res.json({ success:true, deleted:true });
    }

    res.json({ success:true, data:b });
  } catch(err) {
    res.status(500).json({ success:false, error:err.message });
  }
});

// ── DELETE booking ───────────────────────────────────────────────────────────
router.delete('/:id', authenticateToken, async (req,res) => {
  try {
    // Fetch first so we know what to clean up from schedules
    const found = await pool.query(
      'SELECT * FROM booking_requests WHERE id=$1',
      [req.params.id]
    );
    if (found.rowCount === 0)
      return res.status(404).json({ success:false, error:'Not found' });

    const b = found.rows[0];
    const groupName = (b.entity && b.entity.trim()) ? b.entity.trim() : (b.name || 'Booking');

    // Remove from schedules (approved bookings live there)
    await pool.query(
      `DELETE FROM schedules WHERE group_name=$1 AND day=$2 AND time=$3 AND room=$4`,
      [groupName, b.day, b.start_time, b.room]
    ).catch(()=>{});

    // Clean up the auto-created group if it has no more schedules
    await pool.query(
      `DELETE FROM groups WHERE name=$1
       AND NOT EXISTS (SELECT 1 FROM schedules WHERE group_name=$1)`,
      [groupName]
    ).catch(()=>{});

    // Delete the booking record itself
    await pool.query('DELETE FROM booking_requests WHERE id=$1', [req.params.id]);

    res.json({ success:true });
  } catch(err) {
    res.status(500).json({ success:false, error:err.message });
  }
});

module.exports = router;