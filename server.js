// TDrive Pro v15.0 - Fandi + Postgres + Email + Demo + Diagnostico + Trava de acesso + Login (vendedor/admin)
// Correcao 26/07/2026: o Chrome do robo nao existia no servidor (ver .puppeteerrc.cjs)
const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
      await pool.query(
            'CREATE TABLE IF NOT EXISTS fichas (' +
            'fandi_id TEXT PRIMARY KEY,' +
            'cpf TEXT,' +
            'name TEXT,' +
            'mother TEXT,' +
            'phone TEXT,' +
            'salary TEXT,' +
            'cep TEXT,' +
            'address TEXT,' +
            'neighborhood TEXT,' +
            'status TEXT,' +
            'fandi_url TEXT,' +
            'erro TEXT,' +
            'criado_em TIMESTAMPTZ DEFAULT NOW()' +
            ')'
            );
await pool.query('ALTER TABLE fichas ADD COLUMN IF NOT EXISTS erro_tecnico TEXT');
await pool.query('ALTER TABLE fichas ADD COLUMN IF NOT EXISTS tentativas INT DEFAULT 0');
await pool.query('CREATE TABLE IF NOT EXISTS loja (id INT PRIMARY KEY, dados TEXT, atualizado_em TIMESTAMPTZ DEFAULT NOW())');
await pool.query(
'CREATE TABLE IF NOT EXISTS leads (' +
'id TEXT PRIMARY KEY,' +
'carro_id TEXT,' +
'modelo TEXT,' +
'preco NUMERIC,' +
'nome TEXT,' +
'telefone TEXT,' +
'entrada NUMERIC,' +
'parcelas INT,' +
'parcela_estimada NUMERIC,' +
'mensagem TEXT,' +
'origem TEXT,' +
'visto BOOLEAN DEFAULT FALSE,' +
'criado_em TIMESTAMPTZ DEFAULT NOW()' +
')'
);

// ---------- LOGIN: tabelas de usuarios e sessoes (v15.0) ----------
await pool.query(
'CREATE TABLE IF NOT EXISTS users (' +
'id TEXT PRIMARY KEY,' +
'nome TEXT,' +
'email TEXT UNIQUE,' +
'senha_hash TEXT,' +
'senha_salt TEXT,' +
'role TEXT,' +
'ativo BOOLEAN DEFAULT TRUE,' +
'criado_em TIMESTAMPTZ DEFAULT NOW(),' +
'ultimo_login TIMESTAMPTZ' +
')'
);
await pool.query(
'CREATE TABLE IF NOT EXISTS sessoes (' +
'token TEXT PRIMARY KEY,' +
'user_id TEXT REFERENCES users(id),' +
'criado_em TIMESTAMPTZ DEFAULT NOW(),' +
'expira_em TIMESTAMPTZ' +
')'
);
      await pool.query(
        'CREATE TABLE IF NOT EXISTS padrao_agregado (' +
        'id INT PRIMARY KEY,' +
        'dados JSONB,' +
        'atualizado_em TIMESTAMPTZ DEFAULT NOW()' +
        ')'
      );
      await pool.query(
        'CREATE TABLE IF NOT EXISTS padrao_execucoes (' +
        'id TEXT PRIMARY KEY,' +
        'quando TIMESTAMPTZ DEFAULT NOW(),' +
        'usuario TEXT,' +
        'quantidade INT' +
        ')'
      );
await pool.query('ALTER TABLE fichas ADD COLUMN IF NOT EXISTS user_id TEXT');

// Cria o primeiro admin automaticamente SE ainda nao existir nenhum admin
// E as variaveis ADMIN_EMAIL / ADMIN_SENHA_INICIAL estiverem configuradas no Render.
// O Vinicios escolhe o email e a senha (nunca o Claude). Depois de criado,
// essas variaveis podem ser removidas do Render sem afetar o login.
try {
var qtdAdmin = await pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin'");
if (qtdAdmin.rows[0].n === 0) {
var emailAdmin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
var senhaAdmin = process.env.ADMIN_SENHA_INICIAL || '';
if (emailAdmin && senhaAdmin) {
var saltA = gerarSalt();
var hashA = hashSenha(senhaAdmin, saltA);
var idA = 'U-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
await pool.query(
'INSERT INTO users (id, nome, email, senha_hash, senha_salt, role) VALUES ($1,$2,$3,$4,$5,\'admin\') ON CONFLICT (email) DO NOTHING',
[idA, 'Vinicios', emailAdmin, hashA, saltA]
);
console.log('[AUTH] Conta admin inicial criada para ' + emailAdmin + '. Pode remover ADMIN_EMAIL/ADMIN_SENHA_INICIAL do Render agora.');
} else {
console.warn('[AUTH] Nenhum admin existe ainda. Defina ADMIN_EMAIL e ADMIN_SENHA_INICIAL no Render (servico web Nova-Pagina) para criar o primeiro admin automaticamente.');
}
}
} catch (eAdmin) {
console.error('[AUTH] erro ao checar/criar admin inicial: ' + eAdmin.message);
}
}

const agente = require('./agente');
app.use(express.json());

// ---------- LOGIN: helpers de senha, cookie e sessao (v15.0) ----------
// Sem pacote novo no package.json (licao ja aprendida: dependencia extra ja
// quebrou deploy antes). Usa so node:crypto (scrypt) e leitura manual do
// cabecalho Cookie (nao precisamos do pacote cookie-parser pra isso).
function gerarSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashSenha(senha, salt) { return crypto.scryptSync(String(senha), salt, 64).toString('hex'); }
function senhaValida(senha, salt, hashGuardado) {
var calc = hashSenha(senha, salt);
var a = Buffer.from(calc, 'hex');
var b = Buffer.from(hashGuardado, 'hex');
if (a.length !== b.length) return false;
return crypto.timingSafeEqual(a, b);
}
function pegaCookie(req, nome) {
var cru = req.headers.cookie || '';
var partes = cru.split(';');
for (var i = 0; i < partes.length; i++) {
var p = partes[i].trim();
var idx = p.indexOf('=');
if (idx === -1) continue;
if (p.slice(0, idx) === nome) { try { return decodeURIComponent(p.slice(idx + 1)); } catch (e) { return null; } }
}
return null;
}
var DURACAO_SESSAO_MS = { admin: 7 * 24 * 60 * 60 * 1000, vendedor: 3 * 24 * 60 * 60 * 1000 };
async function criarSessao(usuario) {
var token = crypto.randomBytes(32).toString('hex');
var duracao = DURACAO_SESSAO_MS[usuario.role] || DURACAO_SESSAO_MS.vendedor;
var expira = new Date(Date.now() + duracao);
await pool.query('INSERT INTO sessoes (token, user_id, expira_em) VALUES ($1,$2,$3)', [token, usuario.id, expira]);
return { token: token, duracaoMs: duracao };
}
async function pegaUsuarioDaSessao(req) {
var token = pegaCookie(req, 'tdrive_sessao');
if (!token) return null;
try {
var r = await pool.query(
'SELECT u.id, u.nome, u.email, u.role, u.ativo, s.expira_em FROM sessoes s JOIN users u ON u.id = s.user_id WHERE s.token = $1',
[token]
);
if (!r.rows.length) return null;
var row = r.rows[0];
if (!row.ativo) return null;
if (new Date(row.expira_em) < new Date()) return null;
return { id: row.id, nome: row.nome, email: row.email, role: row.role };
} catch (e) { return null; }
}
app.use(async function (req, res, next) {
req.usuario = await pegaUsuarioDaSessao(req);
next();
});
function exigeLogin(papeisPermitidos) {
return function (req, res, next) {
if (!req.usuario) return res.status(401).json({ success: false, precisaLogin: true, message: 'Faca login para continuar.' });
if (papeisPermitidos && papeisPermitidos.length && papeisPermitidos.indexOf(req.usuario.role) === -1) {
return res.status(403).json({ success: false, message: 'Seu usuario nao tem permissao para acessar isso.' });
}
next();
};
}

// ---------- PROTECAO DE PAGINAS POR TIPO DE ACESSO (v16.0) ----------
// Antes so o JS do navegador escondia o conteudo chamando /api/me depois da
// pagina carregar. Agora o servidor barra ANTES de mandar qualquer HTML:
// pagina de ferramenta interna sem sessao valida nunca sai do servidor.
// Publico continua livre: loja.html, /carro/:id e as duas telas de login.
var PAGINAS_SO_DONO = ['/roadmap.html'];
var PAGINAS_DONO_E_GESTOR = ['/painel.html', '/admin', '/admin.html', '/projetos.html', '/leads.html', '/crm.html'];
var PAGINAS_LOGIN_QUALQUER = ['/', '/app.html', '/voz.html', '/consorcio.html', '/simulador.html', '/demo-fandi.html', '/vendedor', '/vendedor.html', '/padrao-clientes.html', '/index-old.html'];
app.use(function (req, res, next) {
  if (req.method !== 'GET') return next();
  var caminho = req.path;
  var precisaSoDono = PAGINAS_SO_DONO.indexOf(caminho) !== -1;
  var precisaDonoOuGestor = precisaSoDono || PAGINAS_DONO_E_GESTOR.indexOf(caminho) !== -1;
  var precisaAlgumLogin = precisaDonoOuGestor || PAGINAS_LOGIN_QUALQUER.indexOf(caminho) !== -1;
  if (!precisaAlgumLogin) return next();
  if (!req.usuario) {
    return res.redirect(precisaDonoOuGestor ? '/admin/login' : '/vendedor/login');
  }
  var papel = req.usuario.role;
  var acessoOk = true;
  if (precisaSoDono && papel !== 'admin') acessoOk = false;
  else if (precisaDonoOuGestor && papel !== 'admin' && papel !== 'gestor') acessoOk = false;
  if (!acessoOk) {
    return res.redirect((papel === 'admin' || papel === 'gestor') ? '/admin' : '/vendedor');
  }
  next();
});
app.use(express.static('public', { index: false }));

const EMAIL_DESTINATARIOS = [
      'marcelo.sinhorine@tdrive.com.br',
      'douglas.pinto@tdrive.com.br',
      'eli.psilva@tdrive.com.br',
      'feitoyota@automob.com.br'
      ];

