// Serves the download page for /d/<transferId>
export async function onRequest({ request, env }) {
  const res = await env.ASSETS.fetch(new URL('/download', request.url));
  return new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
