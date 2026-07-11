// Vercel Serverless Function
// Ruta: /api/quota-status.js
//
// Lectura de la cuota actual (análisis + chat) de una cuenta. Aplica el
// reset lazy de 30 días si el ciclo venció, pero NO consume nada — lo usan
// HomeScreen, UpgradeScreen y el banner de ChatScreen para pintar el estado
// sin necesidad de intentar un análisis/mensaje primero.

const { Redis } = require('@upstash/redis')
const { Ratelimit } = require('@upstash/ratelimit')
const { verifyIdToken } = require('../lib/googleAuth')
const { getQuotaStatus, isPro } = require('../lib/quota')

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
})

const ipRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  prefix: 'vetai:rl:quota-status:ip',
})

const subRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, '60 s'),
  prefix: 'vetai:rl:quota-status:sub',
})

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
  try {
    const { success } = await ipRatelimit.limit(ip)
    if (!success) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    }
  } catch (rlErr) {
    console.error('[RATE-LIMIT] Error consultando Redis (IP), continuando sin límite:', rlErr.message)
  }

  const internalToken = req.headers['x-internal-token']
  if (!internalToken || internalToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { idToken } = req.body

  const account = await verifyIdToken(idToken)
  if (!account) {
    return res.status(401).json({ error: 'invalid_session', message: 'Sign in with Google required.' })
  }
  const { sub } = account

  try {
    const { success } = await subRatelimit.limit(sub)
    if (!success) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    }
  } catch (rlErr) {
    console.error('[RATE-LIMIT] Error consultando Redis (sub), continuando sin límite:', rlErr.message)
  }

  try {
    const [userIsPro, status] = await Promise.all([
      isPro(sub),
      getQuotaStatus(sub),
    ])

    return res.status(200).json({
      isPro: userIsPro,
      analysesRemaining: userIsPro ? 999 : status.analysesRemaining,
      analysesMax: status.analysesMax,
      chatRemaining: userIsPro ? 999 : status.chatRemaining,
      chatMax: status.chatMax,
      resetAt: status.resetAt,
    })
  } catch (err) {
    console.error('quota-status: error leyendo cuota:', err.message)
    return res.status(503).json({ error: 'quota_unavailable', message: 'Could not read your quota. Try again.' })
  }
}
