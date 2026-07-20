// ================================================================
//  OmniHub — ussd.js  (G: USSD Interface)
//  Text-based menu for basic phones — no internet needed
//  Works with Ethio Telecom USSD gateway
//  Dial: *123# (configure with Ethio Telecom)
//
//  Install: npm install express (already installed)
//  Endpoint: POST /ussd  ← registered with Ethio Telecom portal
// ================================================================
const express = require('express');
const router  = express.Router();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// ── USSD SESSION STORE (in-memory, upgrade to Redis for scale) ────
const sessions = new Map(); // phoneNumber → sessionData

// ── MENU DEFINITIONS ──────────────────────────────────────────────
const MENUS = {
  // ── MAIN MENU ─────────────────────────────────────────────────
  main: {
    am: `OmniHub ✦\n1. ሂሳቤ ይፈትሽ\n2. ቢንጎ ውጤቶች\n3. ዋሌት ዝርዝር\n4. ማስቀመጥ ጥያቄ\n5. ቋንቋ ቀይር\n0. ውጣ`,
    en: `OmniHub ✦\n1. Check Balance\n2. Bingo Results\n3. Wallet History\n4. Deposit Request\n5. Change Language\n0. Exit`,
    ti: `OmniHub ✦\n1. ሒሳብ ፈትሽ\n2. ቢንጎ ውጽኢት\n3. ዋሌት ዝርዝር\n4. ምቕማጥ ሕቶ\n5. ቛንቛ ቀይር\n0. ውጻእ`,
    om: `OmniHub ✦\n1. Dhaabbata Ilaalii\n2. Bingo Bu'aa\n3. Seenaa Mkoba\n4. Kewwachuu\n5. Afaan Jijjiiri\n0. Ba'i`,
  },

  // ── BALANCE MENU ──────────────────────────────────────────────
  balance: {
    am: (data) => `💰 ሂሳብዎ\n────────────\nETB: ${data.etb}\nUSD: $${data.usd}\nOmniCoins: ${data.coins}\n────────────\n0. ዋና ምናሌ`,
    en: (data) => `💰 Your Balance\n────────────\nETB: ${data.etb}\nUSD: $${data.usd}\nOmniCoins: ${data.coins}\n────────────\n0. Main Menu`,
    ti: (data) => `💰 ሒሳብካ\n────────────\nETB: ${data.etb}\nUSD: $${data.usd}\nOmniCoins: ${data.coins}\n────────────\n0. ቀንዲ ምናሌ`,
    om: (data) => `💰 Dhaabbata Kee\n────────────\nETB: ${data.etb}\nUSD: $${data.usd}\nOmniCoins: ${data.coins}\n────────────\n0. Caancala Guddaa`,
  },

  // ── BINGO RESULTS ─────────────────────────────────────────────
  bingo: {
    am: (data) => `🎯 ቢንጎ ውጤቶች\n────────────\nቀጣይ ጨዋታ: ${data.nextGame}\nጃክፖት: ₵${data.jackpot}\nከፍ. ተሸናፊ: ${data.lastWinner}\nሽልማት: ${data.lastPrize} ETB\n────────────\n0. ዋና ምናሌ`,
    en: (data) => `🎯 Bingo Results\n────────────\nNext Game: ${data.nextGame}\nJackpot: ₵${data.jackpot}\nLast Winner: ${data.lastWinner}\nPrize: ${data.lastPrize} ETB\n────────────\n0. Main Menu`,
    ti: (data) => `🎯 ቢንጎ ውጽኢት\n────────────\nዝቕጽል ጸወታ: ${data.nextGame}\nጃክፖት: ₵${data.jackpot}\nናይ መጨረሻ: ${data.lastWinner}\nሽልማት: ${data.lastPrize} ETB\n────────────\n0. ቀንዲ ምናሌ`,
    om: (data) => `🎯 Bingo Bu'aa\n────────────\nTapho Itti Aanu: ${data.nextGame}\nJackpot: ₵${data.jackpot}\nMo'ataa: ${data.lastWinner}\nKaffaltii: ${data.lastPrize} ETB\n────────────\n0. Caancala Guddaa`,
  },

  // ── WALLET HISTORY ────────────────────────────────────────────
  history: {
    am: (txs) => `📋 ዝርዝር (መጨረሻ 5)\n────────────\n${txs}\n────────────\n0. ዋና ምናሌ`,
    en: (txs) => `📋 History (Last 5)\n────────────\n${txs}\n────────────\n0. Main Menu`,
    ti: (txs) => `📋 ዝርዝር (ናይ መጨረሻ 5)\n────────────\n${txs}\n────────────\n0. ቀንዲ ምናሌ`,
    om: (txs) => `📋 Seenaa (Dhumaa 5)\n────────────\n${txs}\n────────────\n0. Caancala Guddaa`,
  },

  // ── DEPOSIT REQUEST ───────────────────────────────────────────
  deposit_start: {
    am: `💳 ጥያቄ\nFull service በ app ይጠቀሙ\nOmniHub.vercel.app\n\nSMS መሙያ:\n1. Telebirr ይጠቀሙ\n2. CBEbirr ይጠቀሙ\n0. ዋና ምናሌ`,
    en: `💳 Deposit\nFor full service use app:\nOmniHub.vercel.app\n\nQuick deposit:\n1. Via Telebirr\n2. Via CBEbirr\n0. Main Menu`,
    ti: `💳 ምቕማጥ\nናይ ምሉእ ኣገልግሎት ኣፕ ተጠቀም:\nOmniHub.vercel.app\n\n1. ብ Telebirr\n2. ብ CBEbirr\n0. ቀንዲ ምናሌ`,
    om: `💳 Kewwachuu\nApp fayyadami:\nOmniHub.vercel.app\n\n1. Telebirr dhaan\n2. CBEbirr dhaan\n0. Caancala Guddaa`,
  },

  // ── LANGUAGE PICKER ───────────────────────────────────────────
  lang_pick: {
    any: `🌍 Language / ቋንቋ\n1. አማርኛ\n2. English\n3. ትግርኛ\n4. Afaan Oromoo\n0. Back`,
  },

  // ── NOT REGISTERED ────────────────────────────────────────────
  not_found: {
    am: `❌ ያልተመዘገቡ ተጠቃሚ\nOmniHub.vercel.app ይጎብኙ\nወይም ቁጥር +251115XXX\n0. ውጣ`,
    en: `❌ User not found\nVisit OmniHub.vercel.app\nor call +251115XXX\n0. Exit`,
    ti: `❌ ኣይተመዝገብካን\nOmniHub.vercel.app ጎብኦ\n0. ውጻእ`,
    om: `❌ Fayyadamaa Argamne\nOmniHub.vercel.app ilaalii\n0. Ba'i`,
  },

  // ── ERROR ─────────────────────────────────────────────────────
  error: {
    am: `⚠️ ስህተት ተፈጠረ\nደቂቃ ጠብቀው እንደገና ይሞክሩ\n0. ዋና ምናሌ`,
    en: `⚠️ An error occurred\nPlease try again in a minute\n0. Main Menu`,
    ti: `⚠️ ጌጋ ኣጋጢሙ\nደቒቃ ጸናሕ ደጊምካ ፈትን\n0. ቀንዲ ምናሌ`,
    om: `⚠️ Dogoggorri Uumame\nDaqiiqaa eegii irra deebi'i\n0. Caancala Guddaa`,
  },
};

