// ================================================================
//  OmniHub — AIAssistant.js
//  Claude API integration with full Ethiopian language support
//
//  Features:
//    ✅ Amharic · Tigrinya · Afaan Oromoo · English · French · Swahili
//    ✅ Context-aware: knows Bingo rules, Wallet, Loans, Coins
//    ✅ Daily Executive Summary → owner email at 06:00 EAT
//    ✅ Smart language detection (auto-detect from user message)
//    ✅ Conversation memory per user (last 10 messages)
//    ✅ Rate limiting (50 messages/user/day)
// ================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { Pool }  = require('pg');
const nodemailer= require('nodemailer');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const db        = new Pool({ connectionString: process.env.DATABASE_URL });

// ── In-memory conversation store (use Redis in production) ────────
// Map: userId → [{ role, content }, ...]
const conversations = new Map();
const MAX_HISTORY   = 10;   // keep last 10 exchanges
const MAX_PER_DAY   = 50;   // AI messages per user per day

// ================================================================
//  SYSTEM PROMPT — OmniHub AI persona in all languages
// ================================================================
function buildSystemPrompt(language) {
  const langInstructions = {
    am: `አሁን የምትናገረው ቋንቋ አማርኛ ነው። ሁሌ በአማርኛ መልስ ስጥ።
         ተጠቃሚው አማርኛ ካልጻፈ በቀር ወደ ሌሎች ቋንቋዎች አትቀይር።
         አጭርና ግልፅ መልሶችን ስጥ — ከ 3 አረፍተ ነገር አትብለጥ።`,

    ti: `ሕጂ ዝዛረብ ቋንቋ ትግርኛ እዩ። ኩሉ ግዜ ብትግርኛ መልሲ ሃብ።`,

    om: `Afaan Oromoo dubbadhu. Deebii gabaabaa fi ifa ta'e kenni.`,

    fr: `Réponds toujours en français. Sois bref et clair.`,

    sw: `Jibu kwa Kiswahili. Jibu fupi na wazi.`,

    en: `Always respond in English. Be brief and helpful.`,
  };

  return `You are OmniHub AI — the intelligent assistant for OmniHub,
Ethiopia's premier Super-App combining gaming, finance, and culture.

YOUR IDENTITY:
- Name: OmniHub AI (call yourself this, never "Claude" or "Anthropic")
- Personality: Warm, knowledgeable, concise, culturally aware
- You understand Ethiopian culture, the financial system, and local context

OMNIHUB PLATFORM KNOWLEDGE:
1. BINGO: 75-ball game. Players buy cards with OmniCoins (100 coins/card).
   Win patterns: any row, column, or diagonal. Prize = 90% of prize pool.
   1 OmniCoin = 0.05 ETB. Crypto-fair RNG — all results are verifiable.

2. WALLET: Dual currency — ETB (Ethiopian Birr) and USD.
   Deposit via: Chapa (all methods), Telebirr, CBEbirr.
   Withdraw via: Telebirr or CBEbirr (KYC required).
   Exchange rate: ~55 ETB per USD (updated daily).

3. OMNI-COINS: Reward points earned by:
   - Daily login: 10 coins + 5 per 7-day streak
   - Bingo win: 100 coins
   - Referral: 500 coins per new user
   - KYC complete: 200 coins
   - Ethiopian holidays: 2-3× multiplier

4. TRUST SCORE & LOANS: Score 0-100 based on coins, activity, KYC, history.
   Score ≥ 60 → instant micro-loan. Interest: 5-20% p.a. (lower = better score).
   Max loan = (coins × 0.1) + (score × 100) ETB.

5. KYC: Upload ID photo. Manual review. Required for withdrawals > 1,000 ETB.

RULES:
- Never give financial advice or guarantee winnings
- If asked about real money amounts, say "contact support"
- Keep responses under 3 sentences unless explaining a process
- Always be encouraging and positive about OmniHub
- For technical errors, say "ለቴክኒካዊ ድጋፍ support@omnihub.app ያግኙ"

${langInstructions[language] || langInstructions.en}`;
}

