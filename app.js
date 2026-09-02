import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.102.0/+esm';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');
const config = window.HOLA_CONFIG || {};
const MADRID_TZ = config.timezone || 'Europe/Madrid';
const KIOSK_STORAGE = 'holaSevillaKioskV1';
const LANG_STORAGE = 'holaSevillaLanguage';
const FUNCTION_RELEASES = {
  'admin-api': '2026.09.02.2',
  'kiosk-punch': '2026.09.02.1',
  'gps-punch': '2026.09.02.2',
};
const SCHEDULE_START_MONTH = '2026-09';
const REQUEST_TIMEOUT_MS = 20_000;
const configured = /^https:\/\/[^/]+\.supabase\.co$/.test(config.supabaseUrl || '')
  && String(config.supabasePublishableKey || '').startsWith('sb_publishable_');

const client = configured
  ? createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const state = {
  lang: localStorage.getItem(LANG_STORAGE) || (navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'es'),
  entry: 'employee',
  session: null,
  profile: null,
  view: 'home',
  data: {},
  kiosk: readJSON(KIOSK_STORAGE, null),
  kioskEmployees: [],
  kioskStore: null,
  kioskSelected: null,
  kioskSuccess: null,
  health: null,
  busy: false,
  scheduleMonth: null,
  scheduleEmployeeId: null,
};

let kioskResetTimer;

function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function L(zh, es) { return state.lang === 'zh' ? zh : es; }
function setLang(lang) {
  state.lang = lang === 'zh' ? 'zh' : 'es';
  localStorage.setItem(LANG_STORAGE, state.lang);
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'es';
  renderCurrent();
}

let toastTimer;
function toast(message, error = false) {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = message;
  element.style.background = error ? '#8f332f' : '#15221e';
  element.classList.add('show');
  toastTimer = setTimeout(() => element.classList.remove('show'), 3200);
}

function errorText(error) {
  const code = String(error?.code || error?.message || error?.error || error || 'UNKNOWN_ERROR');
  const messages = {
    INVALID_LOGIN_CREDENTIALS: L('手机号或密码不正确', 'Teléfono o contraseña incorrectos'),
    INVALID_PHONE: L('手机号格式不正确，请填写完整号码，例如 +34 600 000 000', 'El teléfono no es válido. Usa el formato completo, por ejemplo +34 600 000 000'),
    INVALID_PIN: L('个人PIN不正确', 'PIN personal incorrecto'),
    PIN_MUST_BE_6_DIGITS: L('PIN必须是6位数字', 'El PIN debe tener 6 cifras'),
    PIN_NOT_CONFIGURED: L('该员工尚未设置PIN，请由VIVI重设PIN', 'Este empleado no tiene PIN. VIVI debe restablecerlo'),
    PIN_TEMPORARILY_LOCKED: L('PIN错误次数过多，请15分钟后重试', 'Demasiados intentos. Prueba en 15 minutos'),
    NOT_ASSIGNED_TO_THIS_STORE: L('你今天未被安排在此店', 'Hoy no estás asignado a esta tienda'),
    INVALID_EVENT_SEQUENCE: L('打卡顺序不正确，请刷新后重试', 'Secuencia de fichaje incorrecta'),
    INVALID_INPUT: L('填写的信息不完整或格式不正确', 'Faltan datos o el formato no es válido'),
    INVALID_TIME_RANGE: L('结束时间必须晚于开始时间', 'La hora final debe ser posterior a la inicial'),
    INVALID_WORKDATE: L('日期格式不正确，请重新选择日期', 'La fecha no es válida. Selecciónala de nuevo'),
    INVALID_SCHEDULE_TIME: L('排班结束时间必须晚于开始时间', 'El fin del turno debe ser posterior al inicio'),
    INVALID_MONTH: L('请选择有效的排班月份', 'Selecciona un mes válido'),
    INVALID_WEEK_PATTERN: L('请检查一周模板，每个工作日都要填写正确的店铺和时间', 'Revisa la plantilla semanal: cada día laborable necesita tienda y horario válidos'),
    NO_SCHEDULE_TODAY: L('今天没有已发布的排班，不能使用手机打卡', 'No hay horario publicado para hoy. No puedes fichar con el móvil'),
    SCHEDULE_DAY_OFF: L('今天是排班休息日，不能打卡', 'Hoy es día libre según el horario. No puedes fichar'),
    INVALID_CORRECTION: L('请至少填写一个有效的修正时间', 'Indica al menos una hora válida para corregir'),
    NO_GPS_PERMISSION: L('当前没有有效的手机GPS打卡授权', 'No tienes autorización GPS vigente'),
    NO_ALLOWED_EVENTS: L('请至少选择一种允许的GPS打卡动作', 'Selecciona al menos un tipo de fichaje GPS'),
    OUTSIDE_AUTHORIZED_AREA: L('当前位置距离排班店铺超过100米，不能打卡', 'Estás a más de 100 metros de la tienda asignada. No puedes fichar'),
    LOCATION_NOT_ACCURATE_ENOUGH: L('定位精度不足，请到开阔位置重试', 'La ubicación no es suficientemente precisa'),
    LOCATION_PERMISSION_DENIED: L('浏览器没有定位权限，请在地址栏允许位置权限', 'El navegador no tiene permiso de ubicación. Actívalo en la barra de direcciones'),
    LOCATION_UNAVAILABLE: L('暂时无法取得准确位置，请打开手机定位后重试', 'No se pudo obtener la ubicación. Activa el GPS e inténtalo de nuevo'),
    STORE_GPS_NOT_CONFIGURED: L('VIVI尚未配置该店GPS坐标', 'La tienda todavía no tiene coordenadas GPS'),
    STORE_NOT_FOUND: L('店铺不存在，请刷新后重试', 'La tienda no existe. Actualiza e inténtalo de nuevo'),
    STORE_NOT_ACTIVE: L('该店铺已停用，不能执行此操作', 'La tienda está desactivada'),
    EMPLOYEE_DISABLED: L('账号已停用，请联系VIVI', 'Cuenta desactivada. Contacta con VIVI'),
    EMPLOYEE_NOT_ACTIVE: L('该员工不存在或已停用', 'El empleado no existe o está desactivado'),
    DELETE_REQUIRES_DEACTIVATION: L('请先停用该员工，再删除误建账号', 'Desactiva primero al empleado antes de eliminar la cuenta errónea'),
    EMPLOYEE_HAS_RECORDS: L('该员工已有排班、打卡、GPS授权、申请或修正记录，只能停用，不能删除', 'Este empleado ya tiene registros. Solo se puede desactivar, no eliminar'),
    EMPLOYEE_NOT_FOUND: L('员工账号不存在，可能已被删除', 'La cuenta no existe o ya fue eliminada'),
    EMPLOYEE_DELETE_FAILED: L('账号删除失败，请确认该员工没有任何正式记录', 'No se pudo eliminar. Comprueba que no tenga registros oficiales'),
    DEVICE_DISABLED: L('此店铺电脑未授权或已停用', 'Este ordenador no está autorizado'),
    DEVICE_DENIED: L('此电脑凭证不正确，请由VIVI重新绑定', 'La credencial de este ordenador no es válida. VIVI debe vincularlo de nuevo'),
    DEVICE_REQUIRED: L('此电脑尚未绑定店铺', 'Este ordenador todavía no está vinculado'),
    REQUEST_ALREADY_REVIEWED: L('该申请已处理，请刷新查看最新状态', 'La solicitud ya fue revisada. Actualiza para ver el estado'),
    RECORD_NOT_FOUND: L('记录不存在或已发生变化，请刷新后重试', 'El registro no existe o ha cambiado. Actualiza e inténtalo de nuevo'),
    UNAUTHENTICATED: L('登录已过期，请重新登录', 'La sesión ha caducado. Inicia sesión de nuevo'),
    SESSION_EXPIRED: L('登录已过期，请重新登录', 'La sesión ha caducado. Inicia sesión de nuevo'),
    FORBIDDEN: L('当前账号没有执行此操作的权限', 'Esta cuenta no tiene permiso para realizar esta acción'),
    NETWORK_ERROR: L('无法连接服务器，请检查网络后重试', 'No se pudo conectar con el servidor. Comprueba la red'),
    REQUEST_TIMEOUT: L('服务器响应超时，请稍后重试', 'El servidor tardó demasiado. Inténtalo de nuevo'),
    INVALID_SERVER_RESPONSE: L('服务器返回异常，请刷新后重试', 'Respuesta no válida del servidor. Actualiza e inténtalo de nuevo'),
    DATA_LOAD_FAILED: L('数据加载失败，请检查网络并刷新', 'No se pudieron cargar los datos. Comprueba la red y actualiza'),
    OPERATION_FAILED: L('操作未完成，请刷新后重试', 'La operación no se completó. Actualiza e inténtalo de nuevo'),
  };
  const normalized = code.toUpperCase().replace(/\s+/g, '_');
  if (messages[normalized]) return messages[normalized];
  if (/FAILED TO (SEND|FETCH)|FAILED TO FETCH|NETWORK|LOAD FAILED/i.test(code)) return messages.NETWORK_ERROR;
  if (/JWT|TOKEN.*EXPIRED|SESSION.*EXPIRED/i.test(code)) return messages.SESSION_EXPIRED;
  if (/DUPLICATE|ALREADY (REGISTERED|EXISTS)|UNIQUE CONSTRAINT/i.test(code)) return L('手机号已存在，请检查是否重复创建', 'El teléfono ya existe. Comprueba si la cuenta está duplicada');
  if (normalized.startsWith('INVALID_')) return messages.INVALID_INPUT;
  console.error('Unhandled application error:', error);
  return messages.OPERATION_FAILED;
}

function normalizedErrorCode(error) {
  return String(error?.code || error?.message || error?.error || error || 'UNKNOWN_ERROR').toUpperCase().replace(/\s+/g, '_');
}

function forgetKioskIfInvalid(error) {
  const code = normalizedErrorCode(error);
  if (!['DEVICE_DISABLED', 'DEVICE_DENIED', 'DEVICE_REQUIRED'].includes(code)) return false;
  localStorage.removeItem(KIOSK_STORAGE);
  state.kiosk = null;
  return true;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 9) digits = `34${digits}`;
  return digits ? `+${digits}` : '';
}

function loginEmailFromPhone(value) {
  const digits = normalizePhone(value).replace(/\D/g, '');
  return `p${digits}@attendance.invalid`;
}

function madridDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MADRID_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function madridDisplay(date = new Date(), withSeconds = false) {
  return new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'es-ES', {
    timeZone: MADRID_TZ,
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    ...(withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : {}),
  }).format(date);
}

function timeText(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-ES', { timeZone: MADRID_TZ, hour: '2-digit', minute: '2-digit' }).format(date);
}

function dateText(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'es-ES', {
    timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short',
  }).format(date);
}

