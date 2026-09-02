// ────────────────────────────────────────────────────────────
// 단어장 앱 - 전체 로직
// ────────────────────────────────────────────────────────────

const app = document.getElementById('app');
const TEST_LIMIT = 30;

const state = {
  screen: 'loading',      // loading | home | study | study-done | test | result
  level: 'middle',        // middle | high
  round: 1,
  words: { middle: [], high: [] },
  progress: new Map(),    // word_id -> {status, wrong_count, last_reviewed_at}
  syncCode: null,
  cloudReady: false,
  settingsOpen: false,
  study: null,
  test: null,
  resumePrompt: null,     // {type, level, round, mode, saved}
};

// ── 동기화 코드 ──────────────────────────────────────────────
function getOrCreateSyncCode() {
  let code = localStorage.getItem('flashcard_sync_code');
  if (!code) {
    code = randomCode();
    localStorage.setItem('flashcard_sync_code', code);
  }
  return code;
}
function randomCode() {
  const s = () => Math.random().toString(36).slice(2, 6);
  return `${s()}-${s()}`;
}

// ── Supabase 여부 ────────────────────────────────────────────
function isSupabaseConfigured() {
  return (
    typeof SUPABASE_URL === 'string' &&
    typeof SUPABASE_ANON_KEY === 'string' &&
    SUPABASE_URL.startsWith('http') &&
    SUPABASE_ANON_KEY.length > 10
  );
}

async function fetchCloudProgress(syncCode) {
  const url = `${SUPABASE_URL}/rest/v1/progress?sync_code=eq.${encodeURIComponent(syncCode)}&select=word_id,status,wrong_count,last_reviewed_at`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) throw new Error('fetch failed');
  return res.json();
}

async function pushCloudProgress(record) {
  const url = `${SUPABASE_URL}/rest/v1/progress?on_conflict=sync_code,word_id`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify([record]),
  });
  if (!res.ok) throw new Error('push failed');
}

// ── 로컬 캐시 (진행 상황: 안다/모른다) ─────────────────────────
function localCacheKey() {
  return `progress_cache_${state.syncCode}`;
}
function persistLocalCache() {
  const obj = {};
  state.progress.forEach((v, k) => (obj[k] = v));
  localStorage.setItem(localCacheKey(), JSON.stringify(obj));
}
function loadLocalCache() {
  const raw = localStorage.getItem(localCacheKey());
  if (!raw) return;
  const obj = JSON.parse(raw);
  Object.entries(obj).forEach(([k, v]) => state.progress.set(k, v));
}

// ── 진행 상황 갱신 ───────────────────────────────────────────
function updateProgress(wordId, isKnown) {
  const existing = state.progress.get(wordId) || { status: 'new', wrong_count: 0 };
  const record = {
    status: isKnown ? 'known' : 'unknown',
    wrong_count: isKnown ? existing.wrong_count || 0 : (existing.wrong_count || 0) + 1,
    last_reviewed_at: new Date().toISOString(),
  };
  state.progress.set(wordId, record);
  persistLocalCache();

  if (state.cloudReady) {
    pushCloudProgress({
      sync_code: state.syncCode,
      word_id: wordId,
      status: record.status,
      wrong_count: record.wrong_count,
      last_reviewed_at: record.last_reviewed_at,
      updated_at: new Date().toISOString(),
    }).catch(() => { state.cloudReady = false; });
  }
}

