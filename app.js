// ── CONFIGURACIÓN ─────────────────────────────────────────────────────
const CONFIG = {
  CLIENT_ID: '467340891750-aerhtg34qdjrj9rdbkqdmr603f5msvk9.apps.googleusercontent.com',
  SHEET_ID:  '14KUDiLI6Gw-YcGXlfdc3bSorur8p6tOYTJvaeBGR6HQ',
  SCOPES:    'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly',
  ANTHROPIC_KEY: '',
};

const DOMINIOS_BANCARIOS = [
  'bbvanet.com.co', 'bbva.com', 'bbva.com.co',
  'notificacionesbancolombia.com',
  'achcolombia.com.co',
  'bancofalabella.com', 'co.bancofalabella.com',
  'nu.com.co', 'nu.com',
  'bancodebogota.com.co',
  'avvillas.com.co'
];

let estado = {
  tokenClient: null,
  accessToken: null,
  productos: [],
  grupos: [],
  transacciones: [],
  correosPendientes: []
};

// ── INICIALIZACIÓN ────────────────────────────────────────────────────
window.onload = () => {
  cargarScriptGoogle().then(() => inicializarGoogleIdentity());
  configurarNav();
  configurarFormularios();
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('btn-actualizar').addEventListener('click', cargarDatos);
};

function cargarScriptGoogle() {
  return new Promise(resolve => {
    const gsi = document.createElement('script');
    gsi.src = 'https://accounts.google.com/gsi/client';
    gsi.onload = () => {
      const gapi = document.createElement('script');
      gapi.src = 'https://apis.google.com/js/api.js';
      gapi.onload = resolve;
      document.head.appendChild(gapi);
    };
    document.head.appendChild(gsi);
  });
}

function inicializarGoogleIdentity() {
  estado.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (response) => {
      if (response.error) { mostrarToast('Error de autenticación: ' + response.error); return; }
      estado.accessToken = response.access_token;
      mostrarApp();
      await cargarDatos();
    }
  });
  document.getElementById('btn-login').addEventListener('click', () => {
    estado.tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

function mostrarApp() {
  document.getElementById('pantalla-login').classList.add('oculto');
  document.getElementById('pantalla-app').classList.remove('oculto');
}

function logout() {
  google.accounts.oauth2.revoke(estado.accessToken, () => {
    estado.accessToken = null;
    estado.productos = [];
    document.getElementById('pantalla-app').classList.add('oculto');
    document.getElementById('pantalla-login').classList.remove('oculto');
  });
}

// ── API GOOGLE SHEETS ─────────────────────────────────────────────────
async function leerHoja(rango) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(rango)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${estado.accessToken}` } });
  const data = await res.json();
  return data.values || [];
}

async function escribirFila(hoja, valores) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(hoja)}:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${estado.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [valores] })
  });
  return res.json();
}

async function actualizarCelda(rango, valor) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(rango)}?valueInputOption=USER_ENTERED`;
  await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${estado.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[valor]] })
  });
}

// ── API GMAIL ─────────────────────────────────────────────────────────
async function leerCorreosBancarios() {
  mostrarSpinner(true);
  try {
    const query = 'newer_than:7d';
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=80&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${estado.accessToken}` } });
    const data = await res.json();

    if (!data.messages || data.messages.length === 0) {
      mostrarToast('No se encontraron correos en los últimos 7 días');
      renderCorreosPendientes([]);
      mostrarSpinner(false);
      return;
    }

    const correos = await Promise.all(data.messages.map(m => leerCorreo(m.id)));

    const correosBancarios = correos.filter(c => {
      const de = (c.payload?.headers?.find(h => h.name === 'From')?.value || '').toLowerCase();
      return DOMINIOS_BANCARIOS.some(d => de.includes(d));
    });

    if (correosBancarios.length === 0) {
      mostrarToast('No se encontraron correos bancarios en los últimos 7 días');
      renderCorreosPendientes([]);
      mostrarSpinner(false);
      return;
    }

    const procesados = correosBancarios.map(c => procesarCorreo(c)).filter(c => c !== null);

    const idsRegistrados = estado.transacciones
      .filter(t => t.fuente === 'Gmail')
      .map(t => t.notas);

    estado.correosPendientes = procesados.filter(c => !idsRegistrados.includes(c.gmailId));
    renderCorreosPendientes(estado.correosPendientes);

  } catch(e) {
    mostrarToast('Error leyendo Gmail: ' + e.message);
    console.error(e);
  }
  mostrarSpinner(false);
}

async function leerCorreo(id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${estado.accessToken}` } });
  return res.json();
}

function procesarCorreo(msg) {
  try {
    const headers = msg.payload.headers;
    const asunto = headers.find(h => h.name === 'Subject')?.value || '';
    const de = headers.find(h => h.name === 'From')?.value || '';
    const fecha = headers.find(h => h.name === 'Date')?.value || '';
    const fechaFormateada = formatearFechaCorreo(fecha);

    let cuerpoPlain = '';
    let cuerpoHtml = '';

    function extraerPartes(parts) {
      for (const part of parts || []) {
        if (part.parts) extraerPartes(part.parts);
        if (part.body?.data) {
          const decoded = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          if (part.mimeType === 'text/plain') cuerpoPlain += decoded;
          if (part.mimeType === 'text/html') cuerpoHtml += decoded;
        }
      }
    }

    if (msg.payload.body?.data) {
      const decoded = atob(msg.payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      if (msg.payload.mimeType === 'text/plain') cuerpoPlain = decoded;
      else cuerpoHtml = decoded;
    }
    extraerPartes(msg.payload.parts);

    const textoLimpio = cuerpoPlain ||
      cuerpoHtml.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    const textoCompleto = asunto + ' ' + textoLimpio;
    const deLower = de.toLowerCase();

    // ── Detectar banco ──────────────────────────────────────────────
    let banco = 'Desconocido';
    if (deLower.includes('bancolombia')) banco = 'Bancolombia';
    else if (deLower.includes('bbva') || deLower.includes('bbvanet')) banco = 'BBVA';
    else if (deLower.includes('nu.com')) banco = 'Nu';
    else if (deLower.includes('bogota')) banco = 'Banco de Bogotá';
    else if (deLower.includes('falabella')) banco = 'Falabella';
    else if (deLower.includes('avvillas')) banco = 'AV Villas';
    else if (deLower.includes('achcolombia')) banco = 'PSE';

    // ── Extraer monto ───────────────────────────────────────────────
    const candidatos = [];

    // Patrón A: $X,XXX.XX — coma miles, punto decimal (BBVA Compra, Bancolombia)
    const regA = /\$\s*(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)/g;
    for (const m of textoCompleto.matchAll(regA)) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (val >= 100) candidatos.push(val);
    }

    // Patrón B: $X.XXX,XX — punto miles, coma decimal (BBVA Llave)
    const regB = /\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)/g;
    for (const m of textoCompleto.matchAll(regB)) {
      const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (val >= 100) candidatos.push(val);
    }

    // Patrón C: número grande sin símbolo
    const regC = /\b(\d{1,3}(?:[.,]\d{3})+)\b/g;
    for (const m of textoCompleto.matchAll(regC)) {
      const val = parseFloat(m[1].replace(/[.,]/g, ''));
      if (val >= 100) candidatos.push(val);
    }

    const validos = candidatos.filter(v => v >= 100 && v < 500000000);
    if (validos.length === 0) return null;
    const monto = Math.max(...validos);

    // ── Detectar tipo ───────────────────────────────────────────────
    const esIngreso = /recibiste|abono|consignaci[oó]n|dep[oó]sito|te enviaron|recib[ií]ste|pago recibido|ingreso a tu/i.test(textoCompleto);
    const esEgreso = /compra|compra exitosa|pago exitoso|debitado|d[eé]bito|retiro|transferiste|enviaste|env[ií]o con llave|cargo|consumo/i.test(textoCompleto);
    const tipo = (esIngreso && !esEgreso) ? 'Ingreso' : 'Egreso';

    // ── Sugerir producto ────────────────────────────────────────────
    let productoSugerido = '';
    const prods = estado.productos.filter(p => p.entidad === banco);

    if (prods.length === 1) {
      productoSugerido = prods[0].id;
    } else if (prods.length > 1) {
      // Buscar *XXXX en el texto
      const matchesTC = [...textoCompleto.matchAll(/\*(\d{4})\b/g)];
      for (const m of matchesTC) {
        const prodMatch = prods.find(p =>
          p.cuenta && (p.cuenta.endsWith(m[1]) || p.cuenta === '*' + m[1])
        );
        if (prodMatch) { productoSugerido = prodMatch.id; break; }
      }

      // Buscar últimos 4 dígitos de cuenta
      if (!productoSugerido) {
        for (const p of prods) {
          if (p.cuenta && p.cuenta !== 'N/A' && p.cuenta.length >= 4) {
            const tail = p.cuenta.replace('*', '').slice(-4);
            if (textoCompleto.includes(tail)) { productoSugerido = p.id; break; }
          }
        }
      }

      // Fallback: primera cuenta de ahorros
      if (!productoSugerido) {
        const cuenta = prods.find(p => p.tipo === 'Cuenta Ahorros' || p.tipo === 'Cuenta Inversión');
        productoSugerido = cuenta ? cuenta.id : prods[0].id;
      }
    }

    // PSE: siempre BBVA Ahorros
    if (banco === 'PSE') {
      productoSugerido = estado.productos.find(p => p.entidad === 'BBVA' && p.tipo === 'Cuenta Ahorros')?.id || '';
    }

    return {
      gmailId: msg.id,
      fecha: fechaFormateada,
      banco,
      asunto,
      monto,
      tipo,
      productoSugerido,
      textoPreview: asunto.substring(0, 80)
    };
  } catch(e) {
    console.error('Error procesando correo:', e);
    return null;
  }
}