function shiftDurationText(item) {
  if (!item?.clock_in || !item?.clock_out) return '—';
  const minutes = Math.max(0, Math.round((new Date(item.clock_out) - new Date(item.clock_in)) / 60000));
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function breakDurationText(item) {
  if (!item?.break_start || !item?.break_end) return '0m';
  const minutes = Math.max(0, Math.round((new Date(item.break_end) - new Date(item.break_start)) / 60000));
  return `${minutes}m`;
}

function addDays(dateString, amount) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthLastDate(monthString) {
  const [year, month] = String(monthString).split('-').map(Number);
  if (!year || month < 1 || month > 12) return '';
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function currentScheduleMonth() {
  const current = madridDate().slice(0, 7);
  return state.scheduleMonth || (current < SCHEDULE_START_MONTH ? SCHEDULE_START_MONTH : current);
}

function madridTimeValue(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: MADRID_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}

function madridLocalToIso(dateString, timeString) {
  const [year, month, day] = dateString.split('-').map(Number);
  const [hour, minute] = timeString.split(':').map(Number);
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let count = 0; count < 3; count += 1) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: MADRID_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    guess += Date.UTC(year, month - 1, day, hour, minute) - represented;
  }
  return new Date(guess).toISOString();
}

function languageButton() {
  return `<button class="language-btn" id="languageToggle" type="button">${state.lang === 'zh' ? 'ES' : '中文'}</button>`;
}

function renderConfigurationError() {
  app.innerHTML = `<main class="setup-page"><section class="setup-card">
    <span class="brand-mark">H</span><p class="eyebrow">CONFIGURATION REQUIRED</p>
    <h1>${L('等待连接新项目', 'Falta conectar el nuevo proyecto')}</h1>
    <p>${L('请先在 config.js 中填写新的 Supabase Project URL 和 sb_publishable 公钥。不要填写任何管理员密钥。', 'Añade en config.js la URL del nuevo proyecto y su clave sb_publishable. Nunca añadas una clave de administrador.')}</p>
    <div class="callout warning"><b>${L('安全', 'Seguridad')}</b><span>${L('service_role、sb_secret 和数据库密码只能保存在服务器端。', 'service_role, sb_secret y la contraseña de base de datos son solo para el servidor.')}</span></div>
  </section></main>`;
}

function renderAuth() {
  const kioskReady = Boolean(state.kiosk?.deviceId && state.kiosk?.deviceSecret);
  app.innerHTML = `<main class="auth-shell">
    <section class="auth-story">
      <div class="brand-lockup"><span class="brand-mark">H</span><span><b>HOLA!SEVILLA</b><small>CONTROL HORARIO OFICIAL</small></span></div>
      <div><p class="eyebrow">NOVAKEEPS S.L.</p><h1>${L('每一次到岗，清楚记录。', 'Cada jornada, claramente registrada.')}</h1><p>${L('四店统一排班、考勤、申请与审计。员工手机可在当天排班店铺100米内定位打卡，跨店等特殊情况由VIVI临时授权。', 'Horarios, fichajes, solicitudes y auditoría para las cuatro tiendas. El móvil permite fichar a menos de 100 m de la tienda asignada; las excepciones requieren autorización de VIVI.')}</p></div>
      <div class="auth-facts"><div><b>4</b><span>${L('家店铺', 'tiendas')}</span></div><div><b>20'</b><span>${L('休息', 'descanso')}</span></div><div><b>7h</b><span>${L('每日班次', 'jornada')}</span></div></div>
    </section>
    <section class="auth-panel">
      <div class="top-actions" style="justify-content:flex-end;margin-bottom:24px">${languageButton()}</div>
      <p class="eyebrow">ACCESS / ACCESO</p><h2>${L('选择使用方式', 'Elige cómo acceder')}</h2>
      <p>${L('员工手机、店铺固定电脑和VIVI管理后台使用不同权限。', 'El móvil del empleado, el ordenador de tienda y el panel de VIVI tienen permisos distintos.')}</p>
      <div class="entry-tabs">
        <button type="button" data-entry="employee" class="${state.entry === 'employee' ? 'active' : ''}">${L('员工手机', 'Empleado')}</button>
        <button type="button" data-entry="kiosk" class="${state.entry === 'kiosk' ? 'active' : ''}">${L('店铺电脑', 'Ordenador')}</button>
        <button type="button" data-entry="manager" class="${state.entry === 'manager' ? 'active' : ''}">VIVI</button>
      </div>
      <div id="entryContent">
        ${state.entry === 'kiosk' ? renderKioskEntry(kioskReady) : renderLoginForm(state.entry)}
      </div>
      <p class="form-status" id="authStatus"></p>
    </section>
  </main>`;
  bindAuth();
}

function renderLoginForm(role) {
  return `<form id="loginForm" class="stack-form" data-role="${role}">
    <label>${L('手机号', 'Teléfono')}<input id="loginPhone" type="tel" placeholder="+34 600 000 000" required autocomplete="username"></label>
    <label>${L('登录密码', 'Contraseña')}<input id="loginPassword" type="password" minlength="8" required autocomplete="current-password"></label>
    <button class="primary-btn" type="submit">${role === 'manager' ? L('进入四店管理后台', 'Entrar al panel de VIVI') : L('登录查看我的信息', 'Entrar a mi cuenta')}</button>
    <div class="callout"><b>${L('说明', 'Nota')}</b><span>${role === 'manager' ? L('只有VIVI管理员账号可以进入。', 'Solo puede acceder la cuenta administradora de VIVI.') : L('手机可查看排班和申请，也可在当天排班店铺100米内定位打卡。', 'Puedes consultar horarios y solicitudes y fichar con ubicación a menos de 100 m de la tienda asignada.')}</span></div>
  </form>`;
}

function renderKioskEntry(ready) {
  if (ready) {
    return `<div class="stack-form"><div class="callout"><b>${L('已配置', 'Configurado')}</b><span>${escapeHTML(state.kiosk.storeName || L('店铺电脑', 'Ordenador de tienda'))}</span></div>
      <button class="primary-btn" id="openKiosk" type="button">${L('打开固定打卡界面', 'Abrir pantalla de fichaje')}</button>
      <button class="ghost-btn" id="clearKiosk" type="button">${L('解除此电脑配置', 'Quitar configuración')}</button></div>`;
  }
  return `<form id="kioskManagerLogin" class="stack-form">
    <p class="muted">${L('第一次需要VIVI在这台店铺电脑上登录并绑定店铺。绑定后员工只需选择姓名并输入6位PIN。', 'La primera vez VIVI debe iniciar sesión y vincular este ordenador a una tienda. Después el empleado solo elige su nombre e introduce su PIN de 6 cifras.')}</p>
    <label>${L('VIVI手机号', 'Teléfono de VIVI')}<input id="kioskManagerPhone" type="tel" required></label>
    <label>${L('VIVI登录密码', 'Contraseña de VIVI')}<input id="kioskManagerPassword" type="password" minlength="8" required></label>
    <button class="primary-btn" type="submit">${L('验证并配置此电脑', 'Verificar y configurar')}</button>
  </form>`;
}

function bindAuth() {
  $('#languageToggle')?.addEventListener('click', () => setLang(state.lang === 'zh' ? 'es' : 'zh'));
  $$('[data-entry]').forEach((button) => button.addEventListener('click', () => {
    state.entry = button.dataset.entry;
    renderAuth();
  }));
  $('#loginForm')?.addEventListener('submit', login);
  $('#openKiosk')?.addEventListener('click', () => openKiosk());
  $('#clearKiosk')?.addEventListener('click', () => {
    if (!confirm(L('确定解除这台电脑的店铺绑定？', '¿Quitar la vinculación de este ordenador?'))) return;
    localStorage.removeItem(KIOSK_STORAGE); state.kiosk = null; renderAuth();
  });
  $('#kioskManagerLogin')?.addEventListener('submit', startKioskConfiguration);
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const desiredRole = form.dataset.role;
  const status = $('#authStatus');
  status.textContent = L('正在登录…', 'Iniciando sesión…');
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: loginEmailFromPhone($('#loginPhone').value),
      password: $('#loginPassword').value,
    });
    if (error) throw error;
    const profile = await loadProfile(data.user.id);
    if (!profile || !profile.active || (desiredRole === 'manager' && profile.role !== 'manager') || (desiredRole === 'employee' && profile.role !== 'employee')) {
      await client.auth.signOut();
      status.textContent = desiredRole === 'manager' ? L('此账号不是VIVI管理员', 'Esta cuenta no es administradora') : L('此账号不是员工账号', 'Esta cuenta no es de empleado');
      return;
    }
    state.session = data.session; state.profile = profile; state.view = 'home';
    await loadPortalData(); renderPortal();
  } catch (error) {
    if (state.profile) {
      state.session = null; state.profile = null; state.data = {};
      await client.auth.signOut().catch(() => {});
    }
    status.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
}

async function loadProfile(userId) {
  const { data, error } = await client.from('profiles').select('*, stores(id,name,address)').eq('user_id', userId).single();
  if (error) {
    console.error('Profile load failed:', error);
    throw new Error('DATA_LOAD_FAILED');
  }
  return data;
}

async function startKioskConfiguration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const status = $('#authStatus');
  status.textContent = L('正在验证VIVI身份…', 'Verificando a VIVI…');
  try {
    const { data, error } = await client.auth.signInWithPassword({
      email: loginEmailFromPhone($('#kioskManagerPhone').value),
      password: $('#kioskManagerPassword').value,
    });
    if (error) throw error;
    const profile = await loadProfile(data.user.id);
    if (profile?.role !== 'manager' || !profile.active) {
      await client.auth.signOut(); status.textContent = L('只有VIVI可以配置店铺电脑', 'Solo VIVI puede configurar el ordenador'); return;
    }
    const { data: stores, error: storeError } = await client.from('stores').select('*').eq('active', true).order('name');
    if (storeError) throw new Error('DATA_LOAD_FAILED');
    if (!stores?.length) throw new Error('STORE_NOT_FOUND');
    $('#entryContent').innerHTML = `<form id="finishKioskSetup" class="stack-form">
      <label>${L('绑定店铺', 'Tienda vinculada')}<select id="kioskStore">${stores.map((store) => `<option value="${store.id}">${escapeHTML(store.name)}</option>`).join('')}</select></label>
      <label>${L('电脑名称', 'Nombre del ordenador')}<input id="kioskName" value="${L('店铺收银电脑', 'Ordenador de caja')}" required minlength="2"></label>
      <button class="primary-btn" type="submit">${L('完成绑定', 'Completar vinculación')}</button>
    </form>`;
    $('#finishKioskSetup').addEventListener('submit', finishKioskConfiguration);
    status.textContent = '';
  } catch (error) {
    await client.auth.signOut().catch(() => {});
    state.session = null;
    state.profile = null;
    status.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
}

async function finishKioskConfiguration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  const status = $('#authStatus');
  status.textContent = L('正在生成此电脑的独立凭证…', 'Creando credencial del ordenador…');
  try {
    const storeId = $('#kioskStore').value;
    const result = await adminAction({ action: 'create_kiosk', storeId, name: $('#kioskName').value });
    const { data: store } = await client.from('stores').select('name').eq('id', storeId).maybeSingle();
    state.kiosk = { deviceId: result.deviceId, deviceSecret: result.deviceSecret, storeName: store?.name || '' };
    localStorage.setItem(KIOSK_STORAGE, JSON.stringify(state.kiosk));
    await client.auth.signOut(); state.session = null; state.profile = null;
    await openKiosk();
  } catch (error) {
    status.textContent = errorText(error);
  } finally {
    button.disabled = false;
  }
}

