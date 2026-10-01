/** Netlify Function: die gesamte API (/api/*) läuft über die gemeinsame Express-App. */
import serverless from 'serverless-http';
import { createApp } from '../../server/app.js';

let handlerPromise;
function getHandler() {
  if (!handlerPromise) handlerPromise = Promise.resolve(serverless(createApp()));
  return handlerPromise;
}

export default async (req, context) => {
  const url = new URL(req.url);
  const headers = Object.fromEntries(req.headers);
  const body = ['GET', 'HEAD'].includes(req.method) ? null : await req.text();
  const event = {
    httpMethod: req.method, path: url.pathname, rawUrl: req.url, headers, multiValueHeaders: {},
    queryStringParameters: Object.fromEntries(url.searchParams), body, isBase64Encoded: false,
  };
  const r = await (await getHandler())(event, {});
  const resBody = r.isBase64Encoded ? Buffer.from(r.body || '', 'base64') : (r.body ?? '');
  return new Response(resBody, { status: r.statusCode || 200, headers: r.headers || {} });
};

export const config = { path: '/api/*' };