// ================================================================
//  LANGUAGE DETECTION
//  Simple heuristic — in production use a proper library
// ================================================================
function detectLanguage(text) {
  // Ethiopic script ranges
  const ethiopicRange = /[\u1200-\u137F\u1380-\u139F]/;
  if (ethiopicRange.test(text)) {
    // Distinguish Amharic vs Tigrinya by common words
    const tigWords = ['ሕጂ','ኢዩ','ወይ','ዝ','ኣ','ብ','ናይ'];
    const tigCount = tigWords.filter(w => text.includes(w)).length;
    return tigCount >= 2 ? 'ti' : 'am';
  }

  // Latin-based language detection by common words
  const lower = text.toLowerCase();
  if (/\b(je|vous|nous|merci|bonjour|oui|non|est|dans)\b/.test(lower)) return 'fr';
  if (/\b(mimi|wewe|habari|asante|karibu|sawa|ndiyo)\b/.test(lower)) return 'sw';
  if (/\b(ana|maal|galata|hayyama|eeyy|miti)\b/.test(lower)) return 'om';
  return 'en';
}

// ================================================================
//  RATE LIMITER  (in-memory — use Redis in production)
// ================================================================
const dailyCounts = new Map(); // `${userId}:${date}` → count

function checkRateLimit(userId) {
  const key   = `${userId}:${new Date().toDateString()}`;
  const count = dailyCounts.get(key) || 0;
  if (count >= MAX_PER_DAY) return false;
  dailyCounts.set(key, count + 1);
  return true;
}

// ================================================================
//  MAIN CHAT FUNCTION
// ================================================================
async function chat(userId, userMessage) {
  // Rate limit check
  if (!checkRateLimit(userId)) {
    return {
      role:     'assistant',
      content:  'ዛሬ የAI ጥያቄ ወሰን ደርሷል (50/day)። ነገ ይቀጥሉ! / Daily AI limit reached (50/day).',
      language: 'am',
      limited:  true,
    };
  }

  // Detect language
  const language = detectLanguage(userMessage);

  // Get or init conversation history for this user
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);

  // Add user message to history
  history.push({ role: 'user', content: userMessage });

  // Keep only last N exchanges
  const trimmed = history.slice(-MAX_HISTORY);
  conversations.set(userId, trimmed);

  try {
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 400,
      system:     buildSystemPrompt(language),
      messages:   trimmed,
    });

    const assistantMsg = response.content[0].text;

    // Add assistant response to history
    trimmed.push({ role: 'assistant', content: assistantMsg });
    conversations.set(userId, trimmed.slice(-MAX_HISTORY));

    // Log to DB (non-blocking)
    logConversation(userId, userMessage, assistantMsg, language).catch(() => {});

    return {
      role:     'assistant',
      content:  assistantMsg,
      language,
      tokens:   response.usage?.output_tokens,
    };
  } catch (err) {
    console.error('[AI Chat]', err.message);
    const errMsg = language === 'am'
      ? 'ይቅርታ — AI ለጊዜው አይሰራም። እባክዎ ቆይ ይሞክሩ።'
      : 'Sorry — AI is temporarily unavailable. Please try again.';
    return { role: 'assistant', content: errMsg, language, error: true };
  }
}

// ================================================================
//  CLEAR HISTORY  (user can reset conversation)
// ================================================================
function clearHistory(userId) {
  conversations.delete(userId);
}

