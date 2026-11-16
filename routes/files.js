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

// Follow-up 1: foto de profissional guardada no banco. Pública (aparece na página /b/:slug), mas só
// com o hash da versão atual; tipo validado no upload; sem sniffing e sem execução.
router.get('/professional-photo/:id/:hash', async (req, res) => {
    try {
        if (!/^\d{1,10}$/.test(req.params.id) || !/^[a-f0-9]{16}$/.test(req.params.hash)) return res.status(404).send({ message: 'Não encontrado' });
        const photo = await require('../services/professionalsService').photo(Number(req.params.id), req.params.hash);
        if (!photo) return res.status(404).send({ message: 'Não encontrado' });
        res.set({
            'Content-Type': photo.mime, 'Cache-Control': 'public, max-age=31536000, immutable',
            'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
            'Content-Disposition': 'inline',
        });
        return res.send(photo.bytes);
    } catch (error) {
        return res.status(404).send({ message: 'Não encontrado' });
    }
});

module.exports = router;
