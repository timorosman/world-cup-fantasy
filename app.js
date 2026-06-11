// 2026 World Cup Fantasy Draft - Core Application Code

// ═══════════════════════════════════════════════════════════
// LIVE SYNC ENGINE — worldcup26.ir API Integration
// ═══════════════════════════════════════════════════════════

const LIVE_API_URL = 'https://worldcup26.ir/get/games';
const SYNC_INTERVAL_MS = 90000; // 90 seconds

let syncIntervalHandle = null;
let syncEnabled = true;
let lastSyncTime = null;
let lastSyncMatchCount = 0;
let apiMatchCache = []; // Raw API games for the live ticker

// Maps API English team names → our internal team IDs
// Covers all 48 qualified 2026 World Cup teams
const TEAM_NAME_MAP = {
  // UEFA
  'France': 'france',
  'Spain': 'spain',
  'England': 'england',
  'Belgium': 'belgium',
  'Netherlands': 'netherlands',
  'Portugal': 'portugal',
  'Croatia': 'croatia',
  'Germany': 'germany',
  'Switzerland': 'switzerland',
  'Austria': 'austria',
  'Turkey': 'turkey',
  'Türkiye': 'turkey',
  'Sweden': 'sweden',
  'Norway': 'norway',
  'Czechia': 'czechia',
  'Czech Republic': 'czechia',
  'Scotland': 'scotland',
  'Bosnia and Herzegovina': 'bosnia',
  'Bosnia': 'bosnia',

  // CONMEBOL
  'Argentina': 'argentina',
  'Brazil': 'brazil',
  'Colombia': 'colombia',
  'Uruguay': 'uruguay',
  'Ecuador': 'ecuador',
  'Paraguay': 'paraguay',

  // CAF
  'Morocco': 'morocco',
  'Senegal': 'senegal',
  'Egypt': 'egypt',
  'Ivory Coast': 'ivory_coast',
  "Côte d'Ivoire": 'ivory_coast',
  'Tunisia': 'tunisia',
  'Algeria': 'algeria',
  'DR Congo': 'dr_congo',
  'Congo DR': 'dr_congo',
  'Democratic Republic of the Congo': 'dr_congo',
  'South Africa': 'south_africa',
  'Ghana': 'ghana',
  'Cape Verde': 'cape_verde',
  'Cabo Verde': 'cape_verde',

  // AFC
  'Japan': 'japan',
  'Iran': 'iran',
  'South Korea': 'south_korea',
  'Australia': 'australia',
  'Qatar': 'qatar',
  'Uzbekistan': 'uzbekistan',
  'Iraq': 'iraq',
  'Saudi Arabia': 'saudi_arabia',
  'Jordan': 'jordan',

  // CONCACAF
  'United States': 'usa',
  'USA': 'usa',
  'Mexico': 'mexico',
  'Canada': 'canada',
  'Panama': 'panama',
  'Curaçao': 'curacao',
  'Curacao': 'curacao',
  'Haiti': 'haiti',

  // OFC
  'New Zealand': 'new_zealand'
};

// Extra teams in WC 2026 not in original TEAMS_DB — we need them for match lookup
// We'll dynamically add unknown API teams as minimal placeholder objects
const EXTRA_TEAMS_CACHE = {};

function resolveTeamId(apiName) {
  if (!apiName) return null;
  return TEAM_NAME_MAP[apiName] || null;
}

function ensureTeamExists(apiName, teamId) {
  // If teamId not in TEAMS_DB, add a placeholder to EXTRA_TEAMS_CACHE
  if (!teamId) return;
  const inDb = TEAMS_DB.find(t => t.id === teamId);
  if (!inDb && !EXTRA_TEAMS_CACHE[teamId]) {
    EXTRA_TEAMS_CACHE[teamId] = {
      id: teamId,
      name: apiName,
      confederation: 'UNK',
      rank: 999
    };
  }
}

// Extended getTeamById that also checks EXTRA_TEAMS_CACHE
function getTeamByIdExtended(id) {
  return TEAMS_DB.find(t => t.id === id) || EXTRA_TEAMS_CACHE[id] || null;
}

