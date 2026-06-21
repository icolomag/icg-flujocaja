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
        <div id="campos-normales-gmail-${c.gmailId}">
          <select class="correo-select" id="correo-prod-${c.gmailId}" onchange="avisoCuotaTC('${c.gmailId}')">${optsProductos}</select>
          <select class="correo-select" id="correo-grupo-${c.gmailId}" onchange="actualizarSubgruposCorreo('${c.gmailId}')">${optsGrupos}</select>
          <select class="correo-select" id="correo-sub-${c.gmailId}" onchange="revisarInteresCorreo('${c.gmailId}')"></select>
          <input class="correo-input" id="correo-desc-${c.gmailId}" type="text" placeholder="Descripción" value="${c.asunto.substring(0,50)}" />
          <div class="aviso-cuota-tc oculto" id="correo-aviso-${c.gmailId}" style="font-size:0.85em;color:#0a7;margin-top:4px;">ℹ️ Se registrará a 1 cuota. Para diferir, usa +Transacción.</div>
          <div class="campo-interes-deuda oculto" id="correo-int-bloque-${c.gmailId}" style="margin-top:6px;">
            <label style="font-size:0.85em;color:var(--texto2)">Interés incluido en el pago (si aplica):</label>
            <input class="correo-input" id="correo-int-${c.gmailId}" type="number" min="0" value="0" placeholder="0" />
          </div>
        </div>
        ${c.tipo === 'Egreso' ? `<button type="button" class="btn-secundario" style="margin-top:6px; padding:4px 10px; font-size:0.85em" id="btn-split-abrir-gmail-${c.gmailId}" onclick="abrirSplitTarjeta('gmail','${c.gmailId}',${c.monto})">➗ Distribuir en varios subgrupos</button>` : ''}
        <div id="split-tarjeta-gmail-${c.gmailId}"></div>
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
  revisarInteresCorreo(gmailId);
}

// Muestra el campo de interés solo si el subgrupo elegido apunta a una deuda
// (tiene Cuenta_Destino). Así Nacho separa capital/interés en pagos de TC.
function revisarInteresCorreo(gmailId) {
  const subgrupo = document.getElementById(`correo-sub-${gmailId}`)?.value;
  const grupo = document.getElementById(`correo-grupo-${gmailId}`)?.value;
  const bloque = document.getElementById(`correo-int-bloque-${gmailId}`);
  if (!bloque) return;
  const g = estado.grupos.find(x => x.grupo === grupo && x.subgrupo === subgrupo);
  const esPagoDeuda = g && g.cuentaDestino;
  bloque.classList.toggle('oculto', !esPagoDeuda);
  if (!esPagoDeuda) {
    const inp = document.getElementById(`correo-int-${gmailId}`);
    if (inp) inp.value = 0;
  }
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

  // Blindaje contra doble clic: el botón "Registrar" vive dentro del bloque del correo
  const btn = document.querySelector(`#correo-${gmailId} .btn-confirmar`);
  const textoOrig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  mostrarSpinner(true);
  try {
    const datosTx = {
      fecha: c.fecha, tipo: c.tipo, grupo, subgrupo,
      producto, monto: c.monto, descripcion, fuente: 'Gmail', notas: c.gmailId,
      numCuotas: 1, primeraCuota: '', conInteres: false
    };
    // ¿Es pago de deuda? (el subgrupo apunta a una TC/deuda vía Cuenta_Destino)
    const gSel = estado.grupos.find(x => x.grupo === grupo && x.subgrupo === subgrupo);
    const esPagoDeuda = gSel && gSel.cuentaDestino;
    const interes = esPagoDeuda
      ? (Number(document.getElementById(`correo-int-${gmailId}`)?.value) || 0)
      : 0;

    let r;
    let gmfGmail = 0;
    if (esPagoDeuda) {
      // Pago de deuda: partir en capital (traslado) + interés (costo financiero)
      // El GMF lo genera registrarPagoDeudaPartido sobre el total (no acá, para no duplicar)
      r = await registrarPagoDeudaPartido(datosTx, interes);
      if (r.destino) {
        const prodDestino = estado.productos.find(p => p.id === r.destino);
        if (prodDestino && prodDestino.tipo === 'Tarjeta Crédito') {
          await marcarCuotasPagoExtracto(r.destino, r.idTxCapital, c.fecha);
        }
      }
    } else {
      // Movimiento normal (no es pago de deuda)
      r = construirFilaTx(datosTx);
      await escribirFila('Transacciones', r.fila);
      const prodSel = estado.productos.find(p => p.id === producto);
      if (!r.esTraslado && prodSel && prodSel.tipo === 'Tarjeta Crédito') {
        await generarCuotasTC(r.idTx, datosTx);
      }
      // GMF si la salida es desde cuenta de ahorros no exenta
      gmfGmail = await generarGMF(producto, c.monto, c.fecha, descripcion, 'Gmail');
    }
    await cargarDatos();
    mostrarSpinner(false);
    let msgGmail = r.esTraslado ? '✓ Pago de TC registrado desde Gmail' : '✓ Transacción registrada desde Gmail';
    if (gmfGmail > 0) msgGmail += ` + GMF ${fmt(gmfGmail)}`;
    mostrarToast(msgGmail);
    document.getElementById(`correo-${gmailId}`)?.remove();
    estado.correosPendientes = estado.correosPendientes.filter(x => x.gmailId !== gmailId);
  } catch(e) {
    mostrarSpinner(false);
    if (btn) { btn.disabled = false; btn.textContent = textoOrig; }
    mostrarToast('Error registrando desde Gmail: ' + e.message);
    console.error(e);
  }
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
      leerHoja('Productos!A2:R'),
      leerHoja('Grupos!A2:G'),
      leerHoja('Transacciones!A2:M'),
      leerHoja('Presupuesto!A2:F'),
      leerHoja('Contexto!A2:C'),
      leerHoja('Config!A2:B'),
      leerHoja('Calendario_Deuda!A2:N')
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
      saldoCierre: parseFloat(f[14]) || 0,
      metodoAmortizacion: f[15] || '',
      tipoTasa: f[16] || '',
      exentoGMF: (f[17] || '').toString().toUpperCase() === 'TRUE'
    }));

    estado.grupos = filasGrupos.map(f => ({ tipo: f[0], grupo: f[1], subgrupo: f[2], cuentaDestino: f[3] || '', esCostoFinanciero: (f[4] || '').toString().toUpperCase() === 'SI', esRendimientoLP: (f[5] || '').toString().toUpperCase() === 'SI', idSubgrupo: (f[6] || '').toString().trim() }));
    estado.transacciones = filasTx.map(f => ({
      id: f[0], fecha: f[1], tipo: f[2], grupo: f[3], subgrupo: f[4],
      origen: f[5], destino: f[6], monto: parseFloat(f[7]) || 0,
      descripcion: f[8], fuente: f[9], confirmado: f[10], notas: f[11],
      idSubgrupo: (f[12] || '').toString().trim()
    }));

    estado.presupuesto = filasPpto.map(f => ({
      fecha: f[0], tipo: f[1], grupo: f[2], subgrupo: f[3],
      monto: parseFloat(f[4]) || 0, comentario: f[5] || ''
    }));

    estado.contexto = filasContexto
      .filter(f => f[0] && (f[2] || '').toString().toUpperCase() !== 'FALSE')
      .map(f => ({ categoria: f[0], consideracion: f[1] || '' }));

    estado.cuotasTC = filasCuotas.map(f => ({
      idCuota: f[0], idCompra: f[1], idTx: f[2],
      tipoOrigen: f[3] || 'TC', productoTC: f[4],
      descripcion: f[5], numCuota: parseInt(f[6]) || 0,
      totalCuotas: parseInt(f[7]) || 0,
      capitalCuota: parseFloat(f[8]) || 0,
      interesCuota: parseFloat(f[9]) || 0,
      fechaVencimiento: f[10] || '', estado: f[11] || 'Pendiente',
      idTxPago: f[12] || '',
      fechaCompra: f[13] || ''
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
    // El botón de distribuir solo aplica a egresos
    const splitBloque = document.getElementById('tx-split-abrir-bloque');
    if (splitBloque) {
      if (tipo === 'Egreso') splitBloque.classList.remove('oculto');
      else splitBloque.classList.add('oculto');
    }
  });

  document.getElementById('tx-grupo').addEventListener('change', function() {
    const tipo = document.getElementById('tx-tipo').value;
    const grupo = this.value;
    const subs = estado.grupos.filter(g => g.tipo === tipo && g.grupo === grupo).map(g => g.subgrupo);
    const elSub = document.getElementById('tx-subgrupo');
    elSub.innerHTML = '<option value="">— Selecciona subgrupo —</option>' +
      subs.map(s => `<option value="${s}">${s}</option>`).join('');
    elSub.disabled = false;
    actualizarAvisoDeudaTx();
  });
}

// ── GMF (4x1000 / Gravamen a los Movimientos Financieros) ─────────────
// Tasa legal del GMF: $4 por cada $1.000 que sale de una cuenta = 0.004
const TASA_GMF = 0.004;

// ¿La cuenta de salida está exenta del GMF?
// Solo las cuentas de ahorro pueden estar marcadas exentas (col Exento_GMF=TRUE en Productos).
// Cualquier otra cosa (cuenta no marcada, tarjeta, etc.) → no exenta.
function productoExentoGMF(idProducto) {
  const p = estado.productos.find(x => x.id === idProducto);
  return !!(p && p.exentoGMF);
}

// ¿Desde este producto puede salir plata que genere GMF?
// El GMF grava salidas desde cuentas de ahorro. No aplica si la plata "sale"
// de una tarjeta de crédito o un crédito (eso es disponer de deuda, no debitar caja).
function productoGeneraGMF(idProducto) {
  const p = estado.productos.find(x => x.id === idProducto);
  if (!p) return false;
  const tipo = (p.tipo || '').toLowerCase();
  // Solo cuentas de ahorro / inversión líquida (de donde sale caja real)
  const esCuentaCaja = tipo.includes('ahorro') || tipo.includes('inversión') || tipo.includes('inversion');
  return esCuentaCaja && !p.exentoGMF;
}

// Calcula el valor del GMF de una salida. Devuelve 0 si la cuenta es exenta
// o si no es una cuenta de la que salga caja real (tarjeta/crédito).
// Redondea al peso.
function calcularGMF(idProducto, monto) {
  const m = Number(monto) || 0;
  if (m <= 0) return 0;
  if (!productoGeneraGMF(idProducto)) return 0;
  return Math.round(m * TASA_GMF);
}

// Genera y ESCRIBE un movimiento de GMF si corresponde. Se llama desde los
// flujos donde sale plata real de una cuenta (egreso, split, pago de deuda,
// traslado de salida, nómina). Escribe un Egreso al subgrupo "Gastos bancarios".
// Devuelve el valor del GMF registrado (0 si no aplicaba).
// NOTA: la app genera el GMF siempre que la salida sea de cuenta no exenta;
// si en un caso puntual no aplicaba (ej. traslado a cuenta propia sin cobro),
// Nacho lo elimina del Historial.
async function generarGMF(idProducto, monto, fecha, descripcion, fuente) {
  const valor = calcularGMF(idProducto, monto);
  if (valor <= 0) return 0;

  const gGB = estado.grupos.find(x => x.subgrupo === 'Gastos bancarios');
  if (!gGB) {
    mostrarToast('⚠️ No encontré el subgrupo "Gastos bancarios" en Grupos. El GMF NO se registró.');
    return 0;
  }

  const idTx = 'GMF' + Date.now();
  const fila = [
    idTx, fecha, 'Egreso', gGB.grupo, 'Gastos bancarios',
    idProducto, '', valor,
    'GMF 4x1000 — ' + (descripcion || ''), (fuente || 'GMF'), 'TRUE', '', gGB.idSubgrupo || ''
  ];
  await escribirFila('Transacciones', fila);
  return valor;
}

// ── SPLIT DE DÉBITO: distribuir un egreso en varios subgrupos ──────────
// Estado del panel de distribución (renglones en memoria)
let splitFilas = [];

// Devuelve los grupos de tipo Egreso que NO son de deuda (sin Cuenta_Destino)
function splitGruposEgreso() {
  const noDeuda = estado.grupos.filter(g =>
    g.tipo === 'Egreso' && !g.cuentaDestino
  );
  return [...new Set(noDeuda.map(g => g.grupo))];
}

// Devuelve los subgrupos (no deuda) de un grupo de egreso
function splitSubgruposDe(grupo) {
  return estado.grupos
    .filter(g => g.tipo === 'Egreso' && g.grupo === grupo && !g.cuentaDestino)
    .map(g => g.subgrupo);
}

// Abre el panel de distribución
function abrirSplit() {
  splitFilas = [
    { grupo: '', subgrupo: '', monto: 0 },
    { grupo: '', subgrupo: '', monto: 0 }
  ];
  // Pre-cargar el total con lo que haya en el campo de monto normal
  const montoNormal = parseFloat(document.getElementById('tx-monto').value) || 0;
  document.getElementById('tx-split-total').value = montoNormal > 0 ? montoNormal : '';
  document.getElementById('tx-split-panel').classList.remove('oculto');
  document.getElementById('tx-split-abrir-bloque').classList.add('oculto');
  renderSplitFilas();
  actualizarSplitContador();
}

// Cierra el panel sin guardar
function cerrarSplit() {
  document.getElementById('tx-split-panel').classList.add('oculto');
  // Reaparece el botón si seguimos en Egreso
  if (document.getElementById('tx-tipo').value === 'Egreso') {
    document.getElementById('tx-split-abrir-bloque').classList.remove('oculto');
  }
  splitFilas = [];
}

