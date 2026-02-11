const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
// A Vercel injeta a porta automaticamente, mas definimos 3000 para testes locais
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// URL Base
const BASE_URL = 'https://www.pobreflixtv.uk';

// Configuração do Axios
const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
    },
    timeout: 10000 // Timeout de 10s para não estourar o limite da Vercel (Hobby plan)
});

// --- FUNÇÃO AUXILIAR ---
const parseItem = ($, element) => {
    try {
        const anchor = $(element).find('a');
        const url = anchor.attr('href') || '';
        const thumbContainer = $(element).find('.vb_image_container');
        
        let thumb = thumbContainer.attr('data-background-src');
        if (!thumb) {
            const style = thumbContainer.attr('style');
            if (style && style.includes('url(')) {
                const match = style.match(/url\(['"]?(.*?)['"]?\)/);
                if (match) thumb = match[1];
            }
        }
        // Correção de URL relativa
        if (thumb && !thumb.startsWith('http')) {
            thumb = BASE_URL + thumb;
        }

        const title = $(element).find('.caption').clone().children().remove().end().text().trim();
        const year = $(element).find('.caption .y').text().trim();
        const duration = $(element).find('.caption .t').text().trim();
        const audioType = $(element).find('.capa-audio').text().trim();
        const quality = $(element).find('.capa-quali').text().trim();

        // Extrair ID
        let id = null;
        if (url) {
            // Regex ajustado para pegar ID numérico no final da URL antes ou depois da barra
            const matches = url.match(/-(\d+)\/?$/);
            if (matches) id = matches[1];
        }

        return { id, title, url, thumb, year, duration, tags: { audio: audioType, quality: quality } };
    } catch (e) {
        return null;
    }
};

// --- ROTA RAIZ (Para verificar se está online) ---
app.get('/', (req, res) => {
    res.json({ status: "API Online", maintainer: "pBeast-Games Parser" });
});

// --- ENDPOINT 1: SEARCH ---
app.get('/v1/search', async (req, res) => {
    const query = req.query.s;
    if (!query) return res.status(400).json({ error: "Use ?s=NomeDoFilme" });

    try {
        const searchUrl = `/pesquisar/?p=${encodeURIComponent(query)}`;
        const response = await api.get(searchUrl);
        const $ = cheerio.load(response.data);
        const results = [];

        // Tenta seletor padrão #collview
        $('#collview').each((i, el) => {
            const item = parseItem($, el);
            if (item && item.id) results.push(item);
        });

        // Tenta seletor de lista caso o layout mude na busca
        if (results.length === 0) {
             $('.ipsStreamItem_container').each((i, el) => {
                 // Lógica de fallback simples se necessário
             });
        }

        res.json({ query, count: results.length, results });
    } catch (error) {
        res.status(500).json({ error: "Erro na busca ou timeout." });
    }
});

// --- ENDPOINT 2: RECOMMENDS ---
app.get('/v1/get/recommeds', async (req, res) => {
    try {
        const response = await api.get('/');
        const $ = cheerio.load(response.data);

        const data = {
            movies: { releases: [], trending: [] },
            series: { releases: [], trending: [] }
        };

        const moviesContainer = $('.cWidgetContainer').eq(0);
        moviesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.movies.releases.push(parseItem($, el)));
        moviesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.movies.trending.push(parseItem($, el)));

        const seriesContainer = $('.cWidgetContainer').eq(1);
        seriesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.series.releases.push(parseItem($, el)));
        seriesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.series.trending.push(parseItem($, el)));

        // Limpeza de nulos
        data.movies.releases = data.movies.releases.filter(i => i && i.id);
        data.movies.trending = data.movies.trending.filter(i => i && i.id);
        data.series.releases = data.series.releases.filter(i => i && i.id);
        data.series.trending = data.series.trending.filter(i => i && i.id);

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: "Erro ao pegar recomendações." });
    }
});

// --- ENDPOINT 3: GET PLAYER ---
app.get('/v1/get-player/:id', (req, res) => {
    const { id } = req.params;
    const { sv } = req.query;
    if (!id) return res.status(400).json({ error: "ID obrigatório" });

    const server = sv || 'filemoon';
    // URL gerada
    const playerUrl = `${BASE_URL}/e/getplay.php?id=${id}&sv=${server}`;

    res.json({
        id,
        server,
        url: playerUrl,
        iframe: `<iframe src="${playerUrl}" scrolling="no" frameborder="0" allowfullscreen></iframe>`
    });
});

// --- IMPORTANTE PARA VERCEL ---
// Se estiver rodando localmente (node index.js), ele inicia o servidor.
// Se estiver na Vercel, ele exporta o app para a Vercel gerenciar.
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running locally on port ${PORT}`);
    });
}

module.exports = app;
