require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const miniAppUrl = process.env.MINI_APP_URL;

if (!token) {
  console.warn('BOT_TOKEN не задан в .env — бот не запущен, работает только API.');
  module.exports = null;
} else {
  const bot = new TelegramBot(token, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Добро пожаловать в Novamesh! Открывайте сделки через кнопку ниже.', {
      reply_markup: {
        inline_keyboard: [[{ text: '📱 Открыть Novamesh', web_app: { url: miniAppUrl } }]]
      }
    });
  });

  console.log('Telegram-бот запущен (polling).');
  module.exports = bot;
}
