/* ===================================================================
   EstoquePro — app.js
   Dados em localStorage (protótipo). Para produção: API + PostgreSQL.
   =================================================================== */
'use strict';

/* ============================ UTILIDADES ============================ */
const $ = id => document.getElementById(id);
const DAY = 86400000;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
const brl = c => ((Number(c) || 0) / 100).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });   // dinheiro SEMPRE em centavos
const toCents = v => Math.round((parseFloat(String(v).replace(',', '.')) || 0) * 100);
const fromCents = c => ((Number(c) || 0) / 100).toFixed(2);
const fmtDate = d => new Date(d).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' });
const fmtDay = s => s ? s.split('-').reverse().join('/') : '—';
const localDay = (d = new Date()) => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const monthKey = d => localDay(new Date(d)).slice(0, 7);

function showToast(msg, type){
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ============================ ARMAZENAMENTO ============================ */
const store = {
  get(k, fallback){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(k, v){
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch { showToast('Não foi possível salvar (armazenamento cheio ou bloqueado).', 'error'); return false; }
  }
};
const loadUsers = () => store.get('ep_users', {});
const saveUsers = u => store.set('ep_users', u);
const loadCompanies = () => store.get('ep_companies', {});
const saveCompanies = c => store.set('ep_companies', c);
const emptyDb = () => ({ products: [], movements: [], auditLog: [] });
const loadCompanyData = id => Object.assign(emptyDb(), store.get('ep_data:' + id, {}));
const persist = () => store.set('ep_data:' + currentUser.companyId, db);

/* ============================ ESTADO ============================ */
let currentUser = null, currentCompany = null, db = emptyDb();
let currentSection = 'dashboard', statTab = 'vendidos';
let editingProductId = null, isDenseMode = false;
let BAL = new Map();           // productId -> saldo (recalculado a cada render)
const charts = {};

const ROLE_LABEL = { admin:'Administrador', funcionario:'Funcionário', visualizador:'Visualizador' };
const PERMS = {
  admin: ['*'],
  funcionario: ['product.write', 'movement.write', 'inventory.apply'],
  visualizador: []
};
const can = action => { const p = PERMS[currentUser?.role] || []; return p.includes('*') || p.includes(action); };
function guard(action){
  if(can(action)) return true;
  showToast('Seu perfil não tem permissão para esta ação.', 'error');
  return false;
}

const REASONS = {
  entrada: [['compra','Compra de fornecedor'], ['devolucao','Devolução de cliente'], ['transferencia','Transferência recebida'], ['outros','Outros (descrever)']],
  saida:   [['venda','Venda'], ['perda','Perda'], ['avaria','Avaria'], ['consumo','Consumo interno'], ['outros','Outros (descrever)']]
};
const REASON_LABEL = {
  compra:'Compra', devolucao:'Devolução', transferencia:'Transferência', venda:'Venda', perda:'Perda', avaria:'Avaria',
  consumo:'Consumo interno', outros:'Outros', inventario:'Inventário', saldo_inicial:'Saldo inicial'
};
const TYPE_LABEL = { entrada:'Entrada', saida:'Saída', ajuste:'Ajuste', estorno:'Estorno' };

/* ============================ AUDITORIA ============================ */
function audit(action, entity, detail){
  db.auditLog.unshift({ id: uid(), at: new Date().toISOString(), user: currentUser.name, email: currentUser.email, action, entity, detail: detail || '' });
  if(db.auditLog.length > 500) db.auditLog.length = 500;
}

/* ============================ AUTENTICAÇÃO ============================
   ATENÇÃO: autenticação 100% no navegador serve apenas como demonstração.
   Em produção a verificação de senha e as permissões ficam no servidor. */
async function hashPassword(pw, salt){
  if(!window.crypto?.subtle) throw new Error('Use http://localhost ou HTTPS para habilitar a criptografia.');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function handleSignup(){
  const name = $('signupName').value.trim(), companyName = $('signupCompany').value.trim();
  const email = $('signupEmail').value.trim().toLowerCase(), password = $('signupPassword').value;
  const msg = $('signupMsg');
  const fail = t => { msg.innerHTML = `<div class="form-msg">${esc(t)}</div>`; };

  if(!name || !companyName || !email || !password) return fail('Preencha todos os campos.');
  if(!validEmail(email)) return fail('Informe um e-mail válido.');
  if(password.length < 6) return fail('A senha precisa ter pelo menos 6 caracteres.');

  const users = loadUsers();
  if(users[email]) return fail('Este e-mail já está cadastrado.');

  try {
    const salt = uid();
    const companyId = uid();
    const companies = loadCompanies();
    companies[companyId] = { name: companyName };
    users[email] = { name, role:'admin', companyId, active:true, salt, hash: await hashPassword(password, salt) };
    if(!saveCompanies(companies) || !saveUsers(users)) return;

    currentUser = { email, name, role:'admin', companyId };
    currentCompany = { id: companyId, name: companyName };
    db = emptyDb();
    audit('Conta criada', 'Empresa', companyName);
    persist();
    store.set('ep_session', email);
    enterApp(true);
  } catch(e){ fail(e.message); }
}

async function handleLogin(){
  const email = $('loginEmail').value.trim().toLowerCase(), password = $('loginPassword').value;
  const msg = $('loginMsg');
  const fail = t => { msg.innerHTML = `<div class="form-msg">${esc(t)}</div>`; };
  try {
    const u = loadUsers()[email];
    if(!u || u.hash !== await hashPassword(password, u.salt)) return fail('E-mail ou senha incorretos.');
    if(u.active === false) return fail('Este usuário está desativado. Fale com o administrador.');
    startSession(email, u);
    store.set('ep_session', email);
    enterApp(true);
  } catch(e){ fail(e.message); }
}

function startSession(email, u){
  const companies = loadCompanies();
  currentUser = { email, name: u.name, role: u.role, companyId: u.companyId };
  currentCompany = { id: u.companyId, name: companies[u.companyId]?.name || 'Empresa' };
  db = loadCompanyData(u.companyId);
}

function handleLogout(){
  currentUser = null; currentCompany = null; db = emptyDb();
  localStorage.removeItem('ep_session');
  closeModal();
  showView('landing');
}

function enterApp(welcome){
  $('userChip').innerHTML = `${esc(currentUser.name)}<span class="role-badge ${currentUser.role}">${ROLE_LABEL[currentUser.role]}</span>`;
  $('sideCompany').textContent = currentCompany.name;
  $('btnNovoProduto').disabled = !can('product.write');
  $('btnNovaMov').disabled = !can('movement.write');
  $('btnAplicarInv').disabled = !can('inventory.apply');
  $('navUsuarios').classList.toggle('hidden', !can('*'));
  $('loginPassword').value = ''; $('signupPassword').value = '';
  showView('app');
  switchSection('dashboard');
  if(welcome) showToast('Seja bem-vindo(a), ' + currentUser.name + '!');
}

/* ============================ TELAS ============================ */
function showView(view){
  $('landingView').classList.toggle('hidden', view !== 'landing');
  $('authView').classList.toggle('hidden', view !== 'auth');
  $('appView').classList.toggle('hidden', view !== 'app');
  window.scrollTo(0, 0);
}
function openAuth(mode){
  showView('auth');
  $('loginForm').classList.toggle('hidden', mode !== 'login');
  $('signupForm').classList.toggle('hidden', mode !== 'signup');
  $('loginMsg').innerHTML = ''; $('signupMsg').innerHTML = '';
}

function applyTheme(dark){
  document.body.classList.toggle('dark', dark);
  const icon = dark ? '☀️' : '🌙';
  $('themeToggle').textContent = icon; $('themeToggleApp').textContent = icon;
  localStorage.setItem('ep_theme', dark ? 'dark' : 'light');
  drawLanding();
  if(currentUser) renderAll();
}

function switchSection(section){
  if(section === 'usuarios' && !can('*')) return;
  currentSection = section;
  document.querySelectorAll('.app-section').forEach(s => s.classList.remove('active'));
  $('section-' + section).classList.add('active');
  document.querySelectorAll('.side-nav .nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  renderAll();
}
function switchStatTab(tab){
  statTab = tab;
  document.querySelectorAll('.tab-row button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.stat-tab').forEach(s => s.classList.add('hidden'));
  $('statTab-' + tab).classList.remove('hidden');
  renderStatistics();
}
function globalSearchGo(){
  const v = $('globalSearch').value;
  switchSection('produtos');
  $('pf_search_name').value = v;
  renderProductsTable();
}

/* ============================ CÁLCULOS ============================ */
function refreshCache(){
  BAL = new Map();
  db.movements.forEach(m => BAL.set(m.productId, (BAL.get(m.productId) || 0) + m.delta));
}
const stock = id => BAL.get(id) || 0;
const activeProducts = () => db.products.filter(p => p.active !== false);
const findProduct = id => db.products.find(p => p.id === id);
const lowStockProducts = () => activeProducts().filter(p => stock(p.id) <= (p.minStock || 0));
function daysToExpiry(p){ return p.expiry ? Math.ceil((new Date(p.expiry + 'T23:59:59') - Date.now()) / DAY) : null; }
const expiringProducts = () => activeProducts().filter(p => { const d = daysToExpiry(p); return stock(p.id) > 0 && d !== null && d <= 30; });

// Quantidade vendida nos últimos N dias (estorno de venda abate automaticamente)
function soldMap(days){
  const since = Date.now() - days * DAY, map = new Map();
  db.movements.forEach(m => {
    if(m.reason === 'venda' && new Date(m.date).getTime() >= since) map.set(m.productId, (map.get(m.productId) || 0) - m.delta);
  });
  return map;
}

function pushMovement({ productId, type, reason, qty, delta, unitCost = null, note = '', reverses = null }){
  const m = { id: uid(), date: new Date().toISOString(), productId, type, reason, qty, delta, unitCost, note, reverses, by: currentUser.name };
  db.movements.push(m);
  return m;
}

function last6Months(){
  const out = [], now = new Date();
  for(let i = 5; i >= 0; i--){
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: localDay(d).slice(0, 7), label: d.toLocaleDateString('pt-BR', { month:'short' }).replace('.', '') });
  }
  return out;
}

/* ============================ GRÁFICOS ============================ */
function colors(){
  const cs = getComputedStyle(document.body), g = n => cs.getPropertyValue(n).trim();
  return { ink:g('--ink'), soft:g('--ink-soft'), green:g('--stock-green'), safety:g('--safety'), steel:g('--steel'), line:g('--line'), paper:g('--paper') };
}
function drawChart(id, cfg){
  const el = $(id);
  if(!el || typeof Chart === 'undefined') return;
  charts[id]?.destroy();
  charts[id] = new Chart(el, cfg);
}
function axisOpts(c, extra = {}){
  return {
    x: { ticks:{ color:c.soft }, grid:{ color:c.line } },
    y: { ticks:{ color:c.soft }, grid:{ color:c.line }, beginAtZero:true, ...extra }
  };
}
function drawLanding(){
  const el = $('stockChart2');
  if(!el || typeof Chart === 'undefined') return;
  const light = getComputedStyle(document.querySelector('.showcase')).color;
  const c = colors();
  charts.landing?.destroy();
  charts.landing = new Chart(el, {
    type:'line',
    data:{ labels:['jan','fev','mar','abr','mai','jun'], datasets:[
      { label:'Entradas', data:[120,150,130,180,160,210], borderColor:c.green, backgroundColor:c.green, tension:.3 },
      { label:'Saídas',   data:[100,130,140,150,170,190], borderColor:c.safety, backgroundColor:c.safety, tension:.3 },
      { label:'Nível de estoque', data:[400,420,410,440,430,450], borderColor:light, backgroundColor:light, borderDash:[5,4], tension:.3 }
    ]},
    options:{ plugins:{ legend:{ labels:{ color:light } } }, scales:{ x:{ ticks:{ color:light }, grid:{ color:'rgba(128,128,128,.25)' } }, y:{ ticks:{ color:light }, grid:{ color:'rgba(128,128,128,.25)' } } } }
  });
}

/* ============================ RENDER ============================ */
function renderAll(){
  if(!currentUser) return;
  refreshCache();
  renderBell();
  ({ dashboard:renderDashboard, produtos:renderProductsTable, movimentacoes:renderMovementsTable,
     inventario:renderInventoryTable, estatisticas:renderStatistics, usuarios:renderUsers }[currentSection])();
}

/* ---------- Dashboard ---------- */
function renderDashboard(){
  const ps = activeProducts();
  $('statProdutos').textContent = ps.length;
  $('statValor').textContent = brl(ps.reduce((s, p) => s + Math.max(0, stock(p.id)) * (p.cost || 0), 0));
  const low = lowStockProducts(), exp = expiringProducts();
  $('statAlertas').textContent = low.length;
  $('statVencendo').textContent = exp.length;
  const mk = monthKey(new Date());
  $('statMovMes').textContent = db.movements.filter(m => monthKey(m.date) === mk).length;

  $('lowStockList').innerHTML = low.length ? low.map(p => `
    <div class="low-stock-item"><span>${esc(p.name)} <span class="sub-cell mono">${esc(p.sku)}</span></span>
    <span class="mono"><span class="badge low">${stock(p.id)} / mín ${p.minStock || 0} ${esc(p.unit || 'un')}</span></span></div>`).join('')
    : '<div class="low-stock-item">Nenhum produto abaixo do estoque mínimo.</div>';

  $('expiringList').innerHTML = exp.length ? exp.sort((a, b) => daysToExpiry(a) - daysToExpiry(b)).map(p => {
    const d = daysToExpiry(p);
    return `<div class="low-stock-item"><span>${esc(p.name)} <span class="sub-cell mono">${esc(p.sku)}</span></span>
      <span><span class="badge exp">${d < 0 ? 'Vencido há ' + (-d) + 'd' : 'Vence em ' + d + 'd'}</span> <span class="sub-cell mono">${fmtDay(p.expiry)}</span></span></div>`;
  }).join('') : '<div class="low-stock-item">Nenhum produto vencendo nos próximos 30 dias.</div>';

  // Entradas x saídas e evolução (6 meses)
  const months = last6Months(), c = colors();
  const inn = Object.fromEntries(months.map(m => [m.key, 0])), out = { ...inn }, net = { ...inn };
  db.movements.forEach(m => {
    const k = monthKey(m.date);
    if(k in net) net[k] += m.delta;
    if(!(k in inn)) return;
    if(m.type === 'entrada') inn[k] += m.qty;
    else if(m.type === 'saida') out[k] += m.qty;
    else if(m.type === 'estorno'){ if(m.delta < 0) inn[k] -= m.qty; else out[k] -= m.qty; }
  });
  const firstKey = months[0].key;
  let run = db.movements.filter(m => monthKey(m.date) < firstKey).reduce((s, m) => s + m.delta, 0);
  const evo = months.map(m => (run += net[m.key]));

  drawChart('inOutChart', { type:'bar', data:{ labels: months.map(m => m.label), datasets:[
    { label:'Entradas', data: months.map(m => inn[m.key]), backgroundColor:c.green },
    { label:'Saídas', data: months.map(m => out[m.key]), backgroundColor:c.safety } ] },
    options:{ plugins:{ legend:{ labels:{ color:c.ink } } }, scales: axisOpts(c) } });
  drawChart('evoChart', { type:'line', data:{ labels: months.map(m => m.label), datasets:[
    { label:'Unidades em estoque', data:evo, borderColor:c.steel, backgroundColor:c.steel, tension:.3, fill:false } ] },
    options:{ plugins:{ legend:{ labels:{ color:c.ink } } }, scales: axisOpts(c) } });
}

/* ---------- Produtos ---------- */
function fillFilterOptions(){
  const fill = (id, values, label) => {
    const sel = $(id), cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = values.includes(cur) ? cur : '';
  };
  const uniq = k => [...new Set(db.products.map(p => p[k]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  fill('pf_search_cat', uniq('category'), 'Todas categorias');
  fill('pf_search_brand', uniq('brand'), 'Todas marcas');
}
function getFilteredProducts(){
  const q = $('pf_search_name').value.trim().toLowerCase(), cat = $('pf_search_cat').value, brand = $('pf_search_brand').value, st = $('pf_search_status').value;
  return db.products.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || p.sku.toLowerCase().includes(q) || (p.barcode || '').toLowerCase().includes(q)) &&
    (!cat || p.category === cat) && (!brand || p.brand === brand) &&
    (st === 'todos' || (st === 'ativos' ? p.active !== false : p.active === false))
  ).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
function toggleDenseTable(){ isDenseMode = !isDenseMode; renderProductsTable(); }

function renderProductsTable(){
  fillFilterOptions();
  const wrap = $('productsTableWrap'), list = getFilteredProducts();
  if(!db.products.length){ wrap.innerHTML = '<div class="empty-state">Nenhum produto cadastrado. Clique em “+ Novo Produto” para começar.</div>'; return; }
  if(!list.length){ wrap.innerHTML = '<div class="empty-state">Nenhum produto encontrado com esses filtros.</div>'; return; }

  const admin = can('*'), write = can('product.write');
  const rows = list.map(p => {
    const st = stock(p.id), d = daysToExpiry(p), inactive = p.active === false;
    const hasMov = db.movements.some(m => m.productId === p.id);
    const badges = [
      inactive ? '<span class="badge">Inativo</span>' : '',
      !inactive && st <= (p.minStock || 0) ? '<span class="badge low">Baixo</span>' : '',
      !inactive && st > 0 && d !== null && d <= 30 ? `<span class="badge exp">${d < 0 ? 'Vencido' : 'Vence em ' + d + 'd'}</span>` : ''
    ].join(' ');
    return `<tr class="${inactive ? 'inactive' : ''}">
      <td>${esc(p.name)}<div class="sub-cell mono">${esc(p.sku)}${p.barcode ? ' · ' + esc(p.barcode) : ''}</div></td>
      <td>${esc(p.category || '—')}<div class="sub-cell">${esc(p.brand || '')}</div></td>
      <td class="mono">${st} ${esc(p.unit || 'un')}<div class="sub-cell">mín ${p.minStock || 0}${p.maxStock ? ' · máx ' + p.maxStock : ''}</div></td>
      <td class="mono">${brl(p.cost)}</td><td class="mono">${brl(p.price)}</td>
      <td class="mono">${fmtDay(p.expiry)}</td>
      <td>${badges}</td>
      <td style="white-space:nowrap">
        <button type="button" class="icon-btn" title="Editar" aria-label="Editar ${esc(p.name)}" ${write ? '' : 'disabled'} onclick="openProductModal('${p.id}')">✏️</button>
        <button type="button" class="icon-btn" title="${inactive ? 'Reativar' : 'Inativar'}" aria-label="${inactive ? 'Reativar' : 'Inativar'} ${esc(p.name)}" ${admin ? '' : 'disabled'} onclick="toggleProductActive('${p.id}')">${inactive ? '♻️' : '🚫'}</button>
        <button type="button" class="icon-btn" title="${hasMov ? 'Produto com histórico: apenas inativar' : 'Excluir'}" aria-label="Excluir ${esc(p.name)}" ${admin && !hasMov ? '' : 'disabled'} onclick="deleteProduct('${p.id}')">🗑️</button>
      </td></tr>`;
  }).join('');
  wrap.innerHTML = `<div class="table-scroll"><table class="data-table${isDenseMode ? ' dense' : ''}"><thead><tr>
    <th>Produto</th><th>Categoria / Marca</th><th>Estoque</th><th>Custo</th><th>Preço</th><th>Validade</th><th>Situação</th><th>Ações</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function openProductModal(id){
  if(!guard('product.write')) return;
  editingProductId = id || null;
  const p = id ? findProduct(id) : null, isEdit = !!p;
  const uniq = k => [...new Set(db.products.map(x => x[k]).filter(Boolean))];
  const v = (k, d = '') => isEdit && p[k] !== undefined && p[k] !== null ? esc(p[k]) : d;
  const units = ['un', 'kg', 'g', 'L', 'ml', 'cx', 'pct', 'm'];

  $('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="${isEdit ? 'Editar produto' : 'Novo produto'}">
        <h3>${isEdit ? 'Editar Produto' : 'Novo Produto'}</h3>
        <div class="form-group"><label for="pf_name">Nome *</label><input id="pf_name" value="${v('name')}"></div>
        <div class="two-col">
          <div class="form-group"><label for="pf_sku">SKU *</label><input id="pf_sku" value="${v('sku')}"></div>
          <div class="form-group"><label for="pf_barcode">Código de barras</label>
            <div class="field-with-scan"><input id="pf_barcode" value="${v('barcode')}"><button type="button" class="scan-btn" onclick="openScanner('pf_barcode')">📷</button></div></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="pf_category">Categoria</label><input id="pf_category" list="dl_cat" value="${v('category')}"><datalist id="dl_cat">${uniq('category').map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
          <div class="form-group"><label for="pf_brand">Marca</label><input id="pf_brand" list="dl_brand" value="${v('brand')}"><datalist id="dl_brand">${uniq('brand').map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="pf_supplier">Fornecedor</label><input id="pf_supplier" list="dl_sup" value="${v('supplier')}"><datalist id="dl_sup">${uniq('supplier').map(x => `<option value="${esc(x)}">`).join('')}</datalist></div>
          <div class="form-group"><label for="pf_unit">Unidade</label><select id="pf_unit">${units.map(u => `<option ${isEdit && p.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="pf_cost">Custo (R$)</label><input id="pf_cost" type="number" step="0.01" min="0" value="${isEdit ? fromCents(p.cost) : ''}"></div>
          <div class="form-group"><label for="pf_price">Preço de venda (R$)</label><input id="pf_price" type="number" step="0.01" min="0" value="${isEdit ? fromCents(p.price) : ''}"></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="pf_min">Estoque mínimo</label><input id="pf_min" type="number" min="0" step="1" value="${v('minStock', '0')}"></div>
          <div class="form-group"><label for="pf_max">Estoque máximo</label><input id="pf_max" type="number" min="0" step="1" value="${v('maxStock', '0')}"></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="pf_lead">Prazo de entrega (dias)</label><input id="pf_lead" type="number" min="0" step="1" value="${v('leadTime', '7')}"></div>
          <div class="form-group"><label for="pf_expiry">Validade</label><input id="pf_expiry" type="date" value="${v('expiry')}"></div>
        </div>
        ${isEdit ? '' : '<div class="form-group"><label for="pf_initial">Estoque inicial</label><input id="pf_initial" type="number" min="0" step="1" value="0"></div>'}
        <div class="modal-actions">
          <button type="button" class="btn-outline" onclick="closeModal()">Cancelar</button>
          <button type="button" class="stamp-btn" onclick="saveProduct()">${isEdit ? 'Salvar' : 'Cadastrar'}</button>
        </div>
      </div>
    </div>`;
  $('pf_name').focus();
}

function saveProduct(){
  if(!guard('product.write')) return;
  const g = i => $(i).value.trim(), int = i => Math.max(0, parseInt($(i).value, 10) || 0);
  const name = g('pf_name'), sku = g('pf_sku'), barcode = g('pf_barcode');
  if(!name || !sku){ showToast('Nome e SKU são obrigatórios.', 'error'); return; }
  const dup = db.products.find(p => p.id !== editingProductId && (p.sku.toLowerCase() === sku.toLowerCase() || (barcode && p.barcode === barcode)));
  if(dup){ showToast(`SKU ou código de barras já usado em “${dup.name}”.`, 'error'); return; }
  const minStock = int('pf_min'), maxStock = int('pf_max');
  if(maxStock && maxStock < minStock){ showToast('O estoque máximo não pode ser menor que o mínimo.', 'error'); return; }

  const data = {
    name, sku, barcode, category: g('pf_category'), brand: g('pf_brand'), supplier: g('pf_supplier'), unit: $('pf_unit').value,
    cost: toCents($('pf_cost').value), price: toCents($('pf_price').value), minStock, maxStock, leadTime: int('pf_lead'), expiry: $('pf_expiry').value
  };
  if(editingProductId){
    Object.assign(findProduct(editingProductId), data);
    audit('Produto editado', 'Produto', `${name} (${sku})`);
  } else {
    const p = { id: uid(), active: true, createdAt: new Date().toISOString(), ...data };
    db.products.push(p);
    const initial = int('pf_initial');
    if(initial > 0) pushMovement({ productId: p.id, type:'entrada', reason:'saldo_inicial', qty: initial, delta: initial, unitCost: data.cost, note:'Saldo inicial no cadastro' });
    audit('Produto criado', 'Produto', `${name} (${sku})`);
  }
  if(!persist()) return;
  closeModal(); renderAll(); showToast('Produto salvo com sucesso!');
}

function toggleProductActive(id){
  if(!guard('product.activate')) return;
  const p = findProduct(id), becoming = p.active === false;
  if(!becoming && !confirm(`Inativar “${p.name}”? O histórico é mantido e você pode reativar depois.`)) return;
  p.active = becoming;
  audit(becoming ? 'Produto reativado' : 'Produto inativado', 'Produto', `${p.name} (${p.sku})`);
  persist(); renderAll();
}
function deleteProduct(id){
  if(!guard('product.delete')) return;
  const p = findProduct(id);
  if(db.movements.some(m => m.productId === id)){ showToast('Produto com histórico não pode ser excluído. Inative-o.', 'error'); return; }
  if(!confirm(`Excluir “${p.name}” definitivamente?`)) return;
  db.products = db.products.filter(x => x.id !== id);
  audit('Produto excluído', 'Produto', `${p.name} (${p.sku})`);
  persist(); renderAll(); showToast('Produto excluído.');
}

/* ---------- Movimentações ---------- */
function getFilteredMovements(){
  const type = $('mf_search_type').value, from = $('mf_search_from').value, to = $('mf_search_to').value, q = $('mf_search_text').value.trim().toLowerCase();
  return db.movements.filter(m => {
    const p = findProduct(m.productId), day = localDay(new Date(m.date));
    return (!type || m.type === type) && (!from || day >= from) && (!to || day <= to) && (!q || (p && p.name.toLowerCase().includes(q)));
  }).sort((a, b) => b.date.localeCompare(a.date));
}
function renderMovementsTable(){
  const wrap = $('movementsTableWrap');
  if(!db.movements.length){ wrap.innerHTML = '<div class="empty-state">Nenhuma movimentação registrada ainda.</div>'; return; }
  const list = getFilteredMovements();
  if(!list.length){ wrap.innerHTML = '<div class="empty-state">Nenhuma movimentação encontrada com esses filtros.</div>'; return; }
  const admin = can('*');
  const rows = list.slice(0, 300).map(m => {
    const p = findProduct(m.productId), canReverse = admin && m.type !== 'estorno' && !m.reversedBy;
    return `<tr>
      <td class="mono" style="font-size:.75rem">${fmtDate(m.date)}</td>
      <td>${esc(p ? p.name : 'Produto removido')}</td>
      <td><span class="badge ${m.type}">${TYPE_LABEL[m.type]}</span>${m.reversedBy ? ' <span class="badge">estornada</span>' : ''}</td>
      <td>${esc(REASON_LABEL[m.reason] || m.reason)}<div class="sub-cell">${esc(m.note || '')}</div></td>
      <td class="mono">${m.delta > 0 ? '+' : ''}${m.delta}</td>
      <td>${esc(m.by || '')}</td>
      <td><button type="button" class="icon-btn" title="Estornar" aria-label="Estornar movimentação" ${canReverse ? '' : 'disabled'} onclick="reverseMovement('${m.id}')">↩</button></td></tr>`;
  }).join('');
  wrap.innerHTML = `${list.length > 300 ? '<p class="note">Mostrando as 300 mais recentes. Use os filtros ou exporte para ver tudo.</p>' : ''}
    <div class="table-scroll"><table class="data-table"><thead><tr><th>Data</th><th>Produto</th><th>Tipo</th><th>Motivo</th><th>Qtd</th><th>Usuário</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function openMovementModal(){
  if(!guard('movement.write')) return;
  const ps = activeProducts().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if(!ps.length){ showToast('Cadastre um produto antes de movimentar.', 'error'); return; }
  $('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Nova movimentação">
        <h3>Nova Movimentação</h3>
        <div class="form-group"><label for="mf_code">Código de barras ou SKU (Enter para selecionar)</label>
          <div class="field-with-scan"><input id="mf_code" autocomplete="off" onkeydown="if(event.key==='Enter'){event.preventDefault();pickProductByCode(this.value);}"><button type="button" class="scan-btn" onclick="openScanner('mf_code', pickProductByCode)">📷</button></div></div>
        <div class="form-group"><label for="mf_product">Produto</label><select id="mf_product" onchange="syncMovementForm()">${ps.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.sku)})</option>`).join('')}</select></div>
        <div class="two-col">
          <div class="form-group"><label for="mf_type">Tipo</label><select id="mf_type" onchange="syncMovementForm()"><option value="entrada">Entrada</option><option value="saida">Saída</option></select></div>
          <div class="form-group"><label for="mf_reason">Motivo</label><select id="mf_reason"></select></div>
        </div>
        <div class="two-col">
          <div class="form-group"><label for="mf_qty">Quantidade</label><input id="mf_qty" type="number" min="1" step="1" value="1"></div>
          <div class="form-group" id="mf_cost_wrap"><label for="mf_cost">Custo unitário (R$) — opcional</label><input id="mf_cost" type="number" min="0" step="0.01"></div>
        </div>
        <div class="form-group"><label for="mf_note">Observação</label><input id="mf_note" placeholder="Obrigatória quando o motivo for “Outros”"></div>
        <div id="mf_hint" class="note"></div>
        <div class="modal-actions">
          <button type="button" class="btn-outline" onclick="closeModal()">Cancelar</button>
          <button type="button" class="stamp-btn" onclick="saveMovement()">Registrar</button>
        </div>
      </div>
    </div>`;
  syncMovementForm();
  $('mf_code').focus();
}
function syncMovementForm(){
  const type = $('mf_type').value;
  $('mf_reason').innerHTML = REASONS[type].map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  $('mf_cost_wrap').classList.toggle('hidden', type !== 'entrada');
  refreshCache();
  const p = findProduct($('mf_product').value);
  $('mf_hint').textContent = p ? `Saldo atual: ${stock(p.id)} ${p.unit || 'un'}` : '';
}
function pickProductByCode(code){
  code = String(code || '').trim().toLowerCase();
  const p = activeProducts().find(x => x.sku.toLowerCase() === code || (x.barcode || '').toLowerCase() === code);
  if(!p){ showToast('Nenhum produto ativo com esse código.', 'error'); return; }
  $('mf_product').value = p.id; $('mf_code').value = '';
  syncMovementForm(); $('mf_qty').focus(); $('mf_qty').select();
}

function saveMovement(){
  if(!guard('movement.write')) return;
  const productId = $('mf_product').value, type = $('mf_type').value, reason = $('mf_reason').value;
  const qty = parseInt($('mf_qty').value, 10), note = $('mf_note').value.trim();
  const p = findProduct(productId);
  if(!p || p.active === false){ showToast('Produto inválido ou inativo.', 'error'); return; }
  if(!Number.isInteger(qty) || qty <= 0){ showToast('Informe uma quantidade inteira maior que zero.', 'error'); return; }
  if(reason === 'outros' && !note){ showToast('Descreva o motivo na observação.', 'error'); return; }
  refreshCache();
  const cur = stock(productId);
  if(type === 'saida' && cur < qty){ showToast(`Estoque insuficiente (saldo: ${cur}).`, 'error'); return; }

  let unitCost = null;
  if(type === 'entrada' && $('mf_cost').value !== ''){
    unitCost = toCents($('mf_cost').value);
    if(reason === 'compra' && cur >= 0 && cur + qty > 0) p.cost = Math.round((cur * (p.cost || 0) + qty * unitCost) / (cur + qty));  // custo médio ponderado
  }
  pushMovement({ productId, type, reason, qty, delta: type === 'entrada' ? qty : -qty, unitCost, note });
  audit('Movimentação', TYPE_LABEL[type], `${p.name}: ${type === 'entrada' ? '+' : '-'}${qty} (${REASON_LABEL[reason]})`);
  if(!persist()) return;
  closeModal(); renderAll(); showToast('Movimentação registrada!');
}

function reverseMovement(id){
  if(!guard('movement.reverse')) return;
  const m = db.movements.find(x => x.id === id);
  if(!m || m.type === 'estorno' || m.reversedBy) return;
  refreshCache();
  if(stock(m.productId) - m.delta < 0){ showToast('Estorno deixaria o saldo negativo.', 'error'); return; }
  const why = prompt('Motivo do estorno (obrigatório):');
  if(!why || !why.trim()) return;
  const e = pushMovement({ productId: m.productId, type:'estorno', reason: m.reason, qty: m.qty, delta: -m.delta, note: 'Estorno: ' + why.trim(), reverses: m.id });
  m.reversedBy = e.id;
  audit('Estorno', 'Movimentação', `${findProduct(m.productId)?.name || ''}: ${why.trim()}`);
  persist(); renderAll(); showToast('Movimentação estornada.');
}

/* ---------- Inventário ---------- */
function renderInventoryTable(){
  const wrap = $('inventoryTableWrap'), ps = activeProducts().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  if(!ps.length){ wrap.innerHTML = '<div class="empty-state">Cadastre produtos primeiro.</div>'; return; }
  const dis = can('inventory.apply') ? '' : 'disabled';
  wrap.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Produto</th><th>No sistema</th><th>Contagem física</th><th>Diferença</th></tr></thead><tbody>${
    ps.map(p => `<tr><td>${esc(p.name)}<div class="sub-cell mono">${esc(p.sku)}</div></td><td class="mono">${stock(p.id)}</td>
      <td><input type="number" min="0" step="1" class="mono" style="width:90px;padding:5px;border:2px solid var(--ink);background:var(--paper);color:var(--ink)" id="inv_${p.id}" aria-label="Contagem de ${esc(p.name)}" ${dis} oninput="invDiff('${p.id}')"></td>
      <td class="mono" id="invd_${p.id}">—</td></tr>`).join('')}</tbody></table></div>`;
}
function invDiff(id){
  const v = $('inv_' + id).value, cell = $('invd_' + id);
  if(v === ''){ cell.textContent = '—'; return; }
  const d = parseInt(v, 10) - stock(id);
  cell.textContent = (d > 0 ? '+' : '') + d;
  cell.style.color = d === 0 ? '' : 'var(--safety)';
}
function applyInventoryCount(){
  if(!guard('inventory.apply')) return;
  refreshCache();
  const changes = [];
  for(const p of activeProducts()){
    const input = $('inv_' + p.id);
    if(!input || input.value === '') continue;
    const counted = parseInt(input.value, 10);
    if(Number.isNaN(counted) || counted < 0){ showToast(`Contagem inválida em “${p.name}”.`, 'error'); return; }
    const delta = counted - stock(p.id);
    if(delta !== 0) changes.push({ p, delta, counted });
  }
  if(!changes.length){ showToast('Nenhuma divergência encontrada.'); return; }
  if(!confirm(`Aplicar ${changes.length} ajuste(s) de inventário? Os ajustes ficam registrados e só podem ser desfeitos por estorno.`)) return;
  changes.forEach(({ p, delta }) => {
    pushMovement({ productId: p.id, type:'ajuste', reason:'inventario', qty: Math.abs(delta), delta, note: 'Ajuste de inventário' });
    audit('Ajuste de inventário', 'Produto', `${p.name}: ${delta > 0 ? '+' : ''}${delta}`);
  });
  persist(); renderAll(); showToast(changes.length + ' ajuste(s) aplicado(s)!');
}

/* ---------- Estatísticas ---------- */
function renderStatistics(){
  const ps = activeProducts(), c = colors();
  if(statTab === 'vendidos'){
    const sold = soldMap(90);
    const rank = ps.map(p => ({ name: p.name, q: sold.get(p.id) || 0 }));
    const top = [...rank].sort((a, b) => b.q - a.q).slice(0, 5), low = [...rank].sort((a, b) => a.q - b.q).slice(0, 5);
    const bar = (id, data, color) => drawChart(id, { type:'bar', data:{ labels: data.map(d => d.name), datasets:[{ label:'Unidades vendidas', data: data.map(d => d.q), backgroundColor: color }] },
      options:{ indexAxis:'y', plugins:{ legend:{ display:false } }, scales: axisOpts(c) } });
    bar('topSoldChart', top, c.green); bar('lowSoldChart', low, c.safety);
  }
  if(statTab === 'categorias'){
    const byCat = {};
    ps.forEach(p => { const k = p.category || 'Sem categoria'; byCat[k] = (byCat[k] || 0) + Math.max(0, stock(p.id)) * (p.cost || 0); });
    const labels = Object.keys(byCat), palette = [c.steel, c.safety, c.green, '#CBBF9C', '#8E6BBF', '#2A9D8F', '#E9C46A', '#6D6875'];
    drawChart('catChart', { type:'doughnut', data:{ labels, datasets:[{ data: labels.map(l => byCat[l] / 100), backgroundColor: labels.map((_, i) => palette[i % palette.length]) }] },
      options:{ plugins:{ legend:{ position:'bottom', labels:{ color:c.ink } } } } });
  }
  if(statTab === 'abc') renderABC(ps);
  if(statTab === 'previsao') renderForecast(ps);
  if(statTab === 'parados') renderStale(ps);
}

function renderABC(ps){
  const sold = soldMap(90);
  let basis = 'valor de consumo dos últimos 90 dias (vendas × custo)';
  let items = ps.map(p => ({ p, val: (sold.get(p.id) || 0) * (p.cost || 0) }));
  if(items.every(i => i.val === 0)){
    basis = 'valor imobilizado em estoque (ainda não há vendas no período)';
    items = ps.map(p => ({ p, val: Math.max(0, stock(p.id)) * (p.cost || 0) }));
  }
  items.sort((a, b) => b.val - a.val);
  $('abcNote').textContent = `Classificação pelo ${basis}. A: até 80% do valor acumulado, B: até 95%, C: restante.`;
  if(!items.length || items.every(i => i.val === 0)){ $('abcTableWrap').innerHTML = '<div class="empty-state">Sem dados suficientes para classificar.</div>'; return; }
  const total = items.reduce((s, i) => s + i.val, 0);
  let acc = 0;
  const rows = items.map(i => {
    const before = (acc / total) * 100; acc += i.val;
    const cls = i.val === 0 ? 'C' : before < 80 ? 'A' : before < 95 ? 'B' : 'C';   // o item que cruza o limite pertence à classe de cima
    return `<tr><td>${esc(i.p.name)}</td><td><span class="badge abc-${cls}">Classe ${cls}</span></td>
      <td class="mono">${stock(i.p.id)} ${esc(i.p.unit || 'un')}</td><td class="mono">${brl(i.val)}</td><td class="mono">${((i.val / total) * 100).toFixed(1)}%</td></tr>`;
  }).join('');
  $('abcTableWrap').innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Produto</th><th>Curva</th><th>Estoque</th><th>Valor</th><th>% do total</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderForecast(ps){
  const sold = soldMap(30);
  const rows = ps.map(p => {
    const st = stock(p.id), daily = (sold.get(p.id) || 0) / 30, lead = p.leadTime ?? 7;
    const rop = Math.ceil(daily * lead) + (p.minStock || 0);                 // ponto de pedido
    const coverage = daily > 0 ? st / daily : Infinity;
    const target = p.maxStock || Math.max(rop * 2, 1);
    return { p, st, daily, lead, rop, coverage, need: st <= rop, suggest: Math.max(0, Math.ceil(target - st)) };
  }).filter(r => r.need).sort((a, b) => a.coverage - b.coverage);
  $('previsaoList').innerHTML = rows.length ? rows.map(r => {
    const urgent = r.st <= 0 || r.coverage < r.lead;
    return `<div class="stat-row"><span>${esc(r.p.name)}<div class="sub-cell">${r.p.supplier ? 'Fornecedor: ' + esc(r.p.supplier) + ' · ' : ''}saldo ${r.st}, ponto de pedido ${r.rop}, entrega em ${r.lead}d</div></span>
      <span class="mono ${urgent ? 'urgency-high' : 'urgency-med'}">${r.coverage === Infinity ? 'sem consumo' : 'cobre ' + Math.floor(r.coverage) + 'd'} · comprar ${r.suggest} ${esc(r.p.unit || 'un')}</span></div>`;
  }).join('') : '<div class="stat-row">Nenhum produto atingiu o ponto de pedido.</div>';
}

function renderStale(ps){
  const rows = ps.filter(p => stock(p.id) > 0).map(p => {
    const ms = db.movements.filter(m => m.productId === p.id);
    const outs = ms.filter(m => m.type === 'saida'), ref = outs.length ? outs[outs.length - 1].date : (ms[0]?.date || p.createdAt);
    return { p, days: Math.floor((Date.now() - new Date(ref).getTime()) / DAY), capital: stock(p.id) * (p.cost || 0) };
  }).filter(r => r.days >= 60).sort((a, b) => b.capital - a.capital);
  $('paradosList').innerHTML = rows.length ? rows.map(r =>
    `<div class="stat-row"><span>${esc(r.p.name)}<div class="sub-cell">${stock(r.p.id)} ${esc(r.p.unit || 'un')} parados</div></span><span class="mono">${r.days} dias sem saída · ${brl(r.capital)}</span></div>`).join('')
    : '<div class="stat-row">Nenhum produto parado.</div>';
}

/* ---------- Usuários ---------- */
function renderUsers(){
  if(!can('*')) return;
  const members = Object.entries(loadUsers()).filter(([, u]) => u.companyId === currentUser.companyId);
  $('usersTableWrap').innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Situação</th></tr></thead><tbody>${
    members.map(([email, u]) => {
      const self = email === currentUser.email;
      return `<tr><td>${esc(u.name)}</td><td class="mono">${esc(email)}</td>
        <td>${self ? `<span class="role-badge ${u.role}">${ROLE_LABEL[u.role]}</span>` :
          `<select aria-label="Perfil de ${esc(u.name)}" onchange="changeRole('${esc(email)}', this.value)">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}</td>
        <td>${self ? '<span class="badge entrada">Você</span>' :
          `<button type="button" class="btn-outline btn-sm" onclick="toggleUserActive('${esc(email)}')">${u.active === false ? 'Reativar' : 'Desativar'}</button>`}</td></tr>`;
    }).join('')}</tbody></table></div>`;

  const log = db.auditLog.slice(0, 50);
  $('auditTableWrap').innerHTML = log.length ? `<div class="table-scroll"><table class="data-table dense"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Detalhe</th></tr></thead><tbody>${
    log.map(a => `<tr><td class="mono">${fmtDate(a.at)}</td><td>${esc(a.user)}</td><td>${esc(a.action)}</td><td>${esc(a.detail)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty-state">Sem atividades registradas.</div>';
}
function changeRole(email, role){
  if(!guard('user.manage') || !ROLE_LABEL[role]) return;
  const users = loadUsers();
  if(!users[email] || users[email].companyId !== currentUser.companyId) return;
  users[email].role = role; saveUsers(users);
  audit('Perfil alterado', 'Usuário', `${email} → ${ROLE_LABEL[role]}`); persist(); renderAll();
}
function toggleUserActive(email){
  if(!guard('user.manage')) return;
  const users = loadUsers(), u = users[email];
  if(!u || u.companyId !== currentUser.companyId || email === currentUser.email) return;
  u.active = u.active === false;
  saveUsers(users);
  audit(u.active ? 'Usuário reativado' : 'Usuário desativado', 'Usuário', email); persist(); renderAll();
}
function openInviteModal(){
  if(!guard('user.manage')) return;
  $('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) closeModal()">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="Adicionar membro">
        <h3>Adicionar Membro</h3>
        <div id="inviteMsg"></div>
        <div class="form-group"><label for="iv_name">Nome</label><input id="iv_name"></div>
        <div class="form-group"><label for="iv_email">E-mail</label><input id="iv_email" type="email"></div>
        <div class="two-col">
          <div class="form-group"><label for="iv_role">Perfil</label><select id="iv_role"><option value="funcionario">Funcionário</option><option value="visualizador">Visualizador</option><option value="admin">Administrador</option></select></div>
          <div class="form-group"><label for="iv_pass">Senha provisória</label><input id="iv_pass" type="text" placeholder="Mínimo 6 caracteres"></div>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-outline" onclick="closeModal()">Cancelar</button>
          <button type="button" class="stamp-btn" onclick="saveInvite()">Adicionar</button>
        </div>
      </div>
    </div>`;
  $('iv_name').focus();
}
async function saveInvite(){
  if(!guard('user.manage')) return;
  const name = $('iv_name').value.trim(), email = $('iv_email').value.trim().toLowerCase(), role = $('iv_role').value, pass = $('iv_pass').value;
  const fail = t => { $('inviteMsg').innerHTML = `<div class="form-msg">${esc(t)}</div>`; };
  if(!name || !email || !pass) return fail('Preencha todos os campos.');
  if(!validEmail(email)) return fail('Informe um e-mail válido.');
  if(pass.length < 6) return fail('A senha precisa ter pelo menos 6 caracteres.');
  const users = loadUsers();
  if(users[email]) return fail('Este e-mail já está cadastrado.');
  try {
    const salt = uid();
    users[email] = { name, role, companyId: currentUser.companyId, active:true, salt, hash: await hashPassword(pass, salt) };
    saveUsers(users);
    audit('Membro adicionado', 'Usuário', `${email} (${ROLE_LABEL[role]})`); persist();
    closeModal(); renderAll(); showToast('Membro adicionado. Informe a senha provisória a ele.');
  } catch(e){ fail(e.message); }
}

/* ============================ ALERTAS (SINO) ============================ */
function renderBell(){
  const low = lowStockProducts(), exp = expiringProducts();
  const items = [
    ...low.map(p => `<div class="bell-item">⚠️ <strong>${esc(p.name)}</strong> com estoque baixo (${stock(p.id)}/${p.minStock || 0}).</div>`),
    ...exp.map(p => { const d = daysToExpiry(p); return `<div class="bell-item">⏳ <strong>${esc(p.name)}</strong> ${d < 0 ? 'vencido' : 'vence em ' + d + ' dia(s)'}.</div>`; })
  ];
  const n = items.length;
  $('bellDot').style.display = n ? 'block' : 'none';
  $('bellDot').textContent = n > 99 ? '99+' : n;
  $('bellDropdown').innerHTML = n ? items.join('') : '<div class="bell-item">Tudo certo por aqui. Sem alertas.</div>';
}
function toggleBell(e){ e.stopPropagation(); $('bellDropdown').classList.toggle('open'); }

/* ============================ MODAIS ============================ */
function closeModal(){ $('modalRoot').innerHTML = ''; }

/* ============================ LEITOR DE CÓDIGO DE BARRAS ============================
   Usa a BarcodeDetector API (Chrome/Edge/Android). Leitores USB funcionam como teclado. */
async function openScanner(inputId, onFound){
  if(!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia){
    showToast('Leitura por câmera indisponível neste navegador. Digite o código ou use um leitor USB.', 'error'); return;
  }
  let stream, running = true;
  const ov = document.createElement('div');
  ov.className = 'modal-overlay'; ov.style.zIndex = 1500;
  ov.innerHTML = `<div class="modal-card"><h3>Ler código de barras</h3><div id="scanVideoWrap"><video id="scanVideo" playsinline muted></video></div><button type="button" class="btn-outline btn-block" id="scanCancel">Cancelar</button></div>`;
  document.body.appendChild(ov);
  const stop = () => { running = false; stream?.getTracks().forEach(t => t.stop()); ov.remove(); };
  ov.querySelector('#scanCancel').onclick = stop;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
    const video = ov.querySelector('#scanVideo'); video.srcObject = stream; await video.play();
    let det; try { det = new BarcodeDetector({ formats:['ean_13','ean_8','code_128','upc_a','upc_e','qr_code'] }); } catch { det = new BarcodeDetector(); }
    const tick = async () => {
      if(!running) return;
      try {
        const codes = await det.detect(video);
        if(codes.length){
          const value = codes[0].rawValue; stop();
          $(inputId).value = value;
          if(onFound) onFound(value);
          showToast('Código lido: ' + value);
          return;
        }
      } catch {}
      setTimeout(tick, 250);
    };
    tick();
  } catch(e){ stop(); showToast('Não foi possível acessar a câmera.', 'error'); }
}

/* ============================ EXPORTAÇÃO ============================ */
function datasetFor(kind){
  if(kind === 'products') return getFilteredProducts().map(p => ({
    'Nome': p.name, 'SKU': p.sku, 'Código de barras': p.barcode || '', 'Categoria': p.category || '', 'Marca': p.brand || '', 'Fornecedor': p.supplier || '',
    'Unidade': p.unit || 'un', 'Estoque': stock(p.id), 'Mínimo': p.minStock || 0, 'Máximo': p.maxStock || 0,
    'Custo (R$)': Number(fromCents(p.cost)), 'Preço (R$)': Number(fromCents(p.price)), 'Validade': fmtDay(p.expiry), 'Situação': p.active === false ? 'Inativo' : 'Ativo'
  }));
  return getFilteredMovements().map(m => ({
    'Data': fmtDate(m.date), 'Produto': findProduct(m.productId)?.name || 'Produto removido', 'Tipo': TYPE_LABEL[m.type],
    'Motivo': REASON_LABEL[m.reason] || m.reason, 'Quantidade': m.delta, 'Observação': m.note || '', 'Usuário': m.by || ''
  }));
}
function exportReady(kind){
  refreshCache();
  const rows = datasetFor(kind);
  if(!rows.length){ showToast('Não há dados para exportar.', 'error'); return null; }
  return rows;
}
const fileBase = kind => `estoquepro-${kind === 'products' ? 'produtos' : 'movimentacoes'}-${localDay()}`;
function download(content, name, mime){
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
function exportCSV(kind){
  const rows = exportReady(kind); if(!rows) return;
  const head = Object.keys(rows[0]);
  const cell = v => { let s = String(v ?? ''); if(typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };  // evita injeção de fórmula
  const csv = [head, ...rows.map(r => head.map(h => r[h]))].map(l => l.map(cell).join(';')).join('\r\n');
  download('\ufeff' + csv, fileBase(kind) + '.csv', 'text/csv;charset=utf-8');
}
function exportXLSX(kind){
  if(typeof XLSX === 'undefined'){ showToast('Biblioteca de Excel não carregou. Verifique a internet.', 'error'); return; }
  const rows = exportReady(kind); if(!rows) return;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), kind === 'products' ? 'Produtos' : 'Movimentações');
  XLSX.writeFile(wb, fileBase(kind) + '.xlsx');
}
function exportPDF(kind){
  if(!window.jspdf){ showToast('Biblioteca de PDF não carregou. Verifique a internet.', 'error'); return; }
  const rows = exportReady(kind); if(!rows) return;
  const doc = new window.jspdf.jsPDF({ orientation:'landscape' }), head = Object.keys(rows[0]);
  doc.setFontSize(14);
  doc.text(`${currentCompany.name} — ${kind === 'products' ? 'Produtos' : 'Movimentações'} (${new Date().toLocaleDateString('pt-BR')})`, 14, 15);
  doc.autoTable({ head:[head], body: rows.map(r => head.map(h => String(r[h] ?? ''))), startY: 22, styles:{ fontSize: 8 }, headStyles:{ fillColor:[60, 90, 118] } });
  doc.save(fileBase(kind) + '.pdf');
}

/* ============================ ATALHOS ============================ */
document.addEventListener('keydown', e => {
  if(e.key === 'Escape'){ closeModal(); $('bellDropdown').classList.remove('open'); return; }
  if(!currentUser) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  if(e.altKey && e.key.toLowerCase() === 'n'){ e.preventDefault(); openProductModal(); }
  else if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); $('globalSearch').focus(); }
  else if(e.key === '/' && !typing){ e.preventDefault(); $('globalSearch').focus(); }
});
document.addEventListener('click', e => { if(!e.target.closest('.bell-wrap')) $('bellDropdown').classList.remove('open'); });

/* ============================ INICIALIZAÇÃO ============================ */
function init(){
  $('themeToggle').addEventListener('click', () => applyTheme(!document.body.classList.contains('dark')));
  $('themeToggleApp').addEventListener('click', () => applyTheme(!document.body.classList.contains('dark')));
  applyTheme(localStorage.getItem('ep_theme') === 'dark');

  // Revela os blocos da landing ao rolar
  if('IntersectionObserver' in window){
    const io = new IntersectionObserver(entries => entries.forEach(en => {
      if(en.isIntersecting){ en.target.classList.add('is-visible'); io.unobserve(en.target); }
    }), { threshold: .12 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  } else document.querySelectorAll('.reveal').forEach(el => el.classList.add('is-visible'));

  // Restaura a sessão
  const email = localStorage.getItem('ep_session') ? store.get('ep_session', null) : null;
  const u = email ? loadUsers()[email] : null;
  if(u && u.active !== false){ startSession(email, u); enterApp(false); }
}
init();