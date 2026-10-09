/**
 * PRISMA — Painel de tarefas da Chapa Prisma (Grêmio Politécnico)
 *
 * Google Apps Script. Deve ser criado e implantado A PARTIR da conta
 * chapa.poli.prisma@gmail.com: é ela que envia os e-mails, recebe as
 * entregas, guarda os anexos no Drive e mantém a planilha de dados.
 *
 * Passo a passo de instalação no README.md.
 */

const CONFIG = {
  HUB_EMAIL: 'chapa.poli.prisma@gmail.com',
  SENDER_NAME: 'Chapa Prisma',
  SUBJECT_TAG: 'PRISMA',                 // todo assunto leva [PRISMA T-001]
  SPREADSHEET_NAME: 'Prisma — Tarefas (banco de dados)',
  DRIVE_FOLDER_NAME: 'Prisma — Entregas',
  SCAN_EVERY_MINUTES: 5,                 // 1, 5, 10, 15 ou 30
  SCAN_WINDOW_DAYS: 45,                  // quantos dias de e-mail olhar a cada varredura
  SEND_ACK: true,                        // responde automaticamente confirmando a entrega
  TIMEZONE: 'America/Sao_Paulo'
};

const PRIORITIES = {
  urgente: { label: 'Urgente', color: '#E8906A', rank: 0 },
  alta:    { label: 'Alta',    color: '#E0B44E', rank: 1 },
  media:   { label: 'Média',   color: '#5BB4E0', rank: 2 },
  baixa:   { label: 'Baixa',   color: '#B9BDCB', rank: 3 }
};

const STATUS_LABELS = {
  a_fazer: 'A fazer',
  em_andamento: 'Em andamento',
  verificar: 'Verificar',
  concluida: 'Concluída'
};

// Mantenha igual à lista FILE_KINDS do index.html
const FILE_KINDS = {
  pdf:          { label: 'PDF',          exts: ['pdf'] },
  imagem:       { label: 'Imagem',       exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'svg'] },
  documento:    { label: 'Documento',    exts: ['doc', 'docx', 'odt', 'rtf', 'txt'] },
  planilha:     { label: 'Planilha',     exts: ['xlsx', 'xls', 'csv', 'ods'] },
  apresentacao: { label: 'Apresentação', exts: ['pptx', 'ppt', 'odp', 'key'] },
  video:        { label: 'Vídeo',        exts: ['mp4', 'mov', 'avi', 'mkv', 'webm'] },
  audio:        { label: 'Áudio',        exts: ['mp3', 'wav', 'm4a', 'ogg'] },
  qualquer:     { label: 'Qualquer arquivo', exts: ['*'] }
};

const TABLES = {
  pessoas:     ['id', 'nome', 'email', 'cargo', 'criadoEm'],
  tarefas:     ['id', 'codigo', 'titulo', 'descricao', 'prioridade', 'status', 'responsaveis', 'prazo',
                'tiposArquivo', 'extensoes', 'confirmados', 'entregas', 'criadoEm', 'atualizadoEm', 'concluidoEm'],
  mensagens:   ['id', 'para', 'assunto', 'corpo', 'enviadoEm'],
  eventos:     ['id', 'tarefaId', 'tipo', 'texto', 'quando'],
  processados: ['messageId', 'quando']
};
const JSON_COLS = new Set(['responsaveis', 'tiposArquivo', 'extensoes', 'confirmados', 'entregas', 'para']);

/* =========================================================================
 * Web app
 * ========================================================================= */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Prisma — Tarefas')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * API JSON para o painel hospedado fora do Apps Script (GitHub Pages).
 * O navegador chama sem cookies do Google, então funciona mesmo com várias
 * contas logadas. Corpo (text/plain): {"fn":"apiBootstrap","args":["<token>"]}
 */
