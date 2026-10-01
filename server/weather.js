// Wetterdaten via Open-Meteo (kostenlos, ohne API-Key). Server-seitiger Cache, damit
// mehrere Nutzer die API nicht unnötig belasten.
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

const PARAMS = new URLSearchParams({
  current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
  hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover',
  daily: 'weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant,wind_gusts_10m_max',
  timezone: 'auto',
  forecast_days: '7',
  wind_speed_unit: 'kmh',
});

export async function getWeather(lat, lng) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&${PARAMS}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw Object.assign(new Error('Wetterdienst nicht erreichbar (keine Internetverbindung?).'), { status: 502 });
  }
  if (!res.ok) throw Object.assign(new Error(`Wetterdienst antwortet mit Status ${res.status}.`), { status: 502 });
  const data = await res.json();
  data.moon = moonPhase(new Date());
  data.fetched_at = new Date().toISOString();
  cache.set(key, { at: Date.now(), data });
  return data;
}

// Einfache Mondphasen-Berechnung (synodischer Monat), reicht für die Jagdplanung.
export function moonPhase(date) {
  const synodic = 29.53058867;
  const ref = Date.UTC(2000, 0, 6, 18, 14); // bekannter Neumond
  const days = (date.getTime() - ref) / 86400000;
  const age = ((days % synodic) + synodic) % synodic;
  const fraction = age / synodic;
  const illumination = Math.round((1 - Math.cos(fraction * 2 * Math.PI)) / 2 * 100);
  const names = ['Neumond', 'Zunehmende Sichel', 'Erstes Viertel', 'Zunehmender Mond', 'Vollmond', 'Abnehmender Mond', 'Letztes Viertel', 'Abnehmende Sichel'];
  const idx = Math.round(fraction * 8) % 8;
  return { age: Math.round(age * 10) / 10, illumination, name: names[idx], index: idx };
}
