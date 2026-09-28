require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { verifyInitData } = require('./telegramAuth');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// Кто открыл мини-апп: берём подписанные данные Telegram и проверяем подпись токеном бота
function requireTelegramUser(req, res, next) {
  const tgUser = verifyInitData(req.header('X-Telegram-Init-Data'), BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'invalid_init_data' });
  req.tgUser = tgUser;
  req.user = db.ensureUser(tgUser);
  next();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_SECRET || req.header('X-Admin-Secret') !== ADMIN_SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---------- пользователь (всё строго по его Telegram ID) ----------
app.get('/api/me', requireTelegramUser, (req, res) => res.json(req.user));
app.get('/api/deals', requireTelegramUser, (req, res) => res.json(db.getDeals(req.user.id, req.query.status)));
app.post('/api/deals', requireTelegramUser, (req, res) => {
  const { item, price, currency, role, counterpartyUsername } = req.body;
  const validUser = /^@?[A-Za-z0-9_]{3,32}$/.test(String(counterpartyUsername || ''));
  if (!item || String(item).length > 100 || !(Number(price) > 0) || Number(price) > 1e9 || !db.CURRENCIES.includes(currency) ||
      !['seller', 'buyer'].includes(role) || !validUser)
    return res.status(400).json({ error: 'bad_fields' });
  res.json(db.createDeal({ item, price, currency, role, tgUser: req.tgUser, counterpartyUsername }));
});
app.get('/api/transactions', requireTelegramUser, (req, res) => res.json(db.getTransactions(req.user.id)));

// пополнение / вывод / обмен на рубли на карту — создают заявку «ожидание», её подтверждаете вы
app.post('/api/requests', requireTelegramUser, (req, res) => {
  const { type, currency, amount, dest, fromCurrency } = req.body;
  const n = Number(amount);
  if (!['deposit', 'withdraw', 'convert'].includes(type) || !(n > 0) || n > 1e12 || String(dest || '').length > 200 || (type !== 'convert' && !db.CURRENCIES.includes(currency)))
    return res.status(400).json({ error: 'bad_fields' });
  if (type === 'withdraw' && (req.user.balances[currency] || 0) < n) return res.status(400).json({ error: 'insufficient_balance' });
  if (type === 'convert' && (!db.RATES_TO_RUB[fromCurrency] || fromCurrency === 'RUB' || (req.user.balances[fromCurrency] || 0) < n))
    return res.status(400).json({ error: 'insufficient_balance' });
  res.json(db.createRequest(req.user.id, { type, currency, amount: n, dest, fromCurrency }));
});
app.delete('/api/requests/:id', requireTelegramUser, (req, res) => {
  res.json({ ok: db.cancelRequest(req.user.id, req.params.id) });
});

// ---------- админ (по секретному паролю из .env) ----------
app.get('/api/admin/deals', requireAdmin, (req, res) => res.json(db.adminPendingDeals()));
app.post('/api/admin/deals/:id/step', requireAdmin, (req, res) => {
  const deal = db.adminSetDealStep(req.params.id, Number(req.body.step));
  deal ? res.json(deal) : res.status(404).json({ error: 'not_found' });
});
app.get('/api/admin/requests', requireAdmin, (req, res) => res.json(db.adminPendingRequests()));
app.post('/api/admin/requests/:id/confirm', requireAdmin, (req, res) => {
  const tx = db.adminConfirmRequest(req.params.id);
  tx ? res.json(tx) : res.status(404).json({ error: 'not_found' });
});
app.get('/api/admin/users', requireAdmin, (req, res) => res.json(db.adminUsers()));
app.post('/api/admin/users/:id/balance', requireAdmin, (req, res) => {
  const u = db.adminSetBalance(req.params.id, req.body.currency, req.body.value);
  u ? res.json(u) : res.status(404).json({ error: 'not_found' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Novamesh backend запущен на порту ' + PORT));
require('./bot');
