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

  el.innerHTML = correos.map((c) => {
    const cerrado = esPeriodoCerrado(c.fecha);
    const optsProductos = estado.productos
      .map(p => `<option value="${p.id}" ${p.id === c.productoSugerido ? 'selected' : ''}>${p.nombre}</option>`)
      .join('');
    const optsGrupos = [...new Set(estado.grupos.filter(g => g.tipo === c.tipo).map(g => g.grupo))]
      .map(g => `<option value="${g}">${g}</option>`).join('');

    return `<div class="correo-card" id="correo-${c.gmailId}">
      <div class="correo-header">
        <span class="correo-banco">${c.banco}</span>
        <span class="correo-fecha">${c.fecha}</span>
        <span class="correo-tipo ${c.tipo === 'Ingreso' ? 'tx-ingreso' : 'tx-egreso'}">${c.tipo}</span>
      </div>
      <div class="correo-asunto">${c.textoPreview}</div>
      <div class="correo-monto">${fmt(c.monto)}</div>
      <div class="correo-campos">
        <select class="correo-select" id="correo-prod-${c.gmailId}" onchange="avisoCuotaTC('${c.gmailId}')">${optsProductos}</select>
        <select class="correo-select" id="correo-grupo-${c.gmailId}" onchange="actualizarSubgruposCorreo('${c.gmailId}')">${optsGrupos}</select>
        <select class="correo-select" id="correo-sub-${c.gmailId}"></select>
        <input class="correo-input" id="correo-desc-${c.gmailId}" type="text" placeholder="Descripción" value="${c.asunto.substring(0,50)}" />
        <div class="aviso-cuota-tc oculto" id="correo-aviso-${c.gmailId}" style="font-size:0.85em;color:#0a7;margin-top:4px;">ℹ️ Se registrará a 1 cuota. Para diferir, usa +Transacción.</div>
      </div>
      ${cerrado ? '<div class="correo-cerrado-aviso">🔒 Fecha de un mes ya cerrado — no se puede registrar</div>' : ''}
      <div class="correo-acciones">
        ${cerrado
          ? '<button class="btn-confirmar" disabled style="opacity:0.5;cursor:not-allowed;">🔒 Mes cerrado</button>'
          : `<button class="btn-confirmar" onclick="confirmarCorreo('${c.gmailId}')">✓ Registrar</button>`}
        <button class="btn-secundario" onclick="descartarCorreo('${c.gmailId}')">Ignorar</button>
      </div>
    </div>`;
  }).join('');

  correos.forEach((c) => actualizarSubgruposCorreo(c.gmailId, c.tipo));
  correos.forEach((c) => avisoCuotaTC(c.gmailId));
}

// Muestra un aviso si el producto elegido en un correo es Tarjeta Crédito.
function avisoCuotaTC(gmailId) {
  const prodId = document.getElementById(`correo-prod-${gmailId}`)?.value;
  const aviso = document.getElementById(`correo-aviso-${gmailId}`);
  if (!aviso) return;
  const prod = estado.productos.find(p => p.id === prodId);
  const esTC = prod && prod.tipo === 'Tarjeta Crédito';
  aviso.classList.toggle('oculto', !esTC);
}

function actualizarSubgruposCorreo(gmailId, tipoForzado) {
  const correo = estado.correosPendientes.find(c => c.gmailId === gmailId);
  const tipo = tipoForzado || correo?.tipo || 'Egreso';
  const grupo = document.getElementById(`correo-grupo-${gmailId}`)?.value;
  if (!grupo) return;
  const subs = estado.grupos.filter(g => g.grupo === grupo).map(g => g.subgrupo);
  const el = document.getElementById(`correo-sub-${gmailId}`);
  if (el) el.innerHTML = subs.map(s => `<option value="${s}">${s}</option>`).join('');
}

async function confirmarCorreo(gmailId) {
  const c = estado.correosPendientes.find(x => x.gmailId === gmailId);
  if (!c) { mostrarToast('No se encontró el correo'); return; }
  const producto = document.getElementById(`correo-prod-${gmailId}`).value;
  const grupo = document.getElementById(`correo-grupo-${gmailId}`).value;
  const subgrupo = document.getElementById(`correo-sub-${gmailId}`).value;
  const descripcion = document.getElementById(`correo-desc-${gmailId}`).value;

  if (!producto || !grupo || !subgrupo) { mostrarToast('Completa todos los campos'); return; }
  if (esPeriodoCerrado(c.fecha)) {
    mostrarToast('🔒 No se puede registrar: la fecha pertenece a un mes ya cerrado');
    return;
  }
  mostrarSpinner(true);
  const datosTx = {
    fecha: c.fecha, tipo: c.tipo, grupo, subgrupo,
    producto, monto: c.monto, descripcion, fuente: 'Gmail', notas: c.gmailId,
    numCuotas: 1, primeraCuota: '', conInteres: false
  };
  const r = construirFilaTx(datosTx);
  await escribirFila('Transacciones', r.fila);
  // Si es compra con TC (no pago de TC), generar su cuota corriente
  const prodSel = estado.productos.find(p => p.id === producto);
  if (!r.esTraslado && prodSel && prodSel.tipo === 'Tarjeta Crédito') {
    await generarCuotasTC(r.idTx, datosTx);
  }
  // Si es pago de TC (traslado a una tarjeta), marcar las cuotas del extracto como pagadas
  if (r.esTraslado && r.destino) {
    const prodDestino = estado.productos.find(p => p.id === r.destino);
    if (prodDestino && prodDestino.tipo === 'Tarjeta Crédito') {
      await marcarCuotasPagoExtracto(r.destino, r.idTx, m.fecha);
    }
  }
  await cargarDatos();
  mostrarSpinner(false);
  mostrarToast(r.esTraslado ? '✓ Pago de TC registrado desde Gmail' : '✓ Transacción registrada desde Gmail');
  document.getElementById(`correo-${gmailId}`)?.remove();
  estado.correosPendientes = estado.correosPendientes.filter(x => x.gmailId !== gmailId);
}

function descartarCorreo(gmailId) {
  document.getElementById(`correo-${gmailId}`)?.remove();
  estado.correosPendientes = estado.correosPendientes.filter(x => x.gmailId !== gmailId);
}

