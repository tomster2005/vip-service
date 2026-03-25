require('dotenv').config()

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN)

const PORT = process.env.PORT || 4242
const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook'

app.use(express.json())

// webhook endpoint
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  try {
    console.log('Telegram webhook hit')
    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (error) {
    console.error('Error processing Telegram update:', error)
    res.sendStatus(500)
  }
})

// basic route
app.get('/', (req, res) => {
  res.send('Server running')
})

// log messages
bot.on('message', (msg) => {
  console.log('Message received:', {
    text: msg.text,
    from: msg.from?.id,
    chatId: msg.chat?.id,
  })
})

// start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 'Bot is working ✅')
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})