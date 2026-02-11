const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- CONFIGURAÇÕES ---
const BASE_URL = 'https://www.pobreflixtv.uk';

const api = axios.create({
    baseURL: BASE_URL,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Referer': 'https://www.google.com/'
    },
    timeout: 15000 // Aumentei um pouco para garantir leitura de listas grandes
});

// --- HELPER FUNCTIONS ---

// Extrai ID numérico de URLs (ex: ...-dublado-12345/ -> 12345)
const extractId = (url) => {
    if (!url) return null;
    const matches = url.match(/-(\d+)\/?$/);
    return matches ? matches[1] : null;
};

// Limpa texto
const cleanText = (text) => text ? text.replace(/\n/g, '').trim() : '';

// Parser genérico de Card (Usado na Home e Busca)
const parseCard = ($, element) => {
    try {
        const anchor = $(element).find('a');
        let url = anchor.attr('href') || '';
        
        // Corrige URL se for relativa
        if (url && !url.startsWith('http')) url = BASE_URL + url;

        const thumbContainer = $(element).find('.vb_image_container');
        let thumb = thumbContainer.attr('data-background-src');
        
        // Fallback para style background
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

        return {
            id: extractId(url), // ID da página (não do player)
            title,
            url,
            thumb,
            year,
            quality
        };
    } catch (e) { return null; }
};

// --- ROTAS ---

// 1. Rota de Boas Vindas / Status
app.get('/', (req, res) => {
    res.json({
        status: "Online",
        endpoints: {
            home: "/v1/get/recommeds",
            search: "/v1/search?s=nome_do_filme",
            info: "/v1/info?url=link_do_pobreflix",
            watch: "/v1/watch/:id"
        }
    });
});

// 2. Rota de Home (Recomendados)
app.get('/v1/get/recommeds', async (req, res) => {
    try {
        const response = await api.get('/');
        const $ = cheerio.load(response.data);

        const data = {
            movies: { releases: [], trending: [] },
            series: { releases: [], trending: [] }
        };

        // Container de Filmes (Geralmente o primeiro widget)
        const moviesContainer = $('.cWidgetContainer').eq(0);
        moviesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.movies.releases.push(parseCard($, el)));
        moviesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.movies.trending.push(parseCard($, el)));

        // Container de Séries (Geralmente o segundo widget)
        const seriesContainer = $('.cWidgetContainer').eq(1);
        seriesContainer.find('.vbPanel-container[class*="releases_"] #collview').each((i, el) => data.series.releases.push(parseCard($, el)));
        seriesContainer.find('.vbPanel-container[class*="trending_"] #collview').each((i, el) => data.series.trending.push(parseCard($, el)));

        // Remove nulos
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

// 3. Rota de Busca
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

// 4. Rota de Detalhes (Info + Episódios)
// URL Exemplo: /v1/info?url=https://www.pobreflixtv.uk/assistir-beast-games-dublado-2024-45343/
app.get('/v1/info', async (req, res) => {
    let { url, season } = req.query;
    
    if (!url) return res.status(400).json({ error: "URL obrigatória" });
    if (!url.startsWith('http')) url = BASE_URL + url;

    try {
        // Adiciona parametro de temporada se existir
        const fetchUrl = season ? `${url}?temporada=${season}` : url;
        
        const response = await api.get(fetchUrl);
        const $ = cheerio.load(response.data);

        // --- DETECÇÃO ---
        const listagem = $('#listagem');
        const breadcrumb = $('.breadcrumb').text();
        const isSeries = listagem.length > 0 || breadcrumb.includes('Séries') || breadcrumb.includes('Series');

        // --- DADOS GERAIS ---
        const title = $('.titulo').text().trim();
        const thumb = $('.vb_image_container').attr('data-background-src');
        const desc = $('.sinopse').text().replace('Ler mais...', '').trim();
        const year = $('.infos span').eq(1).text().trim();
        const imdb = $('.imdb').text().trim();

        const result = {
            id: extractId(url), // ID da página principal
            title,
            is_series: isSeries,
            year,
            imdb,
            thumb,
            description: desc,
            episodes: [],
            watch_link: null // Será preenchido se for filme
        };

        if (isSeries) {
            // --- LÓGICA DE SÉRIE ---
            const episodes = [];
            
            $('#listagem li').each((index, element) => {
                const linkTag = $(element).find('a').first();
                const epUrl = linkTag.attr('href');
                const epName = linkTag.text().trim(); // "Episódio 01"
                
                // O site usa data-id="11" para Temp 1 Ep 1, "12" para Temp 1 Ep 2.
                // Vamos usar isso para ordenar.
                const sortId = parseInt($(element).attr('data-id')) || index;

                if (epUrl) {
                    episodes.push({
                        name: epName,
                        player_id: extractId(epUrl), // ID importante para o player
                        url: epUrl,
                        order: sortId
                    });
                }
            });

            // Ordena do menor para o maior (Ep 1, Ep 2...)
            result.episodes = episodes.sort((a, b) => a.order - b.order);
        } else {
            // --- LÓGICA DE FILME ---
            // Se for filme, o ID para assistir geralmente é o mesmo da URL da página
            // ou extraído de um botão específico. No Pobreflix, costuma ser o ID da URL.
            result.watch_link = `${req.protocol}://${req.get('host')}/v1/watch/${result.id}`;
        }

        res.json(result);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Erro ao pegar detalhes" });
    }
});

// 5. Rota de Assistir (Retorna Iframe/HTML)
// Exemplo: /v1/watch/45344
app.get('/v1/watch/:id', (req, res) => {
    const { id } = req.params;
    // Padrão filemoon, mas permite mudar via query param ?sv=streamtape
    const sv = req.query.sv || 'filemoon'; 

    if (!id) return res.send("ID Inválido");

    const embedUrl = `${BASE_URL}/e/getplay.php?id=${id}&sv=${sv}`;

    // HTML limpo que ocupa 100% da tela
    const html = `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Player</title>
        <style>
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
            iframe { width: 100%; height: 100%; border: none; }
        </style>
    </head>
    <body>
        <iframe src="${embedUrl}" allowfullscreen scrolling="no"></iframe>
    </body>
    </html>
    `;

    res.send(html);
});

// --- EXPORTAÇÃO (IMPORTANTE PARA VERCEL) ---
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT}`);
    });
}

module.exports = app;
