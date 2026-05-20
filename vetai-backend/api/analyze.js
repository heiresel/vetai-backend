// Vercel Serverless Function
// Ruta: /api/analyze.js

module.exports = async (req, res) => {
  // Solo acepta POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { base64Image, species, analysisType, symptoms } = req.body

    // Validaciones
    if (!base64Image || !species) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const GROQ_API_KEY = process.env.GROQ_API_KEY
    const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

    // Construir prompt (mismo que en aiService.js)
    const prompt = buildPrompt(species, analysisType || 'general', symptoms || '')

    // Llamar a Groq
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
        max_tokens: 600,
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const error = await response.json()
      console.error('Groq API error:', error)
      return res.status(response.status).json({ error: 'Groq API failed', details: error })
    }

    const data = await response.json()
    const text = data.choices?.[0]?.message?.content

    if (!text) {
      return res.status(500).json({ error: 'Empty response from Groq' })
    }

    // Parsear respuesta
    const parsed = extractJSON(text)
    if (!parsed) {
      return res.status(500).json({ error: 'Could not parse response' })
    }

    const severity = ['bajo', 'medio', 'alto', 'invalida'].includes(parsed.severity)
      ? parsed.severity
      : 'bajo'

    // Respuesta final
    return res.status(200).json({
      diagnosis: parsed.diagnosis || 'Análisis completado.',
      confidence: Math.min(97, Math.max(0, parseInt(parsed.confidence) || 82)),
      severity,
      color: { bajo: 'verde', medio: 'amarillo', alto: 'rojo', invalida: 'gris' }[severity],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 4)
        : ['Consultá con un veterinario especializado en exóticos.'],
      isInvalid: severity === 'invalida',
    })

  } catch (error) {
    console.error('Server error:', error)
    return res.status(500).json({ error: 'Internal server error', message: error.message })
  }
}

// ── Funciones helpers (copiadas de aiService.js) ──

function buildPrompt(species, analysisType, symptoms = '') {
  const typeContext = {
    feces: `Estás analizando una fotografía de las HECES de un ${species}.
Evaluá con criterio clínico: color (normal/anormal), consistencia (firme/blanda/líquida), forma, presencia de mucosidad, sangre, parásitos visibles, uratos (en reptiles), olor aparente por textura, y cualquier anomalía.`,
    skin: `Estás analizando una fotografía de la PIEL, ESCAMAS o PROCESO DE MUDA de un ${species}.
Evaluá: hidratación cutánea, coloración (normal/pálida/enrojecida/oscura), presencia de lesiones, úlceras, infecciones, ectoparásitos visibles (ácaros, garrapatas), estado de las escamas, progreso de la muda, piel retenida y tejidos externos visibles.`,
    general: `Estás analizando una fotografía GENERAL de un ${species}.
Evaluá: postura corporal (normal/anormal), coloración general, tono muscular, estado de los ojos (brillantes/hundidos/cerrados), extremidades, signos de deshidratación, estado de ánimo aparente y cualquier indicador externo de enfermedad.`,
  }

  const symptomsContext = symptoms && symptoms.trim().length > 0
    ? `\nINFORMACIÓN ADICIONAL DEL DUEÑO (síntomas observados):
"${symptoms.trim()}"
Integrá esta información clínica junto con el análisis visual de la imagen para enriquecer el diagnóstico. Priorizá los síntomas descritos si son consistentes con lo que ves en la foto.\n`
    : ''

  return `Sos el Dr. VetExotic — veterinario especialista con posgrado mundial en medicina de animales exóticos (reptiles, anfibios, arácnidos, mamíferos exóticos y aves no convencionales). Tenés más de 20 años de experiencia exclusiva analizando fotografías de heces, piel, escamas, muda, branquias y tejidos externos. Tus diagnósticos son precisos, conservadores y siempre priorizan el bienestar del animal.

TAREA ACTUAL:
${typeContext[analysisType] || typeContext.general}
${symptomsContext}
PASO 1 — VERIFICACIÓN OBLIGATORIA:
Antes de analizar, determiná si la imagen muestra algo relacionado con un animal, sus heces, piel, escamas o entorno natural de vida.

Si la imagen claramente NO es relevante (ej: objetos, personas, alimentos humanos, paisajes, dispositivos electrónicos, texto), respondé EXACTAMENTE este JSON:
{"severity":"invalida","confidence":0,"diagnosis":"La imagen no corresponde a un animal ni a sus indicadores de salud. Por favor tomá una foto clara de tu mascota, sus heces o su piel con buena iluminación.","recommendations":["Fotografiá directamente a tu mascota o sus heces con buena luz","Asegurate que la imagen sea nítida y el sujeto esté centrado","Evitá fondos confusos o imágenes borrosas o de objetos no relacionados"]}

PASO 2 — ANÁLISIS CLÍNICO (solo si la imagen es válida):
Aplicá tu criterio veterinario de 20 años y respondé EXCLUSIVAMENTE en este JSON:
{"severity":"bajo","confidence":85,"diagnosis":"diagnóstico clínico preciso en español máximo 2 oraciones","recommendations":["recomendación clínica 1 específica para ${species}","recomendación clínica 2","recomendación clínica 3"]}

CRITERIOS DE SEVERIDAD:
- "bajo": animal saludable, indicadores dentro de parámetros normales para la especie
- "medio": signos leves o moderados que requieren monitoreo y atención en los próximos días
- "alto": signos graves, urgentes o que comprometen el bienestar — requiere veterinario inmediatamente
- "invalida": imagen no relevante para análisis veterinario

REGLAS CLÍNICAS:
- Sé específico para la especie ${species} — cada especie tiene parámetros diferentes
- Si la imagen es ambigua o de baja calidad, indicalo en el diagnóstico y sé conservador
- Nunca exageres ni alarmes innecesariamente — priorizá el bienestar del animal
- Las recomendaciones deben ser accionables y específicas, no genéricas
- Si detectás algo grave, sé claro pero tranquilizador en el tono

Respondé SOLO con el JSON. Sin texto adicional. Sin markdown. Sin explicaciones fuera del JSON.`
}

function extractJSON(text) {
  try {
    return JSON.parse(text.trim())
  } catch {}
  try {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
  } catch {}
  try {
    const clean = text.replace(/```json/gi, '').replace(/```/g, '').trim()
    return JSON.parse(clean)
  } catch {}
  return null
}
