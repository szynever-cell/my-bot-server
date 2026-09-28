// Хранилище данных (JSON-файл). У каждого пользователя Telegram — свой профиль по его ID.
// Деньги вручную подтверждает админ: сервер только меняет цифры в базе.
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'data.json');

const CURRENCIES = ['RUB', 'USDT', 'TON', 'STARS', 'BTC', 'ETH'];
const RATES_TO_RUB = { USDT: 91.85, TON: 570.0, BTC: 6128500, ETH: 231900, STARS: 1.9, RUB: 1 };
const RUB_PER_USD = 92.4;

function load() {
  if (!fs.existsSync(FILE)) return { users: {}, deals: [], transactions: [] };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function save(data) { fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }
const rid = (p) => p + Math.random().toString(36).slice(2, 8);

function ensureUser(tgUser) {
  const data = load();
  const id = String(tgUser.id);
  let u = data.users[id];
  if (!u) {
    u = data.users[id] = {
      id, username: null, firstName: '', balances: Object.fromEntries(CURRENCIES.map(c => [c, 0])),
      turnoverUsd: 0, createdAt: new Date().toISOString()
    };
  }
  // обновляем имя/юзернейм при каждом входе (в Telegram они могут меняться)
  u.username = tgUser.username || null;
  u.firstName = tgUser.first_name || 'Пользователь';
  save(data);
  return u;
}
function getUser(id) { return load().users[String(id)] || null; }

// --- сделки: видны участникам (по ID или по @username второй стороны) ---
function involves(d, user) {
  const un = (user.username || '').toLowerCase();
  const clean = (s) => (s || '').replace('@', '').toLowerCase();
  return d.sellerId === user.id || d.buyerId === user.id ||
    (un && (clean(d.sellerUsername) === un || clean(d.buyerUsername) === un));
}
function getDeals(userId, status) {
  const data = load();
  const user = data.users[String(userId)];
  if (!user) return [];
  return data.deals.filter(d => involves(d, user) &&
    (status === 'active' ? d.status !== 'done' : status === 'history' ? d.status === 'done' : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function createDeal({ item, price, currency, role, tgUser, counterpartyUsername }) {
  const data = load();
  const uid = String(tgUser.id);
  const me = tgUser.username ? '@' + tgUser.username : tgUser.first_name;
  const deal = {
    id: rid('nm'), item, price: Number(price), currency, status: 'wait', step: 1,
    sellerId: role === 'seller' ? uid : null, buyerId: role === 'buyer' ? uid : null,
    sellerUsername: role === 'seller' ? me : counterpartyUsername,
    buyerUsername: role === 'buyer' ? me : counterpartyUsername,
    createdAt: new Date().toISOString()
  };
  data.deals.push(deal);
  save(data);
  return deal;
}

// --- заявки: пополнение / вывод / обмен на карту. Ждут подтверждения админа ---
function createRequest(userId, { type, currency, amount, dest, fromCurrency }) {
  const data = load();
  const tx = {
    id: rid('tx'), userId: String(userId), type, currency, amount: Number(amount),
    dest: dest || null, fromCurrency: fromCurrency || null, status: 'wait',
    createdAt: new Date().toISOString()
  };
  if (type === 'convert') {
    tx.currency = 'RUB';
    tx.fromAmount = Number(amount);
    tx.amount = Math.round(Number(amount) * RATES_TO_RUB[fromCurrency]);
  }
  data.transactions.push(tx);
  save(data);
  return tx;
}
function getTransactions(userId) {
  return load().transactions.filter(t => t.userId === String(userId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function cancelRequest(userId, txId) {
  const data = load();
  const i = data.transactions.findIndex(t => t.id === txId && t.userId === String(userId) && t.status === 'wait');
  if (i < 0) return false;
  data.transactions.splice(i, 1);
  save(data);
  return true;
}

// --- админ ---
function adminPendingDeals() {
  return load().deals.filter(d => d.status !== 'done');
}
function adminSetDealStep(dealId, step) {
  const data = load();
  const deal = data.deals.find(d => d.id === dealId);
  if (!deal) return null;
  deal.step = step;
  deal.status = step >= 5 ? 'done' : step >= 3 ? 'active' : 'wait';
  if (deal.status === 'done') {
    const income = (uid) => {
      const u = data.users[uid];
      if (!u) return;
      u.balances[deal.currency] = (u.balances[deal.currency] || 0) + deal.price;
      u.turnoverUsd = Math.round((u.turnoverUsd + deal.price * RATES_TO_RUB[deal.currency] / RUB_PER_USD) * 100) / 100;
    };
    if (deal.sellerId) {
      income(deal.sellerId);
      data.transactions.push({ id: rid('tx'), userId: deal.sellerId, type: 'deal_income', currency: deal.currency,
        amount: deal.price, status: 'done', createdAt: new Date().toISOString() });
    }
    if (deal.buyerId) {
      const b = data.users[deal.buyerId];
      if (b) b.turnoverUsd = Math.round((b.turnoverUsd + deal.price * RATES_TO_RUB[deal.currency] / RUB_PER_USD) * 100) / 100;
    }
  }
  save(data);
  return deal;
}
function adminPendingRequests() {
  const data = load();
  return data.transactions.filter(t => t.status === 'wait').map(t => ({
    ...t, username: (data.users[t.userId] || {}).username
  }));
}
function adminConfirmRequest(txId) {
  const data = load();
  const tx = data.transactions.find(t => t.id === txId);
  if (!tx || tx.status !== 'wait') return null;
  const u = data.users[tx.userId];
  if (u) {
    if (tx.type === 'deposit') u.balances[tx.currency] = (u.balances[tx.currency] || 0) + tx.amount;
    if (tx.type === 'withdraw') u.balances[tx.currency] = (u.balances[tx.currency] || 0) - tx.amount;
    if (tx.type === 'convert') u.balances[tx.fromCurrency] = (u.balances[tx.fromCurrency] || 0) - tx.fromAmount;
  }
  tx.status = 'done';
  save(data);
  return tx;
}
function adminSetBalance(userId, currency, value) {
  const data = load();
  const u = data.users[String(userId)];
  if (!u) return null;
  u.balances[currency] = Number(value);
  save(data);
  return u;
}
function adminUsers() { return Object.values(load().users); }

module.exports = {
  CURRENCIES, RATES_TO_RUB, ensureUser, getUser, getDeals, createDeal,
  createRequest, getTransactions, cancelRequest,
  adminPendingDeals, adminSetDealStep, adminPendingRequests, adminConfirmRequest, adminSetBalance, adminUsers
};
