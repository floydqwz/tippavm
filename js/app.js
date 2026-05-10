import { TEAMS, GROUPS, GROUP_MATCHES, KO_MATCHES, MATCHES } from './schedule.js';
import { standings, isGroupComplete, allGroupsComplete, resolveKnockout, thirdPlaceRanking, isFinished } from './bracket.js';

function countFinished(bucket) {
  return Object.values(bucket).filter(isFinished).length;
}
import { emptyState, loadLocal, saveLocal, encodeShare, decodeShare, shareUrl, copyToClipboard, listLocal, existsLocal, removeLocal, renameLocal, copyLocal } from './share.js';

// === Hjälp =================================================================

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v === false || v == null) {}
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function flag(code) {
  const t = TEAMS[code];
  if (!t) return el('span', { class: 'fi' });
  return el('span', { class: `fi fi-${t.iso}`, title: t.name });
}

function teamName(code) {
  return TEAMS[code]?.name || code;
}

// Svenska datum/tid
const WEEKDAYS = ['söndag','måndag','tisdag','onsdag','torsdag','fredag','lördag'];
const MONTHS = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];

function fmtDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function fmtKickoff(iso, time) {
  // time = "20:00 UTC-6" → konvertera till svensk tid (CEST = UTC+2 i juni-juli)
  const m = /^(\d{1,2}):(\d{2})\s+UTC([+-]\d+)$/.exec(time);
  if (!m) return time;
  const hh = parseInt(m[1],10), mm = parseInt(m[2],10), off = parseInt(m[3],10);
  // UTC-tid = lokal tid - offset
  const utcMin = hh*60 + mm - off*60;
  // CEST = UTC+2 (alla VM-matcher i juni/juli, sommartid i Sverige)
  const swMin = utcMin + 2*60;
  const swHH = ((swMin % (24*60)) + 24*60) % (24*60);
  const dayShift = Math.floor(swMin / (24*60));
  const H = String(Math.floor(swHH/60)).padStart(2,'0');
  const M = String(swHH%60).padStart(2,'0');
  // Datumförskjutning
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dayShift);
  const swedish = `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return `${swedish} kl ${H}:${M}`;
}

function fmtVenue(v) {
  // "Los Angeles (Inglewood)" → "Los Angeles"
  return v.replace(/\s*\([^)]*\)\s*$/, '');
}

// === Modaler =============================================================
// Använder <dialog> för bra fokus/tangentbordshantering. ESC stänger automatiskt.

function buildModal(bodyNode, buttons) {
  const dlg = el('dialog', { class: 'modal' });
  dlg.appendChild(bodyNode);
  const actions = el('div', { class: 'modal-actions' });
  buttons.forEach(b => actions.appendChild(b));
  dlg.appendChild(actions);
  document.body.appendChild(dlg);
  return dlg;
}

function modalAlert(message) {
  return new Promise(resolve => {
    let dlg;
    const okBtn = el('button', { class: 'primary', onclick: () => dlg.close() }, 'OK');
    const body = el('p', {}, message);
    dlg = buildModal(body, [okBtn]);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(); });
    dlg.showModal();
    okBtn.focus();
  });
}

function modalConfirm(message, opts = {}) {
  const okLabel = opts.okLabel || 'OK';
  const cancelLabel = opts.cancelLabel || 'Avbryt';
  const danger = !!opts.danger;
  return new Promise(resolve => {
    let dlg, result = false;
    const cancelBtn = el('button', { onclick: () => { result = false; dlg.close(); } }, cancelLabel);
    const okBtn = el('button', {
      class: danger ? 'danger' : 'primary',
      onclick: () => { result = true; dlg.close(); },
    }, okLabel);
    const body = el('p', {}, message);
    dlg = buildModal(body, [cancelBtn, okBtn]);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    okBtn.focus();
  });
}

function modalPrompt(message, defaultValue = '', opts = {}) {
  const okLabel = opts.okLabel || 'OK';
  const cancelLabel = opts.cancelLabel || 'Avbryt';
  return new Promise(resolve => {
    let dlg, result = null;
    const inp = el('input', { type: 'text', value: defaultValue });
    const body = el('div', {},
      el('p', {}, message),
      inp
    );
    const cancelBtn = el('button', { onclick: () => { result = null; dlg.close(); } }, cancelLabel);
    const okBtn = el('button', { class: 'primary', onclick: () => { result = inp.value; dlg.close(); } }, okLabel);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); result = inp.value; dlg.close(); }
    });
    dlg = buildModal(body, [cancelBtn, okBtn]);
    dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
    dlg.showModal();
    inp.focus();
    inp.select();
  });
}

// === State =================================================================

let state = emptyState();
let readonly = false; // sant om vi tittar på en delad tippning
let sharedFromName = null;

let saveTimer = null;
function scheduleSave() {
  if (readonly) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveLocal(state), 300);
}

// === Routing ===============================================================

const routes = {
  '/': renderStart,
  '/grupper': renderGroups,
  '/slutspel': renderKnockout,
  '/sammanfattning': renderSummary,
};

function go(path) {
  if (location.hash !== '#' + path) location.hash = path;
  else render();
}

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  if (h.startsWith('share=')) {
    const tok = h.slice('share='.length);
    return { type: 'share', token: tok };
  }
  if (h && routes[h]) return { type: 'page', path: h };
  if (state.name) return { type: 'page', path: '/grupper' };
  return { type: 'page', path: '/' };
}

window.addEventListener('hashchange', () => {
  render();
  // Vid sidbyte: börja från toppen istället för där förra vyn råkat sluta
  window.scrollTo(0, 0);
});

// === Render ================================================================

function render() {
  const route = currentRoute();
  if (route.type === 'share') {
    const decoded = decodeShare(route.token);
    if (!decoded) {
      $('#app').innerHTML = '';
      $('#app').appendChild(el('div', { class: 'card notice error' }, 'Ogiltig delningslänk. ',
        el('a', { href: '#/' }, 'Tillbaka till start')));
      showShell();
      return;
    }
    state = decoded;
    sharedFromName = decoded.name;
    readonly = true;
    showShell();
    showSharedBanner();
    renderGroups();
    return;
  }
  if (route.type === 'page') {
    readonly = false;
    sharedFromName = null;
  }
  // Startsidan visar formuläret, övriga vyer fungerar även utan satt namn –
  // vi auto-initierar då en tippning under ett standardnamn så användaren
  // kan börja tippa direkt och döpa om sin tippning när som helst.
  if (route.path === '/') {
    showShell();
    renderStart();
    highlightTab('/');
    return;
  }
  if (!state.name) ensureDefaultState();
  showShell();
  const fn = routes[route.path] || renderGroups;
  fn();
  highlightTab(route.path);
}

function ensureDefaultState() {
  const defaultName = 'Min tippning';
  state = loadLocal(defaultName) || emptyState(defaultName);
  state.name = defaultName;
  saveLocal(state);
}

function showShell() {
  // Tabs alltid synliga; "who"-delen visar ett namn när vi har ett.
  const who = $('#who');
  who.innerHTML = '';
  if (state.name) {
    const nameEl = readonly
      ? el('span', { class: 'name' }, state.name)
      : el('button', {
          class: 'name-link',
          onclick: doInlineRename,
          title: 'Klicka för att byta namn på tippningen',
        }, state.name);
    who.appendChild(el('span', {}, 'Tippar som: ', nameEl));
    if (readonly) who.appendChild(el('span', { class: 'badge' }, 'delad'));
  }
}

async function doInlineRename() {
  if (readonly || !state.name) return;
  const oldName = state.name;
  const raw = await modalPrompt('Nytt namn för din tippning:', oldName);
  if (raw == null) return;
  const newName = raw.trim();
  if (!newName) { await modalAlert('Namnet får inte vara tomt.'); return; }
  if (newName === oldName) return;
  if (existsLocal(newName)) {
    await modalAlert(`Namnet "${newName}" är redan upptaget.`);
    return;
  }
  renameLocal(oldName, newName);
  state.name = newName;
  showShell();
}

function showSharedBanner() {
  const tpl = $('#tpl-shared').content.cloneNode(true);
  const sect = tpl.querySelector('section');
  const owner = sharedFromName || 'någon';
  // Svenskt genitiv: namn på s/x/z får inget extra s ("Markus tippning", inte "Markuss")
  const suffix = /[sxzSXZ]$/.test(owner) ? '' : 's';
  sect.querySelector('.shared-title').textContent = `Du tittar på ${owner}${suffix} tippning`;
  sect.querySelector('#fork-btn').addEventListener('click', async () => {
    if (!await modalConfirm('Skapa en egen kopia av den här tippningen att redigera?')) return;
    const newName = await modalPrompt('Vad heter du?', '');
    if (!newName || !newName.trim()) return;
    state = { ...state, name: newName.trim() };
    readonly = false; sharedFromName = null;
    saveLocal(state);
    location.hash = '#/grupper';
  });
  sect.querySelector('#copy-link-btn').addEventListener('click', async () => {
    const ok = await copyToClipboard(location.href);
    await modalAlert(ok ? 'Länken kopierad!' : 'Kunde inte kopiera. Markera URL:en manuellt.');
  });
  $('#app').appendChild(tpl);
}

function highlightTab(path) {
  $$('#nav a').forEach(a => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + path);
  });
}

// --- Startsida -------------------------------------------------------------

function renderSavedRow(name) {
  const open = () => {
    state = loadLocal(name) || emptyState(name);
    state.name = name;
    readonly = false;
    go('/grupper');
  };
  const askName = async (text, defaultVal) => {
    const raw = await modalPrompt(text, defaultVal);
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (!trimmed) { await modalAlert('Namnet får inte vara tomt.'); return null; }
    return trimmed;
  };
  const doRename = async () => {
    const newName = await askName('Nytt namn för tippningen:', name);
    if (!newName || newName === name) return;
    if (existsLocal(newName)) {
      await modalAlert(`Namnet "${newName}" är redan upptaget.`);
      return;
    }
    renameLocal(name, newName);
    if (state.name === name) state.name = newName;
    renderStart();
  };
  const doCopy = async () => {
    const newName = await askName(`Kopiera "${name}" till nytt namn:`, name + ' (kopia)');
    if (!newName) return;
    if (existsLocal(newName)) {
      await modalAlert(`Namnet "${newName}" är redan upptaget.`);
      return;
    }
    copyLocal(name, newName);
    renderStart();
  };
  const doRemove = async () => {
    const ok = await modalConfirm(
      `Ta bort tippningen "${name}"? Det går inte att ångra.`,
      { okLabel: 'Ta bort', danger: true }
    );
    if (!ok) return;
    removeLocal(name);
    if (state.name === name) state = emptyState();
    renderStart();
  };
  return el('li', { class: 'saved-row' },
    el('button', { class: 'saved-name', onclick: open, title: 'Öppna tippningen' }, name),
    el('div', { class: 'saved-actions' },
      el('button', { class: 'icon-btn', onclick: doRename, title: 'Byt namn' }, '✎'),
      el('button', { class: 'icon-btn', onclick: doCopy, title: 'Kopiera' }, '⎘'),
      el('button', { class: 'icon-btn danger', onclick: doRemove, title: 'Ta bort' }, '✕'),
    )
  );
}

function renderStart() {
  const app = $('#app');
  app.innerHTML = '';
  const tpl = $('#tpl-start').content.cloneNode(true);
  app.appendChild(tpl);

  // Lista befintliga lokala tippningar
  const names = listLocal().sort((a, b) => a.localeCompare(b, 'sv'));
  if (names.length) {
    const list = el('ul', { class: 'saved-list' },
      ...names.map(n => renderSavedRow(n))
    );
    const card = el('section', { class: 'card' },
      el('h2', {}, 'Fortsätt på en sparad tippning'),
      list
    );
    app.appendChild(card);
  }

  $('#start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = e.target.name.value.trim();
    if (!name) return;
    const existing = loadLocal(name);
    state = existing || emptyState(name);
    state.name = name;
    readonly = false;
    go('/grupper');
  });
}

// --- Slumpa --------------------------------------------------------------

// Vikter ungefär kalibrerade mot historisk VM-statistik (~1.4 mål per lag/match).
function randomGoals() {
  const r = Math.random();
  if (r < 0.22) return 0;
  if (r < 0.55) return 1;
  if (r < 0.80) return 2;
  if (r < 0.92) return 3;
  if (r < 0.97) return 4;
  if (r < 0.99) return 5;
  return 6;
}

function randomFillUntipped() {
  if (readonly) return 0;
  let n = 0;
  for (const m of GROUP_MATCHES) {
    if (!isFinished(state.group[m.num])) {
      state.group[m.num] = [randomGoals(), randomGoals()];
      n++;
    }
  }
  // Slutspel i num-ordning så att en match har lösta hemma/borta innan vi
  // ev. behöver välja straffvinnare för att låsa winner till nästa rond.
  const koSorted = KO_MATCHES.slice().sort((a, b) => a.num - b.num);
  for (const m of koSorted) {
    if (!isFinished(state.ko[m.num])) {
      state.ko[m.num] = [randomGoals(), randomGoals()];
      n++;
    }
    const p = state.ko[m.num];
    if (p[0] === p[1] && !state.pen[m.num]) {
      const r = resolveKnockout({ ...state.group, ...state.ko, ...prefixedPen() });
      const slot = r[m.num];
      if (slot && slot.home && slot.away) {
        state.pen[m.num] = Math.random() < 0.5 ? slot.home : slot.away;
      }
    }
  }
  scheduleSave();
  return n;
}

async function handleRandomClick() {
  const groupLeft = GROUP_MATCHES.length - countFinished(state.group);
  const koLeft = KO_MATCHES.length - countFinished(state.ko);
  const total = groupLeft + koLeft;
  if (total === 0) {
    await modalAlert('Allt är redan tippat!');
    return;
  }
  if (!await modalConfirm(`Slumpa resultat för ${total} otippade matcher?`, { okLabel: 'Slumpa' })) return;
  randomFillUntipped();
  render();
}

function renderProgressBanner() {
  const totalDone = countFinished(state.group) + countFinished(state.ko);
  const total = MATCHES.length;
  const left = total - totalDone;
  const pct = Math.round(100 * totalDone / total);
  return el('div', { class: 'progress' },
    el('span', {}, `${totalDone} / ${total} matcher tippade`),
    el('div', { class: 'progress-bar' }, el('div', { style: `width: ${pct}%` })),
    el('span', { class: 'small muted' }, `${pct}%`),
    !readonly && left > 0 && el('button', {
      class: 'random-btn',
      onclick: handleRandomClick,
      title: 'Slumpa resultat för alla matcher du inte har tippat',
    }, `🎲 Slumpa ${left} otippade`)
  );
}

// --- Gruppspel -------------------------------------------------------------

function renderGroups() {
  const app = $('#app');
  if (!readonly) app.innerHTML = '';

  app.appendChild(renderProgressBanner());

  const ranking = thirdPlaceRanking(state.group);
  const advancingThirds = ranking ? new Set(ranking.slice(0, 8).map(r => r.group)) : null;

  const grid = el('div', { class: 'groups-grid' });
  for (const g of GROUPS) {
    grid.appendChild(renderGroupCard(g, advancingThirds));
  }
  app.appendChild(grid);

  if (ranking) {
    app.appendChild(renderThirdsCard(ranking));
  }

  if (allGroupsComplete(state.group)) {
    app.appendChild(el('div', { class: 'card notice info cta' },
      el('span', {}, 'Alla gruppmatcher tippade!'),
      el('a', { href: '#/slutspel', class: 'cta-link' }, 'Gå vidare till slutspelet')
    ));
  }
}

function renderThirdsCard(ranking) {
  const card = el('section', { class: 'card' });
  card.appendChild(el('h3', {}, 'Bästa treor'));
  card.appendChild(el('p', { class: 'muted small' },
    'Topp 8 går vidare till slutspelet, övriga fyra åker hem. Rangordning: poäng, målskillnad, gjorda mål, lottning.'));
  const t = el('table', { class: 'standings thirds-table' },
    el('thead', {}, el('tr', {},
      el('th', { class: 'pos' }, '#'),
      el('th', {}, 'Grupp'),
      el('th', { class: 'team-cell' }, 'Lag'),
      el('th', {}, 'P'),
      el('th', { class: 'diff' }, '+/-'),
      el('th', {}, 'GM'),
    ))
  );
  const body = el('tbody');
  ranking.forEach((r, i) => {
    if (i === 8) {
      body.appendChild(el('tr', { class: 'divider' }, el('td', { colspan: '6' })));
    }
    const cls = i < 8 ? 'qualified' : 'eliminated';
    body.appendChild(el('tr', { class: cls },
      el('td', { class: 'pos' }, String(i+1)),
      el('td', {}, r.group),
      el('td', { class: 'team-cell' }, flag(r.team), el('span', { class: 'tn' }, teamName(r.team))),
      el('td', {}, String(r.pts)),
      el('td', { class: 'diff' }, (r.gd > 0 ? '+' : '') + r.gd),
      el('td', {}, String(r.gf))
    ));
  });
  t.appendChild(body);
  card.appendChild(t);
  return card;
}

function renderGroupCard(group, advancingThirds) {
  const matches = GROUP_MATCHES.filter(m => m.group === group.id);
  const tableRows = standings(group.id, state.group);
  const card = el('section', { class: 'card group' });
  card.appendChild(el('h3', {}, `Grupp ${group.id}`));

  // Matchlista
  const list = el('div', { class: 'matches' });
  for (const m of matches) {
    list.appendChild(renderGroupMatch(m));
  }
  card.appendChild(list);

  // Tabell
  card.appendChild(renderStandingsTable(tableRows, advancingThirds, group.id));
  return card;
}

function renderGroupMatch(m) {
  const pred = state.group[m.num] || ['', ''];
  const row = el('div', { class: 'match-row' + (readonly ? ' readonly' : '') });
  row.title = fmtKickoff(m.date, m.time) + ' · ' + fmtVenue(m.venue);
  row.appendChild(el('span', { class: 'when' }, `${m.date.slice(8,10)}/${m.date.slice(5,7)}`));
  row.appendChild(el('span', { class: 'home' },
    el('span', { class: 'tn' }, teamName(m.home)), flag(m.home)));
  row.appendChild(makeScoreInput(m, 'home', pred[0]));
  row.appendChild(el('span', { class: 'vs' }, '–'));
  row.appendChild(makeScoreInput(m, 'away', pred[1]));
  row.appendChild(el('span', { class: 'away' },
    flag(m.away), el('span', { class: 'tn' }, teamName(m.away))));
  return row;
}

function makeScoreInput(m, side, value) {
  const input = el('input', {
    class: 'score',
    type: 'number',
    min: '0', max: '9',
    inputmode: 'numeric',
    value: value === '' || value == null ? '' : String(value),
    'data-num': m.num,
    'data-side': side,
  });
  if (readonly) input.readOnly = true;
  input.addEventListener('input', onScoreInput);
  return input;
}

function onScoreInput(e) {
  if (readonly) return;
  const num = parseInt(e.target.dataset.num, 10);
  const side = e.target.dataset.side;
  const raw = e.target.value;
  const val = raw === '' ? null : Math.max(0, Math.min(9, parseInt(raw, 10) || 0));

  const isGroup = MATCHES.find(x => x.num === num).stage === 'GROUP';
  const bucket = isGroup ? state.group : state.ko;
  const cur = bucket[num] || [null, null];
  const updated = side === 'home' ? [val, cur[1]] : [cur[0], val];
  if (updated[0] == null && updated[1] == null) delete bucket[num];
  else bucket[num] = updated;
  scheduleSave();

  // Auto-fokus: hoppa direkt till nästa scoreruta när en siffra angetts.
  // Vi stödjer bara 0–9 så det finns ingen anledning att vänta in fler siffror.
  const shouldAdvance = /^[0-9]$/.test(raw);

  // Re-render only the affected group card (for live standings)
  if (isGroup) {
    const m = MATCHES.find(x => x.num === num);
    rerenderGroup(m.group);
    updateGroupProgress();
  } else {
    // Slutspel: rendera om hela slutspelsvyn för att propagera
    rerenderKnockout();
  }

  if (shouldAdvance) focusNextScore(num, side);
}

function focusNextScore(num, side) {
  const inputs = [...document.querySelectorAll('input.score')]
    .filter(i => !i.disabled && !i.readOnly);
  const idx = inputs.findIndex(i =>
    i.dataset.num === String(num) && i.dataset.side === side);
  if (idx < 0 || idx === inputs.length - 1) return;
  const next = inputs[idx + 1];
  next.focus();
  next.select();
}

function rerenderGroup(groupId) {
  // När alla grupper är tippade kan en ändring rubba treornas rangordning,
  // vilket påverkar färgkodningen i alla 12 grupper + "Bästa treor"-tabellen.
  // Då rendera hela vyn om. Annars räcker det att uppdatera den ändrade gruppen.
  const focusKey = currentFocusKey();
  if (allGroupsComplete(state.group)) {
    renderGroups();
    restoreFocus(focusKey);
    return;
  }
  const cards = $$('.groups-grid .group');
  const idx = GROUPS.findIndex(g => g.id === groupId);
  if (idx < 0) return;
  const old = cards[idx];
  if (!old) return;
  const fresh = renderGroupCard(GROUPS[idx], null);
  old.replaceWith(fresh);
  restoreFocus(focusKey);
}

function currentFocusKey() {
  const a = document.activeElement;
  if (!a || !a.dataset || !a.dataset.num) return null;
  return { num: a.dataset.num, side: a.dataset.side };
}

function restoreFocus(key) {
  if (!key) return;
  const inp = document.querySelector(`input.score[data-num="${key.num}"][data-side="${key.side}"]`);
  if (inp) { inp.focus(); inp.select(); }
}

function updateGroupProgress() {
  const filled = countFinished(state.group) + countFinished(state.ko);
  const total = MATCHES.length;
  const pct = Math.round(100 * filled / total);
  const prog = $('.progress');
  if (!prog) return;
  prog.querySelector('span').textContent = `${filled} / ${total} matcher tippade`;
  prog.querySelector('.progress-bar > div').style.width = pct + '%';
  prog.querySelector('.small').textContent = pct + '%';
}

function renderStandingsTable(rows, advancingThirds, groupId) {
  const t = el('table', { class: 'standings' });
  const head = el('thead', {}, el('tr', {},
    el('th', { class: 'pos' }, '#'),
    el('th', { class: 'team-cell' }, 'Lag'),
    el('th', {}, 'M'),
    el('th', {}, 'V'),
    el('th', {}, 'O'),
    el('th', {}, 'F'),
    el('th', {}, 'GM'),
    el('th', {}, 'IM'),
    el('th', { class: 'diff' }, '+/-'),
    el('th', {}, 'P')
  ));
  t.appendChild(head);
  const body = el('tbody');
  rows.forEach((r, i) => {
    let cls;
    if (i < 2) cls = 'qualified';
    else if (i === 2) {
      // Trean: vi vet inte säkert förrän alla grupper är tippade.
      // Innan dess visar vi neutral "third"-färg; därefter grön/grå utifrån topp 8.
      if (advancingThirds == null) cls = 'third';
      else cls = advancingThirds.has(groupId) ? 'qualified' : 'eliminated';
    } else cls = 'eliminated';
    body.appendChild(el('tr', { class: cls },
      el('td', { class: 'pos' }, String(i+1)),
      el('td', { class: 'team-cell' }, flag(r.team), el('span', { class: 'tn' }, teamName(r.team))),
      el('td', {}, String(r.mp)),
      el('td', {}, String(r.w)),
      el('td', {}, String(r.d)),
      el('td', {}, String(r.l)),
      el('td', {}, String(r.gf)),
      el('td', {}, String(r.ga)),
      el('td', { class: 'diff' }, (r.gd > 0 ? '+' : '') + r.gd),
      el('td', {}, el('strong', {}, String(r.pts)))
    ));
  });
  t.appendChild(body);
  return t;
}

// --- Slutspel --------------------------------------------------------------

const KO_STAGES = [
  { key: 'R32', label: 'Sextondelsfinal', short: '1/16' },
  { key: 'R16', label: 'Åttondelsfinal',  short: '1/8' },
  { key: 'QF',  label: 'Kvartsfinal',     short: 'KF' },
  { key: 'SF',  label: 'Semifinal',       short: 'SF' },
  { key: 'F',   label: 'Final',           short: 'F' },
];

// Visuell ordning per kolumn så att en match alltid sitter mellan sina
// två föregångare. Härledd från FIFA:s slutspelsträd:
//   89 = W74 v W77   90 = W73 v W75
//   93 = W83 v W84   94 = W81 v W82
//   91 = W76 v W78   92 = W79 v W80
//   95 = W86 v W88   96 = W85 v W87
//   97 = W89/W90  98 = W93/W94  99 = W91/W92  100 = W95/W96
//   101 = W97/W98  102 = W99/W100  104 = W101/W102
// Vald slutspelsmatch (för att markera den och dess två föregångare).
let selectedKoNum = null;

function toggleKoSelection(num) {
  selectedKoNum = (selectedKoNum === num) ? null : num;
  applyKoSelection();
}

function applyKoSelection() {
  document.querySelectorAll('.ko-match').forEach(c => c.classList.remove('selected', 'feeder'));
  if (selectedKoNum == null) return;
  const card = document.querySelector(`.ko-match[data-num="${selectedKoNum}"]`);
  if (!card) { selectedKoNum = null; return; }
  card.classList.add('selected');
  const m = KO_MATCHES.find(x => x.num === selectedKoNum);
  if (!m) return;
  for (const placeholder of [m.home, m.away]) {
    const ref = /^[WL](\d+)$/.exec(placeholder);
    if (!ref) continue;
    const fnum = parseInt(ref[1], 10);
    const fcard = document.querySelector(`.ko-match[data-num="${fnum}"]`);
    if (fcard) fcard.classList.add('feeder');
  }
}

const BRACKET_ORDER = {
  R32: [74, 77, 73, 75, 83, 84, 81, 82, 76, 78, 79, 80, 86, 88, 85, 87],
  R16: [89, 90, 93, 94, 91, 92, 95, 96],
  QF:  [97, 98, 99, 100],
  SF:  [101, 102],
  F:   [104],
};

function renderKnockout() {
  const app = $('#app');
  if (!readonly) app.innerHTML = '';

  app.appendChild(renderProgressBanner());

  if (!allGroupsComplete(state.group)) {
    app.appendChild(el('div', { class: 'card notice info' },
      'Du måste tippa färdigt alla gruppmatcher innan slutspelet kan börja. ',
      el('a', { href: '#/grupper' }, 'Gå till gruppspelet')
    ));
    return;
  }

  const resolved = resolveKnockout({ ...state.group, ...state.ko, ...prefixedPen() });
  const wrap = el('div', { class: 'bracket', id: 'bracket-wrap' });
  for (const stage of KO_STAGES) {
    const order = BRACKET_ORDER[stage.key];
    const matches = order.map(n => KO_MATCHES.find(m => m.num === n));
    const col = el('div', { class: 'bracket-column', 'data-stage': stage.key });
    col.appendChild(el('h3', {
      onclick: () => col.classList.toggle('collapsed')
    }, stage.label));
    const list = el('div', { class: 'matches' });
    for (const m of matches) {
      list.appendChild(renderKoMatch(m, resolved));
    }
    col.appendChild(list);
    wrap.appendChild(col);
  }
  // Bronsmatch som en egen kolumn intill finalen
  const bronze = KO_MATCHES.find(m => m.stage === '3P');
  if (bronze) {
    const col = el('div', { class: 'bracket-column bronze-column' });
    col.appendChild(el('h3', { onclick: () => col.classList.toggle('collapsed') }, 'Bronsmatch'));
    const list = el('div', { class: 'matches' });
    list.appendChild(renderKoMatch(bronze, resolved));
    col.appendChild(list);
    wrap.appendChild(col);
  }

  app.appendChild(wrap);
  applyKoSelection();
}

function rerenderKnockout() {
  const wrap = $('#bracket-wrap');
  if (!wrap) return;
  // Behåll fokus
  const active = document.activeElement;
  const focusKey = active && active.dataset && active.dataset.num
    ? { num: active.dataset.num, side: active.dataset.side }
    : null;
  renderKnockout();
  if (focusKey) {
    const inp = document.querySelector(`input.score[data-num="${focusKey.num}"][data-side="${focusKey.side}"]`);
    if (inp) { inp.focus(); inp.select(); }
  }
}

function prefixedPen() {
  // share/bracket använder key = num + 'p' för straffvinnare
  const out = {};
  for (const [k, v] of Object.entries(state.pen)) {
    out[k + 'p'] = v;
  }
  return out;
}

function renderKoMatch(m, resolved) {
  const r = resolved[m.num];
  const pred = state.ko[m.num] || ['', ''];
  const card = el('div', {
    class: 'ko-match' + (readonly ? ' readonly' : ''),
    'data-num': String(m.num),
    onclick: (ev) => {
      // Klick på poäng-input eller straff-radio ska inte ändra markeringen
      if (ev.target.closest('input, label, .pen-pick')) return;
      toggleKoSelection(m.num);
    },
  });
  card.appendChild(el('div', { class: 'label' },
    `Match ${m.num} · ${fmtKickoff(m.date, m.time)} · ${fmtVenue(m.venue)}`));

  const homeKnown = r && r.home;
  const awayKnown = r && r.away;
  const winner = r && r.winner;

  // Home rad
  card.appendChild(makeKoRow(m, 'home', homeKnown ? r.home : null, r ? r.homeLabel : '', winner, pred[0]));
  // Away rad
  card.appendChild(makeKoRow(m, 'away', awayKnown ? r.away : null, r ? r.awayLabel : '', winner, pred[1]));

  // Straffläggning vid oavgjort
  if (pred[0] !== '' && pred[1] !== '' && pred[0] === pred[1] && homeKnown && awayKnown && pred[0] != null) {
    const penChoice = state.pen[m.num] || '';
    const penWrap = el('div', { class: 'pen-pick' });
    penWrap.appendChild(el('span', {}, 'Vinnare på straffar:'));
    for (const t of [r.home, r.away]) {
      const id = `pen-${m.num}-${t}`;
      const inp = el('input', {
        type: 'radio',
        name: `pen-${m.num}`,
        id,
        value: t,
        ...(penChoice === t ? { checked: true } : {}),
      });
      if (readonly) inp.disabled = true;
      inp.addEventListener('change', () => {
        if (readonly) return;
        state.pen[m.num] = t;
        scheduleSave();
        rerenderKnockout();
      });
      penWrap.appendChild(inp);
      penWrap.appendChild(el('label', { for: id }, teamName(t)));
    }
    card.appendChild(penWrap);
  } else if (state.pen[m.num] && !readonly) {
    // Rensa straffvinnare om matchen inte längre är oavgjord
    delete state.pen[m.num];
    scheduleSave();
  }

  return card;
}

function makeKoRow(m, side, team, label, winner, value) {
  const known = !!team;
  const isWinner = known && winner && winner === team;
  const isLoser = known && winner && winner !== team;
  const cls = ['row'];
  if (!known) cls.push('placeholder');
  if (isWinner) cls.push('winner');
  if (isLoser) cls.push('loser');

  const teamCell = el('div', { class: 'team' });
  if (known) {
    teamCell.appendChild(flag(team));
    teamCell.appendChild(el('span', { class: 'nm' }, teamName(team)));
  } else {
    teamCell.appendChild(el('span', { class: 'nm' }, label || '—'));
  }
  const inp = el('input', {
    class: 'score',
    type: 'number',
    min: '0', max: '9',
    inputmode: 'numeric',
    value: value === '' || value == null ? '' : String(value),
    'data-num': m.num,
    'data-side': side,
  });
  if (readonly) inp.readOnly = true;
  if (!known) inp.disabled = true;
  inp.addEventListener('input', onScoreInput);

  return el('div', { class: cls.join(' ') }, teamCell, inp);
}

// --- Sammanfattning --------------------------------------------------------

function renderShareCard() {
  const url = shareUrl(state);
  const totalDone = countFinished(state.group) + countFinished(state.ko);
  const total = MATCHES.length;
  return el('section', { class: 'card' },
    el('h3', {}, 'Dela din tippning'),
    el('p', { class: 'muted small' },
      totalDone < total
        ? `Länken visar dina ${totalDone} av ${total} tippade matcher just nu. Tippar du fler matcher senare behöver du kopiera en ny länk.`
        : 'Skicka länken till en kompis så kan de se exakt hur du har tippat.'),
    el('div', { class: 'share-box' },
      el('input', { type: 'text', readonly: true, value: url, onclick: (e) => e.target.select() }),
      el('button', {
        class: 'primary',
        onclick: async (e) => {
          const ok = await copyToClipboard(url);
          e.target.textContent = ok ? 'Kopierad!' : 'Misslyckades';
          setTimeout(() => e.target.textContent = 'Kopiera länk', 1500);
        }
      }, 'Kopiera länk')
    )
  );
}

function renderSummary() {
  const app = $('#app');
  if (!readonly) app.innerHTML = '';

  // Dela-länk — alltid tillgänglig, även för halvtippade brackets.
  if (!readonly) app.appendChild(renderShareCard());

  if (!allGroupsComplete(state.group)) {
    app.appendChild(el('div', { class: 'card notice info' },
      'Tippa klart gruppspelet och slutspelet så visas världsmästaren och pallen här.'));
    return;
  }

  const resolved = resolveKnockout({ ...state.group, ...state.ko, ...prefixedPen() });
  const finalMatch = KO_MATCHES.find(m => m.stage === 'F');
  const bronzeMatch = KO_MATCHES.find(m => m.stage === '3P');
  const finalRes = resolved[finalMatch.num];
  const bronzeRes = resolved[bronzeMatch.num];

  const champion = finalRes && finalRes.winner;
  const runnerUp = finalRes && finalRes.winner ? (finalRes.winner === finalRes.home ? finalRes.away : finalRes.home) : null;
  const third = bronzeRes && bronzeRes.winner;

  if (champion) {
    const champCard = el('section', { class: 'card' },
      el('div', { class: 'champion' },
        el('span', { class: 'fi fi-' + TEAMS[champion].iso }),
        el('div', { class: 'label' }, 'Världsmästare 2026 enligt dig'),
        el('h2', {}, teamName(champion))
      )
    );
    app.appendChild(champCard);

    if (runnerUp && third) {
      app.appendChild(el('section', { class: 'card' },
        el('h3', {}, 'Pallen'),
        el('div', { class: 'podium' },
          podiumSlot('Silver', runnerUp),
          podiumSlot('Guld', champion),
          podiumSlot('Brons', third)
        )
      ));
    }
  } else {
    app.appendChild(el('div', { class: 'card notice info' },
      'Tippa klart hela slutspelet (inklusive finalen) för att se vem du tror blir världsmästare.'));
  }


  // Statistik
  const totals = computeGoalTotals();
  if (totals.length) {
    const top = totals.slice(0, 10);
    const list = el('table', { class: 'standings' },
      el('thead', {}, el('tr', {},
        el('th', { class: 'pos' }, '#'),
        el('th', { class: 'team-cell' }, 'Lag'),
        el('th', { class: 'goals' }, 'Mål')
      )),
      el('tbody', {},
        ...top.map((r, i) => el('tr', {},
          el('td', { class: 'pos' }, String(i+1)),
          el('td', { class: 'team-cell' }, flag(r.team), el('span', { class: 'tn' }, teamName(r.team))),
          el('td', { class: 'goals' }, String(r.goals))
        ))
      )
    );
    app.appendChild(el('section', { class: 'card' },
      el('h3', {}, 'Flest mål enligt din tippning'),
      list
    ));
  }
}

function podiumSlot(rank, team) {
  return el('div', { class: 'slot' },
    el('span', { class: 'fi fi-' + TEAMS[team].iso }),
    el('div', { class: 'rank' }, rank),
    el('div', { class: 'nm' }, teamName(team))
  );
}

function computeGoalTotals() {
  const goals = {};
  // Gruppspel
  for (const m of GROUP_MATCHES) {
    const p = state.group[m.num];
    if (!isFinished(p)) continue;
    goals[m.home] = (goals[m.home] || 0) + p[0];
    goals[m.away] = (goals[m.away] || 0) + p[1];
  }
  // Slutspel — använd lösta lag
  const resolved = resolveKnockout({ ...state.group, ...state.ko, ...prefixedPen() });
  for (const m of KO_MATCHES) {
    const p = state.ko[m.num];
    if (!isFinished(p)) continue;
    const r = resolved[m.num];
    if (!r || !r.home || !r.away) continue;
    goals[r.home] = (goals[r.home] || 0) + p[0];
    goals[r.away] = (goals[r.away] || 0) + p[1];
  }
  return Object.entries(goals)
    .map(([team, g]) => ({ team, goals: g }))
    .filter(x => x.goals > 0)
    .sort((a, b) => b.goals - a.goals);
}

// === Init ==================================================================

render();