// Dibuja los renglones del split
function renderSplitFilas() {
  const cont = document.getElementById('tx-split-filas');
  const grupos = splitGruposEgreso();
  cont.innerHTML = splitFilas.map((f, i) => {
    const optsGrupo = '<option value="">— Grupo —</option>' +
      grupos.map(g => `<option value="${g}" ${g === f.grupo ? 'selected' : ''}>${g}</option>`).join('');
    const subs = f.grupo ? splitSubgruposDe(f.grupo) : [];
    const optsSub = '<option value="">— Subgrupo —</option>' +
      subs.map(s => `<option value="${s}" ${s === f.subgrupo ? 'selected' : ''}>${s}</option>`).join('');
    const puedeBorrar = splitFilas.length > 1;
    return `
      <div style="display:grid; grid-template-columns:1fr 1fr 110px 32px; gap:6px; align-items:center; margin-bottom:6px">
        <select onchange="splitCambiarGrupo(${i}, this.value)">${optsGrupo}</select>
        <select onchange="splitCambiarSub(${i}, this.value)">${optsSub}</select>
        <input type="number" min="0" placeholder="0" value="${f.monto || ''}" oninput="splitCambiarMonto(${i}, this.value)" />
        ${puedeBorrar ? `<button type="button" class="btn-secundario" style="padding:4px 8px" onclick="splitBorrarFila(${i})">✕</button>` : '<span></span>'}
      </div>`;
  }).join('');
}

function splitCambiarGrupo(i, val) {
  splitFilas[i].grupo = val;
  splitFilas[i].subgrupo = ''; // al cambiar grupo, resetear subgrupo
  renderSplitFilas();
}
function splitCambiarSub(i, val) {
  splitFilas[i].subgrupo = val;
}
function splitCambiarMonto(i, val) {
  splitFilas[i].monto = parseFloat(val) || 0;
  actualizarSplitContador();
}
function splitBorrarFila(i) {
  splitFilas.splice(i, 1);
  renderSplitFilas();
  actualizarSplitContador();
}
function splitAgregarFila() {
  splitFilas.push({ grupo: '', subgrupo: '', monto: 0 });
  renderSplitFilas();
}

// Actualiza el contador vivo y habilita/bloquea el botón de guardar
function actualizarSplitContador() {
  const total = parseFloat(document.getElementById('tx-split-total').value) || 0;
  const suma = splitFilas.reduce((acc, f) => acc + (f.monto || 0), 0);
  const dif = total - suma;
  const cont = document.getElementById('tx-split-contador');
  const btn = document.getElementById('btn-tx-split-guardar');
  let texto, color, ok;
  if (total <= 0) {
    texto = 'Ingresa el monto total del débito.';
    color = 'var(--texto2,#888)'; ok = false;
  } else if (dif > 0) {
    texto = `Distribuido: ${fmt(suma)} de ${fmt(total)} — faltan ${fmt(dif)}`;
    color = '#c0392b'; ok = false;
  } else if (dif < 0) {
    texto = `Distribuido: ${fmt(suma)} de ${fmt(total)} — sobran ${fmt(-dif)}`;
    color = '#c0392b'; ok = false;
  } else {
    texto = `✓ Distribuido: ${fmt(suma)} de ${fmt(total)} — cuadra`;
    color = '#27ae60'; ok = true;
  }
  cont.textContent = texto;
  cont.style.color = color;
  btn.disabled = !ok;
}

// Valida y guarda la distribución como N egresos independientes
async function guardarSplit() {
  const fecha = document.getElementById('tx-fecha').value;
  const producto = document.getElementById('tx-producto').value;
  const descripcion = document.getElementById('tx-descripcion').value;
  const notas = document.getElementById('tx-notas').value;
  const total = parseFloat(document.getElementById('tx-split-total').value) || 0;

  // Validaciones de los datos comunes
  if (!fecha) { mostrarToast('Selecciona una fecha'); return; }
  if (!producto) { mostrarToast('Selecciona el producto (cuenta)'); return; }
  if (esPeriodoCerrado(fecha)) {
    mostrarToast('🔒 No se puede registrar: la fecha pertenece a un mes ya cerrado');
    return;
  }
  // Cada renglón debe tener grupo, subgrupo y monto > 0
  for (let i = 0; i < splitFilas.length; i++) {
    const f = splitFilas[i];
    if (!f.grupo || !f.subgrupo) { mostrarToast(`Renglón ${i + 1}: falta grupo o subgrupo`); return; }
    if (!f.monto || f.monto <= 0) { mostrarToast(`Renglón ${i + 1}: monto inválido`); return; }
  }
  // La suma debe cuadrar exacta
  const suma = splitFilas.reduce((acc, f) => acc + (f.monto || 0), 0);
  if (suma !== total) { mostrarToast('La suma de los renglones no cuadra con el total'); return; }

  const btn = document.getElementById('btn-tx-split-guardar');
  btn.disabled = true;
  const textoOrig = btn.textContent;
  btn.textContent = 'Guardando...';
  mostrarSpinner(true);
  try {
    // Un egreso independiente por renglón, mismos fecha/producto/descripción
    for (const f of splitFilas) {
      const datos = {
        fecha, tipo: 'Egreso', grupo: f.grupo, subgrupo: f.subgrupo,
        producto, monto: f.monto, descripcion, notas, fuente: 'Manual-Split'
      };
      const r = construirFilaTx(datos);
      await escribirFila('Transacciones', r.fila);
    }
    // GMF una sola vez sobre el TOTAL que salió de la cuenta (no por renglón)
    const gmfSplit = await generarGMF(producto, total, fecha, descripcion, 'Manual-Split');
    await cargarDatos();
    mostrarToast(gmfSplit > 0
      ? `✓ Distribución registrada (${splitFilas.length} mov.) + GMF ${fmt(gmfSplit)}`
      : `✓ Distribución registrada (${splitFilas.length} movimientos)`);
    cerrarSplit();
    resetFormTx();
    cambiarVista('dashboard');
  } catch (e) {
    mostrarToast('✗ Error al guardar la distribución');
    console.error(e);
  } finally {
    mostrarSpinner(false);
    btn.disabled = false;
    btn.textContent = textoOrig;
  }
}

// ── SPLIT DE TARJETA: distribuir un movimiento de Gmail/Imagen ─────────
// Comparte el modelo del split de +Transacción, pero el monto total es FIJO
// (lo detectó el banco). Cada tarjeta maneja sus renglones por una clave única.
// splitTarjetas[clave] = { total, filas: [{grupo, subgrupo, monto}] }
let splitTarjetas = {};

// Abre el split dentro de una tarjeta de Gmail o Imagen.
// origen: 'gmail' | 'imagen'  ·  ref: gmailId (gmail) o índice i (imagen)  ·  total: monto fijo
function abrirSplitTarjeta(origen, ref, total) {
  const clave = `${origen}-${ref}`;
  splitTarjetas[clave] = {
    total: total,
    filas: [{ grupo: '', subgrupo: '', monto: 0 }, { grupo: '', subgrupo: '', monto: 0 }]
  };
  renderSplitTarjeta(origen, ref);
}

// Cierra el split de una tarjeta sin guardar (vuelve a la vista normal de la tarjeta)
function cerrarSplitTarjeta(origen, ref) {
  const clave = `${origen}-${ref}`;
  delete splitTarjetas[clave];
  const cont = document.getElementById(`split-tarjeta-${origen}-${ref}`);
  if (cont) cont.innerHTML = '';
  // Reaparecer el botón de distribuir
  const btnAbrir = document.getElementById(`btn-split-abrir-${origen}-${ref}`);
  if (btnAbrir) btnAbrir.classList.remove('oculto');
  // Reaparecer los campos normales de la tarjeta
  const campos = document.getElementById(`campos-normales-${origen}-${ref}`);
  if (campos) campos.classList.remove('oculto');
}

// Dibuja la grilla del split dentro de la tarjeta
function renderSplitTarjeta(origen, ref) {
  const clave = `${origen}-${ref}`;
  const est = splitTarjetas[clave];
  if (!est) return;
  const cont = document.getElementById(`split-tarjeta-${origen}-${ref}`);
  if (!cont) return;
  // Ocultar el botón de abrir y los campos normales mientras el split está activo
  const btnAbrir = document.getElementById(`btn-split-abrir-${origen}-${ref}`);
  if (btnAbrir) btnAbrir.classList.add('oculto');
  const campos = document.getElementById(`campos-normales-${origen}-${ref}`);
  if (campos) campos.classList.add('oculto');

  const grupos = splitGruposEgreso();
  const filasHtml = est.filas.map((f, idx) => {
    const optsGrupo = '<option value="">— Grupo —</option>' +
      grupos.map(g => `<option value="${g}" ${g === f.grupo ? 'selected' : ''}>${g}</option>`).join('');
    const subs = f.grupo ? splitSubgruposDe(f.grupo) : [];
    const optsSub = '<option value="">— Subgrupo —</option>' +
      subs.map(s => `<option value="${s}" ${s === f.subgrupo ? 'selected' : ''}>${s}</option>`).join('');
    const puedeBorrar = est.filas.length > 1;
    return `
      <div style="display:grid; grid-template-columns:1fr 1fr 100px 30px; gap:5px; align-items:center; margin-bottom:5px">
        <select class="correo-select" onchange="splitTarjetaCambiarGrupo('${origen}','${ref}',${idx},this.value)">${optsGrupo}</select>
        <select class="correo-select" onchange="splitTarjetaCambiarSub('${origen}','${ref}',${idx},this.value)">${optsSub}</select>
        <input class="correo-input" type="number" min="0" placeholder="0" value="${f.monto || ''}" oninput="splitTarjetaCambiarMonto('${origen}','${ref}',${idx},this.value)" />
        ${puedeBorrar ? `<button type="button" class="btn-secundario" style="padding:3px 7px" onclick="splitTarjetaBorrarFila('${origen}','${ref}',${idx})">✕</button>` : '<span></span>'}
      </div>`;
  }).join('');

  cont.innerHTML = `
    <div style="border:1px solid var(--borde,#ddd); border-radius:8px; padding:10px; margin-top:8px; background:rgba(0,0,0,0.02)">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px">
        <strong style="font-size:0.9em">Distribuir ${fmt(est.total)} en varios subgrupos</strong>
        <button type="button" class="btn-secundario" style="padding:3px 8px" onclick="cerrarSplitTarjeta('${origen}','${ref}')">✕ Cancelar</button>
      </div>
      ${filasHtml}
      <button type="button" class="btn-secundario" style="margin-top:4px; padding:4px 10px" onclick="splitTarjetaAgregarFila('${origen}','${ref}')">+ Agregar renglón</button>
      <div id="split-tarjeta-contador-${origen}-${ref}" style="margin-top:8px; font-weight:600; font-size:0.9em"></div>
      <button type="button" class="btn-confirmar" style="margin-top:8px" id="btn-split-tarjeta-guardar-${origen}-${ref}" onclick="guardarSplitTarjeta('${origen}','${ref}')" disabled>✓ Guardar distribución</button>
    </div>`;
  actualizarSplitTarjetaContador(origen, ref);
}

function splitTarjetaCambiarGrupo(origen, ref, idx, val) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (!est) return;
  est.filas[idx].grupo = val;
  est.filas[idx].subgrupo = '';
  renderSplitTarjeta(origen, ref);
}
function splitTarjetaCambiarSub(origen, ref, idx, val) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (est) est.filas[idx].subgrupo = val;
}
function splitTarjetaCambiarMonto(origen, ref, idx, val) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (!est) return;
  est.filas[idx].monto = parseFloat(val) || 0;
  actualizarSplitTarjetaContador(origen, ref);
}
function splitTarjetaBorrarFila(origen, ref, idx) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (!est) return;
  est.filas.splice(idx, 1);
  renderSplitTarjeta(origen, ref);
}
function splitTarjetaAgregarFila(origen, ref) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (!est) return;
  est.filas.push({ grupo: '', subgrupo: '', monto: 0 });
  renderSplitTarjeta(origen, ref);
}

function actualizarSplitTarjetaContador(origen, ref) {
  const est = splitTarjetas[`${origen}-${ref}`];
  if (!est) return;
  const suma = est.filas.reduce((acc, f) => acc + (f.monto || 0), 0);
  const dif = est.total - suma;
  const cont = document.getElementById(`split-tarjeta-contador-${origen}-${ref}`);
  const btn = document.getElementById(`btn-split-tarjeta-guardar-${origen}-${ref}`);
  if (!cont || !btn) return;
  let texto, color, ok;
  if (dif > 0) {
    texto = `Distribuido: ${fmt(suma)} de ${fmt(est.total)} — faltan ${fmt(dif)}`;
    color = '#c0392b'; ok = false;
  } else if (dif < 0) {
    texto = `Distribuido: ${fmt(suma)} de ${fmt(est.total)} — sobran ${fmt(-dif)}`;
    color = '#c0392b'; ok = false;
  } else {
    texto = `✓ Distribuido: ${fmt(suma)} de ${fmt(est.total)} — cuadra`;
    color = '#27ae60'; ok = true;
  }
  cont.textContent = texto;
  cont.style.color = color;
  btn.disabled = !ok;
}

