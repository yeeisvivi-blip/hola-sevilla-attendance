import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.102.0/+esm';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');
const config = window.HOLA_CONFIG || {};
const MADRID_TZ = config.timezone || 'Europe/Madrid';
const KIOSK_STORAGE = 'holaSevillaKioskV1';
const LANG_STORAGE = 'holaSevillaLanguage';
const PUNCH_CACHE_STORAGE = 'holaSevillaRecentPunchesV1';
const FUNCTION_RELEASES = {
  'admin-api': '2026.09.15.3',
  'kiosk-punch': '2026.09.15.4',
  'gps-punch': '2026.09.24.1',
};
const SCHEDULE_START_MONTH = '2026-09';
const REQUEST_TIMEOUT_MS = 20_000;

function withTimeout(promise, timeoutMs = REQUEST_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('REQUEST_TIMEOUT')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
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

function rememberConfirmedPunch(eventType, occurredAt, storeId = null) {
  if (!state.profile?.user_id || !occurredAt) return;
  const workDate = madridDate(new Date(occurredAt));
  const current = readJSON(PUNCH_CACHE_STORAGE, []);
  const retained = Array.isArray(current) ? current.filter((item) =>
    item?.employee_id && item?.work_date >= addDays(madridDate(), -2)
    && !(item.employee_id === state.profile.user_id && item.work_date === workDate && item.event_type === eventType)
  ) : [];
  retained.push({
    employee_id: state.profile.user_id,
    store_id: storeId || null,
    work_date: workDate,
    event_type: eventType,
    occurred_at: occurredAt,
  });
  localStorage.setItem(PUNCH_CACHE_STORAGE, JSON.stringify(retained.slice(-24)));
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
    TOO_EARLY_TO_CLOCK_IN: L('还未到打卡时间，上班卡只能在排班开始前5分钟内打', 'Aún es pronto. La entrada solo puede ficharse desde 5 minutos antes del turno.'),
    INVALID_WORKDATE: L('日期格式不正确，请重新选择日期', 'La fecha no es válida. Selecciónala de nuevo'),
    INVALID_SCHEDULE_TIME: L('排班结束时间必须晚于开始时间', 'El fin del turno debe ser posterior al inicio'),
    INVALID_MONTH: L('请选择有效的排班月份', 'Selecciona un mes válido'),
    INVALID_WEEK_PATTERN: L('请检查一周模板，每个工作日都要填写正确的店铺和时间', 'Revisa la plantilla semanal: cada día laborable necesita tienda y horario válidos'),
    INVALID_SCHEDULE_KIND: L('请选择工作、休息或年假', 'Selecciona trabajo, descanso o vacaciones'),
    ANNUAL_LEAVE_LIMIT_REACHED: L('该员工本年度已达到30天年假上限', 'Este empleado ya ha alcanzado el límite anual de 30 días de vacaciones'),
    NO_SCHEDULE_TODAY: L('今天没有已发布的排班，不能打卡', 'No hay horario publicado para hoy. No puedes fichar'),
    SCHEDULE_DAY_OFF: L('今天是排班休息日或年假，不能打卡', 'Hoy es día libre o de vacaciones según el horario. No puedes fichar'),
    INVALID_CORRECTION: L('请至少填写一个有效的修正时间', 'Indica al menos una hora válida para corregir'),
    INVALID_CORRECTION_KIND: L('请选择有效的考勤处理类型', 'Selecciona un tipo de corrección válido'),
    INVALID_ABSENCE_TIMES: L('登记缺勤时不应填写打卡时间', 'No introduzcas horas al registrar una ausencia'),
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
    CAMERA_PERMISSION_DENIED: L('必须允许摄像头权限才能完成上下班打卡', 'Debes permitir el acceso a la cámara para fichar la entrada o la salida'),
    CAMERA_UNAVAILABLE: L('无法使用电脑摄像头，请检查摄像头后重试，或使用本人手机在店铺100米内打卡', 'No se puede usar la cámara. Compruébala o ficha con tu móvil dentro de 100 m'),
    CAMERA_CANCELLED: L('已取消拍照，本次打卡没有提交', 'Foto cancelada. El fichaje no se ha enviado'),
    PHOTO_REQUIRED: L('上下班打卡必须拍摄现场照片', 'La entrada y la salida requieren una foto en el momento'),
    PHOTO_INVALID: L('现场照片无效，请重新拍摄', 'La foto no es válida. Hazla de nuevo'),
    PHOTO_STALE: L('照片已超时，请重新拍摄', 'La foto ha caducado. Hazla de nuevo'),
    PHOTO_TOO_LARGE: L('照片文件过大，请重新拍摄', 'La foto es demasiado grande. Hazla de nuevo'),
    PHOTO_UPLOAD_FAILED: L('照片上传失败，本次打卡未记录，请检查网络后重试', 'No se pudo subir la foto y el fichaje no se registró. Comprueba la red'),
    PHOTO_STORAGE_UNAVAILABLE: L('照片存储暂时不可用，本次打卡未记录', 'El almacenamiento de fotos no está disponible y el fichaje no se registró'),
    PHOTO_NOT_FOUND: L('照片不存在或已超过30天自动删除', 'La foto no existe o se eliminó automáticamente después de 30 días'),
    REQUEST_ALREADY_REVIEWED: L('该申请已处理，请刷新查看最新状态', 'La solicitud ya fue revisada. Actualiza para ver el estado'),
    RECORD_NOT_FOUND: L('记录不存在或已发生变化，请刷新后重试', 'El registro no existe o ha cambiado. Actualiza e inténtalo de nuevo'),
    UNAUTHENTICATED: L('登录已过期，请重新登录', 'La sesión ha caducado. Inicia sesión de nuevo'),
    SESSION_EXPIRED: L('登录已过期，请重新登录', 'La sesión ha caducado. Inicia sesión de nuevo'),
    FORBIDDEN: L('当前账号没有执行此操作的权限', 'Esta cuenta no tiene permiso para realizar esta acción'),
    NETWORK_ERROR: L('无法连接服务器，请检查网络后重试', 'No se pudo conectar con el servidor. Comprueba la red'),
    REQUEST_TIMEOUT: L('服务器响应超时，请稍后重试', 'El servidor tardó demasiado. Inténtalo de nuevo'),
    INVALID_SERVER_RESPONSE: L('服务器返回异常，请刷新后重试', 'Respuesta no válida del servidor. Actualiza e inténtalo de nuevo'),
    DATA_LOAD_FAILED: L('数据加载失败，请检查网络并刷新', 'No se pudieron cargar los datos. Comprueba la red y actualiza'),
    PGRST202: L('缺少审计修复函数，请先执行配套SQL', 'Falta la función de corrección. Ejecuta primero el SQL de reparación'),
    MULTIPLE_CORRECTIONS_REQUIRE_SCHEMA_REVIEW: L('当天有多条修正记录，需要检查数据库结构', 'Hay varias correcciones para el día; revisa el esquema de la base de datos'),
    CORRECTION_KIND_REQUIRES_SCHEMA_REVIEW: L('当前记录的修正类型需要检查数据库结构', 'El tipo de corrección requiere revisar el esquema'),
    INVALID_CORRECTION_KIND: L('当前后端暂不支持此修正类型', 'El servidor no admite este tipo de corrección'),
    OPERATION_FAILED: L('操作未完成，请刷新后重试', 'La operación no se completó. Actualiza e inténtalo de nuevo'),
  };
  const normalized = code.toUpperCase().replace(/\s+/g, '_');
  if (messages[normalized]) return messages[normalized];
  const messageCode = String(error?.message || '').toUpperCase().replace(/\s+/g,'_');
  if (messages[messageCode]) return messages[messageCode];
  if (/FAILED TO (SEND|FETCH)|FAILED TO FETCH|NETWORK|LOAD FAILED/i.test(code)) return messages.NETWORK_ERROR;
  if (/JWT|TOKEN.*EXPIRED|SESSION.*EXPIRED/i.test(code)) return messages.SESSION_EXPIRED;
  const detail = [code, error?.message, error?.error].filter(Boolean).join(' ');
  if (normalized === 'PHONE_EXISTS' || normalized === 'PHONE_ALREADY_EXISTS' || normalized === 'PHONE_EXISTS_IN_AUTH'
    || (/phone/i.test(detail) && /DUPLICATE|ALREADY (REGISTERED|EXISTS)|UNIQUE CONSTRAINT/i.test(detail))) {
    return L('手机号已存在，请检查是否重复创建', 'El teléfono ya existe. Comprueba si la cuenta está duplicada');
  }
  if (normalized === '23505' || /DUPLICATE|ALREADY (REGISTERED|EXISTS)|UNIQUE CONSTRAINT/i.test(detail)) {
    return L('保存失败：记录存在唯一性冲突，请检查后台约束（23505）', 'No se pudo guardar: conflicto de unicidad. Revisa las restricciones del servidor (23505)');
  }
  if (normalized === '23502' || /null value.*not-null constraint/i.test(detail)) {
    return L('保存失败：数据库不允许必填字段为空，请检查排班字段约束（23502）', 'No se pudo guardar: un campo obligatorio está vacío. Revisa las restricciones del horario (23502)');
  }
  if (normalized === '23514' || /violates check constraint/i.test(detail)) {
    return L('保存失败：数据不符合数据库校验规则（23514）', 'No se pudo guardar: los datos incumplen una restricción de validación (23514)');
  }
  if (normalized === '42P10' || /no unique or exclusion constraint matching/i.test(detail)) {
    return L('保存失败：数据库缺少保存操作所需的唯一约束（42P10）', 'No se pudo guardar: falta la restricción única necesaria para esta operación (42P10)');
  }
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

function attendanceSchedule(item) {
  return (state.data.schedules || []).find((schedule) => schedule.employee_id === item?.employee_id
    && schedule.work_date === item?.work_date && scheduleKind(schedule) === 'work') || null;
}

function scheduledEffectiveMinutes(item, schedule = attendanceSchedule(item)) {
  if (!schedule || scheduleKind(schedule) !== 'work') return null;
  const actualClockIn = attendanceValue(item, 'actual', 'clock_in');
  const actualClockOut = attendanceValue(item, 'actual', 'clock_out');
  const verified = Boolean(item?.corrected && item?.correction_kind !== 'absence');
  if ((!actualClockIn || !actualClockOut) && !verified) return null;
  const scheduledMinutes = durationMinutes(schedule.starts_at, schedule.ends_at);
  if (scheduledMinutes === null) return null;
  const effectiveRecord = verified ? payrollAttendance(item) : actualAttendance(item);
  const hasBreakStart = Boolean(effectiveRecord.break_start);
  const hasBreakEnd = Boolean(effectiveRecord.break_end);
  if (hasBreakStart !== hasBreakEnd) return null;
  const breakMinutes = hasBreakStart ? durationMinutes(effectiveRecord.break_start, effectiveRecord.break_end) : 0;
  if (breakMinutes === null) return null;
  return Math.max(0, scheduledMinutes - breakMinutes);
}

function scheduledEffectiveText(item, schedule = attendanceSchedule(item)) {
  const minutes = scheduledEffectiveMinutes(item, schedule);
  if (minutes === null) return '—';
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function attendanceValue(item, dataset, field) {
  const key = `${dataset}_${field}`;
  return Object.prototype.hasOwnProperty.call(item || {}, key) ? item[key] : item?.[field] || null;
}

function payrollAttendance(item) {
  return {
    ...item,
    clock_in: attendanceValue(item, 'payroll', 'clock_in'),
    break_start: attendanceValue(item, 'payroll', 'break_start'),
    break_end: attendanceValue(item, 'payroll', 'break_end'),
    clock_out: attendanceValue(item, 'payroll', 'clock_out'),
  };
}

function actualAttendance(item) {
  return {
    ...item,
    clock_in: attendanceValue(item, 'actual', 'clock_in'),
    break_start: attendanceValue(item, 'actual', 'break_start'),
    break_end: attendanceValue(item, 'actual', 'break_end'),
    clock_out: attendanceValue(item, 'actual', 'clock_out'),
  };
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

function monthDates(monthString) {
  const end = monthLastDate(monthString);
  if (!end) return [];
  const dates = [];
  for (let date = `${monthString}-01`; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

function previousMonthString(monthString) {
  const [year, month] = String(monthString).split('-').map(Number);
  if (!year || month < 1 || month > 12) return '';
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
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
    const { data, error } = await withTimeout(client.auth.signInWithPassword({
      email: loginEmailFromPhone($('#loginPhone').value),
      password: $('#loginPassword').value,
    }));
    if (error) throw error;
    const profile = await loadProfile(data.user.id);
    if (!profile || !profile.active || (desiredRole === 'manager' && profile.role !== 'manager') || (desiredRole === 'employee' && profile.role !== 'employee')) {
      await client.auth.signOut();
      status.textContent = desiredRole === 'manager' ? L('此账号不是VIVI管理员', 'Esta cuenta no es administradora') : L('此账号不是员工账号', 'Esta cuenta no es de empleado');
      return;
    }
    state.session = data.session; state.profile = profile; state.view = 'home';
    await withTimeout(loadPortalData()); renderPortal();
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
  const { data, error } = await withTimeout(client.from('profiles').select('*, stores(id,name,address)').eq('user_id', userId).single());
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
    const { data, error } = await withTimeout(client.auth.signInWithPassword({
      email: loginEmailFromPhone($('#kioskManagerPhone').value),
      password: $('#kioskManagerPassword').value,
    }));
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
  const started = Date.now();
  let stage = 'session';
  const headers = { 'Content-Type': 'application/json', apikey: config.supabasePublishableKey };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let abortHandler;
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(new Error('REQUEST_TIMEOUT'));
    controller.signal.addEventListener('abort', abortHandler, {once:true});
  });
  try {
    if (authenticated) {
      const { data, error } = await Promise.race([client.auth.getSession(),aborted]);
      if (error || !data?.session?.access_token) throw new Error('SESSION_EXPIRED');
      headers.Authorization = `Bearer ${data.session.access_token}`;
    }
    stage = 'request';
    const response = await Promise.race([fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
      method:'POST',headers,body:JSON.stringify(body),signal:controller.signal,cache:'no-store',
    }),aborted]);
    stage = 'response';
    const responseText = await Promise.race([response.text(),aborted]);
    let result;
    try { result = JSON.parse(responseText); }
    catch { throw new Error('INVALID_SERVER_RESPONSE'); }
    if (!response.ok || result?.error) {
      const error = new Error(result?.error || `HTTP_${response.status}`);
      Object.assign(error,{status:response.status,code:result?.code,detail:result?.detail,recordCounts:result?.recordCounts});throw error;
    }
    return result;
  } catch(original) {
    const error = controller.signal.aborted || original?.name === 'AbortError' ? new Error('REQUEST_TIMEOUT')
      : original instanceof TypeError ? new Error('NETWORK_ERROR') : original;
    error.diagnostic = {service:name,action:body.action || 'punch',stage,elapsedMs:Date.now()-started,status:error.status || null,code:normalizedErrorCode(error)};
    throw error;
  } finally { clearTimeout(timeout);controller.signal.removeEventListener('abort',abortHandler); }
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
      ${state.kioskSuccess ? `<div class="success-panel"><b>✓ ${escapeHTML(state.kioskSuccess.name)}</b><span>${escapeHTML(eventLabel(state.kioskSuccess.eventType))} · ${escapeHTML(timeText(state.kioskSuccess.occurredAt))}</span><p>${state.kioskSuccess.photoCaptured ? L('打卡已记录，现场照片已安全上传且不会保存在电脑中。', 'Fichaje registrado. La foto se subió de forma segura y no se guardó en el ordenador.') : L('打卡已记录，系统将自动退出。', 'Fichaje registrado. La pantalla se cerrará automáticamente.')}</p></div>` : `
        <p class="eyebrow">FICHAJE EN TIENDA</p><h1>${L('选择你的姓名', 'Elige tu nombre')}</h1><p>${L('确认姓名后输入个人6位PIN。上班和下班会自动拍摄现场照片；照片不会保存在这台电脑中。', 'Después introduce tu PIN personal de 6 cifras. En la entrada y la salida se hará una foto automática que no se guardará en este ordenador.')}</p>
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
  if (!employees.length) return `<div class="empty">${L('今天没有排在此店的员工，请检查已发布排班', 'No hay empleados asignados hoy a esta tienda. Revisa el horario publicado')}</div>`;
  return employees.map((employee) => `<button class="employee-choice ${selected?.user_id === employee.user_id ? 'active' : ''}" type="button" data-employee="${employee.user_id}"><b>${escapeHTML(employee.full_name)}</b><small>${employee.events.length ? eventLabel(employee.events.at(-1).event_type) + ' ' + timeText(employee.events.at(-1).occurred_at) : L('尚未打卡', 'Sin fichar')}</small></button>`).join('');
}

function bindKiosk() {
  $('#exitKiosk')?.addEventListener('click', () => { clearTimeout(kioskResetTimer); renderAuth(); });
  $('#kioskRefresh')?.addEventListener('click', openKiosk);
  $('#employeeSearch')?.addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    const list = state.kioskEmployees.filter((employee) => employee.full_name.toLowerCase().includes(term));
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

function kioskPhotoRequired(eventType) {
  return eventType === 'clock_in' || eventType === 'clock_out';
}

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureKioskPhoto(eventType) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('CAMERA_UNAVAILABLE');
  const modalRoot = $('#modalRoot');
  let stream = null;
  let video = null;
  try {
    modalRoot.innerHTML = `<section class="modal camera-modal" role="dialog" aria-modal="true" aria-labelledby="cameraTitle">
      <div class="modal-head"><div><p class="eyebrow">LIVE PHOTO</p><h2 id="cameraTitle">${eventLabel(eventType)} · ${L('现场拍照', 'Foto en directo')}</h2></div><button class="close-btn" id="cameraCancel" type="button" aria-label="${L('取消', 'Cancelar')}">×</button></div>
      <p>${L('请本人正对摄像头。画面将在2秒后自动拍摄，照片不会保存在电脑里。', 'Mira de frente a la cámara. La foto se hará automáticamente en 2 segundos y no se guardará en el ordenador.')}</p>
      <div class="camera-frame"><video id="kioskCamera" autoplay muted playsinline></video><strong id="cameraCountdown">…</strong></div>
      <p class="camera-status" id="cameraStatus">${L('正在启动摄像头…', 'Iniciando la cámara…')}</p>
    </section>`;
    $('#cameraCancel')?.addEventListener('click', () => { modalRoot.innerHTML = ''; });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') throw new Error('CAMERA_PERMISSION_DENIED');
      throw new Error('CAMERA_UNAVAILABLE');
    }
    video = $('#kioskCamera');
    if (!video) throw new Error('CAMERA_CANCELLED');
    video.srcObject = stream;
    if (video.readyState < 2) {
      await Promise.race([
        new Promise((resolve, reject) => {
          video.addEventListener('loadeddata', resolve, { once: true });
          video.addEventListener('error', () => reject(new Error('CAMERA_UNAVAILABLE')), { once: true });
        }),
        waitMs(10_000).then(() => { throw new Error('CAMERA_UNAVAILABLE'); }),
      ]);
    }
    await video.play();
    for (const number of [2, 1]) {
      if (!video.isConnected) throw new Error('CAMERA_CANCELLED');
      $('#cameraCountdown').textContent = String(number);
      $('#cameraStatus').textContent = L('请保持正对摄像头', 'Mantén la mirada hacia la cámara');
      await waitMs(1000);
    }
    if (!video.isConnected || !video.videoWidth || !video.videoHeight) throw new Error('CAMERA_UNAVAILABLE');

    const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('CAMERA_UNAVAILABLE');
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const photoDataUrl = canvas.toDataURL('image/jpeg', 0.72);
    canvas.width = 1;
    canvas.height = 1;
    if (!photoDataUrl.startsWith('data:image/jpeg;base64,') || photoDataUrl.length > 600_100) throw new Error('PHOTO_TOO_LARGE');
    $('#cameraCountdown').textContent = '✓';
    $('#cameraStatus').textContent = L('照片已拍摄，正在安全上传…', 'Foto realizada. Subiendo de forma segura…');
    return { photoDataUrl, photoCapturedAt: new Date().toISOString() };
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    if (video) video.srcObject = null;
    if (modalRoot) modalRoot.innerHTML = '';
  }
}

async function kioskPunch(eventType) {
  const pin = $('#kioskPin')?.value || '';
  if (!/^\d{6}$/.test(pin)) { toast(L('请输入6位PIN', 'Introduce el PIN de 6 cifras'), true); return; }
  if (state.busy) return;
  state.busy = true;
  $$('[data-punch]').forEach((button) => { button.disabled = true; });
  try {
    const photo = kioskPhotoRequired(eventType) ? await captureKioskPhoto(eventType) : null;
    const result = await rawFunction('kiosk-punch', {
      action: 'punch', ...state.kiosk, employeeId: state.kioskSelected, pin, eventType,
      ...(photo || {}),
    });
    state.kioskSuccess = { name: result.employee.name, eventType, occurredAt: result.event.occurredAt, photoCaptured: result.photoCaptured };
    renderKiosk();
    kioskResetTimer = setTimeout(() => openKiosk(), 5000);
  } catch (error) {
    if (forgetKioskIfInvalid(error)) { toast(errorText(error), true); renderAuth(); return; }
    toast(errorText(error), true);
    const pinInput = $('#kioskPin');
    if (pinInput) { pinInput.value = ''; pinInput.focus(); }
  }
  finally {
    state.busy = false;
    $$('[data-punch]').forEach((button) => { button.disabled = false; });
  }
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
  const scheduleStart = monthStart < addDays(today, -7) ? monthStart : addDays(today, -7);
  const scheduleEnd = monthLastDate(today.slice(0, 7)) > addDays(today, 14) ? monthLastDate(today.slice(0, 7)) : addDays(today, 14);
  const now = new Date().toISOString();
  const dayStart = madridLocalToIso(today, '00:00');
  const dayEnd = madridLocalToIso(addDays(today, 1), '00:00');
  const [stores, schedules, attendance, requests, permissions, todayEvents, portalEvents] = await Promise.all([
    client.from('stores').select('*').eq('active', true).order('name'),
    client.from('schedules').select('*, stores(name,address)').gte('work_date', scheduleStart).lte('work_date', scheduleEnd).order('work_date'),
    client.from('attendance_daily').select('*').gte('work_date', monthStart).lte('work_date', today).order('work_date', { ascending: false }),
    client.from('requests').select('*').order('created_at', { ascending: false }).limit(50),
    client.from('gps_permissions').select('*, stores(name,address,latitude,longitude,radius_m)').eq('active', true).lte('valid_from', now).gte('valid_until', now).order('valid_until'),
    client.from('attendance_events').select('employee_id,store_id,event_type,occurred_at')
      .eq('employee_id', state.profile.user_id).gte('occurred_at', dayStart).lt('occurred_at', dayEnd)
      .order('occurred_at'),
    client.rpc('hola_portal_today_events_v1'),
  ]);
  assertQueryResults([stores, schedules, attendance, requests, permissions]);
  const attendanceRows = attendance.data || [];
  const cachedEvents = readJSON(PUNCH_CACHE_STORAGE, []).filter((item) =>
    item?.employee_id === state.profile.user_id && item?.work_date === today
  );
  const serverEventMap = new Map();
  [...(!todayEvents.error ? todayEvents.data || [] : []), ...(!portalEvents.error ? portalEvents.data || [] : [])]
    .forEach((event) => {
      if (event?.employee_id === state.profile.user_id) {
        serverEventMap.set(`${event.employee_id}:${event.event_type}:${event.occurred_at}`, event);
      }
    });
  const serverEvents = [...serverEventMap.values()];
  const effectiveEvents = [...serverEvents, ...cachedEvents].sort((a, b) =>
    String(a.occurred_at).localeCompare(String(b.occurred_at))
  );
  if (effectiveEvents.length) {
    const existingIndex = attendanceRows.findIndex((item) => item.work_date === today);
    const existing = existingIndex >= 0 ? attendanceRows[existingIndex] : {
      employee_id: state.profile.user_id,
      store_id: effectiveEvents[0]?.store_id || null,
      work_date: today,
    };
    const merged = { ...existing };
    for (const event of effectiveEvents) {
      const field = ({ clock_in: 'clock_in', break_start: 'break_start', break_end: 'break_end', clock_out: 'clock_out' })[event.event_type];
      if (!field) continue;
      const actualField = `actual_${field}`;
      if (!merged[actualField]) merged[actualField] = event.occurred_at;
      // Compatibility fallback for deployments that do not yet expose actual_*.
      if (!merged[field]) merged[field] = event.occurred_at;
    }
    if (existingIndex >= 0) attendanceRows[existingIndex] = merged;
    else attendanceRows.unshift(merged);
  }
  if (todayEvents.error) console.warn('Attendance event fallback unavailable:', todayEvents.error);
  if (portalEvents.error) console.warn('Portal live-event RPC unavailable:', portalEvents.error);
  state.data = {
    stores: stores.data || [],
    schedules: schedules.data || [],
    attendance: attendanceRows,
    requests: requests.data || [],
    permissions: permissions.data || [],
  };
}
async function loadManagerData() {
  const today = madridDate();
  const attendanceMonth = state.attendanceMonth || today.slice(0,7);
  const monthStart = `${attendanceMonth}-01`;
  const attendanceEnd = attendanceMonth === today.slice(0,7) ? today : monthLastDate(attendanceMonth);
  const scheduleMonth = currentScheduleMonth();
  const scheduleStart = addDays(`${scheduleMonth}-01`, -7);
  const scheduleEnd = monthLastDate(scheduleMonth);
  const scheduleQueryStart = scheduleStart < monthStart ? scheduleStart : monthStart;
  const scheduleQueryEnd = scheduleEnd > today ? scheduleEnd : today;
  const leaveYear = scheduleMonth.slice(0, 4);
  const dayStart = madridLocalToIso(today, '00:00');
  const dayEnd = madridLocalToIso(addDays(today, 1), '00:00');
  const photoStart = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [stores, employees, schedules, todaySchedules, events, managerEvents, requests, permissions, devices, attendance, todayAttendance, audits, photoEvents, annualLeave] = await Promise.all([
    client.from('stores').select('*').order('name'),
    client.from('profiles').select('*, stores(name)').eq('role', 'employee').order('full_name'),
    client.from('schedules').select('*, stores(name)').gte('work_date', scheduleQueryStart).lte('work_date', scheduleQueryEnd).order('work_date'),
    client.from('schedules').select('*, stores(name)').eq('work_date', today).order('starts_at'),
    client.from('attendance_events').select('*, stores(name)').gte('occurred_at', dayStart).lt('occurred_at', dayEnd).order('occurred_at'),
    client.rpc('hola_portal_today_events_v1'),
    client.from('requests').select('*').order('created_at', { ascending: false }).limit(100),
    client.from('gps_permissions').select('*, stores(name)').eq('active', true).gte('valid_until', new Date().toISOString()).order('valid_until'),
    client.from('kiosk_devices').select('*, stores(name)').order('created_at', { ascending: false }),
    client.from('attendance_daily').select('*').gte('work_date', monthStart).lte('work_date', attendanceEnd).order('work_date', { ascending: false }),
    client.from('attendance_daily').select('*').eq('work_date', today),
    client.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(100),
    client.from('attendance_events').select('id, employee_id, store_id, event_type, source, occurred_at, metadata, stores(name)')
      .eq('source', 'kiosk').in('event_type', ['clock_in', 'clock_out']).gte('occurred_at', photoStart)
      .order('occurred_at', { ascending: false }).limit(1500),
    client.from('schedules').select('employee_id, work_date').eq('schedule_kind', 'annual_leave').eq('published', true)
      .gte('work_date', `${leaveYear}-01-01`).lte('work_date', `${leaveYear}-12-31`).order('work_date'),
  ]);
  const results = [stores, employees, schedules, todaySchedules, requests, permissions, devices, attendance, todayAttendance, audits, photoEvents];
  assertQueryResults(results);
  const employeeById = new Map((employees.data || []).map((employee) => [employee.user_id, employee]));
  const storeById = new Map((stores.data || []).map((store) => [store.id, store]));
  const attachEmployee = (items) => (items || []).map((item) => ({ ...item, profiles: employeeById.get(item.employee_id) || null }));
  const liveEventsById = new Map();
  [...(events.data || []), ...(managerEvents.error ? [] : managerEvents.data || [])].forEach((event) => {
    if (!event?.id) return;
    const store = event.stores || storeById.get(event.store_id) || (event.store_name ? { name: event.store_name } : null);
    liveEventsById.set(event.id, { ...event, stores: store });
  });
  const liveEvents = attachEmployee([...liveEventsById.values()]);
  if (managerEvents.error) console.warn('Manager live-event RPC unavailable:', managerEvents.error);
  const liveEventKeys = new Set(liveEvents.map((event) => `${event.employee_id}:${event.event_type}`));
  (todayAttendance.data || []).forEach((record) => {
    ['clock_in', 'break_start', 'break_end', 'clock_out'].forEach((eventType) => {
      const occurredAt = attendanceValue(record, 'actual', eventType);
      const key = `${record.employee_id}:${eventType}`;
      if (!occurredAt || liveEventKeys.has(key)) return;
      liveEvents.push({
        id: `daily-${record.employee_id}-${eventType}`,
        employee_id: record.employee_id,
        store_id: record.store_id,
        event_type: eventType,
        occurred_at: occurredAt,
        source: record.source || 'daily',
        metadata: {},
        stores: storeById.get(record.store_id) || null,
        profiles: employeeById.get(record.employee_id) || null,
      });
      liveEventKeys.add(key);
    });
  });
  liveEvents.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  state.data = {
    stores: stores.data || [],
    employees: employees.data || [],
    schedules: attachEmployee(schedules.data),
    todaySchedules: attachEmployee(todaySchedules.data),
    events: liveEvents,
    requests: attachEmployee(requests.data),
    permissions: attachEmployee(permissions.data),
    devices: devices.data || [],
    attendance: attendance.data || [],
    todayAttendance: todayAttendance.data || [],
    audits: audits.data || [],
    photoEvents: attachEmployee(photoEvents.data),
    annualLeave: annualLeave.data || [],
    annualLeaveReady: !annualLeave.error,
  };
  if (!state.health) await checkSystemHealth();
}

function navItems() {
  return state.profile.role === 'manager'
    ? [['home', L('四店总览', 'Resumen')], ['employees', L('员工账号', 'Empleados')], ['schedule', L('排班', 'Horarios')], ['requests', L('申请审批', 'Solicitudes')], ['gps', L('GPS授权', 'Permisos GPS')], ['stores', L('店铺设置', 'Tiendas')], ['export', L('考勤与报表', 'Jornada e informes')]]
    : [['home', L('我的首页', 'Mi inicio')], ['records', L('考勤记录', 'Mis fichajes')], ['requests', L('提交申请', 'Solicitudes')], ['profile', L('个人资料', 'Mi perfil')]];
}

function renderNavigation(items) {
  const button = ([view,label]) => `<button class="nav-btn ${state.view === view ? 'active' : ''}" data-view="${view}">${label}</button>`;
  if (state.profile.role !== 'manager') return items.map(button).join('');
  const daily = ['home','schedule','export','requests','employees'].map(view=>items.find(item=>item[0]===view)).filter(Boolean);
  const extra = items.filter(item=>!daily.includes(item));
  return daily.map(button).join('') + `<details class="nav-extra" ${extra.some(item=>item[0]===state.view) ? 'open' : ''}><summary>${L('更多设置','Más ajustes')}</summary>${extra.map(button).join('')}</details>`;
}

function renderPortal() {
  const items = navItems();
  if (!items.some(([view]) => view === state.view)) state.view = 'home';
  const currentTitle = items.find(([view]) => view === state.view)?.[1] || '';
  app.innerHTML = `<div class="app-layout">
    <aside class="sidebar"><div class="brand-lockup"><span class="brand-mark">H</span><span><b>HOLA!SEVILLA</b><small>CONTROL HORARIO</small></span></div>
      <nav>${renderNavigation(items)}</nav>
      <div class="sidebar-bottom"><div class="account-chip"><b>${escapeHTML(state.profile.full_name)}</b><small>${state.profile.role === 'manager' ? 'VIVI · MANAGER' : escapeHTML(state.profile.stores?.name || '')}</small></div><button class="ghost-btn" id="logout" type="button">${L('退出登录', 'Cerrar sesión')}</button></div>
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
  const actualRecord = actualAttendance(record || {});
  const permissions = state.data.permissions || [];
  const annualLeave = scheduleKind(schedule) === 'annual_leave';
  const status = actualRecord.clock_out ? L('今日已完成', 'Jornada completada') : actualRecord.clock_in ? L('工作进行中', 'Jornada en curso') : annualLeave ? L('今天年假', 'Vacaciones') : schedule?.is_day_off ? L('今天休息', 'Día libre') : L('等待到店', 'Pendiente de entrada');
  return `<div class="page-grid">
    <article class="card hero-card"><div><p class="eyebrow">${dateText(today)}</p><h2>${escapeHTML(state.profile.full_name)}，${status}</h2><p>${schedule ? (annualLeave ? L('排班：年假', 'Horario: vacaciones') : schedule.is_day_off ? L('排班：休息', 'Horario: descanso') : `${escapeHTML(schedule.stores?.name || '')} · ${timeText(schedule.starts_at)}—${timeText(schedule.ends_at)}`) : L('VIVI尚未发布今天的排班', 'VIVI todavía no ha publicado el horario de hoy')}</p></div><div class="hero-meta"><span>${L('手机定位：店铺100米内打卡', 'Móvil: fichaje dentro de 100 m')}</span><span>${L('店铺电脑：PIN打卡', 'Ordenador: fichaje con PIN')}</span></div></article>
    <article class="card summary-card"><div class="metric"><span>${L('上班', 'Entrada')}</span><b>${timeText(actualRecord.clock_in)}</b></div><div class="metric"><span>${L('休息', 'Pausa')}</span><b>${timeText(actualRecord.break_start)}–${timeText(actualRecord.break_end)}</b></div><div class="metric"><span>${L('下班', 'Salida')}</span><b>${timeText(actualRecord.clock_out)}</b></div></article>
  </div>
  ${renderScheduledMobilePunch(schedule, actualRecord)}
  ${permissions.map((permission) => renderGpsCard(permission, actualRecord)).join('')}
  <article class="card"><div class="section-head"><div><p class="eyebrow">NEXT 7 DAYS</p><h2>${L('近期排班', 'Próximos turnos')}</h2></div></div>${scheduleTable(state.data.schedules.filter((item) => item.work_date >= today).slice(0, 7), false)}</article>`;
}

function renderScheduledMobilePunch(schedule, record) {
  const nextActions = nextActionsFromRecord(record);
  let content;
  if (!schedule) {
    content = `<div class="callout warning"><b>${L('不能打卡', 'No disponible')}</b><span>${L('今天没有已发布的排班，请联系VIVI。', 'No hay horario publicado para hoy. Contacta con VIVI.')}</span></div>`;
  } else if (schedule.is_day_off) {
    content = scheduleKind(schedule) === 'annual_leave'
      ? `<div class="callout"><b>${L('今日年假', 'Vacaciones')}</b><span>${L('年假期间不显示打卡按钮。', 'No se muestran botones de fichaje durante las vacaciones.')}</span></div>`
      : `<div class="callout"><b>${L('今日休息', 'Día libre')}</b><span>${L('休息日不显示打卡按钮。', 'No se muestran botones de fichaje en un día libre.')}</span></div>`;
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

function scheduleKind(item) {
  if (item?.schedule_kind === 'annual_leave') return 'annual_leave';
  return item?.is_day_off ? 'day_off' : 'work';
}

const SICK_LEAVE_MARKER = '[SICK_LEAVE]';

const CORRECTION_REASON_PRESETS = Object.freeze({
  missed_punch: { zh: '员工忘记打卡', es: 'La persona trabajadora olvidó fichar.' },
  approved_request: { zh: '根据已批准的员工补卡申请修正', es: 'Corrección realizada conforme a la solicitud de fichaje aprobada.' },
  system_error: { zh: '打卡系统无法完成操作', es: 'El sistema de fichaje no permitió completar la operación.' },
  wrong_time: { zh: '原打卡时间与实际情况不符', es: 'La hora registrada no coincide con la hora real.' },
  early_departure: { zh: '员工实际提前离开店铺', es: 'La persona trabajadora salió de la tienda antes de la hora prevista.' },
  verified: { zh: '管理员核对排班及记录后修正', es: 'Corrección realizada por la administración tras verificar el horario y los registros.' },
  absence: { zh: '员工当天缺勤', es: 'La persona trabajadora estuvo ausente ese día.' },
  sick_leave: { zh: '员工当天病假', es: 'La persona trabajadora estuvo de baja médica ese día.' },
});

function splitBilingualReason(value) {
  const cleaned = String(value || '').replace(SICK_LEAVE_MARKER, '').trim();
  const bilingual = cleaned.match(/^\s*中文[：:]\s*([\s\S]*?)\s*\n\s*(?:Español|ES)[\s:：]+([\s\S]*)$/i);
  if (bilingual) return { zh: bilingual[1].trim(), es: bilingual[2].trim() };
  return /[\u3400-\u9fff]/.test(cleaned) ? { zh: cleaned, es: '' } : { zh: '', es: cleaned };
}

function bilingualReason(zh, es) {
  return `中文：${String(zh || '').trim()}\nEspañol: ${String(es || '').trim()}`;
}

function isSickLeaveRecord(item) {
  if (item?.correction_kind !== 'absence') return false;
  const reason = String(item.correction_reason || '');
  return reason.includes(SICK_LEAVE_MARKER) || /(^|[\s:：])(病假|baja médica)([\s:：]|$)/i.test(reason);
}

function visibleCorrectionReason(item) {
  return String(item?.correction_reason || '').replace(SICK_LEAVE_MARKER, '').trim();
}

function attendanceRowsForView() {
  const month = state.attendanceMonth || madridDate().slice(0, 7);
  const start = `${month}-01`;
  const end = monthLastDate(month);
  const employees = state.data.employees || (state.profile ? [state.profile] : []);
  const employeeById = new Map(employees.map((employee) => [employee.user_id, employee]));
  const schedules = (state.data.schedules || []).filter((item) => item.published !== false
    && item.work_date >= start && item.work_date <= end);
  const scheduleByKey = new Map(schedules.map((item) => [`${item.employee_id}:${item.work_date}`, item]));
  const rows = (state.data.attendance || []).filter((item) => item.work_date >= start && item.work_date <= end).map((item) => {
    const schedule = scheduleByKey.get(`${item.employee_id}:${item.work_date}`);
    const employee = employeeById.get(item.employee_id) || schedule?.profiles;
    return {
      ...item,
      employee_name: item.employee_name || employee?.full_name || '',
      store_name: item.store_name || schedule?.stores?.name || '',
      display_schedule_kind: schedule ? scheduleKind(schedule) : null,
      display_schedule: schedule || null,
    };
  });
  const existing = new Set(rows.map((item) => `${item.employee_id}:${item.work_date}`));
  schedules.forEach((schedule) => {
    const key = `${schedule.employee_id}:${schedule.work_date}`;
    if (existing.has(key)) return;
    const employee = employeeById.get(schedule.employee_id) || schedule.profiles;
    rows.push({
      employee_id: schedule.employee_id,
      employee_name: employee?.full_name || '',
      work_date: schedule.work_date,
      store_id: schedule.store_id || null,
      store_name: schedule.stores?.name || '',
      display_schedule_kind: scheduleKind(schedule),
      display_schedule: schedule,
      schedule_only: true,
      clock_in: null,
      break_start: null,
      break_end: null,
      clock_out: null,
    });
  });
  const represented = new Set(rows.map((item) => `${item.employee_id}:${item.work_date}`));
  employees.forEach((employee) => monthDates(month).forEach((date) => {
    const key = `${employee.user_id}:${date}`;
    if (represented.has(key)) return;
    rows.push({
      employee_id: employee.user_id,
      employee_name: employee.full_name || '',
      work_date: date,
      store_name: '',
      display_schedule_kind: null,
      display_schedule: null,
      calendar_only: true,
      clock_in: null,
      break_start: null,
      break_end: null,
      clock_out: null,
    });
  }));
  return rows.sort((a, b) => b.work_date.localeCompare(a.work_date)
    || String(a.employee_name).localeCompare(String(b.employee_name), 'es'));
}

function scheduleTable(items, showEmployee = true, editable = false) {
  if (!items.length) return `<div class="empty">${L('暂无排班', 'No hay horarios')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${showEmployee ? `<th>${L('员工', 'Empleado')}</th>` : ''}<th>${L('日期', 'Fecha')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('时间', 'Horario')}</th>${editable ? `<th>${L('操作', 'Acción')}</th>` : ''}</tr></thead><tbody>${items.map((item) => `<tr>${showEmployee ? `<td><b>${escapeHTML(item.profiles?.full_name || '')}</b></td>` : ''}<td>${dateText(item.work_date)}</td><td>${scheduleKind(item) === 'annual_leave' ? '—' : escapeHTML(item.stores?.name || '')}</td><td>${scheduleKind(item) === 'annual_leave' ? `<span class="status annual-leave">${L('年假', 'Vacaciones')}</span>` : item.is_day_off ? `<span class="status">${L('休息', 'Libre')}</span>` : `${timeText(item.starts_at)}—${timeText(item.ends_at)}`}</td>${editable ? `<td>${item.profiles?.active === false ? '—' : `<button class="ghost-btn" data-edit-schedule="${item.id}" type="button">${L('修改', 'Modificar')}</button>`}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function renderRecords() {
  return `<article class="card">${attendanceTable(attendanceRowsForView(), true)}</article>`;
}

function attendanceRowStatus(item) {
  if (isSickLeaveRecord(item)) return { className: 'sick-leave', label: L('病假', 'Baja médica') };
  if (item.correction_kind === 'absence') return { className: 'alert', label: L('缺勤', 'Ausencia') };
  if (item.display_schedule_kind === 'annual_leave') return { className: 'annual-leave', label: L('年假', 'Vacaciones') };
  if (item.display_schedule_kind === 'day_off') return { className: '', label: L('休息日', 'Día libre') };
  if (item.corrected) return { className: 'pending', label: L('工作日 · 已核实', 'Laborable · Verificado') };
  const hasPunch = ['clock_in', 'break_start', 'break_end', 'clock_out']
    .some((field) => Boolean(attendanceValue(item, 'actual', field)));
  if (!hasPunch && item.work_date > madridDate() && item.display_schedule_kind === 'work') return { className: 'pending', label: L('工作日 · 待打卡', 'Laborable · Pendiente') };
  if (!hasPunch && item.display_schedule_kind === 'work') return { className: 'alert', label: L('工作日 · 未打卡', 'Laborable · Sin fichajes') };
  if (!hasPunch && !item.display_schedule_kind) return { className: '', label: L('未排班', 'Sin horario') };
  return { className: 'ok', label: L('工作日', 'Día laborable') };
}

function attendanceTable(items, showEmployee = true, editable = false) {
  if (!items.length) return `<div class="empty">${L('暂无考勤记录', 'No hay registros')}</div>`;
  const requestable = !editable && state.role === 'employee';
  return `<div class="table-wrap"><table><thead><tr>${showEmployee ? `<th>${L('员工', 'Empleado')}</th>` : ''}<th>${L('日期', 'Fecha')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('上班', 'Entrada')}</th><th>${L('休息', 'Pausa')}</th><th>${L('下班', 'Salida')}</th><th>${L('有效工时', 'Horas efectivas')}</th>${requestable ? `<th>${L('补卡申请', 'Solicitar fichaje')}</th>` : ''}${editable ? `<th>${L('操作', 'Acción')}</th>` : ''}</tr></thead><tbody>${items.map((item) => {
    const status = attendanceRowStatus(item);
    const nonWorking = item.correction_kind === 'absence' || ['day_off', 'annual_leave'].includes(item.display_schedule_kind);
    const canCorrect = !['day_off', 'annual_leave'].includes(item.display_schedule_kind);
    const actualIn = timeText(attendanceValue(item, 'actual', 'clock_in'));
    const actualBreak = `${timeText(attendanceValue(item, 'actual', 'break_start'))}–${timeText(attendanceValue(item, 'actual', 'break_end'))}`;
    const actualOut = timeText(attendanceValue(item, 'actual', 'clock_out'));
    const canRequest = canCorrect && item.work_date <= madridDate();
    const effectiveText = nonWorking ? '0h 00m' : scheduledEffectiveText(item);
    const hoursCell = requestable ? effectiveText : `<b>${effectiveText}</b><br><span class="status ${status.className}">${status.label}</span>`;
    return `<tr>${showEmployee ? `<td>${escapeHTML(item.employee_name || '')}</td>` : ''}<td>${dateText(item.work_date)}</td><td>${escapeHTML(item.store_name || '—')}</td><td>${actualIn}</td><td>${actualBreak}</td><td>${actualOut}</td><td>${hoursCell}</td>${requestable ? `<td>${canRequest ? `<button type="button" class="ghost-btn" data-request-missed="${escapeHTML(item.work_date)}">${L('补卡申请','Solicitar')}</button>` : '—'}</td>` : ''}${editable ? `<td>${canCorrect ? `<div class="button-row"><button type="button" class="ghost-btn" data-edit-attendance="${escapeHTML(item.employee_id)}" data-work-date="${escapeHTML(item.work_date)}">${item.corrected ? L('再次修改', 'Volver a corregir') : L('修改', 'Corregir')}</button>${item.corrected ? `<button type="button" class="ghost-btn danger" data-void-attendance="${escapeHTML(item.employee_id)}" data-work-date="${escapeHTML(item.work_date)}">${L('撤销修正', 'Anular corrección')}</button>` : ''}</div>` : '—'}</td>` : ''}</tr>`;
  }).join('')}</tbody></table></div>`;
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
  return `<div class="page-grid"><article class="card hero-card"><div><p class="eyebrow">EMPLOYEE PROFILE</p><h2>${escapeHTML(state.profile.full_name)}</h2><p>NIF ${escapeHTML(state.profile.nif || '—')} · ${escapeHTML(state.profile.stores?.name || '')}</p></div><div class="hero-meta"><span>${state.profile.active ? L('在职', 'En activo') : L('停用', 'Desactivado')}</span><span>${escapeHTML(state.profile.phone)}</span></div></article><article class="card summary-card"><p class="eyebrow">PRIVACY</p><h3>${L('数据、位置与照片', 'Datos, ubicación y fotos')}</h3><p>${L('GPS只在手机打卡时读取一次，不会持续追踪。店铺电脑的上班和下班打卡会拍摄现场照片，照片直接上传至私有云端，不保存在店铺电脑，并在30天后自动删除。', 'El GPS solo se obtiene al fichar con el móvil y no realiza seguimiento continuo. En el ordenador de tienda se hace una foto en la entrada y la salida; se sube directamente al almacenamiento privado, no se guarda en el ordenador y se elimina automáticamente después de 30 días.')}</p></article></div>`;
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
  <article class="card"><div class="section-head"><div><p class="eyebrow">LIVE TODAY</p><h2>${L('今日员工打卡汇总', 'Resumen de fichajes de hoy')}</h2><p>${L('按当天排班店铺分组，每名员工的上班、休息和下班记录集中在同一行。', 'Agrupado por la tienda programada; todos los fichajes de cada empleado aparecen en una sola fila.')}</p></div><span class="status ok">Europe/Madrid</span></div>${todayAttendanceSummary(state.data.events)}</article>`;
}

function todayAttendanceRows(events = []) {
  const today = madridDate();
  const scheduleSource = state.data.todaySchedules || state.data.schedules || [];
  const schedules = scheduleSource.filter((item) => item.work_date === today && scheduleKind(item) === 'work');
  const storeById = new Map((state.data.stores || []).map((store, index) => [store.id, { ...store, order: index }]));
  const scheduleByEmployee = new Map(schedules.map((schedule) => [schedule.employee_id, schedule]));
  const rows = new Map();

  const ensureRow = ({ employeeId, storeId, profile, schedule }) => {
    const resolvedStoreId = storeId || schedule?.store_id || profile?.store_id || '';
    const key = `${employeeId || profile?.user_id || 'unknown'}::${resolvedStoreId || 'unknown'}`;
    if (!rows.has(key)) {
      const store = storeById.get(resolvedStoreId);
      rows.set(key, {
        key,
        employeeId: employeeId || profile?.user_id || '',
        employeeName: profile?.full_name || '',
        employeeNo: profile?.employee_no || '',
        storeId: resolvedStoreId,
        storeName: store?.name || schedule?.stores?.name || '',
        storeOrder: store?.order ?? Number.MAX_SAFE_INTEGER,
        schedule: schedule || null,
        events: {},
        sources: new Set(),
      });
    }
    const row = rows.get(key);
    if (!row.schedule && schedule) row.schedule = schedule;
    if (!row.employeeName && profile?.full_name) row.employeeName = profile.full_name;
    if (!row.employeeNo && profile?.employee_no) row.employeeNo = profile.employee_no;
    if (!row.storeName && schedule?.stores?.name) row.storeName = schedule.stores.name;
    return row;
  };

  schedules.forEach((schedule) => ensureRow({
    employeeId: schedule.employee_id,
    storeId: schedule.store_id,
    profile: schedule.profiles,
    schedule,
  }));

  events.forEach((event) => {
    const schedule = scheduleByEmployee.get(event.employee_id) || null;
    const row = ensureRow({
      employeeId: event.employee_id,
      storeId: event.store_id || schedule?.store_id,
      profile: event.profiles || schedule?.profiles,
      schedule: event.store_id === schedule?.store_id ? schedule : null,
    });
    if (!row.storeName && event.stores?.name) row.storeName = event.stores.name;
    if (event.source) row.sources.add(event.source);
    const current = row.events[event.event_type];
    const keepLatest = event.event_type === 'break_end' || event.event_type === 'clock_out';
    if (!current || (keepLatest ? event.occurred_at > current.occurred_at : event.occurred_at < current.occurred_at)) {
      row.events[event.event_type] = event;
    }
  });

  return [...rows.values()].sort((a, b) => {
    if (a.storeOrder !== b.storeOrder) return a.storeOrder - b.storeOrder;
    const aStart = a.schedule?.starts_at || '99:99';
    const bStart = b.schedule?.starts_at || '99:99';
    return aStart.localeCompare(bStart)
      || a.employeeName.localeCompare(b.employeeName, state.lang === 'zh' ? 'zh-CN' : 'es-ES')
      || a.employeeNo.localeCompare(b.employeeNo);
  });
}

function todayAttendanceStatus(row) {
  if (row.events.clock_out) return { className: 'ok', label: L('已下班', 'Finalizado') };
  if (row.events.break_start && !row.events.break_end) return { className: 'pending', label: L('休息中', 'En pausa') };
  if (row.events.clock_in) return { className: 'ok', label: L('工作中', 'Trabajando') };
  return { className: '', label: L('未上班', 'Sin entrada') };
}

function todayAttendanceSummary(events) {
  const rows = todayAttendanceRows(events);
  if (!rows.length) return `<div class="empty">${L('今天暂无排班和打卡记录', 'Hoy no hay horarios ni fichajes')}</div>`;
  const groups = new Map();
  rows.forEach((row) => {
    const groupKey = row.storeId || row.storeName || 'unknown';
    if (!groups.has(groupKey)) groups.set(groupKey, { name: row.storeName || L('未识别店铺', 'Tienda sin identificar'), rows: [] });
    groups.get(groupKey).rows.push(row);
  });

  const timeCell = (event) => event ? `<b class="live-punch-time">${timeText(event.occurred_at)}</b>` : '<span class="live-punch-empty">—</span>';
  const photoButtons = (row) => [
    ['clock_in', L('上班照', 'Entrada')],
    ['clock_out', L('下班照', 'Salida')],
  ].map(([type, label]) => {
    const event = row.events[type];
    return event?.metadata?.photo_path
      ? `<button class="ghost-btn photo-button" data-view-photo="${event.id}" type="button">${label}</button>`
      : '';
  }).filter(Boolean).join('');

  return `<div class="live-store-list">${[...groups.values()].map((group) => `<section class="live-store-group">
    <div class="live-store-head"><h3>${escapeHTML(group.name)}</h3><span>${group.rows.length} ${L('人', 'personas')}</span></div>
    <div class="table-wrap live-summary-table"><table><thead><tr><th>${L('员工', 'Empleado')}</th><th>${L('排班', 'Horario')}</th><th>${L('上班', 'Entrada')}</th><th>${L('开始休息', 'Inicio pausa')}</th><th>${L('结束休息', 'Fin pausa')}</th><th>${L('下班', 'Salida')}</th><th>${L('当前状态', 'Estado')}</th><th>${L('方式', 'Origen')}</th><th>${L('现场照片', 'Fotos')}</th></tr></thead><tbody>${group.rows.map((row) => {
      const status = todayAttendanceStatus(row);
      const sources = [...row.sources].map((source) => source === 'kiosk'
        ? L('电脑', 'PC')
        : source === 'daily' ? L('打卡记录', 'Registro') : source.toUpperCase()).join(' + ');
      const photos = photoButtons(row);
      return `<tr><td class="live-employee"><b>${escapeHTML(row.employeeName)}</b></td><td>${row.schedule ? `${timeText(row.schedule.starts_at)}—${timeText(row.schedule.ends_at)}` : `<span class="status alert">${L('无排班', 'Sin horario')}</span>`}</td><td>${timeCell(row.events.clock_in)}</td><td>${timeCell(row.events.break_start)}</td><td>${timeCell(row.events.break_end)}</td><td>${timeCell(row.events.clock_out)}</td><td><span class="status ${status.className}">${status.label}</span></td><td>${sources ? `<span class="status ${row.sources.has('gps') ? 'pending' : 'ok'}">${escapeHTML(sources)}</span>` : '—'}</td><td><div class="live-photo-actions">${photos || '—'}</div></td></tr>`;
    }).join('')}</tbody></table></div>
  </section>`).join('')}</div>`;
}

function eventTable(items) {
  if (!items.length) return `<div class="empty">${L('暂无打卡记录', 'No hay fichajes')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('时间', 'Hora')}</th><th>${L('员工', 'Empleado')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('事件', 'Evento')}</th><th>${L('来源', 'Origen')}</th><th>${L('现场照片', 'Foto')}</th></tr></thead><tbody>${items.map((item) => `<tr><td>${timeText(item.occurred_at)}</td><td>${escapeHTML(item.profiles?.full_name || '')}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${eventLabel(item.event_type)}</td><td><span class="status ${item.source === 'gps' ? 'pending' : 'ok'}">${item.source === 'kiosk' ? L('店铺电脑', 'Ordenador') : item.source.toUpperCase()}</span></td><td>${item.metadata?.photo_path ? `<button class="ghost-btn photo-button" data-view-photo="${item.id}" type="button">${L('查看照片', 'Ver foto')}</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function storeOptions(selected = '') { return state.data.stores.filter((store) => store.active !== false).map((store) => `<option value="${store.id}" ${selected === store.id ? 'selected' : ''}>${escapeHTML(store.name)}</option>`).join(''); }
function employeeOptions(activeOnly = true, selected = '') { return state.data.employees.filter((employee) => !activeOnly || employee.active).map((employee) => `<option value="${employee.user_id}" ${selected === employee.user_id ? 'selected' : ''}>${escapeHTML(employee.full_name)}</option>`).join(''); }

function renderEmployees() {
  const hasStores = state.data.stores.some((store) => store.active !== false);
  return `<div><details class="card compact-details"><summary>${L('新增员工', 'Añadir empleado')}</summary><p class="eyebrow">NEW EMPLOYEE</p><h2>${L('创建员工正式账号', 'Crear cuenta de empleado')}</h2><p>${L('员工不能自行注册。手机密码用于查看，6位PIN用于店铺电脑打卡。', 'El empleado no puede registrarse solo. La contraseña es para el móvil y el PIN de 6 cifras para fichar en tienda.')}</p>${hasStores ? `<form id="employeeForm" class="stack-form">
    <label>${L('姓名', 'Nombre completo')}<input id="employeeName" required minlength="2"></label><label>${L('手机号', 'Teléfono')}<input id="employeePhone" type="tel" placeholder="+34 600 000 000" required></label>
    <label>${L('所属店铺', 'Tienda habitual')}<select id="employeeStore">${storeOptions()}</select></label><div class="form-row"><label>${L('手机登录密码', 'Contraseña móvil')}<input id="employeePassword" type="password" minlength="8" required></label><label>${L('店铺打卡PIN', 'PIN de fichaje')}<input id="employeePin" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label></div>
    <button class="primary-btn" type="submit">${L('创建员工', 'Crear empleado')}</button></form>` : `<div class="callout warning"><b>${L('没有可用店铺', 'No hay tiendas disponibles')}</b><span>${L('请先检查店铺数据。', 'Comprueba primero los datos de las tiendas.')}</span></div>`}</details>
    <article class="card"><div class="section-head"><div><p class="eyebrow">TEAM</p><h2>${L('员工账号', 'Cuentas de empleados')}</h2></div><span class="status ok">${state.data.employees.filter((item) => item.active).length} ${L('人在职', 'activos')}</span></div>${employeeTable()}</article></div>`;
}

function employeeTable() {
  if (!state.data.employees.length) return `<div class="empty">${L('尚未创建员工', 'Todavía no hay empleados')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('员工', 'Empleado')}</th><th>NIF</th><th>${L('手机号', 'Teléfono')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('状态', 'Estado')}</th><th>${L('操作', 'Acción')}</th></tr></thead><tbody>${state.data.employees.map((employee) => `<tr><td><b>${escapeHTML(employee.full_name)}</b></td><td>${escapeHTML(employee.nif || '—')}</td><td>${escapeHTML(employee.phone)}</td><td>${escapeHTML(employee.stores?.name || '')}</td><td><span class="status ${employee.active ? 'ok' : 'alert'}">${employee.active ? L('在职', 'Activo') : L('停用', 'Inactivo')}</span></td><td><div class="button-row"><button class="ghost-btn" data-reset="password" data-id="${employee.user_id}">${L('改密码', 'Contraseña')}</button><button class="ghost-btn" data-reset="pin" data-id="${employee.user_id}">PIN</button><button class="${employee.active ? 'danger-btn' : 'secondary-btn'}" data-toggle-employee="${employee.user_id}" data-active="${employee.active ? 'false' : 'true'}">${employee.active ? L('停用', 'Desactivar') : L('启用', 'Activar')}</button>${employee.active ? '' : `<button class="danger-btn" data-delete-employee="${employee.user_id}">${L('删除误建账号', 'Eliminar cuenta errónea')}</button>`}</div></td></tr>`).join('')}</tbody></table></div>`;
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
    .filter((item) => item.employee_id === employee.user_id && scheduleKind(item) !== 'annual_leave')
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
  const month = currentScheduleMonth();
  const employee = selectedScheduleEmployee();
  if (!employee) return `<article class="card"><p>${L('请先创建员工账号。', 'Crea primero una cuenta de empleado.')}</p></article>`;
  const used = (state.data.annualLeave || []).filter(x => x.employee_id === employee.user_id && x.work_date.startsWith(month.slice(0,4))).length;
  const schedules = new Map(state.data.schedules.filter(x => x.employee_id === employee.user_id).map(x => [x.work_date, x]));
  const days = Number(monthLastDate(month).slice(-2));
  const blanks = '<div class="calendar-empty" aria-hidden="true"></div>'.repeat(scheduleWeekdayIndex(`${month}-01`));
  const cells = Array.from({length: days}, (_, i) => {
    const date = `${month}-${String(i+1).padStart(2,'0')}`;
    const item = schedules.get(date);
    const kind = item ? scheduleKind(item) : 'empty';
    const store = state.data.stores.find(x => x.id === item?.store_id);
    const label = !item ? L('未排班','Sin turno') : kind === 'annual_leave' ? L('年假','Vacaciones') : kind === 'day_off' ? L('休息','Libre') : `${madridTimeValue(item.starts_at)}–${madridTimeValue(item.ends_at)}`;
    return `<button class="calendar-day ${kind}" type="button" data-edit-date="${date}" aria-label="${escapeHTML(`${date} ${label} ${store?.name || ''}`)}"><b>${i+1}</b><strong>${label}</strong><small>${escapeHTML(kind === 'work' ? store?.name || '' : '')}</small><span>${L('修改','Editar')}</span></button>`;
  }).join('');
  return `<article class="card"><div class="section-head"><div><h2>${L('整月排班','Horario mensual')}</h2><p>${L('点击日期即可临时换班、换店或安排休息。','Pulsa una fecha para cambiar el turno, la tienda o el descanso.')}</p></div><span class="status">${state.data.annualLeaveReady ? L(`年假 ${used}/30 天`,`Vacaciones ${used}/30 días`) : L('年假待核对','Vacaciones pendientes')}</span></div>
    <div class="form-row"><label>${L('员工','Empleado')}<select id="weeklyEmployee">${employeeOptions(true,employee.user_id)}</select></label><label>${L('月份','Mes')}<input id="weeklyMonth" type="month" min="${SCHEDULE_START_MONTH}" value="${month}"></label></div>
    <div class="button-row"><button class="secondary-btn" id="copyPreviousMonth" type="button">${L('复制上月排班','Copiar horario del mes anterior')}</button><span class="muted">${L('按上月最常用的周一至周日班次生成本月，临时调班不会优先采用。','Genera este mes con el patrón semanal más habitual del mes anterior; los cambios puntuales no tienen prioridad.')}</span></div>
    <div class="month-calendar"><div class="calendar-weekdays">${weekdayNames().map(x=>`<b>${x}</b>`).join('')}</div><div class="calendar-grid">${blanks}${cells}</div></div></article>
    <details class="card compact-details"><summary>${L('按周模板生成整月','Generar el mes con una plantilla semanal')}</summary><form id="weeklyScheduleForm" class="stack-form"><p>${L('仅在建立或重新安排整月时使用；会覆盖工作与休息排班，已登记年假保留。','Úsalo para crear o reorganizar el mes. Sustituye trabajo y descanso; conserva las vacaciones.')}</p><div id="weeklyRows" class="weekly-schedule">${renderWeeklyRows(employee)}</div><label>${L('备注（可选）','Nota opcional')}<input id="weeklyNotes" maxlength="500"></label><button class="primary-btn" type="submit">${L('生成整月排班','Generar horario mensual')}</button></form></details>`;
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
  return `<div class="page-grid">${state.data.stores.map((store) => `<article class="card" style="grid-column:span 6"><p class="eyebrow">${escapeHTML(store.code)}</p><h2>${escapeHTML(store.name)}</h2><form class="stack-form store-form" data-store-id="${store.id}"><label>${L('准确地址', 'Dirección exacta')}<input name="address" value="${escapeHTML(store.address || '')}" required></label><div class="form-row"><label>Latitude<input name="latitude" type="number" step="any" value="${store.latitude ?? ''}" required></label><label>Longitude<input name="longitude" type="number" step="any" value="${store.longitude ?? ''}" required></label></div><label>${L('手机打卡范围（固定100米）', 'Radio de fichaje móvil (100 m fijo)')}<input name="radius" type="number" min="100" max="100" value="100" readonly required></label><button class="primary-btn" type="submit">${L('保存店铺GPS', 'Guardar GPS')}</button></form></article>`).join('')}</div><article class="card"><p class="eyebrow">KIOSK DEVICES</p><h2>${L('已绑定店铺电脑', 'Ordenadores vinculados')}</h2>${deviceTable()}</article>`;
}

function deviceTable() {
  if (!state.data.devices.length) return `<div class="empty">${L('尚未绑定店铺电脑', 'No hay ordenadores vinculados')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('电脑', 'Ordenador')}</th><th>${L('店铺', 'Tienda')}</th><th>${L('最后在线', 'Última conexión')}</th><th>${L('状态', 'Estado')}</th><th>${L('操作', 'Acción')}</th></tr></thead><tbody>${state.data.devices.map((item) => `<tr><td>${escapeHTML(item.name)}</td><td>${escapeHTML(item.stores?.name || '')}</td><td>${item.last_seen_at ? madridDisplay(new Date(item.last_seen_at), true) : '—'}</td><td><span class="status ${item.active ? 'ok' : 'alert'}">${item.active ? L('启用', 'Activo') : L('停用', 'Inactivo')}</span></td><td><button class="${item.active ? 'danger-btn' : 'secondary-btn'}" data-toggle-kiosk="${item.id}" data-active="${item.active ? 'false' : 'true'}">${item.active ? L('停用', 'Desactivar') : L('启用', 'Activar')}</button></td></tr>`).join('')}</tbody></table></div>`;
}

function filteredAttendance() {
  return attendanceRowsForView().filter(item => !state.attendanceEmployeeId || item.employee_id === state.attendanceEmployeeId);
}

function attendanceCalendarCell(item) {
  if (!item) return { className: 'unscheduled', short: '—', label: L('未排班', 'Sin horario') };
  if (isSickLeaveRecord(item)) return { className: 'sick-leave', short: L('病', 'B'), label: L('病假', 'Baja médica') };
  if (item.correction_kind === 'absence') return { className: 'absence', short: L('缺', 'A'), label: L('缺勤', 'Ausencia') };
  if (item.display_schedule_kind === 'annual_leave') return { className: 'annual-leave', short: L('年', 'V'), label: L('年假', 'Vacaciones') };
  if (item.display_schedule_kind === 'day_off') return { className: 'day-off', short: L('休', 'L'), label: L('休息日', 'Día libre') };
  if (item.corrected) return { className: 'corrected', short: L('核', 'C'), label: L('工作日 · 已核实', 'Laborable · Verificado') };
  const hasPunch = ['clock_in', 'break_start', 'break_end', 'clock_out']
    .some((field) => Boolean(attendanceValue(item, 'actual', field)));
  if (item.display_schedule_kind === 'work' && !hasPunch) {
    return item.work_date > madridDate()
      ? { className: 'pending', short: L('待', 'P'), label: L('工作日 · 待打卡', 'Laborable · Pendiente') }
      : { className: 'missing', short: L('未', 'SF'), label: L('工作日 · 未打卡', 'Laborable · Sin fichajes') };
  }
  if (hasPunch) return { className: 'worked', short: L('工', 'T'), label: L('工作日', 'Día laborable') };
  return { className: 'unscheduled', short: '—', label: L('未排班', 'Sin horario') };
}

function monthlyAttendanceCalendar(items) {
  const month = state.attendanceMonth || madridDate().slice(0, 7);
  const employeeById = new Map((state.data.employees || []).map((employee) => [employee.user_id, employee]));
  const employeeIds = [...new Set(items.map((item) => item.employee_id))];
  const rowsByKey = new Map(items.map((item) => [`${item.employee_id}:${item.work_date}`, item]));
  if (!employeeIds.length) return `<div class="empty">${L('暂无考勤记录', 'No hay registros')}</div>`;
  const dates = monthDates(month);
  const leadingBlanks = scheduleWeekdayIndex(dates[0]);
  const trailingBlanks = (7 - ((leadingBlanks + dates.length) % 7)) % 7;
  const calendarDates = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...dates,
    ...Array.from({ length: trailingBlanks }, () => null),
  ];
  const calendars = employeeIds.map((employeeId) => {
    const employee = employeeById.get(employeeId);
    const fallback = items.find((item) => item.employee_id === employeeId);
    const name = employee?.full_name || fallback?.employee_name || '';
    const nif = employee?.nif || '';
    const cells = calendarDates.map((date) => {
      if (!date) return '<div class="attendance-month-day outside-month" aria-hidden="true"></div>';
      const item = rowsByKey.get(`${employeeId}:${date}`);
      const status = attendanceCalendarCell(item);
      const actualIn = timeText(attendanceValue(item, 'actual', 'clock_in'));
      const actualBreakStart = timeText(attendanceValue(item, 'actual', 'break_start'));
      const actualBreakEnd = timeText(attendanceValue(item, 'actual', 'break_end'));
      const actualOut = timeText(attendanceValue(item, 'actual', 'clock_out'));
      const nonWorking = item?.correction_kind === 'absence' || ['day_off', 'annual_leave'].includes(item?.display_schedule_kind);
      const effective = nonWorking ? '0h 00m' : scheduledEffectiveText(item || {});
      const detail = `${date} · ${status.label}${item?.store_name ? ` · ${item.store_name}` : ''}${actualIn !== '—' || actualOut !== '—' ? ` · ${actualIn}–${actualOut}` : ''}`;
      return `<button type="button" class="attendance-month-day ${status.className}" data-calendar-correct="${escapeHTML(employeeId)}" data-work-date="${date}" title="${escapeHTML(detail)}" aria-label="${escapeHTML(`${name} ${detail}`)}"><span class="attendance-month-date">${Number(date.slice(-2))}</span><strong>${status.label}</strong><small>${escapeHTML(item?.store_name || '—')}</small><span>${L('上','E')} ${actualIn} · ${L('下','S')} ${actualOut}</span><span>${L('休','P')} ${actualBreakStart}–${actualBreakEnd}</span><b>${L('有效','Efectivas')} ${effective}</b></button>`;
    }).join('');
    return `<section class="attendance-month"><header><div><h3>${escapeHTML(name)}</h3><p>NIF · ${escapeHTML(nif || L('未填写', 'Sin NIF'))}</p></div></header><div class="attendance-month-weekdays">${weekdayNames().map((day) => `<b>${day}</b>`).join('')}</div><div class="attendance-month-grid">${cells}</div></section>`;
  }).join('');
  return `<div class="attendance-month-list">${calendars}</div>`;
}

function renderExport() {
  const month = state.attendanceMonth || madridDate().slice(0,7);
  const attendanceItems = filteredAttendance();
  return `<article class="card"><div class="section-head"><div><h2>${L('整月考勤日历','Calendario mensual de jornada')}</h2><p>${L('当月每天均显示工作日、休息日、缺勤、病假和年假；没有打卡也不会漏掉。','Cada día del mes muestra jornada laboral, descanso, ausencia, baja médica o vacaciones, incluso sin fichajes.')}</p></div><button class="primary-btn" type="button" id="newCorrection">${L('补充记录','Añadir registro')}</button></div>
    <form id="monthlyReportForm" class="report-controls"><label>${L('月份','Mes')}<input id="reportMonth" type="month" min="${SCHEDULE_START_MONTH}" max="${madridDate().slice(0,7)}" value="${month}" required></label><label>${L('员工','Empleado')}<select id="reportEmployee"><option value="">${L('全部员工','Todos')}</option>${employeeOptions(false,state.attendanceEmployeeId)}</select></label><div class="form-actions"><button class="secondary-btn" id="previewEmployeeReport" type="submit">${L('打印签字表','Imprimir registro')}</button><button class="ghost-btn" id="exportCsv" type="button">${L('下载CSV','Descargar CSV')}</button></div></form>
    <div class="button-row attendance-legend"><span class="status ok">${L('工：工作日','T: trabajado')}</span><span class="status">${L('休：休息日','L: libre')}</span><span class="status alert">${L('缺：缺勤','A: ausencia')}</span><span class="status sick-leave">${L('病：病假','B: baja médica')}</span><span class="status annual-leave">${L('年：年假','V: vacaciones')}</span><span class="status pending">${L('待：待打卡','P: pendiente')}</span><span class="status alert">${L('未：未打卡','SF: sin fichajes')}</span></div>
    ${monthlyAttendanceCalendar(attendanceItems)}</article>
      <details class="card compact-details"><summary>${L('查看每日详细时间与修改历史','Ver horas diarias y correcciones')}</summary>${attendanceTable(attendanceItems,true,true)}</details>
      <details class="card compact-details"><summary>${L('打卡照片', 'Fotos de fichaje')}</summary><p>${L('只有上班和下班打卡拍照。点击“查看照片”时生成短时有效链接，照片不会下载到店铺电脑。', 'Solo se fotografían la entrada y la salida. “Ver foto” crea un enlace temporal; la foto no se descarga en el ordenador de tienda.')}</p>${eventTable(state.data.photoEvents || [])}</details>
  <details class="card compact-details"><summary>${L('修改历史', 'Historial de cambios')}</summary>${auditTable()}</details>
    <details class="card compact-details"><summary>${L('连接检查','Comprobar conexión')}</summary><p>${L('保存异常时检查后台服务。','Comprueba el servidor si falla un guardado.')}</p><button id="checkAdminConnection" type="button" class="secondary-btn">${L('检查后台连接','Comprobar servidor')}</button><pre id="connectionResult" role="status"></pre></details>`;
}
function auditTable() {
  if (!state.data.audits?.length) return `<div class="empty">${L('暂无管理操作', 'No hay acciones')}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>${L('时间', 'Hora')}</th><th>${L('操作', 'Acción')}</th><th>${L('对象', 'Objeto')}</th><th>${L('编号', 'ID')}</th></tr></thead><tbody>${state.data.audits.map((item) => `<tr><td>${madridDisplay(new Date(item.created_at), true)}</td><td>${escapeHTML(item.action)}</td><td>${escapeHTML(item.target_type)}</td><td><small>${escapeHTML(item.target_id || '—')}</small></td></tr>`).join('')}</tbody></table></div>`;
}

function openEditDialog(title, content) {
  const root = $('#modalRoot');
  const previousFocus = document.activeElement;
  root.innerHTML = `<section class="modal edit-dialog" role="dialog" aria-modal="true" aria-labelledby="editorTitle"><div class="modal-head"><h2 id="editorTitle">${escapeHTML(title)}</h2><button type="button" class="close-btn" id="closeEditor" aria-label="${L('关闭','Cerrar')}">×</button></div>${content}</section>`;
  const close = () => {
    const form = $('form',root);
    if (form?.dataset.saving === 'true') return;
    if (root.dataset.dirty === 'true' && !confirm(L('放弃尚未保存的修改？','¿Descartar los cambios sin guardar?'))) return;
    closeEditDialog();
    previousFocus?.focus();
  };
  root.dataset.dirty = 'false';
  root.oninput = () => { root.dataset.dirty = 'true'; };
  root.onchange = () => { root.dataset.dirty = 'true'; };
  $('#closeEditor').onclick = close;
  root.onclick = event => { if(event.target === root) close(); };
  root.onkeydown = event => {
    if(event.key === 'Escape') { event.preventDefault(); close(); }
    if(event.key !== 'Tab') return;
    const focusable = $$('button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',root).filter(x=>!x.hidden && x.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length-1];
    if(event.shiftKey && document.activeElement === first) { event.preventDefault();last.focus(); }
    else if(!event.shiftKey && document.activeElement === last) {event.preventDefault();first.focus();}
  };
  $('#closeEditor').focus();
}

function closeEditDialog() {
  const root = $('#modalRoot');
  root.innerHTML = '';root.onclick = null;root.onkeydown = null;root.oninput = null;root.onchange = null;delete root.dataset.dirty;
}

function openCorrectionDialog(employeeId, date) {
  const fixed = Boolean(employeeId && date);
  const employee = state.data.employees.find(x=>x.user_id === employeeId);
  if (fixed && !employee) return;
  const title = fixed ? `${employee.full_name} · ${dateText(date)}` : L('补充考勤记录','Añadir registro');
  openEditDialog(title, `<form id="correctionForm" class="stack-form">
    ${fixed ? `<input type="hidden" id="correctionEmployee" value="${employeeId}"><input type="hidden" id="correctionDate" value="${date}">` : `<div class="form-row"><label>${L('员工','Empleado')}<select id="correctionEmployee">${employeeOptions(false,state.attendanceEmployeeId)}</select></label><label>${L('日期','Fecha')}<input id="correctionDate" type="date" value="${madridDate()}" required></label></div>`}
    <label>${L('处理类型','Tipo')}<select id="correctionKind"><option value="attendance">${L('补充／修正打卡','Corregir fichajes')}</option><option value="sick_leave">${L('病假','Baja médica')}</option><option value="absence">${L('缺勤','Ausencia')}</option></select></label>
    <p id="correctionLoadStatus" role="status"></p><button id="loadCorrection" type="button" class="ghost-btn">${L('重新载入','Recargar')}</button>
    <div id="correctionTimeFields"><div class="form-row"><label>${L('上班','Entrada')}<input id="correctionClockIn" type="time"></label><label>${L('下班','Salida')}<input id="correctionClockOut" type="time"></label></div><div class="form-row"><label>${L('开始休息','Inicio pausa')}<input id="correctionBreakStart" type="time"></label><label>${L('结束休息','Fin pausa')}<input id="correctionBreakEnd" type="time"></label></div></div>
    <label>${L('常用修改原因（自动双语）','Motivo habitual (bilingüe automático)')}<select id="correctionReasonPreset"><option value="">${L('自定义原因','Motivo personalizado')}</option><option value="missed_punch">${L('忘记打卡','Olvido de fichaje')}</option><option value="approved_request">${L('已批准的补卡申请','Solicitud de fichaje aprobada')}</option><option value="system_error">${L('打卡系统无法操作','Error del sistema de fichaje')}</option><option value="wrong_time">${L('记录时间与实际不符','Hora registrada incorrecta')}</option><option value="early_departure">${L('实际提前离店','Salida anticipada real')}</option><option value="verified">${L('核对排班及记录后修正','Corrección tras verificación')}</option><option value="absence">${L('缺勤','Ausencia')}</option><option value="sick_leave">${L('病假','Baja médica')}</option></select></label>
    <p>${L('常用原因会自动填写中文和西班牙语；自定义原因请同时填写两种语言。','Los motivos habituales completan automáticamente chino y español. Para un motivo personalizado, completa ambos idiomas.')}</p>
    <label>中文·修改原因<textarea id="correctionReasonZh" minlength="2" required placeholder="请用中文说明修改原因"></textarea></label>
    <label>Español · Motivo del cambio<textarea id="correctionReasonEs" minlength="5" required placeholder="Indica el motivo de la corrección en español"></textarea></label><p id="correctionSaveStatus" class="save-status" role="status"></p><button class="primary-btn" type="submit" disabled>${L('保存双语修改','Guardar corrección bilingüe')}</button></form>`);
  $('#correctionForm').addEventListener('submit',saveCorrection);
  $('#correctionKind').addEventListener('change',toggleCorrectionFields);
  $('#correctionReasonPreset').addEventListener('change', (event) => {
    const preset = CORRECTION_REASON_PRESETS[event.currentTarget.value];
    if (!preset) return;
    $('#correctionReasonZh').value = preset.zh;
    $('#correctionReasonEs').value = preset.es;
  });
  $('#loadCorrection').onclick = () => {
    if($('#modalRoot').dataset.dirty === 'true' && !confirm(L('重新载入会替换当前填写内容，继续？','La recarga sustituye los datos del formulario. ¿Continuar?'))) return;
    loadCorrectionRecord();
  };
  if(!fixed) {
    $('#correctionEmployee').addEventListener('change',()=>loadCorrectionRecord());
    $('#correctionDate').addEventListener('change',()=>loadCorrectionRecord());
  }
  loadCorrectionRecord();
}


function openVoidCorrectionDialog(employeeId, date) {
  const employee = state.data.employees.find((item) => item.user_id === employeeId);
  const record = state.data.attendance.find((item) => item.employee_id === employeeId && item.work_date === date);
  if (!employee || !record?.corrected) return;
  openEditDialog(L('撤销考勤修正', 'Anular corrección'), `<form id="voidCorrectionForm" class="stack-form">
    <p><strong>${escapeHTML(employee.full_name)}</strong> · ${dateText(date)}</p>
    <p>${L('撤销后将恢复该日原始打卡。修正记录和撤销原因仍会保留在审计历史中。', 'Se restaurarán los fichajes originales. La corrección y el motivo de anulación permanecerán en el historial de auditoría.')}</p>
    <label>${L('撤销原因（必填）', 'Motivo de anulación (obligatorio)')}<textarea id="voidCorrectionReason" minlength="5" required placeholder="${L('请说明为什么撤销本次修正', 'Indica por qué se anula esta corrección')}"></textarea></label>
    <p id="voidCorrectionStatus" class="save-status" role="status"></p>
    <button class="primary-btn danger" type="submit">${L('确认撤销并恢复原始打卡', 'Anular y restaurar fichajes originales')}</button>
  </form>`);
  $('#voidCorrectionForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = $('#voidCorrectionReason').value.trim();
    if (reason.length < 5) {
      toast(L('请填写至少5个字的撤销原因', 'Escribe un motivo de al menos 5 caracteres'), true);
      return;
    }
    await editorSave(form, '#voidCorrectionStatus', {
      action: 'correct_attendance',
      correctionKind: 'void',
      employeeId,
      workDate: date,
      clockIn: null,
      breakStart: null,
      breakEnd: null,
      clockOut: null,
      reason,
    }, L('修正已撤销，已恢复原始打卡', 'Corrección anulada; se restauraron los fichajes originales'));
  });
}

async function checkAdminConnection() {
  const button = $('#checkAdminConnection'), output = $('#connectionResult');
  button.disabled = true;output.textContent = L('正在检查…','Comprobando…');
  const started = Date.now();
  try {
    const result = await functionRequest('admin-api',{action:'health'},{timeoutMs:8000});
    output.textContent = L(`后台已响应，版本 ${result.release || '未知'}，耗时 ${Date.now()-started}ms。此检查不代表保存已成功。`,`Servidor disponible, versión ${result.release || '?'}, ${Date.now()-started}ms. Esta prueba no confirma un guardado.`);
  } catch(error) {
    output.textContent = `${errorText(error)}\n${JSON.stringify(error.diagnostic || {code:normalizedErrorCode(error)},null,2)}`;
  } finally {button.disabled = false;}
}

async function refreshEditedRecord(body, successMessage) {
  try {
    const table = body.action === 'upsert_schedule' ? 'schedules' : 'attendance_daily';
    const query = client.from(table).select(table === 'schedules' ? '*, stores(name)' : '*')
      .eq('employee_id',body.employeeId).eq('work_date',body.workDate).abortSignal(AbortSignal.timeout(8000));
    const result = await query.maybeSingle();
    if(result.error) throw result.error;
    const field = table === 'schedules' ? 'schedules' : 'attendance';
    state.data[field] = state.data[field].filter(item=>item.employee_id !== body.employeeId || item.work_date !== body.workDate);
    if(!result.data && body.action === 'correct_attendance' && body.correctionKind === 'void') {
      renderPortal();toast(successMessage);return;
    }
    if(!result.data) throw new Error('RECORD_NOT_FOUND');
    const record = result.data;
    state.data[field].push(record);
    if(table === 'schedules') {
      state.data.schedules.sort((a,b)=>a.work_date.localeCompare(b.work_date));
      state.data.annualLeave = (state.data.annualLeave || []).filter(item=>item.employee_id !== body.employeeId || item.work_date !== body.workDate);
      if(scheduleKind(record) === 'annual_leave' && record.published) state.data.annualLeave.push({employee_id:body.employeeId,work_date:body.workDate});
    } else state.data.attendance.sort((a,b)=>b.work_date.localeCompare(a.work_date));
    renderPortal();toast(successMessage);
  } catch(error) {
    toast(L('已保存，但最新记录加载失败，请点击刷新。','Guardado, pero no se pudo actualizar el registro. Pulsa actualizar.'),true);
  }
}

async function editorSave(form, statusId, body, successMessage) {
  const status = $(statusId);
  if(form.dataset.saving === 'true') return;
  const controls = $$('input,select,textarea,button',form).map(element=>[element,element.disabled]);
  form.dataset.saving = 'true';controls.forEach(([element])=>{element.disabled=true;});
  status.textContent = L('正在保存，请稍候…','Guardando…');
  try {
    const result = await adminAction(body);
    if (result?.ok !== true) throw new Error('INVALID_SERVER_RESPONSE');
    closeEditDialog();
    await refreshEditedRecord(body, successMessage);
  } catch(error) {
    const uncertain = ['REQUEST_TIMEOUT','NETWORK_ERROR'].includes(normalizedErrorCode(error));
    status.textContent = uncertain
      ? L('未收到保存确认，结果待核对。填写内容已保留，请先核对服务器记录，避免重复提交。','No se recibió confirmación. Los datos del formulario se conservan; comprueba el registro antes de volver a guardar.')
      : errorText(error);
    if(uncertain) {
      const check = document.createElement('button');check.type='button';check.className='secondary-btn';check.textContent=L('核对服务器记录','Comprobar registro');
      status.append(document.createElement('br'),check);
      check.onclick = async () => {
        check.disabled=true;
        try {
          const table = body.action === 'upsert_schedule' ? 'schedules' : 'attendance_daily';
          const result = await client.from(table).select('*').eq('employee_id',body.employeeId).eq('work_date',body.workDate).abortSignal(AbortSignal.timeout(8000)).maybeSingle();
          if(result.error) throw result.error;
          const record=result.data;
          const text = !record ? L('服务器目前没有当天记录。','No hay registro para este día.') : body.action === 'upsert_schedule'
            ? `${L('服务器当前排班','Horario actual')}: ${scheduleKind(record)} · ${state.data.stores.find(x=>x.id===record.store_id)?.name || ''} · ${timeText(record.starts_at)}–${timeText(record.ends_at)}`
            : `${L('服务器当前记录','Registro actual')}: ${timeText(record.clock_in)} / ${timeText(record.break_start)}–${timeText(record.break_end)} / ${timeText(record.clock_out)} · ${record.correction_reason || ''}`;
          const resultText=document.createElement('p');resultText.textContent=text;status.append(resultText);
        } catch(readError) {const text=document.createElement('p');text.textContent=L('核对也未完成，请检查后台连接。','No se pudo comprobar; revisa la conexión.');status.append(text);}
        finally {check.disabled=false;}
      };
    }
    const detail=document.createElement('details');const summary=document.createElement('summary');summary.textContent=L('错误详情（可截图）','Detalles del error');
    const pre=document.createElement('pre');pre.textContent=JSON.stringify(error.diagnostic || {code:normalizedErrorCode(error)},null,2);detail.append(summary,pre);status.append(detail);
  } finally {
    delete form.dataset.saving;
    controls.forEach(([element,disabled])=>{element.disabled=disabled;});
  }
}

function bindPortal() {
  $('#languageToggle')?.addEventListener('click', () => setLang(state.lang === 'zh' ? 'es' : 'zh'));
  $('#logout')?.addEventListener('click', logout);
  $('#refreshData')?.addEventListener('click', refreshPortal);
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view; renderPortal(); }));
  $('#requestForm')?.addEventListener('submit', submitRequest);
  $$('[data-request-missed]').forEach((button) => button.addEventListener('click', () => {
    state.view = 'requests';
    renderPortal();
    $('#requestType').value = 'missed_punch';
    $('#requestDate').value = button.dataset.requestMissed;
    $('#requestTime').focus();
  }));
  $$('[data-gps-punch]').forEach((button) => button.addEventListener('click', () => gpsPunch(button.dataset.gpsPunch, button.dataset.gpsPermission || null)));
  $('#employeeForm')?.addEventListener('submit', createEmployee);
  $$('[data-toggle-employee]').forEach((button) => button.addEventListener('click', () => toggleEmployee(button)));
  $$('[data-delete-employee]').forEach((button) => button.addEventListener('click', () => deleteEmployee(button)));
  $$('[data-reset]').forEach((button) => button.addEventListener('click', () => resetEmployeeCredential(button)));
  $('#weeklyScheduleForm')?.addEventListener('submit', saveMonthlySchedule);
  $('#copyPreviousMonth')?.addEventListener('click', copyPreviousMonthSchedule);
  $('#weeklyEmployee')?.addEventListener('change', changeWeeklyEmployee);
  $('#weeklyMonth')?.addEventListener('change', changeScheduleMonth);
  bindWeeklyRows();
  $$('[data-edit-date]').forEach((button) => button.addEventListener('click', () => editSchedule(button)));
  $$('[data-review]').forEach((button) => button.addEventListener('click', () => reviewRequest(button)));
  $('#gpsForm')?.addEventListener('submit', grantGps);
  $$('[data-revoke-gps]').forEach((button) => button.addEventListener('click', () => revokeGps(button)));
  $$('.store-form').forEach((form) => form.addEventListener('submit', saveStore));
  $$('[data-toggle-kiosk]').forEach((button) => button.addEventListener('click', () => toggleKiosk(button)));
  $$('[data-view-photo]').forEach((button) => button.addEventListener('click', () => viewAttendancePhoto(button)));
  $('#exportCsv')?.addEventListener('click', exportCsv);
  $('#monthlyReportForm')?.addEventListener('submit', (event) => generateMonthlyReports(event, !$('#reportEmployee').value));
  $('#previewAllReports')?.addEventListener('click', (event) => generateMonthlyReports(event, true));
  $('#newCorrection')?.addEventListener('click', () => openCorrectionDialog());
  $$('[data-calendar-correct]').forEach(button => button.addEventListener('click', () => openCorrectionDialog(button.dataset.calendarCorrect, button.dataset.workDate)));
  $$('[data-edit-attendance]').forEach(button => button.addEventListener('click', () => openCorrectionDialog(button.dataset.editAttendance,button.dataset.workDate)));
  $$('[data-void-attendance]').forEach(button => button.addEventListener('click', () => openVoidCorrectionDialog(button.dataset.voidAttendance,button.dataset.workDate)));
  $('#reportEmployee')?.addEventListener('change', event => { state.attendanceEmployeeId = event.target.value; renderPortal(); });
  $('#reportMonth')?.addEventListener('change', async event => {
    state.attendanceMonth = event.target.value;
    try { await reloadPortal(); } catch(error) { toast(errorText(error),true); }
  });
  $('#checkAdminConnection')?.addEventListener('click', checkAdminConnection);
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
  await withTimeout(loadPortalData());
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

async function confirmEmployeePunch(eventType, previousValue) {
  const field = ({ clock_in: 'clock_in', break_start: 'break_start', break_end: 'break_end', clock_out: 'clock_out' })[eventType];
  if (!field) return null;
  const actualField = `actual_${field}`;
  await new Promise((resolve) => setTimeout(resolve, 700));
  const today = madridDate();
  const dayStart = madridLocalToIso(today, '00:00');
  const dayEnd = madridLocalToIso(addDays(today, 1), '00:00');
  const [daily, events] = await withTimeout(Promise.all([
    client.from('attendance_daily').select(actualField).eq('work_date', today).maybeSingle(),
    client.from('attendance_events').select('occurred_at').eq('employee_id', state.profile.user_id)
      .eq('event_type', eventType).gte('occurred_at', dayStart).lt('occurred_at', dayEnd)
      .order('occurred_at', { ascending: false }).limit(1),
  ]), 7_000);
  const confirmedAt = daily.data?.[actualField] || events.data?.[0]?.occurred_at || null;
  if (!confirmedAt || confirmedAt === previousValue) return null;
  return confirmedAt;
}

async function gpsPunch(eventType, permissionId = null) {
  if (!navigator.geolocation) { toast(L('此设备不支持定位', 'Este dispositivo no admite ubicación'), true); return; }
  if (state.busy) return;
  state.busy = true;
  $$('[data-gps-punch]').forEach((button) => { button.disabled = true; });
  const currentRecord = (state.data.attendance || []).find((item) => item.work_date === madridDate());
  const previousValue = attendanceValue(currentRecord, 'actual', eventType);
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
    rememberConfirmedPunch(eventType, result.event.occurredAt, result.event.storeId || result.store?.id || null);
    await finishMutation(`${eventLabel(eventType)} · ${timeText(result.event.occurredAt)} · ${Math.round(result.distanceM)}m`);
  } catch (error) {
    const locationError = error?.code === 1 ? 'LOCATION_PERMISSION_DENIED' : [2, 3].includes(error?.code) ? 'LOCATION_UNAVAILABLE' : error;
    const code = normalizedErrorCode(locationError);
    const shouldConfirm = ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'INVALID_SERVER_RESPONSE', 'OPERATION_FAILED', 'INVALID_EVENT_SEQUENCE'].includes(code)
      || code.startsWith('HTTP_');
    let confirmedAt = null;
    if (shouldConfirm) {
      try { confirmedAt = await confirmEmployeePunch(eventType, previousValue); }
      catch (confirmationError) { console.error('Punch confirmation failed:', confirmationError); }
    }
    if (confirmedAt) {
      rememberConfirmedPunch(eventType, confirmedAt);
      try { await reloadPortal(); } catch (refreshError) { console.error('Confirmed punch refresh failed:', refreshError); }
      toast(`${eventLabel(eventType)} · ${timeText(confirmedAt)} · ${L('已确认打卡成功', 'Fichaje confirmado')}`);
    } else {
      toast(errorText(locationError), true);
    }
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
  const nonWorkDay = event.target.value !== 'work';
  $('#singleScheduleStart').disabled = nonWorkDay;
  $('#singleScheduleEnd').disabled = nonWorkDay;
}

function editSchedule(button) {
  const employee = selectedScheduleEmployee();
  const date = button.dataset.editDate;
  if (!employee || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return;
  const item = state.data.schedules.find(x => x.employee_id === employee.user_id && x.work_date === date);
  openEditDialog(`${employee.full_name} · ${dateText(date)}`, `<form id="singleScheduleForm" class="stack-form">
    <input id="singleScheduleEmployee" type="hidden" value="${employee.user_id}"><input id="singleScheduleDate" type="hidden" value="${date}">
    <label>${L('当天安排','Tipo de día')}<select id="singleScheduleKind">${[['work',L('工作','Trabajo')],['day_off',L('休息','Descanso')],['annual_leave',L('年假','Vacaciones')]].map(([value,label])=>`<option value="${value}" ${value === (item ? scheduleKind(item) : 'work') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
    <label>${L('店铺','Tienda')}<select id="singleScheduleStore">${storeOptions(item?.store_id || employee.home_store_id)}</select></label>
    <div class="form-row"><label>${L('上班','Entrada')}<input id="singleScheduleStart" type="time" value="${madridTimeValue(item?.starts_at,'10:00')}" required></label><label>${L('下班','Salida')}<input id="singleScheduleEnd" type="time" value="${madridTimeValue(item?.ends_at,'17:00')}" required></label></div>
    <label>${L('备注（可选）','Nota opcional')}<input id="singleScheduleNotes" maxlength="500" value="${escapeHTML(item?.notes || '')}"></label>
    <p class="save-status" role="status" id="scheduleSaveStatus"></p><button class="primary-btn" type="submit">${L('保存这一天','Guardar este día')}</button></form>`);
  $('#singleScheduleForm').addEventListener('submit',saveSingleSchedule);
  $('#singleScheduleKind').addEventListener('change',toggleSingleScheduleTimes);
  toggleSingleScheduleTimes({target:$('#singleScheduleKind')});
}

function mostCommonPreviousMonthPattern(items, fallbackStoreId) {
  return Array.from({ length: 7 }, (_, weekday) => {
    const candidates = items.filter((item) => scheduleKind(item) !== 'annual_leave'
      && scheduleWeekdayIndex(item.work_date) === weekday);
    if (!candidates.length) return null;
    const choices = new Map();
    candidates.forEach((item) => {
      const dayOff = scheduleKind(item) === 'day_off';
      const choice = {
        dayOff,
        storeId: item.store_id || fallbackStoreId || '',
        start: madridTimeValue(item.starts_at, '10:00'),
        end: madridTimeValue(item.ends_at, '17:00'),
      };
      const key = JSON.stringify(choice);
      const current = choices.get(key) || { choice, count: 0, lastDate: '' };
      current.count += 1;
      if (item.work_date > current.lastDate) current.lastDate = item.work_date;
      choices.set(key, current);
    });
    return [...choices.values()].sort((left, right) => right.count - left.count
      || right.lastDate.localeCompare(left.lastDate))[0].choice;
  });
}

async function copyPreviousMonthSchedule(event) {
  const button = event.currentTarget;
  const employee = selectedScheduleEmployee();
  const targetMonth = $('#weeklyMonth')?.value || currentScheduleMonth();
  const sourceMonth = previousMonthString(targetMonth);
  if (!employee || !sourceMonth) return;
  button.disabled = true;
  try {
    const sourceResult = await client.from('schedules').select('work_date,store_id,starts_at,ends_at,is_day_off,schedule_kind,published')
      .eq('employee_id', employee.user_id).eq('published', true)
      .gte('work_date', `${sourceMonth}-01`).lte('work_date', monthLastDate(sourceMonth))
      .order('work_date').abortSignal(AbortSignal.timeout(8000));
    if (sourceResult.error) throw sourceResult.error;
    const pattern = mostCommonPreviousMonthPattern(sourceResult.data || [], employee.home_store_id);
    if (pattern.some((item) => !item) || pattern.every((item) => item.dayOff)
      || pattern.some((item) => !item.storeId || (!item.dayOff && (!item.start || !item.end || item.end <= item.start)))) {
      toast(L('上月没有完整的周一至周日排班，无法自动复制。请使用周模板生成。', 'El mes anterior no tiene un horario completo de lunes a domingo. Usa la plantilla semanal.'), true);
      return;
    }
    const sourceLabel = new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'es-ES', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${sourceMonth}-15T12:00:00Z`));
    const targetLabel = new Intl.DateTimeFormat(state.lang === 'zh' ? 'zh-CN' : 'es-ES', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${targetMonth}-15T12:00:00Z`));
    if (!confirm(L(
      `将按 ${employee.full_name} ${sourceLabel} 最常用的每周排班生成 ${targetLabel}，覆盖本月工作日和休息日；已登记年假保留。确定继续？`,
      `Se generará ${targetLabel} para ${employee.full_name} usando el patrón semanal más habitual de ${sourceLabel}. Se sustituirán los días laborables y libres; las vacaciones registradas se conservarán. ¿Continuar?`,
    ))) return;
    const result = await adminAction({
      action: 'publish_month_schedule',
      employeeId: employee.user_id,
      month: targetMonth,
      pattern,
      notes: `Copied from ${sourceMonth}`,
    });
    await finishMutation(L(`已复制上月排班，共生成${result.count}天`, `Horario anterior copiado: ${result.count} días`));
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    button.disabled = false;
  }
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
    `将按这份周模板覆盖 ${employee?.full_name || ''} ${monthLabel} 的工作和休息排班；已登记年假会保留。确定继续？`,
    `Se sobrescribirán los días de trabajo y descanso de ${employee?.full_name || ''} para ${monthLabel}; las vacaciones ya registradas se conservarán. ¿Continuar?`,
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
  const kind = $('#singleScheduleKind').value;
  const date = $('#singleScheduleDate').value;
  const start = $('#singleScheduleStart').value, end = $('#singleScheduleEnd').value;
  if(kind === 'work' && (!start || !end || end <= start)) { $('#scheduleSaveStatus').textContent=errorText('INVALID_SCHEDULE_TIME');return; }
  await editorSave(form,'#scheduleSaveStatus',{
    action:'upsert_schedule',employeeId:$('#singleScheduleEmployee').value,storeId:$('#singleScheduleStore').value,workDate:date,
    scheduleKind:kind,dayOff:kind !== 'work',startsAt:kind === 'work' ? madridLocalToIso(date,start) : null,
    endsAt:kind === 'work' ? madridLocalToIso(date,end) : null,notes:$('#singleScheduleNotes').value,
  },L('当天排班已保存','Horario del día guardado'));
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

async function viewAttendancePhoto(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const result = await adminAction({ action: 'attendance_photo', eventId: button.dataset.viewPhoto });
    const event = [...(state.data.events || []), ...(state.data.photoEvents || [])]
      .find((item) => item.id === button.dataset.viewPhoto);
    if (!event) throw new Error('RECORD_NOT_FOUND');
    const employeeName = event.profiles?.full_name || '';
    const modalRoot = $('#modalRoot');
    modalRoot.innerHTML = `<section class="modal photo-modal" role="dialog" aria-modal="true" aria-labelledby="photoTitle">
      <div class="modal-head"><div><p class="eyebrow">ATTENDANCE PHOTO</p><h2 id="photoTitle">${escapeHTML(employeeName)} · ${eventLabel(event.event_type)}</h2></div><button class="close-btn" id="closePhoto" type="button" aria-label="${L('关闭', 'Cerrar')}">×</button></div>
      <p>${madridDisplay(new Date(event.occurred_at), true)} · ${escapeHTML(event.stores?.name || '')}</p>
      <img class="attendance-photo" src="${escapeHTML(result.signedUrl)}" alt="${L('员工现场打卡照片', 'Foto del fichaje del empleado')}">
      <p class="muted">${L('照片链接仅短时间有效；照片在打卡30天后自动删除。', 'El enlace solo es válido durante un tiempo breve; la foto se elimina 30 días después del fichaje.')}</p>
    </section>`;
    const close = () => { modalRoot.innerHTML = ''; modalRoot.onclick = null; };
    $('#closePhoto')?.addEventListener('click', close);
    modalRoot.onclick = (clickEvent) => { if (clickEvent.target === modalRoot) close(); };
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    button.disabled = false;
  }
}


let correctionLoadSequence = 0;
async function loadCorrectionRecord() {
  const form = $('#correctionForm');
  if (!form) return;
  const employeeId = $('#correctionEmployee').value;
  const workDate = $('#correctionDate').value;
  if (!employeeId || !workDate) return;
  const sequence = ++correctionLoadSequence;
  const status = $('#correctionLoadStatus');
  const submit = form.querySelector('button[type="submit"]');
  const fields = ['correctionClockIn', 'correctionBreakStart', 'correctionBreakEnd', 'correctionClockOut'];
  submit.disabled = true;
  fields.forEach((id) => { $('#' + id).value = ''; $('#' + id).disabled = true; });
  $('#correctionReasonPreset').value = '';
  $('#correctionReasonZh').value = '';
  $('#correctionReasonEs').value = '';
  status.textContent = L('正在载入最新记录…', 'Cargando registro actual…');
  try {
    const result = await client.from('attendance_daily').select('*').eq('employee_id', employeeId).eq('work_date', workDate).abortSignal(AbortSignal.timeout(8000)).maybeSingle();
    if (sequence !== correctionLoadSequence || !form.isConnected) return;
    if (result.error) throw result.error;
    const record = result.data;
    const existingReason = splitBilingualReason(record?.correction_reason);
    $('#correctionReasonZh').value = existingReason.zh;
    $('#correctionReasonEs').value = existingReason.es;
    $('#correctionKind').value = isSickLeaveRecord(record) ? 'sick_leave' : record?.correction_kind === 'absence' ? 'absence' : 'attendance';
    toggleCorrectionFields();
    ['clock_in', 'break_start', 'break_end', 'clock_out'].forEach((key, index) => {
      const value = attendanceValue(record, 'payroll', key);
      $('#' + fields[index]).value = value ? new Intl.DateTimeFormat('en-GB', {
        timeZone: MADRID_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).format(new Date(value)) : '';
    });
    status.textContent = record
      ? L('已载入当前生效记录，可再次修改并填写本次原因。', 'Registro vigente cargado. Puedes corregirlo de nuevo indicando el motivo.')
      : L('当天暂无记录，可填写补卡时间。', 'No hay registro para este día. Puedes añadirlo.');
    $('#modalRoot').dataset.dirty = 'false';
    submit.disabled = false;
  } catch (error) {
    if (sequence !== correctionLoadSequence || !form.isConnected) return;
    status.textContent = L('载入失败，请点击“载入当天最新记录”重试。', 'Error al cargar. Pulsa «Cargar registro actual» para reintentar.');
    toast(errorText(error), true);
  }
}

function toggleCorrectionFields() {
  const kind = $('#correctionKind');
  const fields = $('#correctionTimeFields');
  if (!kind || !fields) return;
  const nonAttendance = kind.value !== 'attendance';
  fields.hidden = nonAttendance;
  fields.querySelectorAll('input').forEach((input) => {
    input.disabled = nonAttendance;
    if (nonAttendance) input.value = '';
  });
}

async function saveCorrection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const date = $('#correctionDate').value;
  const correctionKind = $('#correctionKind').value;
  const backendCorrectionKind = correctionKind === 'attendance' ? 'attendance' : 'absence';
  const employeeId = $('#correctionEmployee').value;
  const iso = (selector) => $(selector).value ? madridLocalToIso(date, $(selector).value) : null;
  if (correctionKind === 'attendance' && !$('#correctionClockIn').value && !$('#correctionClockOut').value && !$('#correctionBreakStart').value && !$('#correctionBreakEnd').value) {
    toast(L('请至少填写一个修正时间', 'Indica al menos una hora corregida'), true); return;
  }
  const suppliedTimes = correctionKind === 'attendance'
    ? [$('#correctionClockIn').value, $('#correctionBreakStart').value, $('#correctionBreakEnd').value, $('#correctionClockOut').value].filter(Boolean)
    : [];
  if (suppliedTimes.some((value, index) => index > 0 && value <= suppliedTimes[index - 1])) {
    toast(errorText('INVALID_TIME_RANGE'), true); return;
  }
  const reasonZh = $('#correctionReasonZh').value.trim();
  const reasonEs = $('#correctionReasonEs').value.trim();
  if (reasonZh.length < 2 || reasonEs.length < 5) {
    toast(L('修改原因必须同时填写中文和西班牙语', 'El motivo debe estar escrito en chino y en español'), true); return;
  }
  const reason = bilingualReason(reasonZh, reasonEs);
  if (button.disabled) return;
  await editorSave(form,'#correctionSaveStatus',{
    action:'correct_attendance',correctionKind:backendCorrectionKind,employeeId,workDate:date,
    clockIn:backendCorrectionKind === 'absence' ? null : iso('#correctionClockIn'),
    breakStart:backendCorrectionKind === 'absence' ? null : iso('#correctionBreakStart'),
    breakEnd:backendCorrectionKind === 'absence' ? null : iso('#correctionBreakEnd'),
    clockOut:backendCorrectionKind === 'absence' ? null : iso('#correctionClockOut'),
    reason:correctionKind === 'sick_leave' ? `${SICK_LEAVE_MARKER} ${reason}` : reason,
  },L('考勤修改已保存','Corrección guardada'));
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }
function exportCsv() {
  const header = ['nif', 'employee', 'date', 'store', 'clock_in', 'break_start', 'break_end', 'clock_out', 'scheduled_start', 'scheduled_end', 'effective_work_minus_recorded_break', 'record_kind', 'corrected', 'correction_reason'];
  const employeeById = new Map(state.data.employees.map((employee) => [employee.user_id, employee]));
  const rows = filteredAttendance().map((item) => {
    const schedule = attendanceSchedule(item);
    const nonWorking = item.correction_kind === 'absence' || ['day_off', 'annual_leave'].includes(item.display_schedule_kind);
    const recordKind = isSickLeaveRecord(item) ? 'sick_leave'
      : item.correction_kind === 'absence' ? 'absence'
      : item.display_schedule_kind || item.correction_kind || 'unscheduled';
    return [employeeById.get(item.employee_id)?.nif || '', item.employee_name, item.work_date, item.store_name,
      timeText(attendanceValue(item,'actual','clock_in')), timeText(attendanceValue(item,'actual','break_start')),
      timeText(attendanceValue(item,'actual','break_end')), timeText(attendanceValue(item,'actual','clock_out')),
      timeText(schedule?.starts_at), timeText(schedule?.ends_at), nonWorking ? '0h 00m' : scheduledEffectiveText(item, schedule),
      recordKind, item.corrected ? 'YES' : 'NO', visibleCorrectionReason(item)];
  });
  const csv = '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `HOLA_SEVILLA_attendance_${state.attendanceMonth || madridDate().slice(0,7)}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function durationMinutes(startValue, endValue) {
  if (!startValue || !endValue) return null;
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  return Math.round((end - start) / 60_000);
}

function reportDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return '—';
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function reportDateText(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', weekday: 'short', day: '2-digit', month: '2-digit' }).format(date);
}

function monthlyReportRow(date, schedule, attendance) {
  const absence = attendance?.correction_kind === 'absence';
  const sickLeave = isSickLeaveRecord(attendance);
  const actualClockIn = attendanceValue(attendance, 'actual', 'clock_in');
  const actualBreakStart = attendanceValue(attendance, 'actual', 'break_start');
  const actualBreakEnd = attendanceValue(attendance, 'actual', 'break_end');
  const actualClockOut = attendanceValue(attendance, 'actual', 'clock_out');
  const hasPunch = Boolean(actualClockIn || actualBreakStart || actualBreakEnd || actualClockOut);
  const dayOff = Boolean(schedule?.is_day_off);
  const annualLeave = scheduleKind(schedule) === 'annual_leave';
  const future = date > madridDate();
  const rawPresenceMinutes = durationMinutes(actualClockIn, actualClockOut);
  const hasBreakStart = Boolean(actualBreakStart);
  const hasBreakEnd = Boolean(actualBreakEnd);
  const hasCompleteBreak = hasBreakStart && hasBreakEnd;
  const rawBreakMinutes = durationMinutes(actualBreakStart, actualBreakEnd);
  const breakPairValid = hasBreakStart === hasBreakEnd;
  const sequenceValid = rawPresenceMinutes !== null && breakPairValid
    && (!hasCompleteBreak || (rawBreakMinutes !== null
      && new Date(actualClockIn) <= new Date(actualBreakStart)
      && new Date(actualBreakEnd) <= new Date(actualClockOut)
      && rawBreakMinutes <= rawPresenceMinutes));
  const effectiveMinutes = scheduledEffectiveMinutes(attendance || {}, schedule);
  const earlyArrivalMinutes = schedule?.starts_at && actualClockIn
    ? durationMinutes(actualClockIn, schedule.starts_at)
    : null;
  const issues = [];
  let hasIncident = false;

  if (sickLeave) {
    const reason = visibleCorrectionReason(attendance);
    issues.push(`病假 / Baja médica${reason ? `：${reason}` : ''}`);
  } else if (absence) {
    const reason = visibleCorrectionReason(attendance);
    issues.push(`缺勤 / Ausencia${reason ? `：${reason}` : ''}`);
    hasIncident = true;
  } else if (annualLeave && !hasPunch) {
    issues.push('年假 / Vacaciones');
  } else if (dayOff && !hasPunch) {
    issues.push('休息日 / Día libre');
  } else if (future && !hasPunch) {
    issues.push(schedule ? '工作日 · 待打卡 / Día laborable · Pendiente' : '未排班 / Sin horario');
  } else {
    if (schedule && scheduleKind(schedule) === 'work') issues.push('工作日 / Día laborable');
    if (!schedule) { issues.push('无排班 / Sin horario'); hasIncident = true; }
    if (annualLeave && hasPunch) { issues.push('年假期间有打卡 / Fichaje durante vacaciones'); hasIncident = true; }
    else if (dayOff && hasPunch) { issues.push('休息日有打卡 / Fichaje en día libre'); hasIncident = true; }
    if (!hasPunch) {
      issues.push('未打卡 / Sin fichajes');
      hasIncident = true;
    } else {
      const missing = [
        [actualClockIn, '上班 / entrada'],
        [actualClockOut, '下班 / salida'],
      ].filter(([value]) => !value).map(([, label]) => label);
      if (missing.length) { issues.push(`缺少 ${missing.join('、')}`); hasIncident = true; }
      if (!breakPairValid) { issues.push('午休记录不完整 / Pausa incompleta'); hasIncident = true; }
      else if (!sequenceValid) { issues.push('时间顺序异常 / Orden incorrecto'); hasIncident = true; }
      else if (!hasCompleteBreak) issues.push('未午休 / Sin pausa');

      const late = schedule?.starts_at && actualClockIn ? durationMinutes(schedule.starts_at, actualClockIn) : null;
      const early = schedule?.ends_at && actualClockOut ? durationMinutes(actualClockOut, schedule.ends_at) : null;
      if (!attendance?.corrected && earlyArrivalMinutes > 0) issues.push(`提前打卡 / Entrada anticipada ${earlyArrivalMinutes}m（不计入工时 / no computa）`);
      if (late > 0) { issues.push(`迟到 / Retraso ${late}m`); hasIncident = true; }
      if (early > 0) { issues.push(`早退 / Salida anticipada ${early}m`); hasIncident = true; }
      if (attendance?.corrected) issues.push(`已修正 / Corregido${attendance.correction_reason ? `：${attendance.correction_reason}` : ''}`);
    }
  }

  const nonWorking = absence || dayOff || annualLeave;
  return {
    date,
    store: attendance?.store_name || (annualLeave ? '—' : schedule?.stores?.name) || '—',
    actualClockIn: timeText(actualClockIn),
    actualBreakStart: timeText(actualBreakStart),
    actualBreakEnd: timeText(actualBreakEnd),
    actualClockOut: timeText(actualClockOut),
    effectiveMinutes: nonWorking ? 0 : effectiveMinutes,
    note: issues.join('；') || '正常 / Correcto',
    hasIncident,
    annualLeave,
    absence,
    sickLeave,
    dayOff,
    future,
  };
}

function monthlyReportStatus(row) {
  if (row.sickLeave) return { className: 'sick-leave', label: '病假 / Baja' };
  if (row.absence) return { className: 'absence', label: '缺勤 / Ausencia' };
  if (row.annualLeave) return { className: 'annual-leave', label: '年假 / Vacaciones' };
  if (row.dayOff) return { className: 'day-off', label: '休息 / Libre' };
  if (row.future && row.actualClockIn === '—') return { className: 'pending', label: '待打卡 / Pendiente' };
  if (row.actualClockIn === '—' && row.actualClockOut === '—') return { className: 'missing', label: '未打卡 / Sin fichajes' };
  return { className: row.hasIncident ? 'incident' : 'worked', label: '工作 / Trabajo' };
}

function monthlyReportHtml(employee, month, reportEnd, schedules, attendance) {
  const ownSchedules = schedules.filter((item) => item.employee_id === employee.user_id);
  const ownAttendance = attendance.filter((item) => item.employee_id === employee.user_id);
  const scheduleByDate = new Map(ownSchedules.map((item) => [item.work_date, item]));
  const attendanceByDate = new Map(ownAttendance.map((item) => [item.work_date, item]));
  const dates = monthDates(month);
  const rows = dates.map((date) => monthlyReportRow(date, scheduleByDate.get(date), attendanceByDate.get(date)));
  const effectiveTotal = rows.reduce((sum, row) => sum + (row.effectiveMinutes ?? 0), 0);
  const completeDays = rows.filter((row) => !row.absence && !row.dayOff && !row.annualLeave && !row.future && row.effectiveMinutes !== null).length;
  const dayOffDays = rows.filter((row) => row.dayOff && !row.annualLeave).length;
  const sickLeaveDays = rows.filter((row) => row.sickLeave).length;
  const annualLeaveDays = rows.filter((row) => row.annualLeave).length;
  const incidentCount = rows.filter((row) => row.hasIncident).length;
  const monthLabel = new Intl.DateTimeFormat('es-ES', { timeZone: 'UTC', year: 'numeric', month: 'long' }).format(new Date(`${month}-15T12:00:00Z`));
  const leadingBlanks = scheduleWeekdayIndex(`${month}-01`);
  const trailingBlanks = (7 - ((leadingBlanks + rows.length) % 7)) % 7;
  const calendarRows = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...rows,
    ...Array.from({ length: trailingBlanks }, () => null),
  ];
  const calendarHtml = calendarRows.map((row) => {
    if (!row) return '<div class="report-calendar-day outside-month"></div>';
    const status = monthlyReportStatus(row);
    return `<div class="report-calendar-day ${status.className}"><div class="report-calendar-date"><b>${Number(row.date.slice(-2))}</b><strong>${status.label}</strong></div><small>${escapeHTML(row.store)}</small><span>E ${row.actualClockIn} · S ${row.actualClockOut}</span><span>P ${row.actualBreakStart}–${row.actualBreakEnd}</span><b>${L('有效','Efectivas')} ${reportDuration(row.effectiveMinutes)}</b>${row.hasIncident ? `<em>${escapeHTML(row.note)}</em>` : ''}</div>`;
  }).join('');

  return `<article class="monthly-report-sheet">
    <header class="report-header"><div><b>HOLA!SEVILLA</b><small>NOVAKEEPS S.L.</small></div><div><h1>Registro mensual de jornada</h1><p>月度工时签字表 · ${escapeHTML(monthLabel)}</p></div></header>
    <div class="report-meta"><span><b>Empleado / 员工：</b>${escapeHTML(employee.full_name)}</span><span><b>NIF：</b>${escapeHTML(employee.nif || '—')}</span><span><b>Periodo / 统计截止：</b>${escapeHTML(month)}-01 — ${escapeHTML(reportEnd)}</span></div>
    <div class="report-calendar"><div class="report-calendar-weekdays"><b>Lunes<br>星期一</b><b>Martes<br>星期二</b><b>Miércoles<br>星期三</b><b>Jueves<br>星期四</b><b>Viernes<br>星期五</b><b>Sábado<br>星期六</b><b>Domingo<br>星期天</b></div><div class="report-calendar-grid">${calendarHtml}</div></div>
    <div class="report-totals"><span><small>Días completos / 完整天数</small><b>${completeDays}</b></span><span><small>Días libres / 休息日</small><b>${dayOffDays}</b></span><span><small>Ausencias / 缺勤</small><b>${rows.filter((row) => row.absence && !row.sickLeave).length}</b></span><span><small>Baja médica / 病假</small><b>${sickLeaveDays}</b></span><span><small>Vacaciones / 年假</small><b>${annualLeaveDays}</b></span><span><small>Horas efectivas / 有效工时</small><b>${reportDuration(effectiveTotal)}</b></span><span class="${incidentCount ? 'alert' : ''}"><small>Incidencias / 异常</small><b>${incidentCount}</b></span></div>
    <p class="report-note">Solo se muestran los fichajes reales. Las horas efectivas parten de la duración del turno programado y descuentan la pausa registrada entre inicio y fin de pausa. Una pausa incompleta debe corregirse. Los retrasos y salidas anticipadas se mantienen como incidencias.<br>只显示员工实际打卡时间。有效工时以排班起止时间为基础，再减去“开始休息—结束休息”的实际时长；休息记录不完整时必须补正。迟到和早退仍保留为异常备注。</p>
    <div class="report-signatures"><div><span>Firma del trabajador / 员工签字</span><i></i><small>Fecha / 日期：________________</small></div><div><span>Firma de la empresa / 公司签字</span><i></i><small>Fecha / 日期：________________</small></div></div>
    <footer>El trabajador confirma la recepción y revisión de este registro, sin renunciar a comunicar discrepancias. / 员工签字表示已收到并核对本表，如有差异仍可书面提出。</footer>
  </article>`;
}

async function generateMonthlyReports(event, allEmployees) {
  event.preventDefault();
  const month = $('#reportMonth')?.value;
  const selectedEmployeeId = $('#reportEmployee')?.value;
  if (!/^\d{4}-\d{2}$/.test(month || '') || (!allEmployees && !selectedEmployeeId)) return;
  const buttons = [$('#previewEmployeeReport'), $('#previewAllReports')].filter(Boolean);
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const monthStart = `${month}-01`;
    const reportEnd = monthLastDate(month);
    const [schedulesResult, attendanceResult] = await Promise.all([
      client.from('schedules').select('*, stores(name)').gte('work_date', monthStart).lte('work_date', reportEnd).eq('published', true).order('work_date'),
      client.from('attendance_daily').select('*').gte('work_date', monthStart).lte('work_date', reportEnd).order('work_date'),
    ]);
    assertQueryResults([schedulesResult, attendanceResult]);
    const schedules = schedulesResult.data || [];
    const attendance = attendanceResult.data || [];
    const relevantIds = new Set([...schedules, ...attendance].map((item) => item.employee_id));
    const employees = allEmployees
      ? state.data.employees.filter((employee) => relevantIds.has(employee.user_id))
      : state.data.employees.filter((employee) => employee.user_id === selectedEmployeeId);
    if (!employees.length) { toast(L('该月份没有可生成的员工记录', 'No hay registros de empleados para ese mes'), true); return; }
    const printArea = employees.map((employee) => monthlyReportHtml(employee, month, reportEnd, schedules, attendance)).join('');
    const modalRoot = $('#modalRoot');
    modalRoot.innerHTML = `<section class="modal report-preview"><div class="modal-head"><div><p class="eyebrow">PRINT PREVIEW</p><h2>${L('月度工时签字表', 'Registro mensual para firma')} · ${employees.length}${L('人', ' empleados')}</h2></div><button class="close-btn" id="closeReport" type="button">×</button></div><div class="form-actions report-preview-actions"><button class="primary-btn" id="printReports" type="button">${L('打印／保存PDF', 'Imprimir / Guardar PDF')}</button><span class="muted">${L('打印设置选择A4横向；每位员工自动分页。', 'Selecciona A4 horizontal; cada empleado empieza en una página nueva.')}</span></div><div class="print-area" id="printArea">${printArea}</div></section>`;
    const close = () => { modalRoot.innerHTML = ''; modalRoot.onclick = null; };
    $('#closeReport')?.addEventListener('click', close);
    $('#printReports')?.addEventListener('click', () => window.print());
    modalRoot.onclick = (clickEvent) => { if (clickEvent.target === modalRoot) close(); };
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function renderCurrent() {
  if (!configured) renderConfigurationError();
  else if (state.profile) renderPortal();
  else if (document.querySelector('.kiosk-shell')) renderKiosk();
  else renderAuth();
}

async function initialize() {
  document.documentElement.lang = state.lang === 'zh' ? 'zh-CN' : 'es';
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js?v=20261001-3').then((registration) => registration.update()).catch(() => {});
  }
  if (!configured) { renderConfigurationError(); return; }
  try {
    const { data, error } = await withTimeout(client.auth.getSession());
    if (error) throw error;
    if (data.session?.user) {
      const profile = await loadProfile(data.session.user.id);
      if (profile?.active) {
        state.session = data.session;
        state.profile = profile;
        await withTimeout(loadPortalData());
        renderPortal();
      } else {
        await client.auth.signOut({ scope: 'local' }).catch(() => {});
        renderAuth();
      }
    } else {
      renderAuth();
    }
  } catch (error) {
    console.error('Startup session recovery', error);
    await client.auth.signOut({ scope: 'local' }).catch(() => {});
    state.session = null;
    state.profile = null;
    state.data = {};
    state.health = null;
    state.busy = false;
    renderAuth();
    setTimeout(() => toast(L('登录状态已失效，请重新登录', 'La sesión ha caducado. Inicia sesión de nuevo.'), true), 0);
  }
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') { state.session = null; state.profile = null; state.data = {}; state.health = null; state.busy = false; }
  });
}

setInterval(() => {
  const kioskClock = $('#kioskTime'); if (kioskClock) kioskClock.textContent = timeText(new Date());
  const portalClock = $('#portalClock'); if (portalClock) portalClock.textContent = timeText(new Date());
}, 1000);

initialize().catch((error) => {
  console.error('Application startup failed', error);
  app.innerHTML = `<main class="setup-page"><section class="setup-card"><h1>${L('应用启动失败', 'No se pudo iniciar')}</h1><p>${escapeHTML(errorText(error))}</p><button class="primary-btn" id="startupRetry" type="button">${L('重新载入', 'Volver a cargar')}</button></section></main>`;
  $('#startupRetry')?.addEventListener('click', () => location.reload());
});
