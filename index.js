const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
    res.removeHeader("X-Frame-Options");
    res.setHeader(
      "Content-Security-Policy",
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src *; child-src *; connect-src *; script-src * 'unsafe-inline' 'unsafe-eval';"
    );
    next();
});

const BASE_URL = 'https://www.pobreflixtv.autos';

const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.pobreflixtv.autos/'
    },
    timeout: 15000
});

const TOKEN = 'f3981b7851ab13ac1e33';

// Domínios de anúncio conhecidos para bloquear
const AD_DOMAINS = [
    'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com',
    'googletagservices.com', 'google-analytics.com', 'adservice.google.com',
    'pagead2.googlesyndication.com', 'adnxs.com', 'adsrvr.org',
    'advertising.com', 'outbrain.com', 'taboola.com', 'revcontent.com',
    'mgid.com', 'propellerads.com', 'popads.net', 'popcash.net',
    'trafficjunky.com', 'exoclick.com', 'juicyads.com', 'adsterra.com',
    'hilltopads.net', 'plugrush.com', 'ero-advertising.com',
    'contentabc.com', 'traffic-media.co', 'clickadu.com', 'adcash.com',
    'bidvertiser.com', 'yllix.com', 'a-ads.com', 'coinzilla.io',
    'parodostaunter.qpon', 'am.parodostaunter.qpon',
    'etv-embed.icu',
];

// Script injetado no HTML do embed para bloquear ads client-side
const AD_BLOCKER_SCRIPT = `
<script>
(function() {
    // Bloqueia window.open (popups/popunders)
    window.open = function() { return null; };

    // Bloqueia criação de elementos de anúncio
    const AD_DOMAINS = ${JSON.stringify(AD_DOMAINS)};
    const _createElement = document.createElement.bind(document);
    document.createElement = function(tag) {
        const el = _createElement(tag);
        if (tag.toLowerCase() === 'script' || tag.toLowerCase() === 'iframe') {
            const _setSrc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setAttribute');
            const origSet = el.setAttribute.bind(el);
            el.setAttribute = function(name, value) {
                if ((name === 'src' || name === 'href') && value) {
                    if (AD_DOMAINS.some(d => value.includes(d))) {
                        return;
                    }
                }
                return origSet(name, value);
            };
        }
        return el;
    };

    // Observa o DOM e remove elementos de ad assim que aparecem
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            mutation.addedNodes.forEach(function(node) {
                if (!node.src && !node.href && !node.tagName) return;
                const src = node.src || node.href || '';
                if (AD_DOMAINS.some(d => src.includes(d))) {
                    node.remove();
                }
                // Remove iframes de popunder
                if (node.tagName === 'IFRAME' && node.style && 
                    (node.style.zIndex > 9000 || node.width == 0 || node.height == 0)) {
                    node.remove();
                }
            });
        });
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    // Bloqueia navegação forçada por redirect
    const _pushState = history.pushState.bind(history);
    window.addEventListener('beforeunload', function(e) {
        e.stopImmediatePropagation();
    });
})();
</script>
`;

// Faz fetch server-side do embed, injeta ad blocker e serve HTML limpo
const fetchAndCleanEmbed = async (embedUrl) => {
    const response = await axios.get(embedUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': BASE_URL + '/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: 15000,
        responseType: 'text'
    });

    let html = response.data;

    // Remove scripts de domínios de ad
    AD_DOMAINS.forEach(domain => {
        const regex = new RegExp(`<script[^>]*src=["'][^"']*${domain.replace('.', '\\.')}[^"']*["'][^>]*>.*?</script>`, 'gis');
        html = html.replace(regex, '<!-- ad blocked -->');
        const iframeRegex = new RegExp(`<iframe[^>]*src=["'][^"']*${domain.replace('.', '\\.')}[^"']*["'][^>]*>.*?</iframe>`, 'gis');
        html = html.replace(iframeRegex, '<!-- ad blocked -->');
    });

    // Injeta o script bloqueador logo após o <head>
    html = html.replace(/<head>/i, '<head>' + AD_BLOCKER_SCRIPT);
    // Fallback se não tiver <head>
    if (!html.includes(AD_BLOCKER_SCRIPT)) {
        html = AD_BLOCKER_SCRIPT + html;
    }

    return html;
};