async function fetchAndSyncMatches() {
  try {
    updateSyncStatusUI('syncing');
    const resp = await fetch(LIVE_API_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const games = data.games || [];

    // Cache the full API response for the live ticker
    apiMatchCache = games;

    // Filter finished matches only
    const finishedGames = games.filter(g => g.finished === 'TRUE' || g.finished === true);

    let newMatchCount = 0;
    let newKnockoutCount = 0;

    for (const game of finishedGames) {
      const homeId = resolveTeamId(game.home_team_name_en);
      const awayId = resolveTeamId(game.away_team_name_en);

      if (!homeId || !awayId) continue; // Skip if we can't map the team
      if (homeId === awayId) continue;

      // Check if both teams are qualified 2026 World Cup teams (present in TEAMS_DB)
      const isHomeQualified = TEAMS_DB.some(t => t.id === homeId);
      const isAwayQualified = TEAMS_DB.some(t => t.id === awayId);
      if (!isHomeQualified || !isAwayQualified) continue;

      // Ensure teams are in our DB (or placeholder cache)
      ensureTeamExists(game.home_team_name_en, homeId);
      ensureTeamExists(game.away_team_name_en, awayId);

      // Deduplication: check if this game was already logged
      // Key: sorted team IDs + game ID from API
      const apiMatchId = `api_${game.id}`;
      const alreadyLogged = state.matches.some(m => m.apiMatchId === apiMatchId);
      if (alreadyLogged) continue;

      // Also skip if there's a manual match with same teams on same date
      const dateStr = game.local_date ? game.local_date.split(' ')[0] : '';
      const manualDuplicate = state.matches.some(m => {
        if (m.source === 'api') return false;
        const sameTeams = (m.teamAId === homeId && m.teamBId === awayId) ||
                          (m.teamAId === awayId && m.teamBId === homeId);
        return sameTeams;
      });
      if (manualDuplicate) continue;

      const goalsA = parseInt(game.home_score) || 0;
      const goalsB = parseInt(game.away_score) || 0;

      const matchObj = {
        id: 'match_api_' + game.id,
        apiMatchId,
        teamAId: homeId,
        teamBId: awayId,
        goalsA,
        goalsB,
        ownGoalsA: 0,
        ownGoalsB: 0,
        redCardsA: 0,
        redCardsB: 0,
        shootoutWinnerId: null,
        timestamp: new Date().toISOString(),
        source: 'api',
        apiGameType: game.type || 'group',
        apiMatchDate: game.local_date || ''
      };

      state.matches.push(matchObj);
      newMatchCount++;

      // ── Auto-tick knockout progression ──────────────────────
      // When a knockout-round game is finished, both participants
      // appeared in that round → tick the appearance bonus.
      const roundType = (game.type || '').toLowerCase();
      if (roundType !== 'group') {
        [homeId, awayId].forEach(tid => {
          if (!state.knockoutProgress[tid]) {
            state.knockoutProgress[tid] = {
              advKnockout: false, r32: false, r16: false,
              qf: false, sf: false, final: false, champ: false
            };
          }
          const kp = state.knockoutProgress[tid];
          // Mark group advancement if not already set
          if (!kp.advKnockout) { kp.advKnockout = true; newKnockoutCount++; }
          if (roundType === 'r32' && !kp.r32) { kp.r32 = true; newKnockoutCount++; }
          if (roundType === 'r16' && !kp.r16) { kp.r16 = true; newKnockoutCount++; }
          if (roundType === 'qf'  && !kp.qf)  { kp.qf  = true; newKnockoutCount++; }
          if (roundType === 'sf'  && !kp.sf)  { kp.sf  = true; newKnockoutCount++; }
          if ((roundType === 'final' || roundType === 'third') && !kp.final) {
            kp.final = true; newKnockoutCount++;
          }
        });

        // Determine champion — winner of the final
        if (roundType === 'final') {
          let champId = null;
          if (goalsA > goalsB) champId = homeId;
          else if (goalsB > goalsA) champId = awayId;
          if (champId) {
            if (!state.knockoutProgress[champId]) {
              state.knockoutProgress[champId] = {
                advKnockout: false, r32: false, r16: false,
                qf: false, sf: false, final: false, champ: false
              };
            }
            if (!state.knockoutProgress[champId].champ) {
              state.knockoutProgress[champId].champ = true;
              newKnockoutCount++;
            }
          }
        }
      }
    }

    lastSyncTime = new Date();
    lastSyncMatchCount += newMatchCount;

    if (newMatchCount > 0 || newKnockoutCount > 0) {
      // Auto-advance phase if knockout games started appearing
      if (newKnockoutCount > 0 && state.leaguePhase === 'group_stage') {
        state.leaguePhase = 'knockout_stage';
      }
      saveState();
      renderApp();
      if (newMatchCount > 0) {
        showNotification(`🌐 Auto-sync: ${newMatchCount} new match${newMatchCount > 1 ? 'es' : ''} imported!`, 'success');
      }
    }

    updateSyncStatusUI('idle');
  } catch (err) {
    console.error('Live sync failed:', err);
    updateSyncStatusUI('error');
    updateSyncStatusText(`Sync error — retrying in 90s`);
  }
}

function startAutoSync() {
  if (syncIntervalHandle) return; // Already running
  syncEnabled = true;
  fetchAndSyncMatches(); // Immediate first fetch
  syncIntervalHandle = setInterval(fetchAndSyncMatches, SYNC_INTERVAL_MS);
  updateSyncStatusUI('idle');
}

function stopAutoSync() {
  if (syncIntervalHandle) {
    clearInterval(syncIntervalHandle);
    syncIntervalHandle = null;
  }
  syncEnabled = false;
  updateSyncStatusUI('paused');
}

function toggleSync() {
  if (syncEnabled) {
    stopAutoSync();
    showNotification('⏸ Live sync paused.', 'info');
  } else {
    startAutoSync();
    showNotification('▶ Live sync resumed!', 'success');
  }
  updateSyncToggleBtn();
}

function manualSync() {
  showNotification('🔄 Syncing now…', 'info');
  fetchAndSyncMatches();
}

function updateSyncStatusUI(status) {
  const dot = document.getElementById('sync-status-dot');
  const label = document.getElementById('sync-status-label');
  if (!dot || !label) return;

  dot.className = 'sync-dot';
  if (status === 'idle') {
    dot.classList.add('sync-dot-active');
    const secAgo = lastSyncTime
      ? Math.round((Date.now() - lastSyncTime.getTime()) / 1000)
      : null;
    label.textContent = secAgo !== null ? `Synced ${secAgo}s ago · ${lastSyncMatchCount} matches` : 'Live sync active';
  } else if (status === 'syncing') {
    dot.classList.add('sync-dot-syncing');
    label.textContent = 'Syncing…';
  } else if (status === 'error') {
    dot.classList.add('sync-dot-error');
    label.textContent = 'Sync error';
  } else if (status === 'paused') {
    dot.classList.add('sync-dot-paused');
    label.textContent = 'Sync paused';
  }
}

function updateSyncStatusText(text) {
  const label = document.getElementById('sync-status-label');
  if (label) label.textContent = text;
}

function updateSyncToggleBtn() {
  const btn = document.getElementById('sync-toggle-btn');
  if (!btn) return;
  btn.textContent = syncEnabled ? '⏸ Pause' : '▶ Resume';
}

// Ticker refresh every 30s to update "Xs ago" label without re-polling
setInterval(() => {
  if (syncEnabled && lastSyncTime) {
    updateSyncStatusUI('idle');
  }
}, 30000);


// 1. Predefined Teams Database with FIFA Rankings (as of mid-2026 status)
const TEAMS_DB = [
  // UEFA (16 teams)
  { id: 'france', name: 'France', confederation: 'UEFA', rank: 2 },
  { id: 'spain', name: 'Spain', confederation: 'UEFA', rank: 3 },
  { id: 'england', name: 'England', confederation: 'UEFA', rank: 4 },
  { id: 'belgium', name: 'Belgium', confederation: 'UEFA', rank: 6 },
  { id: 'netherlands', name: 'Netherlands', confederation: 'UEFA', rank: 7 },
  { id: 'portugal', name: 'Portugal', confederation: 'UEFA', rank: 8 },
  { id: 'croatia', name: 'Croatia', confederation: 'UEFA', rank: 10 },
  { id: 'germany', name: 'Germany', confederation: 'UEFA', rank: 11 },
  { id: 'switzerland', name: 'Switzerland', confederation: 'UEFA', rank: 15 },
  { id: 'austria', name: 'Austria', confederation: 'UEFA', rank: 22 },
  { id: 'turkey', name: 'Turkey', confederation: 'UEFA', rank: 26 },
  { id: 'sweden', name: 'Sweden', confederation: 'UEFA', rank: 29 },
  { id: 'norway', name: 'Norway', confederation: 'UEFA', rank: 31 },
  { id: 'czechia', name: 'Czechia', confederation: 'UEFA', rank: 40 },
  { id: 'scotland', name: 'Scotland', confederation: 'UEFA', rank: 42 },
  { id: 'bosnia', name: 'Bosnia and Herzegovina', confederation: 'UEFA', rank: 64 },

  // CONMEBOL (6 teams)
  { id: 'argentina', name: 'Argentina', confederation: 'CONMEBOL', rank: 1 },
  { id: 'brazil', name: 'Brazil', confederation: 'CONMEBOL', rank: 5 },
  { id: 'colombia', name: 'Colombia', confederation: 'CONMEBOL', rank: 12 },
  { id: 'uruguay', name: 'Uruguay', confederation: 'CONMEBOL', rank: 14 },
  { id: 'ecuador', name: 'Ecuador', confederation: 'CONMEBOL', rank: 30 },
  { id: 'paraguay', name: 'Paraguay', confederation: 'CONMEBOL', rank: 56 },

  // CAF (10 teams)
  { id: 'morocco', name: 'Morocco', confederation: 'CAF', rank: 13 },
  { id: 'senegal', name: 'Senegal', confederation: 'CAF', rank: 19 },
  { id: 'egypt', name: 'Egypt', confederation: 'CAF', rank: 36 },
  { id: 'ivory_coast', name: 'Ivory Coast', confederation: 'CAF', rank: 38 },
  { id: 'tunisia', name: 'Tunisia', confederation: 'CAF', rank: 41 },
  { id: 'algeria', name: 'Algeria', confederation: 'CAF', rank: 46 },
  { id: 'dr_congo', name: 'DR Congo', confederation: 'CAF', rank: 46 },
  { id: 'south_africa', name: 'South Africa', confederation: 'CAF', rank: 57 },
  { id: 'ghana', name: 'Ghana', confederation: 'CAF', rank: 64 },
  { id: 'cape_verde', name: 'Cape Verde', confederation: 'CAF', rank: 67 },

  // AFC (9 teams)
  { id: 'japan', name: 'Japan', confederation: 'AFC', rank: 17 },
  { id: 'iran', name: 'Iran', confederation: 'AFC', rank: 20 },
  { id: 'south_korea', name: 'South Korea', confederation: 'AFC', rank: 23 },
  { id: 'australia', name: 'Australia', confederation: 'AFC', rank: 25 },
  { id: 'qatar', name: 'Qatar', confederation: 'AFC', rank: 35 },
  { id: 'uzbekistan', name: 'Uzbekistan', confederation: 'AFC', rank: 50 },
  { id: 'iraq', name: 'Iraq', confederation: 'AFC', rank: 55 },
  { id: 'saudi_arabia', name: 'Saudi Arabia', confederation: 'AFC', rank: 56 },
  { id: 'jordan', name: 'Jordan', confederation: 'AFC', rank: 68 },

  // CONCACAF (6 teams)
  { id: 'usa', name: 'USA', confederation: 'CONCACAF', rank: 18 },
  { id: 'mexico', name: 'Mexico', confederation: 'CONCACAF', rank: 21 },
  { id: 'canada', name: 'Canada', confederation: 'CONCACAF', rank: 33 },
  { id: 'panama', name: 'Panama', confederation: 'CONCACAF', rank: 34 },
  { id: 'curacao', name: 'Curaçao', confederation: 'CONCACAF', rank: 82 },
  { id: 'haiti', name: 'Haiti', confederation: 'CONCACAF', rank: 83 },

  // OFC (1 team)
  { id: 'new_zealand', name: 'New Zealand', confederation: 'OFC', rank: 94 }
];

// Managers
const MANAGERS = ['Gio', 'Charlie', 'Justin', 'Aarya', 'Nico', 'Timor'];

// Draft rounds template
const DRAFT_ORDER = [
  // Round 1
  { round: 1, confed: 'Any', manager: 'Gio' },
  { round: 1, confed: 'Any', manager: 'Charlie' },
  { round: 1, confed: 'Any', manager: 'Justin' },
  { round: 1, confed: 'Any', manager: 'Aarya' },
  { round: 1, confed: 'Any', manager: 'Nico' },
  { round: 1, confed: 'Any', manager: 'Timor' },
  // Round 2
  { round: 2, confed: 'Any', manager: 'Timor' },
  { round: 2, confed: 'Any', manager: 'Nico' },
  { round: 2, confed: 'Any', manager: 'Aarya' },
  { round: 2, confed: 'Any', manager: 'Justin' },
  { round: 2, confed: 'Any', manager: 'Charlie' },
  { round: 2, confed: 'Any', manager: 'Gio' },
  // Round 3
  { round: 3, confed: 'Any', manager: 'Gio' },
  { round: 3, confed: 'Any', manager: 'Charlie' },
  { round: 3, confed: 'Any', manager: 'Justin' },
  { round: 3, confed: 'Any', manager: 'Aarya' },
  { round: 3, confed: 'Any', manager: 'Nico' },
  { round: 3, confed: 'Any', manager: 'Timor' },
  // Round 4
  { round: 4, confed: 'Any', manager: 'Timor' },
  { round: 4, confed: 'Any', manager: 'Nico' },
  { round: 4, confed: 'Any', manager: 'Aarya' },
  { round: 4, confed: 'Any', manager: 'Justin' },
  { round: 4, confed: 'Any', manager: 'Charlie' },
  { round: 4, confed: 'Any', manager: 'Gio' },
  // Round 5
  { round: 5, confed: 'Any', manager: 'Gio' },
  { round: 5, confed: 'Any', manager: 'Charlie' },
  { round: 5, confed: 'Any', manager: 'Justin' },
  { round: 5, confed: 'Any', manager: 'Aarya' },
  { round: 5, confed: 'Any', manager: 'Nico' },
  { round: 5, confed: 'Any', manager: 'Timor' },
  // Round 6 - Wild Card
  { round: 6, confed: 'Wild Card', manager: 'Timor' },
  { round: 6, confed: 'Wild Card', manager: 'Nico' },
  { round: 6, confed: 'Wild Card', manager: 'Aarya' },
  { round: 6, confed: 'Wild Card', manager: 'Justin' },
  { round: 6, confed: 'Wild Card', manager: 'Charlie' },
  { round: 6, confed: 'Wild Card', manager: 'Gio' }
];

// 2. Default State Generator
function getInitialState() {
  return {
    leaguePhase: 'drafting', // 'drafting', 'group_stage', 'knockout_stage', 'finished'
    draftPicks: [], // Array of { manager, teamId, round, confed, isWildCard }
    currentDraftIndex: 0,
    matches: [], // Array of logged match objects
    knockoutProgress: {}, // teamId -> { advKnockout: bool, r32: bool, r16: bool, qf: bool, sf: bool, final: bool, champ: bool }
    trades: [], // Array of trade logs
    waiversUsed: {}, // managerName -> bool (tracks if manager used their 1 allowed waiver)
    coinFlipWinner: null // managerName resolved by manual coinflip tiebreaker if needed
  };
}

let state = getInitialState();

// 3. Persistence
const LOCAL_STORAGE_KEY = 'world_cup_fantasy_2026_state';

function saveState() {
  // Always persist locally as fallback
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  // Sync to Firebase if available
  if (isFirebaseReady()) {
    syncStateToFirebase(state);
  }
}

function loadState() {
  // Start with localStorage (synchronous, always available)
  const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (saved) {
    try {
      state = JSON.parse(saved);
    } catch (e) {
      console.error("Failed to parse saved state, starting fresh", e);
      state = getInitialState();
    }
  } else {
    state = getInitialState();
  }
  ensureStateDefaults();
}

async function loadStateFromFirebase() {
  if (!isFirebaseReady()) return;
  const fbState = await readStateFromFirebase();
  if (fbState) {
    state = fbState;
    ensureStateDefaults();
    // Also update local cache
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
    renderApp();
  }
}

function ensureStateDefaults() {
  if (!state.trades) state.trades = [];
  if (!state.waiversUsed) state.waiversUsed = {};
  if (!state.knockoutProgress) state.knockoutProgress = {};
  if (!state.coinFlipWinner) state.coinFlipWinner = null;
}

// Apply an incoming Firebase state update (from another device)
function applyRemoteState(newState) {
  state = newState;
  ensureStateDefaults();
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(state));
  renderApp();
}