// ================================================================
//  LOG TO DATABASE
// ================================================================
async function logConversation(userId, userMsg, assistantMsg, language) {
  await db.query(
    `INSERT INTO ai_conversation_logs
       (user_id, user_message, assistant_message, language, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, userMsg.slice(0, 1000), assistantMsg.slice(0, 2000), language]
  );
}

// ================================================================
//  DAILY EXECUTIVE SUMMARY
//  Runs at 06:00 EAT via cron — emails owner with full stats
// ================================================================
async function generateExecutiveSummary() {
  console.log('[AI Summary] Generating daily executive summary...');

  // ── Gather stats from DB ──────────────────────────────────────
  const { rows: [stats] } = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE is_active = true)
        AS total_users,
      (SELECT COUNT(*) FROM users WHERE DATE(created_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS new_users_today,
      (SELECT COUNT(DISTINCT user_id) FROM ai_conversation_logs
        WHERE DATE(created_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS ai_users_today,
      (SELECT COALESCE(SUM(amount_etb), 0) FROM payment_transactions
        WHERE status = 'completed' AND tx_type = 'deposit'
          AND DATE(completed_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS revenue_etb_today,
      (SELECT COALESCE(SUM(amount_etb), 0) FROM payment_transactions
        WHERE status = 'completed' AND tx_type = 'withdrawal'
          AND DATE(completed_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS withdrawals_etb_today,
      (SELECT COUNT(*) FROM bingo_rooms
        WHERE DATE(created_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS bingo_games_today,
      (SELECT COALESCE(SUM(coins), 0) FROM coin_transactions
        WHERE coins > 0
          AND DATE(created_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS coins_issued_today,
      (SELECT COUNT(*) FROM loans
        WHERE status = 'active'
          AND DATE(disbursed_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS loans_today,
      (SELECT COALESCE(SUM(amount), 0) FROM loans
        WHERE status = 'active'
          AND DATE(disbursed_at AT TIME ZONE 'Africa/Addis_Ababa') = CURRENT_DATE)
        AS loan_volume_today
  `);

  const date    = new Date().toLocaleDateString('en-ET', {
    timeZone: 'Africa/Addis_Ababa',
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const netRevenue = parseFloat(stats.revenue_etb_today || 0)
                   - parseFloat(stats.withdrawals_etb_today || 0);

  // ── Ask Claude to write the summary in English + Amharic ──────
  const prompt = `
Write a brief, professional Daily Executive Summary for OmniHub Super-App.
Data for ${date} (EAT):

- Total Active Users: ${stats.total_users}
- New Users Today: ${stats.new_users_today}
- AI Chat Users: ${stats.ai_users_today}
- Deposits Today: ${parseFloat(stats.revenue_etb_today).toLocaleString()} ETB
- Withdrawals Today: ${parseFloat(stats.withdrawals_etb_today).toLocaleString()} ETB
- Net Revenue: ${netRevenue.toLocaleString()} ETB
- Bingo Games: ${stats.bingo_games_today}
- OmniCoins Issued: ${parseInt(stats.coins_issued_today).toLocaleString()}
- Loans Disbursed: ${stats.loans_today} (${parseFloat(stats.loan_volume_today).toLocaleString()} ETB)

Format:
1. Start with "OmniHub Daily Executive Summary — [date]"
2. 3-4 bullet points highlighting key metrics
3. One sentence: what went well today
4. One sentence: what to watch tomorrow
5. End with an Amharic version of the summary (2-3 sentences)

Keep it under 200 words total.`;

  let summaryText = '';
  try {
    const res = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens: 500,
      messages:   [{ role: 'user', content: prompt }],
    });
    summaryText = res.content[0].text;
  } catch {
    summaryText = `OmniHub Daily Summary — ${date}
• Users: ${stats.total_users} total, ${stats.new_users_today} new
• Revenue: ${parseFloat(stats.revenue_etb_today).toLocaleString()} ETB deposits
• Bingo: ${stats.bingo_games_today} games played
• Loans: ${stats.loans_today} disbursed`;
  }

  // ── Save summary to DB ────────────────────────────────────────
  await db.query(
    `INSERT INTO executive_summaries
       (summary_date, total_users, new_users_today,
        revenue_etb, withdrawals_etb, bingo_games,
        coins_issued, loans_count, ai_summary, generated_at)
     VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (summary_date) DO UPDATE SET
       ai_summary   = EXCLUDED.ai_summary,
       generated_at = NOW()`,
    [
      stats.total_users,       stats.new_users_today,
      stats.revenue_etb_today, stats.withdrawals_etb_today,
      stats.bingo_games_today, stats.coins_issued_today,
      stats.loans_today,       summaryText,
    ]
  );

  // ── Send email to owner ───────────────────────────────────────
  await sendSummaryEmail(summaryText, stats, date, netRevenue);

  console.log('[AI Summary] Done ✅');
  return summaryText;
}

