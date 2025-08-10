import 'dotenv/config';
import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
  console.warn('⚠️ OPENAI_API_KEY non trovata nelle variabili d\'ambiente.');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Funzione helper per logging delle versioni e verifica iniziale
export const checkOpenAIStatus = async () => {
  try {
    console.log('✅ gptClient inizializzato. Modello di default: gpt-4o-mini');
  } catch (err) {
    console.error('❌ Errore inizializzazione OpenAI:', err);
  }
};