// Helper to look up team object by id (also checks extra API-discovered teams)
function getTeamById(id) {
  if (!id) return null;
  const team = TEAMS_DB.find(t => t.id === id) || EXTRA_TEAMS_CACHE[id] || null;
  if (!team) {
    // Return a safe fallback object to prevent TypeError crashes for old/non-WC teams in saved storage
    return {
      id: id,
      name: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' '),
      confederation: 'Unknown',
      rank: 999
    };
  }
  return team;
}

// 4. Calculations Engine
function calculateStats() {
  // Reset team calculated stats
  const teamStats = {};
  TEAMS_DB.forEach(t => {
    teamStats[t.id] = {
      wins: 0,
      draws: 0,
      goalsScored: 0,
      cleanSheets: 0,
      ownGoals: 0,
      redCards: 0,
      shootoutWins: 0,
      upsetBonuses: 0,
      matchPoints: 0,
      knockoutPoints: 0,
      totalPoints: 0
    };
  });

  // Calculate stats from matches
  state.matches.forEach(m => {
    const teamA = teamStats[m.teamAId];
    const teamB = teamStats[m.teamBId];

    if (!teamA || !teamB) return;

    const dbA = getTeamById(m.teamAId);
    const dbB = getTeamById(m.teamBId);

    // Goals
    teamA.goalsScored += m.goalsA;
    teamB.goalsScored += m.goalsB;

    // Own Goals
    teamA.ownGoals += m.ownGoalsA;
    teamB.ownGoals += m.ownGoalsB;

    // Red Cards
    teamA.redCards += m.redCardsA;
    teamB.redCards += m.redCardsB;

    // Match Outcomes
    if (m.goalsA > m.goalsB) {
      teamA.wins += 1;
      // Upset check: rank number is larger = worse ranking.
      // So if A has a higher rank number, A is lower ranked. Beating B is an upset.
      if (dbA.rank > dbB.rank) {
        teamA.upsetBonuses += 1;
      }
    } else if (m.goalsB > m.goalsA) {
      teamB.wins += 1;
      if (dbB.rank > dbA.rank) {
        teamB.upsetBonuses += 1;
      }
    } else {
      // Draw
      teamA.draws += 1;
      teamB.draws += 1;

      // Check shootout
      if (m.shootoutWinnerId === m.teamAId) {
        teamA.shootoutWins += 1;
      } else if (m.shootoutWinnerId === m.teamBId) {
        teamB.shootoutWins += 1;
      }
    }

    // Clean sheets
    if (m.goalsB === 0) teamA.cleanSheets += 1;
    if (m.goalsA === 0) teamB.cleanSheets += 1;
  });

  // Compile Match Points
  TEAMS_DB.forEach(t => {
    const stats = teamStats[t.id];
    
    // Base: Win=3, Draw=1, Goal=+1, Clean Sheet=+1
    // Penalties: Own Goal=-1, Red Card=-2
    // Bonuses: Penalty Win=+2, Upset Win=+3
    const matchPts = (stats.wins * 3) +
                     (stats.draws * 1) +
                     (stats.goalsScored * 1) +
                     (stats.cleanSheets * 1) +
                     (stats.shootoutWins * 2) +
                     (stats.upsetBonuses * 3) -
                     (stats.ownGoals * 1) -
                     (stats.redCards * 2);
    
    stats.matchPoints = matchPts;

    // Knockout progression calculations
    const kp = state.knockoutProgress[t.id] || {};
    let knockPts = 0;
    if (kp.advKnockout) knockPts += 5;
    if (kp.r32) knockPts += 3;
    if (kp.r16) knockPts += 5;
    if (kp.qf) knockPts += 7;
    if (kp.sf) knockPts += 10;
    if (kp.final) knockPts += 15;
    if (kp.champ) knockPts += 25;

    stats.knockoutPoints = knockPts;
    stats.totalPoints = stats.matchPoints + stats.knockoutPoints;
  });

  // Compile Manager Stats
  const managerStandings = MANAGERS.map(managerName => {
    // Find manager's picks
    const picks = state.draftPicks.filter(p => p.manager === managerName);
    let score = 0;
    let totalWins = 0;
    let totalGoals = 0;
    let knockoutTeams = 0;
    let hasChampion = false;

    const picksWithScores = picks.map(p => {
      const stats = teamStats[p.teamId];
      const isWildcard = p.isWildCard;
      const teamMultiplier = isWildcard ? 1.5 : 1;
      const finalTeamPoints = stats.totalPoints * teamMultiplier;

      score += finalTeamPoints;
      totalWins += stats.wins;
      totalGoals += stats.goalsScored;

      const kp = state.knockoutProgress[p.teamId] || {};
      if (kp.advKnockout) {
        knockoutTeams += 1;
      }
      if (kp.champ) {
        hasChampion = true;
      }

      return {
        ...p,
        stats,
        finalTeamPoints
      };
    });

    return {
      manager: managerName,
      score,
      totalWins,
      totalGoals,
      knockoutTeams,
      hasChampion,
      picks: picksWithScores
    };
  });

  // Sort Standing applying Tiebreaker hierarchy:
  // 1. Score (descending)
  // 2. Most total wins (descending)
  // 3. Most knockout stage teams (descending)
  // 4. Most goals scored (descending)
  // 5. Champion team ownership (descending, true first)
  // 6. Manual Coin Flip result or manager alphabetical (as fail-safe)
  managerStandings.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
    if (b.knockoutTeams !== a.knockoutTeams) return b.knockoutTeams - a.knockoutTeams;
    if (b.totalGoals !== a.totalGoals) return b.totalGoals - a.totalGoals;
    if (a.hasChampion !== b.hasChampion) return b.hasChampion ? 1 : -1;
    
    if (state.coinFlipWinner === a.manager) return -1;
    if (state.coinFlipWinner === b.manager) return 1;
    
    return a.manager.localeCompare(b.manager);
  });

  return { teamStats, managerStandings };
}

// 5. Draft Core Actions
function isMyTurn() {
  const identity = getManagerIdentity();
  if (!identity) return true; // No identity set = local/solo mode, allow all
  if (!isFirebaseReady()) return true; // No Firebase = local mode
  const currentPickInfo = DRAFT_ORDER[state.currentDraftIndex];
  if (!currentPickInfo) return false;
  return currentPickInfo.manager === identity;
}

function getCurrentTurnManager() {
  const currentPickInfo = DRAFT_ORDER[state.currentDraftIndex];
  return currentPickInfo ? currentPickInfo.manager : null;
}