function limparCpf(cpf) {
      return String(cpf || '').replace(/\D/g, '');
}
app.post('/api/submit-fandi', async (req, res) => {
      const dados = req.body;
      const cpfLimpo = limparCpf(dados.cpf);

         if (!dados.cpf || !dados.name) {
               return res.json({ success: false, message: 'CPF ou Nome faltando' });
         }
      if (cpfLimpo.length !== 11) {
            return res.json({ success: false, message: 'CPF invalido: precisa ter 11 digitos (recebido: ' + cpfLimpo.length + ')' });
      }

         try {
               const dup = await pool.query(
                     "SELECT fandi_id, status, criado_em FROM fichas WHERE cpf=$1 AND status IN ('enviando','enviada') AND criado_em > NOW() - INTERVAL '10 minutes' ORDER BY criado_em DESC LIMIT 1",
                     [dados.cpf]
                     );
               if (dup.rows.length) {
                     const existente = dup.rows[0];
                     return res.json({
                           success: false,
                           message: 'Ja existe uma ficha para este CPF enviada ha pouco (status: ' + existente.status + ', ID: ' + existente.fandi_id + '). Aguarde antes de reenviar para evitar duplicidade no Fandi.'
                     });
               }
         } catch (err) {
               console.error('[DB ERRO ao checar duplicidade]', err.message);
         }

         const fandi_id = 'PROP-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
      try {
            await pool.query(
                  'INSERT INTO fichas (fandi_id, cpf, name, mother, phone, salary, cep, address, neighborhood, status, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'enviando\',$10)',
                  [fandi_id, dados.cpf, dados.name, dados.mother, dados.phone, String(dados.salary || ''), dados.cep, dados.address, dados.neighborhood, (req.usuario && req.usuario.id) || null]
                  );
            res.json({ success: true, fandi_id: fandi_id, message: 'Ficha recebida, enviando ao Fandi...' });
            processarFicha(fandi_id, dados);
      } catch (err) {
            console.error('[DB ERRO ao salvar ficha]', err.message);
            res.json({ success: false, message: 'Erro ao salvar ficha: ' + err.message });
      }
});
// ---------- TRAVA DE ACESSO (v13.2 - agora FECHA quando falta o PIN) ----------
// ATE 26/07/2026 a trava era "aberta por padrao": sem TDRIVE_PIN o /api/fichas
// respondia para qualquer pessoa da internet - e la tem dado de cliente real.
// Um erro de configuracao virava vazamento silencioso.
// AGORA e o contrario: sem PIN configurado, as rotas com dado de cliente NEGAM
// acesso e explicam o que fazer. Erro de configuracao vira erro visivel, nunca vazamento.
const PIN = (process.env.TDRIVE_PIN || '').trim();
// Ajuda a achar variavel criada com nome errado ou no servico errado do Render.
// Mostra so os NOMES parecidos, NUNCA o valor.
const NOMES_PARECIDOS = Object.keys(process.env).filter(function (k) { return /pin|tdrive/i.test(k); });
if (!PIN) {
  console.warn('[SEGURANCA] TDRIVE_PIN nao chegou no servidor. Rotas com dado de cliente estao BLOQUEADAS. Nomes parecidos vistos: ' + JSON.stringify(NOMES_PARECIDOS));
}
function exigePin(req, res, next) {
  if (!PIN) {
    return res.status(503).json({
      success: false,
      semPermissao: true,
      pinAusente: true,
      message: 'Esta rota tem dado de cliente e esta BLOQUEADA porque a variavel TDRIVE_PIN nao chegou no servidor. Confira no Render: servico web Nova-Pagina (nao o banco) > Environment > TDRIVE_PIN > Save changes (o servico reinicia sozinho).',
      variaveisParecidas: NOMES_PARECIDOS
    });
  }
  const enviado = (req.get('x-tdrive-pin') || '').trim();
  if (enviado === PIN) return next();
  return res.status(401).json({ success: false, semPermissao: true, message: 'Acesso protegido. Informe o PIN.' });
}

// ---------- LOGIN: rotas (v15.0) ----------
// Vendedor e admin sao contas separadas na mesma tabela users (campo role).
// Nao existe cadastro publico: so o admin cria conta de vendedor (Bloco B,
// decisao registrada no Gist: sem servico de e-mail configurado ainda,
// o admin cria a conta e passa a senha inicial pro vendedor).
app.post('/api/login', async function (req, res) {
var email = String((req.body && req.body.email) || '').trim().toLowerCase();
var senha = String((req.body && req.body.senha) || '');
if (!email || !senha) return res.json({ success: false, message: 'Preencha email e senha.' });
try {
var r = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
if (!r.rows.length) return res.json({ success: false, message: 'Email ou senha incorretos.' });
var u = r.rows[0];
if (!u.ativo) return res.json({ success: false, message: 'Este usuario esta desativado. Fale com o administrador.' });
if (!senhaValida(senha, u.senha_salt, u.senha_hash)) return res.json({ success: false, message: 'Email ou senha incorretos.' });
var sessao = await criarSessao(u);
await pool.query('UPDATE users SET ultimo_login=NOW() WHERE id=$1', [u.id]);
res.setHeader('Set-Cookie', 'tdrive_sessao=' + sessao.token + '; HttpOnly; Path=/; Max-Age=' + Math.floor(sessao.duracaoMs / 1000) + '; SameSite=Lax');
res.json({ success: true, usuario: { id: u.id, nome: u.nome, email: u.email, role: u.role } });
} catch (err) {
res.json({ success: false, message: 'Erro ao entrar: ' + err.message });
}
});

