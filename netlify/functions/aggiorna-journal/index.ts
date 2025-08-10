// netlify/functions/aggiorna-journal/index.ts
import type { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

/**
 * ==========================
 *   ENV & CONFIG
 * ==========================
 */
const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const AUTHOR_COL = process.env.POEMS_AUTHOR_COLUMN || 'user_id'
const MIN_POEMS = Number(process.env.MIN_POEMS_TO_UPDATE || 3)

// Se presente, usare direttamente questo endpoint completo (es: https://.../.netlify/functions/forza-analisi)
// Altrimenti verrà composto dall’host della richiesta.
const FORZA_ANALISI_URL = process.env.FORZA_ANALISI_URL // opzionale
const FORZA_ANALISI_PATH = '/.netlify/functions/forza-analisi'

/**
 * ==========================
 *   CLIENT
 * ==========================
 */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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
const pickAuthorId = (body: any): string | null =>
  body?.author_id || body?.user_id || body?.record?.user_id || body?.profile_id || null

async function countPoems(authorId: string) {
  const { count, error } = await supabase
    .from('poesie')
    .select('id', { count: 'exact', head: true })
    .eq(AUTHOR_COL, authorId)
  if (error) throw new Error(`Supabase count error: ${JSON.stringify(error)}`)
  return count || 0
}

/**
 * ==========================
 *   HANDLER (proxy → forza-analisi)
 * ==========================
 */
export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  try {
    const body = event.body ? JSON.parse(event.body) : {}
    const debug  = !!(body?.debug || event.queryStringParameters?.debug)
    const dryRun = !!body?.dry_run

    // 1) author_id
    const authorId = pickAuthorId(body)
    if (!isUuid(authorId || '')) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: `Invalid author_id (expected UUID): ${authorId}` })
      }
    }

    // 2) soglia MIN_POEMS
    const poemsCount = await countPoems(authorId!)
    if (poemsCount < MIN_POEMS) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          ok: true,
          triggered: false,
          reason: `not_enough_poems (${poemsCount}/${MIN_POEMS})`,
          authorId,
          authorCol: AUTHOR_COL,
          minPoems: MIN_POEMS
        })
      }
    }

    // 3) costruzione endpoint forza-analisi
    const host = event.headers?.['x-forwarded-host'] || event.headers?.host
    const scheme = (event.headers?.['x-forwarded-proto'] as string) || 'https'
    const endpoint =
      FORZA_ANALISI_URL ||
      (host ? `${scheme}://${host}${FORZA_ANALISI_PATH}` : FORZA_ANALISI_PATH)

    // 4) inoltro richiesta → forza-analisi
    const faResp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_id: authorId, debug, dry_run: dryRun })
    })

    const text = await faResp.text() // manteniamo la risposta così com’è
    return { statusCode: faResp.status, headers: CORS, body: text }

  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: errToString(err), where: 'aggiorna-journal→proxy' })
    }
  }
}

export default handler