// ── CARGA DE DATOS ────────────────────────────────────────────────────
async function cargarDatos() {
  mostrarSpinner(true);
  try {
    const [filasProductos, filasGrupos, filasTx, filasPpto, filasContexto, filasConfig, filasCuotas] = await Promise.all([
      leerHoja('Productos!A2:O'),
      leerHoja('Grupos!A2:D'),
      leerHoja('Transacciones!A2:L'),
      leerHoja('Presupuesto!A2:F'),
      leerHoja('Contexto!A2:C'),
      leerHoja('Config!A2:B'),
      leerHoja('Cuotas_TC!A2:L')
    ]);

    estado.productos = filasProductos.map(f => ({
      id: f[0], nombre: f[1], entidad: f[2], tipo: f[3],
      cuenta: f[4], saldoInicial: parseFloat(f[5]) || 0,
      saldoActual: parseFloat(f[6]) || 0,
      cupoTotal: parseFloat(f[7]) || 0,
      cuotaFija: parseFloat(f[8]) || 0,
      fechaPago: f[9] || '', fechaCorte: f[10] || '',
      disponible: f[11] === 'TRUE', estado: f[12] || 'Activa',
      comentarios: f[13] || '',
      saldoCierre: parseFloat(f[14]) || 0
    }));

    estado.grupos = filasGrupos.map(f => ({ tipo: f[0], grupo: f[1], subgrupo: f[2], cuentaDestino: f[3] || '' }));
    estado.transacciones = filasTx.map(f => ({
      id: f[0], fecha: f[1], tipo: f[2], grupo: f[3], subgrupo: f[4],
      origen: f[5], destino: f[6], monto: parseFloat(f[7]) || 0,
      descripcion: f[8], fuente: f[9], confirmado: f[10], notas: f[11]
    }));

    estado.presupuesto = filasPpto.map(f => ({
      fecha: f[0], tipo: f[1], grupo: f[2], subgrupo: f[3],
      monto: parseFloat(f[4]) || 0, comentario: f[5] || ''
    }));

    estado.contexto = filasContexto
      .filter(f => f[0] && (f[2] || '').toString().toUpperCase() !== 'FALSE')
      .map(f => ({ categoria: f[0], consideracion: f[1] || '' }));

    estado.cuotasTC = filasCuotas.map(f => ({
      idCuota: f[0], idCompra: f[1], idTx: f[2], productoTC: f[3],
      descripcion: f[4], numCuota: parseInt(f[5]) || 0,
      totalCuotas: parseInt(f[6]) || 0, capitalCuota: parseFloat(f[7]) || 0,
      fechaVencimiento: f[8] || '', estado: f[9] || 'Pendiente',
      conInteres: (f[10] || '').toString().toUpperCase() === 'SI',
      idTxPago: f[11] || ''
    }));

    estado.config = {};
    filasConfig.forEach(f => { if (f[0]) estado.config[f[0]] = f[1]; });
    estado.ultimoCierre = estado.config.ultimo_cierre || '2026-05-31';

    // Recalcular saldos en memoria (saldo cierre + movimientos del mes)
    estado.productos.forEach(p => { p.saldoActual = calcularSaldoProducto(p.id); });

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

  const mesActual = new Date().toISOString().substring(0, 7);
  const comprometido = calcularComprometidoMes(mesActual);
  const dispNeto = totDis - comprometido;
  const elComp = document.getElementById('total-comprometido');
  const elDispNeto = document.getElementById('disponible-neto');
  if (elComp) elComp.textContent = fmt(comprometido);
  if (elDispNeto) {
    elDispNeto.textContent = fmt(dispNeto);
    elDispNeto.className = dispNeto >= 0 ? 'verde' : 'rojo';
  }

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
    return `<div class="card card-clicable" onclick="abrirExtractoProducto('${p.id}')" title="Ver extracto">
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

  const corte = estado.ultimoCierre;

  el.innerHTML = `<table>
    <thead><tr>
      <th>Fecha</th><th>Tipo</th><th>Grupo</th><th>Subgrupo</th><th>Producto</th><th>Monto</th><th>Descripción</th><th>Fuente</th><th></th>
    </tr></thead>
    <tbody>
      ${txs.map(t => {
        const cls = t.tipo === 'Ingreso' ? 'tx-ingreso' : t.tipo === 'Egreso' ? 'tx-egreso' : 'tx-traslado';
        const prod = estado.productos.find(p => p.id === t.origen);
        const editable = t.fecha && t.fecha > corte;
        const acciones = editable
          ? `<button class="btn-tx-editar" onclick="abrirEdicionTx('${t.id}')" title="Editar">✏️</button>
             <button class="btn-tx-borrar" onclick="eliminarTx('${t.id}')" title="Eliminar">X</button>`
          : `<span title="Mes cerrado" style="color:var(--texto2);font-size:12px">🔒</span>`;
        return `<tr>
          <td>${t.fecha}</td>
          <td class="${cls}">${t.tipo}</td>
          <td>${t.grupo}</td>
          <td>${t.subgrupo}</td>
          <td>${prod ? prod.nombre : t.origen}</td>
          <td class="${cls}">${t.tipo === 'Egreso' ? '-' : ''}${fmt(Math.abs(t.monto))}</td>
          <td>${t.descripcion || ''}</td>
          <td style="color:var(--texto2);font-size:12px">${t.fuente || ''}</td>
          <td style="white-space:nowrap">${acciones}</td>
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
    if (esPeriodoCerrado(datos.fecha)) {
      mostrarToast('🔒 No se puede registrar: la fecha pertenece a un mes ya cerrado');
      return;
    }
    mostrarSpinner(true);
    datos.fuente = 'Manual';
    const r = construirFilaTx(datos);
    await escribirFila('Transacciones', r.fila);
    // Si la compra es con TC (no es pago de TC), generar su(s) cuota(s)
    const prodSel = estado.productos.find(p => p.id === datos.producto);
    if (!r.esTraslado && prodSel && prodSel.tipo === 'Tarjeta Crédito') {
      await generarCuotasTC(r.idTx, datos);
    }
    // Si es pago de TC (traslado a una tarjeta), marcar las cuotas del extracto como pagadas
    if (r.esTraslado && r.destino) {
      const prodDestino = estado.productos.find(p => p.id === r.destino);
      if (prodDestino && prodDestino.tipo === 'Tarjeta Crédito') {
        await marcarCuotasPagoExtracto(r.destino, r.idTx, datos.fecha);
      }
    }
    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast(r.esTraslado ? '✓ Pago de TC registrado' : '✓ Transacción registrada');
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

  // ── Mostrar opción de cuotas solo si el producto es Tarjeta Crédito ──
  const selProducto = document.getElementById('tx-producto');
  const bloqueCuotas = document.getElementById('tx-cuotas-bloque');
  const chkDiferir = document.getElementById('tx-diferir');
  const bloqueNumCuotas = document.getElementById('tx-num-cuotas-bloque');

  function actualizarVisibilidadCuotas() {
    const prod = estado.productos.find(p => p.id === selProducto.value);
    const esTC = prod && prod.tipo === 'Tarjeta Crédito';
    bloqueCuotas.classList.toggle('oculto', !esTC);
    if (!esTC) {
      chkDiferir.checked = false;
      bloqueNumCuotas.classList.add('oculto');
    }
  }

  selProducto.addEventListener('change', actualizarVisibilidadCuotas);
  chkDiferir.addEventListener('change', () => {
    bloqueNumCuotas.classList.toggle('oculto', !chkDiferir.checked);
    if (chkDiferir.checked) {
      const prod = estado.productos.find(p => p.id === selProducto.value);
      const fechaCompra = document.getElementById('tx-fecha').value || new Date().toISOString().substring(0, 10);
      const ayuda = document.getElementById('tx-primera-cuota-ayuda');
      const venc = prod ? calcularPrimerVencimiento(prod, fechaCompra) : '';
      if (venc) {
        document.getElementById('tx-primera-cuota').value = venc;
        ayuda.textContent = 'Calculada automáticamente — ajústala si el banco la pone otro día.';
      } else {
        document.getElementById('tx-primera-cuota').value = '';
        ayuda.textContent = 'Este producto no tiene corte fijo. Ingresa la fecha de la primera cuota.';
      }
    }
  });
}

function leerFormTx() {
  const diferir = document.getElementById('tx-diferir');
  const esDiferido = diferir && diferir.checked;
  return {
    fecha: document.getElementById('tx-fecha').value,
    tipo: document.getElementById('tx-tipo').value,
    grupo: document.getElementById('tx-grupo').value,
    subgrupo: document.getElementById('tx-subgrupo').value,
    producto: document.getElementById('tx-producto').value,
    monto: parseFloat(document.getElementById('tx-monto').value) || 0,
    descripcion: document.getElementById('tx-descripcion').value,
    notas: document.getElementById('tx-notas').value,
    numCuotas: esDiferido ? (parseInt(document.getElementById('tx-num-cuotas').value) || 1) : 1,
    primeraCuota: esDiferido ? document.getElementById('tx-primera-cuota').value : '',
    conInteres: esDiferido ? document.getElementById('tx-con-interes').checked : false
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

// ── VALIDACIÓN DE PERÍODO CERRADO ─────────────────────────────────────
// Devuelve true si la fecha cae en un mes ya cerrado (≤ último cierre).
// Esas transacciones no se pueden registrar: el pasado está bloqueado.
function esPeriodoCerrado(fecha) {
  if (!fecha) return false;
  return fecha <= estado.ultimoCierre;
}

// ── PAGOS DE TC COMO TRASLADO ─────────────────────────────────────────
// Dado el grupo+subgrupo de un movimiento, decide si es un pago de TC.
// Si lo es, devuelve los datos como Traslado (cuenta origen → TC destino).
// Si no, los devuelve tal cual (movimiento normal).
function construirFilaTx(d) {
  // d = { fecha, tipo, grupo, subgrupo, producto, monto, descripcion, fuente, notas }
  const g = estado.grupos.find(x => x.grupo === d.grupo && x.subgrupo === d.subgrupo);
  const tcDestino = g && g.cuentaDestino ? g.cuentaDestino : '';
  const idTx = 'TX' + Date.now();

  if (tcDestino) {
    // Es pago de TC → traslado: sale de la cuenta origen, abona la TC
    return {
      esTraslado: true,
      idTx,
      origen: d.producto,
      destino: tcDestino,
      fila: [
        idTx, d.fecha, 'Traslado', d.grupo, d.subgrupo,
        d.producto, tcDestino, d.monto, d.descripcion, d.fuente, 'TRUE', d.notas || ''
      ]
    };
  }

  // Movimiento normal
  return {
    esTraslado: false,
    idTx,
    origen: d.producto,
    destino: '',
    fila: [
      idTx, d.fecha, d.tipo, d.grupo, d.subgrupo,
      d.producto, '', d.monto, d.descripcion, d.fuente, 'TRUE', d.notas || ''
    ]
  };
}

// ── ACTUALIZACIÓN DE SALDOS ───────────────────────────────────────────
async function actualizarSaldoProducto(productoId) {
  // Con el nuevo enfoque, el saldo se recalcula desde saldoCierre + movimientos.
  // Las transacciones ya están en estado.transacciones (la fuente de verdad).
  const prod = estado.productos.find(p => p.id === productoId);
  if (!prod) return;

  const nuevoSaldo = calcularSaldoProducto(productoId);
  prod.saldoActual = nuevoSaldo;

  // Escribir al Sheet para mantenerlo al día
  const filas = await leerHoja('Productos!A2:O');
  for (let i = 0; i < filas.length; i++) {
    if (filas[i][0] === productoId) {
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
  if (vista === 'nomina') inicializarNomina();
  if (vista === 'cierre') inicializarCierre();
  if (vista === 'notas') inicializarNotas();
  if (vista === 'extracto') inicializarExtracto();
  if (vista === 'ppto-vista') inicializarPptoVista();
  if (vista === 'abono-tc') inicializarAbonoTC();
}

// ── ABONO ANTICIPADO A TC ─────────────────────────────────────────────
function inicializarAbonoTC() {
  const selOrigen = document.getElementById('abono-origen');
  const selTC = document.getElementById('abono-tc');
  document.getElementById('abono-fecha').value = new Date().toISOString().substring(0, 10);

  // Cuenta de origen: cuentas de ahorro (de donde sale el dinero)
  selOrigen.innerHTML = '<option value="">— Selecciona —</option>';
  estado.productos
    .filter(p => p.tipo === 'Cuenta Ahorros')
    .forEach(p => { selOrigen.innerHTML += `<option value="${p.id}">${p.nombre}</option>`; });

  // Tarjetas: las de tipo Tarjeta Crédito
  selTC.innerHTML = '<option value="">— Selecciona —</option>';
  estado.productos
    .filter(p => p.tipo === 'Tarjeta Crédito')
    .forEach(p => { selTC.innerHTML += `<option value="${p.id}">${p.nombre}</option>`; });

  document.getElementById('abono-compras').innerHTML = '';
  document.getElementById('btn-abono-guardar').classList.add('oculto');

  selTC.onchange = renderComprasAbono;
  document.getElementById('btn-abono-guardar').onclick = registrarAbonoTC;
}

// Registra el abono: marca como Pagada las últimas N cuotas de cada compra indicada,
// y registra el Traslado del dinero (cuenta origen → TC).
async function registrarAbonoTC() {
  const btn = document.getElementById('btn-abono-guardar');
  const tcId = document.getElementById('abono-tc').value;
  const origenId = document.getElementById('abono-origen').value;
  const fecha = document.getElementById('abono-fecha').value;

  if (!tcId || !origenId || !fecha) {
    mostrarToast('Completa origen, tarjeta y fecha'); return;
  }
  if (esPeriodoCerrado(fecha)) {
    mostrarToast('No puedes registrar un abono en un mes cerrado'); return;
  }

  // Recoger qué cuotas abona el usuario por cada compra
  const inputs = document.querySelectorAll('.abono-cuotas-input');
  const aPagar = []; // { idCompra, cantidad, capital }
  let montoTotal = 0;
  inputs.forEach(inp => {
    const n = parseInt(inp.value) || 0;
    if (n > 0) {
      const capital = parseFloat(inp.dataset.capital) || 0;
      aPagar.push({ idCompra: inp.dataset.compra, cantidad: n });
      montoTotal += n * capital;
    }
  });

  if (aPagar.length === 0) { mostrarToast('Indica al menos una cuota a abonar'); return; }

  btn.disabled = true;
  const textoOrig = btn.textContent;
  btn.textContent = 'Registrando...';
  mostrarSpinner(true);

  try {
    const idTx = 'TX' + Date.now();
    // 1. Marcar como Pagada las últimas N cuotas pendientes de cada compra
    const filas = await leerHoja('Cuotas_TC!A2:L');
    for (const item of aPagar) {
      // Buscar las cuotas pendientes de esa compra, ordenadas por número de cuota descendente
      const cuotasCompra = [];
      for (let i = 0; i < filas.length; i++) {
        if (filas[i][1] === item.idCompra && filas[i][9] === 'Pendiente') {
          cuotasCompra.push({ filaSheet: i + 2, numCuota: parseInt(filas[i][5]) || 0 });
        }
      }
      // Reducir plazo: las más lejanas (número de cuota más alto) primero
      cuotasCompra.sort((a, b) => b.numCuota - a.numCuota);
      const aMarcar = cuotasCompra.slice(0, item.cantidad);
      for (const c of aMarcar) {
        await actualizarCelda(`Cuotas_TC!J${c.filaSheet}`, 'Pagada');
        await actualizarCelda(`Cuotas_TC!L${c.filaSheet}`, idTx);
      }
    }

    // 2. Registrar el Traslado del dinero usando el subgrupo de pago vinculado a esa TC
    const grupoPago = estado.grupos.find(g => g.cuentaDestino === tcId);
    if (!grupoPago) {
      mostrarSpinner(false);
      btn.disabled = false; btn.textContent = textoOrig;
      mostrarToast('No encontré el subgrupo de pago vinculado a esta tarjeta. Revisa la hoja Grupos.');
      return;
    }
    await escribirFila('Transacciones', [
      idTx, fecha, 'Traslado', grupoPago.grupo, grupoPago.subgrupo,
      origenId, tcId, montoTotal, 'Abono anticipado a TC', 'Manual', 'TRUE', ''
    ]);

    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast(`✓ Abono de ${fmt(montoTotal)} registrado`);
    cambiarVista('dashboard');
  } catch (e) {
    mostrarSpinner(false);
    mostrarToast('Error al registrar abono: ' + e.message);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = textoOrig;
  }
}

// Muestra las compras con cuotas pendientes de la TC elegida, con campo para indicar cuántas cuotas abona
function renderComprasAbono() {
  const tcId = document.getElementById('abono-tc').value;
  const cont = document.getElementById('abono-compras');
  const btnGuardar = document.getElementById('btn-abono-guardar');

  if (!tcId) { cont.innerHTML = ''; btnGuardar.classList.add('oculto'); return; }

  const compras = comprasConCuotasPendientes(tcId);
  if (compras.length === 0) {
    cont.innerHTML = '<p style="color:#888">Esta tarjeta no tiene cuotas pendientes registradas.</p>';
    btnGuardar.classList.add('oculto');
    return;
  }

  let html = '<label>Indica cuántas cuotas adelantas de cada compra:</label>';
  compras.forEach(c => {
    const desc = c.descripcion || '(sin descripción)';
    html += `
      <div class="abono-compra" style="border:1px solid #ddd;border-radius:6px;padding:8px;margin:6px 0;">
        <div style="font-weight:600">${desc}</div>
        <div style="font-size:0.85em;color:#666">
          ${c.cuotasPendientes} cuota(s) pendiente(s) · saldo ${fmt(c.saldoPendiente)} · ${c.conInteres ? 'con interés' : 'sin interés'}
        </div>
        <label style="margin-top:6px;font-size:0.9em">Cuotas a abonar (0 = ninguna)</label>
        <input type="number" class="abono-cuotas-input" data-compra="${c.idCompra}"
               min="0" max="${c.cuotasPendientes}" value="0"
               data-capital="${c.capitalCuota}" data-pendientes="${c.cuotasPendientes}">
      </div>`;
  });
  cont.innerHTML = html;
  btnGuardar.classList.remove('oculto');
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
    const cerrado = esPeriodoCerrado(m.fecha);
    const clsMonto = m.tipo === 'Ingreso' ? 'tx-ingreso' : 'tx-egreso';
    const badge = m.existe
      ? '<span class="badge-existe">✓ Ya registrado</span>'
      : '<span class="badge-nuevo">Nuevo</span>';

    const optsProductos = estado.productos
      .map(p => `<option value="${p.id}">${p.nombre}</option>`)
      .join('');
    const optsGrupos = [...new Set(estado.grupos.filter(g => g.tipo === m.tipo).map(g => g.grupo))]
      .map(g => `<option value="${g}">${g}</option>`).join('');

    let accionesHtml = '';
    if (m.existe) {
      accionesHtml = '';
    } else if (cerrado) {
      accionesHtml = '<div class="correo-cerrado-aviso">🔒 Fecha de un mes ya cerrado — no se puede registrar</div>';
    } else {
      accionesHtml = `
      <div class="movimiento-campos">
        <select class="correo-select" id="img-prod-${i}" onchange="avisoCuotaTCImagen(${i})">${optsProductos}</select>
        <select class="correo-select" id="img-grupo-${i}" onchange="actualizarSubgruposImagen(${i})">${optsGrupos}</select>
        <select class="correo-select" id="img-sub-${i}"></select>
        <input class="correo-input" id="img-desc-${i}" type="text" value="${m.descripcion}" />
        <div class="aviso-cuota-tc oculto" id="img-aviso-${i}" style="font-size:0.85em;color:#0a7;margin-top:4px;">ℹ️ Se registrará a 1 cuota. Para diferir, usa +Transacción.</div>
      </div>
      <div class="movimiento-acciones">
        <button class="btn-confirmar" onclick="registrarMovimientoImagen(${i})">✓ Registrar</button>
        <button class="btn-secundario" onclick="descartarMovimientoImagen(${i})">Ignorar</button>
      </div>`;
    }

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
    if (!m.existe) {
      actualizarSubgruposImagen(i, m.tipo);
      avisoCuotaTCImagen(i);
    }
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

// Muestra un aviso si el producto elegido en un movimiento de imagen es Tarjeta Crédito.
function avisoCuotaTCImagen(i) {
  const prodId = document.getElementById(`img-prod-${i}`)?.value;
  const aviso = document.getElementById(`img-aviso-${i}`);
  if (!aviso) return;
  const prod = estado.productos.find(p => p.id === prodId);
  const esTC = prod && prod.tipo === 'Tarjeta Crédito';
  aviso.classList.toggle('oculto', !esTC);
}

async function registrarMovimientoImagen(i) {
  const m = estado.movimientosImagen[i];
  const producto = document.getElementById(`img-prod-${i}`).value;
  const grupo = document.getElementById(`img-grupo-${i}`).value;
  const subgrupo = document.getElementById(`img-sub-${i}`).value;
  const descripcion = document.getElementById(`img-desc-${i}`).value;

  if (!producto || !grupo || !subgrupo) { mostrarToast('Completa todos los campos'); return; }
  if (esPeriodoCerrado(m.fecha)) {
    mostrarToast('🔒 No se puede registrar: la fecha pertenece a un mes ya cerrado');
    return;
  }

  mostrarSpinner(true);
  const datosTx = {
    fecha: m.fecha, tipo: m.tipo, grupo, subgrupo,
    producto, monto: m.monto, descripcion, fuente: 'Imagen', notas: '',
    numCuotas: 1, primeraCuota: '', conInteres: false
  };
  const r = construirFilaTx(datosTx);
  await escribirFila('Transacciones', r.fila);
  // Si es compra con TC (no pago de TC), generar su cuota corriente
  const prodSel = estado.productos.find(p => p.id === producto);
  if (!r.esTraslado && prodSel && prodSel.tipo === 'Tarjeta Crédito') {
    await generarCuotasTC(r.idTx, datosTx);
  }
  // Si es pago de TC (traslado a una tarjeta), marcar las cuotas del extracto como pagadas
  if (r.esTraslado && r.destino) {
    const prodDestino = estado.productos.find(p => p.id === r.destino);
    if (prodDestino && prodDestino.tipo === 'Tarjeta Crédito') {
      await marcarCuotasPagoExtracto(r.destino, r.idTx, c.fecha);
    }
  }
  await cargarDatos();
  mostrarSpinner(false);
  mostrarToast(r.esTraslado ? '✓ Pago de TC registrado' : '✓ Movimiento registrado');
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

  // Presupuesto próximos 12 meses (resumen por mes y categoría)
  let resumenPpto = '';
  if (estado.presupuesto && estado.presupuesto.length) {
    const porMes = {};
    estado.presupuesto.forEach(p => {
      const mes = (p.fecha || '').substring(0, 7);
      if (!mes) return;
      if (!porMes[mes]) porMes[mes] = { ingresos: 0, egresos: 0 };
      if (p.tipo === 'Ingreso') porMes[mes].ingresos += p.monto;
      else if (p.tipo === 'Egreso') porMes[mes].egresos += p.monto;
    });
    resumenPpto = Object.keys(porMes).sort().map(mes => {
      const m = porMes[mes];
      return `${mes}: ingresos ${fmt(m.ingresos)}, egresos ${fmt(m.egresos)}, balance ${fmt(m.ingresos - m.egresos)}`;
    }).join('\n');
  }

  // Consideraciones personales (hoja Contexto)
  let notasContexto = '';
  if (estado.contexto && estado.contexto.length) {
    notasContexto = estado.contexto.map(c => `- [${c.categoria}] ${c.consideracion}`).join('\n');
  }

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

PRESUPUESTO PROYECTADO (próximos 12 meses):
${resumenPpto || 'Sin presupuesto cargado'}

CONSIDERACIONES Y DECISIONES ACTUALES (mantenidas por Nacho, son verdades vigentes sobre su situación):
${notasContexto || 'Sin consideraciones registradas'}`;
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
- Si no tienes contexto suficiente, dilo claramente. Máximo una pregunta de clarificación por turno.

GESTIÓN DE CONSIDERACIONES: Nacho mantiene una lista de "consideraciones y decisiones actuales" (mostrada arriba en el contexto), que él edita desde la app. Esa lista es la memoria persistente de su situación. Cuando en la conversación detectes que una consideración quedó obsoleta (por ejemplo, una decisión que ya ejecutó) o que surge un dato permanente nuevo y relevante que debería quedar registrado, sugiérele explícitamente que actualice esa nota: indícale si conviene desactivarla, editarla o agregar una nueva, y con qué texto. No edites tú las notas (no tienes esa capacidad); solo recomiéndale el cambio para que él lo haga desde la pestaña de notas. Hazlo solo cuando sea claramente pertinente, sin ser repetitivo.`;
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

// ── FORMULARIO DE NÓMINA ──────────────────────────────────────────────
function inicializarNomina() {
  // Fecha de hoy
  document.getElementById('nom-fecha').value = new Date().toISOString().split('T')[0];

  // Poblar cuenta destino (cuentas de ahorro)
  const sel = document.getElementById('nom-cuenta');
  const cuentas = estado.productos.filter(p => p.tipo === 'Cuenta Ahorros');
  sel.innerHTML = cuentas.map(p =>
    `<option value="${p.id}" ${p.entidad === 'BBVA' ? 'selected' : ''}>${p.nombre}</option>`
  ).join('');

  // Listeners (evitar duplicados con clonado)
  ['btn-nom-calcular','btn-nom-guardar','btn-nom-cancelar','btn-nom-agregar'].forEach(id => {
    const b = document.getElementById(id);
    b.replaceWith(b.cloneNode(true));
  });

  document.getElementById('btn-nom-calcular').addEventListener('click', calcularNeto);
  document.getElementById('btn-nom-cancelar').addEventListener('click', resetNomina);
  document.getElementById('btn-nom-agregar').addEventListener('click', agregarLineaDescuento);
  document.getElementById('btn-nom-guardar').addEventListener('click', guardarNomina);
}

function agregarLineaDescuento() {
  const cont = document.getElementById('nom-descuentos');
  const div = document.createElement('div');
  div.className = 'nomina-linea nomina-linea-nueva';
  div.innerHTML = `
    <input type="text" class="rubro-nuevo" placeholder="Concepto (ej: Compra interna)" />
    <input type="number" class="nom-desc-extra" value="0" />
    <button class="btn-quitar-linea" onclick="this.parentElement.remove()">×</button>
  `;
  cont.appendChild(div);
}

function calcularNeto() {
  const bruto = parseFloat(document.getElementById('nom-bruto').value) || 0;
  let totalDesc = 0;
  document.querySelectorAll('#nom-descuentos .nomina-linea').forEach(linea => {
    const inp = linea.querySelector('input[type="number"]');
    totalDesc += parseFloat(inp.value) || 0;
  });
  const neto = bruto - totalDesc;
  document.getElementById('nom-neto').textContent = fmt(neto);

  document.getElementById('btn-nom-guardar').classList.remove('oculto');
  document.getElementById('btn-nom-cancelar').classList.remove('oculto');
}

async function guardarNomina() {
  const fecha = document.getElementById('nom-fecha').value;
  const cuentaDestino = document.getElementById('nom-cuenta').value;
  const bruto = parseFloat(document.getElementById('nom-bruto').value) || 0;

  if (!fecha || !cuentaDestino || bruto <= 0) {
    mostrarToast('Completa fecha, cuenta y salario bruto');
    return;
  }

  // Recolectar descuentos
  const descuentos = [];
  document.querySelectorAll('#nom-descuentos .nomina-linea').forEach(linea => {
    const inp = linea.querySelector('input[type="number"]');
    const valor = parseFloat(inp.value) || 0;
    if (valor <= 0) return;

    if (linea.dataset.grupo) {
      // Descuento fijo predefinido
      descuentos.push({ grupo: linea.dataset.grupo, sub: linea.dataset.sub, valor });
    } else {
      // Descuento nuevo agregado
      const rubro = linea.querySelector('.rubro-nuevo')?.value || 'Otros egresos';
      descuentos.push({ grupo: 'Otros egresos', sub: rubro, valor });
    }
  });

  const totalDesc = descuentos.reduce((s, d) => s + d.valor, 0);
  const neto = bruto - totalDesc;

  mostrarSpinner(true);
  try {
    const baseId = Date.now();

    // 1. Registrar ingreso bruto (entra a la cuenta)
    await escribirFila('Transacciones', [
      'TX' + baseId, fecha, 'Ingreso', 'Ingresos', 'ARUS salario neto',
      cuentaDestino, '', bruto, 'Salario bruto quincena', 'Nómina', 'TRUE', ''
    ]);

    // 2. Registrar cada descuento como egreso de la cuenta
    let i = 1;
    for (const d of descuentos) {
      await escribirFila('Transacciones', [
        'TX' + (baseId + i), fecha, 'Egreso', d.grupo, d.sub,
        cuentaDestino, '', d.valor, 'Descuento nómina', 'Nómina', 'TRUE', ''
      ]);
      i++;
    }

    // 3. Actualizar saldo de la cuenta: +bruto -descuentos = +neto
    await actualizarSaldoProducto(cuentaDestino, 'Ingreso', neto);

    // 4. Si hay aporte a FondoSura, actualizar su saldo (la plata va a inversión)
    const aporteFondo = descuentos.find(d => d.sub && d.sub.includes('FondoSura'));
    if (aporteFondo) {
      const fondo = estado.productos.find(p => p.nombre.includes('FondoSura'));
      if (fondo) await actualizarSaldoProducto(fondo.id, 'Ingreso', aporteFondo.valor);
    }

    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast('✓ Nómina registrada — neto: ' + fmt(neto));
    resetNomina();
    cambiarVista('dashboard');
  } catch(e) {
    mostrarSpinner(false);
    mostrarToast('Error registrando nómina: ' + e.message);
    console.error(e);
  }
}

function resetNomina() {
  document.getElementById('btn-nom-guardar').classList.add('oculto');
  document.getElementById('btn-nom-cancelar').classList.add('oculto');
  document.getElementById('nom-neto').textContent = '$0';
  document.querySelectorAll('.nomina-linea-nueva').forEach(l => l.remove());
}

// ── FORMULARIO DE CIERRE DE MES ───────────────────────────────────────
let cierreCalculado = null;

function inicializarCierre() {
  // Poblar selector de mes
  const sel = document.getElementById('cierre-mes');
  if (sel.options.length === 0) {
    const hoy = new Date();
    for (let i = 0; i < 12; i++) {
      const fecha = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
      const valor = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
      const label = fecha.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
      const opt = document.createElement('option');
      opt.value = valor; opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  // Productos de deuda (créditos e hipoteca, NO tarjetas)
  const deuda = estado.productos.filter(p =>
    (p.tipo === 'Crédito' || p.tipo === 'Crédito Hipotecario') && p.estado === 'Activa'
  );
  document.getElementById('cierre-deuda').innerHTML = deuda.map(p => `
    <div class="cierre-linea" data-id="${p.id}">
      <span class="cierre-nombre">${p.nombre}</span>
      <span class="cierre-saldo-actual">Actual: ${fmt(Math.abs(p.saldoActual))}</span>
      <input type="number" class="cierre-input-deuda" placeholder="Nuevo saldo capital" />
    </div>
  `).join('');

  // Productos de inversión
  const inversion = estado.productos.filter(p =>
    p.tipo === 'Cuenta Inversión' || p.tipo === 'Inversión LP' || p.tipo === 'Inversión Internacional'
  );
  document.getElementById('cierre-inversion').innerHTML = inversion.map(p => `
    <div class="cierre-linea" data-id="${p.id}">
      <span class="cierre-nombre">${p.nombre}</span>
      <span class="cierre-saldo-actual">Actual: ${fmt(p.saldoActual)}</span>
      <input type="number" class="cierre-input-inv" placeholder="Saldo actual real" />
    </div>
  `).join('');

  // Cuentas de ahorro (para conciliación)
  const cuentas = estado.productos.filter(p =>
    p.tipo === 'Cuenta Ahorros' && p.estado === 'Activa'
  );
  document.getElementById('cierre-cuentas').innerHTML = cuentas.map(p => `
    <div class="cierre-linea" data-id="${p.id}">
      <span class="cierre-nombre">${p.nombre}</span>
      <span class="cierre-saldo-actual">App: ${fmt(p.saldoActual)}</span>
      <input type="number" class="cierre-input-cuenta" placeholder="Saldo real del banco" />
    </div>
  `).join('');

  // Listeners
  ['btn-cierre-calcular','btn-cierre-guardar','btn-cierre-cancelar'].forEach(id => {
    const b = document.getElementById(id);
    b.replaceWith(b.cloneNode(true));
  });
  document.getElementById('btn-cierre-calcular').addEventListener('click', calcularCierre);
  document.getElementById('btn-cierre-cancelar').addEventListener('click', resetCierre);
  document.getElementById('btn-cierre-guardar').addEventListener('click', guardarCierre);
}

function calcularCierre() {
  const mes = document.getElementById('cierre-mes').value;
  const actualizaciones = [];
  let html = '';

  // Deuda: actualización directa de saldo
  document.querySelectorAll('#cierre-deuda .cierre-linea').forEach(linea => {
    const id = linea.dataset.id;
    const inp = linea.querySelector('.cierre-input-deuda');
    const nuevoSaldo = parseFloat(inp.value);
    if (isNaN(nuevoSaldo)) return;
    const prod = estado.productos.find(p => p.id === id);
    // Deuda se guarda como negativo
    const saldoFinal = -Math.abs(nuevoSaldo);
    const amortizado = Math.abs(prod.saldoActual) - Math.abs(saldoFinal);
    actualizaciones.push({ id, nombre: prod.nombre, tipo: 'deuda', saldoFinal });
    html += `<div>💳 <strong>${prod.nombre}</strong>: nuevo saldo ${fmt(saldoFinal)} — amortizado este mes: <span class="rend-positivo">${fmt(amortizado)}</span></div>`;
  });

  // Inversión: calcular rendimiento
  document.querySelectorAll('#cierre-inversion .cierre-linea').forEach(linea => {
    const id = linea.dataset.id;
    const inp = linea.querySelector('.cierre-input-inv');
    const saldoFinal = parseFloat(inp.value);
    if (isNaN(saldoFinal)) return;
    const prod = estado.productos.find(p => p.id === id);
    const saldoInicial = prod.saldoActual;

    // Sumar traslados del mes hacia/desde este producto
    let entradas = 0, salidas = 0;
    estado.transacciones.forEach(t => {
      if (!t.fecha || !t.fecha.startsWith(mes)) return;
      if (t.tipo === 'Traslado') {
        if (t.destino === id) entradas += t.monto;
        if (t.origen === id) salidas += t.monto;
      }
    });

    const rendimiento = saldoFinal - saldoInicial - entradas + salidas;
    actualizaciones.push({ id, nombre: prod.nombre, tipo: 'inversion', saldoFinal, rendimiento, entradas, salidas });

    const clsRend = rendimiento >= 0 ? 'rend-positivo' : 'rend-negativo';
    html += `<div>📈 <strong>${prod.nombre}</strong>: saldo ${fmt(saldoFinal)} · entradas ${fmt(entradas)} · salidas ${fmt(salidas)} → rendimiento: <span class="${clsRend}">${fmt(rendimiento)}</span></div>`;
  });

  // Cuentas de ahorro: conciliación (saldo calculado vs real)
  document.querySelectorAll('#cierre-cuentas .cierre-linea').forEach(linea => {
    const id = linea.dataset.id;
    const inp = linea.querySelector('.cierre-input-cuenta');
    const saldoReal = parseFloat(inp.value);
    if (isNaN(saldoReal)) return; // si no ingresó saldo real, no la concilia
    const prod = estado.productos.find(p => p.id === id);
    const saldoCalculado = prod.saldoActual;
    const diferencia = saldoReal - saldoCalculado;

    actualizaciones.push({
      id, nombre: prod.nombre, tipo: 'cuenta',
      saldoFinal: saldoReal, saldoCalculado, diferencia
    });

    if (Math.abs(diferencia) < 1) {
      html += `<div>🏦 <strong>${prod.nombre}</strong>: ${fmt(saldoReal)} — <span class="rend-positivo">cuadra ✓</span></div>`;
    } else {
      const signo = diferencia > 0 ? '+' : '';
      html += `<div>🏦 <strong>${prod.nombre}</strong>: real ${fmt(saldoReal)} vs app ${fmt(saldoCalculado)} → <span class="rend-negativo">diferencia ${signo}${fmt(diferencia)}</span></div>`;
    }
  });

  // Si hay cuentas con diferencia, mostrar opciones de conciliación
  const conDiferencia = actualizaciones.filter(a => a.tipo === 'cuenta' && Math.abs(a.diferencia) >= 1);
  if (conDiferencia.length) {
    html += `<div style="margin-top:14px;padding:12px;background:var(--bg3);border-radius:8px;border-left:3px solid var(--amarillo)">
      <strong>⚠️ Hay diferencias de conciliación.</strong><br>
      <span style="font-size:13px;color:var(--texto2)">Elige cómo proceder antes de confirmar:</span>
      <div style="margin-top:8px">
        <label style="display:block;margin:6px 0;font-size:13px">
          <input type="radio" name="modo-dif" value="corregir" checked />
          Voy a corregir los movimientos (cancelo y reviso el historial)
        </label>
        <label style="display:block;margin:6px 0;font-size:13px">
          <input type="radio" name="modo-dif" value="ajuste" />
          Registrar la diferencia como ajuste de conciliación
        </label>
      </div>
    </div>`;
  }

  if (!actualizaciones.length) {
    mostrarToast('Ingresa al menos un saldo');
    return;
  }

  cierreCalculado = { mes, actualizaciones };
  document.getElementById('cierre-resultado').innerHTML =
    `<div class="cierre-rendimiento"><strong>Resumen del cierre:</strong><br>${html}</div>`;
  document.getElementById('btn-cierre-guardar').classList.remove('oculto');
  document.getElementById('btn-cierre-cancelar').classList.remove('oculto');
}

async function guardarCierre() {
  if (!cierreCalculado) return;
  const { mes, actualizaciones } = cierreCalculado;

  // Determinar el modo de manejo de diferencias (si aplica)
  const modoDif = document.querySelector('input[name="modo-dif"]:checked')?.value;
  const conDiferencia = actualizaciones.filter(a => a.tipo === 'cuenta' && Math.abs(a.diferencia) >= 1);

  // Si hay diferencias y eligió "corregir", no cerramos: lo mandamos a revisar
  if (conDiferencia.length && modoDif === 'corregir') {
    mostrarToast('Cierre pausado: corrige los movimientos en el historial y vuelve a calcular');
    return;
  }

  // Fecha de cierre = último día del mes cerrado
  const [anio, mesNum] = mes.split('-').map(Number);
  const ultimoDia = new Date(anio, mesNum, 0).getDate();
  const fechaCierre = `${mes}-${String(ultimoDia).padStart(2, '0')}`;

  if (!confirm(`Vas a cerrar ${mes}. Después de esto, las transacciones de ese mes y anteriores quedarán bloqueadas. ¿Continuar?`)) return;

  mostrarSpinner(true);
  try {
    const filas = await leerHoja('Productos!A2:O');

    for (const a of actualizaciones) {
      // Para inversión: registrar el rendimiento como ingreso/pérdida
      if (a.tipo === 'inversion' && Math.abs(a.rendimiento) > 0) {
        await escribirFila('Transacciones', [
          'TX' + Date.now() + Math.floor(Math.random()*100),
          fechaCierre, 'Ingreso', 'Ingresos', 'Rendimientos financieros',
          a.id, '', a.rendimiento, `Rendimiento ${a.nombre} - cierre ${mes}`, 'Cierre', 'TRUE', ''
        ]);
      }

      // Para cuenta con diferencia en modo "ajuste": registrar transacción de ajuste
      if (a.tipo === 'cuenta' && Math.abs(a.diferencia) >= 1 && modoDif === 'ajuste') {
        const esIngreso = a.diferencia > 0;
        await escribirFila('Transacciones', [
          'TX' + Date.now() + Math.floor(Math.random()*100),
          fechaCierre,
          esIngreso ? 'Ingreso' : 'Egreso',
          esIngreso ? 'Ingresos' : 'Otros egresos',
          esIngreso ? 'Otros ingresos' : 'Ajuste de conciliación',
          a.id, '', Math.abs(a.diferencia),
          `Ajuste conciliación cierre ${mes}`, 'Cierre', 'TRUE', ''
        ]);
      }
    }

    // Recargar para que las transacciones nuevas (rendimientos/ajustes) entren al estado
    await cargarDatos();

    // Congelar Saldo_Cierre (columna O) de TODOS los productos con su saldo actual ya calculado
    const filas2 = await leerHoja('Productos!A2:O');
    for (let i = 0; i < estado.productos.length; i++) {
      const prod = estado.productos[i];
      // Para deuda e inversión, usar el saldo final ingresado; para el resto, el calculado
      const act = actualizaciones.find(a => a.id === prod.id);
      let saldoCongelar;
      if (act && (act.tipo === 'deuda' || act.tipo === 'inversion')) {
        saldoCongelar = act.saldoFinal;
      } else {
        saldoCongelar = prod.saldoActual; // cuentas de ahorro y demás: saldo ya calculado/conciliado
      }
      await actualizarCelda(`Productos!O${i + 2}`, saldoCongelar);
      await actualizarCelda(`Productos!G${i + 2}`, saldoCongelar);
    }

    // Actualizar la fecha de último cierre en Config
    await actualizarCelda('Config!B2', fechaCierre);

    await cargarDatos();
    await recalcularSaldos(true);
    mostrarSpinner(false);
    mostrarToast(`✓ Mes ${mes} cerrado correctamente`);
    resetCierre();
    cambiarVista('dashboard');
  } catch(e) {
    mostrarSpinner(false);
    mostrarToast('Error en cierre: ' + e.message);
    console.error(e);
  }
}
function resetCierre() {
  cierreCalculado = null;
  document.getElementById('cierre-resultado').innerHTML = '';
  document.getElementById('btn-cierre-guardar').classList.add('oculto');
  document.getElementById('btn-cierre-cancelar').classList.add('oculto');
  document.querySelectorAll('#vista-cierre input').forEach(i => i.value = '');
}

// ── NOTAS / CONTEXTO ──────────────────────────────────────────────────
function inicializarNotas() {
  const b = document.getElementById('btn-nota-agregar');
  b.replaceWith(b.cloneNode(true));
  document.getElementById('btn-nota-agregar').addEventListener('click', agregarNota);
  renderNotas();
}

function renderNotas() {
  const el = document.getElementById('notas-lista');
  if (!estado.contexto || !estado.contexto.length) {
    el.innerHTML = '<p style="color:var(--texto2);font-size:14px">Sin consideraciones registradas aún.</p>';
    return;
  }
  el.innerHTML = estado.contexto.map((c, i) => `
    <div class="nota-card">
      <span class="nota-cat">${c.categoria}</span>
      <span class="nota-texto-cont">${c.consideracion}</span>
      <button class="nota-borrar" onclick="borrarNota(${i})" title="Eliminar">🗑</button>
    </div>
  `).join('');
}

async function agregarNota() {
  const categoria = document.getElementById('nota-categoria').value;
  const texto = document.getElementById('nota-texto').value.trim();
  if (!texto) { mostrarToast('Escribe la consideración'); return; }

  mostrarSpinner(true);
  try {
    await escribirFila('Contexto', [categoria, texto, 'TRUE']);
    await cargarDatos();
    document.getElementById('nota-texto').value = '';
    renderNotas();
    mostrarToast('✓ Nota agregada');
  } catch(e) {
    mostrarToast('Error agregando nota: ' + e.message);
  }
  mostrarSpinner(false);
}

async function borrarNota(indice) {
  if (!confirm('¿Eliminar esta consideración?')) return;
  mostrarSpinner(true);
  try {
    // Leer todas las filas actuales de Contexto
    const filas = await leerHoja('Contexto!A2:C');
    // Reconstruir sin la fila del índice indicado (solo activas se muestran, así que mapeamos por contenido)
    const nota = estado.contexto[indice];
    // Encontrar la fila real que coincide con categoría + consideración
    let filaReal = -1;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i][0] === nota.categoria && filas[i][1] === nota.consideracion &&
          (filas[i][2] || '').toString().toUpperCase() !== 'FALSE') {
        filaReal = i;
        break;
      }
    }
    if (filaReal === -1) { mostrarToast('No se encontró la nota'); mostrarSpinner(false); return; }

    // Marcar como FALSE (desactivar) en lugar de borrar físicamente — más seguro
    await actualizarCelda(`Contexto!C${filaReal + 2}`, 'FALSE');
    await cargarDatos();
    renderNotas();
    mostrarSpinner(false);
    mostrarToast('✓ Nota eliminada');
  } catch(e) {
    mostrarSpinner(false);
    mostrarToast('Error eliminando nota: ' + e.message);
  }
}

// ── CÁLCULO DE SALDOS POR PERÍODO ─────────────────────────────────────
// Revisa si una transacción tiene cuotas pagadas o de períodos cerrados (intocables).
// Devuelve true si la compra NO se puede editar en monto/producto.
function tieneCuotasIntocables(idTx) {
  if (!estado.cuotasTC) return false;
  return estado.cuotasTC.some(c =>
    c.idTx === idTx &&
    c.estado !== 'Anulada' &&
    (c.estado === 'Pagada' || (c.fechaVencimiento && c.fechaVencimiento <= estado.ultimoCierre))
  );
}

// Marca como Pagada las cuotas de una TC al registrar el pago normal del extracto.
// Cubre todas las cuotas pendientes con vencimiento hasta el fin del mes del pago
// (incluye meses anteriores que siguieran pendientes). Guarda el ID del pago en col L.
async function marcarCuotasPagoExtracto(tcId, idTxPago, fechaPago) {
  // Límite: último día del mes de la fecha de pago
  const f = new Date(fechaPago + 'T00:00:00');
  const finMes = new Date(f.getFullYear(), f.getMonth() + 1, 0);
  const limite = `${finMes.getFullYear()}-${String(finMes.getMonth() + 1).padStart(2, '0')}-${String(finMes.getDate()).padStart(2, '0')}`;

  const filas = await leerHoja('Cuotas_TC!A2:L');
  for (let i = 0; i < filas.length; i++) {
    const esDeEstaTC = filas[i][3] === tcId;        // col D = Producto_TC
    const estaPendiente = filas[i][9] === 'Pendiente'; // col J = Estado
    const venc = filas[i][8] || '';                  // col I = Fecha_Vencimiento
    if (esDeEstaTC && estaPendiente && venc && venc <= limite) {
      await actualizarCelda(`Cuotas_TC!J${i + 2}`, 'Pagada');
      await actualizarCelda(`Cuotas_TC!L${i + 2}`, idTxPago);
    }
  }
}

// Deshace un abono: devuelve a 'Pendiente' las cuotas que fueron pagadas por ese traslado.
// Identifica las cuotas por el ID del abono guardado en la columna L (ID_Tx_Pago).
async function deshacerAbono(idTxAbono) {
  const filas = await leerHoja('Cuotas_TC!A2:L');
  for (let i = 0; i < filas.length; i++) {
    // Columna L (índice 11) = ID_Tx_Pago; Columna J (índice 9) = Estado
    if (filas[i][11] === idTxAbono && filas[i][9] === 'Pagada') {
      await actualizarCelda(`Cuotas_TC!J${i + 2}`, 'Pendiente');
      await actualizarCelda(`Cuotas_TC!L${i + 2}`, '');
    }
  }
}

// Anula (no borra) las cuotas asociadas a una transacción, marcándolas como 'Anulada'.
// Conserva la fila para trazabilidad. Las cuotas anuladas no cuentan en "Vence este mes".
async function anularCuotasDeTx(idTx) {
  const filas = await leerHoja('Cuotas_TC!A2:L');
  for (let i = 0; i < filas.length; i++) {
    // Columna C (índice 2) = ID_Tx; Columna J (índice 9) = Estado
    if (filas[i][2] === idTx && filas[i][9] !== 'Anulada') {
      await actualizarCelda(`Cuotas_TC!J${i + 2}`, 'Anulada');
    }
  }
}

// Genera y escribe las filas de Cuotas_TC para una compra diferida (o de 1 cuota).
// idTx: ID de la transacción origen. datos: lo leído del formulario + info de cuotas.
async function generarCuotasTC(idTx, datos) {
  const prod = estado.productos.find(p => p.id === datos.producto);
  if (!prod) return;

  const totalCuotas = datos.numCuotas || 1;
  const capitalPorCuota = Math.round(datos.monto / totalCuotas);
  const idCompra = 'CMP' + Date.now();

  // Fecha de la primera cuota: la que el usuario confirmó, o la calculada
  let primera = datos.primeraCuota || calcularPrimerVencimiento(prod, datos.fecha);
  if (!primera) {
    mostrarToast('⚠️ No se pudo determinar la fecha de la primera cuota');
    return;
  }

  const conInteres = datos.conInteres ? 'SI' : 'NO';
  const base = new Date(primera + 'T00:00:00');
  const diaCuota = base.getDate();

  for (let i = 0; i < totalCuotas; i++) {
    // Cada cuota suma un mes a la anterior, cuidando meses cortos
    let mes = base.getMonth() + i;
    let anio = base.getFullYear() + Math.floor(mes / 12);
    mes = mes % 12;
    const ultimoDia = new Date(anio, mes + 1, 0).getDate();
    const dia = Math.min(diaCuota, ultimoDia);
    const fechaVenc = `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

    const idCuota = `${idCompra}-${String(i + 1).padStart(2, '0')}`;
    await escribirFila('Cuotas_TC', [
      idCuota, idCompra, idTx, datos.producto, datos.descripcion,
      i + 1, totalCuotas, capitalPorCuota, fechaVenc, 'Pendiente', conInteres
    ]);
  }
}

// Calcula la fecha de vencimiento de la primera cuota de una compra con TC.
// Usa día de corte y día de pago del producto. Si no los tiene (ej. Crediágil), devuelve ''.
function calcularPrimerVencimiento(producto, fechaCompra) {
  const diaPago = parseInt(producto.fechaPago);
  const diaCorte = parseInt(producto.fechaCorte);
  if (!diaPago || !diaCorte) return ''; // sin datos → el usuario la pone

  const fc = new Date(fechaCompra + 'T00:00:00');
  const diaCompra = fc.getDate();

  // Si compró después del corte, el vencimiento salta al mes siguiente
  let mesVenc = fc.getMonth();
  let anioVenc = fc.getFullYear();
  if (diaCompra > diaCorte) mesVenc += 1;
  // El pago siempre cae después del corte; si el día de pago es menor que el de
  // corte, significa que el pago es el mes siguiente al corte
  if (diaPago < diaCorte) mesVenc += 1;

  if (mesVenc > 11) { mesVenc -= 12; anioVenc += 1; }

  // Ajuste de día para meses cortos (ej. día 30 en febrero)
  const ultimoDia = new Date(anioVenc, mesVenc + 1, 0).getDate();
  const diaFinal = Math.min(diaPago, ultimoDia);

  const mm = String(mesVenc + 1).padStart(2, '0');
  const dd = String(diaFinal).padStart(2, '0');
  return `${anioVenc}-${mm}-${dd}`;
}

// Devuelve las compras de una TC con cuotas pendientes (diferidas Y de 1 cuota).
// Agrupa por compra para que el usuario indique manualmente sobre cuál aplica el abono.
function comprasConCuotasPendientes(productoTC) {
  if (!estado.cuotasTC) return [];
  const pendientes = estado.cuotasTC.filter(c =>
    c.productoTC === productoTC && c.estado === 'Pendiente'
  );
  const grupos = {};
  pendientes.forEach(c => {
    if (!grupos[c.idCompra]) {
      grupos[c.idCompra] = {
        idCompra: c.idCompra, descripcion: c.descripcion,
        totalCuotas: c.totalCuotas, cuotasPendientes: 0,
        saldoPendiente: 0, capitalCuota: c.capitalCuota,
        conInteres: c.conInteres
      };
    }
    grupos[c.idCompra].cuotasPendientes++;
    grupos[c.idCompra].saldoPendiente += c.capitalCuota;
  });
  return Object.values(grupos);
}

// Devuelve un objeto { 'YYYY-MM': capitalQueVence, ... } con el capital de cuotas TC
// pendientes que vence en cada uno de los próximos 'numMeses' a partir de hoy.
// Es la "ola": cuánto desembolso de TC cae cada mes.
function calcularOlaTC(numMeses = 12) {
  const ola = {};
  const hoy = new Date();
  // Inicializar los meses en cero
  for (let i = 0; i < numMeses; i++) {
    const f = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const clave = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}`;
    ola[clave] = 0;
  }
  // Sumar el capital de cada cuota pendiente al mes que le corresponde
  if (estado.cuotasTC) {
    estado.cuotasTC.forEach(c => {
      if (c.estado === 'Pendiente' && c.fechaVencimiento) {
        const clave = c.fechaVencimiento.substring(0, 7); // YYYY-MM
        if (clave in ola) ola[clave] += c.capitalCuota;
      }
    });
  }
  return ola;
}

// Suma el capital de cuotas TC pendientes que vencen dentro del mes indicado (YYYY-MM)
function calcularComprometidoMes(mesYYYYMM) {
  if (!estado.cuotasTC) return 0;
  return estado.cuotasTC
    .filter(c => c.estado === 'Pendiente'
              && c.fechaVencimiento
              && c.fechaVencimiento.substring(0, 7) === mesYYYYMM)
    .reduce((s, c) => s + c.capitalCuota, 0);
}

// El saldo actual = saldo de cierre + movimientos posteriores al último cierre
function calcularSaldoProducto(productoId) {
  const prod = estado.productos.find(p => p.id === productoId);
  if (!prod) return 0;

  let saldo = prod.saldoCierre;
  const corte = estado.ultimoCierre; // fecha del último cierre (YYYY-MM-DD)

  estado.transacciones.forEach(t => {
    if (!t.fecha || t.fecha <= corte) return; // solo movimientos posteriores al cierre

    const monto = t.monto || 0;
    if (t.tipo === 'Ingreso' && t.origen === productoId) saldo += monto;
    else if (t.tipo === 'Egreso' && t.origen === productoId) saldo -= monto;
    else if (t.tipo === 'Traslado') {
      if (t.origen === productoId) saldo -= monto;
      if (t.destino === productoId) saldo += monto;
    }
  });

  return saldo;
}

// Recalcula todos los saldos en memoria y los escribe al Sheet (columna G)
async function recalcularSaldos(escribirSheet = true) {
  const filas = await leerHoja('Productos!A2:O');
  for (let i = 0; i < estado.productos.length; i++) {
    const prod = estado.productos[i];
    const nuevoSaldo = calcularSaldoProducto(prod.id);
    prod.saldoActual = nuevoSaldo;
    if (escribirSheet) {
      await actualizarCelda(`Productos!G${i + 2}`, nuevoSaldo);
    }
  }
}

// ── EDICIÓN Y ELIMINACIÓN DE TRANSACCIONES ────────────────────────────
function abrirEdicionTx(txId) {
  const t = estado.transacciones.find(x => x.id === txId);
  if (!t) { mostrarToast('Transacción no encontrada'); return; }

  document.getElementById('edit-tx-id').value = t.id;
  document.getElementById('edit-tx-fecha').value = t.fecha;
  document.getElementById('edit-tx-tipo').value = t.tipo;
  document.getElementById('edit-tx-monto').value = t.monto;
  document.getElementById('edit-tx-descripcion').value = t.descripcion || '';

  // Poblar selectores de producto
  const opcionesProd = estado.productos.map(p =>
    `<option value="${p.id}">${p.nombre}</option>`).join('');
  document.getElementById('edit-tx-origen').innerHTML = opcionesProd;
  document.getElementById('edit-tx-destino').innerHTML = opcionesProd;
  document.getElementById('edit-tx-origen').value = t.origen;
  document.getElementById('edit-tx-destino').value = t.destino || '';

  // Poblar grupos según tipo
  poblarGruposEdicion(t.tipo, t.grupo, t.subgrupo);

  // Mostrar/ocultar destino según tipo
  toggleDestinoEdicion(t.tipo);

  // Listeners
  document.getElementById('edit-tx-tipo').onchange = (e) => {
    poblarGruposEdicion(e.target.value);
    toggleDestinoEdicion(e.target.value);
  };
  document.getElementById('edit-tx-grupo').onchange = (e) => {
    poblarSubgruposEdicion(document.getElementById('edit-tx-tipo').value, e.target.value);
  };
  document.getElementById('btn-edit-tx-guardar').onclick = guardarEdicionTx;
  document.getElementById('btn-edit-tx-cancelar').onclick = cerrarEdicionTx;

  // Avisos de cuotas TC en el modal
  actualizarAvisosEdicionTC(txId);
  document.getElementById('edit-tx-origen').onchange = () => actualizarAvisosEdicionTC(txId);
  document.getElementById('edit-tx-tipo').addEventListener('change', () => actualizarAvisosEdicionTC(txId));

  document.getElementById('modal-editar-tx').classList.remove('oculto');
}

// Muestra avisos y bloquea campos según el estado de las cuotas y el producto elegido.
function actualizarAvisosEdicionTC(txId) {
  const avisoTC = document.getElementById('edit-tx-aviso-tc');
  const bloqueoTC = document.getElementById('edit-tx-bloqueo-tc');
  const prodId = document.getElementById('edit-tx-origen').value;
  const prod = estado.productos.find(p => p.id === prodId);
  const esTC = prod && prod.tipo === 'Tarjeta Crédito';
  const intocable = tieneCuotasIntocables(txId);

  // Bloqueo: si tiene cuotas pagadas/cerradas, solo se puede editar descripción
  bloqueoTC.classList.toggle('oculto', !intocable);
  document.getElementById('edit-tx-monto').disabled = intocable;
  document.getElementById('edit-tx-fecha').disabled = intocable;
  document.getElementById('edit-tx-origen').disabled = intocable;
  document.getElementById('edit-tx-tipo').disabled = intocable;
  document.getElementById('edit-tx-grupo').disabled = intocable;
  document.getElementById('edit-tx-subgrupo').disabled = intocable;

  // Aviso de "1 cuota": solo si es TC y no está bloqueada
  avisoTC.classList.toggle('oculto', !esTC || intocable);
}

function poblarGruposEdicion(tipo, grupoSel = '', subSel = '') {
  const grupos = [...new Set(estado.grupos.filter(g => g.tipo === tipo).map(g => g.grupo))];
  document.getElementById('edit-tx-grupo').innerHTML = grupos.map(g =>
    `<option value="${g}">${g}</option>`).join('');
  if (grupoSel) document.getElementById('edit-tx-grupo').value = grupoSel;
  const grupoActual = grupoSel || grupos[0];
  poblarSubgruposEdicion(tipo, grupoActual, subSel);
}

function poblarSubgruposEdicion(tipo, grupo, subSel = '') {
  const subs = estado.grupos.filter(g => g.tipo === tipo && g.grupo === grupo).map(g => g.subgrupo);
  document.getElementById('edit-tx-subgrupo').innerHTML = subs.map(s =>
    `<option value="${s}">${s}</option>`).join('');
  if (subSel) document.getElementById('edit-tx-subgrupo').value = subSel;
}

function toggleDestinoEdicion(tipo) {
  document.getElementById('edit-tx-destino-cont').style.display =
    tipo === 'Traslado' ? 'block' : 'none';
}

function cerrarEdicionTx() {
  document.getElementById('modal-editar-tx').classList.add('oculto');
}

async function guardarEdicionTx() {
  const txId = document.getElementById('edit-tx-id').value;
  const fecha = document.getElementById('edit-tx-fecha').value;
  const tipo = document.getElementById('edit-tx-tipo').value;
  const grupo = document.getElementById('edit-tx-grupo').value;
  const subgrupo = document.getElementById('edit-tx-subgrupo').value;
  const origen = document.getElementById('edit-tx-origen').value;
  const destino = tipo === 'Traslado' ? document.getElementById('edit-tx-destino').value : '';
  const monto = parseFloat(document.getElementById('edit-tx-monto').value) || 0;
  const descripcion = document.getElementById('edit-tx-descripcion').value;

  // Validar que la fecha siga siendo del período abierto
  if (fecha <= estado.ultimoCierre) {
    mostrarToast('No puedes mover la transacción a un mes ya cerrado');
    return;
  }
  if (monto <= 0) { mostrarToast('El monto debe ser mayor a cero'); return; }

  const btnGuardar = document.getElementById('btn-edit-tx-guardar');
  btnGuardar.disabled = true;
  const textoOriginal = btnGuardar.textContent;
  btnGuardar.textContent = 'Guardando...';
  mostrarSpinner(true);
  try {
    // Localizar la fila en el Sheet
    const filas = await leerHoja('Transacciones!A2:L');
    let filaReal = -1;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i][0] === txId) { filaReal = i + 2; break; }
    }
    if (filaReal === -1) { mostrarToast('No se encontró en el Sheet'); mostrarSpinner(false); return; }

    // Actualizar la fila completa (columnas B a I; A es el ID que no cambia)
    await actualizarRango(`Transacciones!B${filaReal}:I${filaReal}`,
      [[fecha, tipo, grupo, subgrupo, origen, destino, monto, descripcion]]);

    // Regenerar cuotas TC: anular las viejas y crear según el producto nuevo
    await anularCuotasDeTx(txId);
    const prodNuevo = estado.productos.find(p => p.id === origen);
    if (tipo !== 'Traslado' && prodNuevo && prodNuevo.tipo === 'Tarjeta Crédito') {
      await generarCuotasTC(txId, {
        fecha, producto: origen, monto, descripcion,
        numCuotas: 1, primeraCuota: '', conInteres: false
      });
    }

    await cargarDatos();
    await recalcularSaldos(true);
    mostrarSpinner(false);
    cerrarEdicionTx();
    renderHistorial();
    renderDashboard();
    mostrarToast('✓ Transacción actualizada');
  } catch(e) {
    mostrarSpinner(false);
    mostrarToast('Error al editar: ' + e.message);
    console.error(e);
  } finally {
    btnGuardar.disabled = false;
    btnGuardar.textContent = textoOriginal;
  }
}

async function eliminarTx(txId) {
  const t = estado.transacciones.find(x => x.id === txId);
  if (!t) return;
  if (t.fecha <= estado.ultimoCierre) { mostrarToast('No puedes eliminar una transacción de un mes cerrado'); return; }
  if (tieneCuotasIntocables(txId)) { mostrarToast('No puedes eliminar: esta compra ya tiene cuotas pagadas o de un mes cerrado'); return; }
  if (!confirm(`¿Eliminar esta transacción?\n${t.fecha} · ${t.grupo} > ${t.subgrupo} · ${fmt(t.monto)}`)) return;

  mostrarSpinner(true);
  try {
    const filas = await leerHoja('Transacciones!A2:L');
    let filaReal = -1;
    for (let i = 0; i < filas.length; i++) {
      if (filas[i][0] === txId) { filaReal = i + 2; break; }
    }
    if (filaReal === -1) { mostrarToast('No se encontró en el Sheet'); mostrarSpinner(false); return; }

    await borrarFila('Transacciones', filaReal);
    await anularCuotasDeTx(txId);
    await deshacerAbono(txId);
    await cargarDatos();
    await recalcularSaldos(true);
    mostrarSpinner(false);
    renderHistorial();
    renderDashboard();
    mostrarToast('✓ Transacción eliminada');
  } catch(e) {
    mostrarSpinner(false);
    mostrarToast('Error al eliminar: ' + e.message);
    console.error(e);
  }
}

// ── FUNCIONES AUXILIARES DE SHEETS ────────────────────────────────────
async function actualizarRango(rango, valores) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(rango)}?valueInputOption=USER_ENTERED`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${estado.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: valores })
  });
  if (!resp.ok) throw new Error('Error actualizando rango: ' + resp.status);
  return resp.json();
}

