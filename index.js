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
        'Referer': BASE_URL + '/'
    },
    timeout: 15000
});

const extractId = (url) => {
    if (!url) return null;
    const matches = url.match(/-(\d+)\/?$/);
    return matches ? matches[1] : null;
};

const parseCard = ($, element) => {
    try {
        const anchor = $(element);
        let url = anchor.attr('href') || '';
        if (url && !url.startsWith('http')) {
            if (url.startsWith('//')) url = 'https:' + url;
            else url = BASE_URL + (url.startsWith('/') ? '' : '/') + url;
        }

        let thumb = anchor.find('img').attr('src') || anchor.find('img').attr('data-src') || anchor.find('img').attr('data-lazy-src');
        if (!thumb) {
            // Tentar pegar de um elemento próximo se for um botão
            thumb = anchor.parent().find('img').attr('src') || anchor.parent().find('img').attr('data-src');
        }
        
        if (thumb && !thumb.startsWith('http')) {
             if (thumb.startsWith('//')) thumb = 'https:' + thumb;
             else thumb = BASE_URL + (thumb.startsWith('/') ? '' : '/') + thumb;
        }

        let titleText = anchor.text().trim();
        if (titleText === 'Assistir Série' || titleText === 'Assistir Filme') {
             // Tentar pegar o título do atributo alt da imagem ou do texto do pai
             titleText = anchor.parent().find('img').attr('alt') || anchor.parent().text().trim();
        }

        let parts = titleText.split('\n').map(p => p.trim()).filter(p => p);
        const title = parts[0] ? parts[0].replace('Assistir ', '').replace(' Online Gratis', '') : '';
        const year = parts[1] || '';
        const quality = anchor.find('.capa-quali').text() || '';

        return { id: extractId(url), title, url, thumb, year, quality };
    } catch (e) { return null; }
};

app.get('/', (req, res) => {
    res.json({
        status: "Online",
        msg: "API PobreflixTV.food - Adaptada",
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
            movies: { releases: [] },
            series: { releases: [] }
        };

        const seen = new Set();
        $('a[href*="/assistir-"]').each((i, el) => {
            const item = parseCard($, el);
            if (item && item.id && !seen.has(item.id)) {
                seen.add(item.id);
                if (item.url.includes('series-online') || item.title.toLowerCase().includes('série') || item.url.includes('assistir-spider-noir')) {
                    data.series.releases.push(item);
                } else {
                    data.movies.releases.push(item);
                }
            }
        });

        data.movies.releases = data.movies.releases.slice(0, 20);
        data.series.releases = data.series.releases.slice(0, 20);

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
        const seen = new Set();

        $('a[href*="/assistir-"]').each((i, el) => {
            const item = parseCard($, el);
            if (item && item.id && !seen.has(item.id)) {
                seen.add(item.id);
                results.push(item);
            }
        });

        res.json({ results });
    } catch (error) {
        res.status(500).json({ error: "Erro na busca" });
    }
});

app.get('/v1/info', async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + (url.startsWith('/') ? '' : '/') + url;

    try {
        const response = await api.get(url);
        const $ = cheerio.load(response.data);

        const title = $('h1').first().text().trim() || $('.titulo').text().trim();
        const thumb = $('.vb_image_container img').attr('src') || $('img[alt*="Assistir"]').attr('src');
        const desc = $('.sinopse').text().trim() || $('div:contains("Durante uma viagem")').last().text().trim();
        const yearMatch = $('body').text().match(/\b(19|20)\d{2}\b/);
        const year = yearMatch ? yearMatch[0] : "";
        const imdb = $('a[href*="imdb.com"]').text().trim();

        const isSeries = $('h2:contains("SELECIONE A TEMPORADA")').length > 0 || url.includes('series-online') || $('.ipsTabs').length > 0;

        const result = {
            id: extractId(url),
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
            $('ul li a[href*="/assistir-"]').each((index, element) => {
                const epUrl = $(element).attr('href');
                const epName = $(element).text().trim();
                
                if (epUrl && epUrl !== url && epUrl.includes('x')) {
                    result.episodes.push({
                        name: epName,
                        player_id: extractId(epUrl),
                        url: epUrl
                    });
                }
            });
        } else {
            result.watch_link = `${req.protocol}://${req.get('host')}/v1/watch/${result.id}`;
        }

        res.json(result);
    } catch (error) {
        res.status(500).json({ error: "Erro ao pegar detalhes" });
    }
});

app.get('/v1/watch/:id', async (req, res) => {
    const { id } = req.params;
    const sv = req.query.sv || 'filemoon';

    if (!id) return res.send("ID Inválido");

    const embedUrl = `${BASE_URL}/e/getembed.php?sv=${sv}&id=${id}&token=f3981b7851ab13ac1e33`;

    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="referrer" content="no-referrer" />
    <title>Player</title>
    <style>
        html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
        iframe { width: 100%; height: 100%; border: none; }
    </style>
</head>
<body>
    <iframe
        src="${embedUrl}"
        allowfullscreen
        scrolling="no"
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        referrerpolicy="no-referrer"
    ></iframe>
</body>
</html>`;

    res.send(html);
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
