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

const upsertUserCourse = async ({ userId, courseId, purchaseId }) => {
  try {
    const grantedAt = new Date().toISOString();
    const payload = {
      user_id: userId,
      course_id: courseId,
      purchase_id: purchaseId,
      status: 'active',
      granted_at: grantedAt,
    };

    const { error } = await supabaseAdmin
      .from('user_courses')
      .insert(payload, { onConflict: 'user_id,course_id', ignoreDuplicates: true });

    if (!error) return true;

    // Fallback if the unique constraint isn't present.
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('on conflict') && message.includes('constraint')) {
      const { error: fallbackError } = await supabaseAdmin
        .from('user_courses')
        .upsert(payload, { onConflict: 'user_id,course_id' });
      return !fallbackError;
    }
    return !error;
  } catch {
    return false;
  }
};

router.get('/courses', requireUser, async (req, res, next) => {
  try {
    const { user } = req;

    // Prefer `user_courses` (new denormalized access table). Fallback to legacy `course_purchases`.
    const { data: granted, error: userCoursesError } = await supabaseAdmin
      .from('user_courses')
      .select('course_id,status,granted_at')
      .eq('user_id', user.id);

    if (!userCoursesError && (granted || []).length > 0) {
      const purchasedCourseIds = (granted || [])
        .filter((row) => Boolean(row?.granted_at) || isGrantedStatus(row?.status))
        .map((row) => row.course_id)
        .filter(Boolean);
      return res.json({ courseIds: purchasedCourseIds });
    }

    const { data, error } = await supabaseAdmin
      .from('course_purchases')
      .select('id,course_id,status,paid_at')
      .eq('user_id', user.id);

    if (error) {
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    const paidRows = (data || [])
      .filter((row) => Boolean(row?.paid_at) || isPaidStatus(row?.status))
      .filter((row) => Boolean(row?.course_id));

    // Backfill `user_courses` for old rows or when the access table was cleared manually.
    if (!userCoursesError && paidRows.length > 0) {
      const grantedAt = new Date().toISOString();
      const records = paidRows.map(row => ({
        user_id: user.id,
        course_id: row.course_id,
        purchase_id: row.id,
        status: 'active',
        granted_at: grantedAt,
      }));

      await supabaseAdmin
        .from('user_courses')
        .upsert(records, { onConflict: 'user_id,course_id', ignoreDuplicates: false })
        .catch(() => null); // Игнорируем ошибки для backfill
    }

    const purchasedCourseIds = paidRows.map((row) => row.course_id);

    return res.json({ courseIds: purchasedCourseIds });
  } catch (error) {
    return next(error);
  }
});

export default router;