async function functionRequest(name, body, { authenticated = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: config.supabasePublishableKey };
  if (authenticated) {
    const { data, error } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (error || !accessToken) throw new Error('SESSION_EXPIRED');
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text().catch(() => '');
  let result = {};
  if (responseText) {
    try { result = JSON.parse(responseText); }
    catch { throw new Error('INVALID_SERVER_RESPONSE'); }
  }
  if (!response.ok || result?.error) {
    const requestError = new Error(result?.error || `HTTP_${response.status}`);
    Object.assign(requestError, { status: response.status, detail: result?.detail, recordCounts: result?.recordCounts });
    throw requestError;
  }
  return result;
}

async function rawFunction(name, body) {
  return functionRequest(name, body);
}

async function openKiosk() {
  clearTimeout(kioskResetTimer);
  if (!state.kiosk) { state.entry = 'kiosk'; renderAuth(); return; }
  state.kioskSuccess = null; state.kioskSelected = null;
  app.innerHTML = `<div class="boot"><span class="brand-mark">H</span><p>${L('正在加载今日员工…', 'Cargando empleados de hoy…')}</p></div>`;
  try {
    const result = await rawFunction('kiosk-punch', { action: 'list', ...state.kiosk });
    state.kioskEmployees = result.employees || []; state.kioskStore = result.store;
    renderKiosk();
  } catch (error) {
    forgetKioskIfInvalid(error);
    toast(errorText(error), true); renderAuth();
  }
}

function eventLabel(type) {
  return ({ clock_in: L('上班', 'Entrada'), break_start: L('开始休息', 'Inicio pausa'), break_end: L('结束休息', 'Fin pausa'), clock_out: L('下班', 'Salida') })[type] || type;
}

function nextActionsFromRecord(record) {
  if (!record?.clock_in) return ['clock_in'];
  if (record.clock_out) return [];
  if (record.break_start && !record.break_end) return ['break_end'];
  if (!record.break_start) return ['break_start', 'clock_out'];
  return ['clock_out'];
}

function renderKiosk() {
  const selected = state.kioskEmployees.find((item) => item.user_id === state.kioskSelected);
  app.innerHTML = `<main class="kiosk-shell">
    <header class="kiosk-top"><div class="brand-lockup"><span class="brand-mark">H</span><span><b>HOLA!SEVILLA</b><small>${escapeHTML(state.kioskStore?.name || state.kiosk?.storeName || '')}</small></span></div><div class="kiosk-clock"><b id="kioskTime">${timeText(new Date())}</b><small>${madridDisplay()}</small></div></header>
    <section class="kiosk-card">
      ${state.kioskSuccess ? `<div class="success-panel"><b>✓ ${escapeHTML(state.kioskSuccess.name)}</b><span>${escapeHTML(eventLabel(state.kioskSuccess.eventType))} · ${escapeHTML(timeText(state.kioskSuccess.occurredAt))}</span><p>${L('打卡已记录，系统将自动退出。', 'Fichaje registrado. La pantalla se cerrará automáticamente.')}</p></div>` : `
        <p class="eyebrow">FICHAJE EN TIENDA</p><h1>${L('选择你的姓名', 'Elige tu nombre')}</h1><p>${L('确认姓名后输入个人6位PIN。完成后不会保留个人登录状态。', 'Después introduce tu PIN personal de 6 cifras. La sesión se cerrará al terminar.')}</p>
        <input id="employeeSearch" type="search" placeholder="${L('搜索姓名…', 'Buscar nombre…')}" autocomplete="off">
        <div class="employee-picker" id="employeePicker">${renderEmployeeChoices(state.kioskEmployees, selected)}</div>
        ${selected ? `<div class="pin-box"><label>${L('个人6位PIN', 'PIN personal de 6 cifras')}<input id="kioskPin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" autofocus></label></div>
          <div class="punch-actions">${selected.nextActions.map((action) => `<button class="${action === 'clock_out' ? 'secondary-btn' : 'primary-btn'}" type="button" data-punch="${action}">${eventLabel(action)}</button>`).join('') || `<p>${L('今天已经完成打卡', 'La jornada de hoy ya está completa')}</p>`}</div>` : ''}
      `}
    </section>
    <footer class="kiosk-footer"><button class="link-btn" id="kioskRefresh" type="button">↻ ${L('刷新', 'Actualizar')}</button><button class="link-btn" id="exitKiosk" type="button">${L('返回登录', 'Volver al acceso')}</button></footer>
  </main>`;
  bindKiosk();
}

function renderEmployeeChoices(employees, selected) {
  if (!employees.length) return `<div class="empty">${L('今天此店没有可打卡员工', 'No hay empleados disponibles hoy')}</div>`;
  return employees.map((employee) => `<button class="employee-choice ${selected?.user_id === employee.user_id ? 'active' : ''}" type="button" data-employee="${employee.user_id}"><b>${escapeHTML(employee.full_name)}</b><small>${escapeHTML(employee.employee_no)} · ${employee.events.length ? eventLabel(employee.events.at(-1).event_type) + ' ' + timeText(employee.events.at(-1).occurred_at) : L('尚未打卡', 'Sin fichar')}</small></button>`).join('');
}

function bindKiosk() {
  $('#exitKiosk')?.addEventListener('click', () => { clearTimeout(kioskResetTimer); renderAuth(); });
  $('#kioskRefresh')?.addEventListener('click', openKiosk);
  $('#employeeSearch')?.addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    const list = state.kioskEmployees.filter((employee) => `${employee.full_name} ${employee.employee_no}`.toLowerCase().includes(term));
    $('#employeePicker').innerHTML = renderEmployeeChoices(list, state.kioskEmployees.find((item) => item.user_id === state.kioskSelected));
    bindEmployeeChoices();
  });
  bindEmployeeChoices();
  $$('[data-punch]').forEach((button) => button.addEventListener('click', () => kioskPunch(button.dataset.punch)));
}

function bindEmployeeChoices() {
  $$('[data-employee]').forEach((button) => button.addEventListener('click', () => {
    state.kioskSelected = button.dataset.employee; renderKiosk();
  }));
}

async function kioskPunch(eventType) {
  const pin = $('#kioskPin')?.value || '';
  if (!/^\d{6}$/.test(pin)) { toast(L('请输入6位PIN', 'Introduce el PIN de 6 cifras'), true); return; }
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await rawFunction('kiosk-punch', { action: 'punch', ...state.kiosk, employeeId: state.kioskSelected, pin, eventType });
    state.kioskSuccess = { name: result.employee.name, eventType, occurredAt: result.event.occurredAt };
    renderKiosk();
    kioskResetTimer = setTimeout(() => openKiosk(), 5000);
  } catch (error) {
    if (forgetKioskIfInvalid(error)) { toast(errorText(error), true); renderAuth(); return; }
    toast(errorText(error), true);
    const pinInput = $('#kioskPin');
    if (pinInput) { pinInput.value = ''; pinInput.focus(); }
  }
  finally { state.busy = false; }
}

async function loadPortalData() {
  if (!state.profile) return;
  if (state.profile.role === 'manager') await loadManagerData(); else await loadEmployeeData();
}

function assertQueryResults(results) {
  const failed = results.find((result) => result?.error);
  if (!failed) return;
  console.error('Supabase data query failed:', failed.error);
  throw new Error('DATA_LOAD_FAILED');
}

async function checkSystemHealth() {
  const functionNames = ['admin-api', 'kiosk-punch', 'gps-punch'];
  const checks = await Promise.all(functionNames.map(async (name) => {
    try {
      const result = await functionRequest(name, { action: 'health' }, { timeoutMs: 8_000 });
      return { name, ok: result?.release === FUNCTION_RELEASES[name], release: result?.release || '' };
    } catch (error) {
      return { name, ok: false, error: errorText(error) };
    }
  }));
  state.health = checks;
}

async function loadEmployeeData() {
  const today = madridDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const now = new Date().toISOString();
  const [stores, schedules, attendance, requests, permissions] = await Promise.all([
    client.from('stores').select('*').eq('active', true).order('name'),
    client.from('schedules').select('*, stores(name,address)').gte('work_date', addDays(today, -7)).lte('work_date', addDays(today, 14)).order('work_date'),
    client.from('attendance_daily').select('*').gte('work_date', monthStart).lte('work_date', today).order('work_date', { ascending: false }),
    client.from('requests').select('*').order('created_at', { ascending: false }).limit(50),
    client.from('gps_permissions').select('*, stores(name,address,latitude,longitude,radius_m)').eq('active', true).lte('valid_from', now).gte('valid_until', now).order('valid_until'),
  ]);
  assertQueryResults([stores, schedules, attendance, requests, permissions]);
  state.data = { stores: stores.data || [], schedules: schedules.data || [], attendance: attendance.data || [], requests: requests.data || [], permissions: permissions.data || [] };
}

async function loadManagerData() {
  const today = madridDate();
  const monthStart = `${today.slice(0, 7)}-01`;
  const scheduleMonth = currentScheduleMonth();
  const scheduleStart = addDays(`${scheduleMonth}-01`, -7);
  const scheduleEnd = monthLastDate(scheduleMonth);
  const dayStart = madridLocalToIso(today, '00:00');
  const dayEnd = madridLocalToIso(addDays(today, 1), '00:00');
  const [stores, employees, schedules, events, requests, permissions, devices, attendance, audits] = await Promise.all([
    client.from('stores').select('*').order('name'),
    client.from('profiles').select('*, stores(name)').eq('role', 'employee').order('full_name'),
    client.from('schedules').select('*, stores(name)').gte('work_date', scheduleStart).lte('work_date', scheduleEnd).order('work_date'),
    client.from('attendance_events').select('*, stores(name)').gte('occurred_at', dayStart).lt('occurred_at', dayEnd).order('occurred_at'),
    client.from('requests').select('*').order('created_at', { ascending: false }).limit(100),
    client.from('gps_permissions').select('*, stores(name)').eq('active', true).gte('valid_until', new Date().toISOString()).order('valid_until'),
    client.from('kiosk_devices').select('*, stores(name)').order('created_at', { ascending: false }),
    client.from('attendance_daily').select('*').gte('work_date', monthStart).lte('work_date', today).order('work_date', { ascending: false }),
    client.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100),
  ]);
  const results = [stores, employees, schedules, events, requests, permissions, devices, attendance, audits];
  assertQueryResults(results);
  const employeeById = new Map((employees.data || []).map((employee) => [employee.user_id, employee]));
  const attachEmployee = (items) => (items || []).map((item) => ({ ...item, profiles: employeeById.get(item.employee_id) || null }));
  state.data = {
    stores: stores.data || [],
    employees: employees.data || [],
    schedules: attachEmployee(schedules.data),
    events: attachEmployee(events.data),
    requests: attachEmployee(requests.data),
    permissions: attachEmployee(permissions.data),
    devices: devices.data || [],
    attendance: attendance.data || [],
    audits: audits.data || [],
  };
  await checkSystemHealth();
}

