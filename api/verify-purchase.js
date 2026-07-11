// Vercel Serverless Function
// Ruta: /api/verify-purchase.js

const { GoogleAuth } = require('google-auth-library')
const { Redis } = require('@upstash/redis')
const { Ratelimit } = require('@upstash/ratelimit')
const { verifyIdToken } = require('../lib/googleAuth')
const { setProStatus, clearProStatus } = require('../lib/quota')

const PACKAGE_NAME = 'com.heiresel.vetai'
const PRODUCT_ID = 'vetai_pro_monthly'

// Rate limiter — fuera del handler para reusarse entre invocaciones warm.
// Los nombres de env vars son los compuestos que generó la integración
// Upstash del Marketplace con prefijo custom (no los que fromEnv() busca).
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
})

const ratelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  prefix: 'vetai:verify',
})

module.exports = async (req, res) => {
  // Solo acepta POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Rate limit por IP — antes de cualquier otra validación.
  // Fail-open: si Redis falla, no bloquear compras reales.
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
  try {
    const { success, remaining } = await ratelimit.limit(ip)
    if (!success) {
      console.warn(`[RATE-LIMIT] IP bloqueada: ${ip} — límite 10/60s superado`)
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    }
    console.log(`[RATE-LIMIT] IP ${ip} OK — ${remaining} requests restantes en la ventana`)
  } catch (rlErr) {
    console.error('[RATE-LIMIT] Error consultando Redis, continuando sin límite:', rlErr.message)
  }

  // Verificar token interno
  const internalToken = req.headers['x-internal-token']
  if (!internalToken || internalToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { purchaseToken, idToken } = req.body

    // Validación
    if (!purchaseToken) {
      return res.status(400).json({ error: 'Missing purchaseToken' })
    }

    // idToken es OPCIONAL — mantiene compatibilidad con el flujo de
    // verificación que ya existía antes de la migración a quota server-side.
    // Si viene, marcamos/limpiamos vetai:pro:{sub} en Redis para que
    // analyze.js y chat.js puedan saltear la cuota con evidencia server-side.
    let account = null
    if (idToken) {
      account = await verifyIdToken(idToken)
      if (!account) {
        console.warn('[PRO-STATUS] idToken presente pero inválido — se ignora, no bloquea la verificación de compra. purchaseToken:', purchaseToken.slice(0, 20) + '…')
      } else {
        console.log('[PRO-STATUS] idToken válido, sub resuelto:', account.sub)
      }
    } else {
      console.warn('[PRO-STATUS] Sin idToken en el body — no se puede marcar vetai:pro:{sub} para esta verificación. purchaseToken:', purchaseToken.slice(0, 20) + '…')
    }

    // Wrapper con logging explícito de éxito/fallo — setProStatus/clearProStatus
    // NO deben poder tirar abajo la respuesta de verificación de compra (que
    // ya es válida según Google Play) solo porque Redis falló. Antes, una
    // excepción acá caía en el catch general del handler y devolvía 500 sin
    // dejar rastro de que la compra SÍ era válida pero el marcado Pro falló.
    const markProStatus = async (sub, expiryTimeMillis) => {
      try {
        await setProStatus(sub, expiryTimeMillis)
        console.log('[PRO-STATUS] ✅ setProStatus OK — sub:', sub, 'expiryTimeMillis:', expiryTimeMillis)
      } catch (err) {
        console.error('[PRO-STATUS] ❌ setProStatus FALLÓ — sub:', sub, 'expiryTimeMillis:', expiryTimeMillis, 'error:', err.message)
      }
    }
    const markProCleared = async (sub, reason) => {
      try {
        await clearProStatus(sub)
        console.log('[PRO-STATUS] ✅ clearProStatus OK — sub:', sub, 'reason:', reason)
      } catch (err) {
        console.error('[PRO-STATUS] ❌ clearProStatus FALLÓ — sub:', sub, 'reason:', reason, 'error:', err.message)
      }
    }

    // Autenticación con Google
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    })
    const client = await auth.getClient()
    const tokenResponse = await client.getAccessToken()
    const accessToken = tokenResponse.token

    // Llamar a Google Play Developer API
    const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}/purchases/subscriptions/${PRODUCT_ID}/tokens/${purchaseToken}`

    console.log('Verifying purchase token with Google Play API')

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    })

    if (response.status === 404) {
      console.log('Purchase not found:', purchaseToken)
      if (account) await markProCleared(account.sub, 'purchase_not_found')
      return res.status(200).json({ valid: false, reason: 'purchase_not_found' })
    }

    if (!response.ok) {
      const error = await response.json()
      console.error('Google Play API error:', error)
      return res.status(500).json({ error: 'Google Play API failed', message: JSON.stringify(error) })
    }

    const data = await response.json()
    const { expiryTimeMillis } = data

    if (!expiryTimeMillis) {
      console.log('Purchase valid (no expiryTimeMillis - new purchase):', purchaseToken)
      if (account) await markProStatus(account.sub, null)
      return res.status(200).json({ valid: true, expiryTimeMillis: null })
    }

    if (parseInt(expiryTimeMillis) > Date.now()) {
      console.log('Purchase valid, expires:', new Date(parseInt(expiryTimeMillis)).toISOString())
      if (account) await markProStatus(account.sub, parseInt(expiryTimeMillis))
      return res.status(200).json({ valid: true, expiryTimeMillis })
    }

    console.log('Subscription expired at:', new Date(parseInt(expiryTimeMillis)).toISOString())
    if (account) await markProCleared(account.sub, 'subscription_expired')
    return res.status(200).json({ valid: false, reason: 'subscription_expired' })

  } catch (error) {
    console.error('Server error:', error)
    return res.status(500).json({ error: 'Internal server error', message: error.message })
  }
}