// Extrai o ID da URL do tipo: /assistir-nome-123/ → "123"
const extractId = (url) => {
    if (!url) return null;
    const matches = url.match(/-(\d+)\/?$/);
    return matches ? matches[1] : null;
};

const cleanText = (text) => text ? text.replace(/\n/g, '').trim() : '';

// Extrai o ID real do player a partir do C_Video('XXXXX','server') na página
const extractVideoId = (html) => {
    const match = html.match(/C_Video\(['"](\d+)['"]/);
    return match ? match[1] : null;
};

const parseCard = ($, element) => {
    try {
        const anchor = $(element).find('a');
        let url = anchor.attr('href') || '';
        if (url && !url.startsWith('http')) url = BASE_URL + url;

        const thumbContainer = $(element).find('.vb_image_container');
        let thumb = thumbContainer.attr('data-background-src');
        if (!thumb) {
            const style = thumbContainer.attr('style');
            if (style && style.includes('url(')) {
                const match = style.match(/url\(['"]?(.*?)['"]?\)/);
                if (match) thumb = match[1];
            }
        }
        if (thumb && !thumb.startsWith('http')) thumb = BASE_URL + thumb;

        const title = cleanText($(element).find('.caption').clone().children().remove().end().text());
        const year = cleanText($(element).find('.caption .y').text());
        const quality = cleanText($(element).find('.capa-quali').text());

        return { id: extractId(url), title, url, thumb, year, quality };
    } catch (e) { return null; }
};

// --- ROTAS ---

app.get('/', (req, res) => {
    res.json({
        status: "Online",
        msg: "API JVFlix",
        endpoints: {
            home: "/v1/get/recommeds",
            search: "/v1/search?s=nome",
            info: "/v1/info?url=link_completo",
            watch: "/v1/watch/:id"
        }
    });
});

app.get('/v1/get/recommeds', async (req, res) => {
    try {
        const response = await api.get('/');
        const $ = cheerio.load(response.data);

        const data = {
            movies: { releases: [], trending: [] },
            series: { releases: [], trending: [] }
        };

        const moviesContainer = $('.cWidgetContainer').eq(0);
        moviesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.movies.releases.push(parseCard($, el)));
        moviesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.movies.trending.push(parseCard($, el)));

        const seriesContainer = $('.cWidgetContainer').eq(1);
        seriesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.series.releases.push(parseCard($, el)));
        seriesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.series.trending.push(parseCard($, el)));

        const clean = (arr) => arr.filter(i => i && i.id);
        data.movies.releases = clean(data.movies.releases);
        data.movies.trending = clean(data.movies.trending);
        data.series.releases = clean(data.series.releases);
        data.series.trending = clean(data.series.trending);

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erro ao carregar home" });
    }
});

app.get('/v1/search', async (req, res) => {
    const query = req.query.s;
    if (!query) return res.status(400).json({ error: "Parâmetro 's' obrigatório" });

    try {
        const response = await api.get(`/pesquisar/?p=${encodeURIComponent(query)}`);
        const $ = cheerio.load(response.data);
        const results = [];

        $('#collview').each((i, el) => {
            const item = parseCard($, el);
            if (item && item.id) results.push(item);
        });

        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: "Erro na busca" });
    }
});

