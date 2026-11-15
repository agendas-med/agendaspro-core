const express = require('express');
const router = express.Router();
const { signedUrl } = require('../config/s3');

// Objetos do bucket são privados: a API devolve um redirect para uma URL assinada de 5 min.
// A chave contém 128 bits aleatórios (não enumerável), então a rota funciona em <img src>.
router.get(/^\/s3\/(.+)$/, async (req, res) => {
    try {
        const url = await signedUrl(req.params[0]);
        if (!url) return res.status(404).send({ message: 'Não encontrado' });
        res.set('Cache-Control', 'private, max-age=240');
        return res.redirect(302, url);
    } catch (error) {
        return res.status(404).send({ message: 'Não encontrado' });
    }
});

module.exports = router;
