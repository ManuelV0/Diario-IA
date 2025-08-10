// netlify/functions/forza-analisi/index.ts

import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

/**
 * ==========================
 *   ENV & CONFIG
 * ==========================
 */
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const AUTHOR_COL = process.env.POEMS_AUTHOR_COLUMN || 'user_id' // colonna autore in poesie
const MIN_POEMS = Number(process.env.MIN_POEMS_TO_UPDATE || 3)
const BACKEND_BASE =
  (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || '' // usato per chiamare aggiorna-journal
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

/**
 * ==========================
 *   CLIENTS
 * ==========================
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY })

/**
 * ==========================
 *   UTILS
 * ==========================
 */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

const isUuid = (s?: string) =>
  typeof s === 'string' &&
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(s)

const errToString = (e: any) => (e && e.message) ? e.message : String(e)

const newReqId = () => Math.random().toString(36).slice(2, 9)

const log = (...a: any[]) => console.log('[forza-analisi]', ...a)
const logErr = (...a: any[]) => console.error('[forza-analisi]', ...a)

type AnyObj = Record<string, any>

const pick = (obj: AnyObj | null | undefined, keys: string[]) =>
  (obj ? Object.fromEntries(keys.filter(k => k in obj).map(k => [k, (obj as any)[k]])) : {})

const pickAuthorId = (body: AnyObj): string | null =>
  body?.[AUTHOR_COL] || body?.author_id || body?.user_id || body?.record?.[AUTHOR_COL] || body?.record?.user_id || null

const normalizePoemInput = (rec: AnyObj) => {
  const id = rec?.id
  const authorId = rec?.[AUTHOR_COL] ?? rec?.user_id ?? rec?.author_id ?? null
  const title = rec?.title ?? rec?.titolo ?? null
  const content = rec?.content ?? rec?.testo ?? rec?.text ?? rec?.poemText ?? null
  return { id, authorId, title, content }
}

/**
 * ==========================
 *   SUPABASE OPS
 * ==========================
 */
async function upsertPoemFromManual(rec: AnyObj) {
  // Usa solo i campi ammessi per evitare colonne inesistenti
  const allowed = ['id', AUTHOR_COL, 'title', 'titolo', 'content', 'testo', 'text']
  const payload = pick(rec, allowed)

  const { data, error } = await supabase
    .from('poesie')
    .upsert(payload, { onConflict: 'id' })
    .select('id')
    .single()

  if (error) throw new Error(`Supabase upsert poem error: ${JSON.stringify(error)}`)
  return data?.id as string
}

async function updatePoemAnalysis(poemId: string, analysis: AnyObj) {
  const { error } = await supabase
    .from('poesie')
    .update(analysis)
    .eq('id', poemId)

  if (error) throw new Error(`Supabase update poem error: ${JSON.stringify(error)}`)
}

async function countPoemsByAuthor(authorId: string) {
  const { count, error } = await supabase
    .from('poesie')
    .select('id', { count: 'exact', head: true })
    .eq(AUTHOR_COL, authorId)

  if (error) throw new Error(`Supabase count error: ${JSON.stringify(error)}`)
  return count || 0
}

/**
 * ==========================
 *   OPENAI
 * ==========================
 */
function buildAnalysisPrompt(title: string, content: string) {
  return [
    'Analizza la seguente poesia con tre prospettive: psicologica, letteraria e profilo poetico.',
    'Rispondi in JSON con la struttura:',
    `{
  "analisi_psicologica": {...},
  "analisi_letteraria": {...},
  "profilo_poetico": {...}
}`,
    `Titolo: ${title || 'Senza titolo'}`,
    'Testo:',
    content || ''
  ].join('\n\n')
}

async function analyzePoemWithOpenAI(title: string, content: string) {
  const prompt = buildAnalysisPrompt(title, content)

  const res = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'Sei un analista poetico e restituisci JSON valido.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.4
  })

  const text = res.choices[0]?.message?.content?.trim() || ''
  try {
    const json = JSON.parse(text)
    // assicurati che le tre chiavi esistano
    return {
      analisi_psicologica: json.analisi_psicologica ?? json.psicologica ?? json.psico ?? {},
      analisi_letteraria: json.analisi_letteraria ?? json.letteraria ?? {},
      profilo_poetico: json.profilo_poetico ?? json.profilo ?? {}
    }
  } catch {
    // fallback: incapsula il testo in tre blocchi uguali
    return {
      analisi_psicologica: { testo: text },
      analisi_letteraria: { testo: text },
      profilo_poetico: { testo: text }
    }
  }
}