app.get('/v1/info', async (req, res) => {
    let { url, season } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    try {
        const fetchUrl = season ? `${url}?temporada=${season}` : url;
        const response = await api.get(fetchUrl);
        const $ = cheerio.load(response.data);

        const listagem = $('#listagem');
        const breadcrumb = $('.breadcrumb').text();
        const isSeries = listagem.length > 0 || breadcrumb.includes('Séries') || breadcrumb.includes('Series');

        const title = $('.titulo').text().trim();
        const thumb = $('.vb_image_container').attr('data-background-src');
        const desc = $('.sinopse').text().replace('Ler mais...', '').trim();
        const year = $('.infos span').eq(1).text().trim();
        const imdb = $('.imdb').text().trim();

        // ID real do player (C_Video) — diferente do ID da URL
        const videoId = extractVideoId(response.data);
        const pageId = extractId(url);

        const result = {
            id: pageId,
            video_id: videoId, // ID real usado no embed
            title,
            is_series: isSeries,
            year,
            imdb,
            thumb,
            description: desc,
            episodes: [],
            watch_link: null
        };

        if (isSeries) {
            const episodes = [];
            $('#listagem li').each((index, element) => {
                const linkTag = $(element).find('a').first();
                const epUrl = linkTag.attr('href');
                const epName = linkTag.text().trim();
                const sortId = parseInt($(element).attr('data-id')) || index;

                if (epUrl) {
                    episodes.push({
                        name: epName,
                        player_id: extractId(epUrl), // ID da URL do episódio (precisa de /v1/info para obter video_id)
                        url: epUrl,
                        order: sortId
                    });
                }
            });
            result.episodes = episodes.sort((a, b) => a.order - b.order);
        } else {
            // Usa video_id se disponível, senão cai no page id
            const watchId = videoId || pageId;
            result.watch_link = `${req.protocol}://${req.get('host')}/v1/watch/${watchId}`;
        }

        res.json(result);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao pegar detalhes" });
    }
});

// -------------------------------------------------------
// MIXDROP RESOLVER — abordagem cookie + unpack JS (igual ao script Python)
// Não depende da API do mixdrop. Faz sessão real, extrai cookie e unpacca
// o script obfuscado (p,a,c,k,e,d) para achar o MDCore.wurl.
// -------------------------------------------------------

const mixdropHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
};

// Extrai o file ID de uma URL mixdrop  ex: mixdrop.ag/e/abc123 → abc123
const getMixdropFID = (url) => {
    if (!url) return null;
    const m = url.match(/(?:mixdrop\.[a-z]+|mdy48tn97\.com|mdbekjwqa\.pw|mdfx9dc8n\.net|mdzsmutpcvykb\.net)\/(?:f|e)\/([a-z0-9]+)/i);
    return m ? m[1] : null;
};

