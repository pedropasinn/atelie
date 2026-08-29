/**
 * Testes de fumaça do Ateliê — funções puras + fixtures de sessão, SEM custo de API.
 * Roda com um ATELIE_HOME temporário. Uso: `node_modules/.bin/tsx tests/smoke.test.ts`
 * (ou `bash tests/run.sh`). Sai !=0 se algo falhar.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

// ATELIE_HOME temporário ANTES de qualquer import de módulo que leia config.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-test-'));
process.env.ATELIE_HOME = HOME;

let pass = 0;
const fails: string[] = [];
function ok(cond: unknown, name: string, extra = ''): void {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ' — ' + extra : ''}`);
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function main(): Promise<void> {
  const { extractJson } = await import('../src/lib/jsonx');
  const { coerce, fallback } = await import('../src/lib/judge');
  const { consolidate } = await import('../src/lib/judgeProviders');
  const { renderTemplate } = await import('../src/styles/catalog.types');
  const { compose, subjectAnchor, buildSlots } = await import('../src/lib/promptComposer');
  const { buildJobs } = await import('../src/lib/distribute');
  const { resolveGenProvider, getGenProvider } = await import('../src/lib/genProviders');
  const { detectImageFormat } = await import('../src/lib/imageFormat');
  const { isKebab, slugify, saveUserStyle, getAllStyles, findStyle } = await import('../src/lib/userStyles');
  const { loadSettings, saveSettings } = await import('../src/lib/settings');
  const { CATALOG } = await import('../src/styles/catalog');
  const { createSession } = await import('../src/state/session');
  const { ensureSession, iterDir, append, writeSnapshot } = await import('../src/state/manifest');
  const { estimateSessionCost } = await import('../src/lib/cost');
  const { buildContactSheet } = await import('../src/lib/contactSheet');
  const { listSessions, shortSlug, shortLabel } = await import('../src/lib/sessions');

  // ── jsonx.extractJson ──────────────────────────────────────────────
  ok(extractJson('{"a":1}')?.a === 1, 'extractJson objeto simples');
  ok(extractJson('```json\n{"a":1}\n```')?.a === 1, 'extractJson com cercas');
  ok(extractJson('{"a":1}{"a":1}')?.a === 1, 'extractJson texto DUPLICADO (caso do juiz)');
  ok(Array.isArray(extractJson('[1,2,3]')), 'extractJson array');
  ok(extractJson('sem json aqui') === null, 'extractJson lixo → null');
  const braceInStr = extractJson('lixo {"t":"tem } chave"} fim');
  ok(braceInStr?.t === 'tem } chave', 'extractJson respeita } dentro de string', JSON.stringify(braceInStr));

  // ── judge.coerce / fallback ────────────────────────────────────────
  ok(coerce({ nota: 15 }, 'x', 7).nota === 10, 'coerce clampa nota >10 → 10');
  ok(coerce({ nota: -3 }, 'x', 7).nota === 0, 'coerce clampa nota <0 → 0');
  ok(coerce({ nota: 8 }, 'x', 7).aprovado === true, 'coerce deriva aprovado (8>=7)');
  ok(coerce({ nota: 6 }, 'x', 7).aprovado === false, 'coerce deriva reprovado (6<7)');
  ok(coerce({ nota: '9' }, 'x', 7).nota === 9, 'coerce nota string→número');
  const cEmpty = coerce({}, 'raw', 7);
  ok(cEmpty.nota === null && Array.isArray(cEmpty.problemas), 'coerce objeto vazio → shape válido');
  ok(coerce(null, 'raw!', 7).raw === 'raw!', 'coerce null → fallback com raw');
  ok(fallback('zzz').aprovado === false && fallback('zzz').raw === 'zzz', 'fallback shape');

  // ── renderTemplate ─────────────────────────────────────────────────
  const rt = renderTemplate('{subject} numa {scene}.{extra}', { subject: 'gato', scene: '', extra: '' });
  ok(!rt.includes('{'), 'renderTemplate remove placeholders', rt);
  ok(!/\s{2,}/.test(rt), 'renderTemplate sem espaços duplos', rt);

  // ── promptComposer ─────────────────────────────────────────────────
  const style = CATALOG.find((s) => s.id === 'fotorrealista')!;
  const p1 = compose('um gato lendo jornal', style);
  ok(p1.includes('gato lendo jornal'), 'compose iter1 inclui o pedido');
  const anchor = subjectAnchor('um gato lendo jornal na poltrona, sala aconchegante');
  const p2 = compose('um gato lendo jornal na poltrona, sala aconchegante', style, {
    sugestao_melhoria: 'pose mais assimétrica',
    prompt_sugerido: 'gato tabby displicente',
    anchor,
  });
  ok(p2.includes('AJUSTE') || p2.includes('pose mais assimétrica'), 'compose iter2 inclui o ajuste do juiz');
  ok(p2.toLowerCase().includes(anchor.toLowerCase().slice(0, 12)), 'compose iter2 mantém o sujeito-âncora');
  const pAvoid = compose('um gato', style, undefined, { avoid: 'marca dagua, texto' });
  ok(/avoid/i.test(pAvoid) && pAvoid.includes('marca dagua'), 'compose anexa negativos (avoid)');
  ok(buildSlots('x').subject === 'x', 'buildSlots subject=pedido');

  // ── distribute.buildJobs ───────────────────────────────────────────
  const jobs = buildJobs(['fotorrealista', 'watercolor'], 2, '/tmp/x');
  ok(jobs.length === 4, 'buildJobs 2 estilos × 2 versões = 4', String(jobs.length));
  ok(new Set(jobs.map((j) => j.id)).size === 4, 'buildJobs ids únicos');
  const jobsT = buildJobs(['logo-icone', 'fotorrealista'], 1, '/tmp/x');
  ok(jobsT.find((j) => j.styleId === 'logo-icone')?.mode === 'transparent', 'buildJobs estilo transparente → mode transparent');
  ok(jobsT.find((j) => j.styleId === 'fotorrealista')?.mode === 'generate', 'buildJobs estilo normal → mode generate');
  const jobsP = buildJobs(['fotorrealista'], 1, '/tmp/x', { genProvider: 'codex' });
  ok(jobsP[0].provider === 'codex', 'buildJobs carrega genProvider');

  // ── versões INDIVIDUAIS por estilo ─────────────────────────────────
  const jobsV = buildJobs(['fotorrealista', 'watercolor'], { fotorrealista: 3, watercolor: 1 }, '/tmp/x');
  ok(jobsV.filter((j) => j.styleId === 'fotorrealista').length === 3, 'buildJobs mapa: 3 versões do 1º estilo');
  ok(jobsV.filter((j) => j.styleId === 'watercolor').length === 1, 'buildJobs mapa: 1 versão do 2º estilo');
  ok(new Set(jobsV.map((j) => j.id)).size === 4, 'buildJobs mapa: ids únicos');

  // ── genProviders: só existe codex ──────────────────────────────────
  ok(resolveGenProvider('codex', 'transparent').id === 'codex', 'transparent → codex');
  ok(resolveGenProvider(undefined, 'edit').id === 'codex', 'edit → codex');
  let unknownProviderRejected = false;
  try { getGenProvider('qualquer-coisa'); } catch { unknownProviderRejected = true; }
  ok(unknownProviderRejected, 'provedor desconhecido é recusado');

  // ── imageFormat.detectImageFormat ──────────────────────────────────
  const pf = path.join(HOME, 'a.png');
  fs.writeFileSync(pf, PNG_MAGIC);
  const jf = path.join(HOME, 'b.png'); // JPEG com extensão .png
  fs.writeFileSync(jf, JPEG_MAGIC);
  ok(detectImageFormat(pf).format === 'png', 'detectImageFormat PNG');
  ok(detectImageFormat(jf).format === 'jpeg', 'detectImageFormat JPEG-em-.png');
  ok(detectImageFormat(jf).mime === 'image/jpeg', 'detectImageFormat mime jpeg');
  // cobertura do caminho de erro (openSync lança → default PNG, sem vazar fd via try/finally)
  ok(detectImageFormat(path.join(HOME, 'nao-existe.png')).format === 'png', 'detectImageFormat arquivo ausente → default png');

  // ── judgeProviders.consolidate (média do painel) ───────────────────
  const mkV = (nota: number | null, extra: Partial<any> = {}): any => ({
    aprovado: false, nota, alinhamento: '', problemas: [], sugestao_melhoria: '', prompt_sugerido: '', ...extra,
  });
  const mkP = (nota: number | null, extra: Partial<any> = {}): any => ({ spec: { provider: 'claude', model: 'm', label: 'L' }, verdict: mkV(nota, extra) });
  // média 6.5 com threshold 7 → NÃO aprovado (a média crua, não arredondada, decide o limiar).
  const c65 = consolidate([mkP(6), mkP(7)], 7);
  ok(c65.aprovado === false, 'consolidate média 6.5 < 7 → reprovado (não arredonda antes do limiar)', String(c65.nota));
  ok(c65.nota === 7, 'consolidate nota exibida = Math.round(6.5) = 7', String(c65.nota));
  ok(consolidate([mkP(7), mkP(7)], 7).aprovado === true, 'consolidate média 7.0 >= 7 → aprovado');
  // sem nota finita: crítico não pode cair em painel[0] arbitrário — pega quem tem sugestão.
  const cNull = consolidate([mkP(null), mkP(null, { sugestao_melhoria: 'aumente o contraste', prompt_sugerido: 'x' })], 7);
  ok(cNull.sugestao_melhoria === 'aumente o contraste', 'consolidate sem nota finita escolhe crítico com sugestão');

  // ── userStyles ─────────────────────────────────────────────────────
  ok(isKebab('foo-bar') && !isKebab('Foo Bar') && !isKebab('foo_bar'), 'isKebab');
  ok(slugify('Olá, Mundo!').replace(/[^a-z0-9-]/g, '') === slugify('Olá, Mundo!'), 'slugify só kebab-seguro', slugify('Olá, Mundo!'));
  saveUserStyle({ id: 'meu-estilo-teste', nome: 'Teste', desc: 'd', grupo: 'G', template: '{subject}', defaults: { size: '2K', quality: 'high', aspect: 'square', background: 'auto', format: 'png' } } as any);
  ok(findStyle('meu-estilo-teste')?.nome === 'Teste', 'saveUserStyle + findStyle');
  ok(getAllStyles().length > CATALOG.length, 'getAllStyles inclui estilo do usuário');
  // precedência do usuário: id que colide com um builtin do CATALOG é sobrescrito pelo user.
  // (evita ids usados por outros testes para não acoplar fixtures)
  const builtinId = CATALOG.map((s) => s.id).find((id) => !['fotorrealista', 'watercolor', 'logo-icone'].includes(id))!;
  saveUserStyle({ id: builtinId, nome: 'OVERRIDE-USER', desc: 'd', grupo: 'G', template: '{subject}', defaults: { size: '2K', quality: 'high', aspect: 'square', background: 'auto', format: 'png' } } as any);
  ok(findStyle(builtinId)?.nome === 'OVERRIDE-USER', 'findStyle dá precedência ao estilo do usuário na colisão de id');
  ok(findStyle(builtinId)?.origem === 'user', 'estilo sobrescrito reporta origem=user');
  ok(getAllStyles().filter((s) => s.id === builtinId).length === 1, 'getAllStyles não duplica id sobrescrito');

  // ── settings roundtrip ─────────────────────────────────────────────
  const s0 = loadSettings();
  ok(typeof s0.judgeModel === 'string' && typeof s0.approveThreshold === 'number', 'loadSettings defaults');
  saveSettings({ ...s0, approveThreshold: 9, judgeMode: 'unico' });
  ok(loadSettings().approveThreshold === 9, 'saveSettings persiste');
  ok(s0.autoOpenFolder === true, 'autoOpenFolder default = abrir a pasta ao terminar');
  saveSettings({ ...s0, autoOpenFolder: 'nao' as any }); // a TUI edita como enum sim/nao
  ok(loadSettings().autoOpenFolder === false, 'autoOpenFolder aceita "nao" da TUI');
  saveSettings({ ...s0, autoOpenFolder: true });
  ok(loadSettings().autoOpenFolder === true, 'autoOpenFolder volta a true');

  // ── fixture de sessão p/ cost / contact-sheet / export ─────────────
  function seed(request: string): string {
    const sess = createSession(request, ['fotorrealista'], 1, 'codex', 1);
    ensureSession(sess);
    const img = path.join(iterDir(sess.id, 1), 'fotorrealista-0.png');
    fs.writeFileSync(img, PNG_MAGIC);
    append(sess.id, { kind: 'session_start', request, styleIds: ['fotorrealista'], n: 1, versionsPerStyle: 1, genProvider: 'codex', iteration: 1 });
    append(sess.id, { kind: 'generate', iteration: 1, jobId: 'fotorrealista-0', styleId: 'fotorrealista', ok: true, pngPath: img, provider: 'codex', meta: { resolved: 'codex' }, durationMs: 1000 });
    append(sess.id, { kind: 'verdict', iteration: 1, jobId: 'fotorrealista-0', styleId: 'fotorrealista', nota: 8, aprovado: true });
    sess.chosen = { iteration: 1, jobIndex: 0, styleId: 'fotorrealista', pngPath: img };
    writeSnapshot(sess);
    return sess.id;
  }

  const sid = seed('uma xícara de café');
  const cost = estimateSessionCost({ id: sid } as any);
  ok(typeof cost.usd === 'number' && cost.usd >= 0, 'estimateSessionCost retorna usd número', JSON.stringify(cost.usd));
  ok(listSessions().some((s) => s.id === sid), 'listSessions encontra a sessão');

  // segurança: prompt malicioso NÃO deve injetar HTML cru no contact-sheet
  const sidX = seed('gato <script>alert(1)</script> & <img onerror=x>');
  const html = fs.readFileSync(buildContactSheet(sidX), 'utf8');
  ok(!html.includes('<script>alert(1)</script>'), 'contact-sheet ESCAPA <script> do prompt (anti-injeção)');
  ok(html.includes('data:image/'), 'contact-sheet embute imagem base64');

  // publicação: TUDO que foi gerado vai para a pasta pública + página
  const { publishSession } = await import('../src/lib/contactSheet');
  const dest = path.join(HOME, 'publicado');
  const pub = publishSession(sid, dest);
  ok(fs.existsSync(pub.page), 'publishSession escreve index.html', pub.page);
  ok(pub.images.length === 1, 'publishSession copia TODAS as imagens (sem favoritar)', String(pub.images.length));
  ok(fs.readdirSync(pub.dir).some((f) => f.endsWith('.txt')), 'publishSession grava o .txt ao lado da imagem');
  ok(pub.dir.startsWith(dest), 'publishSession usa o destino pedido', pub.dir);
  const republish = publishSession(sid, dest);
  ok(republish.dir === pub.dir, 'republicar mantém a MESMA pasta da sessão');

  // nome curto do pedido (nome da pasta/página)
  ok(shortSlug('uma xícara de café fumegante sobre a mesa de madeira').split('-').length <= 6, 'shortSlug é curto');
  ok(shortLabel('São Nicolau de Mira, bispo, em pé sobre um plinto').length <= 48, 'shortLabel limita o tamanho');

  // ── Série: buildCanonBlock / buildPanelPrompt / imageBackend refs ──
  const { buildCanonBlock } = await import('../src/lib/serie/canon');
  const { buildPanelPrompt } = await import('../src/lib/serie/panel');
  const { refImageArgs } = await import('../src/lib/imageBackend');
  const {
    createSerie, ensureSerie, saveSerie, loadSerie, listSeries, anchorPath, panelPath,
  } = await import('../src/lib/serie/store');
  const { buildSerieContactSheet } = await import('../src/lib/serie/contactSheet');

  const canonFix: any = {
    estiloId: 'custom',
    estiloDescricao: 'flat 2D cartoon, thick outlines',
    personagens: [
      { nome: 'Mia', descricao: 'girl with round glasses and a green bow' },
      { nome: 'Rex', descricao: 'brown dog with a red collar' },
    ],
    paleta: 'warm pastels',
    mundo: 'cozy village',
  };
  const block = buildCanonBlock(canonFix, ['Mia']);
  ok(block.includes('round glasses'), 'buildCanonBlock inclui descrição do personagem PRESENTE');
  ok(!block.includes('red collar'), 'buildCanonBlock EXCLUI o personagem ausente');
  ok(block.includes('flat 2D cartoon'), 'buildCanonBlock inclui estiloDescricao');
  ok(/IDENTICAL/.test(block), 'buildCanonBlock tem a cláusula IDENTICAL');

  const painelFix: any = { n: 1, cena: 'Mia corre pela praça', personagens: ['Mia'] };
  const fb: any = { consistencia: 5, cenaNota: 8, drifts: ['óculos mais finos', 'laço menor'], sugestao_melhoria: 'engrossar os óculos', prompt_sugerido: '' };
  const pprompt = buildPanelPrompt(canonFix, painelFix, fb);
  ok(pprompt.includes('óculos mais finos') && pprompt.includes('laço menor'), 'buildPanelPrompt (drift) inclui os drifts');
  ok(pprompt.includes('engrossar os óculos'), 'buildPanelPrompt (drift) inclui a sugestão');
  ok(pprompt.includes('CENA: Mia corre pela praça'), 'buildPanelPrompt inclui a cena');
  ok(!buildPanelPrompt(canonFix, painelFix).includes('AJUSTE'), 'buildPanelPrompt sem feedback não injeta AJUSTE');

  // montagem de argv do edit com múltiplas --ref-image
  ok(refImageArgs(['/a.png', '/b.png']).join(' ') === '--ref-image /a.png --ref-image /b.png', 'refImageArgs monta N --ref-image');
  ok(refImageArgs(['', '/c.png']).length === 2, 'refImageArgs pula caminho vazio');

  // ── Série: store roundtrip (ATELIE_HOME temp) ──────────────────────
  const serieFix = createSerie('Aventuras da Mia', 'mia numa vila', canonFix);
  ensureSerie(serieFix);
  serieFix.paineis.push({ n: 1, cena: 'Mia acena', personagens: ['Mia'], aprovado: true, consistencia: 9, cenaNota: 8 });
  saveSerie(serieFix);
  const reloaded = loadSerie(serieFix.id);
  ok(reloaded?.titulo === 'Aventuras da Mia', 'store roundtrip: título');
  ok(reloaded?.canon.personagens.length === 2, 'store roundtrip: personagens');
  ok(reloaded?.paineis[0]?.cena === 'Mia acena', 'store roundtrip: painel');
  ok(listSeries().some((x) => x.id === serieFix.id), 'listSeries encontra a série');
  ok(anchorPath(serieFix.id, 'mia').endsWith(path.join('anchors', 'mia.png')), 'anchorPath compõe caminho');
  ok(panelPath(serieFix.id, 3).endsWith(path.join('panels', 'panel-03.png')), 'panelPath zero-pad');

  // ── Série: contact-sheet ESCAPA <script> (anti-injeção) ────────────
  const serieX = createSerie('Série <script>alert(1)</script>', 'x', {
    estiloId: 'custom',
    estiloDescricao: 'estilo',
    personagens: [{ nome: 'Vilao', descricao: 'capa <script>alert(2)</script> preta', anchorPng: pf }],
  });
  ensureSerie(serieX);
  serieX.paineis.push({ n: 1, cena: 'cena <script>alert(3)</script> perigosa', personagens: ['Vilao'], drifts: ['<img onerror=x>'], consistencia: 7, cenaNota: 7, aprovado: true, pngPath: pf });
  saveSerie(serieX);
  const shtml = fs.readFileSync(buildSerieContactSheet(serieX.id), 'utf8');
  ok(!shtml.includes('<script>alert(1)</script>') && !shtml.includes('<script>alert(2)</script>') && !shtml.includes('<script>alert(3)</script>'), 'contact-sheet da série ESCAPA <script>');
  ok(shtml.includes('data:image/'), 'contact-sheet da série embute imagem base64');

  // ── resumo ─────────────────────────────────────────────────────────
  console.log(`\nPASSOU: ${pass}  FALHOU: ${fails.length}`);
  if (fails.length) {
    console.log('\nFALHAS:');
    for (const f of fails) console.log('  ✗ ' + f);
  }
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('ERRO no runner de testes:', e?.stack || e);
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(2);
});
