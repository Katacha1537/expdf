const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

const app = express();

// Configurar multer para usar /tmp (sistema de arquivos temporário da Vercel)
const upload = multer({ dest: '/tmp/uploads/' });

// Configurar CORS (restrinja a origens específicas em produção)
app.use(cors());
app.use(express.json());

// Função para extrair questões do PDF
async function extrairQuestoes(pdfPath, questoesSelecionadas) {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
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
                blocos.pop(); // remove página da próxima questão
                break;
            }
        }

        questoesExtraidas.push(...blocos);
    }

    const unicas = new Map();
    questoesExtraidas.forEach(p => unicas.set(p.pagina, p));

    return Array.from(unicas.values());
}

// Função para criar novo PDF
async function criarNovoPdf(pdfPath, questoesExtraidas, outputPath) {
    const pdfOriginalBytes = fs.readFileSync(pdfPath);
    const pdfOriginal = await PDFDocument.load(pdfOriginalBytes);
    const novoPdf = await PDFDocument.create();

    for (const q of questoesExtraidas) {
        const [paginaCopiada] = await novoPdf.copyPages(pdfOriginal, [q.pagina - 1]);
        novoPdf.addPage(paginaCopiada);
    }

    const novoPdfBytes = await novoPdf.save();
    fs.writeFileSync(outputPath, novoPdfBytes);
}

// Endpoint para extrair questões
app.post('/extrair-questoes', upload.single('pdf'), async (req, res) => {
    try {
        const questoesSelecionadas = req.body.questoes
            ? req.body.questoes
                .split(',')
                .map(num => num.trim())
                .filter(Boolean)
                .map(num => `Question #${num}`)
            : [];
        const arquivoPDF = req.file;

        if (!arquivoPDF || questoesSelecionadas.length === 0) {
            return res.status(400).json({ error: 'Arquivo PDF e lista de questões são obrigatórios.' });
        }

        // Usar /tmp para o arquivo de saída
        const outputPath = path.join('/tmp', 'resultado.pdf');

        const questoesExtraidas = await extrairQuestoes(arquivoPDF.path, questoesSelecionadas);

        if (questoesExtraidas.length === 0) {
            return res.status(404).json({ message: 'Nenhuma questão encontrada.' });
        }

        await criarNovoPdf(arquivoPDF.path, questoesExtraidas, outputPath);

        res.download(outputPath, 'questoesExtraidas.pdf', () => {
            // Limpeza dos arquivos temporários
            try {
                fs.unlinkSync(arquivoPDF.path);
                fs.unlinkSync(outputPath);
            } catch (err) {
                console.error('Erro ao limpar arquivos:', err);
            }
        });
    } catch (error) {
        console.error('Erro ao processar PDF:', error);
        res.status(500).json({ error: 'Erro interno ao processar o PDF.' });
    }
});

// Endpoint de teste
app.get('/extrair', (req, res) => {
    res.json({ success: true });
});

// Middleware de erro global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Erro interno no servidor.' });
});

// Exportar para Vercel
module.exports = app;