app.post('/api/logout', async function (req, res) {
var token = pegaCookie(req, 'tdrive_sessao');
if (token) { try { await pool.query('DELETE FROM sessoes WHERE token=$1', [token]); } catch (e) {} }
res.setHeader('Set-Cookie', 'tdrive_sessao=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
res.json({ success: true });
});

app.get('/api/me', function (req, res) {
res.json({ success: true, usuario: req.usuario || null });
});

// Admin gerencia contas de vendedor. Nunca devolve senha_hash/senha_salt.
app.post('/api/admin/vendedores', exigeLogin(['admin', 'gestor']), async function (req, res) {
  var nome = String((req.body && req.body.nome) || '').trim();
  var email = String((req.body && req.body.email) || '').trim().toLowerCase();
  var senha = String((req.body && req.body.senha) || '');
  var papel = String((req.body && req.body.papel) || 'vendedor').trim().toLowerCase();
  if (papel !== 'vendedor' && papel !== 'gestor') papel = 'vendedor';
  if (papel === 'gestor' && req.usuario.role !== 'admin') {
    return res.json({ success: false, message: 'So o dono pode criar uma conta ADM.' });
  }
  if (!nome || !email || senha.length < 6) {
    return res.json({ success: false, message: 'Preencha nome, email e uma senha de pelo menos 6 caracteres.' });
  }
  var salt = gerarSalt();
  var hash = hashSenha(senha, salt);
  var id = 'U-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  try {
    await pool.query('INSERT INTO users (id, nome, email, senha_hash, senha_salt, role) VALUES ($1,$2,$3,$4,$5,$6)', [id, nome, email, hash, salt, papel]);
    res.json({ success: true, usuario: { id: id, nome: nome, email: email, role: papel } });
  } catch (err) {
    if (/duplicate key|unique/i.test(err.message)) return res.json({ success: false, message: 'Ja existe uma conta com este email.' });
    res.json({ success: false, message: 'Erro ao criar conta: ' + err.message });
  }
});
app.get('/api/admin/vendedores', exigeLogin(['admin', 'gestor']), async function (req, res) {
  try {
    var r = await pool.query("SELECT id, nome, email, role, ativo, criado_em, ultimo_login FROM users WHERE role IN ('vendedor','gestor') ORDER BY criado_em DESC");
    res.json({ success: true, vendedores: r.rows });
  } catch (err) { res.json({ success: false, message: err.message, vendedores: [] }); }
});
app.post('/api/admin/vendedores/:id/status', exigeLogin(['admin', 'gestor']), async function (req, res) {
  try {
    var alvo = await pool.query('SELECT role FROM users WHERE id=$1', [req.params.id]);
    if (!alvo.rows.length) return res.json({ success: false, message: 'Conta nao encontrada.' });
    if (alvo.rows[0].role === 'gestor' && req.usuario.role !== 'admin') {
      return res.json({ success: false, message: 'So o dono pode ativar/desativar uma conta ADM.' });
    }
    await pool.query("UPDATE users SET ativo = NOT COALESCE(ativo,true) WHERE id=$1 AND role IN ('vendedor','gestor')", [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.json({ success: false, message: err.message }); }
});
app.get('/api/vendedor/fichas', exigeLogin(['vendedor']), async function (req, res) {
try {
var r = await pool.query('SELECT * FROM fichas WHERE user_id=$1 ORDER BY criado_em DESC LIMIT 200', [req.usuario.id]);
res.json({ success: true, total: r.rows.length, fichas: r.rows });
} catch (err) { res.json({ success: false, message: err.message, fichas: [] }); }
});

// ---------- NAVEGADOR ----------
function caminhoChrome() {
if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
try { return puppeteer.executablePath(); } catch (e) { return null; }
}

async function abrirNavegador() {
const opcoes = {
headless: 'new',
args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote','--disable-extensions','--disable-background-networking', '--single-process', '--disable-extensions', '--disable-background-networking', '--js-flags=--max-old-space-size=256'],
timeout: 60000
};
const caminho = caminhoChrome();
if (caminho && fs.existsSync(caminho)) opcoes.executablePath = caminho;
return puppeteer.launch(opcoes);
}

// ---------- MENSAGEM DE ERRO EM PORTUGUES ----------
function erroAmigavel(msg) {
const m = String(msg || '');
  if (/CAMPO_CPF_NAO_APARECEU/.test(m))
    return 'A tela de cadastro do Fandi nao abriu para o robo (provavelmente pediu login ou mudou de endereco). A ficha esta salva aqui: use Copiar dados e Abrir Fandi. O detalhe do que o robo viu esta no diagnostico.';
  if (/PASSO1_LOCAL_DA_VENDA_FALHOU/.test(m))
return 'O robo nao conseguiu escolher o Departamento (SEMINOVOS) ou avancar do Passo 1 (Local da venda) no Fandi - a tela pode ter mudado. A ficha esta salva aqui: use Copiar dados e Abrir Fandi. O detalhe do que o robo viu esta no diagnostico.';
if (/PASSO2_BOTAO_PROXIMA_NAO_ENCONTRADO/.test(m))
return 'O robo preencheu o CPF mas nao achou o botao Proxima do Passo 2 no Fandi. A ficha esta salva aqui: use Copiar dados e Abrir Fandi. O detalhe do que o robo viu esta no diagnostico.';
if (/CAMPO_NAO_ENCONTRADO/.test(m))
return 'O robo nao achou um campo esperado no formulario do Fandi (a tela pode ter mudado). A ficha esta salva aqui: use Copiar dados e Abrir Fandi. O detalhe do que o robo viu esta no diagnostico.';
if (/BOTAO_NOVA_OPERACAO_NAO_ENCONTRADO/.test(m))
    return 'O robo entrou no Fandi mas nao achou o botao de Nova Operacao nesta tela (pode ter mudado de nome ou estar dentro de um menu diferente). A ficha esta salva aqui: use Copiar dados e Abrir Fandi. O detalhe do que o robo viu esta no diagnostico.';
if (/LOGIN_NECESSARIO/.test(m))
    return 'O Fandi pediu login e as variaveis FANDI_EMAIL/FANDI_SENHA nao estao configuradas no Render (Environment do servico web Nova-Pagina). Configure as duas com uma conta do Fandi e tente de novo. Enquanto isso, a ficha esta salva aqui: clique em Copiar dados e Abrir Fandi para subir em 30 segundos.';
if (/LOGIN_FALHOU/.test(m))
    return 'O robo tentou entrar no Fandi com FANDI_EMAIL/FANDI_SENHA mas nao conseguiu (senha errada, conta bloqueada, ou a tela de login mudou de lugar). Confira as credenciais no Render. Enquanto isso, use Copiar dados e Abrir Fandi.';
if (/no executable was found|Could not find Chrome|Browser was not found/i.test(m))
return 'O navegador automatico nao esta instalado no servidor. A ficha foi salva aqui, mas nao subiu no Fandi. Suba manualmente por enquanto.';
if (/Navigation timeout|TimeoutError|timeout of|waiting for/i.test(m))
return 'O Fandi demorou demais para responder. Clique em Tentar de novo daqui a alguns minutos.';
if (/net::|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(m))
return 'Nao consegui alcancar o site do Fandi agora. Pode ser instabilidade da rede.';
if (/Botao submit|selector/i.test(m))
return 'A tela de cadastro do Fandi mudou de lugar. O robo precisa ser reajustado.';
if (/Target closed|Protocol error|out of memory|Killed/i.test(m))
return 'O servidor ficou sem memoria no meio do envio. Tente de novo; se repetir, o plano gratuito nao aguenta o robo.';
return 'Falha ao enviar a ficha ao Fandi. Detalhe tecnico guardado no diagnostico.';
}

// 27/07/2026 (tarde) - URL REAL CONFIRMADA inspecionando o menu ja logado:
// o link do dropdown "Nova Operacao > Financiada" aponta sempre pra
// /operacao/cadastrar/financiada (rota fixa, nao muda com layout responsivo).
// Ir direto nela evita a caca por botao no /operacao/monitor que falhava
// (CAUSA 4 do Adendo 6: o robo as vezes so abria o dropdown sem escolher
// "Financiada", e a navegacao real nunca acontecia).
async function tentarLoginFandi(page) {
  const email = process.env.FANDI_EMAIL || '';
  const senha = process.env.FANDI_SENHA || '';
  if (!email || !senha) return { ok: false, motivo: 'SEM_CREDENCIAL' };
  try {
    const campoEmail = await page.$('input[type="email"], input[name="email"], input[name="username"], input[type="text"]');
    if (!campoEmail) return { ok: false, motivo: 'CAMPO_LOGIN_NAO_ENCONTRADO' };
    await campoEmail.click({ clickCount: 3 });
    await campoEmail.type(email, { delay: 60 });
    let campoSenha = await page.$('input[type="password"]');
    if (!campoSenha) {
      const botaoProximo = await page.$('button[type="submit"]');
      if (!botaoProximo) return { ok: false, motivo: 'BOTAO_PROXIMO_NAO_ENCONTRADO' };
      await botaoProximo.click();
      try { await page.waitForSelector('input[type="password"]', { timeout: 15000 }); } catch (eSenha) { return { ok: false, motivo: 'CAMPO_SENHA_NAO_APARECEU' }; }
      campoSenha = await page.$('input[type="password"]');
    }
    if (!campoSenha) return { ok: false, motivo: 'CAMPO_LOGIN_NAO_ENCONTRADO' };
    await campoSenha.click({ clickCount: 3 });
    await campoSenha.type(senha, { delay: 60 });
    const botaoEntrar = await page.$('button[type="submit"]');
    if (botaoEntrar) {
      await Promise.all([
        botaoEntrar.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(function () {})
      ]);
    } else {
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(function () {});
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: 'ERRO_AO_LOGAR: ' + e.message };
  }
}

async function abrirTelaNovaOperacao(page) {
await page.goto('https://jsl.fandi.com.br/operacao/cadastrar/financiada', { waitUntil: 'networkidle2', timeout: 60000 });
}

// Helper generico: procura um elemento clicavel (botao/link/opcao de lista)
// cujo texto bata EXATAMENTE com o alvo (tolerante a acentos/maiuscula) e
// clica nele. Fica tentando ate o timeout porque a tela pode estar animando.
async function obterFrameFandi(page) {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const frames = page.frames();
    for (const f of frames) {
      let urlFrame = '';
      try { urlFrame = f.url(); } catch (e) {}
      if (/fimanager-jsl\.fandi\.com\.br/.test(urlFrame)) return f;
    }
    await new Promise(function (r) { setTimeout(r, 500); });
  }
  return page.mainFrame();
}

async function clicarPorTexto(ctx, texto) {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    let handle;
    try {
      handle = await ctx.evaluateHandle(function (alvo) {
        function normaliza(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
        function visivel(el) {
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          var estilo = window.getComputedStyle(el);
          if (estilo.visibility === 'hidden' || estilo.display === 'none' || estilo.pointerEvents === 'none') return false;
          return true;
        }
        var alvoNorm = normaliza(alvo);
        var candidatos = Array.prototype.slice.call(document.querySelectorAll('a, button, li, div, span, mat-option, option, [role="option"], [role="button"]'));
        var melhor = null, melhorLen = Infinity;
        for (var i = 0; i < candidatos.length; i++) {
          var el = candidatos[i];
          if (el.tagName !== 'OPTION' && !visivel(el)) continue;
          var texto2 = normaliza(el.textContent);
          if (texto2.length === 0 || texto2.length > 80) continue;
          if (texto2 === alvoNorm) { return el; }
          if (texto2.indexOf(alvoNorm) !== -1 && texto2.length < melhorLen) { melhor = el; melhorLen = texto2.length; }
        }
        return melhor;
      }, texto);
    } catch (eEval) { handle = null; }
    const el = handle ? handle.asElement() : null;
    if (el) {
      try {
        await el.click();
        await handle.dispose();
        return true;
      } catch (eClick) {
        try {
          await el.evaluate(function (node) { node.click(); });
          await handle.dispose();
          return true;
        } catch (eClick2) {
          await handle.dispose();
        }
      }
    } else if (handle) {
      await handle.dispose();
    }
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  return false;
}





// Helper generico: acha um campo (input/textarea) pelo rotulo/placeholder/
// nome tecnico mais proximo e digita nele. O formulario do Fandi e um
// componente Angular que pode nao usar o atributo name como o robo antigo
// esperava; a busca e por pistas (placeholder, aria-label, formcontrolname)
// ou pelo texto do rotulo mais perto no DOM.// Selecao robusta de campos Select2 (Marca/Modelo/Versao do Passo 3 do Fandi).
// Setar sel.value direto NAO basta: o Select2 fica com o texto 'Selecione uma
// opcao' e o Fandi acusa 'Campo obrigatorio' mesmo com o <select> nativo com
// valor. Preciso simular a interacao real (abrir + clicar na opcao renderizada)
// e confirmar pelo TEXTO renderizado do Select2, nao pelo .value do select
// (que sempre devolve a primeira opcao mesmo sem nada selecionado).
async function selecionarSelect2(frameFandi, campoId, comTimeout) {
  const diag = { campoId: campoId };
  try {
    const opcoes = await comTimeout(frameFandi.evaluate(function (id) {
      var sel = document.getElementById(id);
      return sel ? Array.prototype.slice.call(sel.options).map(function (o) { return { value: o.value, text: o.textContent.trim() }; }).filter(function (o) { return o.value; }) : [];
    }, campoId), 6000, 'opcoes_' + campoId).catch(function () { return []; });
    diag.opcoes = opcoes.slice(0, 5);
    if (!opcoes.length) { diag.erro = 'sem_opcoes'; return diag; }
    const textoAlvo = opcoes[0].text;
    diag.textoAlvo = textoAlvo;

    const abriu = await comTimeout(frameFandi.evaluate(function (id) {
      if (!window.jQuery) return { ok: false, motivo: 'sem_jquery' };
      var campo = window.jQuery('#' + id);
      if (!campo.data('select2')) return { ok: false, motivo: 'sem_instancia_select2' };
      try { campo.select2('open'); } catch (eOpen) { return { ok: false, motivo: 'erro_open: ' + eOpen.message }; }
      return { ok: true };
    }, campoId), 5000, 'abrir_' + campoId).catch(function (eAbrir) { return { ok: false, motivo: 'excecao: ' + eAbrir.message }; });
    diag.abriu = abriu;

    await new Promise(function (r) { setTimeout(r, 900); });

    const clique = await (async function () {
      try {
        const handles = await comTimeout(frameFandi.$$('.select2-container--open .select2-results__option'), 5000, 'handles_' + campoId).catch(function () { return []; });
        if (!handles || !handles.length) {
          return { ok: false, motivo: 'sem_opcoes_renderizadas', qtd: 0 };
        }
        let alvoHandle = null;
        let textoClicado = null;
        for (const h of handles) {
          const txt = await h.evaluate(function (el) { return el.textContent.trim(); }).catch(function () { return ''; });
          if (txt === textoAlvo) { alvoHandle = h; textoClicado = txt; break; }
        }
        if (!alvoHandle) {
          alvoHandle = handles[0];
          textoClicado = await handles[0].evaluate(function (el) { return el.textContent.trim(); }).catch(function () { return ''; });
        }
        await alvoHandle.evaluate(function (el) { el.scrollIntoView({ block: 'center' }); }).catch(function () {});
        await comTimeout(alvoHandle.click(), 5000, 'clicar_real_' + campoId);
        return { ok: true, textoClicado: textoClicado, qtd: handles.length, metodo: 'puppeteer_click_trusted' };
      } catch (eClicar) {
        return { ok: false, motivo: 'excecao: ' + eClicar.message };
      }
    })();
    diag.clique = clique;

    await new Promise(function (r) { setTimeout(r, 600); });

    const estadoFinal = await comTimeout(frameFandi.evaluate(function (id) {
      var containerSpan = document.getElementById('select2-' + id + '-container');
      var sel = document.getElementById(id);
      var frameworkInfo = { ngVersionAttr: (function () { var e2 = document.querySelector('[ng-version]'); return e2 ? e2.getAttribute('ng-version') : null; })(), hasAngularGlobal: !!window.angular, hasNgApp: !!document.querySelector('[ng-app]'), selectClasses: sel ? sel.className : null };
      if (sel) {
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        sel.dispatchEvent(new Event('focus', { bubbles: true }));
        sel.dispatchEvent(new Event('focusout', { bubbles: true }));
        sel.dispatchEvent(new Event('blur', { bubbles: true }));
        if (window.angular) {
          try {
            var elNg = window.angular.element(sel);
            var scopeNg = elNg.scope ? elNg.scope() : null;
            if (scopeNg && scopeNg.$apply) { scopeNg.$apply(); }
          } catch (eNg) {}
        }
        if (window.jQuery) {
          try {
            var jSel = window.jQuery(sel);
            jSel.trigger('input');
            jSel.trigger('change');
            jSel.trigger('blur');
            jSel.trigger('focusout');
            var opcaoSel = sel.options[sel.selectedIndex];
            jSel.trigger({ type: 'select2:select', params: { data: { id: sel.value, text: opcaoSel ? opcaoSel.textContent : '' } } });
            if (jSel.valid) { jSel.valid(); }
            var formEl = sel.closest('form');
            if (formEl && window.jQuery(formEl).valid) { window.jQuery(formEl).valid(); }
          } catch (eJq) {}
        }
      }
      return {
        textoRenderizado: containerSpan ? containerSpan.textContent.trim() : null,
        aindaAberto: !!document.querySelector('.select2-container--open'),
        valorNativo: sel ? sel.value : null,
        dispatchNativo: !!sel,
        frameworkInfo: frameworkInfo
      };
    }, campoId), 4000, 'estado_final_' + campoId).catch(function (eEstado) { return { erro: eEstado.message }; });
    diag.estadoFinal = estadoFinal;

    return diag;
  } catch (eGeralSelect2) {
    diag.erroGeral = eGeralSelect2.message;
    return diag;
  }
}


async function preencherCampoPorRotuloNativo(ctx, rotulo, valor) {
  return await ctx.evaluate(function (rot, val) {
    function normaliza(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
    var rotNorm = normaliza(rot);
    function visivel(el) { return el.offsetParent !== null; }
    var alvo = null;
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'));
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (!visivel(el) || el.disabled) continue;
      var nome = normaliza(el.getAttribute('name'));
      var ph = normaliza(el.getAttribute('placeholder'));
      var aria = normaliza(el.getAttribute('aria-label'));
      var idAttr = normaliza(el.id);
      if (nome.indexOf(rotNorm) !== -1 || ph.indexOf(rotNorm) !== -1 || aria.indexOf(rotNorm) !== -1 || idAttr.indexOf(rotNorm) !== -1) { alvo = el; break; }
      if (el.id) {
        var lbl = document.querySelector('label[for="' + el.id + '"]');
        if (lbl && normaliza(lbl.textContent).indexOf(rotNorm) !== -1) { alvo = el; break; }
      }
    }
    if (!alvo) {
      var labels = Array.prototype.slice.call(document.querySelectorAll('label, span, div'));
      for (var j = 0; j < labels.length; j++) {
        var l = labels[j];
        if (normaliza(l.textContent) === rotNorm) {
          var container = l.closest('div');
          var tentativas = 0;
          while (container && tentativas < 4 && !alvo) {
            var inp = container.querySelector('input, textarea');
            if (inp && visivel(inp)) { alvo = inp; break; }
            container = container.parentElement;
            tentativas++;
          }
          if (alvo) break;
        }
      }
    }
    if (!alvo) return { ok: false, motivo: 'nao_encontrado' };
    try {
      alvo.focus();
      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(alvo, val);
      alvo.dispatchEvent(new Event('input', { bubbles: true }));
      alvo.dispatchEvent(new Event('change', { bubbles: true }));
      alvo.blur();
      return { ok: true, valorFinal: alvo.value, id: alvo.id || null, name: alvo.name || null };
    } catch (eSet) {
      return { ok: false, motivo: 'erro_set: ' + eSet.message };
    }
  }, rotulo, valor);
}

async function digitarCampoPorRotulo(ctx, rotulo, valor) {
  for (let tentativa = 0; tentativa < 8; tentativa++) {
    let handle;
    try {
      handle = await ctx.evaluateHandle(function (rot) {
        function normaliza(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim(); }
        var rotNorm = normaliza(rot);
        var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea'));
        for (var i = 0; i < inputs.length; i++) {
          var el = inputs[i];
          if (el.offsetParent === null) continue;
          if (el.disabled) continue;
          var nome = normaliza(el.getAttribute('name'));
          var ph = normaliza(el.getAttribute('placeholder'));
          var aria = normaliza(el.getAttribute('aria-label'));
          var idAttr = normaliza(el.id);
          if (nome.indexOf(rotNorm) !== -1 || ph.indexOf(rotNorm) !== -1 || aria.indexOf(rotNorm) !== -1 || idAttr.indexOf(rotNorm) !== -1) {
            return el;
          }
          if (el.id) {
            var lbl = document.querySelector('label[for="' + el.id + '"]');
            if (lbl && normaliza(lbl.textContent).indexOf(rotNorm) !== -1) return el;
          }
        }
        var labels = Array.prototype.slice.call(document.querySelectorAll('label, span, div'));
        for (var j = 0; j < labels.length; j++) {
          var l = labels[j];
          if (normaliza(l.textContent) === rotNorm) {
            var container = l.closest('div');
            var tentativas = 0;
            while (container && tentativas < 4) {
              var inp = container.querySelector('input, textarea');
              if (inp) return inp;
              container = container.parentElement;
              tentativas++;
            }
          }
        }
        return null;
      }, rotulo);
    } catch (eEval) { handle = null; }
    const el = handle ? handle.asElement() : null;
    if (el) {
      await el.click({ clickCount: 3 });
      await el.type(String(valor || ''), { delay: 30 });
      if (handle) await handle.dispose();
      return true;
    }
    if (handle) await handle.dispose();
    await new Promise(function (r) { setTimeout(r, 400); });
  }
  return false;
}



async function processarFicha(fandi_id, dados) {
      const MAX_TENTATIVAS = 4;
      for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
            let browser;
            try {
                  browser = await abrirNavegador();
                  const page = await browser.newPage();
                  page.setDefaultNavigationTimeout(60000);
                  page.setDefaultTimeout(60000);

            await page.goto('https://jsl.fandi.com.br/', { waitUntil: 'networkidle2', timeout: 60000 });
// 27/07/2026 - CAUSA RAIZ REAL (confirmada abrindo o site direto no navegador):
            // pular pra /operacao/novo SEM logar antes NAO mostra tela de login - o Fandi
// devolve um erro 404 (Pagina nao encontrada) pra quem nao tem sessao, porque
// essa rota so existe navegando por dentro do site ja logado. Por isso o robo
// ficava esperando um campo de CPF que nunca aparecia numa pagina de erro (dai
// o log mostrar campos:[] e temCampoSenha:false - era literalmente o 404).
// Correcao: SEMPRE entra pela raiz primeiro (e la que a tela de login
// realmente aparece) e SO DEPOIS de logado vai para /operacao/novo.
            const checagemLoginFandi = function () {
              return !!document.querySelector('input[type="password"]') ||
                /login|entrar|autentica/i.test(location.pathname + location.search);
            };
            let precisaLogin = await page.evaluate(checagemLoginFandi);
  if (precisaLogin) {
    const temCredencialFandi = !!(process.env.FANDI_EMAIL && process.env.FANDI_SENHA);
    if (!temCredencialFandi) {
      try { if (page && !page.isClosed()) { await page.close(); } } catch (e) {} try { if (browser) { await browser.close(); } } catch (e) {} throw new Error('LOGIN_NECESSARIO: o Fandi pediu login e as variaveis FANDI_EMAIL/FANDI_SENHA nao estao configuradas no servidor.');
    }
    const tentativaLoginFandi = await tentarLoginFandi(page);
    if (!tentativaLoginFandi.ok) {
      try { if (page && !page.isClosed()) { await page.close(); } } catch (e) {} try { if (browser) { await browser.close(); } } catch (e) {} throw new Error('LOGIN_FALHOU: ' + tentativaLoginFandi.motivo);
    }
    const aindaPedeLoginFandi = await page.evaluate(checagemLoginFandi);
    if (aindaPedeLoginFandi) {
      try { if (page && !page.isClosed()) { await page.close(); } } catch (e) {} try { if (browser) { await browser.close(); } } catch (e) {} throw new Error('LOGIN_FALHOU: FEZ_LOGIN_MAS_CONTINUOU_PEDINDO');
    }
  }

  await abrirTelaNovaOperacao(page);
  const frameFandi = await obterFrameFandi(page);


// PASSO 1 - Local da venda: Empresa/Ponto de venda/Vendedor ja vem
// preenchidos pela sessao logada do vendedor. So falta escolher o
// Departamento (usa SEMINOVOS, que e o grosso do estoque desta loja).
try {
const abriuDropdown = await clicarPorTexto(frameFandi, 'selecione', 10000);
if (!abriuDropdown) throw new Error('campo Departamento (Selecione) nao apareceu');
await new Promise(function (r) { setTimeout(r, 400); });
const escolheu = await clicarPorTexto(frameFandi, 'seminovos', 6000);
if (!escolheu) throw new Error('opcao SEMINOVOS nao apareceu na lista');
const avancouPasso1 = await clicarPorTexto(frameFandi, 'proxima', 8000);
if (!avancouPasso1) throw new Error('botao Proxima do Passo 1 nao encontrado');
await new Promise(function (r) { setTimeout(r, 800); });
} catch (ePasso1) {
throw new Error('PASSO1_LOCAL_DA_VENDA_FALHOU: ' + ePasso1.message);
}

// PASSO 2 - Dados do cliente: a tela real so pede CPF/CNPJ pra localizar
// ou criar o cliente.
try {
await digitarCampoPorRotulo(frameFandi, 'cpf ou cnpj', dados.cpf || '');
} catch (eCampo) {
const oQueVi = await page.evaluate(function () {
const nomes = Array.prototype.slice.call(document.querySelectorAll('input,select'))
.map(function (c) { return c.getAttribute('placeholder') || c.getAttribute('name') || c.getAttribute('formcontrolname') || c.type || '?'; })
.slice(0, 25);
return { titulo: document.title, endereco: location.href, campos: nomes };
}).catch(function () { return null; });
throw new Error('CAMPO_CPF_NAO_APARECEU. O robo viu: ' + JSON.stringify(oQueVi));
}
const avancouPasso2 = await clicarPorTexto(frameFandi, 'proxima', 8000);
if (!avancouPasso2) throw new Error('PASSO2_BOTAO_PROXIMA_NAO_ENCONTRADO');
await new Promise(function (r) { setTimeout(r, 1000); });

// 27/07/2026 (tarde) - A PARTIR DAQUI o Fandi entra no Passo 3 (Dados do
// veiculo), que exige Km e Placa. A ficha do TDrive Pro hoje NAO coleta
// esses dois campos (so os 8 campos do cliente). Em vez de adivinhar e
// arriscar um cadastro errado num sistema real, o robo para aqui DE
// PROPOSITO: o cliente ja fica localizado/criado no Fandi com o CPF
// preenchido, e o vendedor termina o resto (veiculo + condicoes da venda)
// com o link direto, ja logado.

            const urlParada = page.url();
            const diagLog = { fases: [] };
            const inicioV5 = Date.now();

            function comTimeout(promise, ms, label) {
              let timer;
              const timeout = new Promise(function (_, reject) {
                timer = setTimeout(function () { reject(new Error('TIMEOUT_' + label)); }, ms);
              });
              return Promise.race([promise, timeout]).finally(function () { clearTimeout(timer); });
            }

            async function corpoTextoV5() {
              try { return await frameFandi.evaluate(function () { return document.body.innerText || ''; }); }
              catch (eTxt) { return ''; }
            }

            async function executarPasso3ComSeguranca() {
              await new Promise(function (r) { setTimeout(r, 2500); });

              try {
                const infoTipoOperacaoV5 = await comTimeout(frameFandi.evaluate(function () {
                  function visivel(el) {
                    var r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return false;
                    var st = window.getComputedStyle(el);
                    return st.visibility !== 'hidden' && st.display !== 'none';
                  }
                  var selects = Array.prototype.slice.call(document.querySelectorAll('select'));
                  var alvo = null;
                  for (var i = 0; i < selects.length; i++) {
                    var textoOpcoes = Array.prototype.slice.call(selects[i].options).map(function (o) { return o.textContent.trim().toUpperCase(); }).join('|');
                    if (/SEMINOVOS/.test(textoOpcoes) && /NOVOS/.test(textoOpcoes)) { alvo = selects[i]; break; }
                  }
                  if (!alvo) return { encontrado: false };
                  var jaSelecionado = alvo.value && alvo.value.length > 0;
                  return { encontrado: true, id: alvo.id || null, name: alvo.name || null, valorAtual: alvo.value, jaSelecionado: jaSelecionado, visivel: visivel(alvo), opcoes: Array.prototype.slice.call(alvo.options).map(function (o) { return { value: o.value, text: o.textContent.trim() }; }) };
                }), 8000, 'info_tipo_operacao').catch(function (e) { return { erro: e.message }; });
                diagLog.fases.push({ fase: 'info_tipo_operacao', resultado: infoTipoOperacaoV5 });

                if (infoTipoOperacaoV5 && infoTipoOperacaoV5.encontrado && !infoTipoOperacaoV5.jaSelecionado && infoTipoOperacaoV5.id) {
                  const opcaoSeminovos = infoTipoOperacaoV5.opcoes.find(function (o) { return /SEMINOVOS/i.test(o.text) && o.value; });
                  if (opcaoSeminovos) {
                    try {
                      await comTimeout(frameFandi.select('#' + infoTipoOperacaoV5.id, opcaoSeminovos.value), 8000, 'select_tipo_operacao');
                      diagLog.fases.push({ fase: 'selecionou_tipo_operacao', valor: opcaoSeminovos });
                    } catch (eSelTipo) {
                      diagLog.fases.push({ fase: 'erro_select_tipo_operacao', erro: eSelTipo.message });
                    }
                  } else {
                    const clicouOpcaoV5 = await comTimeout(clicarPorTexto(frameFandi, 'SEMINOVOS'), 6000, 'clicar_seminovos').catch(function () { return false; });
                    diagLog.fases.push({ fase: 'clicou_seminovos_fallback', clicou: clicouOpcaoV5 });
                  }
                  await new Promise(function (r) { setTimeout(r, 800); });
                }
              } catch (eTipoOperacaoV5) {
                diagLog.fases.push({ fase: 'erro_tipo_operacao', erro: eTipoOperacaoV5.message });
              }

              let txtInicialV5 = await comTimeout(corpoTextoV5(), 8000, 'corpo_inicial').catch(function () { return ''; });
              let modalDetectadoV5 = /outras opera|pend[eê]ncias vizualizada/i.test(txtInicialV5);
              diagLog.fases.push({ fase: 'deteccao_modal', modalDetectado: modalDetectadoV5, trecho: txtInicialV5.slice(0, 300) });

              if (modalDetectadoV5) {
                try {
                  const marcouV5 = await comTimeout(clicarPorTexto(frameFandi, 'Pendências Vizualizadas'), 6000, 'chk_pendencias').catch(function () { return false; });
                  await new Promise(function (r) { setTimeout(r, 600); });
                  const candidatosV5 = ['Continuar sem adicionar', 'Sim, desejo adicionar', 'Estou ciente', 'Não, desejo manter', 'Avançar', 'Continuar', 'Fechar'];
                  let botaoClicadoV5 = null;
                  for (const txt of candidatosV5) {
                    const ok = await comTimeout(clicarPorTexto(frameFandi, txt), 6000, 'btn_modal').catch(function () { return false; });
                    if (ok) { botaoClicadoV5 = txt; await new Promise(function (r) { setTimeout(r, 1000); }); break; }
                  }
                  diagLog.fases.push({ fase: 'fechar_modal', marcouCheckbox: marcouV5, botaoClicado: botaoClicadoV5 });
                } catch (eModalV5) {
                  diagLog.fases.push({ fase: 'fechar_modal_erro', erro: eModalV5.message });
                }
              }

              async function estadoCamposV5() {
                return await comTimeout(frameFandi.evaluate(function () {
                  function visivel(el) {
                    var r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return false;
                    var st = window.getComputedStyle(el);
                    return st.visibility !== 'hidden' && st.display !== 'none';
                  }
                  function cv(id) { var el = document.getElementById(id); return el ? visivel(el) : null; }
                  return { marca: cv('opo_slctMarca'), usado: cv('usado'), novo: cv('novo') };
                }), 6000, 'estado_campos').catch(function (e) { return { erro: e.message }; });
              }

              let estadoV5 = await estadoCamposV5();
              diagLog.fases.push({ fase: 'estado_apos_modal', estado: estadoV5 });

              if (!estadoV5.marca) {
                const clicouUsadoV5 = await comTimeout(clicarPorTexto(frameFandi, 'Usado'), 6000, 'clicar_usado').catch(function () { return false; });
                await new Promise(function (r) { setTimeout(r, 1000); });
                estadoV5 = await estadoCamposV5();
                diagLog.fases.push({ fase: 'apos_usado', clicouUsado: clicouUsadoV5, estado: estadoV5 });

                try {
                  const diagnosticoExtraV5 = await comTimeout(frameFandi.evaluate(function () {
                    function infoEl(el) {
                      if (!el) return null;
                      var st = window.getComputedStyle(el);
                      var r = el.getBoundingClientRect();
                      return { tag: el.tagName, id: el.id || null, className: (el.className || '').toString().slice(0, 80), display: st.display, visibility: st.visibility, w: r.width, h: r.height };
                    }
                    function cadeiaAncestral(id) {
                      var el = document.getElementById(id);
                      if (!el) return { existe: false };
                      var cadeia = [infoEl(el)];
                      var cur = el;
                      for (var i = 0; i < 6 && cur.parentElement; i++) {
                        cur = cur.parentElement;
                        cadeia.push(infoEl(cur));
                      }
                      return { existe: true, cadeia: cadeia };
                    }
                    function visivel(el) {
                      var r = el.getBoundingClientRect();
                      if (r.width <= 0 || r.height <= 0) return false;
                      var st = window.getComputedStyle(el);
                      return st.visibility !== 'hidden' && st.display !== 'none';
                    }
                    var re = /ve[ií]culo|dados do|condi[çc][õo]es|usado|novo\b|passo\s*[23]|avan[çc]ar/i;
                    var candidatos = Array.prototype.slice.call(document.querySelectorAll('a, button, li, div, span, [role="tab"], [role="button"], label')).filter(function (el) {
                      return visivel(el) && re.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 60;
                    }).map(function (el) {
                      return { tag: el.tagName, text: (el.textContent || '').trim(), className: (el.className || '').toString().slice(0, 60) };
                    });
                    var vistos = {};
                    var unicos = candidatos.filter(function (c) {
                      var chave = c.tag + '|' + c.text;
                      if (vistos[chave]) return false;
                      vistos[chave] = true;
                      return true;
                    });
                    return { marcaCadeia: cadeiaAncestral('opo_slctMarca'), usadoCadeia: cadeiaAncestral('usado'), elementosRelevantes: unicos.slice(0, 40) };
                  }), 8000, 'diagnostico_extra').catch(function (e) { return { erro: e.message }; });
                  diagLog.fases.push({ fase: 'diagnostico_extra', resultado: diagnosticoExtraV5 });
                } catch (eExtraV5) {
                  diagLog.fases.push({ fase: 'diagnostico_extra_erro', erro: eExtraV5.message });
                }
              }


                let wizardInfoV5 = null;
              try {
                  async function lerWizardInfoV5() {
                    return await comTimeout(frameFandi.evaluate(function () {
                      var blocos = Array.prototype.slice.call(document.querySelectorAll('[class*="wizard-content"]'));
                      var info = blocos.map(function (el) {
                        var st = window.getComputedStyle(el);
                        return { className: (el.className || '').toString().slice(0, 80), display: st.display, textoInicio: (el.textContent || '').trim().slice(0, 60) };
                      });
                      var ativo = null;
                      for (var i = 0; i < blocos.length; i++) {
                        var st2 = window.getComputedStyle(blocos[i]);
                        if (st2.display !== 'none') { ativo = blocos[i]; break; }
                      }
                      var proximaAtivo = null;
                      var erros = [];
                      if (ativo) {
                        var btns = Array.prototype.slice.call(ativo.querySelectorAll('button, a[role="button"], [type="submit"]'));
                        for (var j = 0; j < btns.length; j++) {
                          var txt = (btns[j].textContent || '').trim();
                          if (/pr[oó]xima|avan[çc]ar/i.test(txt)) { proximaAtivo = txt; break; }
                        }
                        var elErro = Array.prototype.slice.call(ativo.querySelectorAll('[class*="invalid"], [class*="error"], [class*="danger"], .help-block, .field-validation-error'));
                        erros = elErro.map(function (e) { return (e.textContent || '').trim(); }).filter(function (t) { return t; }).slice(0, 10);
                      }
                      return { totalBlocos: blocos.length, blocos: info, ativoTextoInicio: ativo ? (ativo.textContent || '').trim().slice(0, 160) : null, proximaAtivo: proximaAtivo, erros: erros };
                    }), 8000, 'wizard_info').catch(function (e) { return { erro: e.message }; });
                  }

                  let tentativaWizardV5 = 0;
                  wizardInfoV5 = await lerWizardInfoV5();
                  diagLog.fases.push({ fase: 'wizard_info_0', resultado: wizardInfoV5 });

                  while (tentativaWizardV5 < 6 && wizardInfoV5 && !/dados do ve[ií]culo/i.test(wizardInfoV5.ativoTextoInicio || '')) {
                    tentativaWizardV5++;

                    try {
                      const cpfInfoV5 = await comTimeout(frameFandi.evaluate(function () {
                        function visivel(el) {
                          var r = el.getBoundingClientRect();
                          if (r.width <= 0 || r.height <= 0) return false;
                          var st = window.getComputedStyle(el);
                          return st.visibility !== 'hidden' && st.display !== 'none';
                        }
                        var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).filter(visivel);
                        var cpfEl = inputs.find(function (el) {
                          var lbl = '';
                          if (el.id) { var lab = document.querySelector('label[for="' + el.id + '"]'); if (lab) lbl = lab.textContent; }
                          return /cpf/i.test(el.id || '') || /cpf/i.test(el.name || '') || /cpf/i.test(el.placeholder || '') || /cpf/i.test(lbl);
                        });
                        if (!cpfEl) return { encontrado: false, totalVisiveis: inputs.length };
                        return { encontrado: true, id: cpfEl.id || null, valorAtual: cpfEl.value };
                      }), 6000, 'cpf_info').catch(function (e) { return { erro: e.message }; });
                      diagLog.fases.push({ fase: 'cpf_info_' + tentativaWizardV5, resultado: cpfInfoV5 });

                    if (cpfInfoV5 && cpfInfoV5.encontrado && !cpfInfoV5.valorAtual && cpfInfoV5.id && dados && dados.cpf) {
                      try {
                        const preencheuCpfV5 = await comTimeout(frameFandi.evaluate(function (id2, valor2) {
                          var el = document.getElementById(id2);
                          if (!el) return false;
                          el.focus();
                          var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                          setter.call(el, valor2);
                          el.dispatchEvent(new Event('input', { bubbles: true }));
                          el.dispatchEvent(new Event('change', { bubbles: true }));
                          el.blur();
                          return true;
                        }, cpfInfoV5.id, String(dados.cpf)), 6000, 'preenche_cpf').catch(function (e) { return false; });
                        diagLog.fases.push({ fase: 'preencheu_cpf_' + tentativaWizardV5, ok: preencheuCpfV5 });
                        await new Promise(function (r) { setTimeout(r, 600); });
                      } catch (ePreencheCpfV5) {
                        diagLog.fases.push({ fase: 'erro_preenche_cpf_' + tentativaWizardV5, erro: ePreencheCpfV5.message });
                      }
                    }
                    } catch (eCpfV5) {
                      diagLog.fases.push({ fase: 'cpf_info_erro_' + tentativaWizardV5, erro: eCpfV5.message });
                    }

                    let cliqueOk = false;
                    if (wizardInfoV5.proximaAtivo) {
                      cliqueOk = await comTimeout(clicarPorTexto(frameFandi, wizardInfoV5.proximaAtivo), 6000, 'clicar_proxima_loop').catch(function () { return false; });
                    }
                    await new Promise(function (r) { setTimeout(r, 1800); });
                    wizardInfoV5 = await lerWizardInfoV5();
                    diagLog.fases.push({ fase: 'wizard_info_' + tentativaWizardV5, clicou: cliqueOk, resultado: wizardInfoV5 });
                  }

                  estadoV5 = await estadoCamposV5();
                  diagLog.fases.push({ fase: 'apos_loop_wizard', estado: estadoV5, ativoFinal: wizardInfoV5 ? wizardInfoV5.ativoTextoInicio : null });
                } catch (eWizardV5) {
                  diagLog.fases.push({ fase: 'wizard_info_erro', erro: eWizardV5.message });
                }
let preencheuV5 = { tentou: false };
              const estamosEmDadosDoVeiculo = wizardInfoV5 && /dados do ve[ií]culo/i.test(wizardInfoV5.ativoTextoInicio || '');
              diagLog.fases.push({ fase: 'checagem_pre_preenchimento', estadoMarca: estadoV5.marca, estamosEmDadosDoVeiculo: estamosEmDadosDoVeiculo });
              try {
                    const radiosInfoV5 = await comTimeout(frameFandi.evaluate(function () {
                      function visivel(el) {
                        var r = el.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) return false;
                        var st = window.getComputedStyle(el);
                        return st.visibility !== 'hidden' && st.display !== 'none';
                      }
                      var todosElementos = Array.prototype.slice.call(document.querySelectorAll('body *'));
                      function acharCampoAno(el) {
                        var idxEl = todosElementos.indexOf(el);
                        if (idxEl === -1) return null;
                        for (var i = idxEl - 1; i >= 0 && i > idxEl - 400; i--) {
                          var node = todosElementos[i];
                          if (node.children && node.children.length > 0) continue;
                          var t = (node.textContent || '').trim();
                          if (!t || t.length > 60) continue;
                          if (/ano de fabrica/i.test(t)) return 'fabricacao';
                          if (/ano do modelo/i.test(t)) return 'modelo';
                        }
                        return null;
                      }
                      var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"]')).filter(visivel);
                      var grupos = {};
                      radios.forEach(function (r, i) {
                        var nome = r.name || '';
                        if (!nome) return;
                        if (!grupos[nome]) grupos[nome] = [];
                        var texto = '';
                        if (r.id) {
                          var lab = document.querySelector('label[for="' + r.id + '"]');
                          if (lab) texto = lab.textContent.trim();
                        }
                        if (!texto) {
                          var parentLabel = r.closest('label');
                          if (parentLabel) texto = parentLabel.textContent.trim();
                        }
                        var campo = acharCampoAno(r);
                        grupos[nome].push({ value: r.value, texto: texto, checked: r.checked, idx: i, campo: campo });
                      });
                      var resultado = [];
                      Object.keys(grupos).forEach(function (nome) {
                        var itens = grupos[nome];
                        var todosAnos = itens.length > 0 && itens.every(function (it) { return /^(19|20)\d{2}$/.test(it.texto || it.value || ''); });
                        if (!todosAnos) return;
                        var porCampo = {};
                        var semCampo = [];
                        itens.forEach(function (it) {
                          if (it.campo) {
                            if (!porCampo[it.campo]) porCampo[it.campo] = [];
                            porCampo[it.campo].push(it);
                          } else {
                            semCampo.push(it);
                          }
                        });
                        var chavesCampo = Object.keys(porCampo);
                        if (chavesCampo.length > 0) {
                          semCampo.forEach(function (it) {
                            var melhorChave = null, melhorDist = Infinity;
                            chavesCampo.forEach(function (ch) {
                              porCampo[ch].forEach(function (it2) {
                                var d = Math.abs(it2.idx - it.idx);
                                if (d < melhorDist) { melhorDist = d; melhorChave = ch; }
                              });
                            });
                            if (melhorChave) porCampo[melhorChave].push(it);
                          });
                          chavesCampo.forEach(function (campoKey, si) {
                            var subItens = porCampo[campoKey];
                            var jaMarcado = subItens.some(function (it) { return it.checked; });
                            resultado.push({ nomeGrupo: nome + '::' + campoKey, subIndex: si, itens: subItens, jaMarcado: jaMarcado });
                          });
                        } else {
                          var subgrupos = [];
                          var atual = [];
                          itens.forEach(function (it, k) {
                            var numAtual = parseInt(it.texto || it.value, 10);
                            if (k > 0) {
                              var numAnterior = parseInt(itens[k - 1].texto || itens[k - 1].value, 10);
                              if (numAtual > numAnterior) {
                                subgrupos.push(atual);
                                atual = [];
                              }
                            }
                            atual.push(it);
                          });
                          if (atual.length) subgrupos.push(atual);
                          subgrupos.forEach(function (sub, si) {
                            var jaMarcado = sub.some(function (it) { return it.checked; });
                            resultado.push({ nomeGrupo: nome, subIndex: si, itens: sub, jaMarcado: jaMarcado });
                          });
                        }
                      });
                      return resultado;
                    }), 10000, 'radios_ano').catch(function (e) { return { erro: e.message }; });
                    diagLog.fases.push({ fase: 'radios_ano_info', resultado: radiosInfoV5 });

                    if (Array.isArray(radiosInfoV5)) {
                      for (const grupoAnoV5 of radiosInfoV5) {
                        if (!grupoAnoV5.jaMarcado && grupoAnoV5.itens && grupoAnoV5.itens.length) {
                          const item2024V5 = grupoAnoV5.itens.find(function (it) { return (it.texto || it.value) === '2024'; });
                          const alvoAnoV5 = item2024V5 || grupoAnoV5.itens[grupoAnoV5.itens.length - 1];
                          try {
                            const cliqueRadioV5 = await comTimeout(frameFandi.evaluate(function (idxAlvo) {
                              function visivel(el) {
                                var r = el.getBoundingClientRect();
                                if (r.width <= 0 || r.height <= 0) return false;
                                var st = window.getComputedStyle(el);
                                return st.visibility !== 'hidden' && st.display !== 'none';
                              }
                              var radios = Array.prototype.slice.call(document.querySelectorAll('input[type="radio"]')).filter(visivel);
                              var el = radios[idxAlvo];
                              if (!el) return false;
                              // v24.39: NAO clicar - testes confirmaram que clicar aqui reseta Marca/Modelo/Versao para vazio
                              // e as opcoes nunca sao recarregadas (fica 'sem_opcoes' mesmo esperando). Ano de fabricacao
                              // tambem nunca apareceu como erro obrigatorio bloqueando o avanco nos testes.
                              return false;
                            }, alvoAnoV5.idx), 6000, 'clicar_radio_ano').catch(function (e) { return false; });
                            diagLog.fases.push({ fase: 'clicou_radio_ano', grupo: grupoAnoV5.nomeGrupo, sub: grupoAnoV5.subIndex, valor: alvoAnoV5.value, ok: cliqueRadioV5 });
                          } catch (eRadioV5) {
                            diagLog.fases.push({ fase: 'erro_clicou_radio_ano', grupo: grupoAnoV5.nomeGrupo, erro: eRadioV5.message });
                          }
                          await new Promise(function (r) { setTimeout(r, 500); });
                        }
                      }
                    }
                  } catch (eRadiosAnoV5) {
                    diagLog.fases.push({ fase: 'erro_radios_ano', erro: eRadiosAnoV5.message });
                  }

                  if (estadoV5.marca || estamosEmDadosDoVeiculo) {
                preencheuV5.tentou = true;
                try {
                  const opcoesMarcaV5 = await comTimeout(frameFandi.evaluate(function () {
                    var sel = document.getElementById('opo_slctMarca');
                    return sel ? Array.prototype.slice.call(sel.options).map(function (o) { return { value: o.value, text: o.textContent.trim() }; }).filter(function (o) { return o.value; }) : [];
                  }), 6000, 'opcoes_marca').catch(function () { return []; });
                  preencheuV5.opcoesMarca = opcoesMarcaV5.slice(0, 5);

                  if (opcoesMarcaV5.length) {
                    try {
                                            preencheuV5.marcaDiag = await selecionarSelect2(frameFandi, 'opo_slctMarca', comTimeout);
                    } catch (eSelMarca) {
                      preencheuV5.erroSelectMarca = eSelMarca.message;
                      try { frameFandi = await obterFrameFandi(page); preencheuV5.frameReobtido = true; } catch (eReobter) { preencheuV5.erroReobterFrame = eReobter.message; }
                    }
                    await new Promise(function (r) { setTimeout(r, 1800); });

                    const opcoesModeloV5 = await comTimeout(frameFandi.evaluate(function () {
                      var sel = document.getElementById('opo_slctModelo');
                      return sel ? Array.prototype.slice.call(sel.options).map(function (o) { return { value: o.value, text: o.textContent.trim() }; }).filter(function (o) { return o.value; }) : [];
                    }), 6000, 'opcoes_modelo').catch(function () { return []; });
                    preencheuV5.opcoesModelo = opcoesModeloV5.slice(0, 5);

                    if (opcoesModeloV5.length) {
                      try {
                                              preencheuV5.modeloDiag = await selecionarSelect2(frameFandi, 'opo_slctModelo', comTimeout);
                      } catch (eSelModelo) {
                        preencheuV5.erroSelectModelo = eSelModelo.message;
                      }
                      await new Promise(function (r) { setTimeout(r, 1800); });

                      const opcoesVersaoV5 = await comTimeout(frameFandi.evaluate(function () {
                        var sel = document.getElementById('opo_slctVersao');
                        return sel ? Array.prototype.slice.call(sel.options).map(function (o) { return { value: o.value, text: o.textContent.trim() }; }).filter(function (o) { return o.value; }) : [];
                      }), 6000, 'opcoes_versao').catch(function () { return []; });
                      preencheuV5.opcoesVersao = opcoesVersaoV5.slice(0, 5);

                      if (opcoesVersaoV5.length) {
                        try {
                                                preencheuV5.versaoDiag = await selecionarSelect2(frameFandi, 'opo_slctVersao', comTimeout);
                        } catch (eSelVersao) {
                          preencheuV5.erroSelectVersao = eSelVersao.message;
                        }
                        await new Promise(function (r) { setTimeout(r, 800); });
                      }
                    }
                  }

                                    try {
                    const checkPosSelecaoV5 = await comTimeout(frameFandi.evaluate(function () {
                      function valorDe(id) { var el = document.getElementById(id); return el ? el.value : undefined; }
                      return { marca: valorDe('opo_slctMarca'), modelo: valorDe('opo_slctModelo'), versao: valorDe('opo_slctVersao') };
                    }), 4000, 'check_pos_selecao').catch(function (e) { return { erro: e.message }; });
                    diagLog.fases.push({ fase: 'check_pos_selecao_veiculo', valores: checkPosSelecaoV5 });
                  } catch (eCheckPos) {}

async function preencheTextoV5(id, valor) {
                    return await comTimeout(frameFandi.evaluate(function (id2, valor2) {
                      var el = document.getElementById(id2);
                      if (!el) return false;
                      el.focus();
                      var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                      setter.call(el, valor2);
                      el.dispatchEvent(new Event('input', { bubbles: true }));
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                      el.blur();
                      return true;
                    }, id, valor), 6000, 'preenche_campo').catch(function () { return false; });
                  }

                  preencheuV5.km = await preencheTextoV5('mediaKmAno', '12000');
                  try { preencheuV5.quilometragem = await digitarCampoPorRotulo(frameFandi, 'quilometragem', '45000'); } catch (eQuilo) { preencheuV5.erroQuilometragem = eQuilo.message; }
                  try { preencheuV5.valorVeiculo = await preencherCampoPorRotuloNativo(frameFandi, 'valor do veiculo', '50000'); } catch (eValor) { preencheuV5.erroValorVeiculo = eValor.message; }



                                    try {
                    const reforcoCheckV5 = await comTimeout(frameFandi.evaluate(function () {
                      function valorDe(id) { var el = document.getElementById(id); return el ? el.value : undefined; }
                      return { marca: valorDe('opo_slctMarca'), modelo: valorDe('opo_slctModelo'), versao: valorDe('opo_slctVersao') };
                    }), 4000, 'reforco_check').catch(function (e) { return { erro: e.message }; });
                    const reforcoResultadoV5 = { antes: reforcoCheckV5 };
                    if (reforcoCheckV5 && (!reforcoCheckV5.marca || !reforcoCheckV5.modelo || !reforcoCheckV5.versao)) {
                      reforcoResultadoV5.reselecionou = true;
                      try {
                        async function esperarOpcoesV5(idCampo, tentativasMax) {
                          for (let tOp = 0; tOp < tentativasMax; tOp++) {
                            const qtd = await comTimeout(frameFandi.evaluate(function (idC) {
                              var sel = document.getElementById(idC);
                              return sel ? sel.options.length : 0;
                            }, idCampo), 3000, 'esperar_opcoes').catch(function () { return 0; });
                            if (qtd > 1) return qtd;
                            await new Promise(function (r) { setTimeout(r, 1000); });
                          }
                          return 0;
                        }
                        if (!reforcoCheckV5.marca) {
                          reforcoResultadoV5.qtdOpcoesMarcaAntes = await esperarOpcoesV5('opo_slctMarca', 6);
                          reforcoResultadoV5.marcaDiag2 = await selecionarSelect2(frameFandi, 'opo_slctMarca', comTimeout);
                          await new Promise(function (r) { setTimeout(r, 1500); });
                        }
                        if (!reforcoCheckV5.modelo) {
                          reforcoResultadoV5.qtdOpcoesModeloAntes = await esperarOpcoesV5('opo_slctModelo', 6);
                          reforcoResultadoV5.modeloDiag2 = await selecionarSelect2(frameFandi, 'opo_slctModelo', comTimeout);
                          await new Promise(function (r) { setTimeout(r, 1500); });
                        }
                        if (!reforcoCheckV5.versao) {
                          reforcoResultadoV5.qtdOpcoesVersaoAntes = await esperarOpcoesV5('opo_slctVersao', 6);
                          reforcoResultadoV5.versaoDiag2 = await selecionarSelect2(frameFandi, 'opo_slctVersao', comTimeout);
                          await new Promise(function (r) { setTimeout(r, 1500); });
                        }
                      } catch (eReforcoV5) { reforcoResultadoV5.erroReforco = eReforcoV5.message; }
                    } else {
                      reforcoResultadoV5.reselecionou = false;
                    }
                    diagLog.fases.push({ fase: 'reforco_veiculo_pos_ano', resultado: reforcoResultadoV5 });
                  } catch (eReforcoOuterV5) {
                    diagLog.fases.push({ fase: 'erro_reforco_veiculo', erro: eReforcoOuterV5.message });
                  }

                  const clicouProximaV5 = await comTimeout(clicarPorTexto(frameFandi, 'Próxima'), 6000, 'clicar_proxima').catch(function () { return false; });
                  preencheuV5.clicouProxima = clicouProximaV5;
                  await new Promise(function (r) { setTimeout(r, 1500); });
                } catch (eFillV5) {
                  preencheuV5.erro = eFillV5.message;
                }
              }
              diagLog.fases.push({ fase: 'preenchimento_veiculo', resultado: preencheuV5 });

              let estruturaFinalV5 = null;
              try {
                estruturaFinalV5 = await comTimeout(frameFandi.evaluate(function () {
                  function visivel(el) {
                    var r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return false;
                    var st = window.getComputedStyle(el);
                    return st.visibility !== 'hidden' && st.display !== 'none';
                  }
                  var campos = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea')).map(function (el) {
                    return { tag: el.tagName, id: el.id || null, name: el.name || null, visible: visivel(el) };
                  }).filter(function (c) { return c.visible; });
                  var botoesFinais = Array.prototype.slice.call(document.querySelectorAll('button, a[role="button"], [type="submit"]')).map(function (b) {
                    return { text: (b.textContent || '').trim().slice(0, 40) };
                  }).filter(function (b) { return b.text && /enviar|concluir|finalizar|pr[oó]xima/i.test(b.text); });
                  return { camposVisiveis: campos.slice(0, 30), botoesFinais: botoesFinais, errosVisiveis: (function () { var els = Array.prototype.slice.call(document.querySelectorAll('body *')); function rotuloProximo(elAlvo) { var idxEl = els.indexOf(elAlvo); if (idxEl === -1) return null; for (var k = idxEl - 1; k >= 0 && k > idxEl - 60; k--) { var node = els[k]; if (node.children && node.children.length > 0) continue; var tt = (node.textContent || '').trim(); if (!tt || tt.length > 60) continue; if (/obrigat[o\u00f3]rio|informe um valor|selecione uma op/i.test(tt)) continue; return tt; } return null; } var out = []; for (var i = 0; i < els.length; i++) { var t = (els[i].textContent || '').trim(); if (t && t.length < 60 && /obrigat[o\u00f3]rio|informe um valor|selecione uma op/i.test(t) && els[i].children.length === 0) { out.push({ texto: t, visivel: visivel(els[i]), rotulo: rotuloProximo(els[i]), campoInfo: (function () { var idxEl2 = els.indexOf(els[i]); for (var k2 = idxEl2 - 1; k2 >= 0 && k2 > idxEl2 - 80; k2--) { var node2 = els[k2]; if (node2.tagName === 'SELECT' || node2.tagName === 'INPUT') { var parentEl = node2.parentElement; return { tag: node2.tagName, id: node2.id || null, className: node2.className || null, ariaInvalid: node2.getAttribute('aria-invalid'), ngReflectInvalid: node2.getAttribute('ng-reflect-invalid'), dataVal: node2.getAttribute('data-val'), parentClassName: parentEl ? parentEl.className : null, valorAtual: node2.value || null }; } } return null; })() }); } } return out.slice(0, 20); })() };
                }), 6000, 'estrutura_final').catch(function (e) { return { erro: e.message }; });
              } catch (eEstruturaV5) { estruturaFinalV5 = { erro: eEstruturaV5.message }; }
              diagLog.fases.push({ fase: 'estrutura_final', estrutura: estruturaFinalV5 });

              const txtFinalV5 = await comTimeout(corpoTextoV5(), 6000, 'corpo_final').catch(function () { return ''; });
              diagLog.trechoFinal = txtFinalV5.slice(0, 3000);
              try { diagLog.urlFinal = frameFandi.url(); } catch (eUrlV5) { diagLog.urlFinal = 'erro: ' + eUrlV5.message; }
            }


            async function executarPasso4ComSeguranca() {
              diagLog.fases.push({ fase: 'inicio_passo4', ts: Date.now() });
              await new Promise(function (r) { setTimeout(r, 2000); });

              let calcularResultadoV5 = { tentou: false };
              try {
                calcularResultadoV5.tentou = true;
                calcularResultadoV5.clicou = await comTimeout(clicarPorTexto(frameFandi, 'Calcular'), 6000, 'clicar_calcular').catch(function () { return false; });
              } catch (eCalcV5) { calcularResultadoV5.erro = eCalcV5.message; }
              diagLog.fases.push({ fase: 'clique_calcular', resultado: calcularResultadoV5 });

              let snapshotsCalculoV5 = [];
              let calculoTerminouV5 = false;
              for (let tentCalcV5 = 0; tentCalcV5 < 6; tentCalcV5++) {
                await new Promise(function (r) { setTimeout(r, 2500); });
                let snapV5 = null;
                try {
                  snapV5 = await comTimeout(frameFandi.evaluate(function () {
                    var txt = document.body.innerText || '';
                    var semPlanos = txt.indexOf('Nao existem planos') !== -1 || txt.indexOf('Não existem planos') !== -1;
                    var idxParc = txt.indexOf('parcelas de');
                    var trechoParc = idxParc !== -1 ? txt.slice(idxParc, idxParc + 40) : '';
                    var temValorReal = idxParc !== -1 && trechoParc.indexOf('R$') !== -1 && trechoParc.indexOf('R$ 0,00') === -1 && trechoParc.indexOf('R$\n0,00') === -1;
                    return { semPlanos: semPlanos, trechoParc: trechoParc, temValorReal: temValorReal };
                  }), 4000, 'snapshot_calculo_' + tentCalcV5).catch(function (e) { return { erro: e.message }; });
                } catch (eSnapV5) { snapV5 = { erro: eSnapV5.message }; }
                snapshotsCalculoV5.push(snapV5);
                if (snapV5 && snapV5.temValorReal) { calculoTerminouV5 = true; break; }
                if (snapV5 && snapV5.semPlanos && tentCalcV5 >= 2) { break; }
              }
              diagLog.fases.push({ fase: 'aguardo_calculo_passo4', snapshots: snapshotsCalculoV5, terminouDetectado: calculoTerminouV5 });

              try {
                await comTimeout(frameFandi.evaluate(function () { window.scrollTo(0, document.body.scrollHeight); }), 3000, 'scroll_baixo').catch(function () { });
              } catch (eScrollV5) { }

              let enviarResultadoV5 = { tentou: false, pulou: false };
              if (!calculoTerminouV5) {
                enviarResultadoV5.pulou = true;
                enviarResultadoV5.motivo = 'calculo_nao_concluido';
              } else {
                try {
                  enviarResultadoV5.tentou = true;
                  enviarResultadoV5.clicou = await comTimeout(clicarPorTexto(frameFandi, 'Enviar'), 6000, 'clicar_enviar').catch(function () { return false; });
                  await new Promise(function (r) { setTimeout(r, 2000); });
                } catch (eEnvV5) { enviarResultadoV5.erro = eEnvV5.message; }
              }
              diagLog.fases.push({ fase: 'clique_enviar_passo4', resultado: enviarResultadoV5 });

              const txtFinalPasso4V5 = await comTimeout(corpoTextoV5(), 5000, 'corpo_final_passo4').catch(function () { return ''; });
              diagLog.trechoFinalPasso4 = txtFinalPasso4V5.slice(0, 2000);
              try { diagLog.urlFinalPasso4 = frameFandi.url(); } catch (eUrlP4V5) { diagLog.urlFinalPasso4 = 'erro: ' + eUrlP4V5.message; }

              return { calculoConcluido: calculoTerminouV5, enviouClique: !!(enviarResultadoV5 && enviarResultadoV5.clicou) };
            }

            let travouV5 = false;
            try {
              await comTimeout(executarPasso3ComSeguranca(), 100000, 'geral_passo3');
            } catch (eGeralV5) {
              travouV5 = true;
              diagLog.fases.push({ fase: 'timeout_geral', erro: eGeralV5.message });
            }


            let resultadoPasso4V5 = null;
            if (!travouV5) {
              try {
                resultadoPasso4V5 = await comTimeout(executarPasso4ComSeguranca(), 90000, 'geral_passo4');
              } catch (eGeralP4V5) {
                diagLog.fases.push({ fase: 'timeout_geral_passo4', erro: eGeralP4V5.message });
              }
            }