// Guarda la distribución de una tarjeta (Gmail o Imagen) como N egresos.
async function guardarSplitTarjeta(origen, ref) {
  const clave = `${origen}-${ref}`;
  const est = splitTarjetas[clave];
  if (!est) return;

  // Recuperar el movimiento original (fecha, producto sugerido, descripción)
  let fecha, descripcion, notas, fuente, idTarjeta;
  if (origen === 'gmail') {
    const c = estado.correosPendientes.find(x => x.gmailId === ref);
    if (!c) { mostrarToast('No se encontró el correo'); return; }
    fecha = c.fecha;
    descripcion = document.getElementById(`correo-desc-${ref}`)?.value || c.asunto?.substring(0, 50) || '';
    notas = ref; fuente = 'Gmail-Split'; idTarjeta = `correo-${ref}`;
  } else {
    const m = estado.movimientosImagen[ref];
    if (!m) { mostrarToast('No se encontró el movimiento'); return; }
    fecha = m.fecha;
    descripcion = document.getElementById(`img-desc-${ref}`)?.value || m.descripcion || '';
    notas = ''; fuente = 'Imagen-Split'; idTarjeta = `img-mov-${ref}`;
  }

  // El producto (cuenta) se toma del selector de la tarjeta
  const producto = origen === 'gmail'
    ? document.getElementById(`correo-prod-${ref}`)?.value
    : document.getElementById(`img-prod-${ref}`)?.value;

  if (!producto) { mostrarToast('Selecciona el producto (cuenta)'); return; }
  if (esPeriodoCerrado(fecha)) {
    mostrarToast('🔒 No se puede registrar: la fecha pertenece a un mes ya cerrado');
    return;
  }
  for (let i = 0; i < est.filas.length; i++) {
    const f = est.filas[i];
    if (!f.grupo || !f.subgrupo) { mostrarToast(`Renglón ${i + 1}: falta grupo o subgrupo`); return; }
    if (!f.monto || f.monto <= 0) { mostrarToast(`Renglón ${i + 1}: monto inválido`); return; }
  }
  const suma = est.filas.reduce((acc, f) => acc + (f.monto || 0), 0);
  if (suma !== est.total) { mostrarToast('La suma de los renglones no cuadra con el total'); return; }

  const btn = document.getElementById(`btn-split-tarjeta-guardar-${origen}-${ref}`);
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  mostrarSpinner(true);
  try {
    for (const f of est.filas) {
      const datos = {
        fecha, tipo: 'Egreso', grupo: f.grupo, subgrupo: f.subgrupo,
        producto, monto: f.monto, descripcion, notas, fuente
      };
      const r = construirFilaTx(datos);
      await escribirFila('Transacciones', r.fila);
    }
    // GMF una sola vez sobre el TOTAL que salió de la cuenta
    const gmfSplitT = await generarGMF(producto, est.total, fecha, descripcion, fuente);
    await cargarDatos();
    mostrarSpinner(false);
    mostrarToast(gmfSplitT > 0
      ? `✓ Distribución registrada (${est.filas.length} mov.) + GMF ${fmt(gmfSplitT)}`
      : `✓ Distribución registrada (${est.filas.length} movimientos)`);
    // Quitar la tarjeta y limpiar
    document.getElementById(idTarjeta)?.remove();
    if (origen === 'gmail') {
      estado.correosPendientes = estado.correosPendientes.filter(x => x.gmailId !== ref);
    }
    delete splitTarjetas[clave];
  } catch (e) {
    mostrarSpinner(false);
    if (btn) { btn.disabled = false; btn.textContent = '✓ Guardar distribución'; }
    mostrarToast('Error al guardar la distribución: ' + e.message);
    console.error(e);
  }
}


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
        // En traslados mostramos "origen → destino"; en el resto, solo el producto.
        let celdaProducto;
        if (t.tipo === 'Traslado') {
          const prodDest = estado.productos.find(p => p.id === t.destino);
          const nomOrigen = prod ? prod.nombre : (t.origen || '—');
          const nomDestino = prodDest ? prodDest.nombre : (t.destino || '—');
          celdaProducto = `${nomOrigen} → ${nomDestino}`;
        } else {
          celdaProducto = prod ? prod.nombre : t.origen;
        }
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
          <td>${celdaProducto}</td>
          <td class="${cls}">${t.tipo === 'Egreso' ? '-' : ''}${fmt(Math.abs(t.monto))}</td>
          <td>${t.descripcion || ''}</td>
          <td style="color:var(--texto2);font-size:12px">${t.fuente || ''}</td>
          <td style="white-space:nowrap">${acciones}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

// ── DETECCIÓN DE PRODUCTO DE DEUDA ────────────────────────────────────
// Devuelve true si el producto es una deuda: Tarjeta Crédito o crédito/
// hipoteca/libranza/pasivo. Mismo criterio que usa calcularFlujoFinanciero.
function esProductoDeuda(productoId) {
  const p = estado.productos.find(x => x.id === productoId);
  if (!p) return false;
  const t = (p.tipo || '').toLowerCase();
  return t === 'tarjeta crédito' || t === 'tarjeta credito' ||
         t.includes('crédito') || t.includes('credito') ||
         t.includes('hipotec') || t.includes('libranza') || t.includes('pasivo');
}

// ── PAGO DE DEUDA POR TRASLADO: lista de cuotas con checkbox ───────────
// Muestra/oculta el bloque de pago de deuda según si el DESTINO es deuda.
// Renderiza las cuotas pendientes de ese producto, premarcando las que
// vencen en el mes de la fecha del traslado.
function actualizarBloquePagoDeuda() {
  const destinoId = document.getElementById('tr-destino').value;
  const bloque = document.getElementById('tr-pago-deuda-bloque');
  const esDeuda = esProductoDeuda(destinoId);
  bloque.classList.toggle('oculto', !esDeuda);
  if (!esDeuda) {
    document.getElementById('tr-cuotas-lista').innerHTML = '';
    return;
  }
  renderCuotasPagoDeuda(destinoId);
}

function renderCuotasPagoDeuda(destinoId) {
  const cont = document.getElementById('tr-cuotas-lista');
  const fechaTr = document.getElementById('tr-fecha').value || '';
  const mesPago = fechaTr.substring(0, 7); // YYYY-MM

  // Cuotas pendientes de este producto, ordenadas por vencimiento
  const pendientes = (estado.cuotasTC || [])
    .filter(c => c.productoTC === destinoId && c.estado === 'Pendiente')
    .sort((a, b) => (a.fechaVencimiento || '').localeCompare(b.fechaVencimiento || ''));

  if (pendientes.length === 0) {
    cont.innerHTML = '<p style="color:#888;font-size:13px">Este producto no tiene cuotas pendientes en el calendario.</p>';
    return;
  }

  let html = '';
  pendientes.forEach(c => {
    const venceEnMes = (c.fechaVencimiento || '').substring(0, 7) === mesPago;
    const numTxt = c.totalCuotas ? `${c.numCuota}/${c.totalCuotas}` : `${c.numCuota}`;
    const desc = c.descripcion || '(sin descripción)';
    html += `
      <label class="cuota-check" style="display:flex;align-items:flex-start;gap:8px;padding:6px 8px;border:1px solid #eee;border-radius:6px;margin:4px 0;cursor:pointer">
        <input type="checkbox" class="tr-cuota-input" value="${c.idCuota}" ${venceEnMes ? 'checked' : ''} style="margin-top:3px">
        <span style="font-size:13px;line-height:1.4">
          <strong>Cuota ${numTxt}</strong> · vence ${formatearFechaCorta(c.fechaVencimiento)}<br>
          <span style="color:#666">${desc}</span><br>
          <span style="color:#888">capital ${fmt(c.capitalCuota)} + interés ${fmt(c.interesCuota)}</span>
        </span>
      </label>`;
  });
  cont.innerHTML = html;
}

// Formatea YYYY-MM-DD a DD/MM/YYYY (vacío si no hay fecha)
function formatearFechaCorta(f) {
  if (!f) return '—';
  const partes = f.substring(0, 10).split('-');
  if (partes.length !== 3) return f;
  return `${partes[2]}/${partes[1]}/${partes[0]}`;
}

// Marca como Pagada las cuotas (por ID_Cuota) tildadas en el bloque de pago
// de deuda, guardando el ID del traslado en la columna de trazabilidad.
async function marcarCuotasSeleccionadas(idsCuotas, idTxPago) {
  if (!idsCuotas || idsCuotas.length === 0) return;
  const filas = await leerHoja('Calendario_Deuda!A2:M');
  for (let i = 0; i < filas.length; i++) {
    if (idsCuotas.includes(filas[i][0]) && filas[i][11] === 'Pendiente') {
      await actualizarCelda(`Calendario_Deuda!L${i + 2}`, 'Pagada');
      await actualizarCelda(`Calendario_Deuda!M${i + 2}`, idTxPago);
    }
  }
}

