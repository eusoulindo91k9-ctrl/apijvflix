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

const BASE_URL = 'https://www.pobreflixtv.food';

const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://www.pobreflixtv.food/'
    },
    timeout: 15000
});

const TOKEN = 'f3981b7851ab13ac1e33';

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

// --- ROTA DE ASSISTIR ---
// O :id aqui deve ser o video_id (extraído do C_Video), não o ID da URL
app.get('/v1/watch/:id', (req, res) => {
    const { id } = req.params;
    const sv = req.query.sv || 'mixdrop';

    if (!id) return res.send("ID Inválido");

    // Embed direto usando o getembed.php com o ID real do C_Video
    const embedUrl = `${BASE_URL}/e/getembed.php?sv=${sv}&id=${id}&token=${TOKEN}`;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="origin" />
    <title>Player</title>
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; display: block; }
    </style>
</head>
<body>
    <iframe
        src="${embedUrl}"
        allowfullscreen
        scrolling="no"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="origin"
    ></iframe>
</body>
</html>`;

    res.send(html);
});

// Rota auxiliar: resolve video_id a partir da URL da página e redireciona pro player
app.get('/v1/play', async (req, res) => {
    let { url, sv } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    const server = sv || 'mixdrop';

    try {
        const response = await api.get(url);
        const videoId = extractVideoId(response.data);

        if (!videoId) return res.status(404).json({ error: "video_id não encontrado na página" });

        const embedUrl = `${BASE_URL}/e/getembed.php?sv=${server}&id=${videoId}&token=${TOKEN}`;

        const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="origin" />
    <title>Player</title>
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; display: block; }
    </style>
</head>
<body>
    <iframe
        src="${embedUrl}"
        allowfullscreen
        scrolling="no"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="origin"
    ></iframe>
</body>
</html>`;

        res.send(html);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao resolver video_id" });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}

module.exports = app;
