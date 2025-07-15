const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const exhaustedTokens = {};
const rateLimitStatus = {}; // { token: { remaining, limit, reset, fetchedAt } }

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Gather tokens as before...
    const tokens = [
      await env.GITHUB_TOKEN_2.get(),
      await env.GITHUB_TOKEN_3.get(),
      await env.GITHUB_TOKEN_4.get(),
      await env.GITHUB_TOKEN_5.get(),
      await env.GITHUB_TOKEN_6.get(),
      await env.GITHUB_TOKEN_7.get()
    ].filter(Boolean);

    const url = new URL(request.url);

    // --- /stats endpoint ---
    if (url.pathname === '/stats') {
      let totalRemaining = 0;
      let totalLimit = 0;
      let details = [];
      for (const token of tokens) {
        const now = Date.now() / 1000;
        if (
          rateLimitStatus[token] &&
          rateLimitStatus[token].fetchedAt &&
          now - rateLimitStatus[token].fetchedAt < 10
        ) {
          totalRemaining += rateLimitStatus[token].remaining;
          totalLimit += rateLimitStatus[token].limit;
          details.push({
            token: token.slice(0, 8) + '...',
            ...rateLimitStatus[token]
          });
          continue;
        }
        const resp = await fetch('https://api.github.com/rate_limit', {
          headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'Cloudflare-Worker-Proxy'
          }
        });
        const data = await resp.json();
        const core = data.resources.core;
        rateLimitStatus[token] = {
          remaining: core.remaining,
          limit: core.limit,
          reset: core.reset,
          fetchedAt: now
        };
        totalRemaining += core.remaining;
        totalLimit += core.limit;
        details.push({
          token: token.slice(0, 8) + '...',
          remaining: core.remaining,
          limit: core.limit,
          reset: core.reset
        });
      }
      return new Response(
        JSON.stringify({
          totalRemaining,
          totalLimit,
          percent: ((totalRemaining / (tokens.length * 5000)) * 100).toFixed(2) + '%',
          details
        }, null, 2),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // --- Upload endpoint ---
    if (request.method === 'POST' && url.pathname === '/upload') {
      const githubPath = url.searchParams.get('path');
      if (!githubPath) {
        return new Response('Missing path', { status: 400, headers: corsHeaders });
      }
      const body = await request.arrayBuffer();
      // Use browser-compatible base64 encoding
      const content = btoa(String.fromCharCode(...new Uint8Array(body)));

      // Try each token until one works
      let lastError = null;
      for (const token of tokens) {
        if (exhaustedTokens[token] && exhaustedTokens[token] > Date.now() / 1000) continue;

        // --- Check if file exists to get its SHA ---
        let sha = undefined;
        const getResp = await fetch(
          `https://api.github.com/repos/kryptik-dev/gtarevived/contents/${githubPath}?ref=master`,
          {
            headers: {
              'Authorization': `token ${token}`,
              'User-Agent': 'Cloudflare-Worker-Proxy'
            }
          }
        );
        if (getResp.status === 200) {
          const fileData = await getResp.json();
          sha = fileData.sha;
        }

        // Compose GitHub API payload
        const payload = {
          message: `Upload ${githubPath}`,
          content,
          branch: 'master',
          ...(sha ? { sha } : {})
        };

        const resp = await fetch(
          `https://api.github.com/repos/kryptik-dev/gtarevived/contents/${githubPath}`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `token ${token}`,
              'User-Agent': 'Cloudflare-Worker-Proxy',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
          }
        );
        if (resp.status === 201 || resp.status === 200) {
          return new Response(await resp.text(), {
            status: resp.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
        lastError = await resp.text();
      }
      return new Response(
        `All tokens failed. Last error: ${lastError}`,
        { status: 429, headers: corsHeaders }
      );
    }

    // --- Main proxy logic ---
    const githubPath = url.searchParams.get('path');
    if (!githubPath) {
      return new Response('Missing path', { status: 400, headers: corsHeaders });
    }

    const githubUrl = `https://api.github.com/repos/kryptik-dev/gtarevived/contents/${githubPath}?ref=master`;
    const cache = caches.default;
    const cacheKey = new Request(request.url, request);

    // Set cache TTLs
    const isImage = /\.(jpg|jpeg|png|webp|gif)$/i.test(githubPath);
    const cacheTtl = isImage ? 60 * 60 * 24 * 365 : 300; // 1 year for images, 5 min for listings

    // Try to serve from cache first
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    // Try each token until one works (not rate limited)
    let lastError = null;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (exhaustedTokens[token] && exhaustedTokens[token] > Date.now() / 1000) {
        continue;
      }

      const resp = await fetch(githubUrl, {
        headers: {
          'Authorization': `token ${token}`,
          'User-Agent': 'Cloudflare-Worker-Proxy'
        }
      });

      const remaining = parseInt(resp.headers.get('X-RateLimit-Remaining') || '0', 10);
      const limit = parseInt(resp.headers.get('X-RateLimit-Limit') || '5000', 10);
      const reset = parseInt(resp.headers.get('X-RateLimit-Reset') || '0', 10);

      // Save status for /stats
      rateLimitStatus[token] = {
        remaining,
        limit,
        reset,
        fetchedAt: Date.now() / 1000
      };

      if (remaining === 0) {
        exhaustedTokens[token] = reset;
        lastError = `Token exhausted, resets at ${new Date(reset * 1000).toISOString()}`;
        continue;
      }

      const cacheHeaders = isImage
        ? { 'Cache-Control': `public, max-age=${cacheTtl}, immutable` }
        : { 'Cache-Control': `public, max-age=${cacheTtl}` };

      const response = new Response(await resp.text(), {
        status: resp.status,
        headers: {
          ...corsHeaders,
          ...cacheHeaders,
          'Content-Type': isImage ? resp.headers.get('Content-Type') || 'image/jpeg' : 'application/json'
        }
      });

      // Store in cache
      await cache.put(cacheKey, response.clone());

      return response;
    }

    return new Response(
      `All tokens are rate limited. Try again after reset. Last error: ${lastError}`,
      { status: 429, headers: corsHeaders }
    );
  }
} 