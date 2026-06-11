import { useState, useEffect, useCallback } from 'react';
import { supabase } from './supabase.js';
import { calcPoints } from './scoring.js';
import { fetchMatches } from './openfootball.js';

// ─── Time helpers ─────────────────────────────────────────────────────────────
function canBet(matchDate) {
  return Date.now() < new Date(matchDate).getTime() - 30 * 60 * 1000;
}
function timeLeft(matchDate) {
  const diff = new Date(matchDate).getTime() - 30 * 60 * 1000 - Date.now();
  if (diff <= 0) return null;
  const h = Math.floor(diff / 3600000), m = Math.floor((diff % 3600000) / 60000);
  if (h > 48) { const d = Math.floor(h / 24); return `${d}z ${h % 24}h`; }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtDate(ds) {
  const d = new Date(ds);
  return d.toLocaleDateString('ro-RO', {
    day: '2-digit', month: 'short', weekday: 'short',
    timeZone: 'Europe/Bucharest'
  }) + ' ' + d.toLocaleTimeString('ro-RO', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Bucharest'
  });
}
// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#080d18', surface: '#0f1923', card: '#162032', border: '#1c3354',
  accent: '#00d4ff', accent2: '#00ff88', text: '#ddeeff', muted: '#5a7a9a',
  danger: '#ff4444', warn: '#ffc832', gold: '#ffd700',
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Game data
  const [matches, setMatches] = useState([]);
  const [predictions, setPredictions] = useState({});   // { matchId: { home, away, locked } }
  const [allPredictions, setAllPredictions] = useState([]); // toate pariurile (după blocare)
  const [myFinalists, setMyFinalists] = useState([null, null]);
  const [allFinalists, setAllFinalists] = useState([]);
  const [actualFinals, setActualFinals] = useState([null, null]);
  const [profiles, setProfiles] = useState([]);

  // Sync
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const [tab, setTab] = useState('matches');
  const [now, setNow] = useState(Date.now());

  // PWA install
  const [installPrompt, setInstallPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);

  useEffect(() => {
    const handler = (e) => { e.preventDefault(); setInstallPrompt(e); setShowInstallBanner(true); };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    if (outcome === 'accepted') setShowInstallBanner(false);
    setInstallPrompt(null);
  };

  // Clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // ─── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user ?? null);
      if (session?.user) loadProfile(session.user.id);
      else { setProfile(null); setLoading(false); }
    });

    return () => subscription.unsubscribe();
  }, []);

  const loadProfile = async (userId) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single();
    setProfile(data);
    setLoading(false);
  };

  const login = async (username, password) => {
    // Găsim email-ul asociat username-ului
    const { data: prof } = await supabase
      .from('profiles')
      .select('id, username')
      .eq('username', username.toLowerCase())
      .single();

    if (!prof) return 'Username inexistent.';

    const { error } = await supabase.auth.signInWithPassword({
      email: `${username.toLowerCase()}@friendlyrival.app`,
      password,
    });

    if (error) return 'Parolă incorectă.';
    return null;
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setPredictions({});
    setAllPredictions([]);
    setMyFinalists([null, null]);
  };

  // ─── Load data ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!currentUser || !profile) return;
    loadMatches();
    loadMyPredictions();
    loadAllPredictions();
    loadMyFinalists();
    loadAllFinalists();
    loadActualFinals();
    loadProfiles();
  }, [currentUser, profile]);

  const loadMatches = async () => {
    const { data } = await supabase
      .from('matches')
      .select('*')
      .order('match_date', { ascending: true }); // ← ordonate cronologic
    if (data) setMatches(data.map(m => ({
      id: m.id,
      home: m.home,
      away: m.away,
      date: m.match_date,
      group: m.match_group,
      round: m.round,
      score: m.score_home != null && m.score_away != null
        ? { home: String(m.score_home), away: String(m.score_away) }
        : null,
      isManual: m.is_manual,
    })));
  };

  const loadMyPredictions = async () => {
    const { data } = await supabase
      .from('predictions')
      .select('*')
      .eq('user_id', currentUser.id);
    if (data) {
      const map = {};
      data.forEach(p => {
        map[p.match_id] = {
          home: p.score_home != null ? String(p.score_home) : '',
          away: p.score_away != null ? String(p.score_away) : '',
          locked: p.locked,
        };
      });
      setPredictions(map);
    }
  };

 const loadAllPredictions = async () => {
    const { data, error } = await supabase
      .from('predictions')
      .select('*');
    console.log('allPredictions:', data, 'error:', error);
    if (data) setAllPredictions(data);
  };

  const loadMyFinalists = async () => {
    const { data } = await supabase
      .from('finalists')
      .select('*')
      .eq('user_id', currentUser.id)
      .single();
    if (data) setMyFinalists([data.team1, data.team2]);
  };

  const loadAllFinalists = async () => {
    const { data } = await supabase
      .from('finalists')
      .select('*, profiles(display_name, username)');
    if (data) setAllFinalists(data);
  };

  const loadActualFinals = async () => {
    const { data } = await supabase
      .from('actual_finalists')
      .select('*')
      .eq('id', 1)
      .single();
    if (data) setActualFinals([data.team1, data.team2]);
  };

  const loadProfiles = async () => {
    const { data } = await supabase.from('profiles').select('*');
    if (data) setProfiles(data);
  };

  // ─── Sync openfootball ─────────────────────────────────────────────────────
  const sync = useCallback(async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const fetched = await fetchMatches();
      if (!fetched.length) throw new Error('Nicio dată primită');

      // Upsert meciuri în Supabase
      const rows = fetched.map(m => ({
        id: m.id,
        home: m.home,
        away: m.away,
        match_date: m.date,
        match_group: m.group || null,
        round: m.round,
        score_home: m.score ? parseInt(m.score.home) : null,
        score_away: m.score ? parseInt(m.score.away) : null,
        is_manual: false,
      }));

      const { error } = await supabase.from('matches').upsert(rows, {
        onConflict: 'id',
        ignoreDuplicates: true,
      });

      if (error) throw new Error(error.message);

      await loadMatches();
      setLastSync(Date.now());
      setSyncMsg(`✅ ${fetched.length} meciuri actualizate`);
    } catch (e) {
      setSyncMsg(`⚠️ Eroare: ${e.message}`);
    }
    setSyncing(false);
  }, []);