function formatearFechaCorreo(fechaStr) {
  try {
    const d = new Date(fechaStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  } catch {
    return new Date().toISOString().split('T')[0];
  }
}

// ── RENDER CORREOS PENDIENTES ─────────────────────────────────────────
function renderCorreosPendientes(correos) {
  const el = document.getElementById('gmail-lista');
  if (!correos.length) {
    el.innerHTML = '<p class="sin-datos">No hay notificaciones bancarias nuevas por procesar.</p>';
    return;
  }

  el.innerHTML = correos.map((c, i) => {
    const optsProductos = estado.productos
      .map(p => `<option value="${p.id}" ${p.id === c.productoSugerido ? 'selected' : ''}>${p.nombre}</option>`)
      .join('');
    const optsGrupos = [...new Set(estado.grupos.filter(g => g.tipo === c.tipo).map(g => g.grupo))]
      .map(g => `<option value="${g}">${g}</option>`).join('');

    return `<div class="correo-card" id="correo-${i}">
      <div class="correo-header">
        <span class="correo-banco">${c.banco}</span>
        <span class="correo-fecha">${c.fecha}</span>
        <span class="correo-tipo ${c.tipo === 'Ingreso' ? 'tx-ingreso' : 'tx-egreso'}">${c.tipo}</span>
      </div>
      <div class="correo-asunto">${c.textoPreview}</div>
      <div class="correo-monto">${fmt(c.monto)}</div>
      <div class="correo-campos">
        <select class="correo-select" id="correo-prod-${i}">${optsProductos}</select>
        <select class="correo-select" id="correo-grupo-${i}" onchange="actualizarSubgruposCorreo(${i})">${optsGrupos}</select>
        <select class="correo-select" id="correo-sub-${i}"></select>
        <input class="correo-input" id="correo-desc-${i}" type="text" placeholder="Descripción" value="${c.asunto.substring(0,50)}" />
      </div>
      <div class="correo-acciones">
        <button class="btn-confirmar" onclick="confirmarCorreo(${i})">✓ Registrar</button>
        <button class="btn-secundario" onclick="descartarCorreo(${i})">Ignorar</button>
      </div>
    </div>`;
  }).join('');

  correos.forEach((c, i) => actualizarSubgruposCorreo(i, c.tipo));
}

function actualizarSubgruposCorreo(i, tipoForzado) {
  const tipo = tipoForzado || estado.correosPendientes[i]?.tipo || 'Egreso';
  const grupo = document.getElementById(`correo-grupo-${i}`)?.value;
  if (!grupo) return;
  const subs = estado.grupos.filter(g => g.grupo === grupo).map(g => g.subgrupo);
  const el = document.getElementById(`correo-sub-${i}`);
  if (el) el.innerHTML = subs.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function confirmarCorreo(i) {
  const c = estado.correosPendientes[i];
  const producto = document.getElementById(`correo-prod-${i}`).value;
  const grupo = document.getElementById(`correo-grupo-${i}`).value;
  const subgrupo = document.getElementById(`correo-sub-${i}`).value;
  const descripcion = document.getElementById(`correo-desc-${i}`).value;

  if (!producto || !grupo || !subgrupo) { mostrarToast('Completa todos los campos'); return; }

  mostrarSpinner(true);
  const id = 'TX' + Date.now();
  await escribirFila('Transacciones', [
    id, c.fecha, c.tipo, grupo, subgrupo,
    producto, '', c.monto, descripcion, 'Gmail', 'TRUE', c.gmailId
  ]);
  await actualizarSaldoProducto(producto, c.tipo, c.monto);
  await cargarDatos();
  mostrarSpinner(false);
  mostrarToast('✓ Transacción registrada desde Gmail');
  document.getElementById(`correo-${i}`).remove();
  estado.correosPendientes.splice(i, 1);
}

function descartarCorreo(i) {
  document.getElementById(`correo-${i}`).remove();
  estado.correosPendientes.splice(i, 1);
}

// ── CARGA DE DATOS ────────────────────────────────────────────────────
async function cargarDatos() {
  mostrarSpinner(true);
  try {
    const [filasProductos, filasGrupos, filasTx] = await Promise.all([
      leerHoja('Productos!A2:N'),
      leerHoja('Grupos!A2:C'),
      leerHoja('Transacciones!A2:L')
    ]);

    estado.productos = filasProductos.map(f => ({
      id: f[0], nombre: f[1], entidad: f[2], tipo: f[3],
      cuenta: f[4], saldoInicial: parseFloat(f[5]) || 0,
      saldoActual: parseFloat(f[6]) || 0,
      cupoTotal: parseFloat(f[7]) || 0,
      cuotaFija: parseFloat(f[8]) || 0,
      fechaPago: f[9] || '', fechaCorte: f[10] || '',
      disponible: f[11] === 'TRUE', estado: f[12] || 'Activa',
      comentarios: f[13] || ''
    }));

    estado.grupos = filasGrupos.map(f => ({ tipo: f[0], grupo: f[1], subgrupo: f[2] }));
    estado.transacciones = filasTx.map(f => ({
      id: f[0], fecha: f[1], tipo: f[2], grupo: f[3], subgrupo: f[4],
      origen: f[5], destino: f[6], monto: parseFloat(f[7]) || 0,
      descripcion: f[8], fuente: f[9], confirmado: f[10], notas: f[11]
    }));

    renderDashboard();
    poblarSelectores();
    renderHistorial();
    revisarVencimientos();
  } catch(e) {
    mostrarToast('Error cargando datos: ' + e.message);
  }
  mostrarSpinner(false);
}

// ── DASHBOARD ─────────────────────────────────────────────────────────
function renderDashboard() {
  const disponibles = estado.productos.filter(p => p.disponible && p.saldoActual >= 0);
  const inversiones = estado.productos.filter(p => !p.disponible && p.saldoActual > 0 &&
    ['Inversión LP', 'Inversión Internacional', 'Inversión'].some(t => p.tipo.includes(t)));
  const deudas = estado.productos.filter(p => p.saldoActual < 0);

  renderCards('cards-disponible', disponibles);
  renderCards('cards-no-disponible', inversiones);
  renderCards('cards-deudas', deudas);

  const totDis = disponibles.reduce((s, p) => s + p.saldoActual, 0);
  const totInv = inversiones.reduce((s, p) => s + p.saldoActual, 0);
  const totDeu = deudas.reduce((s, p) => s + p.saldoActual, 0);
  const neto = totDis + totInv + totDeu;

  document.getElementById('total-disponible').textContent = fmt(totDis);
  document.getElementById('total-no-disponible').textContent = fmt(totInv);
  document.getElementById('total-deudas').textContent = fmt(totDeu);
  document.getElementById('pat-activos').textContent = fmt(totDis);
  document.getElementById('pat-inversiones').textContent = fmt(totInv);
  document.getElementById('pat-deudas').textContent = fmt(totDeu);
  const elNeto = document.getElementById('pat-neto');
  elNeto.textContent = fmt(neto);
  elNeto.className = neto >= 0 ? 'verde' : 'rojo';
}

function renderCards(contenedorId, productos) {
  const el = document.getElementById(contenedorId);
  if (!productos.length) { el.innerHTML = '<p style="color:var(--texto2);font-size:13px">—</p>'; return; }
  el.innerHTML = productos.map(p => {
    const clsSaldo = p.saldoActual >= 0 ? 'positivo' : 'negativo';
    let badge = '';
    if (p.estado === 'Cerrar') badge = '<span class="card-estado estado-cerrar">Cerrar</span>';
    else if (p.estado === 'Cancelar') badge = '<span class="card-estado estado-cancelar">Cancelar</span>';
    else if (p.estado === 'Evaluar cierre') badge = '<span class="card-estado estado-evaluar">Evaluar</span>';
    return `<div class="card">
      <div class="card-nombre">${p.nombre}</div>
      <div class="card-entidad">${p.entidad}</div>
      <div class="card-saldo ${clsSaldo}">${fmt(p.saldoActual)}</div>
      ${badge}
    </div>`;
  }).join('');
}

// ── SELECTORES ────────────────────────────────────────────────────────
function poblarSelectores() {
  const optsProductos = estado.productos.map(p =>
    `<option value="${p.id}">${p.nombre} (${p.entidad})</option>`).join('');

  ['tx-producto', 'tr-origen', 'tr-destino'].forEach(id => {
    const el = document.getElementById(id);
    const base = el.options[0].outerHTML;
    el.innerHTML = base + optsProductos;
  });

  const grupos = [...new Set(estado.grupos.map(g => g.grupo))];
  const filtroGrupo = document.getElementById('filtro-grupo');
  filtroGrupo.innerHTML = '<option value="">Todos los grupos</option>' +
    grupos.map(g => `<option value="${g}">${g}</option>`).join('');

  document.getElementById('tx-tipo').addEventListener('change', function() {
    const tipo = this.value;
    const gruposUnicos = [...new Set(estado.grupos.filter(g => g.tipo === tipo).map(g => g.grupo))];
    const elGrupo = document.getElementById('tx-grupo');
    elGrupo.innerHTML = '<option value="">— Selecciona grupo —</option>' +
      gruposUnicos.map(g => `<option value="${g}">${g}</option>`).join('');
    elGrupo.disabled = false;
    document.getElementById('tx-subgrupo').innerHTML = '<option value="">— Primero selecciona grupo —</option>';
    document.getElementById('tx-subgrupo').disabled = true;
  });

  document.getElementById('tx-grupo').addEventListener('change', function() {
    const tipo = document.getElementById('tx-tipo').value;
    const grupo = this.value;
    const subs = estado.grupos.filter(g => g.tipo === tipo && g.grupo === grupo).map(g => g.subgrupo);
    const elSub = document.getElementById('tx-subgrupo');
    elSub.innerHTML = '<option value="">— Selecciona subgrupo —</option>' +
      subs.map(s => `<option value="${s}">${s}</option>`).join('');
    elSub.disabled = false;
  });
}

// ── HISTORIAL ─────────────────────────────────────────────────────────
function renderHistorial(filtroTipo = '', filtroGrupo = '') {
  let txs = [...estado.transacciones].reverse();
  if (filtroTipo) txs = txs.filter(t => t.tipo === filtroTipo);
  if (filtroGrupo) txs = txs.filter(t => t.grupo === filtroGrupo);

  const el = document.getElementById('tabla-historial');
  if (!txs.length) { el.innerHTML = '<p style="color:var(--texto2);margin-top:16px">Sin transacciones registradas.</p>'; return; }

  el.innerHTML = `<table>
    <thead><tr>
      <th>Fecha</th><th>Tipo</th><th>Grupo</th><th>Subgrupo</th><th>Producto</th><th>Monto</th><th>Descripción</th><th>Fuente</th>
    </tr></thead>
    <tbody>
      ${txs.map(t => {
        const cls = t.tipo === 'Ingreso' ? 'tx-ingreso' : t.tipo === 'Egreso' ? 'tx-egreso' : 'tx-traslado';
        const prod = estado.productos.find(p => p.id === t.origen);
        return `<tr>
          <td>${t.fecha}</td>
          <td class="${cls}">${t.tipo}</td>
          <td>${t.grupo}</td>
          <td>${t.subgrupo}</td>
          <td>${prod ? prod.nombre : t.origen}</td>
          <td class="${cls}">${t.tipo === 'Egreso' ? '-' : ''}${fmt(Math.abs(t.monto))}</td>
          <td>${t.descripcion || ''}</td>
          <td style="color:var(--texto2);font-size:12px">${t.fuente || ''}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

// ── FORMULARIOS ───────────────────────────────────────────────────────
function configurarFormularios() {
  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById('tx-fecha').value = hoy;
  document.getElementById('tr-fecha').value = hoy;

  document.getElementById('btn-tx-preview').addEventListener('click', () => {
    const datos = leerFormTx();
    if (!validarTx(datos)) return;
    const prod = estado.productos.find(p => p.id === datos.producto);
    document.getElementById('tx-preview').innerHTML = `
      <strong>Confirmar registro:</strong><br>
      📅 Fecha: ${datos.fecha}<br>
      📂 ${datos.tipo} › ${datos.grupo} › ${datos.subgrupo}<br>
      🏦 Producto: ${prod ? prod.nombre : datos.producto}<br>
      💰 Monto: ${fmt(datos.monto)}<br>
      📝 ${datos.descripcion}
    `;
    document.getElementById('tx-preview').classList.remove('oculto');
    document.getElementById('btn-tx-guardar').classList.remove('oculto');
    document.getElementById('btn-tx-cancelar').classList.remove('oculto');
    document.getElementById('btn-tx-preview').classList.add('oculto');
  });

  document.getElementById('btn-tx-cancelar').addEventListener('click', resetFormTx);

  document.getElementById('btn-tx-guardar').addEventListener('click', async () => {
    const datos = leerFormTx();
    mostrarSpinner(true);
    const id = 'TX' + Date.now();
    await escribirFila('Transacciones', [
      id, datos.fecha, datos.tipo, datos.grupo, datos.subgrupo,
      datos.producto, '', datos.monto, datos.descripcion, 'Manual', 'TRUE', datos.notas
    ]);
    await actualizarSaldoProducto(datos.producto, datos.tipo, datos.monto);
    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast('✓ Transacción registrada');
    resetFormTx();
    cambiarVista('dashboard');
  });

  document.getElementById('btn-tr-preview').addEventListener('click', () => {
    const datos = leerFormTr();
    if (!validarTr(datos)) return;
    const origen = estado.productos.find(p => p.id === datos.origen);
    const destino = estado.productos.find(p => p.id === datos.destino);
    document.getElementById('tr-preview').innerHTML = `
      <strong>Confirmar traslado:</strong><br>
      📅 Fecha: ${datos.fecha}<br>
      🏦 Origen: ${origen ? origen.nombre : datos.origen}<br>
      🏦 Destino: ${destino ? destino.nombre : datos.destino}<br>
      💰 Monto: ${fmt(datos.monto)}<br>
      📝 ${datos.descripcion}
    `;
    document.getElementById('tr-preview').classList.remove('oculto');
    document.getElementById('btn-tr-guardar').classList.remove('oculto');
    document.getElementById('btn-tr-cancelar').classList.remove('oculto');
    document.getElementById('btn-tr-preview').classList.add('oculto');
  });

  document.getElementById('btn-tr-cancelar').addEventListener('click', resetFormTr);

  document.getElementById('btn-tr-guardar').addEventListener('click', async () => {
    const datos = leerFormTr();
    mostrarSpinner(true);
    const id = 'TX' + Date.now();
    await escribirFila('Transacciones', [
      id, datos.fecha, 'Traslado', 'Traslados', 'Traslado entre cuentas',
      datos.origen, datos.destino, datos.monto, datos.descripcion, 'Manual', 'TRUE', ''
    ]);
    await actualizarSaldoProducto(datos.origen, 'Egreso', datos.monto);
    await actualizarSaldoProducto(datos.destino, 'Ingreso', datos.monto);
    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast('✓ Traslado registrado');
    resetFormTr();
    cambiarVista('dashboard');
  });

  document.getElementById('btn-filtrar').addEventListener('click', () => {
    renderHistorial(
      document.getElementById('filtro-tipo').value,
      document.getElementById('filtro-grupo').value
    );
  });
}

function leerFormTx() {
  return {
    fecha: document.getElementById('tx-fecha').value,
    tipo: document.getElementById('tx-tipo').value,
    grupo: document.getElementById('tx-grupo').value,
    subgrupo: document.getElementById('tx-subgrupo').value,
    producto: document.getElementById('tx-producto').value,
    monto: parseFloat(document.getElementById('tx-monto').value) || 0,
    descripcion: document.getElementById('tx-descripcion').value,
    notas: document.getElementById('tx-notas').value
  };
}

function leerFormTr() {
  return {
    fecha: document.getElementById('tr-fecha').value,
    origen: document.getElementById('tr-origen').value,
    destino: document.getElementById('tr-destino').value,
    monto: parseFloat(document.getElementById('tr-monto').value) || 0,
    descripcion: document.getElementById('tr-descripcion').value
  };
}

function validarTx(d) {
  if (!d.fecha) { mostrarToast('Selecciona una fecha'); return false; }
  if (!d.tipo) { mostrarToast('Selecciona el tipo'); return false; }
  if (!d.grupo) { mostrarToast('Selecciona el grupo'); return false; }
  if (!d.subgrupo) { mostrarToast('Selecciona el subgrupo'); return false; }
  if (!d.producto) { mostrarToast('Selecciona el producto'); return false; }
  if (!d.monto || d.monto <= 0) { mostrarToast('Ingresa un monto válido'); return false; }
  return true;
}

function validarTr(d) {
  if (!d.fecha) { mostrarToast('Selecciona una fecha'); return false; }
  if (!d.origen) { mostrarToast('Selecciona cuenta origen'); return false; }
  if (!d.destino) { mostrarToast('Selecciona cuenta destino'); return false; }
  if (d.origen === d.destino) { mostrarToast('Origen y destino no pueden ser iguales'); return false; }
  if (!d.monto || d.monto <= 0) { mostrarToast('Ingresa un monto válido'); return false; }
  return true;
}

function resetFormTx() {
  document.getElementById('tx-tipo').value = '';
  document.getElementById('tx-grupo').innerHTML = '<option value="">— Primero selecciona tipo —</option>';
  document.getElementById('tx-grupo').disabled = true;
  document.getElementById('tx-subgrupo').innerHTML = '<option value="">— Primero selecciona grupo —</option>';
  document.getElementById('tx-subgrupo').disabled = true;
  document.getElementById('tx-producto').value = '';
  document.getElementById('tx-monto').value = '';
  document.getElementById('tx-descripcion').value = '';
  document.getElementById('tx-notas').value = '';
  document.getElementById('tx-preview').classList.add('oculto');
  document.getElementById('btn-tx-guardar').classList.add('oculto');
  document.getElementById('btn-tx-cancelar').classList.add('oculto');
  document.getElementById('btn-tx-preview').classList.remove('oculto');
}

function resetFormTr() {
  document.getElementById('tr-origen').value = '';
  document.getElementById('tr-destino').value = '';
  document.getElementById('tr-monto').value = '';
  document.getElementById('tr-descripcion').value = '';
  document.getElementById('tr-preview').classList.add('oculto');
  document.getElementById('btn-tr-guardar').classList.add('oculto');
  document.getElementById('btn-tr-cancelar').classList.add('oculto');
  document.getElementById('btn-tr-preview').classList.remove('oculto');
}

// ── ACTUALIZACIÓN DE SALDOS ───────────────────────────────────────────
async function actualizarSaldoProducto(productoId, tipo, monto) {
  const filas = await leerHoja('Productos!A2:G');
  for (let i = 0; i < filas.length; i++) {
    if (filas[i][0] === productoId) {
      const saldoActual = parseFloat(filas[i][6]) || 0;
      const nuevoSaldo = tipo === 'Ingreso' ? saldoActual + monto : saldoActual - monto;
      await actualizarCelda(`Productos!G${i + 2}`, nuevoSaldo);
      break;
    }
  }
}

// ── NAV ───────────────────────────────────────────────────────────────
function configurarNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => cambiarVista(btn.dataset.vista));
  });
}