function makeDraftPick(teamId) {
  if (state.leaguePhase !== 'drafting') {
    showNotification("Draft is already completed or league is in another phase!", "error");
    return;
  }

  const currentPickInfo = DRAFT_ORDER[state.currentDraftIndex];
  if (!currentPickInfo) return;

  const { round, confed, manager } = currentPickInfo;

  // Turn enforcement: only the active manager can pick (when Firebase is active)
  if (!isMyTurn()) {
    showNotification(`It's ${manager}'s turn to pick! Please wait.`, "error");
    return;
  }
  
  // Validation checks
  const team = getTeamById(teamId);
  if (!team) return;

  // 1. Is team already drafted?
  const isDrafted = state.draftPicks.some(p => p.teamId === teamId);
  if (isDrafted) {
    showNotification(`${team.name} has already been drafted!`, "error");
    return;
  }

  // 2. Confederation restriction check (must be unique federation for rounds 1-5, any for wild card round 6)
  const isWildCardRound = (confed === 'Wild Card');
  if (!isWildCardRound) {
    const allowed = ['UEFA', 'CONMEBOL', 'CONCACAF', 'CAF', 'AFC'];
    if (!allowed.includes(team.confederation)) {
      showNotification(`${team.name} is from ${team.confederation}. Rounds 1-5 require choosing from UEFA, CONMEBOL, CONCACAF, CAF, or AFC.`, "error");
      return;
    }
    const myRounds1to5Picks = state.draftPicks.filter(p => p.manager === manager && p.round < 6);
    const hasConfed = myRounds1to5Picks.some(p => {
      const t = getTeamById(p.teamId);
      return t && t.confederation === team.confederation;
    });
    
    if (hasConfed) {
      showNotification(`You already drafted a ${team.confederation} team in rounds 1-5! You must select a team from one of your remaining federations.`, "error");
      return;
    }
  }

  // Add pick
  state.draftPicks.push({
    manager,
    teamId,
    round,
    confed,
    isWildCard: isWildCardRound
  });

  state.currentDraftIndex += 1;

  // Auto transition to group stage when draft is done
  if (state.currentDraftIndex >= DRAFT_ORDER.length) {
    state.leaguePhase = 'group_stage';
    showNotification("Draft Complete! Transitioning to the Group Stage.", "success");
  } else {
    showNotification(`${manager} drafted ${team.name}!`, "success");
  }

  saveState();
  renderApp();
}

function undoLastDraftPick() {
  if (state.draftPicks.length === 0) {
    showNotification("No draft picks to undo!", "error");
    return;
  }

  const undone = state.draftPicks.pop();
  state.currentDraftIndex -= 1;
  state.leaguePhase = 'drafting'; // Always return to drafting if we undo into draft size

  showNotification(`Undid pick: ${undone.manager} selecting ${getTeamById(undone.teamId).name}`, "info");
  
  saveState();
  renderApp();
}

function autoDraftRemaining() {
  if (state.leaguePhase !== 'drafting') return;

  while (state.currentDraftIndex < DRAFT_ORDER.length) {
    const currentPickInfo = DRAFT_ORDER[state.currentDraftIndex];
    const { confed } = currentPickInfo;

    // Find first available team matching the restriction
    const available = TEAMS_DB.find(t => {
      const isAlreadyDrafted = state.draftPicks.some(p => p.teamId === t.id);
      if (isAlreadyDrafted) return false;
      if (confed === 'Wild Card') return true;
      return t.confederation === confed;
    });

    if (available) {
      makeDraftPick(available.id);
    } else {
      showNotification(`No available teams left matching ${confed}! Draft stuck.`, "error");
      break;
    }
  }
}

// 6. Match Logging Actions
function addMatch(teamAId, teamBId, goalsA, goalsB, ownGoalsA, ownGoalsB, redCardsA, redCardsB, shootoutWinnerId) {
  if (teamAId === teamBId) {
    showNotification("A team cannot play itself!", "error");
    return;
  }

  const matchObj = {
    id: 'match_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    teamAId,
    teamBId,
    goalsA: parseInt(goalsA),
    goalsB: parseInt(goalsB),
    ownGoalsA: parseInt(ownGoalsA),
    ownGoalsB: parseInt(ownGoalsB),
    redCardsA: parseInt(redCardsA),
    redCardsB: parseInt(redCardsB),
    shootoutWinnerId: shootoutWinnerId || null,
    timestamp: new Date().toISOString()
  };

  state.matches.push(matchObj);
  showNotification("Match logged successfully!", "success");
  saveState();
  renderApp();
}

function deleteMatch(matchId) {
  state.matches = state.matches.filter(m => m.id !== matchId);
  showNotification("Match deleted.", "info");
  saveState();
  renderApp();
}

// 7. Trade and Waiver Portal Logic
function checkRosterFederationValidity(teams) {
  const confeds = teams.map(t => t ? t.confederation : null).filter(Boolean);
  const uniqueConfeds = new Set(confeds);
  // Must cover CONMEBOL, UEFA, CONCACAF, CAF, AFC (5 unique federations)
  return uniqueConfeds.has('UEFA') &&
         uniqueConfeds.has('CONMEBOL') &&
         uniqueConfeds.has('CAF') &&
         uniqueConfeds.has('AFC') &&
         uniqueConfeds.has('CONCACAF');
}

function executeTrade(managerA, teamAId, managerB, teamBId) {
  if (state.leaguePhase !== 'group_stage') {
    showNotification("Trades are only allowed during the Group Stage!", "error");
    return;
  }

  // Find index of picks in state.draftPicks
  const pickAIdx = state.draftPicks.findIndex(p => p.manager === managerA && p.teamId === teamAId);
  const pickBIdx = state.draftPicks.findIndex(p => p.manager === managerB && p.teamId === teamBId);

  if (pickAIdx === -1 || pickBIdx === -1) {
    showNotification("Invalid trade setup. Teams or managers do not match selection.", "error");
    return;
  }

  const pickA = state.draftPicks[pickAIdx];
  const pickB = state.draftPicks[pickBIdx];

  const teamAObj = getTeamById(teamAId);
  const teamBObj = getTeamById(teamBId);

  // Get current rosters for A and B
  const rosterA = state.draftPicks.filter(p => p.manager === managerA).map(p => getTeamById(p.teamId));
  const rosterB = state.draftPicks.filter(p => p.manager === managerB).map(p => getTeamById(p.teamId));

  // Simulate swap
  const newRosterA = rosterA.map(t => t.id === teamAId ? teamBObj : t);
  const newRosterB = rosterB.map(t => t.id === teamBId ? teamAObj : t);

  if (!checkRosterFederationValidity(newRosterA)) {
    showNotification(`Trade rejected: ${managerA} must maintain at least one team from each of the 5 federations.`, "error");
    return;
  }
  if (!checkRosterFederationValidity(newRosterB)) {
    showNotification(`Trade rejected: ${managerB} must maintain at least one team from each of the 5 federations.`, "error");
    return;
  }

  // Swap the teams in the picks list
  pickA.teamId = teamBId;
  pickB.teamId = teamAId;

  // Log trade
  state.trades.push({
    id: 'trade_' + Date.now(),
    managerA,
    teamAName: teamAObj.name,
    managerB,
    teamBName: teamBObj.name,
    timestamp: new Date().toLocaleString()
  });

  showNotification(`Trade executed! ${managerA} gets ${teamBObj.name}, ${managerB} gets ${teamAObj.name}.`, "success");
  saveState();
  renderApp();
}

function executeWaiver(manager, dropTeamId, addTeamId) {
  if (state.leaguePhase !== 'knockout_stage') {
    showNotification("Waivers are only allowed after the Group Stage (during Knockout Stage)!", "error");
    return;
  }

  if (state.waiversUsed[manager]) {
    showNotification(`${manager} has already used their 1 waiver addition!`, "error");
    return;
  }

  // Verify manager owns dropTeam
  const pickIdx = state.draftPicks.findIndex(p => p.manager === manager && p.teamId === dropTeamId);
  if (pickIdx === -1) {
    showNotification(`${manager} does not own the dropped team!`, "error");
    return;
  }

  // Verify addTeam is not currently drafted/owned
  const isDrafted = state.draftPicks.some(p => p.teamId === addTeamId);
  if (isDrafted) {
    showNotification(`Selected team to add is already owned!`, "error");
    return;
  }

  // Verify drop/add maintains roster integrity (at least 1 of each of 5 federations)
  const dropTeamObj = getTeamById(dropTeamId);
  const addTeamObj = getTeamById(addTeamId);

  const roster = state.draftPicks.filter(p => p.manager === manager).map(p => getTeamById(p.teamId));
  const newRoster = roster.map(t => t.id === dropTeamId ? addTeamObj : t);

  if (!checkRosterFederationValidity(newRoster)) {
    showNotification(`Waiver rejected: dropping ${dropTeamObj.name} and adding ${addTeamObj.name} would leave you without representation for one of the 5 required federations.`, "error");
    return;
  }

  // Perform waiver swap
  state.draftPicks[pickIdx].teamId = addTeamId;
  state.waiversUsed[manager] = true;

  // Log trade/waiver transaction
  state.trades.push({
    id: 'waiver_' + Date.now(),
    managerA: manager,
    teamAName: dropTeamObj.name,
    managerB: 'Waiver Pool',
    teamBName: addTeamObj.name,
    timestamp: new Date().toLocaleString() + " (Waiver)"
  });

  showNotification(`Waiver complete! ${manager} dropped ${dropTeamObj.name} and added ${addTeamObj.name}.`, "success");
  saveState();
  renderApp();
}

// 8. Notification System
function showNotification(text, type = "success") {
  const container = document.getElementById("notifications-box");
  if (!container) return;

  const banner = document.createElement("div");
  banner.className = `notification-banner ${type}`;
  banner.innerHTML = `
    <span>${text}</span>
    <button class="btn btn-icon btn-secondary" onclick="this.parentElement.remove()" style="padding: 2px 6px;">✕</button>
  `;
  container.appendChild(banner);

  // Remove after 6 seconds
  setTimeout(() => {
    banner.style.opacity = '0';
    banner.style.transform = 'translateY(-10px)';
    banner.style.transition = 'all 0.5s ease';
    setTimeout(() => banner.remove(), 500);
  }, 6000);
}

