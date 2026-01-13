import { Router } from 'express';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

const normalizeStatus = (status) => String(status || '').trim().toLowerCase();

const isPaidStatus = (status) => {
  const normalized = normalizeStatus(status);
  return ['paid', 'succeeded', 'success', 'completed', 'captured', 'confirmed'].includes(normalized);
};

const isGrantedStatus = (status) => {
  const normalized = normalizeStatus(status);
  return ['active', 'granted', 'paid', 'confirmed'].includes(normalized);
};

router.get('/courses', requireUser, async (req, res, next) => {
  try {
    const { user } = req;

    // Prefer `user_courses` (new denormalized access table). Fallback to legacy `course_purchases`.
    const { data: granted, error: userCoursesError } = await supabaseAdmin
      .from('user_courses')
      .select('course_id,status,granted_at')
      .eq('user_id', user.id);

    if (!userCoursesError) {
      const purchasedCourseIds = (granted || [])
        .filter((row) => Boolean(row?.granted_at) || isGrantedStatus(row?.status))
        .map((row) => row.course_id)
        .filter(Boolean);
      return res.json({ courseIds: purchasedCourseIds });
    }

    const { data, error } = await supabaseAdmin
      .from('course_purchases')
      .select('course_id,status,paid_at')
      .eq('user_id', user.id);

    if (error) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    const purchasedCourseIds = (data || [])
      .filter((row) => Boolean(row?.paid_at) || isPaidStatus(row?.status))
      .map((row) => row.course_id)
      .filter(Boolean);

    return res.json({ courseIds: purchasedCourseIds });
  } catch (error) {
    return next(error);
  }
});

export default router;