function cambiarVista(vista) {
  document.querySelectorAll('.vista').forEach(v => v.classList.add('oculto'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('activo'));
  document.getElementById('vista-' + vista).classList.remove('oculto');
  document.querySelector(`[data-vista="${vista}"]`).classList.add('activo');
  if (vista === 'historial') renderHistorial();
  if (vista === 'gmail') leerCorreosBancarios();
  if (vista === 'imagen') inicializarIngesta();
  if (vista === 'asistente') inicializarAsistente();
  if (vista === 'proyeccion') inicializarProyeccion();
  if (vista === 'presupuesto') inicializarPresupuesto();
}

// ── FASE 4: INGESTA POR IMAGEN ────────────────────────────────────────
function inicializarIngesta() {
  const area = document.getElementById('imagen-upload-area');
  const input = document.getElementById('imagen-input');
  const preview = document.getElementById('imagen-preview');
  const placeholder = document.getElementById('imagen-placeholder');
  const acciones = document.getElementById('imagen-acciones');

  area.addEventListener('click', () => input.click());

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      preview.src = ev.target.result;
      preview.classList.remove('oculto');
      placeholder.classList.add('oculto');
      acciones.style.display = 'flex';
      document.getElementById('imagen-resultado').innerHTML = '';
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('btn-imagen-nueva').addEventListener('click', () => {
    input.value = '';
    preview.src = '';
    preview.classList.add('oculto');
    placeholder.classList.remove('oculto');
    acciones.style.display = 'none';
    document.getElementById('imagen-resultado').innerHTML = '';
  });

  document.getElementById('btn-analizar-imagen').addEventListener('click', analizarImagen);
}

async function analizarImagen() {
  const input = document.getElementById('imagen-input');
  const file = input.files[0];
  if (!file) { mostrarToast('Selecciona una imagen primero'); return; }

  mostrarSpinner(true);
  document.getElementById('imagen-resultado').innerHTML = '';

  try {
    // Convertir imagen a base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const mediaType = file.type || 'image/jpeg';

    // Construir contexto de transacciones ya registradas
    const txsRecientes = estado.transacciones
      .slice(-50)
      .map(t => `${t.fecha}|${t.monto}|${t.descripcion}`)
      .join('\n');

    const prompt = `Eres un asistente financiero analizando una captura de pantalla de una app bancaria colombiana.

TRANSACCIONES YA REGISTRADAS (últimas 50):
${txsRecientes || 'Ninguna aún'}

INSTRUCCIONES:
1. Extrae TODOS los movimientos visibles en la imagen (débitos, créditos, compras, pagos, transferencias).
2. Para cada movimiento identifica: fecha (formato YYYY-MM-DD), descripción, monto (número sin símbolos ni puntos de miles), tipo (Ingreso o Egreso).
3. Compara cada movimiento con las transacciones ya registradas por fecha+monto. Si ya existe, márcalo como "existe:true", si no como "existe:false".
4. Responde ÚNICAMENTE con un array JSON válido, sin texto adicional, sin markdown, sin explicaciones.

Formato exacto requerido:
[
  {
    "fecha": "2026-05-24",
    "descripcion": "Compra Supermercado",
    "monto": 85000,
    "tipo": "Egreso",
    "existe": false
  }
]

Si no ves movimientos claros en la imagen, responde: []`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': document.getElementById('campo-apikey')?.value || CONFIG.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64
              }
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      mostrarToast('Error de API: ' + data.error.message);
      mostrarSpinner(false);
      return;
    }

    const texto = data.content[0].text.trim();
    let movimientos = [];

    try {
      const clean = texto.replace(/```json|```/g, '').trim();
      movimientos = JSON.parse(clean);
    } catch(e) {
      mostrarToast('No se pudieron extraer movimientos de la imagen');
      mostrarSpinner(false);
      return;
    }

    if (!movimientos.length) {
      document.getElementById('imagen-resultado').innerHTML =
        '<p class="sin-datos">No se detectaron movimientos en la imagen.</p>';
      mostrarSpinner(false);
      return;
    }

    renderMovimientosImagen(movimientos);

  } catch(e) {
    mostrarToast('Error analizando imagen: ' + e.message);
    console.error(e);
  }
  mostrarSpinner(false);
}

