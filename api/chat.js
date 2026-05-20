// Vercel Serverless Function
// Ruta: /api/chat.js

module.exports = async (req, res) => {
  // Solo acepta POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { messages, base64Image } = req.body

    // Validaciones
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Missing or invalid messages array' })
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY
    const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

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

    // Construir el payload para Groq
    const groqMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    // Si hay imagen en base64, agregarla al último mensaje del usuario
    if (base64Image) {
      const lastUserMsgIndex = groqMessages.map(m => m.role).lastIndexOf('user')
      if (lastUserMsgIndex !== -1) {
        const lastMsg = groqMessages[lastUserMsgIndex]
        const textContent = typeof lastMsg.content === 'string' 
          ? lastMsg.content 
          : 'Por favor analizá esta foto de mi mascota y decime qué observás.'

        groqMessages[lastUserMsgIndex] = {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
            { type: 'text', text: textContent }
          ]
        }
      }
    }

    // Llamar a Groq
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: groqMessages,
        max_tokens: 600,
        temperature: 0.3,
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('Groq API error:', error)
      return res.status(response.status).json({ 
        error: 'Groq API failed', 
        details: error 
      })
    }

    const data = await response.json()

    if (data.error) {
      console.error('Groq error response:', data.error)
      return res.status(500).json({ 
        error: 'Groq error', 
        message: data.error.message || 'Unknown error' 
      })
    }

    const reply = data.choices?.[0]?.message?.content

    if (!reply) {
      return res.status(500).json({ error: 'Empty response from Groq' })
    }

    // Respuesta exitosa
    return res.status(200).json({
      reply,
      model: data.model,
      usage: data.usage
    })

  } catch (error) {
    console.error('Server error:', error)
    return res.status(500).json({ 
      error: 'Internal server error', 
      message: error.message 
    })
  }
}
