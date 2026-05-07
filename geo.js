// api/geo.js — Proxy que remove X-Frame-Options do GEO.ANACOM
// Permite embeder geo.anacom.pt num iframe no nosso site
// Vercel Edge Function (CommonJS)

module.exports = async function handler(req, res) {
  // Só permite carregar geo.anacom.pt (segurança)
  const allowed = 'https://geo.anacom.pt';
  const path = req.query.path || '/publico/home';
  const targetUrl = `${allowed}${path.startsWith('/') ? path : '/' + path}`;

  // Passar query string original (lat, lon, zoom, etc.)
  const qs = new URLSearchParams(req.query);
  qs.delete('path');
  const fullUrl = qs.toString() ? `${targetUrl}?${qs}` : targetUrl;

  try {
    const upstream = await fetch(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SolucoesDiferentes/1.0)',
        'Accept': req.headers.accept || '*/*',
        'Accept-Language': 'pt-PT,pt;q=0.9',
        'Referer': 'https://geo.anacom.pt/',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });

    // Copiar headers mas REMOVER os que bloqueiam iframe
    const skipHeaders = new Set([
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'transfer-encoding',
      'connection',
    ]);

    for (const [key, value] of upstream.headers.entries()) {
      if (!skipHeaders.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    // Adicionar headers que permitem iframe
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Cache moderado
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

    res.status(upstream.status);

    // Stream do body
    const contentType = upstream.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // Reescrever URLs relativas para passar pelo proxy
      let html = await upstream.text();
      // Reescrever links relativos para absolutos ao ANACOM
      html = html.replace(/(href|src|action)="(?!http|\/\/|data:|#)([^"]*?)"/g,
        (m, attr, url) => `${attr}="https://geo.anacom.pt/${url.replace(/^\//, '')}"`);
      // Reescrever fetch/XHR internos — deixar ir directo ao ANACOM
      res.end(html);
    } else {
      const buf = await upstream.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: err.message });
  }
};