function renderMovimientosImagen(movimientos) {
  const nuevos = movimientos.filter(m => !m.existe);
  const existentes = movimientos.filter(m => m.existe);

  let html = `<div style="margin-bottom:16px;font-size:13px;color:var(--texto2)">
    Detectados: <strong style="color:var(--texto)">${movimientos.length}</strong> movimientos —
    <strong style="color:var(--acento)">${nuevos.length} nuevos</strong> por registrar,
    <strong style="color:var(--verde)">${existentes.length} ya registrados</strong>
  </div>`;

  movimientos.forEach((m, i) => {
    const clsMonto = m.tipo === 'Ingreso' ? 'tx-ingreso' : 'tx-egreso';
    const badge = m.existe
      ? '<span class="badge-existe">✓ Ya registrado</span>'
      : '<span class="badge-nuevo">Nuevo</span>';

    const optsProductos = estado.productos
      .map(p => `<option value="${p.id}">${p.nombre}</option>`)
      .join('');
    const optsGrupos = [...new Set(estado.grupos.filter(g => g.tipo === m.tipo).map(g => g.grupo))]
      .map(g => `<option value="${g}">${g}</option>`).join('');

    const accionesHtml = m.existe ? '' : `
      <div class="movimiento-campos">
        <select class="correo-select" id="img-prod-${i}">${optsProductos}</select>
        <select class="correo-select" id="img-grupo-${i}" onchange="actualizarSubgruposImagen(${i})">${optsGrupos}</select>
        <select class="correo-select" id="img-sub-${i}"></select>
        <input class="correo-input" id="img-desc-${i}" type="text" value="${m.descripcion}" />
      </div>
      <div class="movimiento-acciones">
        <button class="btn-confirmar" onclick="registrarMovimientoImagen(${i})">✓ Registrar</button>
        <button class="btn-secundario" onclick="descartarMovimientoImagen(${i})">Ignorar</button>
      </div>`;

    html += `<div class="movimiento-card" id="img-mov-${i}">
      <div class="movimiento-header">
        ${badge}
        <span class="movimiento-fecha">${m.fecha}</span>
        <span class="correo-tipo ${clsMonto}">${m.tipo}</span>
      </div>
      <div class="movimiento-desc">${m.descripcion}</div>
      <div class="movimiento-monto ${clsMonto}">${fmt(m.monto)}</div>
      ${accionesHtml}
    </div>`;
  });

  document.getElementById('imagen-resultado').innerHTML = html;

  // Inicializar subgrupos
  movimientos.forEach((m, i) => {
    if (!m.existe) actualizarSubgruposImagen(i, m.tipo);
  });

  // Guardar movimientos en estado para acceso posterior
  estado.movimientosImagen = movimientos;
}

