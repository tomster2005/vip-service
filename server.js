require('dotenv').config()

const express = require('express')
const TelegramBot = require('node-telegram-bot-api')
const Stripe = require('stripe')
const Database = require('better-sqlite3')
const path = require('path')

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

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
const DISCORD_SERVER_ID = process.env.DISCORD_SERVER_ID
const DISCORD_VIP_ROLE_ID = process.env.DISCORD_VIP_ROLE_ID

if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN')
if (!DOMAIN) throw new Error('Missing DOMAIN')
if (!TELEGRAM_TIPS_CHAT_ID) throw new Error('Missing TELEGRAM_TIPS_CHAT_ID')
if (!TELEGRAM_VIP_CHAT_ID) throw new Error('Missing TELEGRAM_VIP_CHAT_ID')
if (!STRIPE_SECRET_KEY) throw new Error('Missing STRIPE_SECRET_KEY')
if (!STRIPE_PRICE_ID) throw new Error('Missing STRIPE_PRICE_ID')
if (!STRIPE_WEBHOOK_SECRET) throw new Error('Missing STRIPE_WEBHOOK_SECRET')
if (!DISCORD_BOT_TOKEN) throw new Error('Missing DISCORD_BOT_TOKEN')
if (!DISCORD_SERVER_ID) throw new Error('Missing DISCORD_SERVER_ID')
if (!DISCORD_VIP_ROLE_ID) throw new Error('Missing DISCORD_VIP_ROLE_ID')

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN)
const stripe = new Stripe(STRIPE_SECRET_KEY)

const dbPath = path.join(__dirname, 'vip-service.db')
const db = new Database(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_user_id TEXT UNIQUE,
    telegram_chat_id TEXT,
    telegram_username TEXT,
    discord_user_id TEXT,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_checkout_session_id TEXT,
    subscription_status TEXT,
    current_period_end TEXT,
    has_access INTEGER DEFAULT 0,
    discord_role_assigned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`)

function ensureColumnExists(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  const exists = columns.some((col) => col.name === columnName)

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`)
    console.log(`Added missing column: ${columnName}`)
  }
}

ensureColumnExists('subscribers', 'discord_user_id', 'TEXT')
ensureColumnExists('subscribers', 'discord_role_assigned', 'INTEGER DEFAULT 0')

function runQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).run(params))
}

function getQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).get(params))
}

function allQuery(sql, params = []) {
  return Promise.resolve(db.prepare(sql).all(params))
}

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).toISOString()
}

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

function statusCountsAsActive(status) {
  return ['active', 'trialing'].includes(String(status || '').toLowerCase())
}

function userHasActiveAccess(subscriber) {
  if (!subscriber) return false
  if (Number(subscriber.has_access) === 1) return true
  if (statusCountsAsActive(subscriber.subscription_status)) return true
  return false
}

