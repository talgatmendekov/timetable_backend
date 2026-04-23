// src/models/Schedule.js
const pool = require('../config/database');

class Schedule {
  static async getAll() {
    const result = await pool.query(
      'SELECT * FROM schedules ORDER BY group_name, day, time'
    );
    const schedules = {};
    result.rows.forEach(row => {
      const key = `${row.group_name}-${row.day}-${row.time}`;
      schedules[key] = {
        id:          row.id,
        group:       row.group_name,
        day:         row.day,
        time:        row.time,
        course:      row.course,
        teacher:     row.teacher      || '',
        room:        row.room         || '',
        subjectType: row.subject_type || 'lecture',
        duration:    row.duration     || 1,
        meetingLink: row.meeting_link || '',
      };
    });
    return schedules;
  }

  static async upsert(groupName, day, time, course, teacher, room, subjectType, duration, meetingLink) {
    const result = await pool.query(
      `INSERT INTO schedules (group_name, day, time, course, teacher, room, subject_type, duration, meeting_link)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (group_name, day, time)
       DO UPDATE SET
         course       = $4,
         teacher      = $5,
         room         = $6,
         subject_type = $7,
         duration     = $8,
         meeting_link = $9,
         updated_at   = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        groupName,
        day,
        time,
        course,
        teacher      || null,
        room         || null,
        subjectType  || 'lecture',
        duration     || 1,
        meetingLink  || '',
      ]
    );
    return result.rows[0];
  }

  static async delete(groupName, day, time) {
    const result = await pool.query(
      'DELETE FROM schedules WHERE group_name = $1 AND day = $2 AND time = $3 RETURNING *',
      [groupName, day, time]
    );
    return result.rows[0];
  }

  static async deleteByGroup(groupName) {
    const result = await pool.query(
      'DELETE FROM schedules WHERE group_name = $1',
      [groupName]
    );
    return result.rowCount;
  }

  static async getByDay(day) {
    const result = await pool.query(
      'SELECT * FROM schedules WHERE day = $1 ORDER BY time, group_name',
      [day]
    );
    return result.rows;
  }

  static async getByTeacher(teacher) {
    const result = await pool.query(
      'SELECT * FROM schedules WHERE teacher = $1 ORDER BY day, time',
      [teacher]
    );
    return result.rows;
  }

  static async getByGroup(groupName) {
    const result = await pool.query(
      'SELECT * FROM schedules WHERE group_name = $1 ORDER BY day, time',
      [groupName]
    );
    return result.rows;
  }

  static async getAllTeachers() {
    const result = await pool.query(
      `SELECT DISTINCT teacher FROM schedules
       WHERE teacher IS NOT NULL AND teacher != ''
       ORDER BY teacher`
    );
    return result.rows.map(row => row.teacher);
  }
}

module.exports = Schedule;