function doPost(e) {
  const API = {
    apiLogin: apiLogin, apiBootstrap: apiBootstrap, apiSavePeople: apiSavePeople,
    apiDeletePerson: apiDeletePerson, apiSaveTask: apiSaveTask, apiDeleteTask: apiDeleteTask,
    apiSetStatus: apiSetStatus, apiResend: apiResend, apiSendMessage: apiSendMessage, apiScanNow: apiScanNow
  };
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API[req.fn];
    if (!fn) throw new Error('Função desconhecida.');
    out = { ok: true, data: fn.apply(null, Array.isArray(req.args) ? req.args : []) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================================
 * Instalação — rode UMA vez pelo editor (menu ▶ Executar › setup)
 * ========================================================================= */

function setup() {
  const ss = getSpreadsheet_();
  const folder = getFolder_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scanInbox')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('scanInbox').timeBased().everyMinutes(CONFIG.SCAN_EVERY_MINUTES).create();

  const me = Session.getEffectiveUser().getEmail();
  Logger.log('Planilha de dados: ' + ss.getUrl());
  Logger.log('Pasta de entregas: ' + folder.getUrl());
  Logger.log('Varredura da caixa de entrada a cada ' + CONFIG.SCAN_EVERY_MINUTES + ' minutos: ativada.');
  if (!PropertiesService.getScriptProperties().getProperty('PANEL_PASSWORD')) {
    Logger.log('FALTA A SENHA: em Configurações do projeto › Propriedades do script, adicione PANEL_PASSWORD.');
  }
  if (me.toLowerCase() !== CONFIG.HUB_EMAIL) {
    Logger.log('ATENÇÃO: este projeto está rodando como ' + me + ', não como ' + CONFIG.HUB_EMAIL +
      '. Os e-mails sairão desta conta e as entregas só serão lidas nesta caixa de entrada.');
  }
}

/**
 * Diagnóstico — rode pelo editor (▶ Executar › testarEmail).
 * Envia um e-mail de teste para a última pessoa cadastrada (ou para a própria conta)
 * e mostra no registro a cota restante ou o erro exato do Google.
 */
function testarEmail() {
  const people = readTable_('pessoas');
  const to = people.length ? people[people.length - 1].email : Session.getEffectiveUser().getEmail();
  Logger.log('Conta que envia: ' + Session.getEffectiveUser().getEmail());
  Logger.log('Cota de e-mails restante hoje: ' + MailApp.getRemainingDailyQuota());
  GmailApp.sendEmail(to, '[' + CONFIG.SUBJECT_TAG + '] Teste de envio',
    'Se você recebeu este e-mail, o painel da Chapa Prisma consegue enviar tarefas.',
    { name: CONFIG.SENDER_NAME, replyTo: CONFIG.HUB_EMAIL });
  Logger.log('OK: e-mail de teste enviado para ' + to + '. Confira também a pasta Spam.');
}

/* =========================================================================
 * Acesso ao painel por senha
 *
 * O app da Web fica aberto a "Qualquer pessoa" (assim abre em qualquer
 * navegador/conta), mas toda chamada exige a senha do painel.
 * Defina a senha em: Configurações do projeto › Propriedades do script ›
 * PANEL_PASSWORD. Trocar a senha desconecta todo mundo.
 * ========================================================================= */

function apiLogin(senha) {
  const pass = PropertiesService.getScriptProperties().getProperty('PANEL_PASSWORD');
  if (!pass) {
    throw new Error('A senha do painel ainda não foi definida. No editor do Apps Script: ' +
      'Configurações do projeto › Propriedades do script › adicione PANEL_PASSWORD.');
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('LOGIN_FAILS') || 0);
  if (fails >= 10) throw new Error('Muitas tentativas erradas. Aguarde 10 minutos.');
  if (String(senha || '') !== pass) {
    cache.put('LOGIN_FAILS', String(fails + 1), 600);
    Utilities.sleep(700);
    throw new Error('Senha incorreta.');
  }
  return { token: authToken_(pass) };
}

function authToken_(pass) {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(pass, secret));
}

function requireAuth_(token) {
  const pass = PropertiesService.getScriptProperties().getProperty('PANEL_PASSWORD');
  if (!pass || !token || token !== authToken_(pass)) {
    throw new Error('AUTH: sessão expirada — entre com a senha do painel.');
  }
}

/* =========================================================================
 * API chamada pelo painel (google.script.run)
 * ========================================================================= */

function apiBootstrap(token) {
  requireAuth_(token);
  return bootstrap_();
}

/** Adiciona (sem id) ou atualiza (com id) pessoas. Aceita lista para importação em massa. */
function apiSavePeople(token, list) {
  requireAuth_(token);
  return withLock_(() => {
    const people = readTable_('pessoas');
    const r = { adicionadas: 0, atualizadas: 0, ignoradas: 0 };
    (list || []).forEach(p => {
      const nome = clean_(p.nome);
      const email = normEmail_(p.email);
      const cargo = clean_(p.cargo);
      if (!nome || !isEmail_(email)) { r.ignoradas++; return; }
      if (p.id) {
        const ex = people.find(x => x.id === p.id);
        if (!ex) { r.ignoradas++; return; }
        if (people.some(x => x.id !== p.id && x.email === email)) throw new Error('O e-mail ' + email + ' já está cadastrado.');
        Object.assign(ex, { nome: nome, email: email, cargo: cargo });
        r.atualizadas++;
      } else {
        if (people.some(x => x.email === email)) { r.ignoradas++; return; }
        people.push({ id: newId_(), nome: nome, email: email, cargo: cargo, criadoEm: nowIso_() });
        r.adicionadas++;
      }
    });
    writeTable_('pessoas', people);
    const partes = [];
    if (r.adicionadas) partes.push(r.adicionadas + (r.adicionadas > 1 ? ' pessoas adicionadas' : ' pessoa adicionada'));
    if (r.atualizadas) partes.push('dados atualizados');
    if (r.ignoradas) partes.push(r.ignoradas + ' linha(s) ignorada(s) — e-mail inválido ou já cadastrado');
    return withNotice_(partes.join(' · ') || 'Nada para salvar.');
  });
}

function apiDeletePerson(token, id) {
  requireAuth_(token);
  return withLock_(() => {
    const people = readTable_('pessoas');
    const p = people.find(x => x.id === id);
    if (!p) throw new Error('Pessoa não encontrada.');
    writeTable_('pessoas', people.filter(x => x.id !== id));
    const tasks = readTable_('tarefas');
    tasks.forEach(t => {
      t.responsaveis = t.responsaveis.filter(x => x !== id);
      t.confirmados = t.confirmados.filter(x => x !== id);
    });
    writeTable_('tarefas', tasks);
    appendRows_('eventos', [evt_('', 'pessoa', p.nome + ' foi removido(a) da equipe.')]);
    return withNotice_(p.nome + ' removido(a).');
  });
}

/** Cria ou edita uma tarefa. enviar=true manda e-mail aos (novos) responsáveis. */
function apiSaveTask(token, input, enviar) {
  requireAuth_(token);
  return withLock_(() => {
    const tasks = readTable_('tarefas');
    const people = readTable_('pessoas');
    const titulo = clean_(input.titulo);
    if (!titulo) throw new Error('Dê um título à tarefa.');
    const fields = {
      titulo: titulo,
      descricao: String(input.descricao || '').trim(),
      prioridade: PRIORITIES[input.prioridade] ? input.prioridade : 'media',
      responsaveis: unique_((input.responsaveis || []).filter(id => people.some(p => p.id === id))),
      tiposArquivo: unique_((input.tiposArquivo || []).filter(k => FILE_KINDS[k])),
      extensoes: parseExts_(input.extensoes),
      prazo: /^\d{4}-\d{2}-\d{2}$/.test(input.prazo || '') ? input.prazo : '',
      atualizadoEm: nowIso_()
    };
    const events = [];
    let task, novos;
    if (input.id) {
      task = tasks.find(t => t.id === input.id);
      if (!task) throw new Error('Tarefa não encontrada.');
      novos = fields.responsaveis.filter(id => task.responsaveis.indexOf(id) < 0);
      Object.assign(task, fields);
      task.confirmados = task.confirmados.filter(id => fields.responsaveis.indexOf(id) >= 0);
      events.push(evt_(task.id, 'editada', task.codigo + ' foi editada.'));
    } else {
      task = Object.assign({
        id: newId_(), codigo: nextCode_(tasks), status: 'a_fazer',
        confirmados: [], entregas: [], criadoEm: nowIso_(), concluidoEm: ''
      }, fields);
      tasks.push(task);
      novos = fields.responsaveis;
      events.push(evt_(task.id, 'criada', task.codigo + ' criada · prioridade ' + PRIORITIES[task.prioridade].label.toLowerCase() + '.'));
    }
    writeTable_('tarefas', tasks);

    let aviso = input.id ? 'Tarefa atualizada.' : task.codigo + ' criada.';
    if (enviar && novos.length) {
      const sent = sendTaskEmails_(task, novos, people, 'nova');
      if (sent.ok.length) events.push(evt_(task.id, 'email', 'E-mail com a tarefa enviado para ' + sent.ok.join(', ') + '.'));
      if (sent.erros.length) events.push(evt_(task.id, 'erro', 'Falha ao enviar para ' + sent.erros.join(', ') + '.'));
      aviso += sent.ok.length ? ' E-mail enviado para ' + sent.ok.join(', ') + '.' : '';
      if (sent.erros.length) aviso += ' Falhou para: ' + sent.erros.join(', ') + '.';
    }
    appendRows_('eventos', events);
    return withNotice_(aviso, { tarefaId: task.id });
  });
}

function apiDeleteTask(token, id) {
  requireAuth_(token);
  return withLock_(() => {
    const tasks = readTable_('tarefas');
    const t = tasks.find(x => x.id === id);
    if (!t) throw new Error('Tarefa não encontrada.');
    writeTable_('tarefas', tasks.filter(x => x.id !== id));
    appendRows_('eventos', [evt_('', 'excluida', t.codigo + ' (' + t.titulo + ') foi excluída.')]);
    return withNotice_(t.codigo + ' excluída.');
  });
}

/**
 * Muda o status. opts = { nota: string, notificar: boolean }
 * - verificar → em_andamento com nota = "devolver com ajustes" (avisa por e-mail)
 * - → concluida com notificar = agradece por e-mail
 */
function apiSetStatus(token, id, status, opts) {
  requireAuth_(token);
  opts = opts || {};
  return withLock_(() => {
    if (!STATUS_LABELS[status]) throw new Error('Status inválido.');
    const tasks = readTable_('tarefas');
    const people = readTable_('pessoas');
    const t = tasks.find(x => x.id === id);
    if (!t) throw new Error('Tarefa não encontrada.');
    const anterior = t.status;
    const nota = String(opts.nota || '').trim();
    t.status = status;
    t.atualizadoEm = nowIso_();
    t.concluidoEm = status === 'concluida' ? nowIso_() : '';
    const events = [];
    let aviso = t.codigo + ' → ' + STATUS_LABELS[status] + '.';

    if (status === 'concluida') {
      events.push(evt_(t.id, 'concluida', t.codigo + ' aprovada e concluída.'));
      if (opts.notificar && t.responsaveis.length) {
        const s = sendTaskEmails_(t, t.responsaveis, people, 'concluida');
        if (s.ok.length) { events.push(evt_(t.id, 'email', 'Aviso de conclusão enviado para ' + s.ok.join(', ') + '.')); aviso += ' Responsáveis avisados.'; }
      }
    } else if (anterior === 'verificar' && nota) {
      events.push(evt_(t.id, 'devolvida', t.codigo + ' devolvida com ajustes: “' + nota + '”'));
      if (t.responsaveis.length) {
        const s = sendTaskEmails_(t, t.responsaveis, people, 'devolvida', nota);
        if (s.ok.length) { events.push(evt_(t.id, 'email', 'Pedido de ajustes enviado para ' + s.ok.join(', ') + '.')); aviso += ' Pedido de ajustes enviado.'; }
      }
    } else {
      events.push(evt_(t.id, 'status', t.codigo + ': ' + STATUS_LABELS[anterior] + ' → ' + STATUS_LABELS[status] + '.'));
    }
    writeTable_('tarefas', tasks);
    appendRows_('eventos', events);
    return withNotice_(aviso);
  });
}

/** Reenvia a tarefa como lembrete (para quem ainda não entregou). */
function apiResend(token, id) {
  requireAuth_(token);
  return withLock_(() => {
    const tasks = readTable_('tarefas');
    const people = readTable_('pessoas');
    const t = tasks.find(x => x.id === id);
    if (!t) throw new Error('Tarefa não encontrada.');
    const entregaram = new Set(t.entregas.map(e => e.pessoaId).filter(Boolean));
    let alvo = t.responsaveis.filter(pid => !entregaram.has(pid));
    if (!alvo.length) alvo = t.responsaveis;
    if (!alvo.length) throw new Error('Esta tarefa não tem responsáveis.');
    const s = sendTaskEmails_(t, alvo, people, 'lembrete');
    appendRows_('eventos', [evt_(t.id, 'lembrete', 'Lembrete de ' + t.codigo + ' enviado para ' + s.ok.join(', ') + '.')]);
    return withNotice_('Lembrete enviado para ' + s.ok.join(', ') + '.');
  });
}

/** Mensagem avulsa para uma ou mais pessoas. msg = { para: [ids], assunto, corpo } */
function apiSendMessage(token, msg) {
  requireAuth_(token);
  return withLock_(() => {
    const people = readTable_('pessoas');
    const para = unique_((msg.para || []).filter(id => people.some(p => p.id === id)));
    const assunto = clean_(msg.assunto);
    const corpo = String(msg.corpo || '').trim();
    if (!para.length) throw new Error('Escolha pelo menos uma pessoa.');
    if (!assunto || !corpo) throw new Error('Preencha assunto e mensagem.');
    const ok = [], erros = [];
    para.forEach(pid => {
      const p = people.find(x => x.id === pid);
      const html = emailShell_(
        '<p style="margin:0 0 16px;font-size:16px">Olá, ' + esc_(firstName_(p.nome)) + '!</p>' +
        '<div style="font-size:15px;line-height:1.6;color:#1B2340">' + nl2br_(esc_(corpo)) + '</div>' +
        '<p style="margin:24px 0 0;font-size:13px;color:#5A607A">Responda este e-mail para falar com a chapa.</p>');
      const text = 'Olá, ' + firstName_(p.nome) + '!\n\n' + corpo + '\n\n— ' + CONFIG.SENDER_NAME + ' · ' + CONFIG.HUB_EMAIL;
      try {
        GmailApp.sendEmail(p.email, '[' + CONFIG.SUBJECT_TAG + '] ' + assunto, text,
          { htmlBody: html, name: CONFIG.SENDER_NAME, replyTo: CONFIG.HUB_EMAIL });
        ok.push(p.nome);
      } catch (e) { erros.push(p.nome + ' (' + errMsg_(e) + ')'); }
    });
    appendRows_('mensagens', [{ id: newId_(), para: para, assunto: assunto, corpo: corpo, enviadoEm: nowIso_() }]);
    appendRows_('eventos', [evt_('', 'mensagem', 'Mensagem “' + assunto + '” enviada para ' + ok.join(', ') + '.')]);
    let aviso = 'Mensagem enviada para ' + ok.join(', ') + '.';
    if (erros.length) aviso += ' Falhou para: ' + erros.join(', ') + '.';
    return withNotice_(aviso);
  });
}

/** Botão "Verificar caixa" do painel. */
function apiScanNow(token) {
  requireAuth_(token);
  return withLock_(() => {
    const r = scanInbox_();
    const partes = [];
    if (r.entregas) partes.push(r.entregas + ' entrega(s) recebida(s)');
    if (r.inicios) partes.push(r.inicios + ' início(s) confirmado(s)');
    if (r.recusas) partes.push(r.recusas + ' arquivo(s) no formato errado');
    if (r.respostas) partes.push(r.respostas + ' resposta(s)');
    return withNotice_(partes.length ? partes.join(' · ') + '.' : 'Nenhuma novidade na caixa de entrada.');
  });
}

/* =========================================================================
 * Varredura da caixa de entrada (gatilho a cada N minutos)
 * ========================================================================= */

function scanInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try { scanInbox_(); } finally { lock.releaseLock(); }
}

