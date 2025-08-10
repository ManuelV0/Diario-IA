import { Handler } from '@netlify/functions'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Metodo non consentito' }),
    }
  }

  try {
    const { poem_id, rating, user_id } = JSON.parse(event.body || '{}')
    const ip_address = event.headers['x-forwarded-for'] || 'unknown'

    if (!poem_id || !rating || rating < 1 || rating > 5) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Dati voto non validi' }),
      }
    }

    // Inserisce il voto
    const { error } = await supabase.from('votes').insert({
      poem_id,
      rating,
      user_id: user_id || null,
      ip_address: user_id ? null : ip_address,
    })

    if (error) {
      console.error('Errore voto:', error)
      return {
        statusCode: 500,
        body: JSON.stringify({ error: error.message }),
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Voto registrato' }),
    }
  } catch (err: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    }
  }
}

export { handler }
