require('dotenv').config()

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')

const app = express()

const PORT = process.env.PORT || 4242
const DOMAIN = process.env.DOMAIN
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook'

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in environment variables')
}

if (!DOMAIN) {
  throw new Error('Missing DOMAIN in environment variables')
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN)

app.use(express.json())

app.get('/', (req, res) => {
  res.send('Telegram bot server is running')
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    domain: DOMAIN,
    webhookPath: TELEGRAM_WEBHOOK_PATH,
  })
})

app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${DOMAIN}${TELEGRAM_WEBHOOK_PATH}`
    const result = await bot.setWebHook(webhookUrl)

    console.log('Webhook set to:', webhookUrl)

    res.json({
      ok: true,
      webhookUrl,
      result,
    })
  } catch (error) {
    console.error('Failed to set webhook:', error)
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/webhook-info', async (req, res) => {
  try {
    const info = await bot.getWebHookInfo()
    res.json({
      ok: true,
      info,
    })
  } catch (error) {
    console.error('Failed to get webhook info:', error)
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

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

bot.onText(/\/start/, async (msg) => {
  try {
    await bot.sendMessage(msg.chat.id, 'Bot is working ✅')
  } catch (error) {
    console.error('/start error:', error)
  }
})

bot.on('message', (msg) => {
  console.log('Message received:', {
    text: msg.text,
    from: msg.from?.id,
    chatId: msg.chat?.id,
    chatType: msg.chat?.type,
    chatTitle: msg.chat?.title,
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})