function scanInbox_() {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const hub = CONFIG.HUB_EMAIL.toLowerCase();
  const processed = new Set(readTable_('processados').map(r => r.messageId));
  const tasks = readTable_('tarefas');
  const people = readTable_('pessoas');
  const byCode = {};
  tasks.forEach(t => { byCode[t.codigo.toUpperCase()] = t; });

  const r = { entregas: 0, inicios: 0, recusas: 0, respostas: 0 };
  const newProcessed = [], events = [];
  let changed = false;

  const threads = GmailApp.search('subject:' + CONFIG.SUBJECT_TAG + ' newer_than:' + CONFIG.SCAN_WINDOW_DAYS + 'd', 0, 200);
  threads.forEach(thread => thread.getMessages().forEach(msg => {
    const mid = msg.getId();
    if (processed.has(mid)) return;
    const from = extractEmail_(msg.getFrom());
    if (from === me || from === hub) return; // nossos próprios envios
    newProcessed.push({ messageId: mid, quando: nowIso_() });

    const m = String(msg.getSubject() || '').match(/T-(\d{1,6})/i);
    if (!m) return;
    const task = byCode['T-' + (m[1].length < 3 ? ('000' + m[1]).slice(-3) : m[1])];
    if (!task || task.status === 'concluida') return;
    if (task.criadoEm && msg.getDate() < new Date(task.criadoEm)) return;

    const person = people.find(p => p.email === from);
    const nome = person ? person.nome : from;
    const allowed = allowedExts_(task);
    const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
    const body = stripQuoted_(msg.getPlainBody() || '');
    const head = normalize_(body.slice(0, 400));
    const disseInicio = /\b(comecar|comecei|comecando|iniciar|iniciei|iniciando|aceito|ciente)\b/.test(head);
    const disseEntrega = /\b(entregue|entrego|entreguei|feito|feita|concluido|concluida|pronto|pronta|finalizado|finalizei|segue)\b/.test(head);

    const registrarEntrega = (arquivos) => {
      task.entregas.push({
        id: newId_(), pessoaId: person ? person.id : '', de: from, nome: nome,
        quando: msg.getDate().toISOString(), arquivos: arquivos, mensagem: body.slice(0, 600)
      });
      if (person && task.confirmados.indexOf(person.id) < 0) task.confirmados.push(person.id);
      task.status = 'verificar';
      task.atualizadoEm = nowIso_();
      changed = true;
      r.entregas++;
      const n = arquivos.filter(a => a.valido).length;
      events.push(evt_(task.id, 'entrega', nome + ' entregou ' + task.codigo +
        (n ? ' (' + n + ' arquivo' + (n > 1 ? 's' : '') + ')' : '') + ' — aguardando verificação.'));
      if (CONFIG.SEND_ACK) safeReply_(msg, ackEmail_(task, nome, arquivos));
    };

    if (allowed.length) {
      if (atts.length) {
        const validos = atts.filter(a => extAllowed_(a.getName(), allowed));
        if (validos.length) {
          const folder = getTaskFolder_(task);
          const arquivos = atts.map(a => {
            const f = folder.createFile(a.copyBlob()).setName(task.codigo + ' · ' + nome + ' · ' + a.getName());
            return { nome: a.getName(), url: f.getUrl(), valido: extAllowed_(a.getName(), allowed) };
          });
          registrarEntrega(arquivos);
        } else {
          r.recusas++;
          events.push(evt_(task.id, 'recusada', nome + ' enviou ' + atts.map(a => a.getName()).join(', ') +
            ' para ' + task.codigo + ', mas o formato esperado é ' + expectedLabel_(task) + '.'));
          safeReply_(msg, wrongTypeEmail_(task, nome, atts.map(a => a.getName())));
        }
      } else if (disseEntrega) {
        r.recusas++;
        events.push(evt_(task.id, 'recusada', nome + ' respondeu ' + task.codigo + ' sem anexo.'));
        safeReply_(msg, missingAttachmentEmail_(task, nome));
      } else if (disseInicio) {
        markStarted_(task, person, nome, events); changed = true; r.inicios++;
      } else {
        r.respostas++;
        events.push(evt_(task.id, 'resposta', nome + ' respondeu ' + task.codigo + ': “' + body.slice(0, 160).replace(/\s+/g, ' ').trim() + '”'));
      }
    } else {
      // Tarefa sem arquivo: basta responder ENTREGUE / FEITO
      if (disseEntrega || atts.length) {
        const arquivos = [];
        if (atts.length) {
          const folder = getTaskFolder_(task);
          atts.forEach(a => {
            const f = folder.createFile(a.copyBlob()).setName(task.codigo + ' · ' + nome + ' · ' + a.getName());
            arquivos.push({ nome: a.getName(), url: f.getUrl(), valido: true });
          });
        }
        registrarEntrega(arquivos);
      } else if (disseInicio) {
        markStarted_(task, person, nome, events); changed = true; r.inicios++;
      } else {
        r.respostas++;
        events.push(evt_(task.id, 'resposta', nome + ' respondeu ' + task.codigo + ': “' + body.slice(0, 160).replace(/\s+/g, ' ').trim() + '”'));
      }
    }
  }));

  if (changed) writeTable_('tarefas', tasks);
  appendRows_('eventos', events);
  appendRows_('processados', newProcessed);
  pruneProcessed_();
  PropertiesService.getScriptProperties().setProperty('LAST_SCAN', nowIso_());
  return r;
}

