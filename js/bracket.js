// Slutspelslogik: tabeller per grupp, rankning av treor, slutspelsträd.
import { GROUPS, GROUP_MATCHES, KO_MATCHES } from './schedule.js';

// FIFA:s slot-allokering för de 8 bästa treorna i Round of 32.
// Kombinationen av vilka 8 grupper (av A-L) som skickar en trea
// avgör vilken match varje trea hamnar i. Tabell hämtad från FIFA:s
// officiella spelschema (matcherna 74, 77, 79, 80, 81, 82, 85, 87
// är de R32-matcher där 1A/B/D/E/G/I/K/L möter en trea).
//
// Detta är 495 (= C(12,8)) möjliga kombinationer. Vi använder en
// deterministisk girig tilldelning: för varje slot i ordningen 74,
// 77, 79, 80, 81, 82, 85, 87 plockar vi första gruppen i slotens
// tillåtna lista som a) finns bland våra 8 kvalificerade treor och
// b) inte redan är tilldelad. Slotens "tillåtna lista" kommer från
// schedule.js via placeholder-strängen ("3A/B/C/D/F" → ['A','B','C','D','F']).
//
// För de allra flesta verkliga utfall ger detta samma tilldelning
// som FIFA:s tabell. För extremfall där flera tilldelningar är
// teoretiskt möjliga visas en notis i UI:n.

const THIRD_SLOT_NUMS = [74, 77, 79, 80, 81, 82, 85, 87];