// ── HELPER: get menu text ─────────────────────────────────────────
function getMenu(menuKey, lang = 'am', data = null) {
  const menu = MENUS[menuKey];
  if (!menu) return MENUS.error[lang] || MENUS.error.en;
  const template = menu[lang] || menu.en || menu.any || '';
  if (typeof template === 'function') return template(data);
  return template;
}

// ── HELPER: format date short ─────────────────────────────────────
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-ET', { month:'short', day:'numeric' });
}

// ── HELPER: format transaction list ──────────────────────────────
function fmtTxList(rows, lang) {
  if (!rows.length) return lang === 'am' ? 'ምንም ግብይት የለም' : 'No transactions';
  const typeMap = {
    deposit:         { am:'ማስቀ', en:'Dep', ti:'ምቕ', om:'Kew' },
    withdraw:        { am:'ማውጣ', en:'Wit', ti:'ምውጻ', om:'Baa' },
    bingo_win:       { am:'ቢንጎ', en:'Bingo', ti:'ቢንጎ', om:'Bingo' },
    coin_redeem:     { am:'ሳንቲም', en:'Coin', ti:'ሳንቲ', om:'Coin' },
    marketplace_buy: { am:'ግዢ', en:'Buy', ti:'ዕዳጋ', om:'Gur' },
  };
  return rows.map(t => {
    const type = (typeMap[t.type]?.[lang]) || t.type.slice(0,5);
    const sign = t.amount > 0 ? '+' : '';
    return `${fmtDate(t.created_at)} ${type}: ${sign}${parseFloat(t.amount).toFixed(0)} ETB`;
  }).join('\n');
}

