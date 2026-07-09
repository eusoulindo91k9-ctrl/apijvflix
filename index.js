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

// === NOVO DOMÍNIO DO POBREFLIX (atualizado em 2026) ===
// Site original: https://www.pobreflixtv.gift/
// A API antiga usava pobreflixtv.autos + token fixo + endpoint /e/getplay.php.
// O novo site é IPS (Invision) e usa endpoints index.php?app=videobox&...
// Não há mais token nem sv=mixdrop — o playerData retorna TODOS os servers.
const BASE_URL = 'https://www.pobreflixtv.gift';
const PLAYER_DATA_ENDPOINT = '/index.php?app=videobox&module=video&controller=view&do=playerData&id=';
const EPISODES_LIST_ENDPOINT = '/index.php?app=videobox&module=video&controller=view&do=episodesList';
const SEARCH_ENDPOINT = '/index.php?app=videobox&module=video&controller=index&do=buscarContent';

const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': BASE_URL + '/'
    },
    timeout: 15000
});

const mixdropHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8',
};

// Sessões em memória para o proxy de stream
const videoSessions = new Map();

// --- HELPERS GERAIS ---

const extractId = (url) => {
    if (!url) return null;
    // Padrão: ...-slug-12345/  (qualquer URL de filme/série/episódio do pobreflix termina com -<id>/)
    const matches = url.match(/-(\d+)\/?$/);
    return matches ? matches[1] : null;
};

const cleanText = (text) => text ? text.replace(/\n/g, '').replace(/\s+/g, ' ').trim() : '';

/**
 * Extrai o video_id da página de detalhes.
 * No novo site, o ID é exposto diretamente como <div id="view" data-video-id="12345">.
 * Mantemos um fallback para o padrão antigo C_Video('12345') por segurança.
 */
