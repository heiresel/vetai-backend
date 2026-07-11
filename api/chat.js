// Vercel Serverless Function
// Ruta: /api/chat.js
//
// Requiere sesión de Google (idToken) + token interno de la app.
// Comparte el mismo hash de cuota que analyze.js (campo chat_used, mismo
// reset_at) — 5 mensajes gratis / 30 días, fail-closed si Redis no responde.

const { Redis } = require('@upstash/redis')
const { Ratelimit } = require('@upstash/ratelimit')
const { verifyIdToken } = require('../lib/googleAuth')
const { consumeQuota, refundQuota, isPro } = require('../lib/quota')

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
})

const ipRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, '60 s'),
  prefix: 'vetai:rl:chat:ip',
})

const subRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, '60 s'),
  prefix: 'vetai:rl:chat:sub',
})

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // ── Rate limit por IP ──────────────────────────────────────────
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim()
  try {
    const { success } = await ipRatelimit.limit(ip)
    if (!success) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    }
  } catch (rlErr) {
    console.error('[RATE-LIMIT] Error consultando Redis (IP), continuando sin límite:', rlErr.message)
  }

  // ── Token interno de la app ────────────────────────────────────
  const internalToken = req.headers['x-internal-token']
  if (!internalToken || internalToken !== process.env.INTERNAL_API_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  // ── Sesión de Google ────────────────────────────────────────────
  const { idToken, messages, base64Image } = req.body

  const account = await verifyIdToken(idToken)
  if (!account) {
    return res.status(401).json({ error: 'invalid_session', message: 'Sign in with Google required.' })
  }
  const { sub } = account

  // ── Rate limit por cuenta ───────────────────────────────────────
  try {
    const { success } = await subRatelimit.limit(sub)
    if (!success) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
    }
  } catch (rlErr) {
    console.error('[RATE-LIMIT] Error consultando Redis (sub), continuando sin límite:', rlErr.message)
  }

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing or invalid messages array' })
  }

  // ── Cuota (fail-closed) ──────────────────────────────────────────
  let userIsPro = false
  try {
    userIsPro = await isPro(sub)
  } catch (err) {
    console.error('chat: error verificando estado Pro:', err.message)
    return res.status(503).json({ error: 'quota_unavailable', message: 'Could not verify your account status. Try again.' })
  }

  let quotaResult = null
  if (!userIsPro) {
    try {
      quotaResult = await consumeQuota(sub, 'chat_used')
    } catch (err) {
      console.error('chat: error consumiendo cuota:', err.message)
      return res.status(503).json({ error: 'quota_unavailable', message: 'Could not verify your quota. Try again.' })
    }

    if (!quotaResult.allowed) {
      return res.status(429).json({
        error: 'chat_exhausted',
        message: 'Free chat messages used up for this cycle.',
        quota: {
          chatRemaining: quotaResult.remaining,
          resetAt: quotaResult.resetAt,
          isPro: false,
        },
      })
    }
  }

  // ── Llamada a Agnes AI ───────────────────────────────────────────
  try {
    const AGNES_API_KEY = process.env.AGNES_API_KEY
    const AGNES_URL = 'https://apihub.agnes-ai.com/v1/chat/completions'

    const SYSTEM_PROMPT = `Sos el Dr. VetExotic — veterinario especialista con posgrado mundial en medicina de animales exóticos (reptiles, anfibios, arácnidos, mamíferos exóticos y aves no convencionales). Tenés más de 20 años de experiencia exclusiva.

TU ESPECIALIDAD — ANIMALES QUE ATENDÉS:
Reptiles: tortugas, iguanas, geckos, dragones barbudos, camaleones, serpientes, skinks, varanos.
Anfibios: ajolotes, ranas, sapos, salamandras, tritones.
Arácnidos: tarántulas, escorpiones, escolopendras.
Invertebrados: palo insecto, mantis religiosa, cucarachas gigantes, milpiés.
Mamíferos exóticos: erizos, chinchillas, conejos, cobayas, hurones, azúcar glider, ardillas, degus.
Aves no convencionales: loros, cacatúas, ninfas, agapornis, canarios, cotorras.
Peces exóticos: peces de agua dulce y marina de ornamento.

ANIMALES QUE NO ATENDÉS:
Perros y gatos — para ellos recomendá un veterinario clínico general.

REGLA CRÍTICA — VERIFICACIÓN DE IMÁGENES:
Si el usuario envía una imagen verificá que sea de uno de los animales de tu especialidad, sus heces, piel, escamas o entorno de vida.
Si la imagen muestra claramente una persona, parte del cuerpo humano, comida, objeto, paisaje, dispositivo electrónico, perro, gato o cualquier cosa fuera de tu especialidad, respondé EXACTAMENTE esto (en el idioma del usuario):
"Solo puedo analizar imágenes de mascotas exóticas como reptiles, anfibios, arácnidos, aves o mamíferos exóticos. Por favor enviá una foto de tu mascota para poder ayudarte. 🦎"
No hagas ningún análisis de imágenes de humanos bajo ninguna circunstancia.

REGLA — CONSULTAS SOBRE PERROS Y GATOS:
Si alguien pregunta sobre perros o gatos respondé:
"Mi especialidad son las mascotas exóticas. Para perros y gatos te recomiendo consultar con un veterinario clínico general. 🐾"

Respondés en el mismo idioma que el usuario (español o inglés).
Sos preciso, conservador y siempre priorizás el bienestar del animal.
Respondés de forma concisa pero completa — máximo 3-4 párrafos cortos.
Cuando el caso es grave, siempre recomendás visitar al veterinario.
Al final de cada respuesta sobre un problema específico, agregás: "⚠️ Recuerda que este consejo es orientativo y no reemplaza la consulta veterinaria presencial."`

    const agnesMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    if (base64Image) {
      const lastUserMsgIndex = agnesMessages.map(m => m.role).lastIndexOf('user')
      if (lastUserMsgIndex !== -1) {
        const lastMsg = agnesMessages[lastUserMsgIndex]
        const textContent = typeof lastMsg.content === 'string'
          ? lastMsg.content
          : 'Por favor analizá esta foto de mi mascota y decime qué observás.'

        agnesMessages[lastUserMsgIndex] = {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
            { type: 'text', text: textContent }
          ]
        }
      }
    }

    const response = await fetch(AGNES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGNES_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        messages: agnesMessages,
        max_tokens: 1500,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('Agnes API error:', error)
      if (quotaResult) await refundQuota(sub, 'chat_used')
      return res.status(response.status).json({
        error: 'Agnes API failed',
        details: error
      })
    }

    const data = await response.json()

    if (data.error) {
      console.error('Agnes error response:', data.error)
      if (quotaResult) await refundQuota(sub, 'chat_used')
      return res.status(500).json({
        error: 'Agnes error',
        message: data.error.message || 'Unknown error'
      })
    }

    const reply = data.choices?.[0]?.message?.content

    if (!reply) {
      if (quotaResult) await refundQuota(sub, 'chat_used')
      return res.status(500).json({ error: 'Empty response from Agnes' })
    }

    return res.status(200).json({
      reply,
      model: data.model,
      usage: data.usage,
      quota: userIsPro
        ? { isPro: true }
        : { chatRemaining: quotaResult.remaining, resetAt: quotaResult.resetAt, isPro: false },
    })

  } catch (error) {
    console.error('Server error:', error)
    if (quotaResult) await refundQuota(sub, 'chat_used')
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    })
  }
}
