// src/routes/announcementRoutes.js
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

// Init table
const initTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id         SERIAL PRIMARY KEY,
      message    TEXT NOT NULL,
      color      VARCHAR(20) DEFAULT 'blue',
      expires    DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
};
initTable().catch(console.error);

// GET all active announcements (public)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM announcements
       WHERE expires IS NULL OR expires >= CURRENT_DATE
       ORDER BY created_at DESC`
    );
    res.json({ success: true, data: r.rows });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// POST new announcement (admin only)
router.post('/', async (req, res) => {
  const { message, color = 'blue', expires = null } = req.body;
  if (!message?.trim()) return res.json({ success: false, error: 'Message required' });
  try {
    const r = await pool.query(
      `INSERT INTO announcements (message, color, expires) VALUES ($1,$2,$3) RETURNING *`,
      [message.trim(), color, expires || null]
    );
    res.json({ success: true, data: r.rows[0] });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// DELETE announcement (admin only)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query(`DELETE FROM announcements WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

module.exports = router;