/** Netlify Function: die gesamte API läuft über diese eine Funktion (Pfad /api/*). */
import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';

const handlerPromise = (async () => serverless(createApp(), { basePath: '' }))();

export const handler = async (event, context) => {
  // Bei Rewrites liefert Netlify den ursprünglichen Pfad; direkt aufgerufen den Funktionspfad.
  const prefix = '/.netlify/functions/api';
  if (event.path?.startsWith(prefix)) event.path = '/api' + event.path.slice(prefix.length);
  if (event.rawUrl) { try { const u = new URL(event.rawUrl); if (u.pathname.startsWith(prefix)) u.pathname = '/api' + u.pathname.slice(prefix.length); event.rawUrl = u.toString(); } catch {} }
  return (await handlerPromise)(event, context);
};