// ── FORMULARIOS ───────────────────────────────────────────────────────
function configurarFormularios() {
  const hoy = new Date().toISOString().split('T')[0];
  document.getElementById('tx-fecha').value = hoy;
  document.getElementById('tr-fecha').value = hoy;

  document.getElementById('btn-tx-preview').addEventListener('click', () => {
    const datos = leerFormTx();
    if (!validarTx(datos)) return;
    if (subgrupoEsDeudaTx()) {
      actualizarAvisoDeudaTx();
      mostrarToast('💡 Este es un pago de deuda: regístralo por la pestaña Traslado.');
      return;
    }
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

  // ── Listeners del split de débito ──
  const btnSplitAbrir = document.getElementById('btn-tx-split-abrir');
  if (btnSplitAbrir) btnSplitAbrir.addEventListener('click', abrirSplit);
  const btnSplitCerrar = document.getElementById('btn-tx-split-cerrar');
  if (btnSplitCerrar) btnSplitCerrar.addEventListener('click', cerrarSplit);
  const btnSplitAgregar = document.getElementById('btn-tx-split-agregar');
  if (btnSplitAgregar) btnSplitAgregar.addEventListener('click', splitAgregarFila);
  const btnSplitGuardar = document.getElementById('btn-tx-split-guardar');
  if (btnSplitGuardar) btnSplitGuardar.addEventListener('click', guardarSplit);
  const inputSplitTotal = document.getElementById('tx-split-total');
  if (inputSplitTotal) inputSplitTotal.addEventListener('input', actualizarSplitContador);

  // ── Blindaje: avisar que los pagos de deuda van por Traslado ──
  document.getElementById('tx-subgrupo').addEventListener('change', actualizarAvisoDeudaTx);
  const btnIrTraslado = document.getElementById('btn-tx-ir-traslado');
  if (btnIrTraslado) {
    btnIrTraslado.addEventListener('click', () => {
      resetFormTx();
      cambiarVista('traslado');
    });
  }

  document.getElementById('btn-tx-guardar').addEventListener('click', async () => {
    const datos = leerFormTx();
    // Blindaje: los pagos de deuda no se procesan acá, van por Traslado
    if (subgrupoEsDeudaTx()) {
      mostrarToast('💡 Este es un pago de deuda: regístralo por la pestaña Traslado (separa capital e interés).');
      return;
    }
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
    // GMF si la salida es desde una cuenta de ahorros no exenta
    // (calcularGMF devuelve 0 si el origen es una TC o cuenta exenta)
    const gmfTx = await generarGMF(datos.producto, datos.monto, datos.fecha, datos.descripcion, 'Manual');
    await cargarDatos();
    mostrarSpinner(false);
    let msgTx = r.esTraslado ? '✓ Pago de TC registrado' : '✓ Transacción registrada';
    if (gmfTx > 0) msgTx += ` + GMF ${fmt(gmfTx)}`;
    mostrarToast(msgTx);
    resetFormTx();
    cambiarVista('dashboard');
  });

  document.getElementById('btn-tr-preview').addEventListener('click', () => {
    const datos = leerFormTr();
    if (!validarTr(datos)) return;
    const origen = estado.productos.find(p => p.id === datos.origen);
    const destino = estado.productos.find(p => p.id === datos.destino);

    let extra = '';
    if (esProductoDeuda(datos.destino) && !datos.esDisposicion) {
      const interes = parseFloat(document.getElementById('tr-interes').value) || 0;
      const capital = datos.monto - interes;
      const nCuotas = document.querySelectorAll('.tr-cuota-input:checked').length;
      extra = `
        <br>── Pago de deuda ──<br>
        💵 Capital (traslado): ${fmt(capital)}<br>
        💸 Interés (costo financiero): ${fmt(interes)}<br>
        ✅ Cuotas a marcar pagadas: ${nCuotas}`;
    }

    document.getElementById('tr-preview').innerHTML = `
      <strong>Confirmar traslado:</strong><br>
      📅 Fecha: ${datos.fecha}<br>
      🏦 Origen: ${origen ? origen.nombre : datos.origen}<br>
      🏦 Destino: ${destino ? destino.nombre : datos.destino}<br>
      💰 Monto: ${fmt(datos.monto)}<br>
      📝 ${datos.descripcion}${extra}
    `;
    document.getElementById('tr-preview').classList.remove('oculto');
    document.getElementById('btn-tr-guardar').classList.remove('oculto');
    document.getElementById('btn-tr-cancelar').classList.remove('oculto');
    document.getElementById('btn-tr-preview').classList.add('oculto');
  });

  document.getElementById('btn-tr-cancelar').addEventListener('click', resetFormTr);

  document.getElementById('btn-tr-guardar').addEventListener('click', async () => {
    const datos = leerFormTr();
    const btn = document.getElementById('btn-tr-guardar');
    btn.disabled = true;
    const textoOrig = btn.textContent;
    btn.textContent = 'Guardando...';
    mostrarSpinner(true);
    try {
      // ¿El destino es una deuda? → pago de deuda partido (capital + interés)
      const destinoEsDeuda = esProductoDeuda(datos.destino) && !datos.esDisposicion;

      if (destinoEsDeuda) {
        const interes = parseFloat(document.getElementById('tr-interes').value) || 0;
        const capital = datos.monto - interes;
        if (capital < 0) {
          mostrarSpinner(false);
          btn.disabled = false; btn.textContent = textoOrig;
          mostrarToast('El interés no puede ser mayor que el monto del pago');
          return;
        }

        // Cuotas tildadas por el usuario
        const idsCuotas = Array.from(document.querySelectorAll('.tr-cuota-input:checked'))
          .map(chk => chk.value);

        const idCapital = 'TX' + Date.now();
        // Buscar el subgrupo de pago real de la deuda destino (su Cuenta_Destino
        // apunta al producto). Así la fila queda con "Pago TC MC Nu" (y su ID)
        // en vez del genérico "Pago de deuda". Si no se encuentra, cae al genérico.
        const gPagoDest = estado.grupos.find(x => x.cuentaDestino === datos.destino);
        const grupoCap = gPagoDest ? gPagoDest.grupo : 'Traslados';
        const subCap = gPagoDest ? gPagoDest.subgrupo : 'Pago de deuda';
        const idSubCap = gPagoDest ? gPagoDest.idSubgrupo : '';
        // 1) Traslado del CAPITAL (monto - interés) a la deuda
        await escribirFila('Transacciones', [
          idCapital, datos.fecha, 'Traslado', grupoCap, subCap,
          datos.origen, datos.destino, capital,
          datos.descripcion || 'Pago de deuda', 'Manual', 'TRUE', '', idSubCap
        ]);

        // 2) Egreso de COSTO FINANCIERO por el interés (desde la cuenta origen)
        if (interes > 0) {
          const gCF = estado.grupos.find(x => x.subgrupo === 'Costo financiero');
          if (!gCF) {
            mostrarToast('⚠️ No encontré el subgrupo "Costo financiero" en Grupos. El interés NO se registró.');
          } else {
            await escribirFila('Transacciones', [
              'TX' + (Date.now() + 1), datos.fecha, 'Egreso', gCF.grupo, 'Costo financiero',
              datos.origen, '', interes,
              'Interés ' + (datos.descripcion || 'pago de deuda'), 'Manual', 'TRUE', '', gCF.idSubgrupo || ''
            ]);
          }
        }

        // 3) Marcar como Pagada las cuotas tildadas (el traslado de capital es la trazabilidad)
        await marcarCuotasSeleccionadas(idsCuotas, idCapital);

        // 4) GMF sobre el TOTAL que salió de la cuenta origen (capital + interés), una vez
        const gmfPago = await generarGMF(datos.origen, datos.monto, datos.fecha, datos.descripcion || 'Pago de deuda', 'Manual');

        await cargarDatos();
        mostrarSpinner(false);
        btn.disabled = false; btn.textContent = textoOrig;
        let msgPago = '✓ Pago de deuda registrado' + (interes > 0 ? ' (capital + interés)' : '');
        if (gmfPago > 0) msgPago += ` + GMF ${fmt(gmfPago)}`;
        mostrarToast(msgPago);
        resetFormTr();
        cambiarVista('dashboard');
        return;
      }

      // ── Traslado normal / disposición (comportamiento de siempre) ──
      const id = 'TX' + Date.now();
      const gTrasl = estado.grupos.find(x => x.subgrupo === 'Traslado entre cuentas');
      await escribirFila('Transacciones', [
        id, datos.fecha, 'Traslado', 'Traslados', 'Traslado entre cuentas',
        datos.origen, datos.destino, datos.monto, datos.descripcion, 'Manual', 'TRUE', '', gTrasl ? gTrasl.idSubgrupo : ''
      ]);
      await actualizarSaldoProducto(datos.origen, 'Egreso', datos.monto);
      await actualizarSaldoProducto(datos.destino, 'Ingreso', datos.monto);
      // Si el origen es una tarjeta/crédito, es una disposición: generar sus cuotas
      if (datos.esDisposicion) {
        await generarCuotasDisposicion(id, datos);
      }
      // GMF sobre lo que salió del origen. En disposición el origen es una TC →
      // generarGMF devuelve 0 (no es salida de caja). En traslado entre cuentas,
      // genera si el origen es cuenta de ahorros no exenta (Nacho borra si no aplicaba).
      const gmfTrasl = await generarGMF(datos.origen, datos.monto, datos.fecha, datos.descripcion || 'Traslado', 'Manual');
      await cargarDatos();
      mostrarSpinner(false);
      btn.disabled = false; btn.textContent = textoOrig;
      mostrarToast(gmfTrasl > 0 ? `✓ Traslado registrado + GMF ${fmt(gmfTrasl)}` : '✓ Traslado registrado');
      resetFormTr();
      cambiarVista('dashboard');
    } catch (e) {
      mostrarSpinner(false);
      btn.disabled = false; btn.textContent = textoOrig;
      mostrarToast('Error registrando: ' + e.message);
      console.error(e);
    }
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

  // ── Al marcar "genera intereses": mostrar campos de tasa y el método del producto ──
  const chkInteres = document.getElementById('tx-con-interes');
  if (chkInteres) {
    chkInteres.addEventListener('change', () => {
      const bloqueTasa = document.getElementById('tx-tasa-bloque');
      bloqueTasa.classList.toggle('oculto', !chkInteres.checked);
      if (chkInteres.checked) {
        const prod = estado.productos.find(p => p.id === selProducto.value);
        const metodo = normalizarMetodoAmortizacion(prod ? prod.metodoAmortizacion : '');
        const ayudaM = document.getElementById('tx-metodo-ayuda');
        if (ayudaM) {
          const tasaTxt = 'El % que escribas se interpreta como ' + etiquetaTipoTasa(prod ? prod.tipoTasa : '') + '.';
          ayudaM.textContent = (metodo === 'aleman'
            ? 'Este producto amortiza con método alemán (cuota decreciente). '
            : 'Este producto amortiza con método francés (cuota fija). ') + tasaTxt;
        }
      }
    });
  }

  // ── Mostrar bloque de disposición solo si el ORIGEN del traslado es Tarjeta Crédito ──
  const selOrigen = document.getElementById('tr-origen');
  const bloqueDisp = document.getElementById('tr-disposicion-bloque');

  function actualizarVisibilidadDisposicion() {
    const prod = estado.productos.find(p => p.id === selOrigen.value);
    const esTC = prod && prod.tipo === 'Tarjeta Crédito';
    bloqueDisp.classList.toggle('oculto', !esTC);
    if (esTC) {
      const fechaTr = document.getElementById('tr-fecha').value || new Date().toISOString().substring(0, 10);
      const ayuda = document.getElementById('tr-primera-cuota-ayuda');
      const venc = calcularPrimerVencimiento(prod, fechaTr) || sumarUnMes(fechaTr);
      document.getElementById('tr-primera-cuota').value = venc;
      ayuda.textContent = (calcularPrimerVencimiento(prod, fechaTr))
        ? 'Calculada automáticamente — ajústala si el banco la pone otro día.'
        : 'Sin corte fijo (ej. Crediágil): se tomó un mes desde la fecha. Ajústala si aplica.';
      const ayudaM = document.getElementById('tr-metodo-ayuda');
      if (ayudaM) {
        const metodo = normalizarMetodoAmortizacion(prod.metodoAmortizacion);
        const tasaTxt = 'El % que escribas se interpreta como ' + etiquetaTipoTasa(prod.tipoTasa) + '.';
        ayudaM.textContent = (metodo === 'aleman'
          ? 'Esta tarjeta amortiza con método alemán (cuota decreciente). '
          : 'Esta tarjeta amortiza con método francés (cuota fija). ') + tasaTxt;
      }
    }
  }

  selOrigen.addEventListener('change', actualizarVisibilidadDisposicion);
  document.getElementById('tr-fecha').addEventListener('change', actualizarVisibilidadDisposicion);

  // ── Pago de deuda: mostrar bloque y lista de cuotas cuando el DESTINO es deuda ──
  document.getElementById('tr-destino').addEventListener('change', actualizarBloquePagoDeuda);
  document.getElementById('tr-fecha').addEventListener('change', actualizarBloquePagoDeuda);
}

// ¿El subgrupo seleccionado en +Transacción apunta a una deuda? (tiene Cuenta_Destino)
function subgrupoEsDeudaTx() {
  const grupo = document.getElementById('tx-grupo').value;
  const subgrupo = document.getElementById('tx-subgrupo').value;
  const g = estado.grupos.find(x => x.grupo === grupo && x.subgrupo === subgrupo);
  return !!(g && g.cuentaDestino);
}

// Muestra u oculta el aviso de "esto va por Traslado" según el subgrupo elegido
function actualizarAvisoDeudaTx() {
  const aviso = document.getElementById('tx-aviso-deuda');
  if (!aviso) return;
  if (subgrupoEsDeudaTx()) aviso.classList.remove('oculto');
  else aviso.classList.add('oculto');
}

function leerFormTx() {
  const diferir = document.getElementById('tx-diferir');
  const esDiferido = diferir && diferir.checked;
  const prodTx = estado.productos.find(p => p.id === document.getElementById('tx-producto').value);
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
    conInteres: esDiferido ? document.getElementById('tx-con-interes').checked : false,
    tasaPct: esDiferido ? (parseFloat(document.getElementById('tx-tasa-pct').value) || 0) : 0,
    tasaTipo: normalizarTipoTasa(prodTx ? prodTx.tipoTasa : '')
  };
}

function leerFormTr() {
  const origen = document.getElementById('tr-origen').value;
  const prodOrigen = estado.productos.find(p => p.id === origen);
  const esDisposicion = prodOrigen && prodOrigen.tipo === 'Tarjeta Crédito';
  return {
    fecha: document.getElementById('tr-fecha').value,
    origen: origen,
    destino: document.getElementById('tr-destino').value,
    monto: parseFloat(document.getElementById('tr-monto').value) || 0,
    descripcion: document.getElementById('tr-descripcion').value,
    esDisposicion: esDisposicion,
    numCuotas: parseInt(document.getElementById('tr-num-cuotas').value) || 1,
    tasaPct: parseFloat(document.getElementById('tr-tasa-pct').value) || 0,
    tasaTipo: normalizarTipoTasa(prodOrigen ? prodOrigen.tipoTasa : ''),
    primeraCuota: document.getElementById('tr-primera-cuota').value
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
  const avisoDeuda = document.getElementById('tx-aviso-deuda');
  if (avisoDeuda) avisoDeuda.classList.add('oculto');
  // Cerrar el panel de distribución si estaba abierto
  const splitPanel = document.getElementById('tx-split-panel');
  if (splitPanel) splitPanel.classList.add('oculto');
  const splitAbrir = document.getElementById('tx-split-abrir-bloque');
  if (splitAbrir) splitAbrir.classList.add('oculto');
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
  // Limpiar bloque de pago de deuda
  const bloqueDeuda = document.getElementById('tr-pago-deuda-bloque');
  if (bloqueDeuda) bloqueDeuda.classList.add('oculto');
  const intInput = document.getElementById('tr-interes');
  if (intInput) intInput.value = '0';
  const lista = document.getElementById('tr-cuotas-lista');
  if (lista) lista.innerHTML = '';
}

// ── VALIDACIÓN DE PERÍODO CERRADO ─────────────────────────────────────
// Devuelve true si la fecha cae en un mes ya cerrado (≤ último cierre).
// Esas transacciones no se pueden registrar: el pasado está bloqueado.
function esPeriodoCerrado(fecha) {
  if (!fecha) return false;
  return fecha <= estado.ultimoCierre;
}

// ── PAGO DE DEUDA PARTIDO (capital + interés) ─────────────────────────
// Registra un pago de TC/deuda separando el interés del capital, para no
// inflar el abono a capital. Crea hasta dos registros, ambos desde la
// cuenta de ahorros origen:
//   1) Traslado del CAPITAL (monto - interes) a la tarjeta/deuda.
//   2) Egreso de COSTO FINANCIERO por el interés (subgrupo "Costo financiero").
// Si interes <= 0, se comporta como un pago normal (solo el traslado).
// Devuelve { idTxCapital, idTxInteres, esTraslado, destino } para que el
// llamador marque cuotas pagadas con el traslado de capital.
async function registrarPagoDeudaPartido(d, interes) {
  // d = { fecha, tipo, grupo, subgrupo, producto, monto, descripcion, fuente, notas }
  const intNum = Number(interes) || 0;
  const capital = d.monto - intNum;

  // 1) Registro del capital (lo arma construirFilaTx → será Traslado por Cuenta_Destino)
  const dCapital = { ...d, monto: capital };
  const rCapital = construirFilaTx(dCapital);
  await escribirFila('Transacciones', rCapital.fila);

  let idTxInteres = '';

  // 2) Registro del interés como egreso de costo financiero (solo si hay interés)
  if (intNum > 0) {
    const gCF = estado.grupos.find(x => x.subgrupo === 'Costo financiero');
    if (!gCF) {
      mostrarToast('⚠️ No encontré el subgrupo "Costo financiero" en Grupos. El interés NO se registró.');
    } else {
      idTxInteres = 'TX' + (Date.now() + 1); // +1 para no chocar con el id del capital
      const filaInteres = [
        idTxInteres, d.fecha, 'Egreso', gCF.grupo, 'Costo financiero',
        d.producto, '', intNum,
        'Interés ' + (d.descripcion || ''), d.fuente, 'TRUE', d.notas || '', gCF.idSubgrupo || ''
      ];
      await escribirFila('Transacciones', filaInteres);
    }
  }

  // 3) GMF sobre el TOTAL que salió de la cuenta de ahorros (capital + interés),
  //    una sola vez. Si la cuenta es exenta o no es cuenta de caja, devuelve 0.
  await generarGMF(d.producto, d.monto, d.fecha, d.descripcion || 'Pago de deuda', d.fuente);

  return {
    idTxCapital: rCapital.idTx,
    idTxInteres,
    esTraslado: rCapital.esTraslado,
    destino: rCapital.destino
  };
}

// ── PAGOS DE TC COMO TRASLADO ─────────────────────────────────────────
// Dado el grupo+subgrupo de un movimiento, decide si es un pago de TC.
// Si lo es, devuelve los datos como Traslado (cuenta origen → TC destino).
// Si no, los devuelve tal cual (movimiento normal).
function construirFilaTx(d) {
  // d = { fecha, tipo, grupo, subgrupo, producto, monto, descripcion, fuente, notas }
  const g = estado.grupos.find(x => x.grupo === d.grupo && x.subgrupo === d.subgrupo);
  const tcDestino = g && g.cuentaDestino ? g.cuentaDestino : '';
  const idSub = g ? g.idSubgrupo : '';   // ID estable del subgrupo (col M)
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
        d.producto, tcDestino, d.monto, d.descripcion, d.fuente, 'TRUE', d.notas || '', idSub
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
      d.producto, '', d.monto, d.descripcion, d.fuente, 'TRUE', d.notas || '', idSub
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
  // Abrir/cerrar grupos desplegables
  document.querySelectorAll('.nav-grupo-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const grupo = btn.closest('.nav-grupo');
      const yaAbierto = grupo.classList.contains('abierto');
      cerrarMenusNav();
      if (!yaAbierto) grupo.classList.add('abierto');
    });
  });
  // Clic fuera de la barra → cierra cualquier menú abierto
  document.addEventListener('click', cerrarMenusNav);
}

function cerrarMenusNav() {
  document.querySelectorAll('.nav-grupo.abierto').forEach(g => g.classList.remove('abierto'));
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
  // Cierra el menú desplegable y resalta el grupo que contiene la vista activa
  cerrarMenusNav();
  document.querySelectorAll('.nav-grupo').forEach(g => g.classList.remove('tiene-activo'));
  const btnActivo = document.querySelector(`.nav-btn[data-vista="${vista}"]`);
  if (btnActivo) {
    const grupo = btnActivo.closest('.nav-grupo');
    if (grupo) grupo.classList.add('tiene-activo');
  }
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
    const filas = await leerHoja('Calendario_Deuda!A2:M');
    for (const item of aPagar) {
      // Buscar las cuotas pendientes de esa compra, ordenadas por número de cuota descendente
      const cuotasCompra = [];
      for (let i = 0; i < filas.length; i++) {
        if (filas[i][1] === item.idCompra && filas[i][11] === 'Pendiente') {
          cuotasCompra.push({ filaSheet: i + 2, numCuota: parseInt(filas[i][6]) || 0 });
        }
      }
      // Reducir plazo: las más lejanas (número de cuota más alto) primero
      cuotasCompra.sort((a, b) => b.numCuota - a.numCuota);
      const aMarcar = cuotasCompra.slice(0, item.cantidad);
      for (const c of aMarcar) {
        await actualizarCelda(`Calendario_Deuda!L${c.filaSheet}`, 'Pagada');
        await actualizarCelda(`Calendario_Deuda!M${c.filaSheet}`, idTx);
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
      origenId, tcId, montoTotal, 'Abono anticipado a TC', 'Manual', 'TRUE', '', grupoPago.idSubgrupo || ''
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
        <div id="campos-normales-imagen-${i}">
          <select class="correo-select" id="img-prod-${i}" onchange="avisoCuotaTCImagen(${i})">${optsProductos}</select>
          <select class="correo-select" id="img-grupo-${i}" onchange="actualizarSubgruposImagen(${i})">${optsGrupos}</select>
          <select class="correo-select" id="img-sub-${i}" onchange="revisarInteresImagen(${i})"></select>
          <input class="correo-input" id="img-desc-${i}" type="text" value="${m.descripcion}" />
          <div class="aviso-cuota-tc oculto" id="img-aviso-${i}" style="font-size:0.85em;color:#0a7;margin-top:4px;">ℹ️ Se registrará a 1 cuota. Para diferir, usa +Transacción.</div>
          <div class="campo-interes-deuda oculto" id="img-int-bloque-${i}" style="margin-top:6px;">
            <label style="font-size:0.85em;color:var(--texto2)">Interés incluido en el pago (si aplica):</label>
            <input class="correo-input" id="img-int-${i}" type="number" min="0" value="0" placeholder="0" />
          </div>
        </div>
        ${m.tipo === 'Egreso' ? `<button type="button" class="btn-secundario" style="margin-top:6px; padding:4px 10px; font-size:0.85em" id="btn-split-abrir-imagen-${i}" onclick="abrirSplitTarjeta('imagen',${i},${m.monto})">➗ Distribuir en varios subgrupos</button>` : ''}
        <div id="split-tarjeta-imagen-${i}"></div>
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
  revisarInteresImagen(i);
}

// Muestra el campo de interés solo si el subgrupo elegido apunta a una deuda.
function revisarInteresImagen(i) {
  const subgrupo = document.getElementById(`img-sub-${i}`)?.value;
  const grupo = document.getElementById(`img-grupo-${i}`)?.value;
  const bloque = document.getElementById(`img-int-bloque-${i}`);
  if (!bloque) return;
  const g = estado.grupos.find(x => x.grupo === grupo && x.subgrupo === subgrupo);
  const esPagoDeuda = g && g.cuentaDestino;
  bloque.classList.toggle('oculto', !esPagoDeuda);
  if (!esPagoDeuda) {
    const inp = document.getElementById(`img-int-${i}`);
    if (inp) inp.value = 0;
  }
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

  // Blindaje contra doble clic: el botón "Registrar" vive dentro del bloque del movimiento
  const btn = document.querySelector(`#img-mov-${i} .btn-confirmar`);
  const textoOrig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }

  mostrarSpinner(true);
  try {
    const datosTx = {
      fecha: m.fecha, tipo: m.tipo, grupo, subgrupo,
      producto, monto: m.monto, descripcion, fuente: 'Imagen', notas: '',
      numCuotas: 1, primeraCuota: '', conInteres: false
    };
    // ¿Es pago de deuda? (el subgrupo apunta a una TC/deuda vía Cuenta_Destino)
    const gSel = estado.grupos.find(x => x.grupo === grupo && x.subgrupo === subgrupo);
    const esPagoDeuda = gSel && gSel.cuentaDestino;
    const interes = esPagoDeuda
      ? (Number(document.getElementById(`img-int-${i}`)?.value) || 0)
      : 0;

    let r;
    let gmfImg = 0;
    if (esPagoDeuda) {
      // Pago de deuda: partir en capital (traslado) + interés (costo financiero)
      // El GMF lo genera registrarPagoDeudaPartido sobre el total (no acá, para no duplicar)
      r = await registrarPagoDeudaPartido(datosTx, interes);
      if (r.destino) {
        const prodDestino = estado.productos.find(p => p.id === r.destino);
        if (prodDestino && prodDestino.tipo === 'Tarjeta Crédito') {
          await marcarCuotasPagoExtracto(r.destino, r.idTxCapital, m.fecha);
        }
      }
    } else {
      // Movimiento normal (no es pago de deuda)
      r = construirFilaTx(datosTx);
      await escribirFila('Transacciones', r.fila);
      const prodSel = estado.productos.find(p => p.id === producto);
      if (!r.esTraslado && prodSel && prodSel.tipo === 'Tarjeta Crédito') {
        await generarCuotasTC(r.idTx, datosTx);
      }
      // GMF si la salida es desde cuenta de ahorros no exenta
      gmfImg = await generarGMF(producto, m.monto, m.fecha, descripcion, 'Imagen');
    }
    await cargarDatos();
    mostrarSpinner(false);
    let msgImg = r.esTraslado ? '✓ Pago de TC registrado' : '✓ Movimiento registrado';
    if (gmfImg > 0) msgImg += ` + GMF ${fmt(gmfImg)}`;
    mostrarToast(msgImg);
    document.getElementById(`img-mov-${i}`).remove();
  } catch(e) {
    mostrarSpinner(false);
    if (btn) { btn.disabled = false; btn.textContent = textoOrig; }
    mostrarToast('Error registrando desde Imagen: ' + e.message);
    console.error(e);
  }
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
  document.getElementById('btn-generar-proyeccion').addEventListener('click', renderOlaCaja);
  renderOlaCaja();
}

function renderOlaCaja() {
  const proy = calcularProyeccionCaja(12);
  const meses = proy.meses;

  // Etiquetas de mes cortas (ej. "jun 26")
  const etiqueta = m => {
    const d = new Date(m.mes + '-02');
    return d.toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }).replace('.', '');
  };

  // ── Tarjetas resumen ──
  const saldoMin = Math.min(...meses.map(m => m.saldoFinal));
  const mesMin = meses.find(m => m.saldoFinal === saldoMin);
  const clsMin = saldoMin < 0 ? 'rojo' : (saldoMin < 3000000 ? 'amarillo' : 'verde');

  let html = `
  <div class="flujos-cards">
    <div class="flujo-card">
      <div class="flujo-card-label">Saldo de partida</div>
      <div class="flujo-card-valor">${fmt(proy.saldoPartida)}</div>
      <div class="flujo-card-tag">Caja disponible hoy</div>
    </div>
    <div class="flujo-card">
      <div class="flujo-card-label">Punto más bajo</div>
      <div class="flujo-card-valor ${clsMin}">${fmt(saldoMin)}</div>
      <div class="flujo-card-tag">${etiqueta(mesMin)}</div>
    </div>
    <div class="flujo-card">
      <div class="flujo-card-label">Saldo final proyectado</div>
      <div class="flujo-card-valor">${fmt(meses[meses.length - 1].saldoFinal)}</div>
      <div class="flujo-card-tag">${etiqueta(meses[meses.length - 1])}</div>
    </div>
  </div>`;

  // ── Gráfica SVG ──
  html += dibujarOlaSVG(meses);

  // ── Tabla mes a mes ──
  html += `<div class="flujos-tabla" style="margin-top:20px">
    <div class="flujo-fila cols-header ola-grid">
      <div class="concepto">Mes</div>
      <div class="num">Operativo</div>
      <div class="num">Financiero</div>
      <div class="num">Flujo neto</div>
      <div class="num">Saldo caja</div>
    </div>`;

  meses.forEach(m => {
    const clsFila = m.enRojo ? 'fila-roja' : '';
    const clsNeto = m.flujoNeto >= 0 ? 'verde' : 'rojo';
    const clsSaldo = m.saldoFinal < 0 ? 'rojo' : '';
    html += `<div class="flujo-fila ola-grid ${clsFila}">
      <div class="concepto">${etiqueta(m)}</div>
      <div class="num">${fmt(m.operativo)}</div>
      <div class="num">${m.financiero === 0 ? fmt(0) : fmt(m.financiero)}</div>
      <div class="num ${clsNeto}">${fmt(m.flujoNeto)}</div>
      <div class="num ${clsSaldo}"><strong>${fmt(m.saldoFinal)}</strong></div>
    </div>`;
  });

  html += `</div>
  <div style="margin-top:10px;font-size:12px;color:var(--texto2)">
    Operativo: presupuestado. Financiero: lo que vence según el calendario de deuda (la "ola"). El saldo de caja encadena mes a mes desde tu disponible actual.
  </div>`;

  document.getElementById('proyeccion-resultado').innerHTML = html;
}