function markStarted_(task, person, nome, events) {
  if (person && task.confirmados.indexOf(person.id) < 0) task.confirmados.push(person.id);
  if (task.status === 'a_fazer') task.status = 'em_andamento';
  task.atualizadoEm = nowIso_();
  events.push(evt_(task.id, 'inicio', nome + ' começou a trabalhar em ' + task.codigo + '.'));
}

/* =========================================================================
 * E-mails
 * ========================================================================= */

function sendTaskEmails_(task, personIds, people, kind, nota) {
  const ok = [], erros = [];
  personIds.forEach(pid => {
    const p = people.find(x => x.id === pid);
    if (!p) return;
    const mail = taskEmail_(task, p, people, kind, nota);
    try {
      GmailApp.sendEmail(p.email, mail.subject, mail.text,
        { htmlBody: mail.html, name: CONFIG.SENDER_NAME, replyTo: CONFIG.HUB_EMAIL });
      ok.push(p.nome);
    } catch (e) {
      Logger.log('Falha ao enviar para ' + p.email + ': ' + errMsg_(e));
      erros.push(p.nome + ' (' + errMsg_(e) + ')');
    }
  });
  return { ok: ok, erros: erros };
}

function taskEmail_(task, person, people, kind, nota) {
  const pr = PRIORITIES[task.prioridade] || PRIORITIES.media;
  const tag = '[' + CONFIG.SUBJECT_TAG + ' ' + task.codigo + ']';
  const subjects = {
    nova: tag + ' ' + task.titulo,
    lembrete: tag + ' Lembrete: ' + task.titulo,
    devolvida: tag + ' Ajustes necessários: ' + task.titulo,
    concluida: tag + ' Concluída: ' + task.titulo
  };
  const intros = {
    nova: 'Você foi designado(a) para uma tarefa da Chapa Prisma.',
    lembrete: 'Passando para lembrar desta tarefa — ainda não recebemos sua entrega.',
    devolvida: 'Recebemos sua entrega, obrigado! Antes de concluir, precisamos de alguns ajustes:',
    concluida: 'Sua entrega foi verificada e a tarefa está concluída. Obrigado pelo trabalho!'
  };
  const outros = task.responsaveis.filter(id => id !== person.id)
    .map(id => (people.find(p => p.id === id) || {}).nome).filter(Boolean);
  const expects = allowedExts_(task).length > 0;
  const prazo = task.prazo ? fmtDatePt_(task.prazo) : 'sem prazo definido';

  let html = '<p style="margin:0 0 6px;font-size:16px">Olá, ' + esc_(firstName_(person.nome)) + '!</p>' +
    '<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#3A4160">' + intros[kind] + '</p>';

  if (kind === 'devolvida' && nota) {
    html += '<div style="background:#F8E1D6;border-left:4px solid #E8906A;padding:14px 16px;margin:0 0 20px;font-size:15px;line-height:1.5">' + nl2br_(esc_(nota)) + '</div>';
  }

  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:6px solid ' + pr.color + ';background:#FFFFFF;margin:0 0 20px"><tr><td style="padding:16px 18px">' +
    '<div style="font-family:\'Courier New\',monospace;font-size:12px;color:#5A607A;letter-spacing:1px">' + task.codigo + '</div>' +
    '<div style="font-size:20px;font-weight:bold;margin:4px 0 10px;color:#1B2340">' + esc_(task.titulo) + '</div>' +
    '<span style="display:inline-block;background:' + pr.color + ';color:#1B2340;font-family:\'Courier New\',monospace;font-size:11px;letter-spacing:1px;text-transform:uppercase;padding:4px 8px;font-weight:bold">' + pr.label + '</span>' +
    '<span style="font-family:\'Courier New\',monospace;font-size:12px;color:#3A4160;margin-left:10px">Prazo: ' + esc_(prazo) + '</span>' +
    (outros.length ? '<div style="font-size:13px;color:#5A607A;margin-top:10px">Junto com: ' + esc_(outros.join(', ')) + '</div>' : '') +
    '</td></tr></table>';

  if (kind !== 'concluida') {
    if (task.descricao) {
      html += sectionTitle_('O que fazer') + '<div style="font-size:15px;line-height:1.6;margin:0 0 20px">' + nl2br_(esc_(task.descricao)) + '</div>';
    }
    html += sectionTitle_('O que entregar') +
      '<div style="font-size:15px;line-height:1.6;margin:0 0 20px">' +
      (expects ? 'Arquivo: <b>' + esc_(expectedLabel_(task)) + '</b>' : 'Nenhum arquivo — só precisamos da sua confirmação.') + '</div>';
    html += sectionTitle_('Como responder') +
      '<ol style="margin:0 0 8px;padding-left:20px;font-size:15px;line-height:1.7">' +
      (kind === 'nova' ? '<li>Quando começar, responda este e-mail escrevendo <b>COMEÇAR</b> — assim a chapa sabe que você está nisso.</li>' : '') +
      (expects
        ? '<li>Ao terminar, <b>responda este e-mail anexando o arquivo</b>.</li>'
        : '<li>Ao terminar, responda este e-mail escrevendo <b>ENTREGUE</b>.</li>') +
      '<li>A resposta deve ir para <b>' + CONFIG.HUB_EMAIL + '</b> e manter <b>' + tag + '</b> no assunto (basta clicar em “Responder”).</li>' +
      '</ol>' +
      '<p style="font-size:13px;color:#5A607A;margin:0">A entrega é registrada automaticamente e vai para verificação.</p>';
  }

  const text = [
    'Olá, ' + firstName_(person.nome) + '!', '', intros[kind], '',
    kind === 'devolvida' && nota ? 'AJUSTES: ' + nota + '\n' : '',
    task.codigo + ' — ' + task.titulo,
    'Prioridade: ' + pr.label + ' · Prazo: ' + prazo,
    outros.length ? 'Junto com: ' + outros.join(', ') : '', '',
    kind !== 'concluida' && task.descricao ? 'O QUE FAZER\n' + task.descricao + '\n' : '',
    kind !== 'concluida' ? 'O QUE ENTREGAR\n' + (expects ? 'Arquivo: ' + expectedLabel_(task) : 'Nenhum arquivo — responda ENTREGUE.') + '\n' : '',
    kind !== 'concluida' ? 'COMO RESPONDER\nResponda este e-mail (para ' + CONFIG.HUB_EMAIL + ', mantendo ' + tag + ' no assunto)' +
      (kind === 'nova' ? '. Escreva COMEÇAR quando começar' : '') + (expects ? ' e anexe o arquivo ao terminar.' : ' e escreva ENTREGUE ao terminar.') : '',
    '', '— ' + CONFIG.SENDER_NAME
  ].filter(l => l !== null).join('\n');

  return { subject: subjects[kind], html: emailShell_(html), text: text };
}

