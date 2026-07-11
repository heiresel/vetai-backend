// lib/quota.js
// Quota server-side atada a la cuenta de Google (sub), atómica vía script
// Lua sobre Upstash Redis — reemplaza el contador local de SQLite que se
// reseteaba con solo desinstalar la app.
//
// Un único hash por usuario (vetai:quota:{sub}) con DOS contadores que
// comparten el mismo reset_at (mismo ciclo de 30 días para análisis y chat):
//   analyses_used, chat_used, reset_at (epoch ms)
//
// Fail-closed: si Redis no responde, quien llama a consumeQuota() debe
// tratar la excepción como "no se pudo verificar la cuota" y bloquear el
// uso (nunca asumir que hay cupo disponible).

const { Redis } = require('@upstash/redis')

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
})

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000 // 30 días
const MAX_ANALYSES = 5
const MAX_CHAT = 5

// KEYS[1] = hash key
// ARGV[1] = field ('analyses_used' | 'chat_used')
// ARGV[2] = max para ese field
// ARGV[3] = now (epoch ms)
// ARGV[4] = period_ms
// ARGV[5] = ttl en segundos para la key completa (limpieza de cuentas inactivas)
//
// Devuelve: { allowed: 0|1, remaining, resetAt }
const CONSUME_SCRIPT = `
local key = KEYS[1]
local field = ARGV[1]
local max = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local period = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local resetAt = tonumber(redis.call('HGET', key, 'reset_at'))

if not resetAt or now >= resetAt then
  resetAt = now + period
  redis.call('HSET', key, 'analyses_used', 0, 'chat_used', 0, 'reset_at', resetAt)
end

local used = tonumber(redis.call('HGET', key, field)) or 0

if used >= max then
  redis.call('EXPIRE', key, ttl)
  return {0, 0, resetAt}
end

local newUsed = redis.call('HINCRBY', key, field, 1)
redis.call('EXPIRE', key, ttl)

return {1, max - newUsed, resetAt}
`

// KEYS[1] = hash key
// ARGV[1] = field
const REFUND_SCRIPT = `
local key = KEYS[1]
local field = ARGV[1]
local used = tonumber(redis.call('HGET', key, field)) or 0
if used > 0 then
  redis.call('HINCRBY', key, field, -1)
end
return 1
`

// KEYS[1] = hash key
// ARGV[1] = now (epoch ms)
// ARGV[2] = period_ms
// Solo lectura salvo por el reset lazy (que sí escribe si el ciclo venció).
const STATUS_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local period = tonumber(ARGV[2])

local resetAt = tonumber(redis.call('HGET', key, 'reset_at'))

if not resetAt or now >= resetAt then
  resetAt = now + period
  redis.call('HSET', key, 'analyses_used', 0, 'chat_used', 0, 'reset_at', resetAt)
end

local analysesUsed = tonumber(redis.call('HGET', key, 'analyses_used')) or 0
local chatUsed = tonumber(redis.call('HGET', key, 'chat_used')) or 0

