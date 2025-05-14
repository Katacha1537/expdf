const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
    ]
});

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const upload = multer({
    dest: '/tmp/uploads/',
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos PDF são permitidos.'));
        }
    }
});

async function extrairQuestoes(pdfPath, questoesSelecionadas) {
    try {
        const data = await fs.readFile(pdfPath);
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdf = await loadingTask.promise;

        const paginas = pdf.numPages;
        const todasPaginas = [];

        for (let i = 1; i <= paginas; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const texto = content.items.map(item => item.str).join(' ');
            todasPaginas.push({ pagina: i, texto });
        }

        const questoesExtraidas = [];

        for (let i = 0; i < questoesSelecionadas.length; i++) {
            const questaoAtual = questoesSelecionadas[i];
            const numeroAtual = parseInt(questaoAtual.match(/\d+/)[0]);
            const questaoProxima = `Question #${numeroAtual + 1}`;

            let capturando = false;
            const blocos = [];

            for (const pagina of todasPaginas) {
                const { texto } = pagina;

                if (texto.includes(questaoAtual)) {
                    capturando = true;
                }

                if (capturando) {
                    blocos.push(pagina);
                }

                if (capturando && texto.includes(questaoProxima)) {
                    blocos.pop();
                    break;
                }
            }

            questoesExtraidas.push(...blocos);
        }

        const unicas = new Map();
        questoesExtraidas.forEach(p => unicas.set(p.pagina, p));

        return Array.from(unicas.values());
    } catch (error) {
        logger.error('Erro ao extrair questões:', error);
        throw new Error('Falha ao processar o PDF.');
    }
}

async function criarNovoPdf(pdfPath, questoesExtraidas, outputPath) {
    try {
        const pdfOriginalBytes = await fs.readFile(pdfPath);
        const pdfOriginal = await PDFDocument.load(pdfOriginalBytes);
        const novoPdf = await PDFDocument.create();

        for (const q of questoesExtraidas) {
            const [paginaCopiada] = await novoPdf.copyPages(pdfOriginal, [q.pagina - 1]);
            novoPdf.addPage(paginaCopiada);
        }

        const novoPdfBytes = await novoPdf.save();
        await fs.writeFile(outputPath, novoPdfBytes);
    } catch (error) {
        logger.error('Erro ao criar novo PDF:', error);
        throw new Error('Falha ao gerar o PDF de saída.');
    }
}

app.post('/extrair-questoes', upload.single('pdf'), async (req, res) => {
    const arquivoPDF = req.file;
    const outputPath = path.join('/tmp', `resultado-${Date.now()}.pdf`);

    try {
        const questoesSelecionadas = req.body.questoes
            ? req.body.questoes
                .split(',')
                .map(num => num.trim())
                .filter(Boolean)
                .map(num => `Question #${num}`)
            : [];

        if (!arquivoPDF || questoesSelecionadas.length === 0) {
            return res.status(400).json({ error: 'Arquivo PDF e lista de questões são obrigatórios.' });
        }

        const questoesExtraidas = await extrairQuestoes(arquivoPDF.path, questoesSelecionadas);

        if (questoesExtraidas.length === 0) {
            return res.status(404).json({ message: 'Nenhuma questão encontrada.' });
        }

        await criarNovoPdf(arquivoPDF.path, questoesExtraidas, outputPath);

        res.download(outputPath, 'questoesExtraidas.pdf', async (err) => {
            try {
                await fs.unlink(arquivoPDF.path);
                await fs.unlink(outputPath);
            } catch (cleanupError) {
                logger.error('Erro ao limpar arquivos:', cleanupError);
            }

            if (err) {
                logger.error('Erro ao enviar arquivo:', err);
            }
        });
    } catch (error) {
        logger.error('Erro ao processar PDF:', error);
        try {
            if (arquivoPDF?.path) await fs.unlink(arquivoPDF.path);
            if (await fs.access(outputPath).then(() => true).catch(() => false)) await fs.unlink(outputPath);
        } catch (cleanupError) {
            logger.error('Erro ao limpar arquivos após erro:', cleanupError);
        }
        res.status(500).json({ error: 'Erro interno ao processar o PDF.' });
    }
});

app.get('/', (req, res) => {
    res.json({ success: true });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'Arquivo muito grande. O tamanho máximo é 100 MB.' });
        }
        return res.status(400).json({ error: err.message });
    }
    logger.error('Erro no servidor:', err);
    res.status(500).json({ error: 'Erro interno no servidor.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logger.info(`Servidor rodando na porta ${PORT}`);
});

process.on('SIGTERM', async () => {
    logger.info('Recebido SIGTERM. Encerrando servidor...');
    await new Promise(resolve => app.close(resolve));
    process.exit(0);
});