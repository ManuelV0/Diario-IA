// netlify/functions/genera-analisi-batch.ts
import { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// --- ENV helpers
const mustGet = (k: string) => {
  const v = process.env[k]
  if (!v) throw new Error(`Missing env: ${k}`)
  return v
}

// --- Clients
const supabase = createClient(
  mustGet('SUPABASE_URL'),
  mustGet('SUPABASE_SERVICE_ROLE_KEY') // service role (solo lato server!)
)
const openai = new OpenAI({ apiKey: mustGet('OPENAI_API_KEY') })

// --- Opzionale: proteggi l'endpoint con un header segreto
const JOB_SECRET = process.env.JOB_SECRET || ''

// --- Utils
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const buildPrompt = (content: string) => `
Agisci come un "Futurista Strategico" e un analista di sistemi complessi.
Il tuo compito non è predire il futuro, ma mappare le sue possibilità per fornire un vantaggio decisionale.

Argomento: ${content}

Proiettalo 20 anni nel futuro e crea un dossier strategico completo in formato JSON con la seguente struttura obbligatoria:

{
  "vettori_di_cambiamento_attuali": [
    "Descrizione del vettore 1",
    "Descrizione del vettore 2",
    "Descrizione del vettore 3"
  ],
  "scenario_ottimistico": "Descrizione dettagliata dell'utopia plausibile",
  "scenario_pessimistico": "Descrizione dettagliata della distopia plausibile",
  "fattori_inattesi": {
    "positivo_jolly": "Evento positivo imprevisto",
    "negativo_cigno_nero": "Evento negativo imprevisto"
  },
  "dossier_strategico_oggi": {
    "azioni_preparatorie_immediate": [
      "Azione 1",
      "Azione 2",
      "Azione 3"
    ],
    "opportunita_emergenti": [
      "Opportunità 1",
      "Opportunità 2"
    ],
    "rischio_esistenziale_da_mitigare": "Descrizione del rischio"
  }
}

Requisiti:
- Pensa in modo sistemico.
- Tono lucido, strategico e privo di sensazionalismo.
- Usa esempi concreti.
`

const generateMockAnalysis = (content: string) => ({
  vettori_di_cambiamento_attuali: [
    'Avanzamenti tecnologici generici',
    'Cambiamenti sociali globali',
    'Tendenze economiche emergenti',
  ],
  scenario_ottimistico:
    'Scenario positivo con cooperazione globale e uso etico delle tecnologie.',
  scenario_pessimistico:
    'Scenario negativo con crisi geopolitiche e tecnologie usate male.',
  fattori_inattesi: {
    positivo_jolly: 'Scoperta scientifica rivoluzionaria.',
    negativo_cigno_nero: 'Evento catastrofico imprevisto.',
  },
  dossier_strategico_oggi: {
    azioni_preparatorie_immediate: [
      'Investire in formazione continua',
      'Diversificare le fonti di reddito',
      'Creare reti di collaborazione',
    ],
    opportunita_emergenti: [
      'Sviluppo di tecnologie sostenibili',
      'Mercati di nicchia legati all’adattamento climatico',
    ],
    rischio_esistenziale_da_mitigare: 'Collasso ecologico globale',
  },
})

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Metodo non consentito' }),
    }
  }

  // opzionale: richiedi header segreto per evitare trigger pubblici
  if (JOB_SECRET) {
    const got = event.headers['x-job-secret'] || event.headers['X-Job-Secret']
    if (got !== JOB_SECRET) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      }
    }
  }

  try {
    // Prendi fino a 5 poesie con analisi mancante o vuota o "null"
    // NB: .or(...) accetta una stringa con filtri separati da virgola
    const { data: poesie, error } = await supabase
      .from('poesie')
      .select('id, title, content, analisi_psicologica')
      .or('analisi_psicologica.is.null,analisi_psicologica.eq.{}')
      .not('content', 'is', null)
      .limit(5)

    if (error) throw error

    if (!poesie?.length) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Nessuna poesia da analizzare' }),
      }
    }

    let count = 0

    for (const poesia of poesie) {
      const content = (poesia.content || '').trim()
      if (!content) continue

      try {
        const prompt = buildPrompt(content)

        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          response_format: { type: 'json_object' },
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
        })

        let analisi: any
        try {
          analisi = JSON.parse(completion.choices[0].message.content || '{}')
        } catch {
          analisi = generateMockAnalysis(content)
        }

        const { error: updErr } = await supabase
          .from('poesie')
          .update({
            // teniamo analisi_letteraria a null: il nuovo front-end non la usa
            analisi_letteraria: null,
            analisi_psicologica: analisi,
          })
          .eq('id', poesia.id)

        if (updErr) {
          console.error(`Errore update poesia ${poesia.id}`, updErr)
        } else {
          count++
          console.log(`✔ Analizzata poesia ${poesia.id}`)
        }

        // piccolo delay per non martellare OpenAI
        await sleep(1000)
      } catch (err) {
        console.error('Errore su poesia:', poesia.id, err)
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Analizzate e aggiornate ${count} poesie.` }),
    }
  } catch (err: any) {
    console.error('Errore generale:', err)
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    }
  }
}
