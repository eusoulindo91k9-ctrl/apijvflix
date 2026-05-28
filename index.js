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
// MIXDROP RESOLVER (baseado no plugin JDownloader)
// Recebe URL do tipo mixdrop.ag/e/FILEID ou /f/FILEID
// Retorna o link direto do .mp4
// -------------------------------------------------------
const MIXDROP_API = 'https://api.mixdrop.ag';
const MIXDROP_API_MAIL = 'psp@jdownloader.org';
const MIXDROP_API_KEY  = 'u3aH2kgUYOQ36hd';

// Domínios ativos do mixdrop (mortos ignorados automaticamente)
const MIXDROP_DOMAINS = [
    'mixdrop.ag', 'mixdrop.club', 'mdy48tn97.com', 'mdbekjwqa.pw',
    'mdfx9dc8n.net', 'mdzsmutpcvykb.net', 'mixdrop.ms',
    'mixdrop.is', 'mixdrop.si', 'mixdrop.ps'
];

const mixdropHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
};

// Extrai o file ID de uma URL mixdrop  ex: mixdrop.ag/e/abc123 → abc123
const getMixdropFID = (url) => {
    if (!url) return null;
    // Cobre mixdrop.top, mixdrop.ag, e todos os domínios alternativos
    const m = url.match(/(?:mixdrop\.[a-z]+|mdy48tn97\.com|mdbekjwqa\.pw|mdfx9dc8n\.net|mdzsmutpcvykb\.net)\/(?:f|e)\/([a-z0-9]+)/i);
    return m ? m[1] : null;
};

// Resolve o MP4 direto a partir de um file ID mixdrop
const resolveMixdrop = async (fid) => {
    // 1. Verifica se existe via API
    const apiUrl = `${MIXDROP_API}/fileinfo?email=${encodeURIComponent(MIXDROP_API_MAIL)}&key=${MIXDROP_API_KEY}&ref[]=${fid}`;
    const apiResp = await axios.get(apiUrl, { headers: mixdropHeaders, timeout: 15000 });
    const json = apiResp.data;

    if (!json.success) throw new Error('Arquivo não encontrado no mixdrop');
    const fileInfo = json.result[0];
    if (fileInfo.deleted) throw new Error('Arquivo deletado no mixdrop');

    // 2. Acessa a página do embed para pegar o link direto
    const embedUrl = `https://mixdrop.top/e/${fid}`;
    const pageResp = await axios.get(embedUrl, {
        headers: { ...mixdropHeaders, 'Referer': 'https://mixdrop.top/' },
        timeout: 15000
    });
    let html = pageResp.data;

    // 3. Tenta extrair o link direto do JS da página (padrão do mixdrop)
    // Padrão: MDCore.wurl="https://...mp4"  ou  "videoUrl":"https://...mp4"
    let directUrl = null;

    const patterns = [
        /MDCore\.wurl\s*=\s*["']([^"']+\.mp4[^"']*)/i,
        /"videoUrl"\s*:\s*["']([^"']+\.mp4[^"']*)/i,
        /source\s+src=["']([^"']+\.mp4[^"']*)/i,
        /file\s*:\s*["']([^"']+\.mp4[^"']*)/i,
        /["'](https?:\/\/[^"']*\.mp4[^"']*)/i,
    ];

    for (const pat of patterns) {
        const m = html.match(pat);
        if (m) { directUrl = m[1]; break; }
    }

    // 4. Se tem ?download na página (passo extra que o JD menciona)
    if (!directUrl) {
        const continueMatch = html.match(/((?:\/f\/[a-z0-9]+)?\?download)/i);
        if (continueMatch) {
            const continueResp = await axios.get(`https://mixdrop.top${continueMatch[1]}`, {
                headers: { ...mixdropHeaders, 'Referer': embedUrl },
                timeout: 15000
            });
            html = continueResp.data;
            for (const pat of patterns) {
                const m = html.match(pat);
                if (m) { directUrl = m[1]; break; }
            }
        }
    }

    if (!directUrl) throw new Error('Não foi possível extrair o link direto do mixdrop');

    // Garante https
    if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;

    return { directUrl, title: fileInfo.title || fid };
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
const buildVideoPlayer = (mp4Url, title = '') => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title || 'Player'}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        video {
            width: 100%; height: 100%;
            display: block;
            background: #000;
        }
    </style>
</head>
<body>
    <video
        src="${mp4Url}"
        controls
        autoplay
        playsinline
        preload="metadata"
        crossorigin="anonymous"
    ></video>
</body>
</html>`;

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

        // 2. Resolve MP4 direto via lógica JDownloader
        const { directUrl, title } = await resolveMixdrop(fid);

        // 3. Serve player nativo sem ads
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(buildVideoPlayer(directUrl, title));

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

        // 3. Resolve MP4 direto
        const { directUrl, title } = await resolveMixdrop(fid);

        // 4. Serve player nativo
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(buildVideoPlayer(directUrl, title));

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