function actualizarSubgruposImagen(i, tipoForzado) {
  const tipo = tipoForzado || estado.movimientosImagen?.[i]?.tipo || 'Egreso';
  const grupo = document.getElementById(`img-grupo-${i}`)?.value;
  if (!grupo) return;
  const subs = estado.grupos.filter(g => g.grupo === grupo).map(g => g.subgrupo);
  const el = document.getElementById(`img-sub-${i}`);
  if (el) el.innerHTML = subs.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function registrarMovimientoImagen(i) {
  const m = estado.movimientosImagen[i];
  const producto = document.getElementById(`img-prod-${i}`).value;
  const grupo = document.getElementById(`img-grupo-${i}`).value;
  const subgrupo = document.getElementById(`img-sub-${i}`).value;
  const descripcion = document.getElementById(`img-desc-${i}`).value;

  if (!producto || !grupo || !subgrupo) { mostrarToast('Completa todos los campos'); return; }

  mostrarSpinner(true);
  const id = 'TX' + Date.now();
  await escribirFila('Transacciones', [
    id, m.fecha, m.tipo, grupo, subgrupo,
    producto, '', m.monto, descripcion, 'Imagen', 'TRUE', ''
  ]);
  await actualizarSaldoProducto(producto, m.tipo, m.monto);
  await cargarDatos();
  mostrarSpinner(false);
  mostrarToast('✓ Movimiento registrado');
  document.getElementById(`img-mov-${i}`).remove();
}

function descartarMovimientoImagen(i) {
  document.getElementById(`img-mov-${i}`).remove();
}

// ── FASE 5: ASISTENTE IA ──────────────────────────────────────────────
let chatHistorial = [];

function inicializarAsistente() {
  const input = document.getElementById('chat-input');
  const btnEnviar = document.getElementById('btn-chat-enviar');
  const btnLimpiar = document.getElementById('btn-limpiar-chat');

  // Evitar registrar listeners múltiples veces
  btnEnviar.replaceWith(btnEnviar.cloneNode(true));
  btnLimpiar.replaceWith(btnLimpiar.cloneNode(true));
  input.replaceWith(input.cloneNode(true));

  const btnEnviarNuevo = document.getElementById('btn-chat-enviar');
  const btnLimpiarNuevo = document.getElementById('btn-limpiar-chat');
  const inputNuevo = document.getElementById('chat-input');

  btnEnviarNuevo.addEventListener('click', () => enviarMensajeChat());
  btnLimpiarNuevo.addEventListener('click', limpiarChat);
  inputNuevo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviarMensajeChat(); }
  });

  // Mensaje de bienvenida si el chat está vacío
  if (chatHistorial.length === 0) {
    agregarMensajeChat('asistente', `Hola Nacho. Soy tu asistente financiero. Tengo acceso a tus saldos actuales, historial de transacciones y productos financieros.\n\nPuedes preguntarme sobre tus gastos, analizar decisiones bancarias o pedirme recomendaciones. ¿En qué te ayudo?`);
  }
}

function construirContextoFinanciero() {
  // Saldos actuales
  const saldos = estado.productos.map(p =>
    `${p.nombre} (${p.entidad}): ${fmt(p.saldoActual)} — ${p.tipo} — ${p.disponible ? 'Disponible' : 'No disponible'} — Estado: ${p.estado}`
  ).join('\n');

  // Resumen patrimonio
  const totDis = estado.productos.filter(p => p.disponible && p.saldoActual >= 0).reduce((s, p) => s + p.saldoActual, 0);
  const totInv = estado.productos.filter(p => !p.disponible && p.saldoActual > 0).reduce((s, p) => s + p.saldoActual, 0);
  const totDeu = estado.productos.filter(p => p.saldoActual < 0).reduce((s, p) => s + p.saldoActual, 0);
  const neto = totDis + totInv + totDeu;

  // Últimas 50 transacciones
  const txs = estado.transacciones.slice(-50).map(t => {
    const prod = estado.productos.find(p => p.id === t.origen);
    return `${t.fecha} | ${t.tipo} | ${t.grupo} > ${t.subgrupo} | ${prod ? prod.nombre : t.origen} | ${fmt(t.monto)} | ${t.descripcion || ''}`;
  }).join('\n');

  // Gastos del mes actual por categoría
  const hoy = new Date();
  const mesActual = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;
  const txsMes = estado.transacciones.filter(t => t.fecha && t.fecha.startsWith(mesActual));
  const gastosPorGrupo = {};
  txsMes.filter(t => t.tipo === 'Egreso').forEach(t => {
    gastosPorGrupo[t.grupo] = (gastosPorGrupo[t.grupo] || 0) + t.monto;
  });
  const resumenMes = Object.entries(gastosPorGrupo)
    .sort((a, b) => b[1] - a[1])
    .map(([g, v]) => `${g}: ${fmt(v)}`)
    .join('\n');

  const ingresosMes = txsMes.filter(t => t.tipo === 'Ingreso').reduce((s, t) => s + t.monto, 0);
  const egresosMes = txsMes.filter(t => t.tipo === 'Egreso').reduce((s, t) => s + t.monto, 0);

  return `FECHA HOY: ${hoy.toISOString().split('T')[0]}

PATRIMONIO NETO:
- Activos disponibles: ${fmt(totDis)}
- Inversiones LP: ${fmt(totInv)}
- Deudas totales: ${fmt(totDeu)}
- Patrimonio neto: ${fmt(neto)}

SALDOS POR PRODUCTO:
${saldos}

RESUMEN MES ${mesActual}:
- Ingresos: ${fmt(ingresosMes)}
- Egresos: ${fmt(egresosMes)}
- Balance: ${fmt(ingresosMes - egresosMes)}

GASTOS POR CATEGORÍA (mes actual):
${resumenMes || 'Sin egresos registrados este mes'}

ÚLTIMAS 50 TRANSACCIONES:
${txs || 'Sin transacciones registradas'}

DECISIONES ESTRATÉGICAS PENDIENTES:
1. Cerrar cuenta AV Villas (tiene costo mensual, hipoteca se paga por PSE)
2. Cerrar Banco de Bogotá al cancelar TC Visa Platinum (*4762, saldo: ${fmt(Math.abs(estado.productos.find(p => p.id === 'P14')?.saldoActual || 0))})
3. Evaluar traslado nómina BBVA → Bancolombia`;
}

