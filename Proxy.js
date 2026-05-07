// api/proxy.js
// Proxy transparente para geo.anacom.pt:
// 1. Remove X-Frame-Options (permite iframe)
// 2. Remove Content-Security-Policy frame-ancestors
// 3. Injeta <base href> para recursos relativos carregarem do ANACOM
// 4. Injeta script que redireciona fetch interno através do proxy

module.exports = async function handler(req, res) {
  // Permitir qualquer origem chamar este proxy
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // URL a proxiar — por defeito o portal ANACOM
  const rawUrl = req.query.url || 'https://geo.anacom.pt/publico/home';

  // Segurança: só permite geo.anacom.pt
  if (!rawUrl.startsWith('https://geo.anacom.pt') &&
      !rawUrl.startsWith('http://geo.anacom.pt')) {
    return res.status(403).send('Forbidden');
  }

  // Passar query string extra (lat, lon, zoom)
  const extra = new URLSearchParams(req.query);
  extra.delete('url');
  const targetUrl = extra.toString()
    ? `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}${extra}`
    : rawUrl;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.7',
        'Accept-Encoding': 'identity',
        'Referer': 'https://geo.anacom.pt/',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });

    const contentType = upstream.headers.get('content-type') || 'text/html';

    // Para recursos binários (JS, CSS, imagens) — passar directo sem modificar
    if (!contentType.includes('text/html')) {
      const headers_to_keep = ['content-type','cache-control','etag','last-modified'];
      headers_to_keep.forEach(h => {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      });
      // Remover bloqueios de frame também em sub-recursos
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Frame-Options', 'ALLOWALL');
      res.status(upstream.status);
      const buf = await upstream.arrayBuffer();
      return res.end(Buffer.from(buf));
    }

    // HTML: modificar para permitir iframe e fixar recursos
    let html = await upstream.text();

    // Injectar ANTES do </head>:
    // 1. <base> para todos os recursos relativos irem para geo.anacom.pt
    // 2. Script que intercepta fetch para URLs relativas do ArcGIS
    const injection = `
<base href="https://geo.anacom.pt/" target="_self">
<script>
(function(){
  // Remover meta CSP se existir
  document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')
    .forEach(m => m.remove());

  // Interceptar fetch para URLs relativas do ArcGIS REST
  const _fetch = window.fetch.bind(window);
  window.fetch = function(url, opts) {
    if (typeof url === 'string') {
      if (url.startsWith('/server/rest') || url.startsWith('/portal')) {
        url = 'https://geo.anacom.pt' + url;
      }
    }
    return _fetch(url, opts);
  };

  // Interceptar XMLHttpRequest também
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    if (typeof url === 'string') {
      if (url.startsWith('/server/rest') || url.startsWith('/portal')) {
        url = 'https://geo.anacom.pt' + url;
      }
    }
    return _open.call(this, method, url, ...args);
  };
})();
</script>`;

    // Injectar antes de </head>
    if (html.includes('</head>')) {
      html = html.replace('</head>', injection + '</head>');
    } else {
      html = injection + html;
    }

    // Remover headers de segurança que bloqueiam iframe
    const skipHeaders = new Set([
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'transfer-encoding',
      'connection',
      'content-encoding',
    ]);

    for (const [key, value] of upstream.headers.entries()) {
      if (!skipHeaders.has(key.toLowerCase())) {
        try { res.setHeader(key, value); } catch {}
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    res.setHeader('Cache-Control', 's-maxage=30');
    res.status(upstream.status);
    res.end(html);

  } catch (err) {
    console.error('Proxy error:', err.message);
    // Fallback: redirecionar para o original
    res.setHeader('Content-Type', 'text/html');
    res.status(200).end(`
      <html><body style="margin:0;font-family:sans-serif;background:#0a0e1a;color:white;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;gap:16px">
        <div style="font-size:48px">⚠️</div>
        <div style="font-size:16px;font-weight:700">Proxy temporariamente indisponível</div>
        <div style="font-size:13px;color:#6b7fa3">Erro: ${err.message}</div>
        <a href="https://geo.anacom.pt/publico/home" target="_top"
           style="padding:12px 24px;background:#0057b8;border-radius:8px;color:white;text-decoration:none;font-weight:700;margin-top:8px">
          Abrir GEO.ANACOM →
        </a>
      </body></html>
    `);
  }
};