/**
 * ==========================
 *   JOURNAL TRIGGER
 * ==========================
 */
async function maybeTriggerJournal(authorId: string, poemsCount: number, debug: boolean) {
  if (!isUuid(authorId)) {
    if (debug) log('Skip aggiorna-journal: invalid authorId', authorId)
    return { triggered: false, reason: 'invalid_author' }
  }
  if (poemsCount < MIN_POEMS) {
    if (debug) log(`Skip aggiorna-journal: poemsCount=${poemsCount} < min=${MIN_POEMS}`)
    return { triggered: false, reason: 'threshold' }
  }
  if (!BACKEND_BASE) {
    if (debug) log('Skip aggiorna-journal: BACKEND_BASE (PUBLIC_BASE_URL) non configurato')
    return { triggered: false, reason: 'no_backend_base' }
  }

  const url = `${BACKEND_BASE}/.netlify/functions/aggiorna-journal`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_id: authorId })
    })
    const out = await resp.json().catch(() => ({}))
    if (debug) log('aggiorna-journal →', resp.status, out)
    return { triggered: true, status: resp.status, out }
  } catch (e) {
    logErr('Error calling aggiorna-journal', errToString(e))
    return { triggered: false, reason: 'fetch_error', error: errToString(e) }
  }
}

/**
 * ==========================
 *   HANDLER
 * ==========================
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  const reqId = newReqId()

  try {
    const body: AnyObj = event.body ? JSON.parse(event.body) : {}
    const debug = !!(body?.debug || event.queryStringParameters?.debug)
    const dry_run = !!body?.dry_run

    // 1) Determina modalità: webhook Supabase vs manuale
    const isWebhook = !!body?.type && !!body?.record
    const rec: AnyObj = isWebhook ? body.record : body

    // 2) Normalizza input poesia
    const { id: poemId, authorId, title, content } = normalizePoemInput(rec)
    if (!poemId) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: 'Missing poem id', reqId })
      }
    }
    if (debug) log('reqId=', reqId, 'poemId=', poemId, 'authorId=', authorId, 'mode=', isWebhook ? 'webhook' : 'manual')

    // 3) In modalità manuale, garantisci l’upsert della poesia (opzionale)
    if (!isWebhook) {
      // Se arriva titolo/contenuto, upsert così restano nel DB
      if (title || content || authorId) {
        await upsertPoemFromManual({
          id: poemId,
          [AUTHOR_COL]: authorId,
          title,
          content
        })
      }
    }

    // 4) Analisi con OpenAI (se non dry_run)
    let analysis: AnyObj = {}
    if (dry_run) {
      analysis = {
        analisi_psicologica: { dry_run: true },
        analisi_letteraria: { dry_run: true },
        profilo_poetico: { dry_run: true }
      }
    } else {
      analysis = await analyzePoemWithOpenAI(title || '', content || '')
    }

    // 5) Aggiorna la poesia con i risultati
    await updatePoemAnalysis(poemId, analysis)

    // 6) Conta poesie autore e valuta trigger diario
    let poemsCount = 0
    if (authorId && isUuid(authorId)) {
      poemsCount = await countPoemsByAuthor(authorId)
    }
    const journal = await maybeTriggerJournal(authorId || '', poemsCount, debug)

    const res = {
      ok: true,
      reqId,
      poemId,
      authorId,
      poemsCount,
      minPoems: MIN_POEMS,
      triggered_journal: journal
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify(res) }
  } catch (err: any) {
    logErr('FATAL', err)
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: errToString(err), where: 'forza-analisi' })
    }
  }
}

export default handler
