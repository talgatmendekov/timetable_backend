// src/config/database.js
const { Pool } = require('pg');
require('dotenv').config();

const getPoolConfig = () => {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    };
  }
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME     || 'university_schedule',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl:      false
  };
};

const pool = new Pool(getPoolConfig());

pool.on('connect', () => console.log('✅ Database connected successfully'));
pool.on('error', (err) => console.error('❌ Database error:', err.message));

// ── Auto-migration: runs on every startup ─────────────────────────────────────
const runMigrations = async () => {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');

    // 1. Expand VARCHAR columns in schedules that are too small
    await client.query(`
      ALTER TABLE schedules
        ALTER COLUMN subject_type TYPE VARCHAR(50),
        ALTER COLUMN course       TYPE VARCHAR(200),
        ALTER COLUMN teacher      TYPE VARCHAR(100),
        ALTER COLUMN room         TYPE VARCHAR(50),
        ALTER COLUMN group_name   TYPE VARCHAR(50);
    `);

    // 2. Add meeting_link column if missing
    await client.query(`
      ALTER TABLE schedules
        ADD COLUMN IF NOT EXISTS meeting_link VARCHAR(500) DEFAULT '';
    `);

    // 3. Add duration column if missing
    await client.query(`
      ALTER TABLE schedules
        ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 1;
    `);

    // 4. Create teachers table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS teachers (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        telegram_id VARCHAR(50),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 5. Create group_channels table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS group_channels (
        id         SERIAL PRIMARY KEY,
        group_name VARCHAR(50) NOT NULL UNIQUE,
        chat_id    VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 6. Create broadcast_log table if missing
    await client.query(`
      CREATE TABLE IF NOT EXISTS broadcast_log (
        id              SERIAL PRIMARY KEY,
        subject         TEXT,
        message         TEXT,
        recipient_count INT,
        sent_count      INT,
        failed_count    INT,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('✅ Migrations complete');
  } catch (err) {
    if (err.message.includes('cannot be cast')) {
      console.warn('⚠️ Migration warning (non-critical):', err.message);
    } else {
      console.error('❌ Migration error:', err.message);
    }
  } finally {
    client.release();
  }
};

// Run migrations after a short delay to ensure DB is ready
setTimeout(runMigrations, 2000);

module.exports = pool;