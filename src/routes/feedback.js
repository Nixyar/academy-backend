import { Router } from 'express';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';
import { sendApiError } from '../lib/publicErrors.js';

const router = Router();

/**
 * GET /api/feedback/:courseId
 * Получить отзыв пользователя для курса
 */
router.get('/:courseId', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;

    if (!courseId) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }

    const { data, error } = await supabaseAdmin
      .from('course_feedback')
      .select('rating,comment,updated_at')
      .eq('course_id', courseId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.error('[feedback:get] Supabase error', { courseId, userId: user.id, error });
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    // Если отзыва нет, возвращаем пустой объект
    if (!data) {
      return res.json({});
    }

    return res.json({
      rating: data.rating,
      comment: data.comment || '',
      updated_at: data.updated_at,
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/feedback/:courseId
 * Создать или обновить отзыв пользователя для курса
 *
 * Body: { rating: number, comment?: string }
 */
router.post('/:courseId', requireUser, async (req, res, next) => {
  try {
    const courseId = String(req.params?.courseId || '').trim();
    const { user } = req;
    const { rating, comment } = req.body || {};

    if (!courseId) {
      return sendApiError(res, 400, 'INVALID_REQUEST');
    }

    // Валидация rating
    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return sendApiError(res, 400, 'INVALID_RATING', {
        message: 'Рейтинг должен быть числом от 1 до 5',
      });
    }

    // Валидация comment (опционально)
    const normalizedComment = typeof comment === 'string' ? comment.trim() : '';
    if (normalizedComment.length > 5000) {
      return sendApiError(res, 400, 'COMMENT_TOO_LONG', {
        message: 'Комментарий не должен превышать 5000 символов',
      });
    }

    // Проверить существование курса
    const { data: course, error: courseError } = await supabaseAdmin
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .maybeSingle();

    if (courseError) {
      console.error('[feedback:post] Course lookup error', { courseId, error: courseError });
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    if (!course) {
      return sendApiError(res, 404, 'COURSE_NOT_FOUND');
    }

    // Upsert отзыва
    const payload = {
      course_id: courseId,
      user_id: user.id,
      rating,
      comment: normalizedComment,
      metadata: { page: 'course_end' },
    };

    const { data, error } = await supabaseAdmin
      .from('course_feedback')
      .upsert(payload, { onConflict: 'user_id,course_id' })
      .select('updated_at')
      .maybeSingle();

    if (error) {
      console.error('[feedback:post] Upsert error', { courseId, userId: user.id, error });
      return sendApiError(res, 500, 'INTERNAL_ERROR');
    }

    return res.json({
      ok: true,
      updated_at: data?.updated_at || new Date().toISOString(),
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
