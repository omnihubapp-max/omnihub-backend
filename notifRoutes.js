// ================================================================
//  OmniHub — notifRoutes.js  (C: Notification Routes)
//  REST endpoints for push tokens + in-app notifications
//  Mount: app.use('/api/notifications', notifRoutes)
// ================================================================
const express = require('express');
const router  = express.Router();
const { auth } = require('../security/security');
const {
  saveFCMToken, getNotifications,
  markRead, markAllRead,
} = require('../notifications/pushService');

// POST /api/notifications/token — save FCM token from device
router.post('/token', auth, async (req, res) => {
  try {
    const { token, platform = 'web' } = req.body;
    if (!token) return res.status(400).json({ error: 'token_required' });
    await saveFCMToken(req.user.id, token, platform);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// GET /api/notifications — get in-app notifications
router.get('/', auth, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const data = await getNotifications(
      req.user.id,
      Math.min(parseInt(limit), 50),
      parseInt(offset)
    );
    res.json(data);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/read — mark specific notifications as read
router.post('/read', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids?.length) return res.status(400).json({ error: 'ids_required' });
    await markRead(req.user.id, ids);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// POST /api/notifications/read-all — mark all as read
router.post('/read-all', auth, async (req, res) => {
  try {
    await markAllRead(req.user.id);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
