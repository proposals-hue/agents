'use strict';
/*
 * Boss Dashboard — a calm, bilingual, read-only view for Eng. Muhammad.
 * Pure Node stdlib (no framework, no build step). Node >= 18 (uses global fetch).
 *
 * It assembles ONE friendly JSON (/api/summary) from three sources:
 *   a) Mission Control API  -> agent health
 *   b) cron/jobs.json        -> scheduled automations
 *   c) scheduled/sent_log.json + MC activities -> what happened today + numbers
 *
 * All secrets stay server-side. The boss only ever sees plain text.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------------
// Config
// ----------------------------------------------------------------------------
const ROOT = __dirname;
function loadConfig() {
  for (const name of ['config.json', 'config.example.json']) {
    try {
      return JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'));
    } catch {
      // Keep Vercel/serverless deploys alive when the local secret config is not present.
    }
  }
  return {};
}
function configuredPath(configured, fallback) {
  const fallbackPath = path.resolve(ROOT, fallback);
  if (process.env.VERCEL === '1') return fallbackPath;
  const primary = path.resolve(ROOT, configured || fallback);
  if (fs.existsSync(primary)) return primary;
  return fallbackPath;
}

const cfg = loadConfig();

const PORT = Number(process.env.BOSS_PORT || cfg.port || 3001);
const BIND = process.env.BOSS_HOST || cfg.bindHost || '0.0.0.0';
const PASSWORD = (process.env.BOSS_DASH_PASS || cfg.password || '').trim();
const TZ = cfg.timezone || 'Asia/Riyadh';
const MC_URL = process.env.MISSION_CONTROL_URL || (cfg.missionControl && cfg.missionControl.url) || 'http://127.0.0.1:3000';
const MC_KEY = process.env.MISSION_CONTROL_API_KEY || (cfg.missionControl && cfg.missionControl.apiKey) || '';
const ERP = cfg.erp || { enabled: false };

const SENT_LOG = configuredPath(cfg.paths && cfg.paths.sentLog, './data/sent_log.json');
const CRON_JOBS = configuredPath(cfg.paths && cfg.paths.cronJobs, './data/jobs.json');
const WORKFLOWS = configuredPath(cfg.paths && cfg.paths.workflows, './workflows.json');
const OPENCLAW = configuredPath(cfg.paths && cfg.paths.openclaw, './data/openclaw.json');

// ----------------------------------------------------------------------------
// Friendly names. Two keyings exist:
//   - Mission Control agents identify by display name + a `role` field
//     (e.g. name "Raqeeb", role "procurement-watchdog").
//   - cron/jobs.json identifies by lowercase `agentId` (e.g. "procurement").
// ROLES holds bilingual role labels; AREA maps cron agentIds to a name + role.
// ----------------------------------------------------------------------------
const ROLES = {
  exec:        { en: 'Executive Assistant', ar: 'المساعد التنفيذي' },
  procurement: { en: 'Procurement',         ar: 'المشتريات' },
  accounts:    { en: 'Accounts',            ar: 'الحسابات' },
  sales:       { en: 'Sales',               ar: 'المبيعات' },
  delivery:    { en: 'Delivery',            ar: 'التوصيل' },
  marketing:   { en: 'Marketing',           ar: 'التسويق' },
  projects:    { en: 'Projects',            ar: 'المشاريع' },
  fleet:       { en: 'Fleet',               ar: 'الأسطول' },
  hr:          { en: 'HR',                  ar: 'الموارد البشرية' },
  rental:      { en: 'Rentals',             ar: 'الإيجارات' },
  support:     { en: 'Support',             ar: 'الدعم' },
  other:       { en: 'Assistant',           ar: 'مساعد' },
};
const AREA = {
  main:        { name: 'Fahad',          role: 'exec' },
  procurement: { name: 'Raqeeb',         role: 'procurement' },
  accounts:    { name: 'Haseb',          role: 'accounts' },
  sales:       { name: 'Mutabi',         role: 'sales' },
  delivery:    { name: 'Naqqal',         role: 'delivery' },
  marketing:   { name: 'Musawwiq',       role: 'marketing' },
  projects:    { name: 'Musharif',       role: 'projects' },
  rental:      { name: "Mu'ajjir",       role: 'rental' },
  fleet:       { name: 'Astuli',         role: 'fleet' },
  hr:          { name: 'Muwazzif',       role: 'hr' },
};
const AREA_SUMMARY = {
  main: {
    en: 'Keeps the boss updated and routes important requests',
    ar: 'يتابع التحديثات المهمة ويوصل الطلبات لصاحب القرار',
  },
  procurement: {
    en: 'Watches material requests, POs, and suppliers',
    ar: 'يتابع طلبات المواد وأوامر الشراء والموردين',
  },
  accounts: {
    en: 'Watches collections, invoices, and payment follow-ups',
    ar: 'يتابع التحصيل والفواتير ومتابعة الدفعات',
  },
  sales: {
    en: 'Watches quotations, targets, tenders, and sales follow-ups',
    ar: 'يتابع عروض الأسعار والأهداف والمناقصات ومتابعات المبيعات',
  },
  delivery: {
    en: 'Watches shipments, stores, and delivery delays',
    ar: 'يتابع الشحنات والمستودعات وتأخير التسليم',
  },
  marketing: {
    en: 'Watches content approvals and publishing activity',
    ar: 'يتابع اعتماد المحتوى ونشاط النشر',
  },
  projects: {
    en: 'Watches project follow-ups and delivery signals',
    ar: 'يتابع متابعات المشاريع وإشارات التسليم',
  },
  rental: {
    en: 'Watches tenants, rent reminders, and lease activity',
    ar: 'يتابع المستأجرين وتذكيرات الإيجار وحركة العقود',
  },
  fleet: {
    en: 'Watches vehicles, documents, and fleet incidents',
    ar: 'يتابع المركبات والوثائق وحوادث الأسطول',
  },
  hr: {
    en: 'Watches HR documents, expiry reminders, and staff reports',
    ar: 'يتابع وثائق الموارد البشرية والتنبيهات وتقارير الموظفين',
  },
};
// infra model-runners — never shown to the boss
function isInfraAgent(name) { return /^runner/i.test(String(name || '')); }
// MC role field -> role key
function roleKeyFromMc(role, name) {
  const r = String(role || '').toLowerCase();
  if (r.includes('procurement')) return 'procurement';
  if (r.includes('account')) return 'accounts';
  if (r.includes('sales')) return 'sales';
  if (r.includes('delivery')) return 'delivery';
  if (r.includes('marketing')) return 'marketing';
  if (r.includes('project')) return 'projects';
  if (r.includes('fleet')) return 'fleet';
  if (r.includes('hr')) return 'hr';
  if (r.includes('rental')) return 'rental';
  if (r.includes('tenant') || r.includes('support')) return 'support';
  if (String(name || '').toLowerCase() === 'main') return 'exec';
  return 'other';
}
function roleLabel(key) { return ROLES[key] || ROLES.other; }
// canonical area id used to link an agent to its workflows (matches workflows.json `area`)
function agentArea(role, name) {
  const k = roleKeyFromMc(role, name);
  if (k === 'exec') return 'main';
  if (k === 'support') return 'rental';
  if (k === 'other') return String(name || '').toLowerCase() === 'main' ? 'main' : 'other';
  return k;
}
// only label jobs owned by a real business agent; infra "runner" jobs get no tag
// (their names already describe what they do)
function areaName(id) {
  const a = AREA[String(id || '').toLowerCase()];
  return a ? a.name : '';
}
function businessArea(id) {
  const key = String(id || '').toLowerCase();
  return AREA[key] ? key : '';
}
function areaForAgentId(id) {
  const key = String(id || '').toLowerCase();
  if (key === 'rental-tenant') return 'rental';
  return businessArea(key) || (key === 'main' ? 'main' : '');
}
function maskPeer(id) {
  const s = String(id || '');
  if (!s) return '';
  if (s.includes('@g.us')) return s.replace(/\d(?=\d{4})/g, '*');
  if (s.startsWith('+')) return s.replace(/\d(?=\d{4})/g, '*');
  return s.length > 8 ? `${s.slice(0, 3)}…${s.slice(-4)}` : s;
}
function channelLabel(kind, area, peerId, existingCount) {
  const owner = areaName(area) || 'OpenClaw';
  const type = kind === 'direct' ? 'chat' : 'group';
  const suffix = existingCount > 0 ? ` ${maskPeer(peerId).slice(-9)}` : '';
  return `${owner} ${type}${suffix}`;
}
function inferAutomationAreas(job, wf, categoryKey) {
  const primary = wf
    ? wf.area
    : (businessArea(job.agentId) || (AREA[categoryKey] ? categoryKey : ''));
  const related = new Set();
  if (primary) related.add(primary);

  const full = `${job.id || ''} ${job.name || ''} ${job.description || ''}`.toLowerCase();
  const addIf = (area, re) => { if (re.test(full)) related.add(area); };
  addIf('hr', /hr group|\bhr\b|\biqama\b|\bhuman resources\b|\bemployee daily activity\b|\bemployee iqama\b|\bemployee contract\b|\bhr employee\b|\bhr fleet\b|\bleave application\b/);
  addIf('procurement', /\b(procurement|supplier|rfq|purchase order|material request|raw material|po|mr)\b/);
  addIf('sales', /\b(sales|salesman|salesmen|quotation|visit|target|dn\/so|tender)\b/);
  addIf('delivery', /\b(delivery|shipment|truck|store)\b/);
  addIf('fleet', /\b(fleet|vehicle|accident|license|insurance|inspection|fahs)\b/);
  addIf('accounts', /\b(accounts|collection|receivable|cash receipt|invoice)\b/);
  addIf('marketing', /\b(marketing|linkedin|content|newsletter|campaign)\b/);
  addIf('rental', /\b(rent|rental|tenant|installment|lease)\b/);
  addIf('projects', /\b(project|projects|dpp)\b/);

  return { primary, relatedAreas: Array.from(related) };
}

// ----------------------------------------------------------------------------
// Plain-language cleanup. cron/jobs.json names/descriptions are written for
// engineers: they carry "(Python)", script filenames (foo.py), "Runs xxx.py:"
// lead-ins, internal [managed-by=...] tags, and the odd mojibake dash. The boss
// should never see any of that. These strip it automatically for ANY job, so
// new automations are cleaned with no extra config.
// ----------------------------------------------------------------------------
function fixMojibake(s) {
  // UTF-8 punctuation stored/decoded as CP1252 -> shows up as \u00e2... runs
  return String(s)
    .replace(/\u00e2\u20ac\u201d/g, ' - ')   // em dash
    .replace(/\u00e2\u20ac\u201c/g, ' - ')   // en dash
    .replace(/\u00e2\u20ac\u2122/g, "'")     // right single quote
    .replace(/\u00e2\u20ac\u00a6/g, '\u2026') // ellipsis
    .replace(/\u00e2\u20ac\u0153/g, '"')     // left double quote
    .replace(/\u00e2\u20ac\u009d/g, '"')     // right double quote
    .replace(/\u00e2\u2020\u2019/g, '\u2192') // arrow
    .replace(/\u00e2\u20ac/g, ' - ')          // leftover
    .replace(/\s{2,}/g, ' ');
}
function tidy(s) {
  return String(s)
    .replace(/\s+([:.,;)])/g, '$1')   // no space before punctuation
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–]\s*$/, '')        // trailing dash
    .trim();
}
function cleanName(name) {
  let s = fixMojibake(name || '');
  // drop purely-technical parentheticals: (Python) (Py) (B1) (Playwright)
  s = s.replace(/\s*\((?:python|py|b1|playwright)\)\s*/gi, ' ');
  // bare technical words / script filenames left in the name
  s = s.replace(/\b[\w-]+\.py\b/gi, '');
  s = s.replace(/\b(?:python|playwright)\b/gi, '');
  return tidy(s);
}
function cleanDesc(desc) {
  let s = fixMojibake(desc || '');
  s = s.replace(/\[[^\]]*\]/g, ' ');               // [managed-by=...] internal tags
  // "Runs foo_bar.py daily at 9:30 AM: reminds…" -> "reminds…"
  s = s.replace(/^\s*Runs\s+[\w-]+\.py\s+[\s\S]*?:\s+/i, ''); // drop "Runs x.py <schedule>: "
  s = s.replace(/^\s*Runs\s+[\w-]+\.py\s*/i, '');                // fallback: bare "Runs x.py"
  s = s.replace(/\b[\w-]+\.py\b/gi, '');           // stray script names
  s = s.replace(/\bpython\b/gi, '');               // the word itself
  s = s.replace(/\bplaywright\b/gi, '');           // browser-automation jargon
  // drop whole sentences that are pure implementation detail
  s = s.split(/(?<=\.)\s+/)
    .filter((p) => !/\b(script|session|timeout|timeouts|spin[- ]?up|cron|regex|json|imap|payload|whitelist|doctype|stub|stubs)\b/i.test(p))
    .join(' ');
  return tidy(s);
}
const AUTOMATION_AR_COPY = {
  'bb52724f-411d-4da4-ba16-cd9394e1a87b': {
    name: 'ترقية ذاكرة النظام',
    desc: 'يراجع أهم الملاحظات القصيرة ويرقي المفيد منها إلى الذاكرة الدائمة.',
  },
  '012854ef-36ba-4061-a3f9-3727d7579555': {
    name: 'مراقبة طلبات المواد',
    desc: 'يفحص ERP بحثاً عن طلبات مواد جديدة ويبلغ مجموعة المشتريات.',
  },
  'py-rm-barcode-allocator-001': {
    name: 'تخصيص باركود المواد الخام',
    desc: 'يفحص مواد BCI الخام الجديدة ويخصص الباركود التالي المتاح لها.',
  },
  'py-erp-monitor-001': {
    name: 'متابعة تحديثات ERP',
    desc: 'يتابع الموظفين والمواد وأوامر الشراء والإجازات والمشاريع الجديدة ويبلغ Eng. Muhammad.',
  },
  'py-chemanalyst-scraper-001': {
    name: 'متابعة أسعار ChemAnalyst الأسبوعية',
    desc: 'يجلب أسعار المواد الرئيسية من ChemAnalyst لاستخدامها في قرارات عروض الموردين.',
  },
  'py-dn-so-notifier-001': {
    name: 'ملخص أوامر البيع والتسليم اليومي',
    desc: 'يرسل لكل مندوب ملخص نهاية اليوم عن أوامر البيع وسندات التسليم الجديدة.',
  },
  'py-shipment-delay-001': {
    name: 'مراقبة تأخير الشحنات',
    desc: 'يتابع الشحنات المتأخرة وينبه السائق ومجموعة التوصيل.',
  },
  'py-bci-dn-so-reconcile-001': {
    name: 'مطابقة سندات تسليم BCI مع أوامر البيع',
    desc: 'يقارن سندات التسليم المكتملة مع أوامر البيع المرتبطة للتأكد من الكميات والمواد.',
  },
  'py-bci-store-group-reminders-001': {
    name: 'تذكير إنشاء سندات التسليم من مجموعة المستودع',
    desc: 'يتابع طلبات التوصيل في مجموعة المستودع التي لم يصبح لها سند تسليم في ERP.',
  },
  'py-bci-store-group-delayed-intake-001': {
    name: 'معالجة رسائل المستودع المتأخرة',
    desc: 'يجمع رسائل وصور المستودع المتأخرة ثم يرسل رداً مصنفاً واحداً بعد اكتمال الرسالة.',
  },
  'py-mr-leadtime-001': {
    name: 'متابعة تأخير طلبات المواد',
    desc: 'يرسل طلب مادة متأخر واحد في كل دورة إلى مجموعة المشتريات ويعيد التنبيه كل 3 أيام.',
  },
  'py-raw-material-shortage-001': {
    name: 'تذكير نقص المواد الخام',
    desc: 'ينبه جافيد بالمواد الخام الأقل من حد الأمان أو المتوقع نقصها، مع متابعة في اليوم التالي عند الحاجة.',
  },
  'py-quotation-followup-001': {
    name: 'متابعة عروض الأسعار المفتوحة',
    desc: 'يذكر مندوبي المبيعات بعروض الأسعار المفتوحة التي لم تتحول إلى أوامر بيع.',
  },
  'py-salesman-target-tracker-001': {
    name: 'متابعة أهداف مندوبي المبيعات',
    desc: 'يرسل لكل مندوب مبيعات تحديث الشهر الحالي، ترتيبه، أبرز العملاء، وتذكير الزيارات اليومية.',
  },
  'py-salesman-visit-tracker-noon-001': {
    name: 'متابعة زيارات المندوبين - منتصف اليوم',
    desc: 'ينبه المندوبين الذين لم يسجلوا زيارة ميدانية اليوم ويرسل ملخص الفريق عند الحاجة.',
  },
  'py-salesman-visit-tracker-midday-001': {
    name: 'متابعة زيارات المندوبين - 3:30',
    desc: 'ينبه المندوبين الذين ما زالوا أقل من الحد اليومي للزيارات المسجلة.',
  },
  'py-salesman-visit-tracker-eod-001': {
    name: 'ملخص زيارات المندوبين لصاحب القرار',
    desc: 'يرسل ملخص الاستثناءات لـ Eng. Muhammad عن المندوبين الأقل من الحد اليومي للزيارات.',
  },
  'py-rent-reminder-001': {
    name: 'تذكير أقساط الإيجار',
    desc: 'يرسل تذكيرات مبكرة لأقساط عقود الإيجار إلى Eng. Muhammad وعزير.',
  },
  'py-truck-arrival-001': {
    name: 'تنبيه قرب وصول الشاحنات',
    desc: 'ينبه مجموعة التوصيل قبل وصول الشاحنة إلى الوجهة بنحو 30 دقيقة.',
  },
  'py-unengaged-trucks-001': {
    name: 'تذكير الشاحنات غير المشغولة',
    desc: 'ينبه مجموعة التوصيل بالشاحنات التي لا يوجد لها رحلة تسليم نشطة اليوم.',
  },
  'py-oil-change-001': {
    name: 'متابعة تغيير زيت الشاحنات',
    desc: 'ينبه عند تجاوز الشاحنة حد الكيلومترات منذ آخر تغيير زيت.',
  },
  'mkt-weekly-planning': {
    name: 'تخطيط محتوى التسويق الأسبوعي',
    desc: 'يجهز خطة محتوى الأسبوع التالي ويرسلها لمجموعة تسويق BCI للاعتماد.',
  },
  'mkt-daily-drafting': {
    name: 'طلب منشورات تقويم التسويق - شاكر',
    desc: 'يرسل طلبات منشورات التقويم التسويقي اليومية إلى شاكر.',
  },
  'py-morning-briefing-001': {
    name: 'الملخص الصباحي',
    desc: 'يرسل لـ Eng. Muhammad ملخصاً يومياً عن التحصيل والاعتمادات والمبيعات وما تم أمس.',
  },
  'py-collections-brief-001': {
    name: 'ملخص التحصيل الذكي',
    desc: 'يرسل تحليل الفواتير المتأخرة وأولويات التحصيل وأكبر العملاء المتأخرين.',
  },
  'py-po-approval-notifier-001': {
    name: 'تنبيه اعتماد أوامر الشراء',
    desc: 'يتابع أوامر الشراء التي تنتظر اعتماد Eng. Muhammad ويرسلها للرد السريع.',
  },
  'py-po-notifier-anas-001': {
    name: 'تنبيه أوامر شراء APC إلى أنس',
    desc: 'يرسل أوامر شراء APC الجديدة إلى أنس عبر واتساب.',
  },
  'py-register-approvals-001': {
    name: 'تسجيل أوامر الشراء المعلقة',
    desc: 'يحدث سجل أوامر الشراء التي تنتظر الاعتماد.',
  },
  'mkt-watchdog': {
    name: 'مراقبة التسويق خلال ساعات العمل',
    desc: 'يذكر Eng. Muhammad بالاعتمادات التسويقية المعلقة ويتابع المهام المتأخرة.',
  },
  'py-eod-summary-001': {
    name: 'ملخص نهاية اليوم',
    desc: 'يرسل بطاقة نهاية اليوم: ما تم إنجازه، الاعتمادات، والعناصر التي ما زالت معلقة.',
  },
  '33884025-b4a0-4d1e-9563-6cda102c0056': {
    name: 'تحصيلات العملاء المتأخرة للمندوبين',
    desc: 'يرسل تذكيراً يومياً لكل مندوب BCI عن العملاء المتأخرين في السداد ضمن حساباته.',
  },
  'py-rental-overdue-001': {
    name: 'متابعة الإيجارات المتأخرة',
    desc: 'يفحص عقود الإيجار ويرسل ملخص المتأخرات وتذكيرات المستأجرين حسب مواعيد الاستحقاق.',
  },
  'py-rental-payment-reminder-001': {
    name: 'تذكير دفعات إيجار APC/BCI',
    desc: 'ينبه مجموعة الموارد البشرية بأقساط الإيجار وفواتير الكهرباء قبل الاستحقاق.',
  },
  'py-rfq-email-poller-001': {
    name: 'متابعة بريد RFQ',
    desc: 'يتابع رسائل الموردين الصادرة والواردة الخاصة بطلبات عروض الأسعار.',
  },
  'py-rfq-group-notifier-001': {
    name: 'شبكة أمان تنبيهات RFQ',
    desc: 'يلتقط أي جولة RFQ تم تجهيزها ولم يصل تنبيهها للمجموعة أو لصاحب القرار.',
  },
  'boss-dashboard-regen': {
    name: 'تحديث لوحة المتابعة',
    desc: 'يعيد توليد بيانات لوحة المتابعة بشكل دوري.',
  },
  'py-etimad-tender-watcher-001': {
    name: 'مراقبة مناقصات اعتماد',
    desc: 'يفحص مناقصات اعتماد العامة ويبلغ Eng. Muhammad بالمناقصات المناسبة لنطاق APC.',
  },
  'py-hr-fleet-expiry-001': {
    name: 'تذكير انتهاء وثائق الأسطول للموارد البشرية',
    desc: 'يرسل وثائق الأسطول المنتهية أو القريبة من الانتهاء إلى مجموعة الموارد البشرية.',
  },
  'py-hr-employee-expiry-001': {
    name: 'تذكير انتهاء إقامات وعقود الموظفين',
    desc: 'ينبه قبل انتهاء الإقامات والعقود ويرسل ملخصاً أسبوعياً للمنتهي منها.',
  },
  'py-fleet-accident-followup-001': {
    name: 'متابعة حوادث الأسطول',
    desc: 'يتابع حالات الحوادث المفتوحة ويذكر مجموعة الموارد البشرية بخطوات نجم وتقدير والمطالبة.',
  },
  'mkt-linkedin-playwright-review': {
    name: 'متابعة LinkedIn اليومية الآمنة',
    desc: 'ينفذ تفاعلات محدودة وآمنة على صفحة LinkedIn الخاصة بـ BCI وينبه Eng. Muhammad عند وجود أمر مهم.',
  },
  'py-watchdog-gateway-001': {
    name: 'مراقبة بوابة واتساب',
    desc: 'يفحص جاهزية بوابة OpenClaw وواتساب وينبه عند توقفها.',
  },
  'py-support-collections-queue-001': {
    name: 'تحديث قائمة التحصيل للدعم',
    desc: 'يقرأ الذمم المدينة من ERP ويجهز قائمة مدفوعات معلقة نظيفة لنظام الدعم المنفصل.',
  },
  'py-item-price-reply-promoter-001': {
    name: 'ترقية ردود أسعار المواد',
    desc: 'يعالج ردود أسعار الموردين بشكل آمن وقابل لإعادة التشغيل.',
  },
  'py-item-price-outreach-5h': {
    name: 'طلب أسعار المواد من الموردين',
    desc: 'يرسل دفعات من طلبات تحديث الأسعار للموردين لسد فجوات أسعار مواد BCI.',
  },
  'py-boss-instruction-instant-001': {
    name: 'مراقبة تعليمات Eng. Muhammad الفورية',
    desc: 'يتابع تعليمات Eng. Muhammad الجديدة أو المعدلة ويبلغ الموظف المعني فوراً.',
  },
  'py-boss-instruction-reminder-001': {
    name: 'تذكير تعليمات Eng. Muhammad المفتوحة',
    desc: 'يتابع التعليمات المفتوحة ويرسل تذكيراً للموظفين المعنيين.',
  },
  'py-smr-watcher-001': {
    name: 'مراقبة طلبات مواد المندوبين',
    desc: 'يتابع حالة طلبات مواد المندوبين في ERP ويبلغ Eng. Muhammad أو المندوب حسب المرحلة.',
  },
  'py-cash-receipt-group-watcher-001': {
    name: 'مراقبة سندات القبض في المجموعة',
    desc: 'يتابع دورة سند القبض في ERP ويعلن مراحل التسجيل والاستلام.',
  },
  'py-employee-daily-activity-reminder-001': {
    name: 'تذكير تقرير النشاط اليومي للموظفين',
    desc: 'يذكر موظفي المكتب النشطين الذين لم يرسلوا تقرير النشاط اليومي.',
  },
  '6898b94e-f142-4610-bc99-4143dbe1a2e4': {
    name: 'تنبيهات الدعم الفني',
    desc: 'ينبه عاصم بطلبات الدعم الجديدة والمكتملة، وينبه المندوب بردود الدعم الفني.',
  },
  '0dad0883-1fae-465e-9d9b-e673d6e4271b': {
    name: 'مراقبة ردود تعليمات Eng. Muhammad',
    desc: 'يتابع تعليقات تعليمات Eng. Muhammad في ERP وينقل ردود الموظفين أو ردود Eng. Muhammad للطرف المناسب.',
  },
};
function automationDisplay(job, name, desc) {
  const ar = AUTOMATION_AR_COPY[job.id] || {};
  return {
    name: { en: name, ar: ar.name || name },
    description: { en: desc, ar: ar.desc || desc },
  };
}