function navItems() {
  return state.profile.role === 'manager'
    ? [['home', L('四店总览', 'Resumen')], ['employees', L('员工账号', 'Empleados')], ['schedule', L('排班', 'Horarios')], ['requests', L('申请审批', 'Solicitudes')], ['gps', L('GPS授权', 'Permisos GPS')], ['stores', L('店铺设置', 'Tiendas')], ['export', L('导出与审计', 'Exportar')]]
    : [['home', L('我的首页', 'Mi inicio')], ['records', L('考勤记录', 'Mis fichajes')], ['requests', L('提交申请', 'Solicitudes')], ['profile', L('个人资料', 'Mi perfil')]];
}

function renderPortal() {
  const items = navItems();
  if (!items.some(([view]) => view === state.view)) state.view = 'home';
  const currentTitle = items.find(([view]) => view === state.view)?.[1] || '';
  app.innerHTML = `<div class="app-layout">
    <aside class="sidebar"><div class="brand-lockup"><span class="brand-mark">H</span><span><b>HOLA!SEVILLA</b><small>CONTROL HORARIO</small></span></div>
      <nav>${items.map(([view, label]) => `<button class="nav-btn ${state.view === view ? 'active' : ''}" data-view="${view}">${label}</button>`).join('')}</nav>
      <div class="sidebar-bottom"><div class="account-chip"><b>${escapeHTML(state.profile.full_name)}</b><small>${state.profile.role === 'manager' ? 'VIVI · MANAGER' : `${escapeHTML(state.profile.employee_no)} · ${escapeHTML(state.profile.stores?.name || '')}`}</small></div><button class="ghost-btn" id="logout" type="button">${L('退出登录', 'Cerrar sesión')}</button></div>
    </aside>
    <main class="main-area"><header class="topbar"><div><p class="eyebrow">${state.profile.role === 'manager' ? 'VIVI · 4 STORES' : escapeHTML(state.profile.stores?.name || 'HOLA!SEVILLA')}</p><h1>${currentTitle}</h1></div><div class="top-actions">${languageButton()}<button class="ghost-btn" id="refreshData" type="button">↻</button><div class="date-chip"><b id="portalClock">${timeText(new Date())}</b><small>${madridDisplay()}</small></div></div></header>
      <section class="view">${renderPortalView()}</section></main>
    <nav class="mobile-nav">${items.map(([view, label]) => `<button class="${state.view === view ? 'active' : ''}" data-view="${view}" type="button">${label}</button>`).join('')}</nav>
  </div>`;
  bindPortal();
}

function renderPortalView() {
  if (state.profile.role === 'manager') {
    return ({ home: renderManagerHome, employees: renderEmployees, schedule: renderSchedule, requests: renderManagerRequests, gps: renderGpsAdmin, stores: renderStores, export: renderExport })[state.view]?.() || '';
  }
  return ({ home: renderEmployeeHome, records: renderRecords, requests: renderEmployeeRequests, profile: renderProfile })[state.view]?.() || '';
}

function renderEmployeeHome() {
  const today = madridDate();
  const schedule = state.data.schedules.find((item) => item.work_date === today);
  const record = state.data.attendance.find((item) => item.work_date === today);
  const permissions = state.data.permissions || [];
  const status = record?.clock_out ? L('今日已完成', 'Jornada completada') : record?.clock_in ? L('工作进行中', 'Jornada en curso') : schedule?.is_day_off ? L('今天休息', 'Día libre') : L('等待到店', 'Pendiente de entrada');
  return `<div class="page-grid">
    <article class="card hero-card"><div><p class="eyebrow">${dateText(today)}</p><h2>${escapeHTML(state.profile.full_name)}，${status}</h2><p>${schedule ? (schedule.is_day_off ? L('排班：休息', 'Horario: descanso') : `${escapeHTML(schedule.stores?.name || '')} · ${timeText(schedule.starts_at)}—${timeText(schedule.ends_at)}`) : L('VIVI尚未发布今天的排班', 'VIVI todavía no ha publicado el horario de hoy')}</p></div><div class="hero-meta"><span>${L('手机定位：店铺100米内打卡', 'Móvil: fichaje dentro de 100 m')}</span><span>${L('店铺电脑：PIN打卡', 'Ordenador: fichaje con PIN')}</span></div></article>
    <article class="card summary-card"><div class="metric"><span>${L('上班', 'Entrada')}</span><b>${timeText(record?.clock_in)}</b></div><div class="metric"><span>${L('休息', 'Pausa')}</span><b>${timeText(record?.break_start)}–${timeText(record?.break_end)}</b></div><div class="metric"><span>${L('下班', 'Salida')}</span><b>${timeText(record?.clock_out)}</b></div></article>
  </div>
  ${renderScheduledMobilePunch(schedule, record)}
  ${permissions.map((permission) => renderGpsCard(permission, record)).join('')}
  <article class="card"><div class="section-head"><div><p class="eyebrow">NEXT 7 DAYS</p><h2>${L('近期排班', 'Próximos turnos')}</h2></div></div>${scheduleTable(state.data.schedules.filter((item) => item.work_date >= today).slice(0, 7), false)}</article>`;
}

function renderScheduledMobilePunch(schedule, record) {
  const nextActions = nextActionsFromRecord(record);
  let content;
  if (!schedule) {
    content = `<div class="callout warning"><b>${L('不能打卡', 'No disponible')}</b><span>${L('今天没有已发布的排班，请联系VIVI。', 'No hay horario publicado para hoy. Contacta con VIVI.')}</span></div>`;
  } else if (schedule.is_day_off) {
    content = `<div class="callout"><b>${L('今日休息', 'Día libre')}</b><span>${L('休息日不显示打卡按钮。', 'No se muestran botones de fichaje en un día libre.')}</span></div>`;
  } else if (!nextActions.length) {
    content = `<span class="status ok">${L('今天已经完成打卡', 'La jornada de hoy ya está completa')}</span>`;
  } else {
    content = `<div class="button-row">${nextActions.map((event) => `<button class="${event === 'clock_out' ? 'secondary-btn' : 'primary-btn'}" data-gps-punch="${event}" type="button">${eventLabel(event)}</button>`).join('')}</div>`;
  }
  return `<article class="card"><p class="eyebrow">MOBILE GPS PUNCH</p><h2>${L('店铺100米内手机打卡', 'Fichaje móvil dentro de 100 m')}</h2><p>${schedule && !schedule.is_day_off ? `${escapeHTML(schedule.stores?.name || '')}<br>${escapeHTML(schedule.stores?.address || '')}` : L('手机打卡必须对应当天已发布的排班。', 'El fichaje móvil debe corresponder al horario publicado de hoy.')}</p>${content}<div class="callout"><b>GPS · 100m</b><span>${L('点击打卡时只读取一次位置。必须允许精确定位；系统不会持续追踪。', 'La ubicación se obtiene una sola vez al fichar. Debes permitir ubicación precisa; no hay seguimiento continuo.')}</span></div></article>`;
}

function renderGpsCard(permission, record) {
  const used = permission.used_events || [];
  const nextActions = nextActionsFromRecord(record);
  const allowed = (permission.allowed_events || []).filter((event) => !used.includes(event) && nextActions.includes(event));
  return `<article class="card"><p class="eyebrow">TEMPORARY GPS AUTHORIZATION</p><h2>${L('特殊情况手机GPS打卡已授权', 'Fichaje GPS autorizado temporalmente')}</h2><p>${escapeHTML(permission.stores?.name || '')}<br>${madridDisplay(new Date(permission.valid_from), true)} → ${madridDisplay(new Date(permission.valid_until), true)}<br>${escapeHTML(permission.reason)}</p><div class="button-row">${allowed.map((event) => `<button class="primary-btn" data-gps-punch="${event}" data-gps-permission="${permission.id}" type="button">${eventLabel(event)}</button>`).join('') || `<span class="status ok">${nextActions.length ? L('当前没有符合顺序的可用动作', 'No hay una acción disponible en este momento') : L('今天已经完成打卡', 'La jornada de hoy ya está completa')}</span>`}</div><div class="callout"><b>GPS · 100m</b><span>${L('临时跨店打卡也必须在授权店铺100米内。', 'El fichaje excepcional también debe realizarse a menos de 100 m de la tienda autorizada.')}</span></div></article>`;
}

