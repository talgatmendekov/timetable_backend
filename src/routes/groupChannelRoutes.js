// Backend: src/routes/groupChannelRoutes.js
const express = require('express');
const router  = express.Router();
const pool    = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Ensure table exists on startup
pool.query(`
  CREATE TABLE IF NOT EXISTS group_channels (
    group_name  TEXT PRIMARY KEY,
    chat_id     TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(err => console.error('group_channels table init:', err.message));

// GET all group channels
router.get('/', async (req, res) => {  // public — guests need group list too
  try {
    // Return all known groups, merging with channel rows so every group shows up
    const [groupsResult, channelsResult] = await Promise.all([
      pool.query('SELECT DISTINCT group_name FROM schedules ORDER BY group_name'),
      pool.query('SELECT * FROM group_channels ORDER BY group_name'),
    ]);


    console.log('group_channels raw:', JSON.stringify(channelsResult.rows));
    const channelMap = {};
    channelsResult.rows.forEach(r => { channelMap[r.group_name] = r.chat_id; });

    const data = groupsResult.rows.map(r => ({
      group_name: r.group_name,
      chat_id: channelMap[r.group_name] || null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET group-channels:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST / PUT — upsert a group channel
router.post('/', authenticateToken, async (req, res) => {
  console.log('POST /api/group-channels body:', JSON.stringify(req.body));
  // Accept both naming conventions
  const group_name = req.body.group_name || req.body.name || req.body.groupName;
  const chat_id    = req.body.chat_id    || req.body.chatId || req.body.chat;
  if (!group_name || !chat_id) {
    console.log('Missing fields — group_name:', group_name, 'chat_id:', chat_id);
    return res.status(400).json({ success: false, error: 'group_name and chat_id are required. Received: ' + JSON.stringify(req.body) });
  }
  try {
    await pool.query(`
      INSERT INTO group_channels (group_name, chat_id, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (group_name) DO UPDATE SET chat_id = $2, updated_at = NOW()
    `, [group_name, chat_id.toString()]);

    res.json({ success: true });
  } catch (err) {
    console.error('POST group-channels:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE a group — removes from schedules, groups, and group_channels
router.delete('/:groupName', authenticateToken, async (req, res) => {
  const groupName = decodeURIComponent(req.params.groupName);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // 1. Remove all schedule entries for this group
    await client.query('DELETE FROM schedules WHERE group_name = $1', [groupName]);
    // 2. Remove from group_channels
    await client.query('DELETE FROM group_channels WHERE group_name = $1', [groupName]);
    // 3. Remove from groups table (booking-created groups live here)
    await client.query('DELETE FROM groups WHERE name = $1', [groupName]);
    // 4. Also clean up any booking_requests tied to this entity
    await client.query(
      "DELETE FROM booking_requests WHERE entity = $1 OR name = $1",
      [groupName]
    );
    await client.query('COMMIT');
    console.log(`Deleted group + schedules: ${groupName}`);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('DELETE group-channels:', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;