// ----------------------------------------------------------------------------
// Auto-categorization. Every automation lands in exactly one business category,
// inferred from its id/name/description by keyword — so a NEW cron job is filed
// automatically with no manual mapping. Order matters: most specific first.
// ----------------------------------------------------------------------------
const CATEGORIES = {
  procurement: { en: 'Procurement & Suppliers',   ar: 'المشتريات والموردون',        icon: '📦' },
  sales:       { en: 'Sales & Quotations',        ar: 'المبيعات وعروض الأسعار',     icon: '📈' },
  delivery:    { en: 'Delivery & Fleet',          ar: 'التوصيل والأسطول',           icon: '🚚' },
  accounts:    { en: 'Accounts & Collections',    ar: 'الحسابات والتحصيل',          icon: '💰' },
  rental:      { en: 'Rentals',                   ar: 'الإيجارات',                  icon: '🏢' },
  marketing:   { en: 'Marketing',                 ar: 'التسويق',                    icon: '📣' },
  hr:          { en: 'HR & Documents',            ar: 'الموارد البشرية والوثائق',   icon: '👤' },
  reports:     { en: 'Reports & Briefings',       ar: 'التقارير والملخصات',         icon: '📊' },
  system:      { en: 'System & Monitoring',       ar: 'النظام والمراقبة',           icon: '🛡️' },
  other:       { en: 'Other',                     ar: 'أخرى',                       icon: '🤖' },
};
const CATEGORY_ORDER = [
  'procurement', 'sales', 'delivery', 'accounts',
  'rental', 'marketing', 'hr', 'reports', 'system', 'other',
];
function categorize(job) {
  const full = `${job.id || ''} ${job.name || ''} ${job.description || ''}`.toLowerCase();
  const titleOnly = `${job.id || ''} ${job.name || ''}`.toLowerCase();
  // word-boundary match so short tokens (rent, po, mr) don't match inside
  // other words (e.g. "rent" inside "currently").
  const wb = (str, ks) => ks.some((k) =>
    new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(str));
  const has = (...ks) => wb(full, ks);          // match anywhere
  const named = (...ks) => wb(titleOnly, ks);   // match in the job's name/id only

  if (has('erp monitor', 'erp-monitor', 'morning briefing', 'eod summary', 'end-of-day')) return 'reports';
  if (has('rent', 'rental', 'rentals', 'sharafat', 'tenant')) return 'rental';
  if (has('marketing', 'mkt', 'linkedin', 'content', 'shakir')) return 'marketing';
  if (has('instruction', 'technical support')) return 'system';   // internal coordination
  if (has('collection', 'collections', 'receivable', 'receivables', 'cash receipt')) return 'accounts';
  // HR is keyed on the job NAME, so "reminds the HR group" in a fleet job
  // doesn't pull it out of Delivery.
  if (named('iqama', 'contract', 'expiry', 'activity report', 'hr')) return 'hr';
  if (has('rfq', 'supplier', 'suppliers', 'purchase order', 'po', 'material request', 'mr',
          'procurement', 'chemanalyst', 'price', 'barcode', 'raw material', 'smr')) return 'procurement';
  if (has('truck', 'trucks', 'oil', 'shipment', 'shipments', 'unengaged', 'fleet', 'accident',
          'delivery', 'intake', 'store')) return 'delivery';
  if (has('quotation', 'quotations', 'salesman', 'salesmen', 'sales', 'visit', 'target',
          'dn/so', 'tender', 'tenders', 'etimad')) return 'sales';
  if (has('briefing', 'brief', 'summary', 'report')) return 'reports';
  if (has('watchdog', 'gateway', 'memory', 'monitor', 'register', 'dashboard')) return 'system';
  return 'other';
}