//useEffect(() => {
//    if (currentUser) sync();
//  }, [currentUser]);

  // ─── Predictions ───────────────────────────────────────────────────────────
  const setPred = async (matchId, side, val) => {
    const match = matches.find(m => m.id === matchId);
    if (!match || !canBet(match.date)) return;

    // Update local imediat (UX rapid)
    setPredictions(prev => ({
      ...prev,
      [matchId]: { ...(prev[matchId] || {}), [side]: val },
    }));

    // Sync cu Supabase
    const current = predictions[matchId] || {};
    const newPred = { ...current, [side]: val };

    await supabase.from('predictions').upsert({
      user_id: currentUser.id,
      match_id: matchId,
      score_home: newPred.home !== '' ? parseInt(newPred.home) : null,
      score_away: newPred.away !== '' ? parseInt(newPred.away) : null,
      locked: false,
    }, { onConflict: 'user_id,match_id' });
  };

  // Blocare automată pariuri când expiră timpul
  useEffect(() => {
    matches.forEach(m => {
      if (!canBet(m.date) && predictions[m.id] && !predictions[m.id].locked) {
        supabase.from('predictions')
          .update({ locked: true, locked_at: new Date().toISOString() })
          .eq('user_id', currentUser?.id)
          .eq('match_id', m.id)
          .then(() => {
            setPredictions(prev => ({
              ...prev,
              [m.id]: { ...prev[m.id], locked: true },
            }));
          });
      }
    });
  }, [now, matches]);

  // ─── Finalists ─────────────────────────────────────────────────────────────
  const setFinalistPred = async (idx, team) => {
    const newFin = [...myFinalists];
    newFin[idx] = team;
    setMyFinalists(newFin);

    await supabase.from('finalists').upsert({
      user_id: currentUser.id,
      team1: newFin[0],
      team2: newFin[1],
    }, { onConflict: 'user_id' });
  };

  const setActualFinalistsDB = async (newFinals) => {
    setActualFinals(newFinals);
    await supabase.from('actual_finalists').update({
      team1: newFinals[0],
      team2: newFinals[1],
    }).eq('id', 1);
  };

  // ─── Manual result (admin) ─────────────────────────────────────────────────
  const setManualResult = async (matchId, side, val) => {
    setMatches(prev => prev.map(m => {
      if (m.id !== matchId) return m;
      const score = m.score || { home: '', away: '' };
      return { ...m, score: { ...score, [side]: val }, isManual: true };
    }));

    const match = matches.find(m => m.id === matchId);
    const currentScore = match?.score || {};
    const newScore = { ...currentScore, [side]: val };

    if (newScore.home !== '' && newScore.away !== '' &&
        newScore.home != null && newScore.away != null) {
      await supabase.from('matches').update({
        score_home: parseInt(newScore.home),
        score_away: parseInt(newScore.away),
        is_manual: true,
      }).eq('id', matchId);
    }
  };

  // Admin deblochează un pariu
  const unlockPrediction = async (userId, matchId) => {
    await supabase.from('predictions')
      .update({ locked: false, locked_at: null })
      .eq('user_id', userId)
      .eq('match_id', matchId);
    await loadAllPredictions();
  };

  // ─── Leaderboard ───────────────────────────────────────────────────────────
  const results = {};
  matches.forEach(m => {
    if (m.score) results[m.id] = m.score;
  });

  const players = profiles.filter(p => !p.is_admin);
  const leaderboard = players.map(p => {
    const userPreds = {};
    allPredictions
      .filter(pr => pr.user_id === p.id)
      .forEach(pr => {
        userPreds[pr.match_id] = {
          home: pr.score_home != null ? String(pr.score_home) : '',
          away: pr.score_away != null ? String(pr.score_away) : '',
        };
      });

    // Include și propriile pariuri neblocate pentru calcul propriu
    if (p.id === currentUser?.id) {
      Object.entries(predictions).forEach(([mid, pred]) => {
        if (!userPreds[mid]) userPreds[mid] = pred;
      });
    }

    const userFinalists = allFinalists.find(f => f.user_id === p.id);
    const fin = userFinalists ? [userFinalists.team1, userFinalists.team2] : [];

    const { pts, exact, penalties } = calcPoints(
      userPreds, results, fin, actualFinals.filter(Boolean), matches
    );
    return { ...p, pts, exact, penalties };
  }).sort((a, b) => b.pts - a.pts || b.exact - a.exact);

  const allTeams = [...new Set(matches.flatMap(m => [m.home, m.away]))].sort();
  const campStarted = now > new Date('2026-06-11T19:00:00Z').getTime();
  const isAdmin = profile?.is_admin === true;

  // ─── Render ────────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ ...s.loginBg, flexDirection: 'column', gap: 16 }}>
      <div style={{ fontSize: 52 }}>⚽</div>
      <p style={{ color: C.accent, fontWeight: 700 }}>Se încarcă...</p>
    </div>
  );

  if (!currentUser) {
    return (
      <>
        <LoginScreen onLogin={login} />
        {showInstallBanner && <InstallBanner onInstall={handleInstall} onDismiss={() => setShowInstallBanner(false)} />}
      </>
    );
  }

  return (
    <div style={s.root}>
      {showInstallBanner && <InstallBanner onInstall={handleInstall} onDismiss={() => setShowInstallBanner(false)} />}
      <Header
        user={profile} isAdmin={isAdmin}
        onLogout={logout} tab={tab} setTab={setTab}
      />
      <main style={s.main}>
        {tab === 'matches' && (
          <MatchesTab
            matches={matches}
            predictions={predictions}
            allPredictions={allPredictions}
            profiles={profiles}
            results={results}
            setPred={setPred}
            syncing={syncing} syncMsg={syncMsg} lastSync={lastSync} onSync={sync}
            isAdmin={isAdmin}
            unlockPrediction={unlockPrediction}
          />
        )}
        {tab === 'finalists' && (
          <FinalistsTab
            userPred={myFinalists}
            actualFinals={actualFinals}
            isAdmin={isAdmin}
            onSetPred={setFinalistPred}
            onSetActual={setActualFinalistsDB}
            allTeams={allTeams}
            campStarted={campStarted}
            allPlayers={players}
            allFinalists={allFinalists}
          />
        )}
        {tab === 'standings' && (
          <StandingsTab leaderboard={leaderboard} />
        )}
        {tab === 'profile' && (
          <ProfileTab
            currentUser={profile}
            onChangePassword={async (oldPwd, newPwd) => {
              const { error: signInErr } = await supabase.auth.signInWithPassword({
                email: `${profile.username}@friendlyrival.app`,
                password: oldPwd,
              });
              if (signInErr) return 'Parola curentă este greșită.';
              const { error } = await supabase.auth.updateUser({ password: newPwd });
              if (error) return error.message;
              return null;
            }}
            onChangeName={async (name) => {
              if (!name.trim()) return 'Numele nu poate fi gol.';
              const { error } = await supabase.from('profiles')
                .update({ display_name: name.trim() })
                .eq('id', currentUser.id);
              if (error) return error.message;
              await loadProfile(currentUser.id);
              return null;
            }}
          />
        )}
        {tab === 'admin' && isAdmin && (
          <AdminTab
            matches={matches}
            results={results}
            setResult={setManualResult}
            actualFinals={actualFinals}
            setActualFinals={setActualFinalistsDB}
            syncing={syncing} syncMsg={syncMsg} lastSync={lastSync} onSync={sync}
            profiles={profiles}
            allPredictions={allPredictions}
            unlockPrediction={unlockPrediction}
            currentUserId={currentUser.id}
          />
        )}
      </main>
    </div>
  );
}

