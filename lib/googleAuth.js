// lib/googleAuth.js
// Verificación de ID tokens de Google Sign-In — compartida por analyze.js,
// chat.js, quota-status.js y verify-purchase.js.
//
// La verificación es local (firma JWT contra las claves públicas de Google,
// cacheadas por la librería) — no hace ninguna llamada de red a Google en
// el caso común, por eso es segura de usar en cada request sin costo extra.

const { OAuth2Client } = require('google-auth-library')

const WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID

const client = new OAuth2Client(WEB_CLIENT_ID)

/**
 * Verifica un ID token de Google Sign-In.
 * @param {string} idToken
 * @returns {Promise<{ sub: string, email: string } | null>} null si el token
 *          es inválido, expiró, o no corresponde a nuestro Web Client ID.
 */
async function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return null
  if (!WEB_CLIENT_ID) {
    console.error('googleAuth: falta GOOGLE_WEB_CLIENT_ID en las env vars')
    return null
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: WEB_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    if (!payload || !payload.sub) return null

    return {
      sub: payload.sub,
      email: payload.email || null,
    }
  } catch (err) {
    console.warn('googleAuth: idToken inválido:', err.message)
    return null
  }
}

module.exports = { verifyIdToken }