// Dibuja la ola en SVG: línea de saldo de caja + barras de desembolso de deuda
function dibujarOlaSVG(meses) {
  const W = 760, H = 260, padL = 70, padR = 20, padT = 20, padB = 40;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const n = meses.length;

  const saldos = meses.map(m => m.saldoFinal);
  const olas = meses.map(m => m.olaDesembolso);
  const maxSaldo = Math.max(...saldos, 0);
  const minSaldo = Math.min(...saldos, 0);
  const maxOla = Math.max(...olas, 1);
  const rango = (maxSaldo - minSaldo) || 1;

  // Coordenada Y para un valor de saldo
  const yS = v => padT + innerH - ((v - minSaldo) / rango) * innerH;
  // X para el índice de mes (centro de cada columna)
  const stepX = innerW / n;
  const xC = i => padL + stepX * i + stepX / 2;
  // Altura de barra de ola
  const hOla = v => (v / maxOla) * (innerH * 0.5);

  // Línea cero (si hay saldos negativos)
  const yCero = yS(0);

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;background:var(--fondo2);border-radius:var(--radio)">`;

  // Zona bajo cero (roja tenue) si aplica
  if (minSaldo < 0) {
    svg += `<rect x="${padL}" y="${yCero}" width="${innerW}" height="${padT + innerH - yCero}" fill="rgba(231,76,60,0.10)"/>`;
    svg += `<line x1="${padL}" y1="${yCero}" x2="${W - padR}" y2="${yCero}" stroke="rgba(231,76,60,0.5)" stroke-width="1" stroke-dasharray="4 3"/>`;
  }

  // Barras de la ola (desembolso de deuda)
  meses.forEach((m, i) => {
    if (m.olaDesembolso > 0) {
      const bh = hOla(m.olaDesembolso);
      const bx = xC(i) - stepX * 0.28;
      const bw = stepX * 0.56;
      const by = padT + innerH - bh;
      svg += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="2" fill="rgba(243,156,18,0.55)"/>`;
    }
  });

  // Línea de saldo de caja
  let pts = meses.map((m, i) => `${xC(i)},${yS(m.saldoFinal)}`).join(' ');
  svg += `<polyline points="${pts}" fill="none" stroke="var(--acento)" stroke-width="2.5"/>`;

  // Puntos sobre la línea
  meses.forEach((m, i) => {
    const cls = m.saldoFinal < 0 ? 'rgba(231,76,60,1)' : 'var(--acento)';
    svg += `<circle cx="${xC(i)}" cy="${yS(m.saldoFinal)}" r="3.5" fill="${cls}"/>`;
  });

  // Etiquetas de mes (eje X)
  meses.forEach((m, i) => {
    const d = new Date(m.mes + '-02');
    const lbl = d.toLocaleDateString('es-CO', { month: 'short' }).replace('.', '');
    svg += `<text x="${xC(i)}" y="${H - 14}" text-anchor="middle" font-size="10" fill="var(--texto2)">${lbl}</text>`;
  });

  // Etiquetas de saldo (eje Y): máximo, cero, mínimo
  const fmtCorto = v => '$' + Math.round(v / 1000000) + 'M';
  svg += `<text x="${padL - 8}" y="${yS(maxSaldo) + 4}" text-anchor="end" font-size="10" fill="var(--texto2)">${fmtCorto(maxSaldo)}</text>`;
  if (minSaldo < 0) svg += `<text x="${padL - 8}" y="${yCero + 4}" text-anchor="end" font-size="10" fill="var(--texto2)">$0</text>`;
  svg += `<text x="${padL - 8}" y="${yS(minSaldo) + 4}" text-anchor="end" font-size="10" fill="var(--texto2)">${fmtCorto(minSaldo)}</text>`;

  svg += `</svg>`;
  return svg;
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

// Nivel de zoom activo de la vista de presupuesto: 'resumen' | 'grupos' | 'subgrupos'
let nivelPpto = 'grupos';

function cargarComparativo() {
  const mes = document.getElementById('ppto-mes').value;
  const flujos = calcularFlujosMes(mes);
  document.getElementById('ppto-aviso').style.display =
    (flujos.operativo.ingresos === 0 && flujos.operativo.egresos === 0) ? 'block' : 'none';
  renderFlujos(flujos);
}

// Cambia el nivel de zoom y vuelve a pintar
function cambiarNivelPpto(nivel) {
  nivelPpto = nivel;
  cargarComparativo();
}

function renderFlujos(flujos) {
  const fechaLabel = new Date(flujos.mes + '-02').toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
  const op = flujos.operativo;
  const fin = flujos.financiero;

  // Tarjetas resumen arriba.
  // Operativo y neto van en REAL; financiero va proyectado (su real aún no se calcula).
  const netoCombinado = op.netoReal + fin.netoReal;
  const clsOp = op.netoReal >= 0 ? 'verde' : 'rojo';
  const clsFin = fin.netoReal >= 0 ? 'verde' : 'rojo';
  const clsNeto = netoCombinado >= 0 ? 'verde' : 'rojo';

  let html = `
  <h3 style="font-size:15px;margin-bottom:16px;color:var(--texto2);text-transform:capitalize">${fechaLabel}</h3>

  <div class="flujos-cards">
    <div class="flujo-card">
      <div class="flujo-card-label">Flujo operativo</div>
      <div class="flujo-card-valor ${clsOp}">${fmt(op.netoReal)}</div>
      <div class="flujo-card-tag">Real</div>
    </div>
    <div class="flujo-card">
      <div class="flujo-card-label">Flujo financiero</div>
      <div class="flujo-card-valor ${clsFin}">${fmt(fin.netoReal)}</div>
      <div class="flujo-card-tag">Real</div>
    </div>
    <div class="flujo-card">
      <div class="flujo-card-label">Flujo neto del mes</div>
      <div class="flujo-card-valor ${clsNeto}">${fmt(netoCombinado)}</div>
      <div class="flujo-card-tag">Real</div>
    </div>
  </div>

  <div class="flujos-zoom">
    <button class="zoom-btn ${nivelPpto==='resumen'?'activo':''}" onclick="cambiarNivelPpto('resumen')">Resumen</button>
    <button class="zoom-btn ${nivelPpto==='grupos'?'activo':''}" onclick="cambiarNivelPpto('grupos')">Grupos</button>
    <button class="zoom-btn ${nivelPpto==='subgrupos'?'activo':''}" onclick="cambiarNivelPpto('subgrupos')">Subgrupos</button>
  </div>

  <div class="flujos-tabla">`;

  // ── BLOQUE OPERATIVO ──
  html += `<div class="flujo-bloque-header operativo">
    <div>Flujo operativo</div>
    <div class="num">${fmt(op.netoReal)}</div>
  </div>`;

  if (nivelPpto !== 'resumen') {
    html += `<div class="flujo-fila cols-header">
      <div class="concepto">Concepto</div>
      <div class="num">Ppto</div>
      <div class="num">Real</div>
      <div class="num">Desv.</div>
    </div>`;
  }

  if (nivelPpto !== 'resumen') {
    // Ingresos y egresos, separados
    const gruposIng = Object.entries(op.grupos).filter(([,g]) => g.tipo === 'ingreso')
      .sort(([,a], [,b]) => (b.total || 0) - (a.total || 0));
    const gruposEgr = Object.entries(op.grupos).filter(([,g]) => g.tipo === 'egreso')
      .sort(([,a], [,b]) => (b.total || 0) - (a.total || 0));

    if (gruposIng.length) {
      html += `<div class="flujo-subtitulo">Ingresos</div>`;
      gruposIng.forEach(([nombre, g]) => { html += renderGrupoFlujo(nombre, g); });
    }
    if (gruposEgr.length) {
      html += `<div class="flujo-subtitulo">Egresos</div>`;
      gruposEgr.forEach(([nombre, g]) => { html += renderGrupoFlujo(nombre, g); });
    }
  }

  // ── BLOQUE FINANCIERO ── (informativo: Proyectado vs Real)
  html += `<div class="flujo-bloque-header financiero">
    <div>Flujo financiero</div>
    <div class="num">${fmt(fin.netoReal)}</div>
  </div>`;

  if (nivelPpto !== 'resumen') {
    // Cabecera de columnas del financiero
    html += `<div class="flujo-fila cols-header">
      <div class="concepto">Concepto</div>
      <div class="num">Proyect.</div>
      <div class="num">Real</div>
      <div class="num"></div>
    </div>`;

    html += renderLineaFin('Nuevos créditos', fin.nuevosCreditos, fin.nuevosCreditosReal, 'entra');
    html += renderLineaFin('Abonos a capital', -fin.abonoCapital, -fin.abonoCapitalReal, 'sale');
    html += renderLineaFin('Costo financiero', -fin.costoFinanciero, -fin.costoFinancieroReal, 'sale');

    // Separador y líneas de inversión LP (solo real; no se proyectan).
    html += `<div class="flujo-fila" style="border-top:1px dashed var(--borde,#ccc);margin-top:4px;padding-top:6px"><div class="concepto" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--texto2)">inversión LP</div><div class="num"></div><div class="num"></div><div class="num"></div></div>`;
    html += renderLineaFin('Retiros inversión LP', 0, fin.retirosLPReal, 'entra');
    html += renderLineaFin('Aportes inversión LP', 0, -fin.aportesLPReal, 'sale');
    html += renderLineaFin('Rendimientos LP', 0, fin.rendimientoLPReal, 'entra');
  }

  // ── FLUJO NETO ── (en real, coherente con la tarjeta de arriba)
  html += `<div class="flujo-bloque-header neto">
    <div>Flujo neto del mes</div>
    <div class="num ${clsNeto}">${fmt(netoCombinado)}</div>
  </div>`;

  html += `</div>
  <div style="margin-top:10px;font-size:12px;color:var(--texto2)">
    Operativo y neto en <strong>Real</strong>. Financiero: Proyectado = lo que vence según el calendario de deuda; Real = lo ejecutado este mes.
  </div>`;

  document.getElementById('ppto-resultado').innerHTML = html;
}

// Pinta un grupo operativo (3 columnas: ppto, real, desv) y sus subgrupos si el zoom lo pide
function renderGrupoFlujo(nombre, g) {
  const tipoTx = g.tipo === 'ingreso' ? 'Ingreso' : 'Egreso';
  let h = `<div class="flujo-fila grupo tres-col">
    <div class="concepto">${nombre}</div>
    <div class="num">${g.total ? fmt(g.total) : '—'}</div>
    <div class="num">${g.totalReal ? fmt(g.totalReal) : '—'}</div>
    <div class="num">${renderDesviacion(g.totalReal, g.total, tipoTx)}</div>
  </div>`;
  if (nivelPpto === 'subgrupos') {
    Object.entries(g.subgrupos).forEach(([sub, v]) => {
      h += `<div class="flujo-fila detalle tres-col">
        <div class="concepto sub2">${sub}</div>
        <div class="num">${v.ppto ? fmt(v.ppto) : '—'}</div>
        <div class="num">${v.real ? fmt(v.real) : '—'}</div>
        <div class="num">${renderDesviacion(v.real, v.ppto, tipoTx)}</div>
      </div>`;
    });
  }
  return h;
}

// Pinta una línea del bloque financiero con columnas Proyectado y Real
function renderLineaFin(label, proyectado, real, dir) {
  const cls = dir === 'entra' ? 'verde' : '';
  const valP = proyectado === 0 ? 0 : proyectado;
  const valR = real === 0 ? 0 : real;
  return `<div class="flujo-fila grupo tres-col">
    <div class="concepto">${label}</div>
    <div class="num ${cls}">${fmt(valP)}</div>
    <div class="num ${cls}">${fmt(valR)}</div>
    <div class="num"></div>
  </div>`;
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
  const btn = document.getElementById('btn-nom-guardar');
  const textoOrig = btn.textContent;

  const fecha = document.getElementById('nom-fecha').value;
  const cuentaDestino = document.getElementById('nom-cuenta').value;
  const bruto = parseFloat(document.getElementById('nom-bruto').value) || 0;

  if (!fecha || !cuentaDestino || bruto <= 0) {
    mostrarToast('Completa fecha, cuenta y salario bruto');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  // Recolectar descuentos
  const descuentos = [];
  document.querySelectorAll('#nom-descuentos .nomina-linea').forEach(linea => {
    const inp = linea.querySelector('input[type="number"]');
    const valor = parseFloat(inp.value) || 0;
    if (valor <= 0) return;

    if (linea.dataset.grupo) {
      // Descuento fijo predefinido
      descuentos.push({ grupo: linea.dataset.grupo, sub: linea.dataset.sub, idsub: linea.dataset.idsub || '', valor });
    } else {
      // Descuento nuevo agregado
      const rubro = linea.querySelector('.rubro-nuevo')?.value || 'Otros egresos';
      descuentos.push({ grupo: 'Otros egresos', sub: rubro, idsub: '', valor });
    }
  });

  const totalDesc = descuentos.reduce((s, d) => s + d.valor, 0);
  const neto = bruto - totalDesc;

  mostrarSpinner(true);
  try {
    const baseId = Date.now();

    // ID estable del subgrupo del salario (se resuelve una vez)
    const gSalario = estado.grupos.find(x => x.subgrupo === 'ARUS salario neto');
    const idSalario = gSalario ? gSalario.idSubgrupo : '';

    // 1. Registrar ingreso bruto (entra a la cuenta)
    await escribirFila('Transacciones', [
      'TX' + baseId, fecha, 'Ingreso', 'Ingresos', 'ARUS salario neto',
      cuentaDestino, '', bruto, 'Salario bruto quincena', 'Nómina', 'TRUE', '', idSalario
    ]);

    // 2. Registrar cada descuento.
    //    Si el subgrupo apunta a una cuenta/producto (tiene Cuenta_Destino en
    //    Grupos) → se registra como Traslado a ese producto (ej. libranza → cuenta
    //    puente P22). Si no, como Egreso normal de la cuenta.
    let i = 1;
    for (const d of descuentos) {
      // Buscar el subgrupo por su ID estable (si la línea lo trae); si no
      // (descuento nuevo escrito a mano), caer al nombre como respaldo.
      const gDesc = d.idsub
        ? estado.grupos.find(x => x.idSubgrupo === d.idsub)
        : estado.grupos.find(x => x.grupo === d.grupo && x.subgrupo === d.sub);
      const ctaDestino = gDesc && gDesc.cuentaDestino ? gDesc.cuentaDestino : '';
      const idSub = gDesc ? gDesc.idSubgrupo : '';
      if (ctaDestino) {
        await escribirFila('Transacciones', [
          'TX' + (baseId + i), fecha, 'Traslado', d.grupo, d.sub,
          cuentaDestino, ctaDestino, d.valor, 'Descuento nómina', 'Nómina', 'TRUE', '', idSub
        ]);
      } else {
        await escribirFila('Transacciones', [
          'TX' + (baseId + i), fecha, 'Egreso', d.grupo, d.sub,
          cuentaDestino, '', d.valor, 'Descuento nómina', 'Nómina', 'TRUE', '', idSub
        ]);
      }
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
    btn.disabled = false; btn.textContent = textoOrig;
    mostrarToast('✓ Nómina registrada — neto: ' + fmt(neto));
    resetNomina();
    cambiarVista('dashboard');
  } catch(e) {
    mostrarSpinner(false);
    btn.disabled = false; btn.textContent = textoOrig;
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

  const btn = document.getElementById('btn-cierre-guardar');
  const textoOrig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Guardando...';

  mostrarSpinner(true);
  try {
    const filas = await leerHoja('Productos!A2:O');

    for (const a of actualizaciones) {
      // Para inversión: registrar el rendimiento como ingreso/pérdida.
      // CP (producto disponible) → subgrupo "Rendimientos financieros CP" (operativo, toca caja).
      // LP (producto no disponible) → subgrupo "Rendimientos financieros LP" (financiero,
      //    no toca caja; el motor lo reinvierte como aporte LP automáticamente).
      if (a.tipo === 'inversion' && Math.abs(a.rendimiento) > 0) {
        const prodInv = estado.productos.find(p => p.id === a.id);
        const esLP = prodInv && !prodInv.disponible;
        const subgrupoRend = esLP ? 'Rendimientos financieros LP' : 'Rendimientos financieros CP';
        const gRend = estado.grupos.find(x => x.subgrupo === subgrupoRend);
        await escribirFila('Transacciones', [
          'TX' + Date.now() + Math.floor(Math.random()*100),
          fechaCierre, 'Ingreso', 'Ingresos', subgrupoRend,
          a.id, '', a.rendimiento, `Rendimiento ${a.nombre} - cierre ${mes}`, 'Cierre', 'TRUE', '', gRend ? gRend.idSubgrupo : ''
        ]);
      }

      // Para cuenta con diferencia en modo "ajuste": registrar transacción de ajuste
      if (a.tipo === 'cuenta' && Math.abs(a.diferencia) >= 1 && modoDif === 'ajuste') {
        const esIngreso = a.diferencia > 0;
        const subAjuste = esIngreso ? 'Otros ingresos' : 'Ajuste de conciliación';
        const gAjuste = estado.grupos.find(x => x.subgrupo === subAjuste);
        await escribirFila('Transacciones', [
          'TX' + Date.now() + Math.floor(Math.random()*100),
          fechaCierre,
          esIngreso ? 'Ingreso' : 'Egreso',
          esIngreso ? 'Ingresos' : 'Otros egresos',
          subAjuste,
          a.id, '', Math.abs(a.diferencia),
          `Ajuste conciliación cierre ${mes}`, 'Cierre', 'TRUE', '', gAjuste ? gAjuste.idSubgrupo : ''
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
    btn.disabled = false; btn.textContent = textoOrig;
    mostrarToast(`✓ Mes ${mes} cerrado correctamente`);
    resetCierre();
    cambiarVista('dashboard');
  } catch(e) {
    mostrarSpinner(false);
    btn.disabled = false; btn.textContent = textoOrig;
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

  const filas = await leerHoja('Calendario_Deuda!A2:M');
  for (let i = 0; i < filas.length; i++) {
    const esDeEstaTC = filas[i][4] === tcId;          // col E = Producto
    const estaPendiente = filas[i][11] === 'Pendiente'; // col L = Estado
    const venc = filas[i][10] || '';                   // col K = Fecha_Vencimiento
    if (esDeEstaTC && estaPendiente && venc && venc <= limite) {
      await actualizarCelda(`Calendario_Deuda!L${i + 2}`, 'Pagada');
      await actualizarCelda(`Calendario_Deuda!M${i + 2}`, idTxPago);
    }
  }
}

// Deshace un abono: devuelve a 'Pendiente' las cuotas que fueron pagadas por ese traslado.
// Identifica las cuotas por el ID del abono guardado en la columna L (ID_Tx_Pago).
async function deshacerAbono(idTxAbono) {
  const filas = await leerHoja('Calendario_Deuda!A2:M');
  for (let i = 0; i < filas.length; i++) {
    // Columna M (índice 12) = ID_Tx_Pago; Columna L (índice 11) = Estado
    if (filas[i][12] === idTxAbono && filas[i][11] === 'Pagada') {
      await actualizarCelda(`Calendario_Deuda!L${i + 2}`, 'Pendiente');
      await actualizarCelda(`Calendario_Deuda!M${i + 2}`, '');
    }
  }
}

// Anula (no borra) las cuotas asociadas a una transacción, marcándolas como 'Anulada'.
// Conserva la fila para trazabilidad. Las cuotas anuladas no cuentan en "Vence este mes".
async function anularCuotasDeTx(idTx) {
  const filas = await leerHoja('Calendario_Deuda!A2:M');
  for (let i = 0; i < filas.length; i++) {
    // Columna C (índice 2) = ID_Tx; Columna L (índice 11) = Estado
    if (filas[i][2] === idTx && filas[i][11] !== 'Anulada') {
      await actualizarCelda(`Calendario_Deuda!L${i + 2}`, 'Anulada');
    }
  }
}

// ── MOTOR DE AMORTIZACIÓN ─────────────────────────────────────────────
// Convierte una tasa ingresada por el usuario a tasa MENSUAL EFECTIVA (decimal).
// tipoTasa: 'mensual' (efectiva mensual), 'ea' (efectiva anual), 'nmv' (nominal mes vencido).
// pct: el número tal cual lo escribe el usuario (ej. 28 para 28%, 1.41 para 1.41%).
function tasaMensualEfectiva(pct, tipoTasa) {
  const r = (parseFloat(pct) || 0) / 100;
  if (r <= 0) return 0;
  switch (tipoTasa) {
    case 'mensual': return r;                     // ya es mensual efectiva
    case 'ea':      return Math.pow(1 + r, 1 / 12) - 1; // efectiva anual → mensual
    case 'nmv':     return r / 12;                // nominal mes vencido → mensual
    default:        return r;                     // por defecto, tratar como mensual
  }
}

// Calcula una tabla de amortización FRANCESA (cuota fija) para un crédito.
// monto: capital dispuesto. n: número de cuotas. iMensual: tasa mensual efectiva (decimal).
// Devuelve un arreglo de n objetos { capital, interes }, redondeados a pesos.
// El ajuste por redondeo se aplica en la ÚLTIMA cuota de capital (Opción A),
// para que la suma de capitales cuadre EXACTO con el monto dispuesto.
function calcularAmortizacionFrancesa(monto, n, iMensual) {
  const cuotas = [];

  // Caso sin interés (tasa 0): capital parejo, interés 0.
  if (iMensual <= 0) {
    const capBase = Math.round(monto / n);
    let acumulado = 0;
    for (let k = 0; k < n; k++) {
      let capital = (k < n - 1) ? capBase : (monto - acumulado);
      acumulado += capital;
      cuotas.push({ capital: Math.round(capital), interes: 0 });
    }
    return cuotas;
  }

  // Cuota fija francesa: C = monto * i / (1 - (1+i)^-n)
  const factor = Math.pow(1 + iMensual, -n);
  const cuotaFija = monto * iMensual / (1 - factor);

  let saldo = monto;
  let capitalAcumulado = 0;

  for (let k = 0; k < n; k++) {
    const interes = Math.round(saldo * iMensual);
    let capital;
    if (k < n - 1) {
      capital = Math.round(cuotaFija) - interes;
      // Saldo real (sin redondear) para el cálculo del interés del mes siguiente
      saldo = saldo - (cuotaFija - (saldo * iMensual));
    } else {
      // Última cuota: el capital es todo lo que falta (cuadra al peso)
      capital = monto - capitalAcumulado;
    }
    capitalAcumulado += capital;
    cuotas.push({ capital: Math.round(capital), interes: interes });
  }

  return cuotas;
}

// Amortización ALEMANA (capital constante): se abona el mismo capital cada mes,
// y el interés se calcula sobre el saldo que va bajando → la cuota total decrece.
// Típico de TC en Colombia (avances, compras a cuotas, compra de cartera).
function calcularAmortizacionAlemana(monto, n, iMensual) {
  const cuotas = [];

  // Caso sin interés (tasa 0): capital parejo, interés 0 (igual que francés).
  if (iMensual <= 0) {
    const capBase = Math.round(monto / n);
    let acumulado = 0;
    for (let k = 0; k < n; k++) {
      let capital = (k < n - 1) ? capBase : (monto - acumulado);
      acumulado += capital;
      cuotas.push({ capital: Math.round(capital), interes: 0 });
    }
    return cuotas;
  }

  const capitalBase = monto / n;
  let saldo = monto;
  let capitalAcumulado = 0;

  for (let k = 0; k < n; k++) {
    const interes = Math.round(saldo * iMensual);
    let capital;
    if (k < n - 1) {
      capital = Math.round(capitalBase);
    } else {
      // Última cuota: cuadra el capital al peso (suma exacta = monto)
      capital = monto - capitalAcumulado;
    }
    capitalAcumulado += capital;
    saldo = saldo - capital;
    cuotas.push({ capital: Math.round(capital), interes: interes });
  }
  return cuotas;
}

// Normaliza el método de amortización leído de la hoja Productos.
// Tolerante a mayúsculas/tildes: "Alemán", "ALEMAN", "aleman" → 'aleman'.
// Cualquier otro valor (incluido vacío) → 'frances' (fallback seguro).
function normalizarMetodoAmortizacion(valor) {
  const v = (valor || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quita tildes
  return v === 'aleman' ? 'aleman' : 'frances';
}

// Normaliza el tipo de tasa leído de la hoja Productos (columna Tipo_Tasa).
// Tolerante a mayúsculas/tildes y a variantes comunes:
//   "Mensual", "mensual" → 'mensual'
//   "E.A.", "EA", "ea"   → 'ea'
//   "N.M.V.", "NMV"      → 'nmv'
// Cualquier otro valor (incluido vacío) → 'ea' (fallback: las tasas de crédito
// suelen publicarse como efectiva anual).
function normalizarTipoTasa(valor) {
  const v = (valor || '').toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita tildes
    .replace(/[.\s]/g, '');                           // quita puntos y espacios: "e.a." → "ea"
  if (v === 'mensual') return 'mensual';
  if (v === 'nmv') return 'nmv';
  return 'ea';
}

// Etiqueta legible del tipo de tasa, para los textos de ayuda del front.
function etiquetaTipoTasa(tipo) {
  switch (normalizarTipoTasa(tipo)) {
    case 'mensual': return 'mensual efectiva';
    case 'nmv':     return 'N.M.V. (nominal mes vencido)';
    default:        return 'E.A. (efectiva anual)';
  }
}

// DESPACHADOR: punto único de cálculo de tablas de amortización.
// Recibe el método (de la hoja Productos) y reparte al cálculo correcto.
// Lo usan TODOS los puntos que generan cuotas (Traslado y +Transacción),
// para tener un solo modelo de funcionamiento.
function calcularAmortizacion(monto, n, iMensual, metodo) {
  return normalizarMetodoAmortizacion(metodo) === 'aleman'
    ? calcularAmortizacionAlemana(monto, n, iMensual)
    : calcularAmortizacionFrancesa(monto, n, iMensual);
}

// Genera las cuotas en Calendario_Deuda para una DISPOSICIÓN (avance/uso de cupo).
// Calcula la tabla de amortización y reparte capital + interés cuota por cuota.
async function generarCuotasDisposicion(idTx, datos) {
  const totalCuotas = datos.numCuotas || 1;
  const iMensual = tasaMensualEfectiva(datos.tasaPct, datos.tasaTipo);

  const prod = estado.productos.find(p => p.id === datos.origen);
  // La tabla se calcula con el método del producto de origen (la TC/crédito desde
  // donde se dispone): alemán o francés según la hoja Productos. Modelo único.
  const tabla = calcularAmortizacion(datos.monto, totalCuotas, iMensual, prod ? prod.metodoAmortizacion : '');

  let primera = datos.primeraCuota
    || calcularPrimerVencimiento(prod, datos.fecha)
    || sumarUnMes(datos.fecha);

  const base = new Date(primera + 'T00:00:00');
  const diaCuota = base.getDate();
  const idCompra = 'DISP' + Date.now();

  for (let i = 0; i < totalCuotas; i++) {
    let mes = base.getMonth() + i;
    let anio = base.getFullYear() + Math.floor(mes / 12);
    mes = mes % 12;
    const ultimoDia = new Date(anio, mes + 1, 0).getDate();
    const dia = Math.min(diaCuota, ultimoDia);
    const fechaVenc = `${anio}-${String(mes + 1).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;

    const idCuota = `${idCompra}-${String(i + 1).padStart(2, '0')}`;
    await escribirFila('Calendario_Deuda', [
      idCuota, idCompra, idTx, 'TC', datos.origen, datos.descripcion,
      i + 1, totalCuotas, tabla[i].capital, tabla[i].interes, fechaVenc, 'Pendiente', ''
    ]);
  }
}

// Genera y escribe las filas de Cuotas_TC para una compra diferida (o de 1 cuota).
// idTx: ID de la transacción origen. datos: lo leído del formulario + info de cuotas.
async function generarCuotasTC(idTx, datos) {
  const prod = estado.productos.find(p => p.id === datos.producto);
  if (!prod) return;

  const totalCuotas = datos.numCuotas || 1;
  const idCompra = 'CMP' + Date.now();

  // Si la compra genera intereses, calculamos la tabla con el método del producto
  // (francés/alemán, leído de la hoja Productos). Si no, capital parejo e interés 0.
  let tabla;
  if (datos.conInteres && datos.tasaPct > 0) {
    const iMensual = tasaMensualEfectiva(datos.tasaPct, datos.tasaTipo);
    tabla = calcularAmortizacion(datos.monto, totalCuotas, iMensual, prod.metodoAmortizacion);
  } else {
    // Sin interés: reparto parejo (la última cuota cuadra el redondeo)
    tabla = calcularAmortizacion(datos.monto, totalCuotas, 0, prod.metodoAmortizacion);
  }

  // Fecha de la primera cuota: la que el usuario confirmó, o la calculada
  let primera = datos.primeraCuota || calcularPrimerVencimiento(prod, datos.fecha);
  if (!primera) {
    mostrarToast('⚠️ No se pudo determinar la fecha de la primera cuota');
    return;
  }

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
    await escribirFila('Calendario_Deuda', [
      idCuota, idCompra, idTx, 'TC', datos.producto, datos.descripcion,
      i + 1, totalCuotas, tabla[i].capital, tabla[i].interes, fechaVenc, 'Pendiente', ''
    ]);
  }
}

// Suma un mes a una fecha 'YYYY-MM-DD', cuidando meses cortos. Para productos sin corte fijo.
function sumarUnMes(fechaStr) {
  const f = new Date(fechaStr + 'T00:00:00');
  const dia = f.getDate();
  let mes = f.getMonth() + 1;
  let anio = f.getFullYear();
  if (mes > 11) { mes -= 12; anio += 1; }
  const ultimoDia = new Date(anio, mes + 1, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDia);
  return `${anio}-${String(mes + 1).padStart(2, '0')}-${String(diaFinal).padStart(2, '0')}`;
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

// ══════════════════════════════════════════════════════════════════════
// MOTOR DE LOS DOS FLUJOS (Tema 7.0) — operativo + financiero
// Pura lógica de cálculo; no toca la pantalla. Una sola fuente de verdad:
// operativo desde estado.presupuesto, financiero desde estado.cuotasTC.
// ══════════════════════════════════════════════════════════════════════

// Devuelve el FLUJO OPERATIVO de un mes (YYYY-MM) desde la hoja Presupuesto.
// Estructura: { ingresos, egresos, neto, grupos: { nombreGrupo: { tipo, subgrupos: {sub: monto}, total } } }
function calcularFlujoOperativo(mesYYYYMM) {
  const res = { ingresos: 0, egresos: 0, neto: 0,
                ingresosReal: 0, egresosReal: 0, netoReal: 0, grupos: {} };

  // 1. Presupuestado (desde hoja Presupuesto)
  if (estado.presupuesto) {
    estado.presupuesto.forEach(p => {
      if (!p.fecha || p.fecha.substring(0, 7) !== mesYYYYMM) return;
      const tipo = (p.tipo || '').toLowerCase();
      const esIngreso = tipo.includes('ingreso');
      const esEgreso = tipo.includes('egreso') || tipo.includes('gasto');
      if (!esIngreso && !esEgreso) return;

      const grupo = p.grupo || 'Sin grupo';
      const sub = p.subgrupo || 'Sin subgrupo';
      if (!res.grupos[grupo]) res.grupos[grupo] = { tipo: esIngreso ? 'ingreso' : 'egreso', subgrupos: {}, total: 0, totalReal: 0 };
      if (!res.grupos[grupo].subgrupos[sub]) res.grupos[grupo].subgrupos[sub] = { ppto: 0, real: 0 };
      res.grupos[grupo].subgrupos[sub].ppto += p.monto;
      res.grupos[grupo].total += p.monto;

      if (esIngreso) res.ingresos += p.monto;
      else res.egresos += p.monto;
    });
  }

  // 2. Real (desde Transacciones: solo Ingreso/Egreso, no traslados)
  if (estado.transacciones) {
    estado.transacciones.forEach(t => {
      if (!t.fecha || t.fecha.substring(0, 7) !== mesYYYYMM) return;
      if (t.tipo !== 'Ingreso' && t.tipo !== 'Egreso') return;
      const esIngreso = t.tipo === 'Ingreso';

      const grupo = t.grupo || 'Sin grupo';
      const sub = t.subgrupo || 'Sin subgrupo';
      if (!res.grupos[grupo]) res.grupos[grupo] = { tipo: esIngreso ? 'ingreso' : 'egreso', subgrupos: {}, total: 0, totalReal: 0 };
      if (!res.grupos[grupo].subgrupos[sub]) res.grupos[grupo].subgrupos[sub] = { ppto: 0, real: 0 };
      res.grupos[grupo].subgrupos[sub].real += t.monto;
      res.grupos[grupo].totalReal += t.monto;

      if (esIngreso) res.ingresosReal += t.monto;
      else res.egresosReal += t.monto;
    });
  }

  res.neto = res.ingresos - res.egresos;
  res.netoReal = res.ingresosReal - res.egresosReal;
  return res;
}

// Devuelve el FLUJO FINANCIERO de un mes (YYYY-MM) desde Calendario_Deuda.
// Tres bloques: nuevosCreditos (entra caja), abonoCapital (sale caja, no es gasto),
// costoFinanciero (intereses, sí es gasto). El neto financiero es lo que sale de caja.
function calcularFlujoFinanciero(mesYYYYMM) {
  const res = {
    nuevosCreditos: 0,
    abonoCapital: 0,
    costoFinanciero: 0,
    neto: 0,
    detalle: { TC: { capital: 0, interes: 0 }, Credito: { capital: 0, interes: 0 } },
    // Aportes a inversión LP (sale caja, NO es gasto — espejo del abono a capital)
    // y retiros de inversión LP (entra caja — espejo del nuevo crédito).
    aportesLP: 0,
    retirosLP: 0,
    // Real (ejecutado desde Transacciones)
    abonoCapitalReal: 0,
    costoFinancieroReal: 0,
    nuevosCreditosReal: 0,
    aportesLPReal: 0,
    retirosLPReal: 0,
    rendimientoLPReal: 0,
    netoReal: 0
  };

  // 1. PROYECTADO: el desembolso TOTAL de deuda que vence este mes según
  // Calendario_Deuda. Cuenta cuotas Pendiente Y Pagada (todas las que vencen
  // el mes), para que la proyección no se infle a medida que se pagan cuotas
  // durante el mes en curso. Las Anuladas no cuentan.
  // EXCEPCIÓN (idea 2): una compra a UNA cuota SIN interés cuyo mes de compra
  // es el MISMO mes en que vence ya está reflejada en el flujo OPERATIVO de ese
  // mes (es una compra al contado con TC de paso). Contarla aquí también sería
  // doble conteo, así que se excluye. Si el mes de compra es ANTERIOR al de
  // vencimiento (compra de un mes que se paga al siguiente), SÍ cuenta: esa
  // salida de caja no está en el operativo del mes de vencimiento.
  if (estado.cuotasTC) {
    estado.cuotasTC.forEach(c => {
      if (c.estado === 'Anulada' || !c.fechaVencimiento) return;
      if (c.fechaVencimiento.substring(0, 7) !== mesYYYYMM) return;

      const capital = c.capitalCuota || 0;
      const interes = c.interesCuota || 0;

      // Exclusión idea 2: compra a 1 cuota, sin interés, comprada el mismo mes
      // en que vence → ya está en el operativo → no contar en el financiero.
      const esUnaCuotaSinInteres = (c.totalCuotas || 0) <= 1 && interes === 0;
      const mesCompra = (c.fechaCompra || '').substring(0, 7);
      const mismoMes = mesCompra && mesCompra === mesYYYYMM;
      if (esUnaCuotaSinInteres && mismoMes) return;

      res.abonoCapital += capital;
      res.costoFinanciero += interes;

      const tipo = (c.tipoOrigen || 'TC') === 'Crédito' ? 'Credito' : 'TC';
      res.detalle[tipo].capital += capital;
      res.detalle[tipo].interes += interes;
    });
  }
  res.neto = res.nuevosCreditos - res.abonoCapital - res.costoFinanciero;

  // 2. REAL: lo ejecutado este mes desde Transacciones
  if (estado.transacciones && estado.productos) {
    // IDs de productos que son deuda (TC o crédito)
    const idsDeuda = estado.productos
      .filter(p => {
        const t = (p.tipo || '').toLowerCase();
        return t.includes('crédito') || t.includes('credito') ||
               t.includes('hipotec') || t.includes('libranza') || t.includes('pasivo');
      })
      .map(p => p.id);

    // IDs de productos de inversión de largo plazo (tipo "Inversión LP" + no disponible).
    // Reciben aportes desde la caja (P15 Cesantías, P16 FondoSura, P19 XTB).
    const idsInversionLP = estado.productos
      .filter(p => {
        const t = (p.tipo || '').toLowerCase();
        return !p.disponible && (t.includes('inversión') || t.includes('inversion'));
      })
      .map(p => p.id);

    estado.transacciones.forEach(t => {
      if (!t.fecha || t.fecha.substring(0, 7) !== mesYYYYMM) return;

      const origenEsDeuda = idsDeuda.includes(t.origen);
      const destinoEsDeuda = idsDeuda.includes(t.destino);
      const origenEsLP = idsInversionLP.includes(t.origen);
      const destinoEsLP = idsInversionLP.includes(t.destino);

      // Abono a capital real: traslado cuyo destino es un producto de deuda
      // (y el origen NO es deuda, para no contar traslados entre deudas)
      if (t.tipo === 'Traslado' && destinoEsDeuda && !origenEsDeuda) {
        res.abonoCapitalReal += t.monto;
      }

      // Nuevo crédito real: traslado cuyo ORIGEN es un producto de deuda
      // (disposición/avance: la TC/Crediágil financia una cuenta de caja)
      if (t.tipo === 'Traslado' && origenEsDeuda && !destinoEsDeuda) {
        res.nuevosCreditosReal += t.monto;
      }

      // --- INVERSIÓN LP ---
      // Principio: cualquier plata que ENTRA a un producto Inversión LP genera
      // "Aporte inversión LP"; cualquier plata que SALE de él genera "Retiro inversión LP".
      // La entrada puede venir como Traslado (campo destino) o como Ingreso (el producto
      // queda en el campo origen). La salida, como Traslado (origen) o Egreso (origen).

      // Aporte LP: traslado con DESTINO un fondo LP (origen no LP),
      // o un INGRESO cuyo producto (en origen) es un fondo LP.
      if (t.tipo === 'Traslado' && destinoEsLP && !origenEsLP) {
        res.aportesLPReal += t.monto;
      } else if (t.tipo === 'Ingreso' && origenEsLP) {
        res.aportesLPReal += t.monto;
      }

      // Retiro LP: traslado con ORIGEN un fondo LP (destino no LP),
      // o un EGRESO cuyo producto (en origen) es un fondo LP.
      if (t.tipo === 'Traslado' && origenEsLP && !destinoEsLP) {
        res.retirosLPReal += t.monto;
      } else if (t.tipo === 'Egreso' && origenEsLP) {
        res.retirosLPReal += t.monto;
      }

      // Costo financiero real: transacción con subgrupo marcado Es_Costo_Financiero
      const g = estado.grupos.find(x => x.grupo === t.grupo && x.subgrupo === t.subgrupo);
      if (g && g.esCostoFinanciero) {
        res.costoFinancieroReal += t.monto;
      }

      // Rendimiento LP real: ingreso con subgrupo marcado Es_Rendimiento_LP.
      // Se muestra en el financiero (no en operativo). Su contrapartida de aporte
      // ya quedó contada arriba (el rendimiento entra a un producto LP).
      if (g && g.esRendimientoLP) {
        res.rendimientoLPReal += t.monto;
      }
    });
  }
  res.netoReal = res.nuevosCreditosReal + res.retirosLPReal
               - res.abonoCapitalReal - res.costoFinancieroReal - res.aportesLPReal;

  return res;
}

// Une los dos flujos de un mes en una sola foto.
function calcularFlujosMes(mesYYYYMM) {
  const operativo = calcularFlujoOperativo(mesYYYYMM);
  const financiero = calcularFlujoFinanciero(mesYYYYMM);
  return {
    mes: mesYYYYMM,
    operativo,
    financiero,
    flujoNeto: operativo.neto + financiero.neto,           // proyectado
    flujoNetoReal: operativo.netoReal + financiero.netoReal // real
  };
}

// ══════════════════════════════════════════════════════════════════════
// MOTOR DE PROYECCIÓN DE CAJA 12 MESES (Tema 7.0, paso 4B) — "la ola"
// Encadena el saldo de caja mes a mes: saldo inicial + flujo neto de cada mes.
// Operativo: presupuestado (la proyección usa el plan, no el real).
// Financiero: proyectado desde Calendario_Deuda (lo que vence).
// ══════════════════════════════════════════════════════════════════════
function calcularProyeccionCaja(numMeses = 12) {
  // 1. Saldo de partida = caja disponible actual (Ahorros + Inversión líquida)
  const saldoPartida = estado.productos
    .filter(p => p.disponible && p.saldoActual >= 0)
    .reduce((s, p) => s + p.saldoActual, 0);

  // 2. Mes de arranque = mes corriente
  const hoy = new Date();
  let anio = hoy.getFullYear();
  let mes = hoy.getMonth(); // 0-11

  const meses = [];
  let saldoAcumulado = saldoPartida;

  for (let i = 0; i < numMeses; i++) {
    const mesYYYYMM = `${anio}-${String(mes + 1).padStart(2, '0')}`;

    const operativo = calcularFlujoOperativo(mesYYYYMM);
    const financiero = calcularFlujoFinanciero(mesYYYYMM);

    // La proyección usa SIEMPRE el presupuestado (plan), también el mes corriente.
    const flujoOperativo = operativo.neto;          // presupuestado
    const flujoFinanciero = financiero.neto;        // proyectado (Calendario_Deuda)
    const flujoNeto = flujoOperativo + flujoFinanciero;

    const saldoInicialMes = saldoAcumulado;
    saldoAcumulado += flujoNeto;

    // Desembolso total de deuda del mes (capital + interés) = la barra de la ola
    const olaDesembolso = financiero.abonoCapital + financiero.costoFinanciero;

    meses.push({
      mes: mesYYYYMM,
      saldoInicial: saldoInicialMes,
      operativo: flujoOperativo,
      financiero: flujoFinanciero,
      flujoNeto: flujoNeto,
      saldoFinal: saldoAcumulado,
      olaDesembolso: olaDesembolso,
      enRojo: saldoAcumulado < 0
    });

    // Avanzar al siguiente mes
    mes++;
    if (mes > 11) { mes = 0; anio++; }
  }

  return { saldoPartida, meses };
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
