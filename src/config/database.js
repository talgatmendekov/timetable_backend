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
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'university_schedule',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
    ssl: false
  };
};

const pool = new Pool(getPoolConfig());

pool.on('connect', () => console.log('✅ Database connected successfully'));
pool.on('error', (err) => console.error('❌ Database error:', err.message));

// ── Auto-migration: fix column sizes on every startup ─────────────────────────
const runMigrations = async () => {
  const client = await pool.connect();
  try {
    console.log('🔄 Running migrations...');

    // 1. Expand VARCHAR columns that are too small
    await client.query(`
      ALTER TABLE schedules
        ALTER COLUMN subject_type TYPE VARCHAR(50),
        ALTER COLUMN course       TYPE VARCHAR(200),
        ALTER COLUMN teacher      TYPE VARCHAR(100),
        ALTER COLUMN room         TYPE VARCHAR(50),
        ALTER COLUMN group_name   TYPE VARCHAR(50);
    `);

    // 2. Add meeting_link column if it doesn't exist yet
    await client.query(`
      ALTER TABLE schedules
        ADD COLUMN IF NOT EXISTS meeting_link VARCHAR(500) DEFAULT '';
    `);

    // 3. Add duration column if it doesn't exist yet
    await client.query(`
      ALTER TABLE schedules
        ADD COLUMN IF NOT EXISTS duration INTEGER DEFAULT 1;
    `);

    console.log('✅ Migrations complete');
  } catch (err) {
    // IF columns are already the right size, Postgres may still throw
    // on some versions — safe to ignore if it's just a no-op resize
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