function ackEmail_(task, nome, arquivos) {
  const lista = arquivos.filter(a => a.valido).map(a => a.nome);
  const html = emailShell_(
    '<p style="margin:0 0 12px;font-size:16px">Recebido, ' + esc_(firstName_(nome)) + '!</p>' +
    '<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Sua entrega para <b>' + task.codigo + ' — ' + esc_(task.titulo) + '</b> foi registrada e está em <b>verificação</b>.</p>' +
    (lista.length ? '<p style="margin:0 0 12px;font-size:14px;color:#3A4160">Arquivos: ' + esc_(lista.join(', ')) + '</p>' : '') +
    '<p style="margin:0;font-size:14px;color:#5A607A">Avisaremos se for preciso algum ajuste.</p>');
  const text = 'Recebido! Sua entrega para ' + task.codigo + ' — ' + task.titulo + ' foi registrada e está em verificação.' +
    (lista.length ? '\nArquivos: ' + lista.join(', ') : '') + '\n\n— ' + CONFIG.SENDER_NAME;
  return { text: text, html: html };
}

function wrongTypeEmail_(task, nome, recebidos) {
  const html = emailShell_(
    '<p style="margin:0 0 12px;font-size:16px">Oi, ' + esc_(firstName_(nome)) + '!</p>' +
    '<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Recebemos seu e-mail para <b>' + task.codigo + ' — ' + esc_(task.titulo) + '</b>, mas nenhum anexo está no formato esperado.</p>' +
    '<p style="margin:0 0 6px;font-size:14px">Esperado: <b>' + esc_(expectedLabel_(task)) + '</b></p>' +
    '<p style="margin:0 0 16px;font-size:14px;color:#5A607A">Recebido: ' + esc_(recebidos.join(', ')) + '</p>' +
    '<p style="margin:0;font-size:15px">Responda este e-mail novamente anexando o arquivo correto.</p>');
  const text = 'Recebemos seu e-mail para ' + task.codigo + ', mas nenhum anexo está no formato esperado (' + expectedLabel_(task) +
    '). Recebido: ' + recebidos.join(', ') + '. Responda novamente anexando o arquivo correto.\n\n— ' + CONFIG.SENDER_NAME;
  return { text: text, html: html };
}