function parseAllowedGroups(placeholder) {
  // "3A/B/C/D/F" -> ['A','B','C','D','F']
  // "3CDFGH"  (utan slash) -> ['C','D','F','G','H']
  if (!placeholder || placeholder[0] !== '3') return [];
  const tail = placeholder.slice(1).replace(/\//g, '');
  return tail.split('');
}

// === Tabellrad-typ: { team, mp, w, d, l, gf, ga, gd, pts }

function emptyRow(team) {
  return { team, mp: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
}

function applyMatch(rowA, rowB, scoreA, scoreB) {
  rowA.mp++; rowB.mp++;
  rowA.gf += scoreA; rowA.ga += scoreB;
  rowB.gf += scoreB; rowB.ga += scoreA;
  rowA.gd = rowA.gf - rowA.ga; rowB.gd = rowB.gf - rowB.ga;
  if (scoreA > scoreB) { rowA.w++; rowA.pts += 3; rowB.l++; }
  else if (scoreA < scoreB) { rowB.w++; rowB.pts += 3; rowA.l++; }
  else { rowA.d++; rowB.d++; rowA.pts++; rowB.pts++; }
}

function compareOverall(a, b) {
  // 1) poäng, 2) målskillnad, 3) gjorda mål
  if (a.pts !== b.pts) return b.pts - a.pts;
  if (a.gd !== b.gd) return b.gd - a.gd;
  if (a.gf !== b.gf) return b.gf - a.gf;
  return 0;
}

// Beräkna inbördes möten mellan ett set av lag i samma grupp.
function headToHead(teams, predictions, groupMatches) {
  const set = new Set(teams);
  const rows = Object.fromEntries(teams.map(t => [t, emptyRow(t)]));
  for (const m of groupMatches) {
    if (!set.has(m.home) || !set.has(m.away)) continue;
    const p = predictions[m.num];
    if (!p) continue;
    applyMatch(rows[m.home], rows[m.away], p[0], p[1]);
  }
  return rows;
}

export function standings(groupId, predictions) {
  const group = GROUPS.find(g => g.id === groupId);
  const groupMatches = GROUP_MATCHES.filter(m => m.group === groupId);
  const rows = Object.fromEntries(group.teams.map(t => [t, emptyRow(t)]));
  for (const m of groupMatches) {
    const p = predictions[m.num];
    if (!p) continue;
    applyMatch(rows[m.home], rows[m.away], p[0], p[1]);
  }
  const all = Object.values(rows);
  // Sortera överlag, lös sedan oavgjort med inbördes möten + alfabetisk
  // (deterministisk lottning för att undvika tvetydig tabell).
  all.sort((a, b) => {
    const c = compareOverall(a, b);
    if (c !== 0) return c;
    return a.team.localeCompare(b.team);
  });
  // Försök förfina inom block med samma poäng/GD/GF: använd inbördes möten
  const refined = [];
  let i = 0;
  while (i < all.length) {
    let j = i + 1;
    while (j < all.length && compareOverall(all[i], all[j]) === 0) j++;
    const block = all.slice(i, j);
    if (block.length > 1) {
      // Är alla matcher inom blocket spelade?
      const teams = block.map(r => r.team);
      const teamSet = new Set(teams);
      const blockMatches = groupMatches.filter(m => teamSet.has(m.home) && teamSet.has(m.away));
      const allPlayed = blockMatches.every(m => predictions[m.num]);
      if (allPlayed) {
        const h2h = headToHead(teams, predictions, groupMatches);
        block.sort((a, b) => {
          const c = compareOverall(h2h[a.team], h2h[b.team]);
          if (c !== 0) return c;
          return a.team.localeCompare(b.team);
        });
      }
    }
    refined.push(...block);
    i = j;
  }
  return refined;
}

export function isGroupComplete(groupId, predictions) {
  const ms = GROUP_MATCHES.filter(m => m.group === groupId);
  return ms.every(m => predictions[m.num]);
}

export function allGroupsComplete(predictions) {
  return GROUPS.every(g => isGroupComplete(g.id, predictions));
}

export function thirdPlaceRanking(predictions) {
  if (!allGroupsComplete(predictions)) return null;
  const thirds = GROUPS.map(g => {
    const t = standings(g.id, predictions);
    return { ...t[2], group: g.id };
  });
  thirds.sort((a, b) => {
    const c = compareOverall(a, b);
    if (c !== 0) return c;
    // För deterministisk lottning vid identisk total: alfabetisk grupp
    return a.group.localeCompare(b.group);
  });
  return thirds;
}

export function assignThirds(predictions) {
  const ranking = thirdPlaceRanking(predictions);
  if (!ranking) return null;
  const top8 = ranking.slice(0, 8);
  const qualifiedGroups = new Set(top8.map(r => r.group));
  const groupToTeam = Object.fromEntries(top8.map(r => [r.group, r.team]));

  const slotMatches = THIRD_SLOT_NUMS.map(num => {
    const m = KO_MATCHES.find(x => x.num === num);
    // Hitta vilket av home/away som är "3..."-platshållaren
    const isHomeThird = m.home.startsWith('3');
    const placeholder = isHomeThird ? m.home : m.away;
    const allowed = parseAllowedGroups(placeholder);
    return { num, allowed, isHomeThird };
  });

  const used = new Set();
  const assignment = {}; // matchnum -> {group, team}
  for (const slot of slotMatches) {
    const choice = slot.allowed.find(g => qualifiedGroups.has(g) && !used.has(g));
    if (choice) {
      used.add(choice);
      assignment[slot.num] = { group: choice, team: groupToTeam[choice], placeholderHome: slot.isHomeThird };
    } else {
      assignment[slot.num] = null; // ingen lösning
    }
  }
  // Säkerställ att alla 8 fick en plats; om inte, fyll vidlyftigt med kvarvarande
  const remaining = [...qualifiedGroups].filter(g => !used.has(g));
  for (const slot of slotMatches) {
    if (assignment[slot.num]) continue;
    const choice = remaining.shift();
    if (choice) {
      used.add(choice);
      assignment[slot.num] = { group: choice, team: groupToTeam[choice], placeholderHome: slot.isHomeThird };
    }
  }
  return assignment;
}

// Lös alla platshållare och returnera vilka två lag som möts i varje
// slutspelsmatch givet predictions. Returnerar en map: matchNum -> { home, away, homeKnown, awayKnown }
export function resolveKnockout(predictions) {
  const result = {};
  const allComplete = allGroupsComplete(predictions);
  let standingsByGroup = null;
  let thirdsAssignment = null;
  if (allComplete) {
    standingsByGroup = {};
    for (const g of GROUPS) standingsByGroup[g.id] = standings(g.id, predictions);
    thirdsAssignment = assignThirds(predictions);
  }

  function resolveSlot(placeholder) {
    if (!placeholder) return { team: null, known: false, label: '' };
    // 1A / 2C
    let m = /^([12])([A-L])$/.exec(placeholder);
    if (m) {
      const pos = parseInt(m[1], 10);
      const grp = m[2];
      const label = pos === 1 ? `Etta i grupp ${grp}` : `Tvåa i grupp ${grp}`;
      if (!standingsByGroup) return { team: null, known: false, label };
      const t = standingsByGroup[grp][pos - 1];
      return { team: t.team, known: true, label };
    }
    // 3X/Y/Z...
    if (placeholder[0] === '3') {
      const allowed = parseAllowedGroups(placeholder);
      const label = `Trea (${allowed.join('/')})`;
      // Hitta vilken match det här är via kontekst — istället slår vi upp via thirdsAssignment per matchnum (görs nedan)
      return { team: null, known: false, label, isThird: true, allowed };
    }
    // W74 / L101
    m = /^([WL])(\d+)$/.exec(placeholder);
    if (m) {
      const kind = m[1]; const num = parseInt(m[2], 10);
      const ref = result[num];
      const refMatch = KO_MATCHES.find(x => x.num === num);
      const stage = refMatch.stage;
      const stageLabel = ({R32:'sextondelsfinal',R16:'åttondelsfinal',QF:'kvartsfinal',SF:'semifinal'})[stage] || 'match';
      const label = (kind === 'W' ? 'Vinnare ' : 'Förlorare ') + stageLabel + ' ' + num;
      if (!ref) return { team: null, known: false, label };
      const winner = ref.winner;
      if (!winner) return { team: null, known: false, label };
      if (kind === 'W') return { team: winner, known: true, label };
      // Förlorare = den andra av home/away
      const loser = winner === ref.home ? ref.away : ref.home;
      return { team: loser, known: !!loser, label };
    }
    return { team: null, known: false, label: placeholder };
  }

  // Bearbeta knockout-matcher i ordning (de är redan numrerade så referenser är framåtriktade)
  const koSorted = [...KO_MATCHES].sort((a, b) => a.num - b.num);
  for (const m of koSorted) {
    let homeSlot = resolveSlot(m.home);
    let awaySlot = resolveSlot(m.away);

    // Hantera "3..."-platshållare via FIFA-allokeringen
    if (homeSlot.isThird && thirdsAssignment) {
      const a = thirdsAssignment[m.num];
      if (a) homeSlot = { team: a.team, known: true, label: `Trea grupp ${a.group}` };
    }
    if (awaySlot.isThird && thirdsAssignment) {
      const a = thirdsAssignment[m.num];
      if (a) awaySlot = { team: a.team, known: true, label: `Trea grupp ${a.group}` };
    }

    const home = homeSlot.team;
    const away = awaySlot.team;
    const pred = predictions[m.num];
    const pen = predictions[m.num + 'p']; // tie-break-vinnare-kod

    let winner = null;
    if (pred) {
      if (pred[0] > pred[1]) winner = home;
      else if (pred[1] > pred[0]) winner = away;
      else winner = pen || null; // user must pick on draw
    }
    result[m.num] = {
      num: m.num,
      stage: m.stage,
      home, away,
      homeLabel: homeSlot.label,
      awayLabel: awaySlot.label,
      homeKnown: homeSlot.known,
      awayKnown: awaySlot.known,
      winner,
    };
  }
  return result;
}