async function borrarFila(nombreHoja, numeroFila) {
  // 1. Obtener el sheetId numérico de la hoja por su nombre
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}`;
  const metaResp = await fetch(metaUrl, { headers: { Authorization: `Bearer ${estado.accessToken}` } });
  const meta = await metaResp.json();
  const hoja = meta.sheets.find(s => s.properties.title === nombreHoja);
  if (!hoja) throw new Error('Hoja no encontrada: ' + nombreHoja);
  const sheetId = hoja.properties.sheetId;

  // 2. Borrar la fila (numeroFila es 1-indexed; la API usa 0-indexed)
  const batchUrl = `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}:batchUpdate`;
  const resp = await fetch(batchUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${estado.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheetId,
            dimension: 'ROWS',
            startIndex: numeroFila - 1,
            endIndex: numeroFila
          }
        }
      }]
    })
  });
  if (!resp.ok) throw new Error('Error borrando fila: ' + resp.status);
  return resp.json();
}

// ── EXTRACTO POR PRODUCTO ─────────────────────────────────────────────
function inicializarExtracto(productoIdInicial = null) {
  const sel = document.getElementById('extracto-producto');
  sel.innerHTML = estado.productos.map(p =>
    `<option value="${p.id}">${p.nombre} (${p.entidad})</option>`).join('');

  if (productoIdInicial) sel.value = productoIdInicial;

  // Rango por defecto: del último cierre + 1 día hasta hoy (mes corriente)
  const hoy = new Date();
  const desde = new Date(estado.ultimoCierre);
  desde.setDate(desde.getDate() + 1);
  document.getElementById('extracto-desde').value = desde.toISOString().split('T')[0];
  document.getElementById('extracto-hasta').value = hoy.toISOString().split('T')[0];

  const btn = document.getElementById('btn-extracto-filtrar');
  btn.replaceWith(btn.cloneNode(true));
  document.getElementById('btn-extracto-filtrar').addEventListener('click', renderExtracto);

  renderExtracto();
}

function renderExtracto() {
  const id = document.getElementById('extracto-producto').value;
  const desde = document.getElementById('extracto-desde').value;
  const hasta = document.getElementById('extracto-hasta').value;
  const prod = estado.productos.find(p => p.id === id);
  if (!prod) return;

  // Saldo de apertura: saldoCierre + movimientos desde el cierre hasta "desde" (exclusivo)
  let saldoApertura = prod.saldoCierre;
  estado.transacciones.forEach(t => {
    if (!t.fecha || t.fecha <= estado.ultimoCierre) return;
    if (t.fecha >= desde) return; // solo lo anterior al rango
    saldoApertura += movimientoEnProducto(t, id);
  });

  // Movimientos dentro del rango
  const movs = estado.transacciones
    .filter(t => t.fecha && t.fecha >= desde && t.fecha <= hasta)
    .filter(t => t.origen === id || t.destino === id)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));

  // Saldo corriente acumulado
  let saldoCorriente = saldoApertura;
  const filas = movs.map(t => {
    const delta = movimientoEnProducto(t, id);
    saldoCorriente += delta;
    const signo = delta >= 0 ? '+' : '';
    const cls = delta >= 0 ? 'tx-ingreso' : 'tx-egreso';
    return `<tr>
      <td>${t.fecha}</td>
      <td>${t.tipo}</td>
      <td>${t.grupo} > ${t.subgrupo}</td>
      <td>${t.descripcion || ''}</td>
      <td class="${cls}">${signo}${fmt(delta)}</td>
      <td>${fmt(saldoCorriente)}</td>
    </tr>`;
  }).join('');

  const saldoFinal = saldoCorriente;
  const esDeuda = prod.tipo === 'Crédito' || prod.tipo === 'Crédito Hipotecario';

  document.getElementById('extracto-resumen').innerHTML = `
    <div class="extracto-saldo-box">
      <div class="label">Saldo apertura</div>
      <div class="valor">${fmt(saldoApertura)}</div>
    </div>
    <div class="extracto-saldo-box">
      <div class="label">Movimientos (${movs.length})</div>
      <div class="valor">${fmt(saldoFinal - saldoApertura)}</div>
    </div>
    <div class="extracto-saldo-box">
      <div class="label">Saldo final</div>
      <div class="valor">${fmt(saldoFinal)}</div>
    </div>`;

  document.getElementById('extracto-tabla').innerHTML = movs.length ? `<table>
    <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th>Descripción</th><th>Movimiento</th><th>Saldo</th></tr></thead>
    <tbody>${filas}</tbody>
  </table>` : '<p style="color:var(--texto2);margin-top:16px">Sin movimientos en este rango.</p>';
}

// Calcula cómo afecta una transacción al saldo de un producto (+/-)
function movimientoEnProducto(t, id) {
  const monto = t.monto || 0;
  if (t.tipo === 'Ingreso' && t.origen === id) return monto;
  if (t.tipo === 'Egreso' && t.origen === id) return -monto;
  if (t.tipo === 'Traslado') {
    if (t.destino === id) return monto;
    if (t.origen === id) return -monto;
  }
  return 0;
}

function abrirExtractoProducto(productoId) {
  cambiarVista('extracto');
  inicializarExtracto(productoId);
}

// ── PRESUPUESTO RODANTE 12 MESES ──────────────────────────────────────
let pptoVistaData = null; // guarda la matriz para descarga

function inicializarPptoVista() {
  const b1 = document.getElementById('btn-generar-ppto');
  const b2 = document.getElementById('btn-descargar-ppto');
  b1.replaceWith(b1.cloneNode(true));
  b2.replaceWith(b2.cloneNode(true));
  document.getElementById('btn-generar-ppto').addEventListener('click', generarPptoVista);
  document.getElementById('btn-descargar-ppto').addEventListener('click', descargarPptoVista);

  // Si ya hay datos generados, mostrarlos
  if (pptoVistaData) renderPptoVista();
  else document.getElementById('ppto-vista-tabla').innerHTML =
    '<p style="color:var(--texto2)">Pulsa "Generar" para construir la vista.</p>';
}

function construirMeses12(desde) {
  // desde: 'YYYY-MM' del mes corriente. Devuelve array de 12 'YYYY-MM'
  const [a, m] = desde.split('-').map(Number);
  const meses = [];
  for (let i = 0; i < 12; i++) {
    const fecha = new Date(a, m - 1 + i, 1);
    meses.push(`${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}