async function enviarMensajeChat(textoForzado) {
  const input = document.getElementById('chat-input');
  const texto = textoForzado || input.value.trim();
  if (!texto) return;

  agregarMensajeChat('usuario', texto);
  if (!textoForzado) input.value = '';

  // Mensaje de espera
  const idPensando = 'pensando-' + Date.now();
  agregarMensajeChat('pensando', 'Analizando...', idPensando);

  try {
    const contexto = construirContextoFinanciero();

    const systemPrompt = `Eres el asistente financiero personal de Nacho (Ignacio Coloma), integrado en su sistema de flujo de caja personal. Tienes acceso completo a sus datos financieros actuales.

PERFIL:
- Profesional financiero senior en ARUS (Medellín, Colombia). Maneja Excel avanzado y SAP. Sabe de finanzas — háblale de igual a igual, sin explicaciones básicas.
- Ecosistema bancario: BBVA (cuenta principal + TC Visa Infinite + crédito libranza), Bancolombia (cuenta + TC MC Black 60 cuotas + Fiducuenta), Nu (cuenta + TC + Cajita), Falabella (cuenta), AV Villas (hipoteca — cerrar cuenta), Banco de Bogotá (cuenta + 2 TC: Platinum a cancelar y nueva Visa con 5% cashback).
- Todos los montos en COP.

OBJETIVOS FINANCIEROS (en orden de prioridad):
1. Sobrevivir el bache de caja de junio-noviembre 2026 sin recurrir a deuda cara
2. Salir de las deudas adicionales de TC (avances de mudanza y viaje)
3. Pagar las deudas familiares (esposa $10M, hija $1.4M) sin presión
4. Ahorrar lo máximo posible para viaje a España (objetivo ~$15M para junio 2027)

SITUACIÓN ESTRATÉGICA ACTUAL (clave para tus análisis):
- Nacho está en DÉFICIT en los próximos meses (jun-nov 2026) por tres gastos extraordinarios acumulados: mudanza de regreso a su apartamento, mantenimiento mayor del carro (pagado con Addi de su esposa, 2 cuotas de $836k jun/jul), y un viaje familiar a fin de junio (~$4.6M, de los cuales él asume $3M y su esposa le reconoce $1.6M).
- El presupuesto base anual cierra cerca de cero/ligero déficit. Los meses fuertes son junio, diciembre (primas) y enero (intereses cesantías + arriendo). Los demás meses son deficitarios.
- ACUERDO CON ESPOSA: los gastos comunes se reparten 50/50, pero actualmente Nacho asume más porque los ingresos de su esposa están temporalmente bajos. Si ella mejora sus ingresos, la carga de Nacho se aliviaría.
- ESTRATEGIA DE DEUDA EN CURSO: Nacho va a evaluar una compra de cartera en la MC Black (tasa preferencial ~14-16% EA usando el 10% de cupo adicional) para consolidar ~$5M de avances que hoy están al 28% EA (Bogotá Platinum $3M + BBVA Infinite $2M). Pendiente confirmar tasa.
- COLCHÓN FONDOSURA: Nacho considera retirar $3-5M de FondoSura (ya tributado) como colchón puntual para el bache, NO como hábito. Monto exacto a definir tras la compra de cartera. Es un recurso de emergencia justificado por la situación crítica temporal.
- Las TC se usan como medio de pago a 1 cuota (cuentas de paso); los avances son la deuda cara a atacar.
- Tiene cesantías ($32.5M) y FondoSura ($15.3M) como ahorro de largo plazo — NO tocar salvo el retiro puntual evaluado.

GASTOS POR COMPORTAMIENTO:
- Sobres (rollover, no se gastan completos cada mes): mantenimiento carro, ropa, médicos, eventos, otros personales. ~$740k/mes presupuestado que rara vez se gasta completo — es el primer amortiguador del déficit.
- Provisiones virtuales (espacio reservado, sin apartar plata aún por la fase de deuda): SOAT, predial, impuesto vehicular, matrícula colegio.

INSTRUCCIONES DE COMPORTAMIENTO:
- Español colombiano, tuteo informal. Respuestas directas y concretas basadas en datos reales.
- Montos en formato $#,##0 COP.
- Señala riesgos concretos, no genéricos. No repitas consejos ya dados en la sesión.
- Para decisiones grandes, considera siempre el orden de prioridad de objetivos y la situación de déficit actual.
- Si no tienes contexto suficiente, dilo claramente. Máximo una pregunta de clarificación por turno.`;

    // Agregar mensaje del usuario al historial
    chatHistorial.push({ role: 'user', content: texto });

    // Mantener historial manejable (últimos 10 turnos)
    const historialReciente = chatHistorial.slice(-20);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': document.getElementById('campo-apikey')?.value || CONFIG.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: document.getElementById('selector-modelo')?.value || 'claude-sonnet-4-5',
        max_tokens: 1500,
        system: systemPrompt + '\n\nCONTEXTO FINANCIERO ACTUAL:\n' + contexto,
        messages: historialReciente
      })
    });

    const data = await response.json();

    // Eliminar mensaje de espera
    document.getElementById(idPensando)?.remove();

    if (data.error) {
      agregarMensajeChat('asistente', 'Error: ' + data.error.message);
      return;
    }

    const respuesta = data.content[0].text;
    chatHistorial.push({ role: 'assistant', content: respuesta });
    agregarMensajeChat('asistente', respuesta);

  } catch(e) {
    document.getElementById(idPensando)?.remove();
    agregarMensajeChat('asistente', 'Error de conexión: ' + e.message);
    console.error(e);
  }
}

function enviarSugerencia(texto) {
  enviarMensajeChat(texto);
}

function agregarMensajeChat(rol, texto, id) {
  const el = document.getElementById('chat-mensajes');
  const div = document.createElement('div');
  div.className = `chat-msg ${rol}`;
  if (id) div.id = id;
  div.textContent = texto;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

function limpiarChat() {
  chatHistorial = [];
  document.getElementById('chat-mensajes').innerHTML = '';
  agregarMensajeChat('asistente', 'Chat limpiado. ¿En qué te ayudo?');
}

// ── FASE 6A: PROYECCIÓN 12 MESES ─────────────────────────────────────
let escenarioActivo = 'base';
let datosProyeccion = null;

function inicializarProyeccion() {
  document.getElementById('btn-generar-proyeccion').addEventListener('click', generarProyeccion);
  document.querySelectorAll('.escenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.escenario-btn').forEach(b => b.classList.remove('activo'));
      btn.classList.add('activo');
      escenarioActivo = btn.dataset.escenario;
      if (datosProyeccion) renderProyeccion(datosProyeccion);
    });
  });
}

function calcularEgresosMensualesBase() {
  // Egresos fijos conocidos de pagos recurrentes
  const fijos = {
    'Hipoteca AV Villas': 830733,
    'TC MC Black (capital)': 833333,
    'Crédito BBVA Libranza': 287432, // quincenal x2
    'Intereses Préstamo LMGO': 100000,
    'FondoSura': 210000, // quincenal x2
  };

  // Calcular promedio de egresos variables de los últimos 3 meses
  const hoy = new Date();
  const hace3meses = new Date(hoy.getFullYear(), hoy.getMonth() - 3, 1);
  const txsRecientes = estado.transacciones.filter(t => {
    if (t.tipo !== 'Egreso') return false;
    const fecha = new Date(t.fecha);
    return fecha >= hace3meses;
  });

  const egresosPorGrupo = {};
  txsRecientes.forEach(t => {
    egresosPorGrupo[t.grupo] = (egresosPorGrupo[t.grupo] || 0) + t.monto;
  });

  // Promediar por 3 meses
  const mesesConDatos = Math.max(1, Math.min(3,
    new Set(txsRecientes.map(t => t.fecha?.substring(0, 7))).size
  ));

  const variablesPorMes = {};
  Object.entries(egresosPorGrupo).forEach(([g, v]) => {
    variablesPorMes[g] = Math.round(v / mesesConDatos);
  });

  return { fijos, variables: variablesPorMes };
}

function calcularIngresosMensualesBase() {
  const hoy = new Date();
  const hace3meses = new Date(hoy.getFullYear(), hoy.getMonth() - 3, 1);
  const txsIngresos = estado.transacciones.filter(t => {
    if (t.tipo !== 'Ingreso') return false;
    const fecha = new Date(t.fecha);
    return fecha >= hace3meses;
  });

  const mesesConDatos = Math.max(1, Math.min(3,
    new Set(txsIngresos.map(t => t.fecha?.substring(0, 7))).size
  ));

  const total = txsIngresos.reduce((s, t) => s + t.monto, 0);
  return Math.round(total / mesesConDatos);
}