const diagnosticoTxt = JSON.stringify(diagLog).slice(0, 30000);

            const passo4SucessoV5 = !!(resultadoPasso4V5 && resultadoPasso4V5.calculoConcluido && resultadoPasso4V5.enviouClique && diagLog.urlFinalPasso4 && diagLog.urlFinalPasso4.indexOf('OperacaoFinanciada360Form') === -1);
            const statusFinalV5 = passo4SucessoV5 ? 'enviada' : 'erro';
            const mensagemFinalV5 = passo4SucessoV5
              ? 'Ficha enviada com sucesso ao Fandi (calculo e envio concluidos automaticamente no Passo 4). Confira em Ver no Fandi.'
              : 'Cliente localizado/criado no Fandi (Passo 2 concluido). O robo tentou avancar o Passo 3 e 4 automaticamente com protecao contra travamentos. Verifique erro_tecnico para ver ate onde chegou. Clique em Abrir Fandi pra conferir/terminar (Condicoes da venda + Enviar), ja logado.';

            await pool.query(
              "UPDATE fichas SET status='erro', erro=$1, erro_tecnico=$2, fandi_url=$3 WHERE fandi_id=$4",
              "UPDATE fichas SET status=$1, erro=$2, erro_tecnico=$3, fandi_url=$4 WHERE fandi_id=$5",
              [
                'Cliente localizado/criado no Fandi (Passo 2 concluido). O robo tentou avancar o Passo 3 automaticamente com protecao contra travamentos. Verifique erro_tecnico para ver ate onde chegou. Clique em Abrir Fandi pra conferir/terminar (Condicoes da venda + Enviar), ja logado.',
                statusFinalV5,
                mensagemFinalV5,
                'DIAGNOSTICO_V5: ' + diagnosticoTxt,
                urlParada,
                fandi_id
              ]
            );
            console.log('[PUPPETEER] Ficha levada ate o Passo 2 no Fandi (tentativa V5, protegida contra travamento):', fandi_id, urlParada, 'travou=' + travouV5);
            try { if (page && !page.isClosed()) { await page.close(); } } catch (eCloseV5) {}
            await browser.close();
            return;
} catch (err) {
      try { if (page && !page.isClosed()) { await page.close(); } } catch (e) {}
      try { if (browser) { await browser.close(); } } catch (e) {}

                  console.error('[ERRO] tentativa ' + tentativa + ' - ' + fandi_id + ': ' + err.message);
                  if (browser) { try { await browser.close(); } catch (e) {} }
                  if (tentativa === MAX_TENTATIVAS) {
                        await pool.query('UPDATE fichas SET status=\'erro\', erro=$1, erro_tecnico=$2 WHERE fandi_id=$3', [erroAmigavel(err.message), err.message, fandi_id]);
                  } else {
                        await new Promise(function (r) { setTimeout(r, 3000); });
                  }
            }
      }
}
app.get('/api/fichas', exigePin, async function (req, res) {
      try {
            const result = await pool.query('SELECT * FROM fichas ORDER BY criado_em DESC LIMIT 200');
            const lista = result.rows.map(function (r) {
                  return {
                        fandi_id: r.fandi_id, cpf: r.cpf, name: r.name, mother: r.mother, phone: r.phone,
                        salary: r.salary, cep: r.cep, address: r.address, neighborhood: r.neighborhood,
                        status: r.status, fandiUrl: r.fandi_url, erro: r.erro, criadoEm: r.criado_em
                  };
            });
            res.json({ success: true, total: lista.length, fichas: lista });
      } catch (err) {
            res.json({ success: false, message: err.message, fichas: [] });
      }
});