// ── CORE USSD HANDLER ─────────────────────────────────────────────
async function handleUSSD(phoneNumber, text, sessionId) {
  // Get or create session
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { phone: phoneNumber, step: 'main', lang: 'am' });
    // Auto-cleanup after 5 min
    setTimeout(() => sessions.delete(sessionId), 5 * 60 * 1000);
  }
  const sess = sessions.get(sessionId);
  const lang = sess.lang;
  const input = (text || '').trim().split('*').pop(); // get last input

  // ── Step: MAIN MENU ───────────────────────────────────────────
  if (!text || text === '' || input === '0') {
    sess.step = 'main';
    return { type: 'CON', text: getMenu('main', lang) };
  }

  // ── Step: LANGUAGE CHANGE ─────────────────────────────────────
  if (sess.step === 'lang_pick') {
    const langMap = { '1':'am', '2':'en', '3':'ti', '4':'om' };
    if (langMap[input]) {
      sess.lang = langMap[input];
      sess.step = 'main';
      return { type: 'CON', text: getMenu('main', sess.lang) };
    }
    sess.step = 'main';
    return { type: 'CON', text: getMenu('main', lang) };
  }

  // ── Step: MAIN MENU SELECTION ─────────────────────────────────
  if (sess.step === 'main') {
    if (input === '1') {
      // Balance check
      sess.step = 'balance';
      try {
        const { rows:[user] } = await db.query(
          `SELECT w.balance_etb, w.balance_usd, cb.total_coins
           FROM users u
           LEFT JOIN wallets w ON w.user_id=u.id AND w.currency='ETB'
           LEFT JOIN coin_balances cb ON cb.user_id=u.id
           WHERE u.phone=$1 LIMIT 1`,
          [phoneNumber]
        );
        if (!user) return { type:'END', text: getMenu('not_found', lang) };
        const data = {
          etb:   parseFloat(user.balance_etb||0).toLocaleString('en-ET',{maximumFractionDigits:2}),
          usd:   parseFloat(user.balance_usd||0).toFixed(2),
          coins: parseInt(user.total_coins||0).toLocaleString(),
        };
        return { type:'CON', text: getMenu('balance', lang, data) };
      } catch(e) {
        return { type:'CON', text: getMenu('error', lang) };
      }

    } else if (input === '2') {
      // Bingo results
      sess.step = 'bingo';
      try {
        const { rows:[last] } = await db.query(
          `SELECT bs.ended_at, u.username, t.amount
           FROM bingo_sessions bs
           LEFT JOIN users u ON u.id=bs.winner_id
           LEFT JOIN transactions t ON t.user_id=bs.winner_id
             AND t.type='bingo_win' AND t.created_at > NOW()-INTERVAL '1h'
           WHERE bs.status='finished'
           ORDER BY bs.ended_at DESC LIMIT 1`
        );
        const data = {
          nextGame:   'Every 5 min',
          jackpot:    '2,500',
          lastWinner: last?.username || 'N/A',
          lastPrize:  last?.amount ? parseFloat(last.amount).toFixed(0) : '0',
        };
        return { type:'CON', text: getMenu('bingo', lang, data) };
      } catch(e) {
        return { type:'CON', text: getMenu('error', lang) };
      }

    } else if (input === '3') {
      // Wallet history
      sess.step = 'history';
      try {
        const { rows:txs } = await db.query(
          `SELECT t.type, t.amount, t.created_at
           FROM transactions t
           JOIN users u ON u.id=t.user_id
           WHERE u.phone=$1 AND t.status='completed'
           ORDER BY t.created_at DESC LIMIT 5`,
          [phoneNumber]
        );
        const list = fmtTxList(txs, lang);
        return { type:'CON', text: getMenu('history', lang, list) };
      } catch(e) {
        return { type:'CON', text: getMenu('error', lang) };
      }

    } else if (input === '4') {
      // Deposit
      sess.step = 'deposit';
      return { type:'CON', text: getMenu('deposit_start', lang) };

    } else if (input === '5') {
      // Language picker
      sess.step = 'lang_pick';
      return { type:'CON', text: getMenu('lang_pick', 'any') };

    } else {
      return { type:'CON', text: getMenu('main', lang) };
    }
  }

  // ── Step: SUB-MENU NAVIGATION ─────────────────────────────────
  // From any sub-menu, 0 goes back to main
  sess.step = 'main';
  return { type:'CON', text: getMenu('main', lang) };
}

// ── EXPRESS ROUTE ─────────────────────────────────────────────────
// POST /ussd  — registered with Ethio Telecom USSD gateway
router.post('/', express.urlencoded({ extended:true }), async (req, res) => {
  const {
    sessionId,
    serviceCode,
    phoneNumber,
    text = '',
    networkCode,
  } = req.body;

  // Validate request (basic)
  if (!sessionId || !phoneNumber) {
    return res.status(400).send('END Invalid request');
  }

  // Normalize phone number
  const phone = phoneNumber.startsWith('+') ? phoneNumber : '+251' + phoneNumber.replace(/^0/, '');

  try {
    const { type, text: response } = await handleUSSD(phone, text, sessionId);
    res.set('Content-Type', 'text/plain');
    res.send(`${type} ${response}`);
  } catch(err) {
    console.error('[USSD Error]', err.message);
    res.set('Content-Type', 'text/plain');
    res.send(`END An error occurred. Please try again.`);
  }
});

// GET /ussd/test?phone=+251911234567&text=1  — dev testing
router.get('/test', async (req, res) => {
  if (process.env.NODE_ENV === 'production')
    return res.status(404).json({ error:'not_found' });
  const { phone='+251911234567', text='' } = req.query;
  const sessionId = `test_${phone}`;
  const result = await handleUSSD(phone, text, sessionId);
  res.json({ ...result, session: sessions.get(sessionId) });
});

// ── USSD ADMIN STATS ──────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_PASS)
    return res.status(403).json({ error:'forbidden' });
  res.json({
    activeSessions: sessions.size,
    sessions: [...sessions.entries()].map(([id, s]) => ({
      id: id.slice(0,8)+'...', step:s.step, lang:s.lang,
    })),
  });
});

module.exports = router;