// 9. Interactive UI Rendering Cycles
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

  const activeBtn = document.querySelector(`[onclick="switchTab('${tabId}')"]`);
  if (activeBtn) activeBtn.classList.add('active');

  const activeContent = document.getElementById(tabId);
  if (activeContent) activeContent.classList.add('active');
}

function renderApp() {
  const { teamStats, managerStandings } = calculateStats();

  // Update overall phase tags/indicators in UI
  updateHeaderStats(managerStandings);

  // Update sync status bar
  if (syncEnabled) updateSyncStatusUI('idle');
  updateSyncToggleBtn();
  
  // Render subpanels
  renderLeaderboard(managerStandings);
  renderManagerPicks(managerStandings);
  renderDraftRoom(teamStats);
  renderMatchCenter(teamStats);
  renderLiveTicker();
  renderTradesWaivers(managerStandings);
  renderDiagnostics();
}

function updateHeaderStats(standings) {
  const currentPhaseEl = document.getElementById('current-league-phase');
  if (currentPhaseEl) {
    let phaseText = "Drafting";
    if (state.leaguePhase === 'group_stage') phaseText = "Group Stage";
    if (state.leaguePhase === 'knockout_stage') phaseText = "Knockout Stage";
    if (state.leaguePhase === 'finished') phaseText = "League Completed";
    
    currentPhaseEl.textContent = phaseText;
  }

  const mottoEl = document.getElementById('header-motto');
  if (mottoEl) {
    mottoEl.textContent = "“Pain, patriotism, and parlay-level delusion.”";
  }
}