function generarPptoVista() {
  // Mes corriente = mes siguiente al último cierre
  const corte = new Date(estado.ultimoCierre);
  const mesCorriente = new Date(corte.getFullYear(), corte.getMonth() + 1, 1);
  const mesInicial = `${mesCorriente.getFullYear()}-${String(mesCorriente.getMonth() + 1).padStart(2, '0')}`;
  const meses = construirMeses12(mesInicial);

  // Saldo inicial disponible = solo cuentas de ahorro + inversión líquida (Fiducuenta, Cajita)
  // Las TC se tratan aparte (su saldo mezcla pago total con diferidos); créditos/hipoteca/inversión LP no son disponible
  const tiposDisponibles = ['Cuenta Ahorros', 'Cuenta Inversión'];
  const disponibles = estado.productos.filter(p => tiposDisponibles.includes(p.tipo));
  let saldoInicial = disponibles.reduce((s, p) => s + (p.saldoCierre || 0), 0);
  
  // Agrupar presupuesto por subgrupo y mes
  // Estructura: ingresos[subgrupo][mes] = monto ; egresos[subgrupo][mes] = monto
  const ingresos = {}, egresos = {};
  estado.presupuesto.forEach(p => {
    const mes = (p.fecha || '').substring(0, 7);
    if (!meses.includes(mes)) return;
    const destino = p.tipo === 'Ingreso' ? ingresos : egresos;
    const clave = `${p.grupo} > ${p.subgrupo}`;
    if (!destino[clave]) destino[clave] = {};
    destino[clave][mes] = (destino[clave][mes] || 0) + p.monto;
  });

  // Calcular totales y saldos encadenados
  const totalIngMes = {}, totalEgrMes = {}, balanceMes = {}, saldoIniMes = {}, saldoFinMes = {};
  let saldoArrastre = saldoInicial;
  meses.forEach(mes => {
    let ti = 0, te = 0;
    Object.values(ingresos).forEach(sub => ti += (sub[mes] || 0));
    Object.values(egresos).forEach(sub => te += (sub[mes] || 0));
    totalIngMes[mes] = ti;
    totalEgrMes[mes] = te;
    balanceMes[mes] = ti - te;
    saldoIniMes[mes] = saldoArrastre;
    saldoFinMes[mes] = saldoArrastre + (ti - te);
    saldoArrastre = saldoFinMes[mes];
  });

  pptoVistaData = { meses, ingresos, egresos, totalIngMes, totalEgrMes, balanceMes, saldoIniMes, saldoFinMes };
  renderPptoVista();
  mostrarToast('✓ Vista generada');
}