return {analysesUsed, chatUsed, resetAt}
`

const keyFor = (sub) => `vetai:quota:${sub}`
const proKeyFor = (sub) => `vetai:pro:${sub}`

const FIELD_MAX = {
  analyses_used: MAX_ANALYSES,
  chat_used: MAX_CHAT,
}

/**
 * Consume atómicamente una unidad de cuota para `field` ('analyses_used' o
 * 'chat_used'). Lanza si Redis falla — el caller debe fail-closed.
 * @returns {Promise<{ allowed: boolean, remaining: number, resetAt: number }>}
 */
async function consumeQuota(sub, field) {
  const max = FIELD_MAX[field]
  if (!max) throw new Error(`consumeQuota: field inválido "${field}"`)

  const now = Date.now()
  const ttlSeconds = Math.ceil((PERIOD_MS * 2) / 1000)

  const [allowed, remaining, resetAt] = await redis.eval(
    CONSUME_SCRIPT,
    [keyFor(sub)],
    [field, String(max), String(now), String(PERIOD_MS), String(ttlSeconds)]
  )

  return { allowed: allowed === 1, remaining: Number(remaining), resetAt: Number(resetAt) }
}

/**
 * Devuelve una unidad de cuota consumida cuando el LLM falló después del
 * consumo — no penaliza al usuario por errores del servidor.
 */
async function refundQuota(sub, field) {
  if (!FIELD_MAX[field]) throw new Error(`refundQuota: field inválido "${field}"`)
  try {
    await redis.eval(REFUND_SCRIPT, [keyFor(sub)], [field])
  } catch (err) {
    // No relanzar — el refund es best-effort, no debe romper la respuesta
    // de error que ya se le está devolviendo al cliente.
    console.error('refundQuota error:', err.message)
  }
}

/**
 * Lectura de estado (aplica el reset lazy si el ciclo venció, pero no
 * consume). Usado por quota-status.js.
 */
async function getQuotaStatus(sub) {
  const now = Date.now()
  const [analysesUsed, chatUsed, resetAt] = await redis.eval(
    STATUS_SCRIPT,
    [keyFor(sub)],
    [String(now), String(PERIOD_MS)]
  )

  return {
    analysesUsed: Number(analysesUsed),
    analysesMax: MAX_ANALYSES,
    analysesRemaining: Math.max(0, MAX_ANALYSES - Number(analysesUsed)),
    chatUsed: Number(chatUsed),
    chatMax: MAX_CHAT,
    chatRemaining: Math.max(0, MAX_CHAT - Number(chatUsed)),
    resetAt: Number(resetAt),
  }
}

/**
 * Marca a un usuario como Pro server-side, con TTL hasta que expire la
 * suscripción según Google Play. Usado por verify-purchase.js.
 * @param {string} sub
 * @param {number|null} expiryTimeMillis — null significa "sin expiración
 *        conocida todavía" (primera compra, antes del primer ciclo de
 *        facturación).
 *
 * IMPORTANTE sobre el caso null: NO usar un TTL largo acá. restorePurchases()
 * en BillingService.js filtra `isActive` antes de llamar a verify-purchase
 * — si el usuario cancela la suscripción antes de que exista un
 * expiryTimeMillis real, la app deja de reportar ese sub al servidor y
 * NUNCA vuelve a haber una llamada que corrija el TTL. Un fallback largo
 * (ej. 35 días) dejaría un "Pro fantasma" marcado en Redis todo ese tiempo
 * sin forma de auto-corregirse. Por eso el fallback es corto (24h): si en
 * ese lapso el usuario vuelve a abrir la app y Play ya devuelve el
 * expiryTimeMillis real, setProStatus() se vuelve a llamar y el SET
 * sobreescribe con el TTL correcto (self-healing); si no, el marcado
 * expira solo y el peor caso es 24h de Pro no reconfirmado, no 35 días.
 */
async function setProStatus(sub, expiryTimeMillis) {
  const FALLBACK_TTL_SECONDS = 24 * 60 * 60 // 24h de resguardo, no 35 días
  let ttlSeconds

  if (expiryTimeMillis) {
    const secondsUntilExpiry = Math.ceil((expiryTimeMillis - Date.now()) / 1000)
    ttlSeconds = secondsUntilExpiry > 0 ? secondsUntilExpiry : 0
  } else {
    ttlSeconds = FALLBACK_TTL_SECONDS
  }

  if (ttlSeconds <= 0) {
    await redis.del(proKeyFor(sub))
    return
  }

  await redis.set(proKeyFor(sub), '1', { ex: ttlSeconds })
}

async function clearProStatus(sub) {
  await redis.del(proKeyFor(sub))
}

/**
 * @returns {Promise<boolean>}
 */
async function isPro(sub) {
  const val = await redis.get(proKeyFor(sub))
  return val !== null && val !== undefined
}

module.exports = {
  consumeQuota,
  refundQuota,
  getQuotaStatus,
  setProStatus,
  clearProStatus,
  isPro,
  MAX_ANALYSES,
  MAX_CHAT,
}
