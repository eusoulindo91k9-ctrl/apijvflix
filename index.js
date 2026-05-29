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

const TOKEN = 'f3981b7851ab13ac1e33';



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

    const matches = url.match(/-(\d+)\/?$/);

    return matches ? matches[1] : null;

};



const cleanText = (text) => text ? text.replace(/\n/g, '').trim() : '';



const extractVideoId = (html) => {

    const match = html.match(/C_Video\(['"]([\w\d]+)['"]\s*,\s*['"]mixdrop['"]/i);

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



// --- MIXDROP: extração de FID e URL ---



const getMixdropFID = (url) => {

    if (!url) return null;

    const m = url.match(/(?:mixdrop\.[a-z]+|mdy48tn97\.com|mdbekjwqa\.pw|mdfx9dc8n\.net|mdzsmutpcvykb\.net)\/(?:f|e)\/([a-z0-9]+)/i);

    return m ? m[1] : null;

};



const extractMixdropUrl = (html) => {

    const MD = '(?:mixdrop\\.[a-z]+|mdy48tn97\\.com|mdbekjwqa\\.pw|mdfx9dc8n\\.net|mdzsmutpcvykb\\.net)';

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



// --- GETPLAY: segue getplay.php e retorna URL do mixdrop ---



const followGetplay = async (videoId, sv = 'mixdrop') => {

    const getplayUrl = `${BASE_URL}/e/getplay.php?id=${videoId}&sv=${sv}&token=${TOKEN}`;



    const resp = await axios.get(getplayUrl, {

        headers: { ...mixdropHeaders, 'Referer': `${BASE_URL}/` },

        maxRedirects: 0,

        timeout: 15000,

        validateStatus: (status) => status < 500,

    });



    // Caso 1: 302 com Location header

    const location = resp.headers?.location;

    if (location) {

        const url = location.startsWith('//') ? 'https:' + location : location;

        if (getMixdropFID(url)) return url;

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



    // Caso 2: HTML com link do mixdrop

    if (typeof resp.data === 'string') {

        const fromHtml = extractMixdropUrl(resp.data);

        if (fromHtml) return fromHtml;

    }



    // Caso 3: JSON

    if (resp.data?.url) return resp.data.url;

    if (resp.data?.link) return resp.data.link;



    throw new Error(`getplay.php nao retornou URL do mixdrop. Status: ${resp.status}. Resposta: ${String(resp.data).slice(0, 300)}`);

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

    const fileInfo = json.result[0];

    if (fileInfo.deleted) throw new Error('Arquivo deletado no mixdrop');



    // 2. Acessa a página embed e pega cookies

    const embedUrl = `https://mixdrop.top/e/${fid}`;

    const pageResp = await axios.get(embedUrl, {

        headers: { ...mixdropHeaders, 'Referer': 'https://mixdrop.top/' },

        timeout: 15000

    });



    const rawCookies = pageResp.headers['set-cookie'];

    let cookieString = '';

    if (rawCookies) {

        cookieString = rawCookies.map(c => c.split(';')[0]).join('; ');

    }



    let html = pageResp.data;



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

            html = continueResp.data;

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

        msg: "API JVFlix",

        endpoints: {

            home: "/v1/get/recommeds",

            search: "/v1/search?s=nome",

            info: "/v1/info?url=link_completo",

            watch: "/v1/watch/:id",

            stream: "/api/stream/:sessionId"

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



        const videoId = extractVideoId(response.data);

        const pageId = extractId(url);



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

            const episodes = [];

            $('#listagem li').each((index, element) => {

                const linkTag = $(element).find('a').first();

                const epUrl = linkTag.attr('href');

                const epName = linkTag.text().trim();

                const sortId = parseInt($(element).attr('data-id')) || index;



                if (epUrl) {

                    episodes.push({

                        name: epName,

                        player_id: extractId(epUrl),

                        url: epUrl,

                        order: sortId

                    });

                }

            });

            result.episodes = episodes.sort((a, b) => a.order - b.order);

        } else {

            const watchId = videoId || pageId;

            result.watch_link = `${req.protocol}://${req.get('host')}/v1/watch/${watchId}`;

        }



        res.json(result);

    } catch (error) {

        console.error(error);

        res.status(500).json({ error: "Erro ao pegar detalhes" });

    }

});



// --- ROTA WATCH: getplay.php → mixdrop → unpack → proxy ---



app.get('/v1/watch/:id', async (req, res) => {

    const { id } = req.params;

    const sv = req.query.sv || 'mixdrop';

    const asJson = req.query.json === '1';



    if (!id) return res.status(400).json({ error: "ID inválido" });



    try {

        // 1. getplay.php → URL do mixdrop

        const playerUrl = await followGetplay(id, sv);

        const fid = getMixdropFID(playerUrl);

        if (!fid) throw new Error('FID não encontrado: ' + playerUrl);



        // 2. Resolve MP4 + cookies

        const { directUrl, cookies, referer, title } = await resolveMixdrop(fid);



        // 3. Salva sessão para o proxy de stream

        const sessionId = Math.random().toString(36).substring(2, 15);

        videoSessions.set(sessionId, { mp4Url: directUrl, cookies, referer });



        const streamUrl = `/api/stream/${sessionId}`;

        const host = `https://apijvflix.vercel.app`;



        // Retorna JSON com as informações ou redireciona pro stream

        return res.json({

            title,

            fid,

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

    let { url, sv } = req.query;

    if (!url) return res.status(400).json({ error: "URL obrigatória" });

    if (!url.startsWith('http')) url = BASE_URL + url;



    const server = sv || 'mixdrop';



    try {

        const response = await api.get(url);

        const videoId = extractVideoId(response.data);

        if (!videoId) return res.status(404).json({ error: "video_id não encontrado na página" });



        const playerUrl = await followGetplay(videoId, server);

        const fid = getMixdropFID(playerUrl);

        if (!fid) throw new Error('FID não encontrado: ' + playerUrl);



        const { directUrl, cookies, referer, title } = await resolveMixdrop(fid);



        const sessionId = Math.random().toString(36).substring(2, 15);

        videoSessions.set(sessionId, { mp4Url: directUrl, cookies, referer });



        const host = `${req.protocol}://${req.get('host')}`;

        return res.json({

            title,

            fid,

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



// --- START ---



if (require.main === module) {

    app.listen(PORT, () => {

        console.log(`Servidor rodando na porta ${PORT}`);

    });

}



module.exports = app;