// ----------------------------------------------------------------------------
// Date helpers (Asia/Riyadh)
// ----------------------------------------------------------------------------
function todayStr() {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function clockNow() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}
// "2026-06-14 10:27:46" -> "2026-06-14"
function logDate(t) { return String(t || '').slice(0, 10); }
// epoch seconds -> "X min ago" style {en, ar}
function ago(unixSec) {
  if (!unixSec) return { en: 'unknown', ar: 'غير معروف' };
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSec)));
  const m = Math.floor(diff / 60);
  const h = Math.floor(diff / 3600);
  const d = Math.floor(diff / 86400);
  if (diff < 60) return { en: 'just now', ar: 'الآن' };
  if (m < 60) return { en: `${m} min ago`, ar: `قبل ${m} دقيقة` };
  if (h < 24) return { en: `${h} hr ago`, ar: `قبل ${h} ساعة` };
  return { en: `${d} day(s) ago`, ar: `قبل ${d} يوم` };
}

// ----------------------------------------------------------------------------
// Cron humanizer -> {en, ar}. Falls back to the raw expression, never throws.
// fields: minute hour day-of-month month day-of-week
// ----------------------------------------------------------------------------
function hourLabel(h) {
  h = Number(h);
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}
function parseList(field) {
  // returns array of numbers for "8,14,17" or "8-10" or "8"; null if not simple
  if (/^\d+$/.test(field)) return [Number(field)];
  if (/^\d+(,\d+)+$/.test(field)) return field.split(',').map(Number);
  if (/^\d+-\d+$/.test(field)) {
    const [a, b] = field.split('-').map(Number);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  return null;
}
// "*/N" or "A-B/N" -> N (step), else null
function stepOf(field) {
  let m = /^\*\/(\d+)$/.exec(field); if (m) return Number(m[1]);
  m = /^\d+-\d+\/(\d+)$/.exec(field); if (m) return Number(m[1]);
  return null;
}
// "A-B" or "A-B/N" -> [A, B], else null
function rangeOf(field) {
  const m = /^(\d+)-(\d+)(?:\/\d+)?$/.exec(field);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
function windowLabel(win) {
  if (!win) return { en: '', ar: '' };
  if (win[0] >= 8 && win[1] <= 18) {
    return { en: ' during work hours', ar: ' خلال ساعات العمل' };
  }
  return {
    en: ` from ${hourLabel(win[0])} to ${hourLabel(win[1])}`,
    ar: ` من ${hourLabel(win[0])} إلى ${hourLabel(win[1])}`,
  };
}
function dayPart(hour) {
  const h = Number(hour);
  if (h >= 0 && h < 5) return { en: 'night', arPrefix: 'كل ليلة' };
  if (h >= 5 && h < 12) return { en: 'morning', arPrefix: 'كل صباح' };
  if (h >= 12 && h < 17) return { en: 'afternoon', arPrefix: 'كل يوم بعد الظهر' };
  return { en: 'evening', arPrefix: 'كل مساء' };
}
// day-of-week field -> bilingual note (cron: 0=Sun .. 5=Fri .. 6=Sat)
function dowNote(dow) {
  if (!dow || dow === '*') return { en: '', ar: '' };
  if (dow === '0-4,6') return { en: ' (not Fri)', ar: ' (عدا الجمعة)' };
  if (dow === '0-4') return { en: ' (Sun–Thu)', ar: ' (الأحد–الخميس)' };
  if (dow === '5') return { en: ' (Fri)', ar: ' (الجمعة)' };
  if (dow === '6') return { en: ' (Sat)', ar: ' (السبت)' };
  return { en: ' (some days)', ar: ' (أيام محددة)' };
}
function humanizeCron(expr) {
  try {
    const parts = String(expr).trim().split(/\s+/);
    if (parts.length < 5) return { en: expr, ar: expr };
    const [min, hour, dom, , dow] = parts;
    const dn = dowNote(dow);
    const win = rangeOf(hour);
    const winTxt = windowLabel(win);

    // minute = * -> always on
    if (min === '*') {
      return { en: `Continuously${winTxt.en}${dn.en}`, ar: `باستمرار${winTxt.ar}${dn.ar}` };
    }

    // minute frequency: */N, A-B/N, or evenly-spaced list (7,37)
    let mStep = stepOf(min);
    if (mStep == null) {
      const ml = parseList(min);
      if (ml && ml.length >= 2) {
        const diffs = [];
        for (let i = 1; i < ml.length; i++) diffs.push(ml[i] - ml[i - 1]);
        if (diffs.every((x) => x === diffs[0])) mStep = diffs[0];
      }
    }
    if (mStep != null) {
      return { en: `Every ${mStep} min${winTxt.en}${dn.en}`, ar: `كل ${mStep} دقيقة${winTxt.ar}${dn.ar}` };
    }

    // minute fixed -> times of day
    if (/^\d+$/.test(min)) {
      const mm = String(min).padStart(2, '0');
      const hStep = stepOf(hour);
      if (hStep != null) {
        return { en: `Every ${hStep} hr${winTxt.en}${dn.en}`, ar: `كل ${hStep} ساعة${winTxt.ar}${dn.ar}` };
      }
      if (hour === '*') {
        return { en: `Every hour at :${mm}${dn.en}`, ar: `كل ساعة عند الدقيقة ${mm}${dn.ar}` };
      }
      if (win) {
        return { en: `Every hour${winTxt.en}${dn.en}`, ar: `كل ساعة${winTxt.ar}${dn.ar}` };
      }
      const hours = parseList(hour);
      if (/^\d+$/.test(dom) && hours && hours.length === 1) {
        return {
          en: `day ${dom} each month, ${hours[0]}:${mm}`,
          ar: `يوم ${dom} من كل شهر، ${hours[0]}:${mm}`,
        };
      }
      if (hours && hours.length === 1) {
        const part = dayPart(hours[0]);
        return { en: `Every ${part.en} at ${hours[0]}:${mm}${dn.en}`, ar: `${part.arPrefix} عند ${hours[0]}:${mm}${dn.ar}` };
      }
      if (hours && hours.length > 1) {
        const list = hours.map((h) => `${h}:${mm}`).join(', ');
        return { en: `At ${list}${dn.en}`, ar: `الساعة ${list}${dn.ar}` };
      }
    }
    return { en: expr, ar: expr };
  } catch {
    return { en: String(expr), ar: String(expr) };
  }
}

// ----------------------------------------------------------------------------
// Source readers
// ----------------------------------------------------------------------------
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch {
    const bundled = readBundledJson(file);
    return bundled === undefined ? fallback : bundled;
  }
}

function readBundledJson(file) {
  const normalized = path.normalize(file);
  try {
    if (normalized === path.normalize(path.resolve(ROOT, 'data', 'jobs.json'))) return require('./data/jobs.json');
    if (normalized === path.normalize(path.resolve(ROOT, 'data', 'sent_log.json'))) return require('./data/sent_log.json');
    if (normalized === path.normalize(path.resolve(ROOT, 'data', 'openclaw.json'))) return require('./data/openclaw.json');
    if (normalized === path.normalize(path.resolve(ROOT, 'workflows.json'))) return require('./workflows.json');
  } catch {
    return undefined;
  }
  return undefined;
}

async function fetchMC(pathname) {
  if (!MC_KEY) return null;
  try {
    const res = await fetch(`${MC_URL}${pathname}`, {
      headers: { 'x-api-key': MC_KEY },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function erpCount(doctype, filters) {
  if (!ERP.enabled) return null;
  try {
    const params = new URLSearchParams({
      fields: JSON.stringify(['name']),
      filters: JSON.stringify(filters),
      limit_page_length: '0',
    });
    const url = `${ERP.url}/api/resource/${encodeURIComponent(doctype)}?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `token ${ERP.apiKey}:${ERP.apiSecret}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.data) ? json.data.length : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Build the boss payload
// ----------------------------------------------------------------------------
function cleanTarget(t) {
  let s = String(t || '').replace(/<[^>]*>/g, '').trim();
  s = s.replace(/\s*\(\+?\d[\d\s-]{6,}\)\s*/g, ' ');
  s = s.replace(/\s*\[[^\]]+\]\s*/g, ' ');
  if (/@g\.us\b/i.test(s)) return 'WhatsApp group';
  if (/^\+?\d[\d\s-]{7,}$/.test(s)) return maskPeer(s.startsWith('+') ? s : `+${s}`);
  s = s.replace(/\+?\d[\d\s-]{7,}/g, (m) => maskPeer(m.trim().startsWith('+') ? m.trim() : `+${m.trim()}`));
  return tidy(s);
}

function targetLabel(t) {
  const s = cleanTarget(t);
  if (!s) return '';
  if (/^boss(?:\s+dm)?$/i.test(s)) return 'Eng. Muhammad';
  return s;
}

function moneyNumber(raw) {
  return Number(String(raw || '').replace(/,/g, ''));
}
function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function formatMoney(currency, value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) return `${currency} ${(n / 1000000).toFixed(2).replace(/\.00$/, '')}M`;
  return `${currency} ${formatNumber(n)}`;
}
function moneyAmounts(text) {
  const s = String(text || '');
  const out = [];
  for (const m of s.matchAll(/\b(SAR|JOD|USD)\s*([0-9][0-9,]*(?:\.\d+)?)/gi)) {
    out.push({ currency: m[1].toUpperCase(), value: moneyNumber(m[2]) });
  }
  for (const m of s.matchAll(/\b([0-9][0-9,]*(?:\.\d+)?)\s*(SAR|JOD|USD)\b/gi)) {
    out.push({ currency: m[2].toUpperCase(), value: moneyNumber(m[1]) });
  }
  return out.filter((m) => Number.isFinite(m.value) && m.value > 0);
}
function firstMoneyLabel(text) {
  const m = moneyAmounts(text)[0];
  return m ? formatMoney(m.currency, m.value) : '';
}
function plural(n, one, many) {
  return Number(n) === 1 ? one : many;
}
function arCount(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function businessHeadline(text, target) {
  const raw = tidy(fixMojibake(text || ''));
  const to = targetLabel(target);
  let m;

  m = raw.match(/^(\d+)\s+new APC PO\(s\):\s*(.+)$/i);
  if (m) {
    const count = Number(m[1]);
    return {
      headline: {
        en: `Procurement sent ${count} new APC purchase ${plural(count, 'order', 'orders')}${to ? ` to ${to}` : ''}`,
        ar: `المشتريات أرسلت ${count} أوامر شراء جديدة من APC${to ? ` إلى ${to}` : ''}`,
      },
      impact: { en: `${count} POs`, ar: `${count} أوامر شراء` },
    };
  }

  m = raw.match(/^Collections brief:\s*([0-9,]+)\s+overdue invoices,\s*([0-9,]+(?:\.\d+)?)\s*SAR/i);
  if (m) {
    const invoices = m[1];
    const amount = formatMoney('SAR', moneyNumber(m[2]));
    return {
      headline: {
        en: `Accounts flagged ${invoices} overdue invoices worth ${amount}`,
        ar: `الحسابات نبهت على ${invoices} فواتير متأخرة بقيمة ${amount}`,
      },
      impact: { en: amount, ar: amount },
    };
  }

  m = raw.match(/^Rental group digest:\s*([0-9,]+)\s+tenants,\s*([0-9,]+(?:\.\d+)?)\s*JOD/i);
  if (m) {
    const tenants = m[1];
    const amount = formatMoney('JOD', moneyNumber(m[2]));
    return {
      headline: {
        en: `Rentals followed up ${tenants} tenants worth ${amount}`,
        ar: `الإيجارات تابعت ${tenants} مستأجرين بقيمة ${amount}`,
      },
      impact: { en: amount, ar: amount },
    };
  }

  m = raw.match(/^Team MTD\s+SAR\s*([0-9,]+)\/([0-9,]+)\s+across\s+([0-9,]+)\s+salesmen/i);
  if (m) {
    const actual = formatMoney('SAR', moneyNumber(m[1]));
    return {
      headline: {
        en: `Sales sent the monthly target update for ${m[3]} salesmen`,
        ar: `المبيعات أرسلت تحديث الهدف الشهري لعدد ${m[3]} مندوبي مبيعات`,
      },
      impact: { en: actual, ar: actual },
    };
  }

  m = raw.match(/^MTD\s+SAR\s*([0-9,]+)\/([0-9,]+),\s*rank\s*([0-9,]+)\/([0-9,]+)/i);
  if (m) {
    const actual = formatMoney('SAR', moneyNumber(m[1]));
    return {
      headline: {
        en: `Sales sent an individual target update${to ? ` to ${to}` : ''}`,
        ar: `المبيعات أرسلت تحديث هدف فردي${to ? ` إلى ${to}` : ''}`,
      },
      impact: { en: `${actual} | rank ${m[3]}/${m[4]}`, ar: `${actual} | الترتيب ${m[3]}/${m[4]}` },
    };
  }

  m = raw.match(/^([A-Z0-9-]+)\s+\((SAR|JOD|USD)\s*([0-9,]+(?:\.\d+)?)\)/i);
  if (m) {
    const amount = formatMoney(m[2].toUpperCase(), moneyNumber(m[3]));
    return {
      headline: {
        en: `Purchase order update: ${m[1]} worth ${amount}`,
        ar: `تحديث أمر شراء: ${m[1]} بقيمة ${amount}`,
      },
      impact: { en: amount, ar: amount },
    };
  }

  m = raw.match(/^(\d+)\s+new tenders/i);
  if (m) {
    return {
      headline: {
        en: `Sales found ${m[1]} matching tenders for review`,
        ar: `المبيعات وجدت ${m[1]} مناقصات مناسبة للمراجعة`,
      },
      impact: { en: `${m[1]} tenders`, ar: `${m[1]} مناقصات` },
    };
  }

  m = raw.match(/^(\d+)\s+payment reminder\(s\),\s*(\d+)\s+lease expiry notice\(s\)/i);
  if (m) {
    return {
      headline: {
        en: `Rentals sent ${m[1]} payment ${plural(m[1], 'reminder', 'reminders')} and ${m[2]} lease ${plural(m[2], 'notice', 'notices')}`,
        ar: `الإيجارات أرسلت ${m[1]} تذكيرات دفع و ${m[2]} تنبيهات عقود`,
      },
      impact: { en: `${Number(m[1]) + Number(m[2])} follow-ups`, ar: `${Number(m[1]) + Number(m[2])} متابعات` },
    };
  }

  m = raw.match(/^Agent\s+"([^"]+)"\s+marked offline/i);
  if (m) {
    return {
      headline: {
        en: `System flagged ${m[1]} as offline`,
        ar: `النظام نبه أن ${m[1]} غير متصل`,
      },
      impact: { en: 'System check', ar: 'فحص النظام' },
    };
  }

  const money = firstMoneyLabel(raw);
  return {
    headline: { en: raw, ar: raw },
    impact: money ? { en: money, ar: money } : null,
  };
}

function valueToday(todaySends, scriptsToday) {
  const totals = new Map();
  for (const e of todaySends) {
    for (const m of moneyAmounts(e.summary || '')) {
      totals.set(m.currency, (totals.get(m.currency) || 0) + m.value);
    }
  }
  const money = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([currency, value]) => formatMoney(currency, value))
    .filter(Boolean);
  const targets = new Set(todaySends.map((e) => cleanTarget(e.target)).filter(Boolean));
  const sends = todaySends.length;
  const scripts = scriptsToday.size;
  return [
    {
      icon: '$',
      label: { en: 'Money watched', ar: 'الأموال التي تمت متابعتها' },
      value: { en: money.length ? money.join(' + ') : 'No money updates', ar: money.length ? money.join(' + ') : 'لا توجد تحديثات مالية' },
    },
    {
      icon: '✓',
      label: { en: 'Approvals / follow-ups handled', ar: 'اعتمادات ومتابعات تمت' },
      value: {
        en: `${sends} ${plural(sends, 'update', 'updates')} | ${scripts} ${plural(scripts, 'task', 'tasks')}`,
        ar: `${arCount(sends, 'تحديث', 'تحديثات')} | ${arCount(scripts, 'مهمة', 'مهام')}`,
      },
    },
    {
      icon: '@',
      label: { en: 'Teams notified', ar: 'الفرق التي تم تنبيهها' },
      value: {
        en: `${targets.size} ${plural(targets.size, 'chat/group', 'chats/groups')}`,
        ar: arCount(targets.size, 'محادثة/مجموعة', 'محادثات/مجموعات'),
      },
    },
  ];
}

function workflowTotal(workflows) {
  return Object.entries(workflows || {})
    .filter(([id, wf]) => id && id[0] !== '_' && wf)
    .length;
}

function snapshotValue(agents, automations, workflows) {
  const workflowCount = workflowTotal(workflows);
  const teamAreas = new Set([
    ...agents.map((a) => a.area).filter(Boolean),
    ...automations.flatMap((a) => a.relatedAreas || []).filter(Boolean),
  ]);
  return [
    {
      icon: '✓',
      label: { en: 'Business checks published', ar: 'فحوصات العمل المنشورة' },
      value: {
        en: `${automations.length} ${plural(automations.length, 'check', 'checks')}`,
        ar: arCount(automations.length, 'فحص', 'فحوصات'),
      },
    },
    {
      icon: '↳',
      label: { en: 'Workflows mapped', ar: 'مسارات العمل الموثقة' },
      value: {
        en: `${workflowCount} ${plural(workflowCount, 'workflow', 'workflows')}`,
        ar: arCount(workflowCount, 'مسار عمل', 'مسارات عمل'),
      },
    },
    {
      icon: '@',
      label: { en: 'Teams covered', ar: 'الفرق المغطاة' },
      value: {
        en: `${teamAreas.size} ${plural(teamAreas.size, 'team area', 'team areas')}`,
        ar: arCount(teamAreas.size, 'فريق', 'فرق'),
      },
    },
  ];
}

function buildChannels(openclaw, automations) {
  const bindings = Array.isArray(openclaw.bindings) ? openclaw.bindings : [];
  const whatsapp = (openclaw.channels && openclaw.channels.whatsapp) || {};
  const groups = whatsapp.groups || {};
  const allowFrom = new Set((whatsapp.allowFrom || []).map((x) => String(x)));
  const seenNames = new Map();

  return bindings
    .map((b, index) => {
      const match = b.match || {};
      const peer = match.peer || {};
      const channel = match.channel || 'whatsapp';
      const kind = peer.kind || 'direct';
      const peerId = String(peer.id || '');
      const area = areaForAgentId(b.agentId);
      const groupCfg = groups[peerId] || {};
      const baseName = channelLabel(kind, area, peerId, seenNames.get(`${area}:${kind}`) || 0);
      seenNames.set(`${area}:${kind}`, (seenNames.get(`${area}:${kind}`) || 0) + 1);
      const relatedAutomations = area
        ? automations.filter((a) => (a.relatedAreas || []).includes(area)).length
        : 0;
      const policy = kind === 'group'
        ? (groupCfg.requireMention ? 'mention' : 'open')
        : (allowFrom.has(peerId) ? 'reply allowed' : 'not allowlisted');
      return {
        id: `channel-${index}`,
        channel,
        kind,
        name: baseName,
        peer: maskPeer(peerId),
        areaKey: area,
        owner: areaName(area),
        policy,
        relatedAutomations,
      };
    })
    .filter((c) => c.channel && c.kind && c.peer)
    .sort((a, b) =>
      a.channel.localeCompare(b.channel) ||
      (a.kind === b.kind ? 0 : (a.kind === 'group' ? -1 : 1)) ||
      (a.owner || '').localeCompare(b.owner || '') ||
      a.name.localeCompare(b.name));
}

async function buildSummary() {
  const today = todayStr();
  const workflows = readJsonSafe(WORKFLOWS, {});
  const openclaw = readJsonSafe(OPENCLAW, {});

  // --- a) Agents (Mission Control) ---
  let agents = [];
  let mcReachable = false;
  const mcConfigured = !!MC_KEY;
  const agentsResp = await fetchMC('/api/agents?limit=100');
  if (agentsResp && Array.isArray(agentsResp.agents)) {
    mcReachable = true;
    agents = agentsResp.agents
      .filter((a) => !isInfraAgent(a.name))
      .map((a) => {
        const raw = String(a.status || 'offline').toLowerCase();
        let state = 'resting';
        if (raw === 'idle' || raw === 'busy' || raw === 'online' || raw === 'active') state = 'working';
        else if (raw === 'error') state = 'attention';
        const display = String(a.name).toLowerCase() === 'main' ? 'Fahad' : a.name;
        const area = agentArea(a.role, a.name);
        return {
          name: display,
          area,
          role: roleLabel(roleKeyFromMc(a.role, a.name)),
          summary: AREA_SUMMARY[area] || roleLabel(roleKeyFromMc(a.role, a.name)),
          state,
          lastActive: ago(a.last_seen),
          workflowCount: Object.values(workflows).filter((w) => w && w.area === area).length,
        };
      });
  }
  const agentsWorking = agents.filter((a) => a.state === 'working').length;
  const anyAttention = agents.some((a) => a.state === 'attention');

  // --- b) Scheduled automations (cron/jobs.json) ---
  const cronData = readJsonSafe(CRON_JOBS, { jobs: [] });
  const allJobs = Array.isArray(cronData.jobs) ? cronData.jobs : [];
  const enabledJobs = allJobs.filter((j) => j.enabled === true);
  const automations = enabledJobs.map((j) => {
    const sch = j.schedule || {};
    let when = { en: 'scheduled', ar: 'مجدول' };
    if (sch.kind === 'cron' && sch.expr) when = humanizeCron(sch.expr);
    else if (sch.kind === 'at' && sch.at) {
      const d = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, dateStyle: 'medium', timeStyle: 'short',
      }).format(new Date(sch.at));
      when = { en: `once: ${d}`, ar: `مرة واحدة: ${d}` };
    }
    const wf = workflows[j.id];
    const catKey = categorize(j);
    const areas = inferAutomationAreas(j, wf, catKey);
    const name = cleanName(j.name || j.id);
    const description = cleanDesc(j.description || '');
    const display = automationDisplay(j, name, description);
    return {
      id: j.id,
      name,
      description,
      displayName: display.name,
      displayDescription: display.description,
      areaKey: areas.primary,
      relatedAreas: areas.relatedAreas,
      area: areaName(areas.primary),
      category: { key: catKey, ...CATEGORIES[catKey] },
      when,
      hasWorkflow: !!wf,
    };
  });
  // ordered list of categories that actually have active automations (+counts)
  const categories = CATEGORY_ORDER
    .map((key) => ({
      key,
      ...CATEGORIES[key],
      count: automations.filter((a) => a.category.key === key).length,
    }))
    .filter((c) => c.count > 0);

  const automationCountFor = (area) =>
    automations.filter((a) => (a.relatedAreas || []).includes(area)).length;
  for (const a of agents) {
    a.automationCount = automationCountFor(a.area);
  }
  const seenAreas = new Set(agents.map((a) => a.area));
  for (const [area, meta] of Object.entries(AREA)) {
    if (seenAreas.has(area)) continue;
    const automationCount = automationCountFor(area);
    if (!automationCount) continue;
    agents.push({
      name: meta.name,
      area,
      role: roleLabel(meta.role),
      summary: AREA_SUMMARY[area] || roleLabel(meta.role),
      state: 'resting',
      lastActive: { en: '', ar: '' },
      workflowCount: Object.values(workflows).filter((w) => w && w.area === area).length,
      automationCount,
    });
  }
  const channels = buildChannels(openclaw, automations);

  // --- c) Today's activity + numbers ---
  const sent = readJsonSafe(SENT_LOG, []);
  const todaySends = (Array.isArray(sent) ? sent : [])
    .filter((e) => e && e.success === true && logDate(e.time) === today);

  const activity = todaySends.map((e) => {
    const friendly = businessHeadline(e.summary || '', e.target);
    return {
      time: String(e.time || '').slice(11, 16),
      sortKey: String(e.time || ''),
      text: e.summary || '',
      headline: friendly.headline,
      impact: friendly.impact,
      to: targetLabel(e.target),
      source: 'send',
    };
  });

  // merge a few MC human-readable activities
  const acts = await fetchMC('/api/activities?limit=40');
  if (acts && Array.isArray(acts.activities)) {
    for (const a of acts.activities) {
      const created = a.created_at ? new Date(a.created_at * 1000 || a.created_at) : null;
      const d = created
        ? new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(created)
        : null;
      if (d && d !== today) continue;
      if (!a.description) continue;
      if (/^Agent\s+"[^"]+"\s+marked offline/i.test(a.description)) continue;
      const friendly = businessHeadline(a.description, a.actor);
      activity.push({
        time: created
          ? new Intl.DateTimeFormat('en-GB', {
              timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
            }).format(created)
          : '',
        sortKey: a.created_at ? String(a.created_at) : '',
        text: a.description,
        headline: friendly.headline,
        impact: friendly.impact,
        to: a.actor === 'main' ? 'Fahad' : (a.actor || ''),
        source: 'agent',
      });
    }
  }
  activity.sort((x, y) => (y.sortKey > x.sortKey ? 1 : -1));
  const activityTop = activity.slice(0, 25);

  const scriptsToday = new Set(todaySends.map((e) => e.script).filter(Boolean));

  // --- d) Optional ERP headline numbers (reads are free) ---
  const [posPending, mrsOpen] = await Promise.all([
    erpCount('Purchase Order', [['docstatus', '=', 0]]),
    erpCount('Material Request', [['docstatus', '=', 0]]),
  ]);

  const numbers = {
    messagesSentToday: todaySends.length,
    automationsRunToday: scriptsToday.size,
    activeAutomations: enabledJobs.length,
    totalAutomations: allJobs.length,
    workflowCount: workflowTotal(workflows),
    channelsTotal: channels.length,
    agentsWorking,
    agentsTotal: agents.length,
    posPending,   // null if ERP unreachable
    mrsOpen,      // null if ERP unreachable
  };

  const sourceMode = mcReachable ? 'live' : (mcConfigured ? 'offline' : 'snapshot');
  const missionControlMissing = mcConfigured && !mcReachable;
  const overallStatus = (missionControlMissing || anyAttention) ? 'attention' : 'good';
  const attentionItems = [];
  if (missionControlMissing) {
    attentionItems.push({
      title: { en: 'Control panel is unreachable', ar: 'تعذر الاتصال بلوحة التحكم' },
      desc: { en: 'Team status may be stale until Mission Control is back online', ar: 'قد تكون حالة الفريق غير محدثة حتى يعود الاتصال' },
      tag: { en: 'System', ar: 'النظام' },
    });
  }
  for (const a of agents.filter((agent) => agent.state === 'attention')) {
    attentionItems.push({
      title: { en: a.name, ar: a.name },
      desc: a.summary || a.role,
      tag: { en: 'Team member needs review', ar: 'عضو يحتاج مراجعة' },
    });
  }

  return {
    overallStatus,
    mcReachable,
    mcConfigured,
    sourceMode,
    agents,
    automations,
    channels,
    categories,
    numbers,
    valueToday: sourceMode === 'snapshot' && todaySends.length === 0
      ? snapshotValue(agents, automations, workflows)
      : valueToday(todaySends, scriptsToday),
    attentionItems,
    activity: activityTop,
    generatedAt: clockNow(),
  };
}

// ----------------------------------------------------------------------------
// Tiny HTTP server
// ----------------------------------------------------------------------------
const COOKIE = 'boss_auth';
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > -1) out[c.slice(0, i).trim()] = c.slice(i + 1).trim();
  });
  return out;
}
function authed(req) {
  if (!PASSWORD) return true;
  return parseCookies(req)[COOKIE] === PASSWORD;
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, headers);
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(d));
  });
}