function renderPptoVista() {
  if (!pptoVistaData) return;
  const { meses, ingresos, egresos, totalIngMes, totalEgrMes, balanceMes, saldoIniMes, saldoFinMes } = pptoVistaData;

  const etiquetaMes = m => {
    const [a, mm] = m.split('-');
    return new Date(a, mm - 1, 1).toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });
  };

  let html = '<table class="tabla-ppto"><thead><tr><th>Concepto</th>';
  meses.forEach(m => html += `<th>${etiquetaMes(m)}</th>`);
  html += '</tr></thead><tbody>';

  // Saldo inicial
  html += '<tr class="fila-saldo"><td><strong>Saldo inicial</strong></td>';
  meses.forEach(m => html += `<td>${fmt(saldoIniMes[m])}</td>`);
  html += '</tr>';

  // INGRESOS
  html += `<tr class="fila-grupo"><td colspan="${meses.length + 1}">INGRESOS</td></tr>`;
  Object.keys(ingresos).sort().forEach(sub => {
    html += `<tr><td>${sub}</td>`;
    meses.forEach(m => html += `<td>${ingresos[sub][m] ? fmt(ingresos[sub][m]) : '—'}</td>`);
    html += '</tr>';
  });
  html += '<tr class="fila-total"><td><strong>Total ingresos</strong></td>';
  meses.forEach(m => html += `<td><strong>${fmt(totalIngMes[m])}</strong></td>`);
  html += '</tr>';

  // EGRESOS
  html += `<tr class="fila-grupo"><td colspan="${meses.length + 1}">EGRESOS</td></tr>`;
  Object.keys(egresos).sort().forEach(sub => {
    html += `<tr><td>${sub}</td>`;
    meses.forEach(m => html += `<td>${egresos[sub][m] ? fmt(egresos[sub][m]) : '—'}</td>`);
    html += '</tr>';
  });
  html += '<tr class="fila-total"><td><strong>Total egresos</strong></td>';
  meses.forEach(m => html += `<td><strong>${fmt(totalEgrMes[m])}</strong></td>`);
  html += '</tr>';

  // Balance y saldo final
  html += '<tr class="fila-balance"><td><strong>Balance del mes</strong></td>';
  meses.forEach(m => {
    const cls = balanceMes[m] >= 0 ? 'tx-ingreso' : 'tx-egreso';
    html += `<td class="${cls}"><strong>${fmt(balanceMes[m])}</strong></td>`;
  });
  html += '</tr>';

  html += '<tr class="fila-saldo"><td><strong>Saldo final</strong></td>';
  meses.forEach(m => {
    const cls = saldoFinMes[m] >= 0 ? '' : 'tx-egreso';
    html += `<td class="${cls}"><strong>${fmt(saldoFinMes[m])}</strong></td>`;
  });
  html += '</tr>';

  html += '</tbody></table>';
  document.getElementById('ppto-vista-tabla').innerHTML = html;
}

