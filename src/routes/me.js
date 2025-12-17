import { Router } from 'express';
import requireUser from '../middleware/requireUser.js';
import supabaseAdmin from '../lib/supabaseAdmin.js';

const router = Router();

router.get('/', requireUser, async (req, res, next) => {
  try {
    const { user } = req;

    const { data: existingProfile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (fetchError) {
      return res.status(500).json({ error: 'Unable to load profile' });
    }

    if (!existingProfile) {
      const newProfile = {
        id: user.id,
        email: user.email,
        name: user.userMetadata?.full_name || user.userMetadata?.name || null,
        avatar_url: user.userMetadata?.avatar_url || null,
        plan: 'free',
        daily_limit: 15,
        daily_used: 0,
      };

      const { data: createdProfile, error: insertError } = await supabaseAdmin
        .from('profiles')
        .insert(newProfile)
        .select()
        .single();

      if (insertError) {
        return res.status(500).json({ error: 'Unable to create profile' });
      }

      return res.json(createdProfile);
    }

    return res.json(existingProfile);
  } catch (error) {
    return next(error);
  }
});

export default router;