app.get('/api/status/:fandi_id', exigePin, async function (req, res) {
      try {
            const result = await pool.query('SELECT * FROM fichas WHERE fandi_id=$1', [req.params.fandi_id]);
            if (!result.rows.length) return res.json({ success: false, message: 'Nao encontrada' });
            const r = result.rows[0];
            res.json({
                  success: true, ficha: {
                        fandi_id: r.fandi_id, cpf: r.cpf, name: r.name, status: r.status,
                        fandiUrl: r.fandi_url, erro: r.erro, criadoEm: r.criado_em
                  }
            });
      } catch (err) {
            res.json({ success: false, message: err.message });
      }
});

// ---------- ATUALIZAR DADOS DA FICHA (v17.1) ----------
// Completa dados que faltavam na hora do envio (telefone, renda, cep,
// endereco, bairro) quando o vendedor descobre isso depois, manualmente.
// So atualiza os campos enviados no corpo; nunca mexe em cpf/name/mother/status.
app.post('/api/fichas/:fandi_id/atualizar', exigePin, async function (req, res) {
try {
var campos = ['phone', 'salary', 'cep', 'address', 'neighborhood'];
var sets = [];
var valores = [];
var i = 1;
var usados = [];
campos.forEach(function (campo) {
if (req.body && req.body[campo] !== undefined && req.body[campo] !== null) {
sets.push(campo + '=$' + i);
valores.push(String(req.body[campo]));
usados.push(campo);
i++;
}
});
if (!sets.length) return res.json({ success: false, message: 'Nenhum campo valido para atualizar (use phone, salary, cep, address ou neighborhood).' });
valores.push(req.params.fandi_id);
var r = await pool.query('UPDATE fichas SET ' + sets.join(', ') + ' WHERE fandi_id=$' + i, valores);
if (!r.rowCount) return res.json({ success: false, message: 'Ficha nao encontrada.' });
res.json({ success: true, message: 'Ficha atualizada.', campos: usados });
} catch (err) {
res.json({ success: false, message: 'Erro ao atualizar: ' + err.message });
}
});