const LOGIN_PAGE = (msg = '') => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login</title><style>
body{font-family:system-ui,Segoe UI,Arial;background:#f4f6f9;display:grid;place-items:center;height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:300px;text-align:center}
input{width:100%;padding:12px;margin:12px 0;border:1px solid #ddd;border-radius:10px;font-size:16px;box-sizing:border-box}
button{width:100%;padding:12px;border:0;border-radius:10px;background:#1f6feb;color:#fff;font-size:16px;cursor:pointer}
.m{color:#c0392b;font-size:13px;min-height:16px}</style></head>
<body><form method="post" action="/login"><h2>Dashboard</h2>
<div class="m">${msg}</div>
<input type="password" name="password" placeholder="Password" autofocus>
<button type="submit">Enter</button></form></body></html>`;

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // login flow
  if (PASSWORD && url.pathname === '/login') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const pw = new URLSearchParams(body).get('password') || '';
      if (pw === PASSWORD) {
        return send(res, 302, '', {
          Location: '/',
          'Set-Cookie': `${COOKIE}=${PASSWORD}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`,
        });
      }
      return send(res, 401, LOGIN_PAGE('Wrong password'), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    return send(res, 200, LOGIN_PAGE(), { 'Content-Type': 'text/html; charset=utf-8' });
  }

  if (!authed(req)) {
    return send(res, 302, '', { Location: '/login' });
  }

  if (url.pathname === '/api/workflows') {
    const wf = readJsonSafe(WORKFLOWS, {});
    return send(res, 200, JSON.stringify(wf), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }

  if (url.pathname === '/api/summary') {
    try {
      const data = await buildSummary();
      return send(res, 200, JSON.stringify(data), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    } catch (err) {
      return send(res, 500, JSON.stringify({ error: 'summary_failed' }), {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'));
      return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    } catch {
      return send(res, 500, 'index.html missing');
    }
  }

  send(res, 404, 'Not found');
}

module.exports = handleRequest;

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, BIND, () => {
    console.log(`Boss dashboard running on http://${BIND}:${PORT}`);
    console.log(`  Mission Control: ${MC_URL}`);
    console.log(`  Password gate:   ${PASSWORD ? 'ON' : 'off (open on this network)'}`);
  });
}
