// Configurazione pubblica dell'app (la chiave "anon" è pensata per stare nel browser: i permessi li decide il database)
window.DP_CONFIG = {
  SUPABASE_URL: 'https://wwereqrojlwktgwlrsib.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind3ZXJlcXJvamx3a3Rnd2xyc2liIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI4MjMzMjYsImV4cCI6MjEwODM5OTMyNn0.vOaCaVc8kaqsRT_o_TP01CbyX9SN-Af1fKjSZ3NxQys',
  // Vista iniziale: Udine
  HOME: { lat: 46.063, lon: 13.236, zoom: 14 },
  // Raggio "vicino alla destinazione" in metri
  RAGGIO_DESTINAZIONE: 300,
  VERSION: '0.5.1'
};
