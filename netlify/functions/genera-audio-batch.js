// genera-audio-batch.js

const fetch = require("node-fetch");

// Lista di poesie senza audio, esempio
// Normalmente le prendi dal DB! Qui è solo dimostrativo:
const poesieSenzaAudio = [
  { id: 1, testo: "Nel mezzo del cammin di nostra vita..." },
  { id: 2, testo: "Amore che move il sole e l’altre stelle..." },
  // ...altre poesie
];

const API_URL = "https://poetry.theitalianpoetryproject.com/.netlify/functions/genera-audio";

async function generaAudioInSequenza(poesie) {
  for (let i = 0; i < poesie.length; i++) {
    const poesia = poesie[i];
    console.log(`>>> Genero audio per poesia #${poesia.id}...`);

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: poesia.testo, poesia_id: poesia.id })
      });
      const data = await res.json();
      if (res.ok) {
        console.log(`✅ Audio generato: ${data.audio_url}`);
      } else {
        console.error(`❌ Errore per poesia #${poesia.id}:`, data.error, data.details);
      }
    } catch (err) {
      console.error(`❌ Errore di rete per poesia #${poesia.id}:`, err);
    }

    if (i < poesie.length - 1) {
      console.log(`⏳ Attendo 2 minuti prima della prossima poesia...`);
      await new Promise(resolve => setTimeout(resolve, 120000)); // 120000 ms = 2 minuti
    }
  }
  console.log("🎉 Tutte le poesie processate!");
}

// Esegui lo script
generaAudioInSequenza(poesieSenzaAudio);