const extractVideoId = (html) => {
    // 1. Padrão novo (filmes): <div id="view" data-video-id="12345" ...>
    const viewDivMatch = html.match(/<div[^>]*id=["']view["'][^>]*data-video-id=["'](\d+)["']/i);
    if (viewDivMatch) return viewDivMatch[1];

    // 2. Padrão novo (séries): <section class="vbEpisodes" data-video-id="12345" ...>
    const sectionMatch = html.match(/<section[^>]*class=["'][^"']*vbEpisodes[^"']*["'][^>]*data-video-id=["'](\d+)["']/i);
    if (sectionMatch) return sectionMatch[1];
    // Variante: data-video-id pode vir antes de class
    const sectionMatch2 = html.match(/<section[^>]*data-video-id=["'](\d+)["'][^>]*class=["'][^"']*vbEpisodes[^"']*["']/i);
    if (sectionMatch2) return sectionMatch2[1];

    // 3. Padrão antigo: function NewAudio() ... C_Video('12345')
    const newAudioMatch = html.match(/function\s+NewAudio\s*\(\s*\)[\s\S]*?C_Video\s*\(\s*['"](\d+)['"]/);
    if (newAudioMatch) return newAudioMatch[1];

    // 4. Fallback: primeiro C_Video encontrado
    const match = html.match(/C_Video\(['"](\d+)['"]/);
    return match ? match[1] : null;
};

/**
 * Faz GET seguindo redirects (igual curl -L), retornando { html, finalUrl }.
 * Preserva cookies e referer em cada hop.
 */
const fetchFollowingRedirects = async (startUrl, { maxRedirects = 10 } = {}) => {
    const BROWSER_HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    };

    let currentUrl = startUrl;
    let cookieJar = {};
    let hops = 0;

    while (hops < maxRedirects) {
        hops++;

        const cookieHeader = Object.entries(cookieJar)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        const resp = await axios.get(currentUrl, {
            headers: {
                ...BROWSER_HEADERS,
                'Referer': currentUrl,
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            maxRedirects: 0,
            validateStatus: (s) => s < 500,
            timeout: 15000,
        });

        const setCookie = resp.headers['set-cookie'];
        if (setCookie) {
            for (const cookie of (Array.isArray(setCookie) ? setCookie : [setCookie])) {
                const [pair] = cookie.split(';');
                const eqIdx = pair.indexOf('=');
                if (eqIdx > 0) {
                    cookieJar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
                }
            }
        }

        const status = resp.status;
        const location = resp.headers['location'];

        if (status >= 300 && status < 400 && location) {
            const resolved = new URL(location, currentUrl).href;
            console.log(`[fetchFollowingRedirects] ${status} ${currentUrl} → ${resolved}`);
            currentUrl = resolved;
            continue;
        }

        console.log(`[fetchFollowingRedirects] ${status} ${currentUrl} (${hops} hop(s))`);
        return { html: resp.data, finalUrl: currentUrl };
    }

    throw new Error(`[fetchFollowingRedirects] Limite de ${maxRedirects} redirects atingido em: ${currentUrl}`);
};

/**
 * Parser de card no novo layout do Pobreflix.
 * Estrutura típica:
 *   <div class="swiper-slide vbTabSliderItem">
 *     <a href="..." class="block" title="Assistir X">
 *       <div class="blocktwo">
 *         <img src="..." alt="...">
 *         <div class="from-background/20" ...></div>
 *         <div class="top"><div>HD</div><div>DUAL</div></div>
 *         <div class="info"><h3>Title</h3><p>2026</p></div>
 *       </div>
 *     </a>
 *   </div>
 */
const parseCard = ($, element) => {
    try {
        // O elemento pode ser o próprio <a class="block"> ou um container que o contém.
        const $el = $(element);
        const isAnchor = $el.is('a.block');
        const anchor = isAnchor ? $el : $el.find('a.block').first();
        let url = anchor.attr('href') || '';
        if (url && !url.startsWith('http')) url = BASE_URL + url;

        let title = cleanText(anchor.attr('title') || '');
        if (!title) {
            title = cleanText($el.find('.info h3').first().text());
        }
        // Remove prefixo "Assistir " se presente
        if (title.toLowerCase().startsWith('assistir ')) {
            title = title.slice(9).trim();
        }

        let thumb = $el.find('.blocktwo img').attr('src') ||
                    $el.find('img').first().attr('src') || '';
        if (thumb && !thumb.startsWith('http')) thumb = BASE_URL + thumb;

        const year = cleanText($el.find('.info p').first().text());

        // Qualidades: múltiplos <div> dentro de .top (ex: HD, DUAL, DUB, LEG)
        const qualities = [];
        $el.find('.top > div').each((_, el) => {
            const q = cleanText($(el).text());
            if (q) qualities.push(q);
        });
        const quality = qualities.join(' / ');

        return { id: extractId(url), title, url, thumb, year, quality };
    } catch (e) {
        return null;
    }
};

// --- MIXDROP: extração de FID e URL ---

const getMixdropFID = (url) => {
    if (!url) return null;
    // Aceita todos os domínios conhecidos do Mixdrop (incluindo os novos miixdrop.net / miiiixdrop.net / mxdrop.sx)
    const m = url.match(/(?:mixdrop\.[a-z]+|miixdrop\.[a-z]+|miiiixdrop\.[a-z]+|mxdrop\.[a-z]+|mdy48tn97\.com|mdbekjwqa\.pw|mdfx9dc8n\.net|mdzsmutpcvykb\.net)\/(?:f|e)\/([a-z0-9]+)/i);
    return m ? m[1] : null;
};

const extractMixdropUrl = (html) => {
    const MD = '(?:mixdrop\\.[a-z]+|miixdrop\\.[a-z]+|miiiixdrop\\.[a-z]+|mxdrop\\.[a-z]+|mdy48tn97\\.com|mdbekjwqa\\.pw|mdfx9dc8n\\.net|mdzsmutpcvykb\\.net)';
    const patterns = [
        new RegExp('<iframe[^>]+src=["\']((?:https?:)?//' + MD + '/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('(?:window\\.location|location\\.href)\\s*=\\s*["\']((?:https?:)?//' + MD + '/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('src\\s*[:=]\\s*["\']((?:https?:)?//' + MD + '/(?:e|f)/[a-z0-9]+[^"\']*)', 'i'),
        new RegExp('["\'](https?://' + MD + '/(?:e|f)/[a-z0-9]+)', 'i'),
    ];
    for (const pat of patterns) {
        const m = html.match(pat);
        if (m) return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
    }
    return null;
};

// --- NOVO: PLAYER DATA → extrai FID do Mixdrop ---

/**
 * Chama o endpoint playerData do novo Pobreflix e retorna:
 *   { fid, mixdropUrl, audio, isEpisode, serversDub, serversLeg, navigation }
 *
 * O JSON retornado pelo site tem formato:
 *   {
 *     "players": [{"label":"MixDrop","url":"https://miixdrop.net/e/","downloadUrl":"..."}],
 *     "servers_dub": "mixdrop=abc123&streamtape=...&byse=...",
 *     "servers_leg": "mixdrop=def456&streamtape=...&byse=...",
 *     "is_episode": "1" | "",
 *     "current_audio": "Dublado" | "Legendado",
 *     "navigation": {"prev":"","next":"","series":""}
 *   }
 *
 * O FID do Mixdrop vem em servers_dub OU servers_leg (query-string com provider=fid).
 */
const fetchPlayerData = async (videoId) => {
    const url = BASE_URL + PLAYER_DATA_ENDPOINT + encodeURIComponent(videoId);

    const resp = await axios.get(url, {
        headers: {
            ...mixdropHeaders,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Referer': BASE_URL + '/',
            'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 15000,
        validateStatus: (s) => s < 500,
    });

    if (resp.status !== 200 || typeof resp.data !== 'object') {
        throw new Error(`playerData falhou (status ${resp.status}) para id=${videoId}`);
    }

    const data = resp.data;

    // Decodifica &amp; → & caso o servidor retorne HTML-entities na query-string
    const decodeEntities = (s) => (s || '').replace(/&amp;/g, '&');

    const serversDubRaw = decodeEntities(data.servers_dub || '');
    const serversLegRaw = decodeEntities(data.servers_leg || '');

    // Tenta Dublado primeiro; se vazio, usa Legendado
    const chosenRaw = serversDubRaw || serversLegRaw;
    const audio = serversDubRaw ? 'Dublado' : (serversLegRaw ? 'Legendado' : (data.current_audio || ''));

    // Parse da query-string "mixdrop=fid&streamtape=fid&byse=fid&doodstream=fid"
    const servers = {};
    if (chosenRaw) {
        for (const pair of chosenRaw.split('&')) {
            const [k, v] = pair.split('=');
            if (k && v) servers[k] = v;
        }
    }

    // Encontra o URL base do Mixdrop no array de players
    const mixdropPlayer = (data.players || []).find(p => /mixdrop/i.test(p.label || '') || getMixdropFID(p.url + 'xxxxx'));
    const mixdropBaseUrl = mixdropPlayer ? mixdropPlayer.url : 'https://miixdrop.net/e/';

    const fid = servers.mixdrop || null;
    const mixdropUrl = fid ? (mixdropBaseUrl + fid) : null;

    return {
        fid,
        mixdropUrl,
        audio,
        isEpisode: data.is_episode === '1' || data.is_episode === 1,
        servers,
        serversDub: serversDubRaw,
        serversLeg: serversLegRaw,
        navigation: data.navigation || {},
        raw: data,
    };
};

// --- UNPACK (p,a,c,k,e,d) ---

function unpackPacker(source) {
    const args = source.match(/\}\('([\s\S]*)', *(\d+), *(\d+), *'([\s\S]*)'\.split\('\|'\)/);
    if (!args) return source;

    const payload = args[1];
    const radix = parseInt(args[2]);
    const symtab = args[4].split('|');

    const lookup = (match) => {
        try {
            const index = parseInt(match, radix);
            if (index < symtab.length && symtab[index]) return symtab[index];
        } catch (e) {}
        return match;
    };

    return payload.replace(/\b\w+\b/g, lookup);
}

function extractVideoFromUnpacked(unpacked) {
    const patterns = [
        /MDCore\.wurl="([^"]+)"/,
        /MDCore\.\w+="([^"]+\.mp4[^"]*)"/,
        /https?:\/\/[^"']+\.mp4[^"']*/,
        /\/\/[^"']+\.mp4[^"']*/
    ];
    for (const pattern of patterns) {
        const match = unpacked.match(pattern);
        if (match) {
            let url = match[1] || match[0];
            if (url.startsWith("//")) url = "https:" + url;
            return url;
        }
    }
    return null;
}

// --- RESOLVE MIXDROP: FID → MP4 direto ---

const MIXDROP_API      = 'https://api.mixdrop.ag';
const MIXDROP_API_MAIL = 'psp@jdownloader.org';
const MIXDROP_API_KEY  = 'u3aH2kgUYOQ36hd';

const resolveMixdrop = async (fid) => {
    // 1. Verifica existência via API oficial
    const apiUrl = `${MIXDROP_API}/fileinfo?email=${encodeURIComponent(MIXDROP_API_MAIL)}&key=${MIXDROP_API_KEY}&ref[]=${fid}`;
    const apiResp = await axios.get(apiUrl, { headers: mixdropHeaders, timeout: 15000 });
    const json = apiResp.data;

    if (!json.success) throw new Error('Arquivo não encontrado no mixdrop');
    const fileInfo = (json.result || [])[0];
    if (!fileInfo) throw new Error('Arquivo não retornado pelo mixdrop');
    if (fileInfo.deleted) throw new Error('Arquivo deletado no mixdrop');

    // 2. Acessa a página embed e pega cookies.
    //    mixdrop.top continua sendo o ponto de entrada estável — ele redireciona
    //    para o domínio atual (miixdrop.net / miiiixdrop.net / mxdrop.sx etc.).
    const embedUrl = `https://mixdrop.top/e/${fid}`;
    const pageResp = await axios.get(embedUrl, {
        headers: { ...mixdropHeaders, 'Referer': BASE_URL + '/' },
        timeout: 15000
    });

    const rawCookies = pageResp.headers['set-cookie'];
    let cookieString = '';
    if (rawCookies) {
        cookieString = rawCookies.map(c => c.split(';')[0]).join('; ');
    }

    let html = typeof pageResp.data === 'string' ? pageResp.data : '';

    // 3. Tenta extrair MP4 por padrões diretos no JS
    let directUrl = null;
    const directPatterns = [
        /MDCore\.wurl\s*=\s*["']([^"']+\.mp4[^"']*)/i,
        /"videoUrl"\s*:\s*["']([^"']+\.mp4[^"']*)/i,
        /source\s+src=["']([^"']+\.mp4[^"']*)/i,
        /file\s*:\s*["']([^"']+\.mp4[^"']*)/i,
        /["'](https?:\/\/[^"']*\.mp4[^"']*)/i,
    ];
    for (const pat of directPatterns) {
        const m = html.match(pat);
        if (m) { directUrl = m[1]; break; }
    }

    // 4. Tenta via unpack (p,a,c,k,e,d)
    if (!directUrl) {
        const packedMatch = html.match(/(eval\(function\(p,a,c,k,e,d[\s\S]*?<\/script>)/);
        if (packedMatch) {
            const unpacked = unpackPacker(packedMatch[1]);
            directUrl = extractVideoFromUnpacked(unpacked);
        }
    }

    // 5. Tenta link ?download
    if (!directUrl) {
        const continueMatch = html.match(/((?:\/f\/[a-z0-9]+)?\?download)/i);
        if (continueMatch) {
            const continueResp = await axios.get(`https://mixdrop.top${continueMatch[1]}`, {
                headers: { ...mixdropHeaders, 'Referer': embedUrl },
                timeout: 15000
            });
            html = typeof continueResp.data === 'string' ? continueResp.data : '';
            for (const pat of directPatterns) {
                const m = html.match(pat);
                if (m) { directUrl = m[1]; break; }
            }
        }
    }

    if (!directUrl) throw new Error('Não foi possível extrair o link direto do mixdrop');
    if (directUrl.startsWith('//')) directUrl = 'https:' + directUrl;

    return {
        directUrl,
        cookies: cookieString,
        referer: 'https://mixdrop.top',
        title: fileInfo.title || fid
    };
};

// --- ROTAS GERAIS ---

app.get('/', (req, res) => {
    res.json({
        status: "Online",
        msg: "API JVFlix (Pobreflix .gift)",
        endpoints: {
            home: "/v1/get/recommeds",
            search: "/v1/search?s=nome",
            info: "/v1/info?url=link_completo",
            watch: "/v1/watch/:id",
            stream: "/api/stream/:sessionId",
            getlives: "/v1/getlives",
            watchlive: "/v1/watchlive?url=url_do_embed"
        }
    });
});

/**
 * Home — recomendações.
 *
 * O novo site tem 2 seções <section id="vbTabSlider" aria-label="Filmes|Séries">,
 * cada uma com 3 painéis: releases_<widgetKey>_html, latest_<widgetKey>_html, mostviewed_<widgetKey>_html.
 * Por compatibilidade mantemos releases/trending, onde trending = mostviewed.
 */
app.get('/v1/get/recommeds', async (req, res) => {
    try {
        const response = await api.get('/');
        const $ = cheerio.load(response.data);

        const data = {
            movies: { releases: [], trending: [] },
            series: { releases: [], trending: [] }
        };

        // Encontra as duas seções vbTabSlider
        const sections = $('section#vbTabSlider');
        if (sections.length === 0) {
            return res.status(502).json({ error: "Estrutura da home mudou — nenhum #vbTabSlider encontrado" });
        }

        const fillSection = ($section, target) => {
            // O id do widget é a classe do section (ex: kw8a73lf1)
            const widgetKey = ($section.attr('class') || '').split(' ').find(c => /^[a-z0-9]{8,}$/i.test(c));
            if (!widgetKey) return;

            // Painel de Lançamentos
            $section.find(`.vbPanel-container.releases_${widgetKey}_html .swiper-slide`).each((i, el) => {
                const card = parseCard($, el);
                if (card && card.id) target.releases.push(card);
            });
            // Painel "trending": tentamos mostviewed (Mais Vistos) primeiro; se vier vazio
            // (o site carrega esse painel via AJAX só quando o usuário clica na aba),
            // caímos para latest (Recentes), que já vem renderizado no HTML.
            $section.find(`.vbPanel-container.mostviewed_${widgetKey}_html .swiper-slide`).each((i, el) => {
                const card = parseCard($, el);
                if (card && card.id) target.trending.push(card);
            });
            if (target.trending.length === 0) {
                $section.find(`.vbPanel-container.latest_${widgetKey}_html .swiper-slide`).each((i, el) => {
                    const card = parseCard($, el);
                    if (card && card.id) target.trending.push(card);
                });
            }
        };

        // Filmes = primeira seção (aria-label="Filmes"); Séries = segunda (aria-label="Séries")
        sections.each((_, sec) => {
            const $sec = $(sec);
            const label = ($sec.attr('aria-label') || '').toLowerCase();
            if (label.includes('filme')) fillSection($sec, data.movies);
            else if (label.includes('série') || label.includes('serie')) fillSection($sec, data.series);
        });

        res.json(data);
    } catch (error) {
        console.error('[recommeds] Erro:', error.message);
        res.status(500).json({ error: "Erro ao carregar home", detail: error.message });
    }
});

/**
 * Search — busca via endpoint AJAX.
 *
 * URL: /index.php?app=videobox&module=video&controller=index&do=buscarContent&q=<query>
 * Retorna: {"html": "<cards...>"}
 */
app.get('/v1/search', async (req, res) => {
    const query = req.query.s;
    if (!query) return res.status(400).json({ error: "Parâmetro 's' obrigatório" });

    try {
        const url = BASE_URL + SEARCH_ENDPOINT + '&q=' + encodeURIComponent(query);
        const resp = await axios.get(url, {
            headers: {
                ...mixdropHeaders,
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Referer': BASE_URL + '/buscar',
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout: 15000,
            validateStatus: (s) => s < 500,
        });

        // O endpoint pode retornar JSON {html:"..."} ou diretamente HTML
        let html = '';
        if (resp.status === 200) {
            if (typeof resp.data === 'string') {
                html = resp.data;
            } else if (resp.data && typeof resp.data === 'object' && resp.data.html) {
                html = resp.data.html;
            }
        }

        if (!html) {
            return res.status(502).json({ error: "Resposta de busca vazia" });
        }

        const $ = cheerio.load(html);
        const results = [];

        // No resultado da busca os cards vêm como <a class="block"> soltos
        // (sem wrapper .swiper-slide). parseCard já procura por a.block internamente,
        // então passamos o próprio <a> como container.
        $('a.block').each((i, el) => {
            const card = parseCard($, el);
            if (card && card.id) results.push(card);
        });

        // Dedup por id (às vezes o mesmo filme aparece duas vezes)
        const seen = new Set();
        const deduped = results.filter(r => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        });

        res.json({ results: deduped, total: deduped.length });
    } catch (error) {
        console.error('[search] Erro:', error.message);
        res.status(500).json({ error: "Erro na busca", detail: error.message });
    }
});

/**
 * Info — detalhes de filme/série/episódio.
 *
 * IMPORTANTE: o novo site retorna 403 se a URL tiver ?area=online.
 * Não usamos mais esse parâmetro — a página em si já contém o data-video-id.
 */
app.get('/v1/info', async (req, res) => {
    let { url, season } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    // NOVO: NÃO adicionar ?area=online (causa 403 no novo domínio)
    // Removemos qualquer ?area=online que vier na URL do cliente
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.delete('area');
    if (season) parsedUrl.searchParams.set('temporada', season);
    url = parsedUrl.href;

    try {
        const { html: pageHtml, finalUrl } = await fetchFollowingRedirects(url);
        const $ = cheerio.load(pageHtml);

        // Detecção de série: presença de <section class="vbEpisodes"> OU URL com /series/online/
        const vbEpisodesSection = $('.vbEpisodes');
        const isSeries = vbEpisodesSection.length > 0 || finalUrl.includes('/series/online/');

        // Título: <h2 class="one"> é o título limpo; <h1 class="type"> é "Assistir X Online"
        const titleH2 = cleanText($('.one').first().text());
        const titleH1 = cleanText($('.type').first().text());
        const title = titleH2 || titleH1.replace(/^Assistir\s+/i, '').replace(/\s+Online$/i, '').trim();

        // Thumb: .vbItemImage img (novo layout)
        let thumb = $('.vbItemImage img').attr('src') || '';
        if (!thumb) {
            // Fallback antigo
            thumb = $('.vb_image_container').attr('data-background-src') || '';
        }
        if (thumb && !thumb.startsWith('http')) thumb = BASE_URL + thumb;

        // Sinopse: .sinopse-text
        const desc = cleanText($('.sinopse-text').first().text()) ||
                     cleanText($('.sinopse').text().replace('Ler mais...', ''));

        // Ano / duração / nota: vêm no <span class="meta-info"> como "7.6 • 2026 • 1h, 53min"
        const metaInfoText = cleanText($('.meta-info').first().text());
        let year = '';
        let imdb = cleanText($('.nota').first().text()); // na verdade é nota TMDB
        if (metaInfoText) {
            const yearMatch = metaInfoText.match(/\b(19|20)\d{2}\b/);
            if (yearMatch) year = yearMatch[0];
        }
        // Fallback: classe .infos span[1] (antigo layout)
        if (!year) {
            year = cleanText($('.infos span').eq(1).text());
        }

        // Video ID: <div id="view" data-video-id="...">
        const videoId = extractVideoId(pageHtml);
        const pageId = extractId(finalUrl);

        const result = {
            id: pageId,
            video_id: videoId,
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
            // A seção .vbEpisodes tem: data-video-id, data-current-season, data-current-audio,
            // e um dropdown .vbSeasonSelect__option[data-season="N"] para cada temporada.
            const sectionEl = vbEpisodesSection.first();
            const currentSeason = parseInt(sectionEl.attr('data-current-season') || '1', 10);
            const currentAudio = sectionEl.attr('data-current-audio') || 'Dublado';

            // Lista todas as temporadas a partir dos botões do dropdown
            const seasons = [];
            sectionEl.find('.vbSeasonSelect__option').each((_, el) => {
                const s = parseInt($(el).attr('data-season') || '0', 10);
                if (s > 0 && !seasons.includes(s)) seasons.push(s);
            });
            const totalSeasons = seasons.length > 0 ? Math.max(...seasons) : currentSeason;
            const audioToUse = currentAudio || 'Dublado';

            // Helper para fazer parse da lista de episódios no HTML (quando já vem na página,
            // para a temporada atual)
            const extractEpisodesFromHtml = (html, seasonNum) => {
                const $$ = cheerio.load(html);
                const eps = [];
                $$('.vbEpisodeCard').each((index, element) => {
                    const linkTag = $$(element).find('a.vbEpisodeCard__link').first();
                    const epUrl = linkTag.attr('href') || '';
                    const epTitle = cleanText($$(element).find('.vbEpisodeCard__title').first().text()) ||
                                   cleanText($$(element).attr('data-title'));
                    const epNumber = parseInt($$(element).attr('data-number')) || (index + 1);
                    const epThumb = $$(element).find('.vbEpisodeCard__thumb img').attr('src') || '';
                    const epDuration = cleanText($$(element).find('.vbEpisodeCard__duration').first().text());
                    const epSynopsis = cleanText($$(element).find('.vbEpisodeCard__synopsis').first().text());
                    if (epUrl) {
                        eps.push({
                            name: epTitle,
                            number: epNumber,
                            season: seasonNum,
                            player_id: extractId(epUrl),
                            url: epUrl,
                            thumb: epThumb,
                            duration: epDuration,
                            synopsis: epSynopsis,
                            order: epNumber
                        });
                    }
                });
                return eps.sort((a, b) => a.order - b.order);
            };

            // Helper para chamar o endpoint episodesList (AJAX do novo site)
            const fetchEpisodesAjax = async (seasonNum) => {
                const ajaxUrl = BASE_URL + EPISODES_LIST_ENDPOINT +
                    '&id=' + encodeURIComponent(videoId) +
                    '&season=' + encodeURIComponent(seasonNum) +
                    '&audio=' + encodeURIComponent(audioToUse);
                const resp = await axios.get(ajaxUrl, {
                    headers: {
                        ...mixdropHeaders,
                        'Accept': 'application/json',
                        'Referer': finalUrl,
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    timeout: 15000,
                    validateStatus: (s) => s < 500,
                });
                if (resp.status !== 200 || typeof resp.data !== 'object') {
                    throw new Error(`episodesList status ${resp.status}`);
                }
                const episodes = resp.data.episodes || [];
                return episodes.map((ep, index) => ({
                    name: cleanText(ep.title) || `Episódio ${ep.number}`,
                    number: parseInt(ep.number) || (index + 1),
                    season: seasonNum,
                    player_id: extractId(ep.url),
                    url: ep.url,
                    thumb: ep.thumb || '',
                    duration: ep.duration ? `${ep.duration} min` : '',
                    synopsis: cleanText(ep.synopsis),
                    order: parseInt(ep.number) || (index + 1)
                })).sort((a, b) => a.order - b.order);
            };

            // Temporada atual: usamos AJAX para garantir a lista completa.
            // O HTML inicial às vezes só traz os primeiros episódios (lazy load via JS).
            const episodesBySeason = {};
            try {
                episodesBySeason[currentSeason] = await fetchEpisodesAjax(currentSeason);
                console.log(`[info] Temporada ${currentSeason}: ${episodesBySeason[currentSeason].length} episódios via AJAX`);
            } catch (e) {
                console.error(`[info] AJAX falhou para temporada atual ${currentSeason}:`, e.message);
                episodesBySeason[currentSeason] = extractEpisodesFromHtml(pageHtml, currentSeason);
                console.log(`[info] Temporada ${currentSeason}: ${episodesBySeason[currentSeason].length} episódios via HTML (fallback)`);
            }

            // Demais temporadas via AJAX em paralelo
            const otherSeasons = seasons.filter(s => s !== currentSeason);
            if (otherSeasons.length > 0 && videoId) {
                await Promise.all(otherSeasons.map(async (s) => {
                    try {
                        episodesBySeason[s] = await fetchEpisodesAjax(s);
                        console.log(`[info] Temporada ${s}: ${episodesBySeason[s].length} episódios via AJAX`);
                    } catch (e) {
                        console.error(`[info] Erro ao buscar temporada ${s} via AJAX:`, e.message);
                        // Fallback: tenta buscar via HTML da própria página da série com ?temporada=N
                        try {
                            const fallbackUrl = `${finalUrl.split('?')[0]}?temporada=${s}`;
                            const { html: sHtml } = await fetchFollowingRedirects(fallbackUrl);
                            episodesBySeason[s] = extractEpisodesFromHtml(sHtml, s);
                            console.log(`[info] Temporada ${s}: ${episodesBySeason[s].length} episódios via fallback HTML`);
                        } catch (e2) {
                            console.error(`[info] Fallback HTML também falou para temporada ${s}:`, e2.message);
                            episodesBySeason[s] = [];
                        }
                    }
                }));
            }

            // Lista flat ordenada por temporada (compatibilidade)
            const allEpisodes = Object.keys(episodesBySeason)
                .map(Number)
                .sort((a, b) => a - b)
                .flatMap(s => episodesBySeason[s] || []);

            result.total_seasons = totalSeasons;
            result.current_season = currentSeason;
            result.audio = audioToUse;
            result.episodes = allEpisodes;
            result.episodes_by_season = episodesBySeason;
        } else {
            const watchId = videoId || pageId;
            result.watch_link = `${req.protocol}://${req.get('host')}/v1/watch/${watchId}`;
        }

        res.json(result);
    } catch (error) {
        console.error('[info] Erro:', error.message);
        res.status(500).json({ error: "Erro ao pegar detalhes", detail: error.message });
    }
});

// --- ROTA WATCH: playerData → mixdrop → unpack → proxy ---

app.get('/v1/watch/:id', async (req, res) => {
    const { id } = req.params;
    const asJson = req.query.json === '1';

    if (!id) return res.status(400).json({ error: "ID inválido" });

    try {
        // 1. playerData → FID do Mixdrop
        const playerData = await fetchPlayerData(id);
        if (!playerData.fid) {
            throw new Error(`Mixdrop FID não encontrado no playerData (id=${id}). servers_dub="${playerData.serversDub}" servers_leg="${playerData.serversLeg}"`);
        }

        // 2. Resolve MP4 + cookies
        const { directUrl, cookies, referer, title } = await resolveMixdrop(playerData.fid);

        // 3. Salva sessão para o proxy de stream
        const sessionId = Math.random().toString(36).substring(2, 15);
        videoSessions.set(sessionId, { mp4Url: directUrl, cookies, referer });

        const streamUrl = `/api/stream/${sessionId}`;
        const host = `https://apijvflix-1.onrender.com`;

        return res.json({
            title,
            fid: playerData.fid,
            audio: playerData.audio,
            is_episode: playerData.isEpisode,
            streamUrl: host + streamUrl,
            mp4Url: directUrl
        });

    } catch (err) {
        console.error('[watch] Erro:', err.message);
        return res.status(500).json({ error: "Erro ao resolver vídeo", detail: err.message });
    }
});

// Rota auxiliar: resolve a partir da URL da página
app.get('/v1/play', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    // Remover ?area=online (causa 403 no novo site)
    const parsedUrl = new URL(url);
    parsedUrl.searchParams.delete('area');
    url = parsedUrl.href;

    try {
        const { html: pageHtml } = await fetchFollowingRedirects(url);
        const videoId = extractVideoId(pageHtml);
        if (!videoId) return res.status(404).json({ error: "video_id não encontrado na página" });

        const playerData = await fetchPlayerData(videoId);
        if (!playerData.fid) throw new Error('Mixdrop FID não encontrado no playerData');

        const { directUrl, cookies, referer, title } = await resolveMixdrop(playerData.fid);

        const sessionId = Math.random().toString(36).substring(2, 15);
        videoSessions.set(sessionId, { mp4Url: directUrl, cookies, referer });

        const host = `${req.protocol}://${req.get('host')}`;
        return res.json({
            title,
            fid: playerData.fid,
            audio: playerData.audio,
            streamUrl: host + `/api/stream/${sessionId}`,
            mp4Url: directUrl
        });

    } catch (err) {
        console.error('[play] Erro:', err.message);
        res.status(500).json({ error: "Erro ao resolver link do vídeo", detail: err.message });
    }
});

// --- PROXY DE STREAM: injeta cookies e faz pipe do CDN ---

app.get('/api/stream/:sessionId', async (req, res) => {
    const sessionData = videoSessions.get(req.params.sessionId);
    if (!sessionData) return res.status(404).send('Sessão expirada ou inválida');

    const { mp4Url, cookies, referer } = sessionData;

    try {
        const streamHeaders = {
            'User-Agent': mixdropHeaders['User-Agent'],
            'Referer': referer,
            'Origin': referer,
            'Cookie': cookies,
            'Accept': '*/*'
        };

        if (req.headers.range) {
            streamHeaders.Range = req.headers.range;
        }

        const cdnResp = await axios({
            method: 'get',
            url: mp4Url,
            headers: streamHeaders,
            responseType: 'stream',
            timeout: 30000
        });

        res.writeHead(cdnResp.status, cdnResp.headers);
        cdnResp.data.pipe(res);

    } catch (error) {
        console.error('[stream] Erro no proxy:', error.message);
        res.status(500).send('Erro ao buscar vídeo no CDN');
    }
});

// --- LIVES: busca eventos ao vivo do reidoscanais ---

const LIVES_API_URL = 'https://api.reidoscanais.ooo/sports?status=live';
const LIVES_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'pt-BR',
    'origin': 'https://reidoscanais.ooo',
    'priority': 'u=1, i',
    'referer': 'https://reidoscanais.ooo/',
    'sec-ch-ua': '"Chromium";v="127", "Not)A;Brand";v="99", "Microsoft Edge Simulate";v="127", "Lemur";v="127"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'
};

app.get('/v1/getlives', async (req, res) => {
    try {
        const response = await axios.get(LIVES_API_URL, {
            headers: LIVES_HEADERS,
            timeout: 15000
        });

        const data = response.data;

        if (!data || !data.success) {
            return res.status(502).json({ success: false, error: 'Resposta inválida da API de lives' });
        }

        const host = `${req.protocol}://${req.get('host')}`;
        const enriched = (data.data || []).map(event => ({
            ...event,
            embeds: (event.embeds || []).map(embed => ({
                ...embed,
                watchlive_url: `${host}/v1/watchlive?url=${encodeURIComponent(embed.embed_url)}`
            }))
        }));

        return res.json({
            success: true,
            data: enriched,
            total: enriched.length
        });

    } catch (err) {
        console.error('[getlives] Erro:', err.message);
        return res.status(500).json({ success: false, error: 'Erro ao buscar lives', detail: err.message });
    }
});

// --- WATCHLIVE: extrai src do iframe do esportesembed e serve como player proxy ---

app.get('/v1/watchlive', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Parâmetro 'url' obrigatório" });

    try {
        const pageResp = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9',
                'Referer': 'https://reidoscanais.ooo/'
            },
            timeout: 15000
        });

        const $ = cheerio.load(pageResp.data);

        const iframeSrc = $('body iframe').first().attr('src');

        if (!iframeSrc) {
            return res.status(404).json({ error: 'Nenhum iframe encontrado na página do embed' });
        }

        const resolvedSrc = iframeSrc.startsWith('http')
            ? iframeSrc
            : iframeSrc.startsWith('//')
                ? 'https:' + iframeSrc
                : new URL(iframeSrc, url).href;

        const proxyUrl = `${req.protocol}://${req.get('host')}/api/live-proxy?url=${encodeURIComponent(resolvedSrc)}`;

        const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Player</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
    iframe {
      position: absolute;
      top: 0; left: 0;
      width: 100%; height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <iframe
    src="${proxyUrl}"
    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
    allowfullscreen
    frameborder="0"
  ></iframe>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);

    } catch (err) {
        console.error('[watchlive] Erro:', err.message);
        return res.status(500).json({ error: 'Erro ao processar embed', detail: err.message });
    }
});

// --- PROXY DE IFRAME: injeta origin e referer reidoscanais.ooo ---

app.get('/api/live-proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Parâmetro url obrigatório');

    try {
        const proxyHeaders = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'pt-BR,pt;q=0.9',
            'Origin': 'https://esportesembed.com/',
            'Referer': 'https://esportesembed.com/',
            'sec-ch-ua': '"Chromium";v="127", "Not)A;Brand";v="99", "Microsoft Edge Simulate";v="127", "Lemur";v="127"',
            'sec-ch-ua-mobile': '?1',
            'sec-ch-ua-platform': '"Android"',
            'sec-fetch-dest': 'iframe',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'cross-site'
        };

        const targetResp = await axios.get(url, {
            headers: proxyHeaders,
            timeout: 15000,
            validateStatus: () => true,
            maxRedirects: 5
        });

        const contentType = targetResp.headers['content-type'] || 'text/html';
        res.setHeader('Content-Type', contentType);

        res.removeHeader('X-Frame-Options');
        res.setHeader(
            'Content-Security-Policy',
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-src *; child-src *; connect-src *; script-src * 'unsafe-inline' 'unsafe-eval'; media-src * data: blob:;"
        );

        return res.send(targetResp.data);

    } catch (err) {
        console.error('[live-proxy] Erro:', err.message);
        return res.status(500).send('Erro ao buscar conteúdo do iframe');
    }
});

// --- START ---

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
        console.log(`BASE_URL: ${BASE_URL}`);
    });
}

module.exports = app;