// ─── Install Banner ───────────────────────────────────────────────────────────
function InstallBanner({ onInstall, onDismiss }) {
  return (
    <div style={{ position: 'fixed', bottom: 16, left: 16, right: 16, background: '#162032',
      border: '1px solid #00d4ff44', borderRadius: 14, padding: '14px 16px',
      display: 'flex', alignItems: 'center', gap: 12, zIndex: 9999,
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>
      <span style={{ fontSize: 28 }}>⚽</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: '#ddeeff' }}>Instalează FriendlyRival</div>
        <div style={{ fontSize: 12, color: '#5a7a9a' }}>Adaugă pe ecranul principal pentru acces rapid</div>
      </div>
      <button onClick={onInstall} style={{ background: 'linear-gradient(90deg,#00d4ff,#00ff88)',
        border: 'none', borderRadius: 8, color: '#080d18', padding: '8px 14px',
        fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Instalează</button>
      <button onClick={onDismiss} style={{ background: 'none', border: 'none',
        color: '#5a7a9a', cursor: 'pointer', fontSize: 18 }}>✕</button>
    </div>
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) { setErr('Completează username și parolă.'); return; }
    setLoading(true);
    const error = await onLogin(username, password);
    if (error) { setErr(error); setLoading(false); }
  };

  return (
    <div style={s.loginBg}>
      <div style={s.loginCard}>
        <div style={{ fontSize: 52, textAlign: 'center' }}>⚽</div>
        <h1 style={s.loginTitle}>FriendlyRival</h1>
        <p style={{ color: C.muted, textAlign: 'center', margin: 0, fontSize: 14 }}>
          Campionat Amical de Pariuri
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={s.label}>Username</label>
          <input style={s.input} autoCapitalize="none" autoCorrect="off"
            placeholder="ex: vlad" value={username}
            onChange={e => { setUsername(e.target.value); setErr(''); }}
            onKeyDown={e => e.key === 'Enter' && handleLogin()} />
          <label style={s.label}>Parolă</label>
          <div style={{ position: 'relative' }}>
            <input style={{ ...s.input, paddingRight: 40 }}
              type={showPwd ? 'text' : 'password'}
              placeholder="••••••••" value={password}
              onChange={e => { setPassword(e.target.value); setErr(''); }}
              onKeyDown={e => e.key === 'Enter' && handleLogin()} />
            <button onClick={() => setShowPwd(p => !p)}
              style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: C.muted, fontSize: 16 }}>
              {showPwd ? '🙈' : '👁️'}
            </button>
          </div>
          {err && <p style={{ color: C.danger, fontSize: 13, margin: 0 }}>{err}</p>}
          <button style={{ ...s.btnPrimary, marginTop: 4, opacity: loading ? 0.7 : 1 }}
            onClick={handleLogin} disabled={loading}>
            {loading ? 'Se încarcă...' : 'Intră în joc →'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────────────
function Header({ user, isAdmin, onLogout, tab, setTab }) {
  const tabs = [
    { id: 'matches', label: '⚽ Meciuri' },
    { id: 'finalists', label: '🏆 Finaliste' },
    { id: 'standings', label: '📊 Clasament' },
    { id: 'profile', label: '👤 Profil' },
    ...(isAdmin ? [{ id: 'admin', label: '⚙️ Admin' }] : []),
  ];
  return (
    <header style={s.header}>
      <div style={s.headerInner}>
        <span style={s.logo}>FriendlyRival 🌍</span>
        <nav style={s.nav}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ ...s.navBtn, ...(tab === t.id ? s.navActive : {}) }}>
              {t.label}
            </button>
          ))}
        </nav>
        <button style={s.btnLogout} onClick={onLogout}>Ieși</button>
      </div>
    </header>
  );
}

// ─── Matches Tab ──────────────────────────────────────────────────────────────
function MatchesTab({ matches, predictions, allPredictions, profiles, results,
  setPred, syncing, syncMsg, lastSync, onSync, isAdmin, unlockPrediction }) {
  const [filter, setFilter] = useState('Toate');

  const roundOrder = ['Toate', 'Grupe', '16-imi', 'Optimi', 'Sferturi', 'Semifinale', 'Finala Mică', 'FINALA'];
  const availableRounds = roundOrder.filter(r =>
    r === 'Toate' ? true :
    r === 'Grupe' ? matches.some(m => !!m.group) :
    matches.some(m => m.round === r)
  );

  const filtered = matches
    .filter(m => {
      if (filter === 'Toate') return true;
      if (filter === 'Grupe') return !!m.group;
      return m.round === filter;
    });

  return (
    <div style={s.section}>
      {isAdmin && <SyncBar syncing={syncing} syncMsg={syncMsg} lastSync={lastSync} onSync={onSync} />}
      {matches.length === 0 && !syncing && (
        <div style={s.emptyBox}>
          📡 Apasă <strong>Actualizează</strong> pentru a încărca meciurile.
        </div>
      )}
      <FilterRow rounds={availableRounds} filter={filter} setFilter={setFilter} />
      <div style={s.matchList}>
        {filtered.map(m => (
          <MatchCard key={m.id} match={m}
            pred={predictions[m.id]}
            allPreds={allPredictions.filter(p => p.match_id === m.id)}
            profiles={profiles}
            result={results[m.id]}
            setPred={setPred}
            isAdmin={isAdmin}
            unlockPrediction={unlockPrediction}
          />
        ))}
      </div>
    </div>
  );
}