// ================================================================
//  EMAIL SENDER  (Nodemailer — use Gmail or SendGrid)
// ================================================================
async function sendSummaryEmail(summaryText, stats, date, netRevenue) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_FROM,
      pass: process.env.EMAIL_PASSWORD,   // use App Password for Gmail
    },
  });

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
<style>
  body  { font-family: 'Courier New', monospace; background:#050505;
          color:#fff; margin:0; padding:0; }
  .wrap { max-width:600px; margin:0 auto; padding:32px 24px; }
  .logo { font-size:1.6rem; font-weight:700; color:#F0C060;
          letter-spacing:4px; margin-bottom:8px; }
  .date { font-size:0.75rem; color:rgba(255,255,255,0.45);
          letter-spacing:2px; margin-bottom:28px; }
  .card { background:#0D0D0D; border:1px solid #2A2A2A;
          padding:20px; margin-bottom:16px; }
  .stat-grid { display:grid; grid-template-columns:1fr 1fr;
               gap:12px; margin-bottom:16px; }
  .stat { background:#111; border:1px solid #2A2A2A;
          padding:12px; text-align:center; }
  .stat-num { font-size:1.4rem; font-weight:700;
              color:#F0C060; display:block; }
  .stat-lbl { font-size:0.6rem; color:rgba(255,255,255,0.4);
              letter-spacing:2px; text-transform:uppercase;
              display:block; margin-top:4px; }
  .summary  { font-size:0.82rem; line-height:1.8;
              color:rgba(255,255,255,0.75); white-space:pre-wrap; }
  .footer   { font-size:0.62rem; color:rgba(255,255,255,0.25);
              text-align:center; margin-top:24px; letter-spacing:1px; }
  .green    { color:#10B981; }
  .red      { color:#EF4444; }
</style>
</head>
<body>
<div class="wrap">
  <p class="logo">OMNIHUB</p>
  <p class="date">DAILY EXECUTIVE SUMMARY — ${date.toUpperCase()}</p>

  <div class="stat-grid">
    <div class="stat">
      <span class="stat-num">${parseInt(stats.total_users).toLocaleString()}</span>
      <span class="stat-lbl">Total Users</span>
    </div>
    <div class="stat">
      <span class="stat-num ${parseInt(stats.new_users_today) > 0 ? 'green' : ''}"
            style="color:${parseInt(stats.new_users_today) > 0 ? '#10B981' : '#F0C060'}">
        +${stats.new_users_today}
      </span>
      <span class="stat-lbl">New Today</span>
    </div>
    <div class="stat">
      <span class="stat-num ${netRevenue > 0 ? 'green' : 'red'}"
            style="color:${netRevenue > 0 ? '#10B981' : '#EF4444'}">
        ${netRevenue > 0 ? '+' : ''}${netRevenue.toLocaleString()}
      </span>
      <span class="stat-lbl">Net ETB</span>
    </div>
    <div class="stat">
      <span class="stat-num">${stats.bingo_games_today}</span>
      <span class="stat-lbl">Bingo Games</span>
    </div>
    <div class="stat">
      <span class="stat-num">${parseInt(stats.coins_issued_today).toLocaleString()}</span>
      <span class="stat-lbl">Coins Issued</span>
    </div>
    <div class="stat">
      <span class="stat-num">${stats.loans_today}</span>
      <span class="stat-lbl">Loans</span>
    </div>
  </div>

  <div class="card">
    <p class="summary">${summaryText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
  </div>

  <p class="footer">OmniHub Super-App · Generated by OmniHub AI · ${new Date().toISOString()}</p>
</div>
</body>
</html>`;

  try {
    await transporter.sendMail({
      from:    `"OmniHub AI" <${process.env.EMAIL_FROM}>`,
      to:      process.env.OWNER_EMAIL,
      subject: `OmniHub Daily Summary — ${date} | ${parseInt(stats.new_users_today)} new users`,
      html:    htmlBody,
      text:    summaryText,
    });
    console.log(`[Email] Summary sent to ${process.env.OWNER_EMAIL}`);
  } catch (err) {
    console.error('[Email] Failed:', err.message);
  }
}

// ================================================================
//  CRON JOB REGISTRAR
//  Call this once from server.js: registerAICronJobs()
// ================================================================
function registerAICronJobs() {
  const cron = require('node-cron');

  // 06:00 EAT every day
  cron.schedule('0 6 * * *', async () => {
    console.log('[CRON 06:00] Running AI Executive Summary...');
    try {
      await generateExecutiveSummary();
    } catch (err) {
      console.error('[CRON Summary]', err.message);
    }
  }, { timezone: 'Africa/Addis_Ababa' });

  // Clear old conversation memory at midnight
  cron.schedule('0 0 * * *', () => {
    conversations.clear();
    console.log('[CRON 00:00] Conversation memory cleared');
  }, { timezone: 'Africa/Addis_Ababa' });

  console.log('[AI] Cron jobs registered (timezone: Africa/Addis_Ababa)');
}

module.exports = {
  chat,
  clearHistory,
  generateExecutiveSummary,
  registerAICronJobs,
  detectLanguage,
};