async function ensureSubscriberExists(telegramUserId, telegramUsername = null, telegramChatId = null) {
  const existing = await getQuery(
    `SELECT * FROM subscribers WHERE telegram_user_id = ?`,
    [String(telegramUserId)]
  )

  if (!existing) {
    await runQuery(
      `
      INSERT INTO subscribers (
        telegram_user_id,
        telegram_chat_id,
        telegram_username,
        subscription_status,
        has_access,
        discord_role_assigned
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        String(telegramUserId),
        telegramChatId ? String(telegramChatId) : null,
        telegramUsername,
        'pending',
        0,
        0,
      ]
    )
    return
  }

  await runQuery(
    `
    UPDATE subscribers
    SET
      telegram_username = COALESCE(?, telegram_username),
      telegram_chat_id = COALESCE(?, telegram_chat_id),
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [
      telegramUsername || null,
      telegramChatId ? String(telegramChatId) : null,
      String(telegramUserId),
    ]
  )
}

async function getSubscriberByTelegramUserId(telegramUserId) {
  return getQuery(`SELECT * FROM subscribers WHERE telegram_user_id = ?`, [
    String(telegramUserId),
  ])
}

async function getSubscriberByStripeSubscriptionId(subscriptionId) {
  return getQuery(`SELECT * FROM subscribers WHERE stripe_subscription_id = ?`, [
    subscriptionId,
  ])
}

async function getSubscriberByStripeCustomerId(customerId) {
  return getQuery(`SELECT * FROM subscribers WHERE stripe_customer_id = ?`, [
    customerId,
  ])
}

async function setSubscriberAccess({
  telegramUserId,
  status,
  hasAccess,
  currentPeriodEnd = null,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
  stripeCheckoutSessionId = null,
}) {
  await runQuery(
    `
    UPDATE subscribers
    SET
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      stripe_subscription_id = COALESCE(?, stripe_subscription_id),
      stripe_checkout_session_id = COALESCE(?, stripe_checkout_session_id),
      subscription_status = ?,
      current_period_end = ?,
      has_access = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [
      stripeCustomerId,
      stripeSubscriptionId,
      stripeCheckoutSessionId,
      status,
      currentPeriodEnd,
      hasAccess ? 1 : 0,
      String(telegramUserId),
    ]
  )
}

async function markDiscordRoleAssigned(telegramUserId, isAssigned) {
  await runQuery(
    `
    UPDATE subscribers
    SET
      discord_role_assigned = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [isAssigned ? 1 : 0, String(telegramUserId)]
  )
}

async function setDiscordUserIdForSubscriber(telegramUserId, discordUserId) {
  await runQuery(
    `
    UPDATE subscribers
    SET
      discord_user_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
    `,
    [String(discordUserId), String(telegramUserId)]
  )
}

async function discordApi(pathname, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Discord API ${response.status}: ${text}`)
  }

  return true
}

async function addDiscordVipRole(discordUserId) {
  await discordApi(
    `/guilds/${DISCORD_SERVER_ID}/members/${discordUserId}/roles/${DISCORD_VIP_ROLE_ID}`,
    { method: 'PUT' }
  )
}

async function removeDiscordVipRole(discordUserId) {
  await discordApi(
    `/guilds/${DISCORD_SERVER_ID}/members/${discordUserId}/roles/${DISCORD_VIP_ROLE_ID}`,
    { method: 'DELETE' }
  )
}

async function syncDiscordRoleForSubscriber(subscriber) {
  if (!subscriber?.discord_user_id) {
    return { ok: false, reason: 'no_discord_user_id' }
  }

  if (userHasActiveAccess(subscriber)) {
    await addDiscordVipRole(subscriber.discord_user_id)
    await markDiscordRoleAssigned(subscriber.telegram_user_id, true)
    return { ok: true, action: 'assigned' }
  }

  await removeDiscordVipRole(subscriber.discord_user_id)
  await markDiscordRoleAssigned(subscriber.telegram_user_id, false)
  return { ok: true, action: 'removed' }
}

async function sendVipInviteLinks(telegramUserId) {
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
}

async function getTelegramUserIdFromStripeObjects({
  directTelegramUserId = null,
  customerId = null,
  subscriptionId = null,
}) {
  if (directTelegramUserId) return String(directTelegramUserId)

  if (subscriptionId) {
    const bySub = await getSubscriberByStripeSubscriptionId(subscriptionId)
    if (bySub?.telegram_user_id) return String(bySub.telegram_user_id)
  }

  if (customerId) {
    const byCustomer = await getSubscriberByStripeCustomerId(customerId)
    if (byCustomer?.telegram_user_id) return String(byCustomer.telegram_user_id)
  }

  return null
}

app.get('/', (req, res) => {
  res.send('Telegram + Stripe + Discord server is running')
})

app.get('/health', async (req, res) => {
  try {
    const countRow = await getQuery(`SELECT COUNT(*) as count FROM subscribers`)

    res.json({
      ok: true,
      domain: DOMAIN,
      telegramWebhookPath: TELEGRAM_WEBHOOK_PATH,
      stripeWebhookPath: STRIPE_WEBHOOK_PATH,
      telegramTipsChatIdSet: Boolean(TELEGRAM_TIPS_CHAT_ID),
      telegramVipChatIdSet: Boolean(TELEGRAM_VIP_CHAT_ID),
      stripePriceIdSet: Boolean(STRIPE_PRICE_ID),
      discordServerIdSet: Boolean(DISCORD_SERVER_ID),
      discordVipRoleIdSet: Boolean(DISCORD_VIP_ROLE_ID),
      subscribersCount: countRow?.count || 0,
    })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    })
  }
})

app.get('/set-webhook', async (req, res) => {
  try {
    const webhookUrl = `${DOMAIN}${TELEGRAM_WEBHOOK_PATH}`
    const result = await bot.setWebHook(webhookUrl)

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

app.get('/subscribers', async (req, res) => {
  try {
    const rows = await allQuery(`
      SELECT
        telegram_user_id,
        telegram_chat_id,
        telegram_username,
        discord_user_id,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_checkout_session_id,
        subscription_status,
        current_period_end,
        has_access,
        discord_role_assigned,
        created_at,
        updated_at
      FROM subscribers
      ORDER BY created_at DESC
    `)

    res.json(rows)
  } catch (error) {
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
        STRIPE_WEBHOOK_SECRET.trim()
      )
    } catch (error) {
      console.error('Stripe webhook signature verification failed:', error.message)
      return res.status(400).send(`Webhook Error: ${error.message}`)
    }

    try {
      console.log('Stripe event received:', event.type)

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object
        const telegramUserId = await getTelegramUserIdFromStripeObjects({
          directTelegramUserId: session.metadata?.telegramUserId || session.client_reference_id,
          customerId: session.customer || null,
          subscriptionId: session.subscription || null,
        })

        if (!telegramUserId) {
          console.error('No telegramUserId found in Stripe session')
          return res.status(200).json({ received: true })
        }

        await setSubscriberAccess({
          telegramUserId,
          status: 'checkout_completed',
          hasAccess: 0,
          stripeCustomerId: session.customer || null,
          stripeSubscriptionId: session.subscription || null,
          stripeCheckoutSessionId: session.id || null,
        })

        if (session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription)
          const isActive = statusCountsAsActive(subscription.status)

          await setSubscriberAccess({
            telegramUserId,
            status: subscription.status || 'active',
            hasAccess: isActive,
            currentPeriodEnd: unixToIso(subscription.current_period_end),
            stripeCustomerId: session.customer || null,
            stripeSubscriptionId: subscription.id || null,
            stripeCheckoutSessionId: session.id || null,
          })

          if (isActive) {
            await sendVipInviteLinks(telegramUserId)

            const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

            if (updatedSubscriber?.discord_user_id) {
              try {
                await syncDiscordRoleForSubscriber(updatedSubscriber)
                await bot.sendMessage(
                  Number(telegramUserId),
                  '✅ Your Discord VIP role has been assigned.'
                )
              } catch (error) {
                console.error('Discord role assignment failed after checkout:', error.message)
                await bot.sendMessage(
                  Number(telegramUserId),
                  '⚠️ Your payment worked, but I could not assign your Discord VIP role yet. Make sure the Discord bot is in the server, the bot role is above the VIP role, and your Discord ID is correct.'
                )
              }
            } else {
              await bot.sendMessage(
                Number(telegramUserId),
                'ℹ️ To unlock Discord VIP as well, send:\n/discord YOUR_DISCORD_ID'
              )
            }
          }
        }
      }

      if (event.type === 'invoice.paid') {
        const invoice = event.data.object
        const telegramUserId = await getTelegramUserIdFromStripeObjects({
          customerId: invoice.customer || null,
          subscriptionId: invoice.subscription || null,
        })

        if (telegramUserId) {
          let subscription = null

          if (invoice.subscription) {
            subscription = await stripe.subscriptions.retrieve(invoice.subscription)
          }

          await setSubscriberAccess({
            telegramUserId,
            status: subscription?.status || 'active',
            hasAccess: statusCountsAsActive(subscription?.status || 'active'),
            currentPeriodEnd: unixToIso(subscription?.current_period_end),
            stripeCustomerId: invoice.customer || null,
            stripeSubscriptionId: invoice.subscription || null,
          })

          const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

          if (updatedSubscriber?.discord_user_id && userHasActiveAccess(updatedSubscriber)) {
            try {
              await syncDiscordRoleForSubscriber(updatedSubscriber)
            } catch (error) {
              console.error('Discord role assignment failed on invoice.paid:', error.message)
            }
          }
        }
      }

      if (event.type === 'invoice.payment_failed') {
        const invoice = event.data.object
        const telegramUserId = await getTelegramUserIdFromStripeObjects({
          customerId: invoice.customer || null,
          subscriptionId: invoice.subscription || null,
        })

        if (telegramUserId) {
          await setSubscriberAccess({
            telegramUserId,
            status: 'past_due',
            hasAccess: 0,
            stripeCustomerId: invoice.customer || null,
            stripeSubscriptionId: invoice.subscription || null,
          })

          const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

          if (updatedSubscriber?.discord_user_id) {
            try {
              await syncDiscordRoleForSubscriber(updatedSubscriber)
            } catch (error) {
              console.error('Discord role removal failed on invoice.payment_failed:', error.message)
            }
          }
        }
      }

      if (event.type === 'customer.subscription.updated') {
        const subscription = event.data.object
        const telegramUserId = await getTelegramUserIdFromStripeObjects({
          customerId: subscription.customer || null,
          subscriptionId: subscription.id || null,
        })

        if (telegramUserId) {
          await setSubscriberAccess({
            telegramUserId,
            status: subscription.status || 'unknown',
            hasAccess: statusCountsAsActive(subscription.status),
            currentPeriodEnd: unixToIso(subscription.current_period_end),
            stripeCustomerId: subscription.customer || null,
            stripeSubscriptionId: subscription.id || null,
          })

          const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

          if (updatedSubscriber?.discord_user_id) {
            try {
              await syncDiscordRoleForSubscriber(updatedSubscriber)
            } catch (error) {
              console.error('Discord sync failed on customer.subscription.updated:', error.message)
            }
          }
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object
        const telegramUserId = await getTelegramUserIdFromStripeObjects({
          customerId: subscription.customer || null,
          subscriptionId: subscription.id || null,
        })

        if (telegramUserId) {
          await setSubscriberAccess({
            telegramUserId,
            status: 'canceled',
            hasAccess: 0,
            currentPeriodEnd: unixToIso(subscription.current_period_end),
            stripeCustomerId: subscription.customer || null,
            stripeSubscriptionId: subscription.id || null,
          })

          const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

          if (updatedSubscriber?.discord_user_id) {
            try {
              await syncDiscordRoleForSubscriber(updatedSubscriber)
            } catch (error) {
              console.error('Discord sync failed on customer.subscription.deleted:', error.message)
            }
          }
        }
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
    bot.processUpdate(req.body)
    res.sendStatus(200)
  } catch (error) {
    console.error('Error processing Telegram update:', error)
    res.sendStatus(500)
  }
})

bot.onText(/\/start/, async (msg) => {
  try {
    await ensureSubscriberExists(
      msg.from?.id,
      msg.from?.username || null,
      msg.chat?.id
    )

    await bot.sendMessage(
      msg.chat.id,
      'Bot is working ✅\n\nUse /buy to subscribe.\nUse /discord YOUR_DISCORD_ID to link Discord.'
    )
  } catch (error) {
    console.error('/start error:', error)
  }
})

bot.onText(/\/buy/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)
    const telegramUsername = msg.from?.username || null
    const telegramChatId = msg.chat?.id

    await ensureSubscriberExists(telegramUserId, telegramUsername, telegramChatId)

    const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

    if (userHasActiveAccess(subscriber)) {
      await bot.sendMessage(
        msg.chat.id,
        '✅ You already have an active subscription.\n\nUse /links for fresh Telegram links.\nUse /discord YOUR_DISCORD_ID if you still need Discord VIP.'
      )
      return
    }

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

    await runQuery(
      `
      UPDATE subscribers
      SET
        stripe_checkout_session_id = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE telegram_user_id = ?
      `,
      [session.id || null, telegramUserId]
    )

    await bot.sendMessage(
      msg.chat.id,
      'Tap below to subscribe:',
      buildCheckoutButton(session.url)
    )
  } catch (error) {
    console.error('/buy error:', error)

    await bot.sendMessage(
      msg.chat.id,
      `❌ Failed to create checkout session.\n\n${error.message}`
    )
  }
})

bot.onText(/\/links/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)
    const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

    if (!userHasActiveAccess(subscriber)) {
      await bot.sendMessage(
        msg.chat.id,
        '❌ You do not have an active subscription right now.'
      )
      return
    }

    await sendVipInviteLinks(telegramUserId)
  } catch (error) {
    console.error('/links error:', error)
    await bot.sendMessage(
      msg.chat.id,
      `❌ Failed to generate fresh links.\n\n${error.message}`
    )
  }
})

bot.onText(/\/status/, async (msg) => {
  try {
    const telegramUserId = String(msg.from?.id)
    const subscriber = await getSubscriberByTelegramUserId(telegramUserId)

    if (!subscriber) {
      await bot.sendMessage(msg.chat.id, 'No subscription record found yet.')
      return
    }

    await bot.sendMessage(
      msg.chat.id,
      `Status: ${subscriber.subscription_status || 'unknown'}\nAccess: ${
        userHasActiveAccess(subscriber) ? 'yes' : 'no'
      }\nDiscord linked: ${subscriber.discord_user_id ? 'yes' : 'no'}\nDiscord role assigned: ${
        Number(subscriber.discord_role_assigned) === 1 ? 'yes' : 'no'
      }\nPeriod end: ${subscriber.current_period_end || 'n/a'}`
    )
  } catch (error) {
    console.error('/status error:', error)
    await bot.sendMessage(msg.chat.id, '❌ Failed to check status.')
  }
})

bot.onText(/\/discord (.+)/, async (msg, match) => {
  try {
    const telegramUserId = String(msg.from?.id)
    const discordUserId = String(match[1] || '').trim()

    if (!/^\d{17,20}$/.test(discordUserId)) {
      await bot.sendMessage(
        msg.chat.id,
        '❌ That does not look like a valid Discord user ID.\n\nExample:\n/discord 1350623540491063358'
      )
      return
    }

    await ensureSubscriberExists(
      telegramUserId,
      msg.from?.username || null,
      msg.chat?.id
    )

    await setDiscordUserIdForSubscriber(telegramUserId, discordUserId)

    const updatedSubscriber = await getSubscriberByTelegramUserId(telegramUserId)

    if (userHasActiveAccess(updatedSubscriber)) {
      try {
        await syncDiscordRoleForSubscriber(updatedSubscriber)
        await bot.sendMessage(
          msg.chat.id,
          '✅ Your Discord ID has been linked and your VIP role has been assigned.'
        )
        return
      } catch (error) {
        console.error('/discord role assignment error:', error.message)
        await bot.sendMessage(
          msg.chat.id,
          '⚠️ Your Discord ID was saved, but I could not assign the VIP role yet. Check that:\n- the Discord bot is in the server\n- the bot role is above the VIP role\n- the Discord user ID is correct\n- you are already in the Discord server'
        )
        return
      }
    }

    await bot.sendMessage(
      msg.chat.id,
      '✅ Your Discord ID has been saved.\n\nWhen you subscribe, the VIP role will be assigned automatically.'
    )
  } catch (error) {
    console.error('/discord error:', error)
    await bot.sendMessage(
      msg.chat.id,
      `❌ Failed to save Discord ID.\n\n${error.message}`
    )
  }
})

bot.onText(/\/testinvite/, async (msg) => {
  try {
    await sendVipInviteLinks(String(msg.from?.id))
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