function descargarPptoVista() {
  if (!pptoVistaData) { mostrarToast('Primero genera la vista'); return; }
  const { meses, ingresos, egresos, totalIngMes, totalEgrMes, balanceMes, saldoIniMes, saldoFinMes } = pptoVistaData;

  const etiquetaMes = m => {
    const [a, mm] = m.split('-');
    return new Date(a, mm - 1, 1).toLocaleDateString('es-CO', { month: 'short', year: '2-digit' });
  };

  // Construir matriz de arrays para SheetJS
  const filas = [];
  filas.push(['Concepto', ...meses.map(etiquetaMes)]);
  filas.push(['Saldo inicial', ...meses.map(m => saldoIniMes[m])]);
  filas.push(['INGRESOS']);
  Object.keys(ingresos).sort().forEach(sub => {
    filas.push([sub, ...meses.map(m => ingresos[sub][m] || 0)]);
  });
  filas.push(['Total ingresos', ...meses.map(m => totalIngMes[m])]);
  filas.push(['EGRESOS']);
  Object.keys(egresos).sort().forEach(sub => {
    filas.push([sub, ...meses.map(m => egresos[sub][m] || 0)]);
  });
  filas.push(['Total egresos', ...meses.map(m => totalEgrMes[m])]);
  filas.push(['Balance del mes', ...meses.map(m => balanceMes[m])]);
  filas.push(['Saldo final', ...meses.map(m => saldoFinMes[m])]);

  const ws = XLSX.utils.aoa_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Presupuesto 12M');
  const hoy = new Date().toISOString().split('T')[0];
  XLSX.writeFile(wb, `ICG_Presupuesto_12M_${hoy}.xlsx`);
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