// Unpacker do JS obfuscado no padrão eval(function(p,a,c,k,e,d){...})
// Replica exatamente o que o script Python faz
const unpackPacker = (source) => {
    const args = source.match(/}\s*\(\s*'([\s\S]*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'([\s\S]*)'\s*\.split\s*\(\s*'\|'\s*\)/);
    if (!args) return source;

    let [, payload, radix, , symtabRaw] = args;
    radix = parseInt(radix);
    const symtab = symtabRaw.split('|');

    const lookup = (word) => {
        try {
            const index = parseInt(word, radix);
            if (!isNaN(index) && index < symtab.length && symtab[index]) {
                return symtab[index];
            }
        } catch (e) { /* ignora */ }
        return word;
    };

    return payload.replace(/\b\w+\b/g, lookup);
};

// Extrai cookies do header set-cookie e monta string "k=v; k2=v2"
const parseCookies = (setCookieHeaders) => {
    if (!setCookieHeaders) return '';
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    return headers
        .map(h => h.split(';')[0].trim())
        .filter(Boolean)
        .join('; ');
};

// Resolve o MP4 direto a partir de um file ID mixdrop
// Estratégia: sessão real com cookie, unpack do JS obfuscado
const resolveMixdrop = async (fid) => {
    const embedUrl = `https://mixdrop.top/e/${fid}`;

    // 1. Primeira requisição — pega os cookies de sessão (como o Python faz com requests.Session)
    const firstResp = await axios.get(embedUrl, {
        headers: { ...mixdropHeaders, 'Referer': 'https://mixdrop.top/' },
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
    });

    // Coleta cookies da primeira resposta
    const rawCookies = parseCookies(firstResp.headers['set-cookie']);
    console.log('[mixdrop] cookies recebidos:', rawCookies || '(nenhum)');

    // 2. Segunda requisição com o cookie setado (replica o comportamento do session.get() do Python)
    const headersWithCookie = {
        ...mixdropHeaders,
        'Referer': 'https://mixdrop.top/',
        ...(rawCookies ? { 'Cookie': rawCookies } : {}),
    };

    const pageResp = await axios.get(embedUrl, {
        headers: headersWithCookie,
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
    });

    // Atualiza cookies com o que veio na segunda resposta também
    const cookies2 = parseCookies(pageResp.headers['set-cookie']);
    const allCookies = [rawCookies, cookies2].filter(Boolean).join('; ');

    let html = pageResp.data;
    if (typeof html !== 'string') throw new Error('Resposta do mixdrop não é HTML');

    // 3. Tenta extrair o link direto do HTML sem precisar fazer unpack
    let directUrl = null;
    const directPatterns = [
        /MDCore\.wurl\s*=\s*["']([^"']+)/i,
        /"videoUrl"\s*:\s*["']([^"']+\.mp4[^"']*)/i,
        /source\s+src=["']([^"']+\.mp4[^"']*)/i,
        /file\s*:\s*["']([^"']+\.mp4[^"']*)/i,
    ];
    for (const pat of directPatterns) {
        const m = html.match(pat);
        if (m && (m[1].includes('.mp4') || m[1].includes('cdn') || m[1].startsWith('//'))) {
            directUrl = m[1];
            break;
        }
    }

    // 4. Se não achou, faz o UNPACK do JS obfuscado (lógica principal do script Python)
    if (!directUrl) {
        // Procura o bloco eval(function(p,a,c,k,e,d){...}) no HTML
        const packedMatch = html.match(/eval\(function\(p,a,c,k,e,d\)[\s\S]*?\.split\('\|'\)\s*\)\s*\)/);
        if (packedMatch) {
            console.log('[mixdrop] script obfuscado encontrado, fazendo unpack...');
            const unpacked = unpackPacker(packedMatch[0]);

            // Agora procura no JS desempacotado
            for (const pat of directPatterns) {
                const m = unpacked.match(pat);
                if (m && (m[1].includes('.mp4') || m[1].includes('cdn') || m[1].startsWith('//'))) {
                    directUrl = m[1];
                    console.log('[mixdrop] URL encontrada no unpacked JS:', directUrl);
                    break;
                }
            }

            // Fallback: qualquer .mp4 no JS desempacotado
            if (!directUrl) {
                const anyMp4 = unpacked.match(/["']((?:https?:)?\/\/[^"']+\.mp4[^"']*)/i);
                if (anyMp4) directUrl = anyMp4[1];
            }
        }
    }

    if (!directUrl) throw new Error('Não foi possível extrair o link direto do mixdrop (url não encontrada no HTML nem no JS)');

    // Garante https
    if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;

    console.log('[mixdrop] URL final resolvida:', directUrl);

    // Retorna a URL e também os cookies — o player vai precisar deles
    return { directUrl, title: fid, cookies: allCookies };
};

