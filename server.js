require('dotenv').config()

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const Stripe = require('stripe')

const app = express()

const PORT = process.env.PORT || 4242
const DOMAIN = process.env.DOMAIN
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_WEBHOOK_PATH = '/telegram-webhook'
const TELEGRAM_TIPS_CHAT_ID = process.env.TELEGRAM_TIPS_CHAT_ID
const TELEGRAM_VIP_CHAT_ID = process.env.TELEGRAM_VIP_CHAT_ID
const INVITE_EXPIRE_MINUTES = Number(process.env.INVITE_EXPIRE_MINUTES || 60)

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET
const STRIPE_WEBHOOK_PATH = '/stripe-webhook'

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')
if (!DOMAIN) throw new Error('Missing DOMAIN')
if (!TELEGRAM_TIPS_CHAT_ID) throw new Error('Missing TELEGRAM_TIPS_CHAT_ID')
if (!TELEGRAM_VIP_CHAT_ID) throw new Error('Missing TELEGRAM_VIP_CHAT_ID')
if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY')
if (!STRIPE_PRICE_ID) throw new Error('Missing STRIPE_PRICE_ID')
if (!STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET')

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN)
const stripe = new Stripe(STRIPE_SECRET_KEY)

function getInviteExpireDate() {
  return Math.floor(Date.now() / 1000) + INVITE_EXPIRE_MINUTES * 60
}

function buildCheckoutButton(sessionUrl) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Subscribe Now',
            url: sessionUrl,
          },
        ],
      ],
    },
  }
}

app.get('/', (req, res) => {
  res.send('Telegram + Stripe server is running')
})

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    domain: DOMAIN,
    telegramWebhookPath: TELEGRAM_WEBHOOK_PATH,
    stripeWebhookPath: STRIPE_WEBHOOK_PATH,
    telegramTipsChatIdSet: Boolean(TELEGRAM_TIPS_CHAT_ID),
    telegramVipChatIdSet: Boolean(TELEGRAM_VIP_CHAT_ID),
    inviteExpireMinutes: INVITE_EXPIRE_MINUTES,
    stripePriceIdSet: Boolean(STRIPE_PRICE_ID),
  })
})

app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${DOMAIN}${TELEGRAM_WEBHOOK_PATH}`
    const result = await bot.setWebHook(webhookUrl)

    console.log('Telegram webhook set to:', webhookUrl)

    res.json({
      ok: true,
      webhookUrl,
      result,
    })
  } catch (error) {
    console.error('Failed to set Telegram webhook:', error)
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
    console.error('Failed to get Telegram webhook info:', error)
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/success', (req, res) => {
  res.send('Payment successful. Return to Telegram.')
})

app.get('/cancel', (req, res) => {
  res.send('Payment cancelled.')
})

app.post(
  STRIPE_WEBHOOK_PATH,
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event

    try {
      const signature = req.headers['stripe-signature']

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      )
    } catch (error) {
      console.error('Stripe webhook signature verification failed:', error.message)
      return res.status(400).send(`Webhook Error: ${error.message}`)
    }

    try {
      console.log('Stripe event received:', event.type)

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object
        const telegramUserId =
          session.metadata?.telegramUserId || session.client_reference_id

        if (!telegramUserId) {
          console.error('No telegramUserId found in Stripe session')
          return res.status(200).json({ received: true })
        }

        const expireDate = getInviteExpireDate()

        const tipsInvite = await bot.createChatInviteLink(TELEGRAM_TIPS_CHAT_ID, {
          member_limit: 1,
          expire_date: expireDate,
        })

        const vipInvite = await bot.createChatInviteLink(TELEGRAM_VIP_CHAT_ID, {
          member_limit: 1,
          expire_date: expireDate,
        })

        await bot.sendMessage(
          Number(telegramUserId),
          `✅ Payment received.\n\nHere are your VIP access links.\n\n📈 Tips Chat:\n${tipsInvite.invite_link}\n\n💬 VIP Chat:\n${vipInvite.invite_link}\n\nThese links expire in ${INVITE_EXPIRE_MINUTES} minutes and only allow one join each.`
        )

        console.log('Invite links sent to Telegram user:', telegramUserId)
      }

      return res.status(200).json({ received: true })
    } catch (error) {
      console.error('Stripe webhook handling error:', error)
      return res.status(500).json({ error: 'Webhook handler failed' })
    }
  }
)

app.use(express.json())

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
    await bot.sendMessage(
      msg.chat.id,
      'Bot is working ✅\n\nUse /buy to get your VIP subscription link.'
    )
  } catch (error) {
    console.error('/start error:', error)
  }
})

bot.onText(/\/buy/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      success_url: `${DOMAIN}/success`,
      cancel_url: `${DOMAIN}/cancel`,
      client_reference_id: telegramUserId,
      metadata: {
        telegramUserId,
      },
    })

    await bot.sendMessage(
      msg.chat.id,
      'Tap below to subscribe:',
      buildCheckoutButton(session.url)
    )

    console.log('/buy checkout created for:', telegramUserId)
  } catch (error) {
    console.error('/buy error:', error)

    await bot.sendMessage(
      msg.chat.id,
      `❌ Failed to create checkout session.\n\n${error.message}`
    )
  }
})

bot.onText(/\/testinvite/, async (msg) => {
  try {
    const expireDate = getInviteExpireDate()

    const tipsInvite = await bot.createChatInviteLink(TELEGRAM_TIPS_CHAT_ID, {
      member_limit: 1,
      expire_date: expireDate,
    })

    const vipInvite = await bot.createChatInviteLink(TELEGRAM_VIP_CHAT_ID, {
      member_limit: 1,
      expire_date: expireDate,
    })

    await bot.sendMessage(
      msg.chat.id,
      `🎯 Test Invite Links\n\n📈 Tips Chat:\n${tipsInvite.invite_link}\n\n💬 VIP Chat:\n${vipInvite.invite_link}\n\nThese links expire in ${INVITE_EXPIRE_MINUTES} minutes.`
    )
  } catch (error) {
    console.error('/testinvite error:', error)

    await bot.sendMessage(
      msg.chat.id,
      `❌ Failed to generate invite links.\n\n${error.message}`
    )
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