function generarProyeccion() {
  mostrarSpinner(true);

  const { fijos, variables } = calcularEgresosMensualesBase();
  const ingresoBase = calcularIngresosMensualesBase();

  // Si no hay suficientes datos, usar valores estimados del perfil
  const ingresoFinal = ingresoBase > 0 ? ingresoBase : 8000000;

  const totalFijos = Object.values(fijos).reduce((s, v) => s + v, 0);
  const totalVariables = Object.values(variables).reduce((s, v) => s + v, 0);
  const egresoBase = totalFijos + totalVariables;

  // Factores por escenario
  const factores = {
    optimista:  { ingresos: 1.10, egresos: 0.90 },
    base:       { ingresos: 1.00, egresos: 1.00 },
    pesimista:  { ingresos: 0.90, egresos: 1.10 }
  };

  // Saldo inicial = total disponible actual
  const saldoInicial = estado.productos
    .filter(p => p.disponible && p.saldoActual > 0)
    .reduce((s, p) => s + p.saldoActual, 0);

  const hoy = new Date();
  const meses = [];

  for (let i = 0; i < 12; i++) {
    const fecha = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const nombreMes = fecha.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });

    const escenarios = {};
    ['optimista', 'base', 'pesimista'].forEach(esc => {
      const f = factores[esc];
      const ingresos = Math.round(ingresoFinal * f.ingresos);
      const egresos = Math.round(egresoBase * f.egresos);
      const balance = ingresos - egresos;
      escenarios[esc] = { ingresos, egresos, balance };
    });

    meses.push({ mes: nombreMes, indice: i, escenarios });
  }

  // Calcular saldos acumulados
  let saldos = { optimista: saldoInicial, base: saldoInicial, pesimista: saldoInicial };
  meses.forEach(m => {
    ['optimista', 'base', 'pesimista'].forEach(esc => {
      saldos[esc] += m.escenarios[esc].balance;
      m.escenarios[esc].saldoAcumulado = saldos[esc];
    });
  });

  datosProyeccion = {
    meses,
    saldoInicial,
    ingresoBase: ingresoFinal,
    egresoBase,
    fijos,
    variables,
    mesesConDatos: new Set(estado.transacciones.map(t => t.fecha?.substring(0, 7))).size
  };

  renderProyeccion(datosProyeccion);
  mostrarSpinner(false);
}

function renderProyeccion(datos) {
  const esc = escenarioActivo;
  const meses = datos.meses;

  // Resumen final del escenario
  const balanceFinal = meses[11].escenarios[esc].saldoAcumulado;
  const balanceMensualProm = Math.round(meses.reduce((s, m) => s + m.escenarios[esc].balance, 0) / 12);
  const mesesNegativo = meses.filter(m => m.escenarios[esc].balance < 0).length;

  const colorFinal = balanceFinal >= datos.saldoInicial ? 'verde' : 'rojo';
  const colorBalance = balanceMensualProm >= 0 ? 'verde' : 'rojo';

  let html = `
  <div class="resumen-proyeccion">
    <div class="resumen-card">
      <div class="label">Saldo inicial</div>
      <div class="valor">${fmt(datos.saldoInicial)}</div>
    </div>
    <div class="resumen-card">
      <div class="label">Saldo proyectado (mes 12)</div>
      <div class="valor ${colorFinal}">${fmt(balanceFinal)}</div>
    </div>
    <div class="resumen-card">
      <div class="label">Balance mensual promedio</div>
      <div class="valor ${colorBalance}">${fmt(balanceMensualProm)}</div>
    </div>
    <div class="resumen-card">
      <div class="label">Meses con balance negativo</div>
      <div class="valor ${mesesNegativo > 0 ? 'rojo' : 'verde'}">${mesesNegativo}</div>
    </div>
  </div>`;

  // Nota sobre calidad de datos
  if (datos.mesesConDatos < 3) {
    html += `<div style="background:rgba(243,156,18,0.1);border:1px solid var(--amarillo);border-radius:var(--radio);padding:12px;margin-bottom:16px;font-size:13px;color:var(--amarillo)">
      ⚠️ Proyección basada en ${datos.mesesConDatos} mes(es) de datos. La precisión mejora con más historial registrado.
    </div>`;
  }

  // Tabla de proyección
  html += `<div class="proyeccion-tabla"><table>
    <thead><tr>
      <th>Mes</th>
      <th>Ingresos</th>
      <th>Egresos</th>
      <th>Balance</th>
      <th>Saldo acumulado</th>
    </tr></thead>
    <tbody>`;

  meses.forEach(m => {
    const d = m.escenarios[esc];
    const clsBalance = d.balance >= 0 ? 'positivo' : 'negativo';
    const clsSaldo = d.saldoAcumulado >= datos.saldoInicial ? 'positivo' : 'negativo';
    html += `<tr>
      <td><strong>${m.mes}</strong></td>
      <td class="positivo">${fmt(d.ingresos)}</td>
      <td class="negativo">-${fmt(d.egresos)}</td>
      <td class="${clsBalance}">${d.balance >= 0 ? '+' : ''}${fmt(d.balance)}</td>
      <td class="${clsSaldo}">${fmt(d.saldoAcumulado)}</td>
    </tr>`;
  });

  // Fila de totales
  const totIngresos = meses.reduce((s, m) => s + m.escenarios[esc].ingresos, 0);
  const totEgresos = meses.reduce((s, m) => s + m.escenarios[esc].egresos, 0);
  const totBalance = totIngresos - totEgresos;
  html += `<tr class="fila-total">
    <td>TOTAL 12M</td>
    <td>${fmt(totIngresos)}</td>
    <td>-${fmt(totEgresos)}</td>
    <td>${totBalance >= 0 ? '+' : ''}${fmt(totBalance)}</td>
    <td>${fmt(meses[11].escenarios[esc].saldoAcumulado)}</td>
  </tr>`;

  html += `</tbody></table></div>`;

  // Desglose de egresos base
  html += `<div style="margin-top:24px">
    <h3 style="font-size:14px;color:var(--texto2);margin-bottom:12px;text-transform:uppercase;letter-spacing:0.5px">Egresos base mensuales</h3>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-width:520px">`;

  Object.entries(datos.fijos).forEach(([nombre, valor]) => {
    html += `<div style="background:var(--bg2);border:1px solid var(--borde);border-radius:var(--radio);padding:10px 14px;font-size:13px">
      <div style="color:var(--texto2);font-size:11px">${nombre}</div>
      <div style="font-weight:700">${fmt(valor)}</div>
    </div>`;
  });

  Object.entries(datos.variables).forEach(([grupo, valor]) => {
    html += `<div style="background:var(--bg2);border:1px solid var(--borde);border-radius:var(--radio);padding:10px 14px;font-size:13px">
      <div style="color:var(--texto2);font-size:11px">${grupo} (prom.)</div>
      <div style="font-weight:700">${fmt(valor)}</div>
    </div>`;
  });

  html += `</div></div>`;

  document.getElementById('proyeccion-resultado').innerHTML = html;
}