// ── 세션 저장 (학습/테스트 진행 중이던 위치) ───────────────────
function sessionKey(type, level, round, mode) {
  return `session_${type}_${level}_${round}_${mode || 'x'}`;
}
function saveSession() {
  if (state.screen === 'study' && state.study) {
    const s = state.study;
    const key = sessionKey('study', state.level, state.round);
    localStorage.setItem(key, JSON.stringify({
      queueIds: s.queue.map((w) => w.id),
      index: s.index,
    }));
  } else if (state.screen === 'test' && state.test && !state.test.empty) {
    const t = state.test;
    const key = sessionKey('test', t.level, t.round, t.mode);
    localStorage.setItem(key, JSON.stringify({
      items: t.queue.map((q) => ({ id: q.word.id, direction: q.direction })),
      index: t.index,
      correct: t.correct,
      wrong: t.wrong,
    }));
  }
}
function clearSession(type, level, round, mode) {
  localStorage.removeItem(sessionKey(type, level, round, mode));
}
function loadSession(type, level, round, mode) {
  const raw = localStorage.getItem(sessionKey(type, level, round, mode));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

// ── 초기화 ───────────────────────────────────────────────────
async function init() {
  state.syncCode = getOrCreateSyncCode();
  render();

  const [middle, high] = await Promise.all([
    fetch('words-middle.json').then((r) => r.json()),
    fetch('words-high.json').then((r) => r.json()),
  ]);
  state.words.middle = middle;
  state.words.high = high;
  state.round = getRounds('middle')[0] || 1;

  loadLocalCache();

  if (isSupabaseConfigured()) {
    try {
      const rows = await fetchCloudProgress(state.syncCode);
      rows.forEach((row) => {
        state.progress.set(row.word_id, {
          status: row.status,
          wrong_count: row.wrong_count,
          last_reviewed_at: row.last_reviewed_at,
        });
      });
      state.cloudReady = true;
      persistLocalCache();
    } catch (e) {
      state.cloudReady = false;
    }
  }

  state.screen = 'home';
  render();
}

// ── 유틸 ─────────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function normalize(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}
function meaningMatches(input, meaning) {
  const inputNorm = normalize(input);
  if (!inputNorm) return false;
  const meaningParts = meaning.split(/[,\/]/).map((p) => normalize(p)).filter(Boolean);
  if (inputNorm === normalize(meaning)) return true;
  if (meaningParts.includes(inputNorm)) return true;
  const joinedSpace = meaningParts.join(' ');
  if (inputNorm === joinedSpace) return true;
  const allSingleToken = meaningParts.every((p) => !p.includes(' '));
  if (allSingleToken) {
    const inputTokens = inputNorm.split(/\s+/).filter(Boolean);
    if (inputTokens.length > 0 && inputTokens.every((t) => meaningParts.includes(t))) {
      return true;
    }
  }
  return false;
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}
function getRounds(level) {
  return [...new Set(state.words[level].map((w) => w.round))].sort((a, b) => b - a);
}
function wordsFor(level, round) {
  return state.words[level].filter((w) => w.round === round);
}
function unknownCount(level, round) {
  return wordsFor(level, round).filter((w) => (state.progress.get(w.id) || {}).status === 'unknown').length;
}
function roundIsVerb3(level, round) {
  const words = wordsFor(level, round);
  return words.length > 0 && words.every((w) => w.type === 'verb3');
}
function findWord(level, id) {
  return state.words[level].find((w) => w.id === id);
}

// ── 화면 전환 ────────────────────────────────────────────────
function setLevel(level) {
  state.level = level;
  const rounds = getRounds(level);
  if (!rounds.includes(state.round)) state.round = rounds[0] || 1;
  render();
}
function setRound(round) {
  state.round = round;
  render();
}
function goHome() {
  saveSession();
  state.screen = 'home';
  state.study = null;
  state.test = null;
  render();
}
function toggleSettings(open) {
  state.settingsOpen = open;
  render();
}

// ═══════════════════════════════════════════════════════════
// 학습모드
// ═══════════════════════════════════════════════════════════
function startStudy(level, round) {
  const saved = loadSession('study', level, round);
  if (saved && saved.index < saved.queueIds.length) {
    state.resumePrompt = { type: 'study', level, round, mode: null, saved };
    render();
    return;
  }
  beginStudy(level, round, null);
}
function beginStudy(level, round, resumeData) {
  state.resumePrompt = null;
  let queue;
  let startIndex = 0;
  if (resumeData) {
    queue = resumeData.queueIds.map((id) => findWord(level, id)).filter(Boolean);
    startIndex = resumeData.index;
  } else {
    const words = wordsFor(level, round);
    const shouldShuffle = !(level === 'middle' && round >= 2);
    queue = shouldShuffle ? shuffle(words) : words.slice();
  }
  if (queue.length === 0) return;
  state.level = level;
  state.round = round;
  state.study = {
    queue,
    index: startIndex,
    flipped: false,
    direction: Math.random() < 0.5 ? 'word' : 'meaning',
  };
  state.screen = 'study';
  render();
}
function flipCard() {
  state.study.flipped = true;
  render();
}
function studyMark(isKnown) {
  const w = state.study.queue[state.study.index];
  updateProgress(w.id, isKnown);
  studyAdvance();
}
function studyAdvance() {
  state.study.index++;
  saveSession();
  if (state.study.index >= state.study.queue.length) {
    clearSession('study', state.level, state.round);
    state.screen = 'study-done';
  } else {
    state.study.flipped = false;
    state.study.direction = Math.random() < 0.5 ? 'word' : 'meaning';
  }
  render();
}
function studySkip() {
  studyAdvance();
}

// ═══════════════════════════════════════════════════════════
// 테스트모드 (전체 / 모르는것) - 최대 30문제
// ═══════════════════════════════════════════════════════════
function startTest(level, round, mode) {
  const saved = loadSession('test', level, round, mode);
  if (saved && saved.index < saved.items.length) {
    state.resumePrompt = { type: 'test', level, round, mode, saved };
    render();
    return;
  }
  beginTest(level, round, mode, null);
}
function beginTest(level, round, mode, resumeData) {
  state.resumePrompt = null;
  state.level = level;
  state.round = round;

  let queue;
  if (resumeData) {
    queue = resumeData.items
      .map((it) => ({ word: findWord(level, it.id), direction: it.direction }))
      .filter((q) => q.word);
  } else {
    let pool = wordsFor(level, round);
    if (mode === 'unknown') {
      pool = pool.filter((w) => (state.progress.get(w.id) || {}).status === 'unknown');
    }
    if (pool.length === 0) {
      state.test = { level, round, mode, queue: [], index: 0, correct: 0, wrong: 0, empty: true };
      state.screen = 'test';
      render();
      return;
    }
    queue = shuffle(pool)
      .slice(0, TEST_LIMIT)
      .map((w) => ({ word: w, direction: Math.random() < 0.5 ? 'w2m' : 'm2w' }));
  }

  state.test = {
    level, round, mode, queue,
    index: resumeData ? resumeData.index : 0,
    correct: resumeData ? resumeData.correct : 0,
    wrong: resumeData ? resumeData.wrong : 0,
    answered: false,
    lastCorrect: null,
    fieldResult: {},
    empty: false,
  };
  state.screen = 'test';
  render();
}

function checkAnswer() {
  const t = state.test;
  const q = t.queue[t.index];
  const w = q.word;
  let isCorrect = false;
  const fieldResult = {};

  if (w.type === 'verb3') {
    const pres = normalize(document.getElementById('in-present')?.value);
    const past = normalize(document.getElementById('in-past')?.value);
    const pp = normalize(document.getElementById('in-pp')?.value);
    fieldResult.present = pres === normalize(w.present);
    fieldResult.past = past === normalize(w.past);
    fieldResult.pp = pp === normalize(w.pastParticiple);
    isCorrect = fieldResult.present && fieldResult.past && fieldResult.pp;
  } else {
    const rawVal = document.getElementById('in-answer')?.value || '';
    if (q.direction === 'w2m') {
      isCorrect = meaningMatches(rawVal, w.meaning);
    } else {
      isCorrect = normalize(rawVal) === normalize(w.word);
    }
  }

  t.answered = true;
  t.lastCorrect = isCorrect;
  t.fieldResult = fieldResult;
  if (isCorrect) t.correct++;
  else t.wrong++;

  updateProgress(w.id, isCorrect);
  saveSession();
  render();
}

function nextQuestion() {
  const t = state.test;
  t.index++;
  t.answered = false;
  t.fieldResult = {};
  saveSession();
  if (t.index >= t.queue.length) {
    clearSession('test', t.level, t.round, t.mode);
    state.screen = 'result';
  }
  render();
}

// ── 이어서하기 / 새로하기 ────────────────────────────────────
function resumeChoice(action) {
  const p = state.resumePrompt;
  if (!p) return;
  if (action === 'resume') {
    if (p.type === 'study') beginStudy(p.level, p.round, p.saved);
    else beginTest(p.level, p.round, p.mode, p.saved);
  } else {
    clearSession(p.type, p.level, p.round, p.mode);
    if (p.type === 'study') beginStudy(p.level, p.round, null);
    else beginTest(p.level, p.round, p.mode, null);
  }
}

// ── 설정: 동기화 코드 변경 ───────────────────────────────────
async function applySyncCode(newCode) {
  newCode = newCode.trim();
  if (!newCode) return;
  state.syncCode = newCode;
  localStorage.setItem('flashcard_sync_code', newCode);
  state.progress.clear();
  loadLocalCache();
  if (isSupabaseConfigured()) {
    try {
      const rows = await fetchCloudProgress(newCode);
      rows.forEach((row) => {
        state.progress.set(row.word_id, {
          status: row.status,
          wrong_count: row.wrong_count,
          last_reviewed_at: row.last_reviewed_at,
        });
      });
      state.cloudReady = true;
    } catch (e) {
      state.cloudReady = false;
    }
  }
  state.settingsOpen = false;
  render();
}
function copySyncCode() {
  navigator.clipboard?.writeText(state.syncCode);
}

// ═══════════════════════════════════════════════════════════
// 렌더링
// ═══════════════════════════════════════════════════════════
function render() {
  if (state.screen === 'loading') {
    app.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    return;
  }

  const topbar = `
    <div class="topbar">
      <div class="brand">단어장</div>
      <button class="settings-btn" onclick="toggleSettings(true)">⚙️</button>
    </div>
    <div class="level-tabs">
      <button class="level-tab ${state.level === 'middle' ? 'active' : ''}" onclick="setLevel('middle')">중등영어</button>
      <button class="level-tab ${state.level === 'high' ? 'active' : ''}" onclick="setLevel('high')">고등영어</button>
    </div>
    ${state.screen === 'home' ? renderRoundTabs() : ''}
  `;

  let body = '';
  if (state.screen === 'home') body = renderHome();
  else if (state.screen === 'study') body = renderStudy();
  else if (state.screen === 'study-done') body = renderStudyDone();
  else if (state.screen === 'test') body = renderTest();
  else if (state.screen === 'result') body = renderResult();

  app.innerHTML = topbar + body
    + (state.settingsOpen ? renderSettingsSheet() : '')
    + (state.resumePrompt ? renderResumeSheet() : '');

  if (state.screen === 'study') attachSwipeHandlers();
}

function renderRoundTabs() {
  const rounds = getRounds(state.level);
  if (rounds.length <= 1) return '';
  return `
    <div class="round-tabs">
      ${rounds.map((r) => `
        <button class="round-tab ${r === state.round ? 'active' : ''}" onclick="setRound(${r})">${r}회</button>
      `).join('')}
    </div>
  `;
}

function renderHome() {
  const level = state.level;
  const round = state.round;
  const total = wordsFor(level, round).length;
  const unknown = unknownCount(level, round);
  const isVerb3Round = roundIsVerb3(level, round);
  const levelName = level === 'middle' ? '중등영어' : '고등영어';
  const formatDesc = isVerb3Round ? '현재형/과거형/과거분사' : '단어와 뜻';
  return `
    <div class="screen">
      <div class="section-label">${state.round}회 · ${levelName} · ${formatDesc}</div>
      <div class="mode-list">
        <button class="mode-card" onclick="startStudy('${level}',${round})">
          <div class="title">📖 학습모드</div>
          <div class="desc">카드를 넘기며 외우고, 모르는 단어를 체크해요</div>
          <div class="count">${round}회 전체 ${total}개</div>
        </button>
        <button class="mode-card" onclick="startTest('${level}',${round},'all')">
          <div class="title">✍️ 전체테스트모드</div>
          <div class="desc">직접 타이핑해서 테스트해요 (최대 ${TEST_LIMIT}문제)</div>
          <div class="count">${round}회 전체 ${total}개</div>
        </button>
        <button class="mode-card" onclick="startTest('${level}',${round},'unknown')">
          <div class="title">🎯 모르는것테스트모드</div>
          <div class="desc">체크한 단어만 집중 테스트해요 (최대 ${TEST_LIMIT}문제)</div>
          <div class="count">모르는 단어 ${unknown}개</div>
        </button>
      </div>
    </div>
  `;
}

function renderInSessionHeader(index, totalLen, extra) {
  const pct = Math.round((index / totalLen) * 100);
  return `
    <div class="session-header">
      <button class="home-btn" onclick="goHome()">← 그만하기</button>
      <div class="section-label">${index + 1} / ${totalLen}${extra ? ' · ' + extra : ''}</div>
    </div>
    <div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
  `;
}

function renderStudy() {
  const s = state.study;
  const w = s.queue[s.index];
  const isVerb3 = w.type === 'verb3';

  let front, speakText;
  if (s.direction === 'word') {
    front = isVerb3 ? w.present : w.word;
    speakText = front;
  } else {
    front = w.meaning;
    speakText = isVerb3 ? `${w.present}, ${w.past}, ${w.pastParticiple}` : w.word;
  }

  let answerBlock = '';
  if (s.flipped) {
    if (isVerb3) {
      answerBlock = `
        <div class="answer-block">
          <div class="forms-row">
            <div><span class="form-tag">현재형</span>${w.present}</div>
            <div><span class="form-tag">과거형</span>${w.past}</div>
            <div><span class="form-tag">과거분사</span>${w.pastParticiple}</div>
          </div>
          ${s.direction === 'word' ? `<div class="front-meaning" style="font-size:20px">${w.meaning}</div>` : ''}
        </div>
      `;
    } else {
      answerBlock = `
        <div class="answer-block">
          ${s.direction === 'word'
            ? `<div class="front-meaning" style="font-size:20px">${w.meaning}</div>`
            : `<div class="front-word" style="font-size:24px">${w.word}</div>`}
        </div>
      `;
    }
  }

  return `
    <div class="screen">
      ${renderInSessionHeader(s.index, s.queue.length)}
      <div class="card-stage">
        <div class="flashcard" onclick="${s.flipped ? '' : 'flipCard()'}">
          <div class="eyebrow">${s.direction === 'word' ? '이 단어의 뜻은?' : '이 뜻의 영어 단어는?'}</div>
          ${s.direction === 'word'
            ? `<div class="front-word">${front}</div>`
            : `<div class="front-meaning">${front}</div>`}
          <button class="speak-btn" onclick="event.stopPropagation(); speak('${speakText.replace(/'/g, "\\'")}')">🔊</button>
          ${!s.flipped ? `<div class="tap-hint">탭해서 답 확인</div>` : answerBlock}
        </div>
      </div>
      ${s.flipped
        ? `<div class="know-btns">
             <button class="btn-unknown" onclick="studyMark(false)">✗ 모른다</button>
             <button class="btn-known" onclick="studyMark(true)">✓ 안다</button>
           </div>`
        : `<div class="nav-row"><button onclick="studySkip()">건너뛰기</button></div>`}
    </div>
  `;
}

function renderStudyDone() {
  return `
    <div class="screen">
      <div class="result-hero">
        <div class="big-num">완료!</div>
        <div class="label">이번 학습에서 모른다고 체크한 단어는<br>모르는것테스트모드에서 다시 볼 수 있어요</div>
      </div>
      <button class="primary-btn" onclick="goHome()">홈으로</button>
    </div>
  `;
}

function renderTest() {
  const t = state.test;
  if (t.empty) {
    return `
      <div class="screen">
        <div class="empty-state">${t.mode === 'unknown' ? '모르는 단어가 없어요! 학습모드에서 먼저 체크해보세요.' : '단어가 없어요.'}</div>
        <button class="secondary-btn" onclick="goHome()">홈으로</button>
      </div>
    `;
  }

  const q = t.queue[t.index];
  const w = q.word;
  const isVerb3 = w.type === 'verb3';

  let promptHtml, fieldsHtml, feedbackHtml = '';

  if (isVerb3) {
    promptHtml = `<div class="prompt-text">${w.meaning}</div><div class="section-label">현재형 · 과거형 · 과거분사를 입력하세요</div>`;
    const fr = t.fieldResult || {};
    fieldsHtml = `
      <div class="answer-fields">
        <div class="answer-field ${t.answered ? (fr.present ? 'correct' : 'wrong') : ''}">
          <label>현재형</label>
          <input id="in-present" type="text" autocomplete="off" autocapitalize="off" ${t.answered ? 'disabled' : ''} value="${t.answered ? w.present : ''}">
        </div>
        <div class="answer-field ${t.answered ? (fr.past ? 'correct' : 'wrong') : ''}">
          <label>과거형</label>
          <input id="in-past" type="text" autocomplete="off" autocapitalize="off" ${t.answered ? 'disabled' : ''} value="${t.answered ? w.past : ''}">
        </div>
        <div class="answer-field ${t.answered ? (fr.pp ? 'correct' : 'wrong') : ''}">
          <label>과거분사</label>
          <input id="in-pp" type="text" autocomplete="off" autocapitalize="off" ${t.answered ? 'disabled' : ''} value="${t.answered ? w.pastParticiple : ''}">
        </div>
      </div>
    `;
  } else {
    const showWord = q.direction === 'w2m';
    promptHtml = `
      <div class="section-label">${showWord ? '이 단어의 뜻을 입력하세요' : '이 뜻의 영어 단어를 입력하세요'}</div>
      <div class="${showWord ? 'prompt-word' : 'prompt-text'}">${showWord ? w.word : w.meaning}</div>
    `;
    fieldsHtml = `
      <div class="answer-fields">
        <div class="answer-field ${t.answered ? (t.lastCorrect ? 'correct' : 'wrong') : ''}">
          <input id="in-answer" type="text" autocomplete="off" autocapitalize="off" ${t.answered ? 'disabled' : ''} value="${t.answered && !t.lastCorrect ? (showWord ? w.meaning : w.word) : ''}">
        </div>
      </div>
    `;
  }

  if (t.answered) {
    feedbackHtml = `
      <div class="feedback-box ${t.lastCorrect ? 'correct' : 'wrong'}">
        ${t.lastCorrect ? '정답이에요! 👍' : '아쉬워요, 정답을 확인하세요.'}
      </div>
    `;
  }

  return `
    <div class="screen">
      ${renderInSessionHeader(t.index, t.queue.length, `맞음 ${t.correct} · 틀림 ${t.wrong}`)}
      <div class="test-prompt">${promptHtml}</div>
      ${fieldsHtml}
      ${feedbackHtml}
      ${t.answered
        ? `<button class="primary-btn" onclick="nextQuestion()">다음 문제</button>`
        : `<button class="primary-btn" onclick="checkAnswer()">확인</button>`}
    </div>
  `;
}

function renderResult() {
  const t = state.test;
  const total = t.queue.length;
  return `
    <div class="screen">
      <div class="result-hero">
        <div class="big-num">${t.correct} / ${total}</div>
        <div class="label">맞음 ${t.correct}개 · 틀림 ${t.wrong}개</div>
      </div>
      <button class="secondary-btn" onclick="startTest('${t.level}',${t.round},'${t.mode}')">다시 풀기</button>
      <button class="primary-btn" onclick="goHome()">홈으로</button>
    </div>
  `;
}

function renderSettingsSheet() {
  return `
    <div class="sheet-backdrop" onclick="if(event.target===this) toggleSettings(false)">
      <div class="sheet">
        <h3>설정</h3>
        <div class="section-label">내 동기화 코드</div>
        <div class="sync-code-box">${state.syncCode}</div>
        <button class="secondary-btn" onclick="copySyncCode()">코드 복사</button>
        <div class="status-line ${state.cloudReady ? '' : 'warn'}">
          ${isSupabaseConfigured()
            ? (state.cloudReady ? '☁️ 클라우드 동기화 연결됨' : '⚠ 클라우드 연결 실패 - 이 기기에만 저장 중')
            : '⚠ Supabase 미설정 - 이 기기에만 저장됩니다'}
        </div>
        <div class="section-label" style="margin-top:10px">다른 기기의 코드로 불러오기</div>
        <input type="text" id="sync-code-input" placeholder="예: a3f9-2b7c">
        <button class="primary-btn" onclick="applySyncCode(document.getElementById('sync-code-input').value)">이 코드로 불러오기</button>
        <button class="secondary-btn" onclick="toggleSettings(false)">닫기</button>
      </div>
    </div>
  `;
}

function renderResumeSheet() {
  const p = state.resumePrompt;
  const doneCount = p.saved.index;
  const totalCount = p.type === 'study' ? p.saved.queueIds.length : p.saved.items.length;
  return `
    <div class="sheet-backdrop">
      <div class="sheet">
        <h3>이어서 할까요?</h3>
        <div class="status-line">저번에 ${doneCount} / ${totalCount}개까지 진행했어요.</div>
        <button class="primary-btn" onclick="resumeChoice('resume')">이어서하기</button>
        <button class="secondary-btn" onclick="resumeChoice('new')">새로하기</button>
      </div>
    </div>
  `;
}

// ── 스와이프 (학습모드 카드 넘기기) ───────────────────────────
function attachSwipeHandlers() {
  const stage = document.querySelector('.card-stage');
  if (!stage) return;
  let startX = 0;
  stage.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 60 && state.study.flipped) {
      studySkip();
    }
  }, { passive: true });
}

init();