// Extrai URL do mixdrop de qualquer HTML
const extractMixdropUrl = (html) => {
    const MD = '(?:mixdrop\\.[a-z]+|mdy48tn97\\.com|mdbekjwqa\\.pw|mdfx9dc8n\\.net|mdzsmutpcvykb\\.net)';
    const patterns = [
        new RegExp('<iframe[^>]+src=["\']((?:https?:)?//'+MD+'/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('(?:window\\.location|location\\.href)\\s*=\\s*["\']((?:https?:)?//'+MD+'/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('src\\s*[:=]\\s*["\']((?:https?:)?//'+MD+'/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('["\'](https?://'+MD+'/(?:e|f)/[a-z0-9]+)', 'i'),
    ];
    for (const pat of patterns) {
        const m = html.match(pat);
        if (m) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
    }
    return null;
};

// Segue o getplay.php e retorna a URL do mixdrop
const followGetplay = async (videoId, sv = 'mixdrop') => {
    const getplayUrl = `${BASE_URL}/e/getplay.php?id=${videoId}&sv=${sv}&token=${TOKEN}`;

    // Não segue redirect — captura o Location do 302 diretamente
    const resp = await axios.get(getplayUrl, {
        headers: { ...mixdropHeaders, 'Referer': `${BASE_URL}/` },
        maxRedirects: 0,
        timeout: 15000,
        validateStatus: (status) => status < 500,
    });

    // Caso 1: 302 com Location header (caminho feliz: pobreflixtv → mixdrop.top/e/FID)
    const location = resp.headers?.location;
    if (location) {
        const url = location.startsWith('//') ? 'https:' + location : location;
        if (getMixdropFID(url)) return url;
        // Location pode ser relativa ou outro redirect — tenta seguir mais um passo
        const resp2 = await axios.get(url, {
            headers: { ...mixdropHeaders, 'Referer': getplayUrl },
            maxRedirects: 5,
            timeout: 15000,
            validateStatus: () => true,
        });
        const loc2 = resp2.headers?.location || resp2.request?.res?.responseUrl || '';
        if (getMixdropFID(loc2)) return loc2;
        if (typeof resp2.data === 'string') {
            const fromHtml = extractMixdropUrl(resp2.data);
            if (fromHtml) return fromHtml;
        }
    }

    // Caso 2: respondeu HTML com link do mixdrop
    if (typeof resp.data === 'string') {
        const fromHtml = extractMixdropUrl(resp.data);
        if (fromHtml) return fromHtml;
    }

    // Caso 3: JSON
    if (resp.data?.url) return resp.data.url;
    if (resp.data?.link) return resp.data.link;

    throw new Error(`getplay.php nao retornou URL do mixdrop. Status: ${resp.status}. Resposta: ${String(resp.data).slice(0, 300)}`);
};


// Player HTML com <video> nativo (sem iframe, sem ads)
// A URL do MP4 é servida via /v1/proxy?url=... para que o cookie
// seja enviado server-side (o browser não consegue setar cookies cross-origin).
const buildVideoPlayer = (mp4Url, title = '', proxyUrl = null) => {
    const videoSrc = proxyUrl || mp4Url;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title || 'Player'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        video { width: 100%; height: 100%; display: block; background: #000; }
        #err { display:none; position:absolute; top:50%; left:50%; transform:translate(-50%,-50%);
               color:#fff; font-family:sans-serif; text-align:center; font-size:14px; }
    </style>
</head>
<body>
    <video id="v" controls autoplay playsinline preload="metadata"></video>
    <div id="err">Erro ao carregar vídeo.<br><small id="errmsg"></small></div>
    <script>
        const v = document.getElementById('v');
        const err = document.getElementById('err');
        const errmsg = document.getElementById('errmsg');
        const src = ${JSON.stringify(videoSrc)};

        v.src = src;
        v.onerror = function() {
            err.style.display = 'block';
            errmsg.textContent = 'Código: ' + (v.error ? v.error.code : '?');
        };
        v.play().catch(()=>{});
    </script>
</body>
</html>`;
};

// Fallback: serve o getplay.php direto se o resolver falhar
const fallbackEmbed = (videoId, sv) => {
    const getplayUrl = `${BASE_URL}/e/getplay.php?id=${videoId}&sv=${sv}&token=${TOKEN}`;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Player</title>
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; display: block; }
    </style>
</head>
<body>
    <iframe src="${getplayUrl}" allowfullscreen scrolling="no"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="origin"></iframe>
</body>
</html>`;
};

// --- PROXY DE VÍDEO ---
// Faz o streaming do MP4 server-side com os headers/cookie corretos.
// Isso é necessário porque o browser não consegue enviar cookies cross-origin
// para o CDN do mixdrop diretamente no <video src="...">.
app.get('/v1/proxy', async (req, res) => {
    const { url, cookies, referer } = req.query;
    if (!url) return res.status(400).send('URL obrigatória');

    try {
        const proxyHeaders = {
            ...mixdropHeaders,
            'Referer': referer || 'https://mixdrop.top/',
            'Origin': 'https://mixdrop.top',
            'Accept': '*/*',
        };
        if (cookies) proxyHeaders['Cookie'] = cookies;

        // Suporte a Range requests (seek no player)
        if (req.headers.range) proxyHeaders['Range'] = req.headers.range;

        const upstream = await axios.get(url, {
            headers: proxyHeaders,
            responseType: 'stream',
            timeout: 30000,
            validateStatus: () => true,
        });

        // Repassa status e headers relevantes
        res.status(upstream.status);
        const passthrough = ['content-type','content-length','content-range','accept-ranges','cache-control'];
        passthrough.forEach(h => {
            if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
        });
        // Garante que o browser aceite como vídeo
        if (!upstream.headers['content-type'] || !upstream.headers['content-type'].includes('video')) {
            res.setHeader('Content-Type', 'video/mp4');
        }
        res.setHeader('Access-Control-Allow-Origin', '*');

        upstream.data.pipe(res);
    } catch (err) {
        console.error('[proxy] erro:', err.message);
        res.status(502).send('Erro no proxy: ' + err.message);
    }
});

// --- ROTA DE ASSISTIR ---
app.get('/v1/watch/:id', async (req, res) => {
    const { id } = req.params;
    const sv = req.query.sv || 'mixdrop';

    if (!id) return res.send("ID Inválido");

    try {
        // 1. Segue getplay.php → pega URL do mixdrop
        const playerUrl = await followGetplay(id, sv);
        const fid = getMixdropFID(playerUrl);

        if (!fid) throw new Error('FID não encontrado: ' + playerUrl);

        // 2. Resolve MP4 direto via unpack JS + cookie de sessão
        const { directUrl, title, cookies } = await resolveMixdrop(fid);

        // 3. Monta URL do proxy com cookie e referer embutidos
        const host = `${req.protocol}://${req.get('host')}`;
        const proxyUrl = `${host}/v1/proxy?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent('https://mixdrop.top/')}&cookies=${encodeURIComponent(cookies || '')}`;

        // 4. Serve player nativo sem ads, usando o proxy
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(buildVideoPlayer(directUrl, title, proxyUrl));

    } catch (err) {
        console.error('[watch] Erro ao resolver, usando fallback:', err.message);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(fallbackEmbed(id, sv));
    }
});

// Rota auxiliar: resolve video_id a partir da URL da página e abre o player
app.get('/v1/play', async (req, res) => {
    let { url, sv } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    const server = sv || 'mixdrop';

    try {
        // 1. Busca a página e extrai o video_id do C_Video(...)
        const response = await api.get(url);
        const videoId = extractVideoId(response.data);
        if (!videoId) return res.status(404).json({ error: "video_id não encontrado na página" });

        // 2. Segue getplay.php → pega URL do mixdrop
        const playerUrl = await followGetplay(videoId, server);
        const fid = getMixdropFID(playerUrl);

        if (!fid) throw new Error('FID não encontrado: ' + playerUrl);

        // 3. Resolve MP4 direto com cookie de sessão
        const { directUrl, title, cookies } = await resolveMixdrop(fid);

        // 4. Monta URL do proxy
        const host = `${req.protocol}://${req.get('host')}`;
        const proxyUrl = `${host}/v1/proxy?url=${encodeURIComponent(directUrl)}&referer=${encodeURIComponent('https://mixdrop.top/')}&cookies=${encodeURIComponent(cookies || '')}`;

        // 5. Serve player nativo
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(buildVideoPlayer(directUrl, title, proxyUrl));

    } catch (err) {
        console.error('[play] Erro ao resolver:', err.message);
        res.status(500).json({ error: "Erro ao resolver link do vídeo", detail: err.message });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}

module.exports = app;