// ── FASE 6B: REAL VS PRESUPUESTO ─────────────────────────────────────
function inicializarPresupuesto() {
  // Poblar selector de meses
  const sel = document.getElementById('ppto-mes');
  if (sel.options.length === 0) {
    const hoy = new Date();
    for (let i = 0; i < 12; i++) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const valor = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
      const label = fecha.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
      const opt = document.createElement('option');
      opt.value = valor;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  const btn = document.getElementById('btn-cargar-ppto');
  btn.replaceWith(btn.cloneNode(true));
  document.getElementById('btn-cargar-ppto').addEventListener('click', cargarComparativo);
}

async function cargarComparativo() {
  const mes = document.getElementById('ppto-mes').value;
  mostrarSpinner(true);

  try {
    // Leer presupuesto del Sheet para ese mes
    const filasPpto = await leerHoja('Presupuesto!A2:F');
    const ppto = filasPpto.filter(f => f[0] && f[0].startsWith(mes));

    // Leer transacciones reales del mes
    const txsMes = estado.transacciones.filter(t =>
      t.fecha && t.fecha.startsWith(mes) && (t.tipo === 'Egreso' || t.tipo === 'Ingreso')
    );

    document.getElementById('ppto-aviso').style.display = ppto.length === 0 ? 'block' : 'none';

    // Construir mapa de real por grupo-subgrupo
    const realMap = {};
    txsMes.forEach(t => {
      const key = `${t.tipo}|${t.grupo}|${t.subgrupo}`;
      realMap[key] = (realMap[key] || 0) + t.monto;
    });

    // Construir mapa de presupuesto
    const pptoMap = {};
    ppto.forEach(f => {
      const key = `${f[1]}|${f[2]}|${f[3]}`;
      pptoMap[key] = (pptoMap[key] || 0) + (parseFloat(f[4]) || 0);
    });

    // Unir todas las claves
    const todasClaves = new Set([...Object.keys(realMap), ...Object.keys(pptoMap)]);

    // Agrupar por tipo y grupo
    const agrupado = {};
    todasClaves.forEach(key => {
      const [tipo, grupo, subgrupo] = key.split('|');
      if (!agrupado[tipo]) agrupado[tipo] = {};
      if (!agrupado[tipo][grupo]) agrupado[tipo][grupo] = [];
      agrupado[tipo][grupo].push({
        subgrupo,
        real: realMap[key] || 0,
        ppto: pptoMap[key] || 0
      });
    });

    renderComparativo(agrupado, mes);

  } catch(e) {
    mostrarToast('Error cargando comparativo: ' + e.message);
    console.error(e);
  }
  mostrarSpinner(false);
}

function renderComparativo(agrupado, mes) {
  const fechaLabel = new Date(mes + '-02').toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
  let html = `<h3 style="font-size:15px;margin-bottom:16px;color:var(--texto2)">${fechaLabel}</h3>`;

  let totalReal = 0;
  let totalPpto = 0;

  ['Egreso', 'Ingreso'].forEach(tipo => {
    if (!agrupado[tipo]) return;
    html += `<div style="margin-bottom:24px">
      <div style="font-size:12px;color:var(--texto2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
        ${tipo === 'Egreso' ? '💸 Egresos' : '💰 Ingresos'}
      </div>`;

    html += `<div class="ppto-fila header">
      <div>Categoría</div>
      <div>Presupuesto</div>
      <div>Real</div>
      <div>Desviación</div>
      <div>%</div>
    </div>`;

    let subtotalReal = 0;
    let subtotalPpto = 0;

    Object.entries(agrupado[tipo]).forEach(([grupo, items]) => {
      const grupoReal = items.reduce((s, i) => s + i.real, 0);
      const grupoPpto = items.reduce((s, i) => s + i.ppto, 0);
      subtotalReal += grupoReal;
      subtotalPpto += grupoPpto;

      html += `<div class="ppto-fila grupo-header">
        <div>${grupo}</div>
        <div>${grupoPpto > 0 ? fmt(grupoPpto) : '—'}</div>
        <div>${grupoReal > 0 ? fmt(grupoReal) : '—'}</div>
        <div>${renderDesviacion(grupoReal, grupoPpto, tipo)}</div>
        <div>${renderPct(grupoReal, grupoPpto, tipo)}</div>
      </div>`;

      items.forEach(item => {
        html += `<div class="ppto-fila">
          <div style="padding-left:16px;color:var(--texto2)">${item.subgrupo}</div>
          <div>${item.ppto > 0 ? fmt(item.ppto) : '—'}</div>
          <div>${item.real > 0 ? fmt(item.real) : '—'}</div>
          <div>${renderDesviacion(item.real, item.ppto, tipo)}</div>
          <div>${renderPct(item.real, item.ppto, tipo)}</div>
        </div>`;
      });
    });

    totalReal += subtotalReal;
    totalPpto += subtotalPpto;

    html += `<div class="ppto-fila total-row">
      <div>SUBTOTAL ${tipo.toUpperCase()}S</div>
      <div>${fmt(subtotalPpto)}</div>
      <div>${fmt(subtotalReal)}</div>
      <div>${renderDesviacion(subtotalReal, subtotalPpto, tipo)}</div>
      <div>${renderPct(subtotalReal, subtotalPpto, tipo)}</div>
    </div></div>`;
  });

  // Balance del mes
  const balanceReal = (agrupado['Ingreso'] ? Object.values(agrupado['Ingreso']).flat().reduce((s, i) => s + i.real, 0) : 0) -
                      (agrupado['Egreso'] ? Object.values(agrupado['Egreso']).flat().reduce((s, i) => s + i.real, 0) : 0);
  const balancePpto = (agrupado['Ingreso'] ? Object.values(agrupado['Ingreso']).flat().reduce((s, i) => s + i.ppto, 0) : 0) -
                      (agrupado['Egreso'] ? Object.values(agrupado['Egreso']).flat().reduce((s, i) => s + i.ppto, 0) : 0);

  html += `<div class="ppto-fila total-row" style="border-top:2px solid var(--acento);margin-top:8px">
    <div>BALANCE DEL MES</div>
    <div class="${balancePpto >= 0 ? 'verde' : 'rojo'}">${fmt(balancePpto)}</div>
    <div class="${balanceReal >= 0 ? 'verde' : 'rojo'}">${fmt(balanceReal)}</div>
    <div></div>
    <div></div>
  </div>`;

  document.getElementById('ppto-resultado').innerHTML = html;
}

function renderDesviacion(real, ppto, tipo) {
  if (ppto === 0) return '<span style="color:var(--texto2)">—</span>';
  const desv = tipo === 'Egreso' ? real - ppto : ppto - real;
  const cls = desv <= 0 ? 'verde' : desv <= ppto * 0.1 ? 'amarillo' : 'rojo';
  const signo = desv >= 0 ? '+' : '';
  return `<span class="${cls}" style="font-size:12px">${signo}${fmt(Math.abs(desv))}</span>`;
}

function renderPct(real, ppto, tipo) {
  if (ppto === 0) return '<span style="color:var(--texto2)">—</span>';
  const pct = Math.round((real / ppto) * 100);
  const cls = tipo === 'Egreso'
    ? (pct <= 90 ? 'barra-ok' : pct <= 110 ? 'barra-alerta' : 'barra-excedido')
    : (pct >= 100 ? 'barra-ok' : pct >= 80 ? 'barra-alerta' : 'barra-excedido');
  return `<div>
    <div style="font-size:11px;margin-bottom:2px;color:var(--texto2)">${pct}%</div>
    <div class="barra-desviacion">
      <div class="barra-fill ${cls}" style="width:${Math.min(pct, 150)}%"></div>
    </div>
  </div>`;
}

// ── ALERTADOR DE VENCIMIENTOS ─────────────────────────────────────────
async function revisarVencimientos() {
  try {
    const filas = await leerHoja('Pagos_Recurrentes!A2:J');
    const hoy = new Date();
    const diaHoy = hoy.getDate();
    const alertas = [];

    filas.forEach(f => {
      const nombre = f[0];
      const monto = parseFloat(f[4]) || 0;
      const frecuencia = f[5] || '';
      let diaPago = parseInt(f[6]) || 0;
      if (!diaPago && (f[6] || '').toLowerCase().includes('último')) {
        diaPago = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
      }
      const activo = (f[8] || '').toString().toUpperCase() === 'TRUE';

      if (!activo || !diaPago) return;
      if (frecuencia !== 'Mensual') return; // por ahora solo mensuales con día fijo

      // Calcular días hasta el vencimiento
      let diasFaltantes = diaPago - diaHoy;
      if (diasFaltantes < 0) {
        // Ya pasó este mes, calcular para el próximo mes
        const diasEnMes = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0).getDate();
        diasFaltantes = (diasEnMes - diaHoy) + diaPago;
      }

      if (diasFaltantes >= 0 && diasFaltantes <= 5) {
        alertas.push({ nombre, monto, diaPago, diasFaltantes });
      }
    });

    renderAlertasVencimiento(alertas);
  } catch(e) {
    console.error('Error revisando vencimientos:', e);
  }
}

function renderAlertasVencimiento(alertas) {
  let cont = document.getElementById('alertas-vencimiento');
  if (!cont) {
    cont = document.createElement('div');
    cont.id = 'alertas-vencimiento';
    const dashboard = document.getElementById('vista-dashboard');
    dashboard.insertBefore(cont, dashboard.firstChild);
  }

  if (!alertas.length) {
    cont.innerHTML = '';
    return;
  }

  alertas.sort((a, b) => a.diasFaltantes - b.diasFaltantes);

  cont.innerHTML = `<div class="alertas-box">
    <div class="alertas-titulo">🔔 Pagos próximos (5 días)</div>
    ${alertas.map(a => {
      const urgente = a.diasFaltantes <= 2;
      const cuando = a.diasFaltantes === 0 ? 'Hoy' :
                     a.diasFaltantes === 1 ? 'Mañana' :
                     `En ${a.diasFaltantes} días`;
      return `<div class="alerta-item ${urgente ? 'urgente' : ''}">
        <span class="alerta-nombre">${a.nombre}</span>
        <span class="alerta-cuando">${cuando} (día ${a.diaPago})</span>
        <span class="alerta-monto">${a.monto > 0 ? fmt(a.monto) : ''}</span>
      </div>`;
    }).join('')}
  </div>`;
}

// ── UTILIDADES ────────────────────────────────────────────────────────
function fmt(n) {
  return '$' + Math.round(n).toLocaleString('es-CO');
}

function mostrarToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('oculto');
  setTimeout(() => el.classList.add('oculto'), 3500);
}

function mostrarSpinner(visible) {
  document.getElementById('spinner').classList.toggle('oculto', !visible);
}
