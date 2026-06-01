const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const NEW_BASE = 'https://apijvflix-1.onrender.com';

app.use(cors());
app.use(express.json());

// Redireciona tudo para a nova API, preservando path + query string
app.use((req, res) => {
    const target = NEW_BASE + req.originalUrl;
    res.redirect(302, target);
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor rodando na porta ${PORT} — redirecionando para ${NEW_BASE}`);
    });
}

module.exports = app;
