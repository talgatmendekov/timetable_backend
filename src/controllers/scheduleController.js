// src/controllers/scheduleController.js
const Schedule = require('../models/Schedule');
const Group = require('../models/Group');

class ScheduleController {
  static async getAll(req, res) {
    try {
      const schedules = await Schedule.getAll();
      res.json(schedules);
    } catch (error) {
      console.error('Get all schedules error:', error);
      res.status(500).json({ success: false, error: 'Server error fetching schedules' });
    }
  }

  static async createOrUpdate(req, res) {
    try {
      const { group, day, time, course, teacher, room, subjectType, duration, meetingLink } = req.body;

      // Verify group exists
      const groupExists = await Group.exists(group);
      if (!groupExists) {
        return res.status(400).json({ success: false, error: 'Group does not exist' });
      }

      const schedule = await Schedule.upsert(
        group, day, time, course,
        teacher     || null,
        room        || null,
        subjectType || 'lecture',
        duration    || 1,
        meetingLink || ''
      );

      res.json({
        success: true,
        data: {
          id:          schedule.id,
          group:       schedule.group_name,
          day:         schedule.day,
          time:        schedule.time,
          course:      schedule.course,
          teacher:     schedule.teacher,
          room:        schedule.room,
          subjectType: schedule.subject_type,
          duration:    schedule.duration,
          meetingLink: schedule.meeting_link,
        }
      });
    } catch (error) {
      console.error('Create/Update schedule error:', error);
      res.status(500).json({ success: false, error: 'Server error saving schedule' });
    }
  }

  static async delete(req, res) {
    try {
      const { group, day, time } = req.params;
      const deleted = await Schedule.delete(group, day, time);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Schedule entry not found' });
      }
      res.json({ success: true, message: 'Schedule deleted successfully' });
    } catch (error) {
      console.error('Delete schedule error:', error);
      res.status(500).json({ success: false, error: 'Server error deleting schedule' });
    }
  }

  static async getByDay(req, res) {
    try {
      const { day } = req.params;
      const schedules = await Schedule.getByDay(day);
      res.json(schedules);
    } catch (error) {
      console.error('Get by day error:', error);
      res.status(500).json({ success: false, error: 'Server error fetching schedules by day' });
    }
  }

  static async getByTeacher(req, res) {
    try {
      const { teacher } = req.params;
      const schedules = await Schedule.getByTeacher(teacher);
      res.json(schedules);
    } catch (error) {
      console.error('Get by teacher error:', error);
      res.status(500).json({ success: false, error: 'Server error fetching schedules by teacher' });
    }
  }

  static async getByGroup(req, res) {
    try {
      const { group } = req.params;
      const schedules = await Schedule.getByGroup(group);
      res.json(schedules);
    } catch (error) {
      console.error('Get by group error:', error);
      res.status(500).json({ success: false, error: 'Server error fetching schedules by group' });
    }
  }

  static async getAllTeachers(req, res) {
    try {
      const teachers = await Schedule.getAllTeachers();
      res.json(teachers);
    } catch (error) {
      console.error('Get all teachers error:', error);
      res.status(500).json({ success: false, error: 'Server error fetching teachers' });
    }
  }
}

module.exports = ScheduleController;