function missingAttachmentEmail_(task, nome) {
  const html = emailShell_(
    '<p style="margin:0 0 12px;font-size:16px">Oi, ' + esc_(firstName_(nome)) + '!</p>' +
    '<p style="margin:0 0 12px;font-size:15px;line-height:1.5">Parece que você quis entregar <b>' + task.codigo + ' — ' + esc_(task.titulo) + '</b>, mas o e-mail chegou sem anexo.</p>' +
    '<p style="margin:0;font-size:15px">Responda novamente anexando: <b>' + esc_(expectedLabel_(task)) + '</b>.</p>');
  const text = 'Parece que você quis entregar ' + task.codigo + ', mas o e-mail chegou sem anexo. Responda novamente anexando: ' +
    expectedLabel_(task) + '.\n\n— ' + CONFIG.SENDER_NAME;
  return { text: text, html: html };
}

function safeReply_(msg, mail) {
  try { msg.reply(mail.text, { htmlBody: mail.html, name: CONFIG.SENDER_NAME }); } catch (e) { /* cota ou erro de envio */ }
}

function sectionTitle_(t) {
  return '<div style="font-family:\'Courier New\',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5A607A;margin:0 0 6px">' + t + '</div>';
}

function emailShell_(inner) {
  return '<div style="background:#EDEBE5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1B2340">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FAF9F6">' +
    '<tr><td style="background:#1B2340;padding:22px 28px">' +
      '<div style="font-size:24px;font-weight:bold;letter-spacing:4px;color:#F4F2EC">PRISMA</div>' +
      '<div style="font-family:\'Courier New\',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#AEB3C7;margin-top:4px">Chapa · Grêmio Politécnico</div>' +
    '</td></tr>' +
    '<tr><td style="padding:0;font-size:0;line-height:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      '<td height="6" style="background:#E8906A;font-size:0;line-height:0">&nbsp;</td>' +
      '<td height="6" style="background:#E0B44E;font-size:0;line-height:0">&nbsp;</td>' +
      '<td height="6" style="background:#5BB4E0;font-size:0;line-height:0">&nbsp;</td>' +
    '</tr></table></td></tr>' +
    '<tr><td style="padding:28px">' + inner + '</td></tr>' +
    '<tr><td style="padding:16px 28px;border-top:1px solid #DCD9D0;font-size:12px;color:#5A607A">' +
      'Enviado pelo painel de tarefas da Chapa Prisma · ' + CONFIG.HUB_EMAIL +
    '</td></tr></table></div>';
}

