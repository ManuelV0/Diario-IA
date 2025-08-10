import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'
import QRCode from 'qrcode'

// ============ ENV ============
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!
const AUTHOR_COL = process.env.POEMS_AUTHOR_COLUMN || 'user_id'          // es. 'user_id'
const MIN_POEMS = Number(process.env.MIN_POEMS_TO_UPDATE || 3)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')

// ============ CLIENTS ============
const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!)
const openai = new OpenAI({ apiKey: OPENAI_API_KEY! })

// ============ CORS ============
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
}

// ============ UTILS ============
function errToString(e: any) {
  try {
    if (e?.message) return e.message
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

function safeJson<T = any>(v: any): T | null {
  if (!v) return null
  if (typeof v === 'object') return v as T
  try { return JSON.parse(String(v)) } catch { return null }
}

function buildPublicPageUrl(authorId: string) {
  if (!PUBLIC_BASE_URL) return ''
  return `${PUBLIC_BASE_URL}/autore/${authorId}`
}

async function maybeGenerateQrDataUrl(url: string): Promise<string | null> {
  if (!url) return null
  try { return await QRCode.toDataURL(url) } catch { return null }
}

function normalizePoemRecord(p: any) {
  const title = p.titolo ?? p.title ?? null
  const text  = p.testo  ?? p.text  ?? p.content ?? null
  return { title: title ?? null, text: text ?? null }
}

// Prompt per diario cumulativo
function promptDiario(prev: any | null, corpus: string) {
  const prevBlock = prev ? `Stato precedente del diario (JSON):
${JSON.stringify(prev).slice(0, 8000)}
` : ''
  return `${prevBlock}Aggiorna o crea il DIARIO DELL’AUTORE sulla base dell’insieme di poesie fornite.
Rispondi SOLO con JSON valido e questo schema esatto:
{
  "descrizione_autore": string,
  "profilo_poetico": {
    "voce": string,
    "stile": string,
    "tono": string,
    "temi_ricorrenti": string[],
    "immagini_metafore_tipiche": string[],
    "influenze_letterarie": string[]
  },
  "ultimo_aggiornamento_iso": string
}

Le frasi devono essere concise, chiare e utili per un lettore pubblico. Imposta "ultimo_aggiornamento_iso" con una ISO timestamp (UTC).

CORPUS POESIE:
"""${corpus.slice(0, 20000)}"""` // limito per sicurezza
}

export const handler: Handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  // ---- tracing/id per incrociare i log in Netlify
  const reqId =
    event.headers?.['x-nf-request-id'] ||
    event.headers?.['x-request-id'] ||
    (context as any)?.awsRequestId ||
    Math.random().toString(36).slice(2)

  const log = (msg: string, extra?: any) => {
    if (extra) {
      try {
        // Evito log gigante
        const copy = JSON.parse(JSON.stringify(extra, (_, v) => (typeof v === 'string' && v.length > 800 ? v.slice(0, 800) + '…[trim]' : v)))
        console.log(`[aggiorna-journal][${reqId}] ${msg}`, copy)
      } catch {
        console.log(`[aggiorna-journal][${reqId}] ${msg}`, extra)
      }
    } else {
      console.log(`[aggiorna-journal][${reqId}] ${msg}`)
    }
  }
  const logErr = (msg: string, err?: any) => {
    console.error(`[aggiorna-journal][${reqId}] ${msg}`, err)
  }

  try {
    log('invoked', {
      method: event.httpMethod,
      hasBody: !!event.body,
      headersSample: {
        'content-type': event.headers?.['content-type'],
        'x-nf-request-id': event.headers?.['x-nf-request-id'],
      }
    })

    const body = safeJson<any>(event.body) || {}
    const debug = !!body.debug || event.queryStringParameters?.debug === '1'
    const dryRun = !!body.dry_run

    // Check ENV di base
    const envOk = {
      SUPABASE_URL: !!SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!SUPABASE_SERVICE_ROLE_KEY,
      OPENAI_API_KEY: !!OPENAI_API_KEY,
      PUBLIC_BASE_URL: !!PUBLIC_BASE_URL,
      AUTHOR_COL: AUTHOR_COL,
      MIN_POEMS
    }
    log('env checks', envOk)

    // Supporta payload webhook (body.record) e manuale (root)
    const isWebhook = !!(body?.type && body?.record)
    const rec = isWebhook ? body.record : body

    const authorId: string | undefined = rec[AUTHOR_COL] || rec.author_id || rec.user_id
    if (!authorId) {
      logErr('author_id mancante', { recKeys: Object.keys(rec || {}) })
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'author_id mancante', reqId }) }
    }

    // 1) Conta poesie dell’autore
    log('counting poems for author', { authorId })
    const { count: poemsCount, error: countErr } = await supabase
      .from('poesie')
      .select('id', { count: 'exact', head: true })
      .eq(AUTHOR_COL as any, authorId)

    if (countErr) {
      logErr('supabase count error', countErr)
      throw new Error(`Supabase count error: ${errToString(countErr)}`)
    }
    log('poems count result', { poemsCount })

    if ((poemsCount ?? 0) < MIN_POEMS) {
      log('threshold not reached, skipping update', { poemsCount, MIN_POEMS })
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          triggered: false,
          reason: `Soglia non raggiunta (${poemsCount ?? 0}/${MIN_POEMS})`,
          authorId,
          reqId,
          debug
        })
      }
    }

    // 2) Leggi poesie con testo/titolo
    log('fetching poems list', { authorId })
    const { data: poems, error: poemsErr } = await supabase
      .from('poesie')
      .select(`id, titolo, title, testo, text, content`)
      .eq(AUTHOR_COL as any, authorId)
      .order('id', { ascending: true })

    if (poemsErr) {
      logErr('supabase poems select error', poemsErr)
      throw new Error(`Supabase poems select error: ${errToString(poemsErr)}`)
    }
    if (!poems || poems.length === 0) {
      log('no poems found for author', { authorId })
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Nessuna poesia trovata per autore', authorId, reqId }) }
    }

    // 3) Profili/QR preesistenti
    log('loading existing profile', { authorId })
    let hasQrColumn = true
    let previous: any = null
    let existingQr: string | null = null
    try {
      const { data: prof, error: profErr } = await supabase
        .from('profiles')
        .select('diario_autore, qr_code_url')
        .eq('id', authorId)
        .single()
      if (profErr) {
        // se la colonna non esiste o errori vari, non bloccare
        const msg = errToString(profErr)
        if (msg.includes('qr_code_url') || msg.includes('column')) hasQrColumn = false
        log('profiles select returned error (non-bloccante)', { msg })
      } else {
        previous = safeJson(prof?.diario_autore) ?? prof?.diario_autore ?? null
        existingQr = prof?.qr_code_url ?? null
      }
    } catch (e) {
      hasQrColumn = false
      log('profiles select threw (soft-fail, disable QR)', { err: errToString(e) })
    }

    // 4) Prepara corpus per GPT
    const corpus = poems.map((p: any, i: number) => {
      const { title, text } = normalizePoemRecord(p)
      const safeTitle = title || `(senza titolo #${i + 1})`
      const safeText = text || ''
      return `Titolo: ${safeTitle}\n${safeText}`
    }).join(`\n\n---\n\n`)

    if (debug) {
      log('corpus preview', { first600: corpus.slice(0, 600) })
    }

    // Se dry_run, fermati qui restituendo diagnostica
    if (dryRun) {
      log('dry_run enabled → stop before OpenAI & DB update', { hasQrColumn, existingQr: !!existingQr })
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          dryRun: true,
          authorId,
          poemsCount,
          hasQrColumn,
          hadExistingQr: !!existingQr,
          envOk,
          reqId
        })
      }
    }

    // 5) OpenAI: genera diario cumulativo (con fallback)
    let diarioAggiornato: any = null
    try {
      log('calling OpenAI')
      const gpt = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        messages: [{ role: 'user', content: promptDiario(previous, corpus) }],
        response_format: { type: 'json_object' }
      })
      const content = gpt.choices?.[0]?.message?.content
      diarioAggiornato = safeJson<any>(content)
      log('OpenAI done', { ok: !!diarioAggiornato })
    } catch (e) {
      logErr('OpenAI error', e)
      diarioAggiornato = null
    }

    if (!diarioAggiornato) {
      diarioAggiornato = {
        descrizione_autore: 'Profilo in aggiornamento.',
        profilo_poetico: {
          voce: '',
          stile: '',
          tono: '',
          temi_ricorrenti: [],
          immagini_metafore_tipiche: [],
          influenze_letterarie: []
        },
        ultimo_aggiornamento_iso: new Date().toISOString()
      }
      log('OpenAI fallback applied')
    }

    // 6) Public URL + QR (soft-fail)
    const publicUrl = buildPublicPageUrl(authorId)
    let qrToSave: string | undefined
    if (hasQrColumn && publicUrl && !existingQr) {
      const qr = await maybeGenerateQrDataUrl(publicUrl)
      if (qr) {
        qrToSave = qr
        log('QR generated')
      } else {
        log('QR generation failed (soft)')
      }
    }

    // 7) Update profiles
    const updatePayload: any = {
      diario_autore: diarioAggiornato,
      diario_updated_at: new Date().toISOString()
    }
    if (qrToSave) updatePayload.qr_code_url = qrToSave

    log('updating profile', { hasQrColumn, includeQr: !!qrToSave })
    const { error: updErr } = await supabase
      .from('profiles')
      .update(updatePayload)
      .eq('id', authorId)

    if (updErr) {
      logErr('profiles update error', updErr)
      throw new Error(`Profiles update error: ${errToString(updErr)}`)
    }

    log('DONE OK', { authorId, poemsCount })
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        ok: true,
        triggered: true,
        authorId,
        poemsCount,
        diario: diarioAggiornato,
        qrGenerated: !!qrToSave,
        publicUrl: publicUrl || null,
        reqId
      })
    }
  } catch (err: any) {
    const msg = errToString(err)
    logErr('FATAL', err)
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: msg, reqId, where: 'aggiorna-journal' })
    }
  }
}

