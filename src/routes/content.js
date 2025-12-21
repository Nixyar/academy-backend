import { Router } from 'express';
import supabaseAnon from '../lib/supabaseAnon.js';

const router = Router();

const parseEq = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value.startsWith('eq.') ? value.slice(3) : value;
};

router.get('/courses', async (req, res, next) => {
  try {
    const { status, slug, access } = req.query || {};

    let query = supabaseAnon.from('courses').select('*').order('sort_order', { ascending: true });

    if (status) {
      query = query.eq('status', parseEq(status));
    }

    if (slug) {
      query = query.eq('slug', parseEq(slug));
    }

    if (access) {
      query = query.eq('access', parseEq(access));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_COURSES' });
    }

    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

router.get('/lessons', async (req, res, next) => {
  try {
    const { course_id: courseId, slug, lesson_type: lessonType } = req.query || {};

    let query = supabaseAnon.from('lessons').select('*').order('sort_order', { ascending: true });

    if (courseId) {
      query = query.eq('course_id', parseEq(courseId));
    }

    if (slug) {
      query = query.eq('slug', parseEq(slug));
    }

    if (lessonType) {
      query = query.eq('lesson_type', parseEq(lessonType));
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'FAILED_TO_FETCH_LESSONS' });
    }

    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

export default router;