/* =========================================================================
 * Dados (Google Sheets) e Drive
 * ========================================================================= */

let SS_CACHE_ = null;

function getSpreadsheet_() {
  if (SS_CACHE_) return SS_CACHE_;
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  let ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(CONFIG.SPREADSHEET_NAME);
    props.setProperty('SPREADSHEET_ID', ss.getId());
  }
  Object.keys(TABLES).forEach(name => {
    if (!ss.getSheetByName(name)) {
      const sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, TABLES[name].length).setValues([TABLES[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  ss.getSheets().forEach(sh => {
    if (!TABLES[sh.getName()] && ss.getSheets().length > Object.keys(TABLES).length && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
  SS_CACHE_ = ss;
  return ss;
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recria */ } }
  const f = DriveApp.createFolder(CONFIG.DRIVE_FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}

function getTaskFolder_(task) {
  const root = getFolder_();
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf(task.codigo + ' ') === 0 || f.getName() === task.codigo) return f;
  }
  return root.createFolder(task.codigo + ' — ' + task.titulo.slice(0, 80));
}

function readTable_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const cols = TABLES[name];
  return sh.getRange(2, 1, last - 1, cols.length).getDisplayValues()
    .filter(r => r[0] !== '')
    .map(r => {
      const o = {};
      cols.forEach((c, i) => {
        let v = r[i];
        if (JSON_COLS.has(c)) { try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; } }
        o[c] = v;
      });
      return o;
    });
}

function toRow_(name, o) {
  return TABLES[name].map(c => {
    let v = o[c];
    if (JSON_COLS.has(c)) v = JSON.stringify(v || []);
    v = v == null ? '' : String(v);
    return /^[=+]/.test(v) ? "'" + v : v;
  });
}

function writeTable_(name, rows) {
  const sh = getSpreadsheet_().getSheetByName(name);
  const cols = TABLES[name].length;
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, cols).clearContent();
  if (!rows.length) return;
  const rng = sh.getRange(2, 1, rows.length, cols);
  rng.setNumberFormat('@');
  rng.setValues(rows.map(o => toRow_(name, o)));
}

function appendRows_(name, rows) {
  if (!rows || !rows.length) return;
  const sh = getSpreadsheet_().getSheetByName(name);
  const rng = sh.getRange(sh.getLastRow() + 1, 1, rows.length, TABLES[name].length);
  rng.setNumberFormat('@');
  rng.setValues(rows.map(o => toRow_(name, o)));
}

function pruneProcessed_() {
  const rows = readTable_('processados');
  if (rows.length < 4000) return;
  const limit = new Date(Date.now() - (CONFIG.SCAN_WINDOW_DAYS + 5) * 864e5).toISOString();
  writeTable_('processados', rows.filter(r => r.quando >= limit));
}

function bootstrap_() {
  const ss = getSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const eventos = readTable_('eventos').sort((a, b) => b.quando.localeCompare(a.quando));
  const mensagens = readTable_('mensagens').sort((a, b) => b.enviadoEm.localeCompare(a.enviadoEm));
  let cota = null;
  try { cota = MailApp.getRemainingDailyQuota(); } catch (e) { /* ignore */ }
  return {
    pessoas: readTable_('pessoas'),
    tarefas: readTable_('tarefas'),
    mensagens: mensagens.slice(0, 100),
    eventos: eventos.slice(0, 400),
    meta: {
      hubEmail: CONFIG.HUB_EMAIL,
      contaAtual: Session.getEffectiveUser().getEmail(),
      ultimaVerificacao: props.getProperty('LAST_SCAN') || '',
      planilhaUrl: ss.getUrl(),
      pastaUrl: getFolder_().getUrl(),
      gatilhoAtivo: ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'scanInbox'),
      intervalo: CONFIG.SCAN_EVERY_MINUTES,
      cotaEmail: cota,
      demo: false
    }
  };
}