function MatchCard({ match, pred, allPreds, profiles, result, setPred, isAdmin, unlockPrediction }) {
  const [showAll, setShowAll] = useState(false);
  const open = canBet(match.date);
  const tl = timeLeft(match.date);
  const played = result && result.home !== '' && result.away !== '' && result.home != null;
  const ph = pred?.home ?? '';
  const pa = pred?.away ?? '';

  let status = null;
  if (played && ph !== '' && pa !== '') {
    const rh = parseInt(result.home), ra = parseInt(result.away);
    const iph = parseInt(ph), ipa = parseInt(pa);
    if (iph === rh && ipa === ra) status = 'exact';
    else if ((iph > ipa) === (rh > ra) && (iph === ipa) === (rh === ra)) status = 'result';
    else status = 'wrong';
  } else if (played) status = 'nopred';

  const SC = { exact: '#00ff88', result: '#ffc832', wrong: '#ff6666', nopred: '#ff4444' };
  const SL = { exact: '⚡ +3 Scor exact!', result: '✓ +1 Rezultat corect', wrong: '✗ 0 pts', nopred: '✗ −1 Nepariat!' };

  return (
    <div style={{ ...s.matchCard, ...(status ? { borderColor: SC[status] + '66' } : {}) }}>
      <div style={s.matchMeta}>
        <span style={s.roundBadge}>{match.round}</span>
        <span style={{ color: C.muted, fontSize: 12 }}>{fmtDate(match.date)}</span>
        {open && tl && <span style={{ color: C.warn, fontSize: 11, fontWeight: 700 }}>⏱ {tl}</span>}
        {!open && !played && <span style={{ color: C.muted, fontSize: 11 }}>🔒 Blocat</span>}
        {played && <span style={{ color: '#888', fontSize: 11 }}>✅ Jucat</span>}
      </div>

      <div style={s.matchRow}>
        <span style={s.team}>{match.home}</span>
        <div style={s.scoreBox}>
          {open ? (
            <>
              <input style={s.scoreIn} type="number" min="0" max="20"
                value={ph} placeholder="—"
                onChange={e => setPred(match.id, 'home', e.target.value)} />
              <span style={s.colon}>:</span>
              <input style={s.scoreIn} type="number" min="0" max="20"
                value={pa} placeholder="—"
                onChange={e => setPred(match.id, 'away', e.target.value)} />
            </>
          ) : (
            <>
              <span style={s.scoreStatic}>{ph !== '' ? ph : '—'}</span>
              <span style={s.colon}>:</span>
              <span style={s.scoreStatic}>{pa !== '' ? pa : '—'}</span>
            </>
          )}
        </div>
        <span style={{ ...s.team, textAlign: 'right' }}>{match.away}</span>
      </div>

      {played && (
        <div style={s.resultRow}>
          <span style={{ color: C.muted, fontSize: 13 }}>
            Scor real: <strong style={{ color: C.text }}>{result.home} – {result.away}</strong>
          </span>
          {status && (
            <span style={{ ...s.badge, background: SC[status] + '22', color: SC[status] }}>
              {SL[status]}
            </span>
          )}
        </div>
      )}

      {/* Pariurile celorlalți — vizibile doar după blocare */}
      {!open && allPreds.length > 0 && (
        <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 8 }}>
          <button onClick={() => setShowAll(p => !p)}
            style={{ background: 'none', border: 'none', color: C.accent,
              fontSize: 12, cursor: 'pointer', fontWeight: 600, padding: 0 }}>
            {showAll ? '▲ Ascunde' : `▼ Vezi pariurile (${allPreds.length})`}
          </button>
          {showAll && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {allPreds.map(p => {
                const prof = profiles.find(u => u.id === p.user_id);
                return (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 8px', background: C.surface, borderRadius: 8, fontSize: 13 }}>
                    <span style={{ flex: 1, color: C.muted }}>{prof?.display_name || '?'}</span>
                    <span style={{ fontWeight: 700, color: C.text }}>
                      {p.score_home ?? '—'} : {p.score_away ?? '—'}
                    </span>
                    {p.locked
                      ? <span style={{ color: C.muted, fontSize: 11 }}>🔒</span>
                      : <span style={{ color: C.warn, fontSize: 11 }}>✏️</span>}
                    {isAdmin && p.locked && (
                      <button onClick={() => unlockPrediction(p.user_id, p.match_id)}
                        style={{ background: C.warn + '22', border: `1px solid ${C.warn}44`,
                          color: C.warn, borderRadius: 6, padding: '2px 7px',
                          fontSize: 11, cursor: 'pointer' }}>
                        Deblochează
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Finalists Tab ────────────────────────────────────────────────────────────
function FinalistsTab({ userPred, actualFinals, isAdmin, onSetPred, onSetActual,
  allTeams, campStarted, allPlayers, allFinalists }) {
  const [q, setQ] = useState('');
  const teams = allTeams.length > 0 ? allTeams :
    ['Brazilia', 'Argentina', 'Franta', 'Anglia', 'Spania', 'Germania', 'Portugalia', 'Olanda'];
  const filtered = teams.filter(t => t.toLowerCase().includes(q.toLowerCase()));
  const locked = campStarted && !isAdmin;

  return (
    <div style={s.section}>
      <div style={s.card}>
        <h2 style={s.sectionTitle}>🏆 Pariază Finalistele</h2>
        <p style={{ color: C.muted, fontSize: 14, margin: 0 }}>
          Ghicește ambele echipe din finală.{' '}
          <strong style={{ color: C.accent }}>+1 pt</strong> per echipă ghicită corect,{' '}
          <strong style={{ color: C.accent }}>+3 pts</strong> dacă le ghicești pe amândouă.
          Trebuie alese înainte de startul campionatului.
        </p>
        {locked && (
          <div style={s.alertBox}>⚠️ Campionatul a început — predicțiile sunt blocate.</div>
        )}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[0, 1].map(i => (
            <div key={i} style={s.finSlot}>
              <span style={{ color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase' }}>
                Finalista {i + 1}
              </span>
              <span style={{ fontSize: 16, fontWeight: 800, color: userPred[i] ? C.accent : C.muted }}>
                {userPred[i] || '—'}
              </span>
              {userPred[i] && !locked && (
                <button style={s.clearBtn} onClick={() => onSetPred(i, null)}>✕</button>
              )}
            </div>
          ))}
        </div>
        {!locked && (
          <>
            <input style={s.input} placeholder="Caută echipă..." value={q}
              onChange={e => setQ(e.target.value)} />
            <div style={s.teamGrid}>
              {filtered.map(t => (
                <button key={t}
                  style={{ ...s.teamBtn, ...(userPred.includes(t) ? s.teamBtnOn : {}) }}
                  onClick={() => {
                    if (userPred.includes(t)) return;
                    if (!userPred[0]) onSetPred(0, t);
                    else if (!userPred[1]) onSetPred(1, t);
                  }}>{t}</button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={s.card}>
        <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>
          🎯 Pariurile tuturor jucătorilor
        </h3>
        {!campStarted && (
          <div style={s.alertBox}>
            👁️ Finalistele celorlalți sunt ascunse până la startul campionatului (11 Iunie).
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {allPlayers.map(u => {
            const fp = allFinalists.find(f => f.user_id === u.id);
            const visible = campStarted || isAdmin;
            return (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', background: C.surface, borderRadius: 10 }}>
                <span style={{ flex: 1, fontWeight: 600 }}>{u.display_name}</span>
                {visible ? (
                  <>
                    <span style={{ color: fp?.team1 ? C.accent : C.muted, fontSize: 13 }}>
                      {fp?.team1 || '—'}
                    </span>
                    <span style={{ color: C.muted }}>vs</span>
                    <span style={{ color: fp?.team2 ? C.accent : C.muted, fontSize: 13 }}>
                      {fp?.team2 || '—'}
                    </span>
                  </>
                ) : (
                  <span style={{ color: C.muted, fontSize: 12 }}>🔒 Ascuns până la start</span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {isAdmin && (
        <div style={s.card}>
          <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>
            ⚙️ Finaliste reale (admin)
          </h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[0, 1].map(i => (
              <div key={i} style={{ flex: 1, minWidth: 160 }}>
                <label style={s.label}>Finalista reală {i + 1}</label>
                <select style={s.select} value={actualFinals[i] || ''}
                  onChange={e => {
                    const nf = [...actualFinals]; nf[i] = e.target.value;
                    onSetActual(nf);
                  }}>
                  <option value="">—</option>
                  {teams.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            ))}
          </div>
          {actualFinals[0] && actualFinals[1] && (
            <p style={{ color: C.accent2, fontWeight: 600, fontSize: 14, margin: 0 }}>
              ✅ Finala: {actualFinals[0]} vs {actualFinals[1]}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Standings Tab ────────────────────────────────────────────────────────────
function StandingsTab({ leaderboard }) {
  return (
    <div style={s.section}>
      <h2 style={s.sectionTitle}>📊 Clasament</h2>
      <div style={s.table}>
        <div style={s.tableHead}>
          <span style={{ width: 36 }}>#</span>
          <span style={{ flex: 1 }}>Jucător</span>
          <span style={{ width: 60, textAlign: 'center' }}>Pts</span>
          <span style={{ width: 80, textAlign: 'center' }}>Exacte</span>
          <span style={{ width: 76, textAlign: 'center' }}>Penaliz.</span>
        </div>
        {leaderboard.map((p, i) => (
          <div key={p.id} style={{ ...s.tableRow, ...(i === 0 ? { background: C.gold + '12' } : {}) }}>
            <span style={{ width: 36, fontWeight: 700,
              color: i === 0 ? C.gold : i === 1 ? '#b0b8c8' : i === 2 ? '#c87533' : C.muted }}>
              {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}
            </span>
            <span style={{ flex: 1, fontWeight: i === 0 ? 700 : 400 }}>{p.display_name}</span>
            <span style={{ width: 60, textAlign: 'center', fontWeight: 800, fontSize: '1.1em', color: C.accent2 }}>
              {p.pts}
            </span>
            <span style={{ width: 80, textAlign: 'center', color: '#64b5f6' }}>{p.exact}</span>
            <span style={{ width: 76, textAlign: 'center', color: '#ff8a80' }}>
              {p.penalties > 0 ? `−${p.penalties}` : '0'}
            </span>
          </div>
        ))}
      </div>
      <p style={{ color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 8 }}>
        Departajare: mai multe scoruri exacte. Egalitate perfectă → se împart banii.
      </p>
      <div style={{ ...s.card, marginTop: 4 }}>
        <h3 style={{ color: C.text, fontSize: 14, fontWeight: 700, margin: 0 }}>📖 Sistem de punctaj</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: C.muted }}>
          <div style={s.ruleRow}><span style={{ color: C.accent2, fontWeight: 700 }}>+3 pts</span> Scor exact</div>
          <div style={s.ruleRow}><span style={{ color: C.warn, fontWeight: 700 }}>+1 pt</span> Rezultat corect, scor diferit</div>
          <div style={s.ruleRow}><span style={{ color: C.accent, fontWeight: 700 }}>+1 pt</span> Per finalista ghicită · <span style={{ color: C.accent, fontWeight: 700 }}>+3 pts</span> ambele ghicite</div>
          <div style={s.ruleRow}><span style={{ color: C.danger, fontWeight: 700 }}>−1 pt</span> Meci nepariat (limita 30 min înainte)</div>
        </div>
      </div>
    </div>
  );
}

// ─── Profile Tab ──────────────────────────────────────────────────────────────
function ProfileTab({ currentUser, onChangePassword, onChangeName }) {
  const [newName, setNewName] = useState(currentUser?.display_name || '');
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confPwd, setConfPwd] = useState('');
  const [msg, setMsg] = useState(null);

  const handleName = async () => {
    const err = await onChangeName(newName);
    setMsg(err ? { type: 'err', text: err } : { type: 'ok', text: 'Nume actualizat!' });
  };

  const handlePwd = async () => {
    if (!oldPwd || !newPwd || !confPwd) return setMsg({ type: 'err', text: 'Completează toate câmpurile.' });
    if (newPwd !== confPwd) return setMsg({ type: 'err', text: 'Parolele noi nu coincid.' });
    if (newPwd.length < 6) return setMsg({ type: 'err', text: 'Parola trebuie să aibă minim 6 caractere.' });
    const err = await onChangePassword(oldPwd, newPwd);
    if (err) setMsg({ type: 'err', text: err });
    else { setMsg({ type: 'ok', text: 'Parolă schimbată!' }); setOldPwd(''); setNewPwd(''); setConfPwd(''); }
  };

  return (
    <div style={s.section}>
      <h2 style={s.sectionTitle}>👤 Profilul meu</h2>
      {msg && (
        <div style={{ ...s.alertBox,
          background: msg.type === 'ok' ? C.accent2 + '22' : C.danger + '22',
          borderColor: msg.type === 'ok' ? C.accent2 + '66' : C.danger + '66',
          color: msg.type === 'ok' ? C.accent2 : C.danger }}>
          {msg.text}
        </div>
      )}
      <div style={s.card}>
        <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>✏️ Schimbă numele afișat</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...s.input, flex: 1 }} value={newName}
            onChange={e => { setNewName(e.target.value); setMsg(null); }} />
          <button style={s.btnSm} onClick={handleName}>Salvează</button>
        </div>
        <p style={{ color: C.muted, fontSize: 12, margin: 0 }}>
          Username: <code style={{ color: C.accent }}>{currentUser?.username}</code>
        </p>
      </div>
      <div style={s.card}>
        <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>🔑 Schimbă parola</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[['Parola curentă', oldPwd, setOldPwd], ['Parola nouă (minim 6 caractere)', newPwd, setNewPwd],
            ['Confirmă parola nouă', confPwd, setConfPwd]].map(([label, val, setter]) => (
            <div key={label}>
              <label style={s.label}>{label}</label>
              <input style={s.input} type="password" value={val}
                onChange={e => { setter(e.target.value); setMsg(null); }} />
            </div>
          ))}
          <button style={s.btnPrimary} onClick={handlePwd}>Schimbă parola</button>
        </div>
      </div>
    </div>
  );
}

// ─── Admin Tab ────────────────────────────────────────────────────────────────
function AdminTab({ matches, results, setResult, actualFinals, setActualFinals,
  syncing, syncMsg, lastSync, onSync, profiles, allPredictions, unlockPrediction }) {
  const [subTab, setSubTab] = useState('results');

  return (
    <div style={s.section}>
      <h2 style={s.sectionTitle}>⚙️ Panou Admin</h2>
      <div style={s.filterRow}>
        {[{ id: 'results', label: '⚽ Rezultate' }, { id: 'users', label: '👥 Utilizatori' }]
          .map(t => (
            <button key={t.id} onClick={() => setSubTab(t.id)}
              style={{ ...s.filterBtn, ...(subTab === t.id ? s.filterBtnActive : {}) }}>
              {t.label}
            </button>
          ))}
      </div>
      {subTab === 'results' && (
        <AdminResults matches={matches} results={results} setResult={setResult}
          actualFinals={actualFinals} setActualFinals={setActualFinals}
          syncing={syncing} syncMsg={syncMsg} lastSync={lastSync} onSync={onSync} />
      )}
      {subTab === 'users' && (
        <AdminUsers profiles={profiles} allPredictions={allPredictions}
          unlockPrediction={unlockPrediction} />
      )}
    </div>
  );
}

function AdminResults({ matches, results, setResult, actualFinals, setActualFinals,
  syncing, syncMsg, lastSync, onSync }) {
  const [filter, setFilter] = useState('Grupe');
  const roundOrder = ['Grupe', '16-imi', 'Optimi', 'Sferturi', 'Semifinale', 'Finala Mică', 'FINALA'];
  const availableRounds = roundOrder.filter(r =>
    r === 'Grupe' ? matches.some(m => !!m.group) : matches.some(m => m.round === r)
  );
  const filtered = matches.filter(m =>
    filter === 'Grupe' ? !!m.group : m.round === filter
  );
  const allTeams = [...new Set(matches.flatMap(m => [m.home, m.away]))].sort();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SyncBar syncing={syncing} syncMsg={syncMsg} lastSync={lastSync} onSync={onSync} full />
      <FilterRow rounds={availableRounds} filter={filter} setFilter={setFilter} />
      <div style={s.matchList}>
        {filtered.map(m => (
          <div key={m.id} style={s.adminRow}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 11, color: C.muted }}>{fmtDate(m.date)} · {m.round}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>{m.home}</span>
                <input style={s.adminIn} type="number" min="0" max="30" placeholder="0"
                  value={results[m.id]?.home ?? ''}
                  onChange={e => setResult(m.id, 'home', e.target.value)} />
                <span style={{ color: C.muted, fontWeight: 700 }}>–</span>
                <input style={s.adminIn} type="number" min="0" max="30" placeholder="0"
                  value={results[m.id]?.away ?? ''}
                  onChange={e => setResult(m.id, 'away', e.target.value)} />
                <span style={{ fontWeight: 600, fontSize: 14, flex: 1, textAlign: 'right' }}>{m.away}</span>
              </div>
            </div>
            {results[m.id]?.home != null && results[m.id]?.away != null
              && results[m.id]?.home !== '' && <span style={{ fontSize: 16 }}>✅</span>}
          </div>
        ))}
      </div>
      <div style={s.card}>
        <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>🏆 Finaliste reale</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[0, 1].map(i => (
            <div key={i} style={{ flex: 1, minWidth: 160 }}>
              <label style={s.label}>Finalista {i + 1}</label>
              <select style={s.select} value={actualFinals[i] || ''}
                onChange={e => { const nf = [...actualFinals]; nf[i] = e.target.value; setActualFinals(nf); }}>
                <option value="">—</option>
                {allTeams.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AdminUsers({ profiles, allPredictions, unlockPrediction }) {
  const players = profiles.filter(p => !p.is_admin);
  const [showAdd, setShowAdd] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', name: '', password: '', isAdmin: false });
  const [msg, setMsg] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!newUser.username || !newUser.name || !newUser.password)
      return setMsg({ type: 'err', text: 'Completează toate câmpurile.' });
    if (newUser.password.length < 6)
      return setMsg({ type: 'err', text: 'Parola trebuie să aibă minim 6 caractere.' });
    setLoading(true);
    const { createUser } = await import('./adminApi.js');
    const result = await createUser(newUser.username, newUser.name, newUser.password, newUser.isAdmin);
    if (result.error) setMsg({ type: 'err', text: result.error });
    else {
      setMsg({ type: 'ok', text: `Utilizatorul "${newUser.name}" a fost creat!` });
      setNewUser({ username: '', name: '', password: '', isAdmin: false });
      setShowAdd(false);
      window.location.reload();
    }
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {msg && (
        <div style={{ ...s.alertBox,
          background: msg.type === 'ok' ? C.accent2 + '22' : C.danger + '22',
          borderColor: msg.type === 'ok' ? C.accent2 + '66' : C.danger + '66',
          color: msg.type === 'ok' ? C.accent2 : C.danger }}>
          {msg.text}
        </div>
      )}

      {players.map(u => {
        const lockedPreds = allPredictions.filter(p => p.user_id === u.id && p.locked);
        return (
          <div key={u.id} style={s.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{u.display_name}</div>
                <div style={{ color: C.muted, fontSize: 12 }}>@{u.username} · {lockedPreds.length} pariuri blocate</div>
              </div>
            </div>
            {lockedPreds.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <p style={{ color: C.muted, fontSize: 12, margin: 0 }}>Pariuri blocate:</p>
                {lockedPreds.slice(0, 5).map(p => (
                  <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 10px', background: C.surface, borderRadius: 8, fontSize: 13 }}>
                    <span style={{ flex: 1, color: C.muted }}>Meci #{p.match_id}</span>
                    <span style={{ fontWeight: 700 }}>{p.score_home} : {p.score_away}</span>
                    <button onClick={() => unlockPrediction(u.id, p.match_id)}
                      style={{ background: C.warn + '22', border: `1px solid ${C.warn}44`,
                        color: C.warn, borderRadius: 6, padding: '2px 8px',
                        fontSize: 11, cursor: 'pointer' }}>
                      🔓 Deblochează
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {showAdd ? (
        <div style={s.card}>
          <h3 style={{ color: C.text, fontSize: 15, fontWeight: 700, margin: 0 }}>➕ Jucător nou</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={s.label}>Username (doar litere mici, fără spații)</label>
              <input style={s.input} placeholder="ex: radu" value={newUser.username}
                onChange={e => setNewUser(n => ({ ...n, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') }))} />
            </div>
            <div>
              <label style={s.label}>Nume afișat</label>
              <input style={s.input} placeholder="ex: Radu" value={newUser.name}
                onChange={e => setNewUser(n => ({ ...n, name: e.target.value }))} />
            </div>
            <div>
              <label style={s.label}>Parolă (minim 6 caractere)</label>
              <input style={s.input} type="text" placeholder="ex: Radu2026!" value={newUser.password}
                onChange={e => setNewUser(n => ({ ...n, password: e.target.value }))} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.muted, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={newUser.isAdmin}
                onChange={e => setNewUser(n => ({ ...n, isAdmin: e.target.checked }))} />
              Este admin
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <button style={{ ...s.btnPrimary, opacity: loading ? 0.7 : 1 }}
                onClick={handleCreate} disabled={loading}>
                {loading ? 'Se creează...' : '✅ Creează'}
              </button>
              <button style={{ ...s.btnSm, background: C.surface }}
                onClick={() => { setShowAdd(false); setMsg(null); }}>
                Anulează
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button style={{ ...s.btnSm, alignSelf: 'flex-start', padding: '10px 20px', fontSize: 14 }}
          onClick={() => setShowAdd(true)}>
          ➕ Adaugă jucător nou
        </button>
      )}
    </div>
  );
}

// ─── Shared Components ────────────────────────────────────────────────────────
function SyncBar({ syncing, syncMsg, lastSync, onSync, full }) {
  return (
    <div style={s.syncBar}>
      <div style={{ flex: 1 }}>
        <p style={{ color: C.muted, fontSize: 13, margin: 0 }}>
          Rezultate automate din{' '}
          <a href="https://github.com/openfootball/worldcup.json" target="_blank"
            rel="noopener noreferrer" style={{ color: C.accent }}>openfootball</a>.
          {full && ' Poți corecta manual mai jos.'}
        </p>
        {lastSync && (
          <p style={{ color: C.muted, fontSize: 11, margin: '2px 0 0' }}>
            Ultima sincronizare: {new Date(lastSync).toLocaleString('ro-RO')}
          </p>
        )}
      </div>
      <button style={s.btnSync} onClick={onSync} disabled={syncing}>
        {syncing ? '⏳ Sincronizez...' : '🔄 Actualizează'}
      </button>
      {syncMsg && (
        <span style={{ fontSize: 12, color: syncMsg.startsWith('✅') ? C.accent2 : C.danger }}>
          {syncMsg}
        </span>
      )}
    </div>
  );
}

function FilterRow({ rounds, filter, setFilter }) {
  return (
    <div style={s.filterRow}>
      {rounds.map(r => (
        <button key={r} onClick={() => setFilter(r)}
          style={{ ...s.filterBtn, ...(filter === r ? s.filterBtnActive : {}) }}>
          {r}
        </button>
      ))}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const s = {
  root: { background: C.bg, minHeight: '100vh', fontFamily: "'Exo 2','Segoe UI',sans-serif", color: C.text },
  main: { maxWidth: 920, margin: '0 auto', padding: '20px 16px 80px' },
  loginBg: { background: `radial-gradient(ellipse at 50% 0%, #0d2040 0%, ${C.bg} 70%)`,
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  loginCard: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 20,
    padding: '40px 32px', width: '100%', maxWidth: 380, display: 'flex', flexDirection: 'column', gap: 16,
    boxShadow: '0 24px 64px rgba(0,0,0,0.6)' },
  loginTitle: { fontSize: 34, fontWeight: 900, textAlign: 'center', margin: 0,
    background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' },
  header: { background: C.surface + 'ee', borderBottom: `1px solid ${C.border}`,
    position: 'sticky', top: 0, zIndex: 100, backdropFilter: 'blur(12px)' },
  headerInner: { maxWidth: 920, margin: '0 auto', padding: '0 16px',
    display: 'flex', alignItems: 'center', gap: 10, height: 56, flexWrap: 'wrap' },
  logo: { fontWeight: 900, fontSize: 16, background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', whiteSpace: 'nowrap' },
  nav: { display: 'flex', gap: 2, flex: 1, flexWrap: 'wrap' },
  navBtn: { background: 'none', border: 'none', color: C.muted, cursor: 'pointer',
    padding: '5px 10px', borderRadius: 8, fontSize: 13, fontWeight: 500 },
  navActive: { background: `${C.accent}20`, color: C.accent, fontWeight: 700 },
  btnLogout: { background: 'none', border: `1px solid ${C.border}`, color: C.muted,
    cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontSize: 12 },
  section: { display: 'flex', flexDirection: 'column', gap: 14 },
  sectionTitle: { fontSize: 22, fontWeight: 900, margin: '0 0 4px',
    background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
    WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' },
  card: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14,
    padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 },
  syncBar: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  btnSync: { background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
    border: 'none', borderRadius: 8, color: C.bg, padding: '8px 16px',
    fontSize: 13, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' },
  emptyBox: { background: `${C.accent}11`, border: `1px dashed ${C.accent}55`, borderRadius: 12,
    padding: '20px', textAlign: 'center', color: C.muted, fontSize: 14 },
  filterRow: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  filterBtn: { background: C.card, border: `1px solid ${C.border}`, color: C.muted,
    cursor: 'pointer', padding: '5px 12px', borderRadius: 20, fontSize: 12, fontWeight: 500 },
  filterBtnActive: { background: `${C.accent}20`, borderColor: C.accent, color: C.accent, fontWeight: 700 },
  matchList: { display: 'flex', flexDirection: 'column', gap: 8 },
  matchCard: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
    padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, transition: 'border-color .3s' },
  matchMeta: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  roundBadge: { background: `${C.accent}20`, color: C.accent, fontSize: 10,
    fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', whiteSpace: 'nowrap' },
  matchRow: { display: 'flex', alignItems: 'center', gap: 10 },
  team: { flex: 1, fontWeight: 600, fontSize: 14 },
  scoreBox: { display: 'flex', alignItems: 'center', gap: 5 },
  scoreIn: { width: 42, textAlign: 'center', background: C.surface, border: `1px solid ${C.accent}44`,
    borderRadius: 7, color: C.text, padding: '5px 3px', fontSize: 18, fontWeight: 700, outline: 'none' },
  scoreStatic: { width: 42, textAlign: 'center', background: C.surface, borderRadius: 7,
    padding: '5px 3px', fontSize: 18, fontWeight: 700, color: C.muted },
  colon: { color: C.muted, fontWeight: 700, fontSize: 16 },
  resultRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: 6, paddingTop: 8, borderTop: `1px solid ${C.border}` },
  badge: { fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 10 },
  alertBox: { background: '#ffc83222', border: '1px solid #ffc83266', borderRadius: 10,
    padding: '10px 14px', color: C.warn, fontSize: 13, fontWeight: 600 },
  finSlot: { flex: 1, minWidth: 130, background: C.surface, border: `2px solid ${C.accent}33`,
    borderRadius: 12, padding: '14px', display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: 6, position: 'relative' },
  clearBtn: { position: 'absolute', top: 6, right: 8, background: 'none', border: 'none',
    color: C.danger, cursor: 'pointer', fontSize: 14, fontWeight: 700 },
  teamGrid: { display: 'flex', flexWrap: 'wrap', gap: 6, maxHeight: 260, overflowY: 'auto' },
  teamBtn: { background: C.surface, border: `1px solid ${C.border}`, color: C.text,
    cursor: 'pointer', padding: '5px 10px', borderRadius: 7, fontSize: 12 },
  teamBtnOn: { background: `${C.accent}25`, borderColor: C.accent, color: C.accent, fontWeight: 700 },
  table: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, overflow: 'hidden' },
  tableHead: { display: 'flex', padding: '10px 18px', background: C.surface,
    color: C.muted, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', gap: 6 },
  tableRow: { display: 'flex', padding: '13px 18px', borderTop: `1px solid ${C.border}`,
    alignItems: 'center', gap: 6 },
  ruleRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
    borderBottom: `1px solid ${C.border}` },
  adminRow: { background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
    padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 },
  adminIn: { width: 46, textAlign: 'center', background: C.surface, border: `1px solid ${C.accent}44`,
    borderRadius: 7, color: C.text, padding: '5px 3px', fontSize: 17, fontWeight: 700, outline: 'none' },
  label: { display: 'block', color: C.muted, fontSize: 12, marginBottom: 5, fontWeight: 600 },
  select: { background: C.surface, border: `1px solid ${C.border}`, color: C.text,
    borderRadius: 8, padding: '8px 10px', fontSize: 13, width: '100%' },
  input: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 9,
    color: C.text, padding: '10px 13px', fontSize: 14, outline: 'none',
    width: '100%', boxSizing: 'border-box' },
  btnPrimary: { background: `linear-gradient(90deg,${C.accent},${C.accent2})`,
    border: 'none', borderRadius: 9, color: C.bg, padding: '12px', fontSize: 15,
    fontWeight: 800, cursor: 'pointer', width: '100%' },
  btnSm: { background: `${C.accent}20`, border: `1px solid ${C.accent}44`, color: C.accent,
    borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' },
};