function scheduleTable(items, showEmployee = true, editable = false) {
  if (!items.length) return `<div class="empty">${L('暂无排班', 'No hay horarios')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${showEmployee ? `<th>${L('员工', 'Empleado')}</th>` : ''}<th>${L('日期', 'Fecha')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('时间', 'Horario')}</th>${editable ? `<th>${L('操作', 'Acción')}</th>` : ''}</tr></thead><tbody>${items.map((item) => `<tr>${showEmployee ? `<td><b>${escapeHTML(item.profiles?.full_name || '')}</b><br><small>${escapeHTML(item.profiles?.employee_no || '')}</small></td>` : ''}<td>${dateText(item.work_date)}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${item.is_day_off ? `<span class="status">${L('休息', 'Libre')}</span>` : `${timeText(item.starts_at)}—${timeText(item.ends_at)}`}</td>${editable ? `<td>${item.profiles?.active === false ? '—' : `<button class="ghost-btn" data-edit-schedule="${item.id}" type="button">${L('修改', 'Modificar')}</button>`}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function renderRecords() {
  return `<article class="card"><div class="section-head"><div><p class="eyebrow">OFFICIAL RECORDS</p><h2>${L('本月考勤记录', 'Registros de este mes')}</h2></div></div>${attendanceTable(state.data.attendance, false)}</article>`;
}

function attendanceTable(items, showEmployee = true) {
  if (!items.length) return `<div class="empty">${L('暂无考勤记录', 'No hay registros')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${showEmployee ? `<th>${L('员工', 'Empleado')}</th>` : ''}<th>${L('日期', 'Fecha')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('上班', 'Entrada')}</th><th>${L('休息', 'Pausa')}</th><th>${L('下班', 'Salida')}</th><th>${L('班次时长', 'Duración')}</th><th>${L('状态', 'Estado')}</th></tr></thead><tbody>${items.map((item) => `<tr>${showEmployee ? `<td>${escapeHTML(item.employee_name || '')}</td>` : ''}<td>${dateText(item.work_date)}</td><td>${escapeHTML(item.store_name || '')}</td><td>${timeText(item.clock_in)}</td><td>${timeText(item.break_start)}–${timeText(item.break_end)}</td><td>${timeText(item.clock_out)}</td><td>${shiftDurationText(item)}</td><td><span class="status ${item.corrected ? 'pending' : 'ok'}">${item.corrected ? L('已审计修正', 'Corregido') : L('原始记录', 'Original')}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function renderEmployeeRequests() {
  const today = madridDate();
  return `<div class="split"><article class="card sticky-card"><p class="eyebrow">NEW REQUEST</p><h2>${L('提交申请', 'Nueva solicitud')}</h2><p>${L('补卡、请假、GPS异常或跨店支援均在此提交。', 'Solicita corrección de fichaje, permiso, incidencia GPS o apoyo en otra tienda.')}</p><form id="requestForm" class="stack-form">
    <label>${L('类型', 'Tipo')}<select id="requestType"><option value="missed_punch">${L('补卡申请', 'Corrección de fichaje')}</option><option value="leave">${L('请假申请', 'Permiso / ausencia')}</option><option value="gps_issue">${L('GPS异常', 'Incidencia GPS')}</option><option value="cross_store">${L('跨店支援', 'Apoyo en otra tienda')}</option><option value="other">${L('其他', 'Otro')}</option></select></label>
    <div class="form-row"><label>${L('日期', 'Fecha')}<input id="requestDate" type="date" value="${today}" required></label><label>${L('相关时间', 'Hora relacionada')}<input id="requestTime" type="time"></label></div>
    <label>${L('情况说明', 'Explicación')}<textarea id="requestReason" minlength="5" maxlength="1000" required></textarea></label><button class="primary-btn" type="submit">${L('提交给VIVI', 'Enviar a VIVI')}</button>
  </form></article><article class="card"><p class="eyebrow">MY REQUESTS</p><h2>${L('我的申请记录', 'Mis solicitudes')}</h2>${requestTable(state.data.requests, false)}</article></div>`;
}

function requestTable(items, manager = true) {
  if (!items.length) return `<div class="empty">${L('暂无申请', 'No hay solicitudes')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${manager ? `<th>${L('员工', 'Empleado')}</th>` : ''}<th>${L('类型', 'Tipo')}</th><th>${L('日期', 'Fecha')}</th><th>${L('说明', 'Explicación')}</th><th>${L('状态', 'Estado')}</th>${manager ? `<th>${L('操作', 'Acción')}</th>` : ''}</tr></thead><tbody>${items.map((item) => `<tr>${manager ? `<td>${escapeHTML(item.profiles?.full_name || '')}</td>` : ''}<td>${escapeHTML(requestTypeLabel(item.request_type))}</td><td>${dateText(item.request_date)}${item.related_time ? ` · ${escapeHTML(item.related_time.slice(0,5))}` : ''}</td><td>${escapeHTML(item.reason)}${item.review_note ? `<br><small>${L('回复', 'Respuesta')}: ${escapeHTML(item.review_note)}</small>` : ''}</td><td><span class="status ${item.status}">${statusLabel(item.status)}</span></td>${manager ? `<td>${item.status === 'pending' ? `<div class="button-row"><button class="secondary-btn" data-review="approved" data-id="${item.id}">${L('批准', 'Aprobar')}</button><button class="danger-btn" data-review="rejected" data-id="${item.id}">${L('拒绝', 'Rechazar')}</button></div>` : '—'}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function requestTypeLabel(type) { return ({ missed_punch: L('补卡', 'Corrección'), leave: L('请假', 'Permiso'), gps_issue: L('GPS异常', 'GPS'), cross_store: L('跨店', 'Otra tienda'), other: L('其他', 'Otro') })[type] || type; }
function statusLabel(status) { return ({ pending: L('待审批', 'Pendiente'), approved: L('已批准', 'Aprobada'), rejected: L('已拒绝', 'Rechazada') })[status] || status; }

function renderProfile() {
  return `<div class="page-grid"><article class="card hero-card"><div><p class="eyebrow">EMPLOYEE PROFILE</p><h2>${escapeHTML(state.profile.full_name)}</h2><p>${escapeHTML(state.profile.employee_no)} · ${escapeHTML(state.profile.stores?.name || '')}</p></div><div class="hero-meta"><span>${state.profile.active ? L('在职', 'En activo') : L('停用', 'Desactivado')}</span><span>${escapeHTML(state.profile.phone)}</span></div></article><article class="card summary-card"><p class="eyebrow">PRIVACY</p><h3>${L('数据与位置', 'Datos y ubicación')}</h3><p>${L('考勤记录按公司法定义务保存。GPS只在员工主动点击打卡时读取一次，用于确认是否在店铺100米内，不会持续追踪。', 'Los registros se conservan según la obligación legal. El GPS se obtiene una sola vez al fichar para confirmar que estás a menos de 100 m de la tienda; no hay seguimiento continuo.')}</p></article></div>`;
}

function renderManagerHome() {
  const active = state.data.employees.filter((item) => item.active);
  const punched = new Set(state.data.events.filter((event) => event.event_type === 'clock_in').map((event) => event.employee_id));
  const pending = state.data.requests.filter((item) => item.status === 'pending');
  const unconfigured = state.data.stores.filter((store) => store.latitude === null || store.longitude === null);
  const unhealthy = (state.health || []).filter((item) => !item.ok);
  return `${unhealthy.length ? `<div class="callout warning"><b>${L('系统版本未同步', 'Versión sin sincronizar')}</b><span>${L('以下后台需要重新部署：', 'Hay que volver a desplegar:')} ${unhealthy.map((item) => escapeHTML(item.name)).join('、')}</span></div>` : `<div class="callout"><b>${L('系统正常', 'Sistema correcto')}</b><span>${L('网页、数据库与三套后台服务连接正常。', 'La web, la base de datos y los tres servicios están conectados.')}</span></div>`}
  <div class="stat-grid"><article class="stat-card"><small>${L('在职员工', 'Empleados activos')}</small><b>${active.length}</b></article><article class="stat-card"><small>${L('今日已上班打卡', 'Entradas hoy')}</small><b>${punched.size}</b></article><article class="stat-card"><small>${L('待审批', 'Pendientes')}</small><b>${pending.length}</b></article><article class="stat-card"><small>${L('GPS未配置店铺', 'Tiendas sin GPS')}</small><b>${unconfigured.length}</b></article></div>
  ${unconfigured.length ? `<div class="callout warning"><b>${L('上线前必须完成', 'Pendiente antes de publicar')}</b><span>${L('请在“店铺设置”中填写四店准确地址、经纬度和有效范围。未配置的店铺不能使用GPS打卡。', 'Completa dirección, coordenadas y radio de las cuatro tiendas. Sin ello no se permite el fichaje GPS.')}</span></div>` : ''}
  <article class="card"><div class="section-head"><div><p class="eyebrow">LIVE TODAY</p><h2>${L('今日实时打卡', 'Fichajes de hoy')}</h2></div><span class="status ok">Europe/Madrid</span></div>${eventTable(state.data.events)}</article>`;
}

function eventTable(items) {
  if (!items.length) return `<div class="empty">${L('今天尚无打卡', 'Todavía no hay fichajes hoy')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('时间', 'Hora')}</th><th>${L('员工', 'Empleado')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('事件', 'Evento')}</th><th>${L('来源', 'Origen')}</th></tr></thead><tbody>${items.map((item) => `<tr><td>${timeText(item.occurred_at)}</td><td>${escapeHTML(item.profiles?.full_name || '')}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${eventLabel(item.event_type)}</td><td><span class="status ${item.source === 'gps' ? 'pending' : 'ok'}">${item.source === 'kiosk' ? L('店铺电脑', 'Ordenador') : item.source.toUpperCase()}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function storeOptions(selected = '') { return state.data.stores.filter((store) => store.active !== false).map((store) => `<option value="${store.id}" ${selected === store.id ? 'selected' : ''}>${escapeHTML(store.name)}</option>`).join(''); }
function employeeOptions(activeOnly = true, selected = '') { return state.data.employees.filter((employee) => !activeOnly || employee.active).map((employee) => `<option value="${employee.user_id}" ${selected === employee.user_id ? 'selected' : ''}>${escapeHTML(employee.full_name)} · ${escapeHTML(employee.employee_no)}</option>`).join(''); }

function renderEmployees() {
  const hasStores = state.data.stores.some((store) => store.active !== false);
  return `<div class="split"><article class="card sticky-card"><p class="eyebrow">NEW EMPLOYEE</p><h2>${L('创建员工正式账号', 'Crear cuenta de empleado')}</h2><p>${L('员工不能自行注册。手机密码用于查看，6位PIN用于店铺电脑打卡。', 'El empleado no puede registrarse solo. La contraseña es para el móvil y el PIN de 6 cifras para fichar en tienda.')}</p>${hasStores ? `<form id="employeeForm" class="stack-form">
    <label>${L('姓名', 'Nombre completo')}<input id="employeeName" required minlength="2"></label><label>${L('手机号', 'Teléfono')}<input id="employeePhone" type="tel" placeholder="+34 600 000 000" required></label>
    <label>${L('所属店铺', 'Tienda habitual')}<select id="employeeStore">${storeOptions()}</select></label><div class="form-row"><label>${L('手机登录密码', 'Contraseña móvil')}<input id="employeePassword" type="password" minlength="8" required></label><label>${L('店铺打卡PIN', 'PIN de fichaje')}<input id="employeePin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label></div>
    <button class="primary-btn" type="submit">${L('创建员工', 'Crear empleado')}</button></form>` : `<div class="callout warning"><b>${L('没有可用店铺', 'No hay tiendas disponibles')}</b><span>${L('请先检查店铺数据。', 'Comprueba primero los datos de las tiendas.')}</span></div>`}</article>
    <article class="card"><div class="section-head"><div><p class="eyebrow">TEAM</p><h2>${L('员工账号', 'Cuentas de empleados')}</h2></div><span class="status ok">${state.data.employees.filter((item) => item.active).length} ${L('人在职', 'activos')}</span></div>${employeeTable()}</article></div>`;
}

function employeeTable() {
  if (!state.data.employees.length) return `<div class="empty">${L('尚未创建员工', 'Todavía no hay empleados')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('员工', 'Empleado')}</th><th>${L('手机号', 'Teléfono')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('状态', 'Estado')}</th><th>${L('操作', 'Acción')}</th></tr></thead><tbody>${state.data.employees.map((employee) => `<tr><td><b>${escapeHTML(employee.full_name)}</b><br><small>${escapeHTML(employee.employee_no)}</small></td><td>${escapeHTML(employee.phone)}</td><td>${escapeHTML(employee.stores?.name || '')}</td><td><span class="status ${employee.active ? 'ok' : 'alert'}">${employee.active ? L('在职', 'Activo') : L('停用', 'Inactivo')}</span></td><td><div class="button-row"><button class="ghost-btn" data-reset="password" data-id="${employee.user_id}">${L('改密码', 'Contraseña')}</button><button class="ghost-btn" data-reset="pin" data-id="${employee.user_id}">PIN</button><button class="${employee.active ? 'danger-btn' : 'secondary-btn'}" data-toggle-employee="${employee.user_id}" data-active="${employee.active ? 'false' : 'true'}">${employee.active ? L('停用', 'Desactivar') : L('启用', 'Activar')}</button>${employee.active ? '' : `<button class="danger-btn" data-delete-employee="${employee.user_id}">${L('删除误建账号', 'Eliminar cuenta errónea')}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
}

function weekdayNames() {
  return [
    L('周一', 'Lunes'), L('周二', 'Martes'), L('周三', 'Miércoles'), L('周四', 'Jueves'),
    L('周五', 'Viernes'), L('周六', 'Sábado'), L('周日', 'Domingo'),
  ];
}

function scheduleWeekdayIndex(dateString) {
  return (new Date(`${dateString}T12:00:00Z`).getUTCDay() + 6) % 7;
}

function selectedScheduleEmployee() {
  const activeEmployees = state.data.employees.filter((employee) => employee.active);
  if (!activeEmployees.some((employee) => employee.user_id === state.scheduleEmployeeId)) {
    state.scheduleEmployeeId = activeEmployees[0]?.user_id || null;
  }
  return activeEmployees.find((employee) => employee.user_id === state.scheduleEmployeeId) || null;
}

function weeklyTemplateFor(employee) {
  const employeeSchedules = state.data.schedules
    .filter((item) => item.employee_id === employee.user_id)
    .sort((left, right) => left.work_date.localeCompare(right.work_date));
  const fallbackStore = employee.home_store_id || state.data.stores.find((store) => store.active !== false)?.id || '';
  return weekdayNames().map((name, weekday) => {
    const existing = employeeSchedules.find((item) => scheduleWeekdayIndex(item.work_date) === weekday);
    return {
      weekday,
      name,
      dayOff: existing ? Boolean(existing.is_day_off) : weekday === 6,
      storeId: existing?.store_id || fallbackStore,
      start: madridTimeValue(existing?.starts_at, '10:00'),
      end: madridTimeValue(existing?.ends_at, '17:00'),
    };
  });
}

function renderWeeklyRows(employee) {
  if (!employee) return '';
  return weeklyTemplateFor(employee).map((item) => `<div class="weekly-row" data-weekday="${item.weekday}">
    <b class="weekly-day-name">${escapeHTML(item.name)}</b>
    <label class="inline-check"><input data-weekly-off type="checkbox" ${item.dayOff ? 'checked' : ''}> <span>${L('休息', 'Libre')}</span></label>
    <label class="weekly-store"><span>${L('店铺', 'Tienda')}</span><select data-weekly-store>${storeOptions(item.storeId)}</select></label>
    <label><span>${L('开始', 'Inicio')}</span><input data-weekly-start type="time" value="${item.start}" ${item.dayOff ? 'disabled' : ''} required></label>
    <label><span>${L('结束', 'Fin')}</span><input data-weekly-end type="time" value="${item.end}" ${item.dayOff ? 'disabled' : ''} required></label>
  </div>`).join('');
}

function renderSchedule() {
  const today = madridDate();
  const month = currentScheduleMonth();
  const employee = selectedScheduleEmployee();
  const canPublish = Boolean(employee) && state.data.stores.some((store) => store.active !== false);
  const dailyDate = today.startsWith(month) ? today : `${month}-01`;
  const visibleSchedules = state.data.schedules.filter((item) => item.employee_id === employee?.user_id && item.work_date.startsWith(month));
  if (!canPublish) return `<article class="card"><p class="eyebrow">SCHEDULE</p><h2>${L('排班', 'Horarios')}</h2><div class="callout warning"><b>${L('暂时无法排班', 'No se puede publicar')}</b><span>${L('请先创建一名在职员工并确认店铺已启用。', 'Crea primero un empleado activo y comprueba que la tienda esté habilitada.')}</span></div></article>`;
  return `<article class="card"><div class="section-head"><div><p class="eyebrow">WEEKLY TEMPLATE · MONTHLY SCHEDULE</p><h2>${L('发布一周模板，自动生成整月', 'Publicar una semana y generar el mes')}</h2></div><span class="status ok">${escapeHTML(month)}</span></div>
    <p>${L('设置周一到周日的固定班次，一次生成该员工整个月的排班。休息日也请保留所属店铺。', 'Configura los turnos fijos de lunes a domingo y genera todo el mes de una vez. Mantén la tienda también en los días libres.')}</p>
    <form id="weeklyScheduleForm" class="stack-form"><div class="form-row"><label>${L('员工', 'Empleado')}<select id="weeklyEmployee">${employeeOptions(true, employee.user_id)}</select></label><label>${L('排班月份', 'Mes')}<input id="weeklyMonth" type="month" min="${SCHEDULE_START_MONTH}" value="${month}" required></label></div>
      <div id="weeklyRows" class="weekly-schedule">${renderWeeklyRows(employee)}</div>
      <label>${L('整月备注（可选）', 'Nota del mes (opcional)')}<input id="weeklyNotes" maxlength="500"></label>
      <div class="callout warning"><b>${L('覆盖提示', 'Aviso')}</b><span>${L('生成整月会覆盖该员工这个月已经发布的排班；之后仍可在下方逐日修改。', 'Al generar el mes se sobrescribe el horario ya publicado de ese empleado; después podrás modificar días concretos.')}</span></div>
      <button class="primary-btn" type="submit">${L('生成整月排班', 'Generar horario mensual')}</button>
    </form></article>
    <div class="split"><article class="card sticky-card" id="singleScheduleCard"><p class="eyebrow">DAILY OVERRIDE</p><h2>${L('单日修改', 'Modificar un día')}</h2><p>${L('临时换店、换班或休息时，只修改这一天。', 'Para un cambio puntual de tienda, turno o descanso, modifica solo ese día.')}</p>
      <form id="singleScheduleForm" class="stack-form"><label>${L('员工', 'Empleado')}<select id="singleScheduleEmployee">${employeeOptions(true, employee.user_id)}</select></label><label>${L('工作店铺', 'Tienda')}<select id="singleScheduleStore">${storeOptions(employee.home_store_id)}</select></label><label>${L('日期', 'Fecha')}<input id="singleScheduleDate" type="date" min="${SCHEDULE_START_MONTH}-01" value="${dailyDate}" required></label>
        <label class="inline-check"><input id="singleScheduleDayOff" type="checkbox"> <span>${L('当天休息', 'Día libre')}</span></label><div class="form-row"><label>${L('开始', 'Inicio')}<input id="singleScheduleStart" type="time" value="10:00" required></label><label>${L('结束', 'Fin')}<input id="singleScheduleEnd" type="time" value="17:00" required></label></div>
        <label>${L('备注（可选）', 'Nota opcional')}<input id="singleScheduleNotes" maxlength="500"></label><button class="primary-btn" type="submit">${L('保存单日修改', 'Guardar cambio del día')}</button></form></article>
      <article class="card"><div class="section-head"><div><p class="eyebrow">MONTH PREVIEW</p><h2>${L('整月排班', 'Horario del mes')} · ${escapeHTML(employee.full_name)}</h2></div><span class="status">${visibleSchedules.length} ${L('天', 'días')}</span></div>${scheduleTable(visibleSchedules, true, true)}</article></div>`;
}

function renderManagerRequests() {
  return `<article class="card"><div class="section-head"><div><p class="eyebrow">APPROVALS</p><h2>${L('员工申请审批', 'Solicitudes de empleados')}</h2></div><span class="status pending">${state.data.requests.filter((item) => item.status === 'pending').length} ${L('项待处理', 'pendientes')}</span></div>${requestTable(state.data.requests, true)}</article>`;
}

function renderGpsAdmin() {
  const today = madridDate();
  const canGrant = state.data.employees.some((employee) => employee.active) && state.data.stores.some((store) => store.active !== false);
  return `<div class="split"><article class="card sticky-card"><p class="eyebrow">TEMPORARY AUTHORIZATION</p><h2>${L('特殊情况跨店GPS授权', 'Autorización GPS excepcional')}</h2><p>${L('员工正常手机打卡按当天排班店铺判断，无需授权。这里仅用于电脑故障、临时跨店或其他已确认的特殊情况。', 'El fichaje móvil normal usa la tienda asignada y no necesita autorización. Esta sección es solo para averías, cambios temporales de tienda u otras excepciones confirmadas.')}</p>${canGrant ? `<form id="gpsForm" class="stack-form">
    <label>${L('员工', 'Empleado')}<select id="gpsEmployee">${employeeOptions()}</select></label><label>${L('店铺', 'Tienda')}<select id="gpsStore">${storeOptions()}</select></label>
    <div class="form-row"><label>${L('开始日期时间', 'Desde')}<input id="gpsFrom" type="datetime-local" value="${today}T09:00" required></label><label>${L('结束日期时间', 'Hasta')}<input id="gpsUntil" type="datetime-local" value="${today}T23:00" required></label></div>
    <label>${L('允许事件', 'Eventos permitidos')}<select id="gpsEvents" multiple size="4"><option value="clock_in" selected>${L('上班', 'Entrada')}</option><option value="break_start" selected>${L('开始休息', 'Inicio pausa')}</option><option value="break_end" selected>${L('结束休息', 'Fin pausa')}</option><option value="clock_out" selected>${L('下班', 'Salida')}</option></select></label>
    <label>${L('授权原因', 'Motivo')}<textarea id="gpsReason" minlength="5" required></textarea></label><button class="primary-btn" type="submit">${L('创建临时授权', 'Crear autorización')}</button></form>` : `<div class="callout warning"><b>${L('暂时无法授权', 'No se puede autorizar')}</b><span>${L('请先创建一名在职员工并确认店铺已启用。', 'Crea primero un empleado activo y comprueba que la tienda esté habilitada.')}</span></div>`}</article>
    <article class="card"><p class="eyebrow">ACTIVE GPS</p><h2>${L('当前授权', 'Autorizaciones actuales')}</h2>${gpsPermissionTable()}</article></div>`;
}

function gpsPermissionTable() {
  if (!state.data.permissions.length) return `<div class="empty">${L('暂无有效授权', 'No hay autorizaciones vigentes')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('员工', 'Empleado')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('有效时间', 'Vigencia')}</th><th>${L('原因', 'Motivo')}</th><th></th></tr></thead><tbody>${state.data.permissions.map((item) => `<tr><td>${escapeHTML(item.profiles?.full_name || '')}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${madridDisplay(new Date(item.valid_from), true)}<br>→ ${madridDisplay(new Date(item.valid_until), true)}</td><td>${escapeHTML(item.reason)}</td><td><button class="danger-btn" data-revoke-gps="${item.id}">${L('撤销', 'Revocar')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderStores() {
  return `<div class="page-grid">${state.data.stores.map((store) => `<article class="card" style="grid-column:span 6"><p class="eyebrow">${escapeHTML(store.code)}</p><h2>${escapeHTML(store.name)}</h2><form class="stack-form store-form" data-store-id="${store.id}"><label>${L('准确地址', 'Dirección exacta')}<input name="address" value="${escapeHTML(store.address || '')}" required></label><div class="form-row"><label>Latitude<input name="latitude" type="number" step="any" value="${store.latitude ?? ''}" required></label><label>Longitude<input name="longitude" type="number" step="any" value="${store.longitude ?? ''}" required></label></div><label>${L('手机打卡范围（最大100米）', 'Radio de fichaje móvil (máx. 100 m)')}<input name="radius" type="number" min="20" max="100" value="${Math.min(Number(store.radius_m) || 100, 100)}" required></label><button class="primary-btn" type="submit">${L('保存店铺GPS', 'Guardar GPS')}</button></form></article>`).join('')}</div><article class="card"><p class="eyebrow">KIOSK DEVICES</p><h2>${L('已绑定店铺电脑', 'Ordenadores vinculados')}</h2>${deviceTable()}</article>`;
}

function deviceTable() {
  if (!state.data.devices.length) return `<div class="empty">${L('尚未绑定店铺电脑', 'No hay ordenadores vinculados')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('电脑', 'Ordenador')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('最后在线', 'Última conexión')}</th><th>${L('状态', 'Estado')}</th><th>${L('操作', 'Acción')}</th></tr></thead><tbody>${state.data.devices.map((item) => `<tr><td>${escapeHTML(item.name)}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${item.last_seen_at ? madridDisplay(new Date(item.last_seen_at), true) : '—'}</td><td><span class="status ${item.active ? 'ok' : 'alert'}">${item.active ? L('启用', 'Activo') : L('停用', 'Inactivo')}</span></td><td><button class="${item.active ? 'danger-btn' : 'secondary-btn'}" data-toggle-kiosk="${item.id}" data-active="${item.active ? 'false' : 'true'}">${item.active ? L('停用', 'Desactivar') : L('启用', 'Activar')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function renderExport() {
  const today = madridDate();
  const canCorrect = state.data.employees.length > 0;
  return `<div class="page-grid"><article class="card hero-card"><div><p class="eyebrow">MONTHLY EXPORT</p><h2>${L('导出本月正式考勤', 'Exportar control horario mensual')}</h2><p>${L('CSV包含员工、日期、店铺、上班、休息、下班及是否审计修正，可由Excel直接打开。', 'El CSV incluye empleado, fecha, tienda, entrada, pausa, salida y correcciones auditadas; se abre directamente en Excel.')}</p></div><div><button class="primary-btn" id="exportCsv" type="button" style="background:white;color:#153f35">${L('下载CSV', 'Descargar CSV')}</button></div></article><article class="card summary-card"><p class="eyebrow">RETENTION</p><h3>${L('保存与审计', 'Conservación y auditoría')}</h3><p>${L('原始打卡事件不可修改或删除。人工修正另存，并记录VIVI、原因和时间。正式记录按西班牙要求保留4年。', 'Los eventos originales no se modifican ni eliminan. Cada corrección guarda quién, motivo y hora. Los registros oficiales se conservan 4 años.')}</p></article></div>
  <div class="split"><article class="card sticky-card"><p class="eyebrow">AUDITED CORRECTION</p><h2>${L('人工修正考勤', 'Corrección manual')}</h2><p>${L('不会覆盖原始打卡，只会新增一条带原因和操作人的修正记录。', 'No sobrescribe el fichaje original; crea una corrección nueva con motivo y responsable.')}</p>${canCorrect ? `<form id="correctionForm" class="stack-form"><label>${L('员工', 'Empleado')}<select id="correctionEmployee">${employeeOptions(false)}</select></label><label>${L('日期', 'Fecha')}<input id="correctionDate" type="date" value="${today}" required></label><div class="form-row"><label>${L('上班', 'Entrada')}<input id="correctionClockIn" type="time"></label><label>${L('下班', 'Salida')}<input id="correctionClockOut" type="time"></label></div><div class="form-row"><label>${L('开始休息', 'Inicio pausa')}<input id="correctionBreakStart" type="time"></label><label>${L('结束休息', 'Fin pausa')}<input id="correctionBreakEnd" type="time"></label></div><label>${L('修正原因（必填）', 'Motivo obligatorio')}<textarea id="correctionReason" minlength="5" required></textarea></label><button class="primary-btn" type="submit">${L('保存审计修正', 'Guardar corrección')}</button></form>` : `<div class="callout warning"><b>${L('尚无员工账号', 'No hay empleados')}</b><span>${L('创建员工后才能新增考勤修正。', 'Crea un empleado antes de añadir una corrección.')}</span></div>`}</article><article class="card"><h2>${L('本月预览', 'Vista previa del mes')}</h2>${attendanceTable(state.data.attendance, true)}</article></div>
  <article class="card"><p class="eyebrow">AUDIT LOG</p><h2>${L('最近100条管理操作', 'Últimas 100 acciones')}</h2>${auditTable()}</article>`;
}

function auditTable() {
  if (!state.data.audits?.length) return `<div class="empty">${L('暂无管理操作', 'No hay acciones')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('时间', 'Hora')}</th><th>${L('操作', 'Acción')}</th><th>${L('对象', 'Objeto')}</th><th>${L('编号', 'ID')}</th></tr></thead><tbody>${state.data.audits.map((item) => `<tr><td>${madridDisplay(new Date(item.created_at), true)}</td><td>${escapeHTML(item.action)}</td><td>${escapeHTML(item.target_type)}</td><td><small>${escapeHTML(item.target_id || '—')}</small></td></tr>`).join('')}</tbody></table></div>`;
}

function bindPortal() {
  $('#languageToggle')?.addEventListener('click', () => setLang(state.lang === 'zh' ? 'es' : 'zh'));
  $('#logout')?.addEventListener('click', logout);
  $('#refreshData')?.addEventListener('click', refreshPortal);
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; renderPortal(); }));
  $('#requestForm')?.addEventListener('submit', submitRequest);
  $$('[data-gps-punch]').forEach((button) => button.addEventListener('click', () => gpsPunch(button.dataset.gpsPunch, button.dataset.gpsPermission || null)));
  $('#employeeForm')?.addEventListener('submit', createEmployee);
  $$('[data-toggle-employee]').forEach((button) => button.addEventListener('click', () => toggleEmployee(button)));
  $$('[data-delete-employee]').forEach((button) => button.addEventListener('click', () => deleteEmployee(button)));
  $$('[data-reset]').forEach((button) => button.addEventListener('click', () => resetEmployeeCredential(button)));
  $('#weeklyScheduleForm')?.addEventListener('submit', saveMonthlySchedule);
  $('#weeklyEmployee')?.addEventListener('change', changeWeeklyEmployee);
  $('#weeklyMonth')?.addEventListener('change', changeScheduleMonth);
  bindWeeklyRows();
  $('#singleScheduleForm')?.addEventListener('submit', saveSingleSchedule);
  $('#singleScheduleDayOff')?.addEventListener('change', toggleSingleScheduleTimes);
  $$('[data-edit-schedule]').forEach((button) => button.addEventListener('click', () => editSchedule(button)));
  $$('[data-review]').forEach((button) => button.addEventListener('click', () => reviewRequest(button)));
  $('#gpsForm')?.addEventListener('submit', grantGps);
  $$('[data-revoke-gps]').forEach((button) => button.addEventListener('click', () => revokeGps(button)));
  $$('.store-form').forEach((form) => form.addEventListener('submit', saveStore));
  $$('[data-toggle-kiosk]').forEach((button) => button.addEventListener('click', () => toggleKiosk(button)));
  $('#exportCsv')?.addEventListener('click', exportCsv);
  $('#correctionForm')?.addEventListener('submit', saveCorrection);
}

async function logout() {
  try { await client.auth.signOut(); }
  catch (error) { console.error('Sign out failed:', error); }
  state.session = null;
  state.profile = null;
  state.data = {};
  state.health = null;
  state.busy = false;
  renderAuth();
}

async function reloadPortal() {
  await loadPortalData();
  renderPortal();
}

async function refreshPortal() {
  try {
    await reloadPortal();
    toast(L('已刷新', 'Actualizado'));
  } catch (error) {
    toast(errorText(error), true);
  }
}

async function finishMutation(successMessage) {
  try {
    await reloadPortal();
    toast(successMessage);
  } catch (error) {
    console.error('Mutation succeeded but refresh failed:', error);
    toast(L('操作已完成，但最新数据加载失败，请点击刷新', 'La operación terminó, pero no se pudieron actualizar los datos. Pulsa actualizar'), true);
  }
}

async function adminAction(body) {
  return functionRequest('admin-api', body, { authenticated: true });
}

async function submitRequest(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const { error } = await client.from('requests').insert({
      employee_id: state.profile.user_id,
      request_type: $('#requestType').value,
      request_date: $('#requestDate').value,
      related_time: $('#requestTime').value || null,
      reason: $('#requestReason').value.trim(),
    });
    if (error) throw error;
    form.reset();
    await finishMutation(L('申请已提交给VIVI', 'Solicitud enviada a VIVI'));
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    button.disabled = false;
  }
}

async function gpsPunch(eventType, permissionId = null) {
  if (!navigator.geolocation) { toast(L('此设备不支持定位', 'Este dispositivo no admite ubicación'), true); return; }
  if (state.busy) return;
  state.busy = true;
  $$('[data-gps-punch]').forEach((button) => { button.disabled = true; });
  toast(L('正在确认你位于店铺100米内…', 'Comprobando que estás a menos de 100 m…'));
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true, timeout: 15_000, maximumAge: 0,
    }));
    const result = await functionRequest('gps-punch', {
      eventType,
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      ...(permissionId ? { permissionId } : {}),
    }, { authenticated: true });
    await finishMutation(`${eventLabel(eventType)} · ${timeText(result.event.occurredAt)} · ${Math.round(result.distanceM)}m`);
  } catch (error) {
    const locationError = error?.code === 1 ? 'LOCATION_PERMISSION_DENIED' : [2, 3].includes(error?.code) ? 'LOCATION_UNAVAILABLE' : error;
    toast(errorText(locationError), true);
  } finally {
    state.busy = false;
    $$('[data-gps-punch]').forEach((button) => { button.disabled = false; });
  }
}

async function createEmployee(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'create_employee', fullName: $('#employeeName').value, phone: $('#employeePhone').value, storeId: $('#employeeStore').value, password: $('#employeePassword').value, pin: $('#employeePin').value, language: 'es' });
    form.reset();
    await finishMutation(L('员工账号已创建', 'Cuenta de empleado creada'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function toggleEmployee(button) {
  const active = button.dataset.active === 'true';
  if (!confirm(active ? L('确定重新启用此员工？', '¿Reactivar este empleado?') : L('停用后员工会立即退出，确定继续？', 'El empleado cerrará sesión. ¿Continuar?'))) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'update_employee', employeeId: button.dataset.toggleEmployee, active });
    await finishMutation(active ? L('员工账号已启用', 'Cuenta reactivada') : L('员工账号已停用', 'Cuenta desactivada'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function deleteEmployee(button) {
  const employee = state.data.employees.find((item) => item.user_id === button.dataset.deleteEmployee);
  if (!employee) { toast(errorText('EMPLOYEE_NOT_FOUND'), true); return; }
  const enteredName = prompt(L(
    `仅限误建且没有任何记录的账号。永久删除不可恢复。\n请输入员工姓名“${employee.full_name}”确认：`,
    `Solo para una cuenta errónea sin registros. La eliminación es irreversible.\nEscribe “${employee.full_name}” para confirmar:`,
  ));
  if (enteredName === null) return;
  if (enteredName.trim() !== employee.full_name.trim()) {
    toast(L('姓名不一致，已取消删除', 'El nombre no coincide. Eliminación cancelada'), true);
    return;
  }
  button.disabled = true;
  try {
    await adminAction({ action: 'delete_employee', employeeId: employee.user_id });
    await finishMutation(L('误建员工账号已永久删除', 'La cuenta errónea se eliminó permanentemente'));
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    button.disabled = false;
  }
}

async function resetEmployeeCredential(button) {
  const type = button.dataset.reset;
  const value = prompt(type === 'pin' ? L('输入新的6位PIN', 'Nuevo PIN de 6 cifras') : L('输入新的手机登录密码（至少8位）', 'Nueva contraseña móvil (mínimo 8 caracteres)'));
  if (!value) return;
  button.disabled = true;
  try { await adminAction({ action: type === 'pin' ? 'reset_pin' : 'reset_password', employeeId: button.dataset.id, [type]: value }); toast(L('已更新', 'Actualizado')); }
  catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

function bindWeeklyRows() {
  $$('.weekly-row').forEach((row) => {
    const checkbox = $('[data-weekly-off]', row);
    checkbox?.addEventListener('change', () => {
      $('[data-weekly-start]', row).disabled = checkbox.checked;
      $('[data-weekly-end]', row).disabled = checkbox.checked;
    });
  });
}

function changeWeeklyEmployee(event) {
  state.scheduleEmployeeId = event.target.value;
  renderPortal();
}

async function changeScheduleMonth(event) {
  const month = event.target.value;
  if (!/^\d{4}-\d{2}$/.test(month) || month < SCHEDULE_START_MONTH) {
    event.target.value = currentScheduleMonth();
    toast(errorText('INVALID_MONTH'), true);
    return;
  }
  state.scheduleMonth = month;
  event.target.disabled = true;
  try { await reloadPortal(); }
  catch (error) { toast(errorText(error), true); }
  finally { event.target.disabled = false; }
}

function toggleSingleScheduleTimes(event) {
  $('#singleScheduleStart').disabled = event.target.checked;
  $('#singleScheduleEnd').disabled = event.target.checked;
}

function editSchedule(button) {
  const item = state.data.schedules.find((schedule) => String(schedule.id) === button.dataset.editSchedule);
  if (!item) { toast(errorText('RECORD_NOT_FOUND'), true); return; }
  const employeeInput = $('#singleScheduleEmployee');
  if (![...employeeInput.options].some((option) => option.value === item.employee_id)) {
    toast(errorText('EMPLOYEE_NOT_ACTIVE'), true);
    return;
  }
  employeeInput.value = item.employee_id;
  $('#singleScheduleStore').value = item.store_id;
  $('#singleScheduleDate').value = item.work_date;
  $('#singleScheduleDayOff').checked = Boolean(item.is_day_off);
  $('#singleScheduleStart').value = madridTimeValue(item.starts_at, '10:00');
  $('#singleScheduleEnd').value = madridTimeValue(item.ends_at, '17:00');
  $('#singleScheduleNotes').value = item.notes || '';
  $('#singleScheduleStart').disabled = Boolean(item.is_day_off);
  $('#singleScheduleEnd').disabled = Boolean(item.is_day_off);
  $('#singleScheduleCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(L('已载入这一天，请修改后保存', 'Día cargado. Modifícalo y guarda'));
}

async function saveMonthlySchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const month = $('#weeklyMonth').value;
  if (!/^\d{4}-\d{2}$/.test(month) || month < SCHEDULE_START_MONTH) { toast(errorText('INVALID_MONTH'), true); return; }
  const pattern = $$('.weekly-row').map((row) => ({
    dayOff: $('[data-weekly-off]', row).checked,
    storeId: $('[data-weekly-store]', row).value,
    start: $('[data-weekly-start]', row).value,
    end: $('[data-weekly-end]', row).value,
  }));
  if (pattern.length !== 7 || pattern.every((item) => item.dayOff) || pattern.some((item) => !item.storeId || (!item.dayOff && (!item.start || !item.end || item.end <= item.start)))) {
    toast(errorText('INVALID_WEEK_PATTERN'), true);
    return;
  }
  const employeeId = $('#weeklyEmployee').value;
  const employee = state.data.employees.find((item) => item.user_id === employeeId);
  const monthLabel = new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'es-ES', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));
  if (!confirm(L(
    `将按这份周模板覆盖 ${employee?.full_name || ''} ${monthLabel} 已有排班，之后仍可改单日。确定继续？`,
    `Se sobrescribirá el horario de ${employee?.full_name || ''} para ${monthLabel}. Después podrás modificar días concretos. ¿Continuar?`,
  ))) return;
  if (button.disabled) return;
  button.disabled = true;
  try {
    const result = await adminAction({ action: 'publish_month_schedule', employeeId, month, pattern, notes: $('#weeklyNotes').value });
    await finishMutation(L(`整月排班已生成，共${result.count}天`, `Horario mensual generado: ${result.count} días`));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function saveSingleSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const dayOff = $('#singleScheduleDayOff').checked;
  const date = $('#singleScheduleDate').value;
  const start = $('#singleScheduleStart').value;
  const end = $('#singleScheduleEnd').value;
  if (!dayOff && end <= start) { toast(errorText('INVALID_SCHEDULE_TIME'), true); return; }
  if (button.disabled) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'upsert_schedule', employeeId: $('#singleScheduleEmployee').value, storeId: $('#singleScheduleStore').value, workDate: date, dayOff, startsAt: dayOff ? null : madridLocalToIso(date, start), endsAt: dayOff ? null : madridLocalToIso(date, end), notes: $('#singleScheduleNotes').value });
    await finishMutation(L('单日排班已保存', 'Cambio del día guardado'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function reviewRequest(button) {
  const note = prompt(button.dataset.review === 'approved' ? L('批准备注（可留空）', 'Nota de aprobación (opcional)') : L('请填写拒绝原因', 'Indica el motivo del rechazo'));
  if (button.dataset.review === 'rejected' && !note) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'review_request', requestId: button.dataset.id, status: button.dataset.review, note: note || '' });
    await finishMutation(L('申请状态已更新', 'Solicitud actualizada'));
  }
  catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function grantGps(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const from = $('#gpsFrom').value;
  const until = $('#gpsUntil').value;
  const allowedEvents = [...$('#gpsEvents').selectedOptions].map((option) => option.value);
  if (!from || !until || until <= from) { toast(errorText('INVALID_TIME_RANGE'), true); return; }
  if (!allowedEvents.length) { toast(errorText('NO_ALLOWED_EVENTS'), true); return; }
  if (button.disabled) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'grant_gps', employeeId: $('#gpsEmployee').value, storeId: $('#gpsStore').value, validFrom: madridLocalToIso(from.slice(0,10), from.slice(11)), validUntil: madridLocalToIso(until.slice(0,10), until.slice(11)), allowedEvents, reason: $('#gpsReason').value });
    await finishMutation(L('GPS临时授权已创建', 'Autorización GPS creada'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function revokeGps(button) {
  if (!confirm(L('确定撤销此GPS授权？', '¿Revocar esta autorización GPS?'))) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'revoke_gps', permissionId: button.dataset.revokeGps });
    await finishMutation(L('GPS授权已撤销', 'Autorización GPS revocada'));
  }
  catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function saveStore(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'update_store', storeId: form.dataset.storeId, address: form.elements.address.value, latitude: Number(form.elements.latitude.value), longitude: Number(form.elements.longitude.value), radiusM: Number(form.elements.radius.value) });
    await finishMutation(L('店铺GPS已保存', 'GPS de tienda guardado'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function toggleKiosk(button) {
  const active = button.dataset.active === 'true';
  if (!confirm(active ? L('确定启用这台电脑？', '¿Activar este ordenador?') : L('停用后此电脑将无法打卡，确定继续？', 'Este ordenador dejará de fichar. ¿Continuar?'))) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'set_kiosk_active', deviceId: button.dataset.toggleKiosk, active });
    await finishMutation(active ? L('店铺电脑已启用', 'Ordenador activado') : L('店铺电脑已停用', 'Ordenador desactivado'));
  }
  catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

async function saveCorrection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const date = $('#correctionDate').value;
  const iso = (selector) => $(selector).value ? madridLocalToIso(date, $(selector).value) : null;
  if (!$('#correctionClockIn').value && !$('#correctionClockOut').value && !$('#correctionBreakStart').value && !$('#correctionBreakEnd').value) {
    toast(L('请至少填写一个修正时间', 'Indica al menos una hora corregida'), true); return;
  }
  const suppliedTimes = [$('#correctionClockIn').value, $('#correctionBreakStart').value, $('#correctionBreakEnd').value, $('#correctionClockOut').value].filter(Boolean);
  if (suppliedTimes.some((value, index) => index > 0 && value <= suppliedTimes[index - 1])) {
    toast(errorText('INVALID_TIME_RANGE'), true); return;
  }
  if (button.disabled) return;
  button.disabled = true;
  try {
    await adminAction({ action: 'correct_attendance', employeeId: $('#correctionEmployee').value, workDate: date, clockIn: iso('#correctionClockIn'), breakStart: iso('#correctionBreakStart'), breakEnd: iso('#correctionBreakEnd'), clockOut: iso('#correctionClockOut'), reason: $('#correctionReason').value });
    await finishMutation(L('审计修正已保存，原始记录未改变', 'Corrección guardada; el original no se ha modificado'));
  } catch (error) { toast(errorText(error), true); }
  finally { button.disabled = false; }
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportCsv() {
  const header = ['employee_no', 'employee', 'date', 'store', 'clock_in', 'break_start', 'break_end', 'clock_out', 'shift_duration', 'break_duration', 'corrected', 'correction_reason'];
  const rows = state.data.attendance.map((item) => [item.employee_no, item.employee_name, item.work_date, item.store_name, timeText(item.clock_in), timeText(item.break_start), timeText(item.break_end), timeText(item.clock_out), shiftDurationText(item), breakDurationText(item), item.corrected ? 'YES' : 'NO', item.correction_reason || '']);
  const csv = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `HOLA_SEVILLA_attendance_${madridDate().slice(0,7)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderCurrent() {
  if (!configured) renderConfigurationError();
  else if (state.profile) renderPortal();
  else if (document.querySelector('.kiosk-shell')) renderKiosk();
  else renderAuth();
}

async function initialize() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'es';
  if (!configured) { renderConfigurationError(); return; }
  const { data } = await client.auth.getSession();
  if (data.session?.user) {
    const profile = await loadProfile(data.session.user.id);
    if (profile?.active) {
      state.session = data.session; state.profile = profile; await loadPortalData(); renderPortal();
    } else { await client.auth.signOut(); renderAuth(); }
  } else { renderAuth(); }
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.session = null; state.profile = null; state.data = {}; state.health = null; state.busy = false; }
  });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

setInterval(() => {
  const kioskClock = $('#kioskTime'); if (kioskClock) kioskClock.textContent = timeText(new Date());
  const portalClock = $('#portalClock'); if (portalClock) portalClock.textContent = timeText(new Date());
}, 1000);

initialize().catch((error) => { app.innerHTML = `<main class="setup-page"><section class="setup-card"><h1>${L('应用启动失败', 'No se pudo iniciar')}</h1><p>${escapeHTML(errorText(error))}</p></section></main>`; });
