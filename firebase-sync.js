// ═══════════════════════════════════════════════════════════
// FIREBASE SYNC MODULE
// ═══════════════════════════════════════════════════════════
// Provides real-time multiplayer state synchronization via
// Firebase Realtime Database. Falls back to localStorage
// when Firebase is not configured or unreachable.

const FIREBASE_CONFIG_KEY = 'wc_fantasy_firebase_config';
const MANAGER_IDENTITY_KEY = 'wc_fantasy_manager_identity';
const DB_STATE_PATH = 'league_state';
const DB_PRESENCE_PATH = 'presence';

let firebaseApp = null;
let firebaseDb = null;
let firebaseConnected = false;
let stateListenerUnsubscribe = null;
let presenceRef = null;
let myPresenceRef = null;
let onlineManagers = [];
let pendingWrites = false;

// ── Config Management ────────────────────────────────────

function getStoredFirebaseConfig() {
  try {
    const raw = localStorage.getItem(FIREBASE_CONFIG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function storeFirebaseConfig(config) {
  localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(config));
}

function clearFirebaseConfig() {
  localStorage.removeItem(FIREBASE_CONFIG_KEY);
}

// ── Manager Identity ─────────────────────────────────────

function getManagerIdentity() {
  return localStorage.getItem(MANAGER_IDENTITY_KEY) || null;
}

function setManagerIdentity(name) {
  localStorage.setItem(MANAGER_IDENTITY_KEY, name);
  updatePresence();
}

function clearManagerIdentity() {
  localStorage.removeItem(MANAGER_IDENTITY_KEY);
}

// ── Firebase Initialization ──────────────────────────────

function initFirebase(config) {
  try {
    // Firebase SDK loaded from CDN provides these globals
    if (typeof firebase === 'undefined') {
      console.warn('Firebase SDK not loaded');
      return false;
    }

    // If already initialized, clean up first
    if (firebaseApp) {
      try { firebaseApp.delete(); } catch (e) { /* ignore */ }
    }

    firebaseApp = firebase.initializeApp(config);
    firebaseDb = firebase.database();

    // Monitor connection state
    const connRef = firebase.database().ref('.info/connected');
    connRef.on('value', (snap) => {
      const wasConnected = firebaseConnected;
      firebaseConnected = snap.val() === true;
      updateConnectionUI();
      
      if (firebaseConnected && !wasConnected) {
        console.log('Firebase connected');
        updatePresence();
      }
      if (!firebaseConnected && wasConnected) {
        console.log('Firebase disconnected');
      }
    });

    storeFirebaseConfig(config);
    return true;
  } catch (err) {
    console.error('Firebase init failed:', err);
    return false;
  }
}

function isFirebaseReady() {
  return firebaseDb !== null && firebaseConnected;
}

// ── State Sync: Write ────────────────────────────────────

function syncStateToFirebase(stateObj) {
  if (!firebaseDb) return Promise.resolve(false);

  pendingWrites = true;
  return firebaseDb.ref(DB_STATE_PATH).set(stateObj)
    .then(() => {
      pendingWrites = false;
      return true;
    })
    .catch((err) => {
      console.error('Firebase write failed:', err);
      pendingWrites = false;
      return false;
    });
}

// ── State Sync: Listen ───────────────────────────────────

function listenForStateChanges(callback) {
  if (!firebaseDb) return;

  // Remove any existing listener
  if (stateListenerUnsubscribe) {
    firebaseDb.ref(DB_STATE_PATH).off('value', stateListenerUnsubscribe);
  }

  stateListenerUnsubscribe = firebaseDb.ref(DB_STATE_PATH).on('value', (snapshot) => {
    // Skip if we just wrote (avoid echo loops)
    if (pendingWrites) return;

    const data = snapshot.val();
    if (data && typeof data === 'object' && Array.isArray(data.draftPicks)) {
      callback(data);
    }
  });
}

// ── State Sync: One-time Read ────────────────────────────

function readStateFromFirebase() {
  if (!firebaseDb) return Promise.resolve(null);

  return firebaseDb.ref(DB_STATE_PATH).once('value')
    .then((snapshot) => {
      const data = snapshot.val();
      if (data && typeof data === 'object' && Array.isArray(data.draftPicks)) {
        return data;
      }
      return null;
    })
    .catch((err) => {
      console.error('Firebase read failed:', err);
      return null;
    });
}

// ── Presence System ──────────────────────────────────────

function updatePresence() {
  if (!firebaseDb) return;

  const identity = getManagerIdentity();
  if (!identity) return;

  // Clean up old presence
  if (myPresenceRef) {
    myPresenceRef.remove();
  }

  myPresenceRef = firebaseDb.ref(`${DB_PRESENCE_PATH}/${identity}`);
  myPresenceRef.set({
    online: true,
    lastSeen: firebase.database.ServerValue.TIMESTAMP
  });

  // Remove presence on disconnect
  myPresenceRef.onDisconnect().remove();
}

function listenForPresence(callback) {
  if (!firebaseDb) return;

  firebaseDb.ref(DB_PRESENCE_PATH).on('value', (snapshot) => {
    const data = snapshot.val();
    const managers = [];
    if (data) {
      Object.keys(data).forEach(name => {
        if (data[name] && data[name].online) {
          managers.push(name);
        }
      });
    }
    onlineManagers = managers;
    callback(managers);
  });
}

// ── Connection UI Helpers ────────────────────────────────

function updateConnectionUI() {
  const indicator = document.getElementById('firebase-connection-dot');
  const label = document.getElementById('firebase-connection-label');
  
  if (!indicator || !label) return;

  if (!firebaseDb) {
    indicator.className = 'sync-dot sync-dot-paused';
    label.textContent = 'Firebase not configured';
  } else if (firebaseConnected) {
    indicator.className = 'sync-dot sync-dot-active';
    const count = onlineManagers.length;
    label.textContent = `${count} manager${count !== 1 ? 's' : ''} online`;
  } else {
    indicator.className = 'sync-dot sync-dot-error';
    label.textContent = 'Reconnecting…';
  }
}

// ── Setup Flow ───────────────────────────────────────────

function tryAutoConnect() {
  const config = getStoredFirebaseConfig();
  if (!config) return false;

  const success = initFirebase(config);
  if (success) {
    updatePresence();
  }
  return success;
}
