// Startet die App mit Demodaten (plattformunabhängig, ohne Umgebungsvariablen setzen zu müssen).
process.env.DEMO = '1';
await import('./index.js');