function renderLeaderboard(standings) {
  const tbody = document.getElementById('leaderboard-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  
  standings.forEach((m, idx) => {
    const rank = idx + 1;
    let rankClass = 'rank-other';
    if (rank === 1) rankClass = 'rank-1';
    else if (rank === 2) rankClass = 'rank-2';
    else if (rank === 3) rankClass = 'rank-3';

    // Count knockout teams
    const koCount = m.knockoutTeams;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><span class="rank-badge ${rankClass}">${rank}</span></td>
      <td><strong>${m.manager}</strong></td>
      <td><span class="text-gold font-bold" style="font-size: 1.1rem;">${m.score.toFixed(1)}</span></td>
      <td>${m.totalWins}</td>
      <td>${koCount}</td>
      <td>${m.totalGoals}</td>
      <td>${m.hasChampion ? '<span class="text-success">Yes</span>' : '<span class="text-muted">No</span>'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function renderManagerPicks(standings) {
  const grid = document.getElementById('managers-picks-grid');
  if (!grid) return;

  grid.innerHTML = '';

  standings.forEach((m, idx) => {
    const isLeader = idx === 0 && m.score > 0;
    const managerCard = document.createElement('div');
    managerCard.className = `manager-card ${isLeader ? 'leader-glow' : ''}`;
    
    let picksHtml = '';
    
    // Put picks in order of draft round or confederation
    const sortedPicks = [...m.picks].sort((a, b) => a.round - b.round);

    if (sortedPicks.length === 0) {
      picksHtml = `<div class="text-muted" style="padding: 20px 0; text-align: center;">No teams drafted yet.</div>`;
    } else {
      sortedPicks.forEach(p => {
        const teamObj = getTeamById(p.teamId);
        const wcTag = p.isWildCard ? `<span class="wildcard-tag">Wild Card 1.5x</span>` : '';
        const confedClass = `badge-${p.confed.toLowerCase().replace(' ', '')}`;

        picksHtml += `
          <div class="pick-item">
            <div class="team-flag-info">
              <span class="confed-badge ${confedClass}">${p.confed}</span>
              <span class="team-name">${teamObj.name}</span>
              ${wcTag}
            </div>
            <div class="team-points">
              <span>${p.finalTeamPoints.toFixed(1)}</span>
              <span class="sub-detail">pts</span>
            </div>
          </div>
        `;
      });
    }

    managerCard.innerHTML = `
      <div class="manager-card-header">
        <span class="manager-name">
          ${isLeader ? '👑' : '👤'} ${m.manager}
        </span>
        <span class="manager-score">${m.score.toFixed(1)} <span style="font-size: 0.8rem; color: var(--text-muted);">PTS</span></span>
      </div>
      <div class="manager-picks-list">
        ${picksHtml}
      </div>
    `;

    grid.appendChild(managerCard);
  });
}

function renderDraftRoom(teamStats) {
  const activePickIndex = state.currentDraftIndex;
  const nextPick = DRAFT_ORDER[activePickIndex];

  const orderStrip = document.getElementById('draft-order-strip');
  const activeManagerEl = document.getElementById('draft-active-manager');
  const activeRoundEl = document.getElementById('draft-active-round');
  const activeRestrictionEl = document.getElementById('draft-active-restriction');
  
  if (state.leaguePhase !== 'drafting') {
    // Hide or disable draft controls
    const controls = document.getElementById('draft-controls-area');
    if (controls) {
      controls.innerHTML = `
        <div class="card" style="text-align: center; padding: 3rem;">
          <h3 class="card-title" style="justify-content: center; border: none; font-size: 1.6rem;">🏆 Draft Finished!</h3>
          <p class="text-secondary" style="margin-bottom: 1.5rem;">All 36 picks have been drafted in compliance with confederation slots.</p>
          <div style="display: flex; gap: 10px; justify-content: center;">
            <button class="btn btn-secondary" onclick="undoLastDraftPick()">Undo Last Pick</button>
            <button class="btn btn-secondary" onclick="resetDraftConfirm()">Restart Draft</button>
          </div>
        </div>
      `;
    }
    if (orderStrip) orderStrip.innerHTML = '';
    return;
  }

  // Get active manager's already drafted federations (non-wildcard)
  let activeManager = nextPick ? nextPick.manager : null;
  let myNonWildCardPicks = [];
  let myDraftedConfeds = [];
  if (activeManager) {
    myNonWildCardPicks = state.draftPicks.filter(p => p.manager === activeManager && p.round < 6);
    myDraftedConfeds = myNonWildCardPicks.map(p => {
      const team = getTeamById(p.teamId);
      return team ? team.confederation : null;
    }).filter(Boolean);
  }

  // Render active pick text
  if (nextPick) {
    if (activeManagerEl) activeManagerEl.textContent = nextPick.manager;
    if (activeRoundEl) activeRoundEl.textContent = `Round ${nextPick.round}`;
    
    if (activeRestrictionEl) {
      if (nextPick.confed === 'Wild Card') {
        activeRestrictionEl.textContent = `Restriction: Wild Card (Any Federation)`;
      } else {
        const allConfeds = ['CONMEBOL', 'UEFA', 'CONCACAF', 'CAF', 'AFC'];
        const remaining = allConfeds.filter(c => !myDraftedConfeds.includes(c));
        activeRestrictionEl.textContent = `Remaining slots: ${remaining.join(', ')}`;
      }
    }
  }

  // Render draft order timeline strip (scrollable)
  if (orderStrip) {
    orderStrip.innerHTML = '';
    DRAFT_ORDER.forEach((p, idx) => {
      const isCompleted = idx < activePickIndex;
      const isActive = idx === activePickIndex;
      
      const card = document.createElement('div');
      card.className = `draft-order-card ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`;
      
      // Find what was selected if completed
      let pickLabel = p.confed;
      if (isCompleted && state.draftPicks[idx]) {
        const selectedTeam = getTeamById(state.draftPicks[idx].teamId);
        if (selectedTeam) {
          pickLabel = selectedTeam.name;
        }
      }

      card.innerHTML = `
        <div class="draft-order-round">R${p.round} - P${idx + 1}</div>
        <div class="draft-order-name">${p.manager}</div>
        <div class="draft-order-restriction">${pickLabel}</div>
      `;
      orderStrip.appendChild(card);
    });

    // Auto-scroll strip to active card
    const activeCard = orderStrip.querySelector('.active');
    if (activeCard) {
      orderStrip.scrollTo({
        left: activeCard.offsetLeft - 100,
        behavior: 'smooth'
      });
    }
  }

  // Render interactive category filter and team cards
  const categoryContainer = document.getElementById('draft-category-tabs');
  const teamsGrid = document.getElementById('draft-teams-grid');

  if (teamsGrid) {
    teamsGrid.innerHTML = '';

    // Filter based on currently active round constraint
    const requiredConfed = nextPick.confed;
    
    // Sort TEAMS_DB alphabetically by name
    const sortedTeams = [...TEAMS_DB].sort((a, b) => a.name.localeCompare(b.name));

    sortedTeams.forEach(t => {
      const isAlreadyDrafted = state.draftPicks.find(p => p.teamId === t.id);
      const isWildCard = (requiredConfed === 'Wild Card');
      const allowed = ['UEFA', 'CONMEBOL', 'CONCACAF', 'CAF', 'AFC'];
      const meetsRestriction = isWildCard || (allowed.includes(t.confederation) && !myDraftedConfeds.includes(t.confederation));
      
      const card = document.createElement('div');
      
      let cardClasses = 'draft-team-card';
      if (isAlreadyDrafted) {
        cardClasses += ' drafted';
      } else if (!meetsRestriction) {
        cardClasses += ' disabled';
      }

      card.className = cardClasses;

      // Click behavior
      if (!isAlreadyDrafted && meetsRestriction) {
        card.onclick = () => makeDraftPick(t.id);
      }

      const draftedLabel = isAlreadyDrafted 
        ? `<span class="drafted-by">${isAlreadyDrafted.manager}</span>` 
        : `<span class="confed-lbl">${t.confederation}</span>`;

      card.innerHTML = `
        <div class="draft-team-top">
          <span class="team-name">${t.name}</span>
          <span class="fifa-rank">FIFA #${t.rank}</span>
        </div>
        <div>
          ${draftedLabel}
        </div>
      `;

      teamsGrid.appendChild(card);
    });
  }
}

function renderMatchCenter(teamStats) {
  // Populate dropdowns for logging new match
  const teamASelect = document.getElementById('match-teamA');
  const teamBSelect = document.getElementById('match-teamB');
  const shootWinnerSelect = document.getElementById('match-shootout-winner');

  if (teamASelect && teamBSelect) {
    const prevA = teamASelect.value;
    const prevB = teamBSelect.value;

    teamASelect.innerHTML = '<option value="">-- Choose Team A --</option>';
    teamBSelect.innerHTML = '<option value="">-- Choose Team B --</option>';

    // Sort teams alphabetically
    const sortedTeams = [...TEAMS_DB].sort((a, b) => a.name.localeCompare(b.name));
    
    sortedTeams.forEach(t => {
      // Show if drafted (standard fantasy practice: matches affect active drafted teams,
      // but we list all qualified teams in case they want to record general matches).
      // Let's list all database teams.
      const optA = document.createElement('option');
      optA.value = t.id;
      optA.textContent = `${t.name} (FIFA #${t.rank} - ${t.confederation})`;
      teamASelect.appendChild(optA);

      const optB = document.createElement('option');
      optB.value = t.id;
      optB.textContent = `${t.name} (FIFA #${t.rank} - ${t.confederation})`;
      teamBSelect.appendChild(optB);
    });

    if (prevA) teamASelect.value = prevA;
    if (prevB) teamBSelect.value = prevB;
  }

  // Render Logged Matches List
  const logList = document.getElementById('match-log-list');
  if (logList) {
    logList.innerHTML = '';
    
    if (state.matches.length === 0) {
      logList.innerHTML = `<div class="text-muted" style="padding: 20px; text-align: center;">No matches logged yet. Enter results to calculate scores!</div>`;
    } else {
      // Sort matches by newest first
      const sortedMatches = [...state.matches].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      sortedMatches.forEach(m => {
        const teamA = getTeamById(m.teamAId);
        const teamB = getTeamById(m.teamBId);
        if (!teamA || !teamB) return;

        const item = document.createElement('div');
        item.className = 'match-log-item';
        
        let shootoutTxt = '';
        if (m.shootoutWinnerId) {
          const sWinner = getTeamById(m.shootoutWinnerId);
          shootoutTxt = ` (PK Winner: ${sWinner.name})`;
        }

        let penaltyCardsText = [];
        if (m.ownGoalsA > 0) penaltyCardsText.push(`${teamA.name} OG: +${m.ownGoalsA}`);
        if (m.ownGoalsB > 0) penaltyCardsText.push(`${teamB.name} OG: +${m.ownGoalsB}`);
        if (m.redCardsA > 0) penaltyCardsText.push(`${teamA.name} RC: +${m.redCardsA}`);
        if (m.redCardsB > 0) penaltyCardsText.push(`${teamB.name} RC: +${m.redCardsB}`);

        const penaltyMeta = penaltyCardsText.length > 0 
          ? `<span class="match-badge" style="background: rgba(239,68,68,0.15); color: var(--danger);">${penaltyCardsText.join(', ')}</span>`
          : '';

        item.innerHTML = `
          <div class="match-log-details">
            <div class="match-log-scoreline">
              ${teamA.name} <span class="text-gold">${m.goalsA}</span> - <span class="text-gold">${m.goalsB}</span> ${teamB.name} ${shootoutTxt}
            </div>
            <div class="match-log-meta">
              <span class="match-badge">${new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
              ${penaltyMeta}
            </div>
          </div>
          <button class="btn btn-icon btn-danger" onclick="deleteMatch('${m.id}')">Delete</button>
        `;
        logList.appendChild(item);
      });
    }
  }

  // Render Knockout Advancement Tracker Card
  const koContainer = document.getElementById('knockout-progression-tbody');
  if (koContainer) {
    koContainer.innerHTML = '';
    
    // Display only DRAFTED teams in the knockout tracker, since only drafted teams matter for points!
    const draftedTeamIds = [...new Set(state.draftPicks.map(p => p.teamId))];
    
    // Sort drafted teams alphabetically
    const teamsToDisplay = TEAMS_DB.filter(t => draftedTeamIds.includes(t.id))
                                   .sort((a, b) => a.name.localeCompare(b.name));

    if (teamsToDisplay.length === 0) {
      koContainer.innerHTML = `<tr><td colspan="8" class="text-muted" style="text-align: center; padding: 20px;">Draft has not occurred yet. Complete the draft to track knockout stages.</td></tr>`;
    } else {
      teamsToDisplay.forEach(t => {
        const kp = state.knockoutProgress[t.id] || {
          advKnockout: false, r32: false, r16: false, qf: false, sf: false, final: false, champ: false
        };

        const tr = document.createElement('tr');
        // Let's see who drafted this team
        const picks = state.draftPicks.filter(p => p.teamId === t.id);
        const owners = picks.map(p => p.manager + (p.isWildCard ? ' (WC)' : '')).join(', ');

        tr.innerHTML = `
          <td><strong>${t.name}</strong><br><span class="text-muted" style="font-size: 0.75rem;">Owner: ${owners}</span></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'advKnockout')" ${kp.advKnockout ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'r32')" ${kp.r32 ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'r16')" ${kp.r16 ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'qf')" ${kp.qf ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'sf')" ${kp.sf ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'final')" ${kp.final ? 'checked' : ''}></td>
          <td style="text-align: center;"><input type="checkbox" onchange="toggleKnockoutProgress('${t.id}', 'champ')" ${kp.champ ? 'checked' : ''}></td>
        `;
        koContainer.appendChild(tr);
      });
    }
  }
}

function toggleKnockoutProgress(teamId, key) {
  if (!state.knockoutProgress[teamId]) {
    state.knockoutProgress[teamId] = {
      advKnockout: false, r32: false, r16: false, qf: false, sf: false, final: false, champ: false
    };
  }
  
  state.knockoutProgress[teamId][key] = !state.knockoutProgress[teamId][key];
  
  // Save & update
  saveState();
  renderApp();
}

function handleMatchSubmit(e) {
  e.preventDefault();
  const teamA = document.getElementById('match-teamA').value;
  const teamB = document.getElementById('match-teamB').value;
  const goalsA = document.getElementById('match-goalsA').value;
  const goalsB = document.getElementById('match-goalsB').value;
  const ownGoalsA = document.getElementById('match-ownGoalsA').value || 0;
  const ownGoalsB = document.getElementById('match-ownGoalsB').value || 0;
  const redCardsA = document.getElementById('match-redCardsA').value || 0;
  const redCardsB = document.getElementById('match-redCardsB').value || 0;
  const shootoutWinner = document.getElementById('match-shootout-winner').value || null;

  if (!teamA || !teamB) {
    showNotification("Please select both teams!", "error");
    return;
  }

  addMatch(teamA, teamB, goalsA, goalsB, ownGoalsA, ownGoalsB, redCardsA, redCardsB, shootoutWinner);
  
  // Clear inputs
  document.getElementById('match-goalsA').value = 0;
  document.getElementById('match-goalsB').value = 0;
  document.getElementById('match-ownGoalsA').value = 0;
  document.getElementById('match-ownGoalsB').value = 0;
  document.getElementById('match-redCardsA').value = 0;
  document.getElementById('match-redCardsB').value = 0;
  document.getElementById('match-shootout-winner').value = '';
}

function updateShootoutSelect() {
  const teamA = document.getElementById('match-teamA').value;
  const teamB = document.getElementById('match-teamB').value;
  const goalsA = parseInt(document.getElementById('match-goalsA').value);
  const goalsB = parseInt(document.getElementById('match-goalsB').value);
  const shootoutWinnerSelect = document.getElementById('match-shootout-winner');

  if (!shootoutWinnerSelect) return;

  if (goalsA === goalsB && teamA && teamB) {
    const nameA = getTeamById(teamA)?.name || 'Team A';
    const nameB = getTeamById(teamB)?.name || 'Team B';

    shootoutWinnerSelect.innerHTML = `
      <option value="">-- No Shootout --</option>
      <option value="${teamA}">${nameA} Win</option>
      <option value="${teamB}">${nameB} Win</option>
    `;
    shootoutWinnerSelect.disabled = false;
  } else {
    shootoutWinnerSelect.innerHTML = '<option value="">-- Shootout Only on Draw --</option>';
    shootoutWinnerSelect.disabled = true;
  }
}

function renderTradesWaivers(standings) {
  // Populate Trade Managers and team selections
  const managerASelect = document.getElementById('trade-managerA');
  const managerBSelect = document.getElementById('trade-managerB');
  const teamASelect = document.getElementById('trade-teamA');
  const teamBSelect = document.getElementById('trade-teamB');

  if (managerASelect && managerBSelect) {
    const prevA = managerASelect.value;
    const prevB = managerBSelect.value;

    managerASelect.innerHTML = '<option value="">-- Select Manager A --</option>';
    managerBSelect.innerHTML = '<option value="">-- Select Manager B --</option>';

    MANAGERS.forEach(m => {
      const optA = document.createElement('option');
      optA.value = m;
      optA.textContent = m;
      managerASelect.appendChild(optA);

      const optB = document.createElement('option');
      optB.value = m;
      optB.textContent = m;
      managerBSelect.appendChild(optB);
    });

    if (prevA) managerASelect.value = prevA;
    if (prevB) managerBSelect.value = prevB;
  }

  // Waivers Setup
  const waiverManagerSelect = document.getElementById('waiver-manager');
  const waiverDropSelect = document.getElementById('waiver-drop');
  const waiverAddSelect = document.getElementById('waiver-add');

  if (waiverManagerSelect) {
    const prevW = waiverManagerSelect.value;
    waiverManagerSelect.innerHTML = '<option value="">-- Select Manager --</option>';
    
    // Sort managers by score ascending (lowest score gets priority!)
    // Add waiver status info
    const waiverPriorityList = [...standings].sort((a,b) => a.score - b.score);

    waiverPriorityList.forEach((w, rank) => {
      const usedText = state.waiversUsed[w.manager] ? '(Used)' : '(Available)';
      const opt = document.createElement('option');
      opt.value = w.manager;
      opt.textContent = `#${rank + 1} priority: ${w.manager} ${usedText}`;
      waiverManagerSelect.appendChild(opt);
    });

    if (prevW) waiverManagerSelect.value = prevW;
  }

  // Populate waiver undrafted teams
  if (waiverAddSelect) {
    const prevAdd = waiverAddSelect.value;
    waiverAddSelect.innerHTML = '<option value="">-- Select Team to Add --</option>';

    // Undrafted teams
    const undrafted = TEAMS_DB.filter(t => !state.draftPicks.some(p => p.teamId === t.id))
                              .sort((a,b) => a.name.localeCompare(b.name));

    undrafted.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name} (FIFA #${t.rank} - ${t.confederation})`;
      waiverAddSelect.appendChild(opt);
    });

    if (prevAdd) waiverAddSelect.value = prevAdd;
  }

  // Render trade/waiver log history
  const historyList = document.getElementById('trade-log-list');
  if (historyList) {
    historyList.innerHTML = '';
    
    if (state.trades.length === 0) {
      historyList.innerHTML = `<div class="text-muted" style="padding: 10px; text-align: center;">No transactions executed yet.</div>`;
    } else {
      // Newest transaction first
      const sortedTrades = [...state.trades].sort((a, b) => b.id.localeCompare(a.id));
      sortedTrades.forEach(t => {
        const item = document.createElement('div');
        item.className = 'trade-log-item';
        
        const isWaiver = t.timestamp.includes('Waiver');
        const desc = isWaiver 
          ? `<strong>${t.managerA}</strong> processed waiver drop-swap: dropped <strong>${t.teamAName}</strong> and added <strong>${t.teamBName}</strong>.`
          : `Roster Swap: <strong>${t.managerA}</strong> traded <strong>${t.teamAName}</strong> to <strong>${t.managerB}</strong> for <strong>${t.teamBName}</strong>.`;

        item.innerHTML = `
          <div>${desc}</div>
          <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px;">${t.timestamp}</div>
        `;
        historyList.appendChild(item);
      });
    }
  }
}

function handleTradeManagerAChange() {
  const managerA = document.getElementById('trade-managerA').value;
  const teamASelect = document.getElementById('trade-teamA');
  if (!teamASelect) return;

  teamASelect.innerHTML = '<option value="">-- Choose Team to Give --</option>';

  if (managerA) {
    const picks = state.draftPicks.filter(p => p.manager === managerA);
    picks.forEach(p => {
      const teamObj = getTeamById(p.teamId);
      const opt = document.createElement('option');
      opt.value = p.teamId;
      opt.textContent = `${teamObj.name} (${p.confed})`;
      teamASelect.appendChild(opt);
    });
  }
}

function handleTradeManagerBChange() {
  const managerB = document.getElementById('trade-managerB').value;
  const teamBSelect = document.getElementById('trade-teamB');
  if (!teamBSelect) return;

  teamBSelect.innerHTML = '<option value="">-- Choose Team to Give --</option>';

  if (managerB) {
    const picks = state.draftPicks.filter(p => p.manager === managerB);
    picks.forEach(p => {
      const teamObj = getTeamById(p.teamId);
      const opt = document.createElement('option');
      opt.value = p.teamId;
      opt.textContent = `${teamObj.name} (${p.confed})`;
      teamBSelect.appendChild(opt);
    });
  }
}

function submitTradeForm(e) {
  e.preventDefault();
  const managerA = document.getElementById('trade-managerA').value;
  const managerB = document.getElementById('trade-managerB').value;
  const teamAId = document.getElementById('trade-teamA').value;
  const teamBId = document.getElementById('trade-teamB').value;

  if (!managerA || !managerB || !teamAId || !teamBId) {
    showNotification("Complete all trade fields first!", "error");
    return;
  }

  if (managerA === managerB) {
    showNotification("A manager cannot trade with themselves!", "error");
    return;
  }

  executeTrade(managerA, teamAId, managerB, teamBId);
}

function handleWaiverManagerChange() {
  const manager = document.getElementById('waiver-manager').value;
  const dropSelect = document.getElementById('waiver-drop');
  if (!dropSelect) return;

  dropSelect.innerHTML = '<option value="">-- Choose Team to Drop --</option>';

  if (manager) {
    const picks = state.draftPicks.filter(p => p.manager === manager);
    picks.forEach(p => {
      const teamObj = getTeamById(p.teamId);
      const opt = document.createElement('option');
      opt.value = p.teamId;
      opt.textContent = teamObj.name;
      dropSelect.appendChild(opt);
    });
  }
}

function submitWaiverForm(e) {
  e.preventDefault();
  const manager = document.getElementById('waiver-manager').value;
  const dropTeamId = document.getElementById('waiver-drop').value;
  const addTeamId = document.getElementById('waiver-add').value;

  if (!manager || !dropTeamId || !addTeamId) {
    showNotification("Complete all waiver fields first!", "error");
    return;
  }

  executeWaiver(manager, dropTeamId, addTeamId);
}

function renderDiagnostics() {
  // Config state string
  const configTextarea = document.getElementById('diagnostics-state-json');
  if (configTextarea) {
    configTextarea.value = JSON.stringify(state, null, 2);
  }
}

// Live Ticker: renders upcoming & recent API matches in the Match Center
function renderLiveTicker() {
  const tickerContainer = document.getElementById('live-ticker-list');
  if (!tickerContainer) return;

  if (apiMatchCache.length === 0) {
    tickerContainer.innerHTML = `<div class="text-muted" style="padding: 16px; text-align: center;">Waiting for first sync…</div>`;
    return;
  }

  // Sort by date, show today + recent finished + upcoming next 3
  const now = new Date();
  
  // Parse date from "MM/DD/YYYY HH:mm" format
  function parseApiDate(str) {
    if (!str) return new Date(0);
    const [datePart, timePart] = str.split(' ');
    const [month, day, year] = datePart.split('/');
    const [hour, min] = (timePart || '00:00').split(':');
    return new Date(year, month - 1, day, hour, min);
  }

  // Show: all finished from last 3 days + all in-progress + next 6 upcoming
  const finished = apiMatchCache
    .filter(g => g.finished === 'TRUE' || g.finished === true)
    .sort((a, b) => parseApiDate(b.local_date) - parseApiDate(a.local_date))
    .slice(0, 8);

  const live = apiMatchCache.filter(g => 
    g.time_elapsed && g.time_elapsed !== 'notstarted' && g.time_elapsed !== 'fulltime' &&
    g.finished !== 'TRUE' && g.finished !== true
  );

  const upcoming = apiMatchCache
    .filter(g => g.time_elapsed === 'notstarted' && g.finished !== 'TRUE')
    .sort((a, b) => parseApiDate(a.local_date) - parseApiDate(b.local_date))
    .slice(0, 5);

  const toShow = [...live, ...upcoming, ...finished];

  if (toShow.length === 0) {
    tickerContainer.innerHTML = `<div class="text-muted" style="padding: 16px; text-align: center;">No matches found in feed.</div>`;
    return;
  }

  tickerContainer.innerHTML = '';

  toShow.forEach(g => {
    const isFinished = g.finished === 'TRUE' || g.finished === true;
    const isLive = !isFinished && g.time_elapsed && g.time_elapsed !== 'notstarted';
    
    const homeId = resolveTeamId(g.home_team_name_en);
    const awayId = resolveTeamId(g.away_team_name_en);

    // Check if this match was auto-imported into our state
    const apiMatchId = `api_${g.id}`;
    const isImported = state.matches.some(m => m.apiMatchId === apiMatchId);

    const importedBadge = isImported
      ? `<span class="api-badge">✓ Imported</span>`
      : (isFinished ? `<span class="api-badge api-badge-pending">Pending</span>` : '');

    const statusBadge = isLive
      ? `<span class="api-badge api-badge-live">🔴 LIVE ${g.time_elapsed ? g.time_elapsed + "'" : ''}</span>`
      : (isFinished ? '' : `<span class="api-badge api-badge-upcoming">${g.local_date || 'TBD'}</span>`);

    const scoreHtml = isFinished || isLive
      ? `<span class="ticker-score">${g.home_score} - ${g.away_score}</span>`
      : `<span class="ticker-score-upcoming">vs</span>`;

    // Highlight if either team is drafted
    const homeOwner = state.draftPicks.find(p => p.teamId === homeId);
    const awayOwner = state.draftPicks.find(p => p.teamId === awayId);
    const hasDraftedTeam = homeOwner || awayOwner;
    const ownerHtml = hasDraftedTeam
      ? `<div style="font-size: 0.7rem; color: var(--accent-gold); margin-top: 4px;">
          ${homeOwner ? `<span>⚡ ${homeOwner.manager}</span>` : ''}
          ${awayOwner ? `<span style="margin-left: 8px;">⚡ ${awayOwner.manager}</span>` : ''}
        </div>`
      : '';

    const groupLabel = g.group ? `<span class="ticker-group">Grp ${g.group}</span>` : '';

    const item = document.createElement('div');
    item.className = `ticker-item ${isLive ? 'ticker-item-live' : ''} ${hasDraftedTeam ? 'ticker-item-relevant' : ''}`;
    item.innerHTML = `
      <div class="ticker-left">
        ${groupLabel}
        <div class="ticker-teams">
          <span class="ticker-team ${homeOwner ? 'ticker-team-owned' : ''}">${g.home_team_name_en || 'TBD'}</span>
          ${scoreHtml}
          <span class="ticker-team ${awayOwner ? 'ticker-team-owned' : ''}">${g.away_team_name_en || 'TBD'}</span>
        </div>
        ${ownerHtml}
      </div>
      <div class="ticker-right">
        ${statusBadge}
        ${importedBadge}
      </div>
    `;
    tickerContainer.appendChild(item);
  });
}


function changePhase(phase) {
  state.leaguePhase = phase;
  showNotification(`League shifted to ${phase.replace('_', ' ')} phase.`, "info");
  saveState();
  renderApp();
}

function triggerCoinFlip() {
  // Pick two managers to flip
  const managerA = prompt("Enter first tied manager name:", MANAGERS[0]);
  const managerB = prompt("Enter second tied manager name:", MANAGERS[1]);

  if (!MANAGERS.includes(managerA) || !MANAGERS.includes(managerB)) {
    alert("Invalid manager names!");
    return;
  }

  const flip = Math.random() < 0.5;
  const winner = flip ? managerA : managerB;
  
  state.coinFlipWinner = winner;
  alert(`Coin flipped! 🪙 Winner is: ${winner}`);
  showNotification(`Coin flip tiebreaker awarded to ${winner}!`, "info");
  
  saveState();
  renderApp();
}

function clearCoinFlip() {
  state.coinFlipWinner = null;
  showNotification("Coin flip tiebreaker cleared.", "info");
  saveState();
  renderApp();
}

function exportStateJSON() {
  const stateStr = JSON.stringify(state, null, 2);
  const blob = new Blob([stateStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `world_cup_fantasy_state_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importStateJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        if (imported && Array.isArray(imported.draftPicks) && Array.isArray(imported.matches)) {
          state = imported;
          saveState();
          renderApp();
          showNotification("League state imported successfully!", "success");
        } else {
          showNotification("Invalid file format. Cannot load league state.", "error");
        }
      } catch (err) {
        showNotification("Failed to parse JSON file.", "error");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function resetDraftConfirm() {
  if (confirm("Are you sure you want to clear all draft picks, match history, and start fresh? This cannot be undone!")) {
    state = getInitialState();
    saveState();
    renderApp();
    showNotification("League reset to starting draft phase.", "info");
    switchTab('draft-board-tab');
  }
}

// 11. Initial Startup Hook
window.addEventListener('DOMContentLoaded', async () => {
  loadState();
  
  // Set up forms handlers
  const mForm = document.getElementById('match-logger-form');
  if (mForm) mForm.addEventListener('submit', handleMatchSubmit);

  const tForm = document.getElementById('trade-logger-form');
  if (tForm) tForm.addEventListener('submit', submitTradeForm);

  const wForm = document.getElementById('waiver-logger-form');
  if (wForm) wForm.addEventListener('submit', submitWaiverForm);

  // Initialize theme
  const theme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  // Try connecting to Firebase if previously configured
  const fbConnected = tryAutoConnect();

  renderApp();

  // If Firebase is connected, load state from it and set up real-time listener
  if (fbConnected) {
    await loadStateFromFirebase();
    listenForStateChanges(applyRemoteState);
    listenForPresence((managers) => {
      updateConnectionUI();
      renderPresenceDots(managers);
    });
  }

  // Show identity modal if Firebase is configured but no identity is set
  if (fbConnected && !getManagerIdentity()) {
    showIdentityModal();
  }

  // Start live auto-sync from worldcup26.ir API
  startAutoSync();

  // Update identity display
  updateIdentityDisplay();
});

// Theme switcher
function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme');
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  localStorage.setItem('theme', newTheme);
}

// ═══════════════════════════════════════════════════════════
// IDENTITY & FIREBASE CONFIG UI
// ═══════════════════════════════════════════════════════════

function showIdentityModal() {
  // Remove existing modal if any
  const existing = document.getElementById('identity-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'identity-modal';
  modal.className = 'identity-modal-overlay';

  const managerBtns = MANAGERS.map(name => 
    `<button class="identity-btn" onclick="selectIdentity('${name}')">
      <span class="identity-btn-icon">👤</span>
      <span class="identity-btn-name">${name}</span>
    </button>`
  ).join('');

  modal.innerHTML = `
    <div class="identity-modal-card">
      <div class="identity-modal-header">
        <span style="font-size: 2.5rem;">🏆</span>
        <h2 class="font-outfit" style="font-size: 1.8rem; font-weight: 800;">Who are you?</h2>
        <p class="text-secondary" style="font-size: 0.95rem;">Select your manager identity to join the draft</p>
      </div>
      <div class="identity-btn-grid">
        ${managerBtns}
      </div>
      <p class="text-muted" style="font-size: 0.75rem; text-align: center; margin-top: 1rem;">Your identity is saved on this device. You can change it later in Settings.</p>
    </div>
  `;

  document.body.appendChild(modal);
  // Animate in
  requestAnimationFrame(() => modal.classList.add('visible'));
}

function selectIdentity(name) {
  setManagerIdentity(name);
  const modal = document.getElementById('identity-modal');
  if (modal) {
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 400);
  }
  showNotification(`Welcome, ${name}! You're in the draft.`, 'success');
  updateIdentityDisplay();
  renderApp();
}

function changeIdentity() {
  showIdentityModal();
}

function updateIdentityDisplay() {
  const nameEl = document.getElementById('current-identity-name');
  const identity = getManagerIdentity();
  if (nameEl) {
    nameEl.textContent = identity || 'Not set';
  }
}

function renderPresenceDots(managers) {
  const container = document.getElementById('presence-dots');
  if (!container) return;

  container.innerHTML = '';
  MANAGERS.forEach(name => {
    const isOnline = managers.includes(name);
    const dot = document.createElement('span');
    dot.className = `presence-badge ${isOnline ? 'presence-online' : 'presence-offline'}`;
    dot.title = `${name}: ${isOnline ? 'Online' : 'Offline'}`;
    dot.textContent = name.charAt(0);
    container.appendChild(dot);
  });
}

// Firebase config paste handler
function applyFirebaseConfig() {
  const textarea = document.getElementById('firebase-config-input');
  if (!textarea) return;

  let raw = textarea.value.trim();
  
  // Try to extract just the config object if they pasted more than needed
  // Look for { ... } pattern
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) raw = match[0];

  try {
    // Safely parse JS object literal by executing it in a function wrapper
    const config = new Function(`return (${raw});`)();
    
    if (!config || typeof config !== 'object') {
      throw new Error('Parsed result is not an object');
    }

    // Auto-generate databaseURL if missing (Firebase no longer includes it by default)
    if (!config.databaseURL && config.projectId) {
      config.databaseURL = `https://${config.projectId}-default-rtdb.firebaseio.com`;
    }

    if (!config.apiKey || !config.projectId) {
      showNotification('Config is missing required fields (apiKey, projectId).', 'error');
      return;
    }

    const success = initFirebase(config);
    if (success) {
      showNotification('🔥 Firebase connected! All managers can now join remotely.', 'success');
      listenForStateChanges(applyRemoteState);
      listenForPresence((managers) => {
        updateConnectionUI();
        renderPresenceDots(managers);
      });

      // Push current state to Firebase so others get it
      syncStateToFirebase(state);
      updatePresence();
      updateConnectionUI();

      // Show identity modal if not set
      if (!getManagerIdentity()) {
        showIdentityModal();
      }
    } else {
      showNotification('Failed to connect to Firebase. Check config.', 'error');
    }
  } catch (err) {
    showNotification('Could not parse config. Try pasting the entire firebaseConfig block.', 'error');
    console.error('Firebase config parse error:', err, 'Processed input:', raw);
  }
}

function disconnectFirebase() {
  clearFirebaseConfig();
  if (firebaseApp) {
    try { firebaseApp.delete(); } catch(e) {}
    firebaseApp = null;
    firebaseDb = null;
    firebaseConnected = false;
  }
  showNotification('Firebase disconnected. Running in local-only mode.', 'info');
  updateConnectionUI();
}