function withNotice_(aviso, extra) {
  return Object.assign(bootstrap_(), { aviso: aviso }, extra || {});
}

/* =========================================================================
 * Utilitários
 * ========================================================================= */

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function nextCode_(tasks) {
  const props = PropertiesService.getScriptProperties();
  let n = Number(props.getProperty('NEXT_TASK_NUM') || 1);
  tasks.forEach(t => { const k = Number(String(t.codigo).replace(/\D/g, '')); if (k >= n) n = k + 1; });
  props.setProperty('NEXT_TASK_NUM', String(n + 1));
  return 'T-' + ('000' + n).slice(-Math.max(3, String(n).length));
}

function evt_(tarefaId, tipo, texto) {
  return { id: newId_(), tarefaId: tarefaId || '', tipo: tipo, texto: texto, quando: nowIso_() };
}

function allowedExts_(task) {
  const set = new Set();
  (task.tiposArquivo || []).forEach(k => (FILE_KINDS[k] ? FILE_KINDS[k].exts : []).forEach(e => set.add(e)));
  (task.extensoes || []).forEach(e => set.add(e));
  return Array.from(set);
}

function extAllowed_(filename, allowed) {
  if (allowed.indexOf('*') >= 0) return true;
  const ext = String(filename).split('.').pop().toLowerCase();
  return String(filename).indexOf('.') >= 0 && allowed.indexOf(ext) >= 0;
}

function expectedLabel_(task) {
  const parts = (task.tiposArquivo || []).filter(k => FILE_KINDS[k]).map(k =>
    k === 'qualquer' ? 'qualquer arquivo' : FILE_KINDS[k].label + ' (' + FILE_KINDS[k].exts.map(e => '.' + e).join(', ') + ')');
  (task.extensoes || []).forEach(e => parts.push('.' + e));
  return parts.join(' ou ') || 'nenhum arquivo';
}

function parseExts_(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  return unique_(arr.map(e => String(e).toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9]/g, '')).filter(Boolean));
}

function stripQuoted_(text) {
  let t = String(text).replace(/\r\n/g, '\n');
  const cuts = [
    t.search(/\n(Em|On)\s[\s\S]{0,250}?(escreveu|wrote)\s*:/),
    t.search(/\n>/),
    t.search(/\n-{2,}\s*(Original Message|Mensagem original)/i),
    t.search(/\n_{8,}/),
    t.search(/\nDe:\s.+\n/)
  ].filter(i => i >= 0);
  if (cuts.length) t = t.slice(0, Math.min.apply(null, cuts));
  return t.trim();
}

function normalize_(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function extractEmail_(from) {
  const m = String(from).match(/<([^>]+)>/);
  return normEmail_(m ? m[1] : from);
}

function fmtDatePt_(ymd) {
  const p = ymd.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1, p[2], 12);
  const dias = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  return dias[d.getDay()] + ', ' + ('0' + p[2]).slice(-2) + '/' + ('0' + p[1]).slice(-2) + '/' + p[0];
}

function errMsg_(e) { return String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 180); }
function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }
function nowIso_() { return new Date().toISOString(); }
function clean_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function isEmail_(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
function unique_(a) { return Array.from(new Set(a)); }
function firstName_(n) { return String(n || '').trim().split(/\s+/)[0] || ''; }
function nl2br_(s) { return String(s).replace(/\n/g, '<br>'); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