app.get('/api/config', function (req, res) {
res.json({ destinatarios: EMAIL_DESTINATARIOS, versao: '15.0', protegido: !!PIN, pinAusente: !PIN, variaveisParecidas: NOMES_PARECIDOS });
});

// Modo demonstracao: cria uma ficha FICTICIA. Nao abre o Fandi, nao envia nada.
app.post('/api/submit-demo', async function (req, res) {
const fandi_id = 'DEMO-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
const nome = 'Cliente Demonstracao';
const cpf = '000.000.000-00';
const url = '/demo-fandi.html?id=' + encodeURIComponent(fandi_id) + '&nome=' + encodeURIComponent(nome) + '&cpf=' + encodeURIComponent(cpf);
try {
await pool.query(
'INSERT INTO fichas (fandi_id, cpf, name, mother, phone, salary, cep, address, neighborhood, status, fandi_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
[fandi_id, cpf, nome, 'Mae Demonstracao', '(00) 00000-0000', '0', '00000-000', 'Rua Exemplo, 100', 'Centro', 'demo', url]
);
res.json({ success: true, fandi_id: fandi_id, fandiUrl: url, message: 'Ficha de demonstracao criada. Nada foi enviado ao Fandi.' });
} catch (err) {
console.error('[DEMO ERRO]', err.message);
res.json({ success: false, message: 'Erro ao criar demonstracao: ' + err.message });
}
});

// ---------- DIAGNOSTICO -
