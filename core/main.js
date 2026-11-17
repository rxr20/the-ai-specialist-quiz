(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const QUESTIONS_PER_TEST = 50;
  const TEST_MS = 30 * 60 * 1000;   // overall countdown
  const FIRST_LIMIT = 120;          // seconds for the first round of questions
  const LAST_LIMIT = 25;            // seconds for the last round
  const ROUNDS = 10;                // ladder rungs, each rung shares one time limit
  const PASS_PERCENT = 70;
  const DEFAULT_SETTINGS = { name: 'Player', sound: true };
  const LIVES_PER_TEST = 5;         // fixed, not adjustable in settings
  const KEYS = ['A', 'B', 'C', 'D'];
  const SCREENS = ['splash', 'menu', 'game', 'result', 'record', 'settings'];

  const state = {
    bank: [],
    active: [],
    index: 0,
    score: 0,
    correct: 0,
    answered: 0,
    lives: 0,
    maxLives: 0,
    debug: false,
    qStart: 0,
    testEnd: 0,
    raf: 0,
    advanceTimer: 0,
    running: false,
    locked: false
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const pad6 = (n) => String(n).padStart(6, '0');
  const fmtClock = (ms) => {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  };

  // ---------- Storage (browser only, safe if blocked) ----------

  function storeGet(key, fallback) {
    try {
      const raw = localStorage.getItem('tasq26.' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      localStorage.setItem('tasq26.' + key, JSON.stringify(value));
    } catch (err) {
      // Storage unavailable (private mode or blocked); the game still runs.
    }
  }

  function loadSettings() {
    return { ...DEFAULT_SETTINGS, ...storeGet('settings', {}) };
  }

  function saveSettings(next) {
    storeSet('settings', next);
  }

  function loadRecords() {
    const list = storeGet('records', []);
    return Array.isArray(list) ? list : [];
  }

  // ---------- Question bank (built into the page) ----------

  // Minimal CSV parser: quoted fields, escaped quotes, CRLF or LF line endings.
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((f) => f.trim() !== '')) rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
    return rows;
  }

  // Header row first: question,correct,wrong1..wrong4.
  function toQuestions(rows) {
    return rows.slice(1)
      .map((r) => ({
        question: (r[0] || '').trim(),
        correct: (r[1] || '').trim(),
        wrong: r.slice(2, 6).map((w) => w.trim()).filter(Boolean)
      }))
      .filter((q) => q.question && q.correct);
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function loadBank() {
    state.bank = window.DEFAULT_QUIZ_CSV ? toQuestions(parseCSV(window.DEFAULT_QUIZ_CSV)) : [];
  }

  // ---------- Screens ----------

  function show(name) {
    $('presenter').hidden = name !== 'game' && name !== 'result';
    SCREENS.forEach((s) => {
      const el = $(s);
      el.classList.toggle('hidden', s !== name);
      if (s === name) {
        el.style.animation = 'none';
        void el.offsetWidth; // restart the entrance animation
        el.style.animation = '';
      }
    });
    if (name === 'menu') renderMenu();
    if (name === 'record') renderRecords();
    if (name === 'settings') renderSettings();
  }

  function renderMenu() {
    const settings = loadSettings();
    $('menu-player').textContent = 'Player: ' + settings.name;
    $('menu-note').textContent = state.bank.length + ' questions in the bank  ·  '
      + QUESTIONS_PER_TEST + ' per test  ·  30 minutes  ·  25 to 120 seconds per question'
      + (isDebug() ? '  ·  DEBUG: 1 question' : '');
  }

  function isDebug() {
    return location.hash === '#debug';
  }

  // Splash: any key or tap moves on to the menu.
  $('splash').addEventListener('click', () => show('menu'));

  document.querySelectorAll('[data-go]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.go;
      if (target === 'play') startTest();
      else show(target);
    });
  });

  // ---------- Settings & records screens ----------

  function renderSettings() {
    const s = loadSettings();
    $('set-name').value = s.name;
    $('set-sound').checked = !!s.sound;
    $('set-status').textContent = '';
  }

  function readSettingsForm() {
    const name = $('set-name').value.trim().slice(0, 20) || DEFAULT_SETTINGS.name;
    return { name, sound: $('set-sound').checked };
  }

  ['set-name', 'set-sound'].forEach((id) => {
    $(id).addEventListener('change', () => {
      saveSettings(readSettingsForm());
      $('set-status').textContent = 'Saved.';
    });
  });

  $('reset-records').addEventListener('click', () => {
    if (!window.confirm('Clear all saved records in this browser?')) return;
    storeSet('records', []);
    $('set-status').textContent = 'Records cleared.';
  });

  function renderRecords() {
    const records = loadRecords();
    const real = records.filter((r) => !r.debug);
    const best = real.reduce((top, r) => (!top || r.score > top.score ? r : top), null);
    $('best-line').textContent = best
      ? 'Personal best: ' + pad6(best.score) + '  ·  ' + best.name + '  ·  ' + new Date(best.date).toLocaleDateString()
      : 'No personal best yet. Play a test to set one.';
    const rows = $('record-rows');
    rows.innerHTML = '';
    if (!records.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = 'No records yet.';
      tr.appendChild(td);
      rows.appendChild(tr);
      return;
    }
    records.slice().reverse().forEach((r) => {
      const tr = document.createElement('tr');
      const cells = [
        new Date(r.date).toLocaleString(),
        r.name + (r.debug ? ' (debug)' : ''),
        r.result === 'win' ? 'Passed' : 'Not passed',
        pad6(r.score),
        r.correct + '/' + r.total,
        fmtClock(r.seconds * 1000)
      ];
      cells.forEach((text) => {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      rows.appendChild(tr);
    });
  }

  // ---------- Test flow ----------

  function startTest() {
    if (!state.bank.length) return;
    const settings = loadSettings();
    state.debug = isDebug();
    const total = state.debug ? 1 : QUESTIONS_PER_TEST;
    const pool = shuffle(state.bank.slice());
    // Each question: the correct answer plus 3 random wrong ones, shuffled.
    state.active = pool.slice(0, Math.min(total, pool.length)).map((item) => {
      const picks = shuffle(item.wrong.slice()).slice(0, 3);
      const answers = shuffle([item.correct, ...picks]);
      return { question: item.question, answers, correct: answers.indexOf(item.correct) };
    });
    state.maxLives = LIVES_PER_TEST;
    Object.assign(state, {
      index: 0, score: 0, correct: 0, answered: 0,
      lives: LIVES_PER_TEST, running: true, locked: false,
      selected: -1, cut: [], fiftyUsed: false, phoneUsed: false, crowdUsed: false,
      paused: false, limit: FIRST_LIMIT, flags: [],
      testEnd: performance.now() + TEST_MS
    });
    $('lives').hidden = state.maxLives === 0;
    $('overall').classList.remove('warn');
    $('debug-tag').hidden = !state.debug;
    show('game');
    renderLives();
    renderQuestion();
    say(randomOf(PRESENTER.intro));
  }

  function renderLives() {
    const box = $('lives');
    box.innerHTML = '';
    for (let i = 0; i < state.maxLives; i++) {
      const life = document.createElement('span');
      life.className = 'life' + (i < state.lives ? '' : ' lost');
      life.textContent = '◆';
      box.appendChild(life);
    }
    box.setAttribute('aria-label', state.lives + ' of ' + state.maxLives + ' lives remaining');
  }

  // Background veil: nearly black on question 1, fully clear on the last question.
  const VEIL_START = 0.9;
  function setVeil(index, total) {
    const t = total > 1 ? index / (total - 1) : 0;
    $('veil').style.opacity = (VEIL_START * (1 - t)).toFixed(3);
  }

  function renderQuestion() {
    const item = state.active[state.index];
    state.locked = false;
    state.selected = -1;
    state.cut = [];
    const total = state.active.length;
    setVeil(state.index, total);
    $('progress').textContent = pad2(state.index + 1) + ' / ' + pad2(total);
    $('progressBar').style.width = (state.index / total * 100) + '%';
    $('question').textContent = item.question;
    $('score').textContent = pad6(state.score);
    $('action').hidden = true;
    $('lock').hidden = true;
    $('action-message').textContent = 'SELECT YOUR ANSWER';
    $('time').textContent = (0).toFixed(1);
    $('time').classList.remove('warn');
    $('timerfill').style.width = '0%';
    $('timerfill').classList.remove('warn');
    state.limit = limitFor(state.index, total);
    $('qlimit').textContent = '/ ' + state.limit + ' S';
    renderLadder();

    const box = $('answers');
    box.innerHTML = '';
    item.answers.forEach((text, i) => {
      const b = document.createElement('button');
      b.className = 'answer';
      const key = document.createElement('span');
      key.className = 'answer-key';
      key.textContent = KEYS[i];
      const copy = document.createElement('span');
      copy.className = 'answer-copy';
      copy.textContent = text;
      b.append(key, copy);
      b.addEventListener('click', () => selectAnswer(i));
      box.appendChild(b);
    });

    state.qStart = performance.now();
    cancelAnimationFrame(state.raf);
    refreshPowers();
    tick();
  }

  // Time limit per question: the first round gets 120 s, falling evenly to 25 s for the last round.
  function limitFor(index, total) {
    const size = Math.max(1, Math.ceil(total / ROUNDS));
    const rungs = Math.ceil(total / size);
    if (rungs <= 1) return FIRST_LIMIT;
    const round = Math.floor(index / size);
    return Math.round(FIRST_LIMIT - round * (FIRST_LIMIT - LAST_LIMIT) / (rungs - 1));
  }

  // Ladder: the test split into rungs, the current one lit, finished ones marked.
  function renderLadder() {
    const total = state.active.length;
    const size = Math.max(1, Math.ceil(total / 10));
    const rungs = Math.ceil(total / size);
    const current = Math.floor(state.index / size);
    const box = $('ladder');
    box.innerHTML = '';
    for (let r = rungs - 1; r >= 0; r--) {
      const from = r * size;
      const to = Math.min(total, (r + 1) * size);
      let correct = 0;
      for (let k = from; k < to; k++) if (state.flags[k]) correct++;
      const li = document.createElement('li');
      li.className = 'rung' + (r < current ? ' done' : r === current ? ' now' : '');
      const label = document.createElement('span');
      label.textContent = 'Q' + pad2(to) + ' [' + limitFor(to - 1, total) + 's]';
      const stars = document.createElement('span');
      stars.className = 'stars';
      stars.setAttribute('aria-label', correct + ' of ' + (to - from) + ' correct');
      for (let s = 0; s < 5; s++) {
        const star = document.createElement('i');
        star.textContent = '★';
        if (s < correct) star.className = 'on';
        stars.appendChild(star);
      }
      li.append(label, stars);
      box.appendChild(li);
    }
  }

  // Ticks both clocks: the per-question timer (counts up from 0) and the overall countdown.
  function tick() {
    if (!state.running) return;
    if (state.paused) {
      state.raf = requestAnimationFrame(tick);
      return;
    }
    const now = performance.now();
    const remaining = state.testEnd - now;
    $('overall').textContent = fmtClock(remaining);
    $('overall').classList.toggle('warn', remaining <= 120000);
    if (remaining <= 0) {
      finish('time');
      return;
    }
    if (state.locked) {
      state.raf = requestAnimationFrame(tick);
      return;
    }
    const limitMs = state.limit * 1000;
    const elapsed = Math.min(limitMs, now - state.qStart);
    const warn = elapsed > limitMs * 0.67;
    $('time').textContent = (elapsed / 1000).toFixed(1);
    $('time').classList.toggle('warn', warn);
    $('timerfill').style.width = (elapsed / limitMs * 100) + '%';
    $('timerfill').classList.toggle('warn', warn);
    if (elapsed >= limitMs) {
      expireQuestion();
      state.raf = requestAnimationFrame(tick);
      return;
    }
    state.raf = requestAnimationFrame(tick);
  }

  // Step one: highlight an option. Nothing is scored until FINAL ANSWER.
  function selectAnswer(i) {
    if (state.locked || !state.running || state.cut.includes(i)) return;
    state.selected = i;
    [...$('answers').children].forEach((b, j) => b.classList.toggle('selected', j === i));
    $('lock').hidden = false;
    $('action-message').textContent = 'PRESS FINAL ANSWER OR ENTER';
  }

  // Step two: lock the highlighted option in and score it.
  function lockIn() {
    if (state.locked || !state.running || state.selected < 0 || state.paused) return;
    const item = state.active[state.index];
    const elapsed = Math.min(state.limit, (performance.now() - state.qStart) / 1000);
    say(randomOf(PRESENTER.lock));
    settle(state.selected === item.correct ? 'correct' : 'wrong', state.selected, elapsed);
  }

  // ---------- Presenter: typed lines in the hologram box ----------
  const PRESENTER = {
    intro: [
      'Welcome to TASQ27. Fifty questions, thirty minutes, zero second chances. Let’s see what you’re made of.',
      'Good evening, contestants. The lights are on, the cameras are rolling, and the machines are watching.',
      'Three powers, one brain. Use them wisely, the audience has a long memory.'
    ],
    lock: [
      'Final answer? Bold move. Let’s see if the algorithm agrees.',
      'Locked in. No take-backs in this studio.',
      'Pressure’s on. Deep breath, then we find out.'
    ],
    right: [
      'Correct! Your neurons are firing in the right order.',
      'That’s the one. Somewhere, a data scientist just smiled.',
      'Clean. Precise. Slightly annoying how good you are.'
    ],
    wrong: [
      'Not quite. The model had that one wrong too, for the record.',
      'Wrong answer, but a very confident one. I respect the commitment.',
      'Ouch. The correct answer was right there, looking embarrassed.'
    ],
    timeout: [
      'Time’s up! The clock doesn’t negotiate.',
      'Silence is also an answer. Unfortunately, it’s the wrong one.'
    ],
    milestone: {
      10: 'Ten down, forty to go. The hard part is still ahead.',
      25: 'Halfway point. You’re still standing, which already puts you ahead of most.',
      40: 'Forty answered. Ten left, and the questions are getting nastier.'
    },
    fifty: ['Two options gone. Now it’s a coin flip with better odds.'],
    phone: ['Calling your friend. Let’s hope they studied.'],
    crowd: ['The audience has spoken. Democracy, but with bar charts.'],
    win: [
      'CONGRATULATIONS. You passed. The certificate is already printing in my head.',
      'You made it. Honestly, I had money on you.'
    ],
    lose: [
      'Not this time. Review the material and come back sharper.',
      'Game over for this round. The machines will still be here tomorrow.'
    ]
  };

  let sayTimer = null;
  function randomOf(list) {
    return list[Math.floor(Math.random() * list.length)];
  }
  // Types a line into the presenter box, one character at a time.
  function say(line) {
    const el = $('presenter-line');
    clearInterval(sayTimer);
    el.textContent = '';
    let n = 0;
    sayTimer = setInterval(() => {
      n++;
      el.textContent = line.slice(0, n);
      if (n >= line.length) clearInterval(sayTimer);
    }, 22);
  }

  // ---------- Powers: 50:50, phone a friend, ask the crowd (once each per test) ----------
  function visibleOptions() {
    return [0, 1, 2, 3].filter((i) => !state.cut.includes(i));
  }

  function refreshPowers() {
    const live = state.running && !state.locked && !state.paused;
    $('pow-fifty').disabled = !live || state.fiftyUsed;
    $('pow-phone').disabled = !live || state.phoneUsed;
    $('pow-crowd').disabled = !live || state.crowdUsed;
  }

  // Freezes the question and test clocks while a popup is open.
  function openPopup(kicker, title) {
    state.paused = true;
    state.pauseStart = performance.now();
    refreshPowers();
    $('popup-kicker').textContent = kicker;
    $('popup-title').textContent = title;
    $('popup-body').innerHTML = '';
    $('popup-close').hidden = true;
    $('popup').hidden = false;
  }

  function closePopup() {
    $('popup').hidden = true;
    const gap = performance.now() - state.pauseStart;
    state.qStart += gap;
    state.testEnd += gap;
    state.paused = false;
    refreshPowers();
  }

  // Share of votes per option. The top share goes to the correct answer or a wrong one.
  function crowdShares(visible, top) {
    const shares = [0, 0, 0, 0];
    const topShare = visible.length === 2 ? 60 + Math.floor(Math.random() * 16) : 45 + Math.floor(Math.random() * 21);
    shares[top] = topShare;
    const others = visible.filter((i) => i !== top);
    const weights = others.map(() => 0.5 + Math.random());
    const sum = weights.reduce((a, b) => a + b, 0);
    let rest = 100 - topShare;
    others.forEach((i, k) => {
      const v = k === others.length - 1 ? rest : Math.round((100 - topShare) * weights[k] / sum);
      shares[i] = v;
      rest -= v;
    });
    return shares;
  }

  function askCrowd() {
    if (state.crowdUsed || state.locked || !state.running) return;
    state.crowdUsed = true;
    const item = state.active[state.index];
    const visible = visibleOptions();
    const wrongVisible = visible.filter((i) => i !== item.correct);
    // 86% of the time the crowd's top vote is the correct answer.
    const top = Math.random() < 0.86 ? item.correct : randomOf(wrongVisible);
    const shares = crowdShares(visible, top);

    openPopup('LIFELINE · ASK THE CROWD', 'Counting the votes…');
    say(randomOf(PRESENTER.crowd));
    const chart = document.createElement('div');
    chart.className = 'crowd';
    [0, 1, 2, 3].forEach((i) => {
      const col = document.createElement('div');
      col.className = 'crowd-col';
      const pct = document.createElement('span');
      pct.className = 'crowd-pct';
      const bar = document.createElement('div');
      bar.className = 'crowd-bar';
      const fill = document.createElement('div');
      fill.className = 'crowd-fill';
      bar.appendChild(fill);
      const lab = document.createElement('span');
      lab.className = 'crowd-lab';
      lab.textContent = KEYS[i];
      col.append(pct, bar, lab);
      chart.appendChild(col);
    });
    $('popup-body').appendChild(chart);
    setTimeout(() => {
      $('popup-title').textContent = 'The crowd has voted';
      chart.querySelectorAll('.crowd-col').forEach((col, i) => {
        col.querySelector('.crowd-fill').style.height = shares[i] + '%';
        col.querySelector('.crowd-pct').textContent = shares[i] + '%';
      });
      $('popup-close').hidden = false;
    }, 2600);
  }

  function callFriend() {
    if (state.phoneUsed || state.locked || !state.running) return;
    state.phoneUsed = true;
    const item = state.active[state.index];
    // The friend is right about 70% of the time, otherwise picks a wrong visible option.
    const pick = Math.random() < 0.7 ? item.correct : randomOf(visibleOptions().filter((i) => i !== item.correct));

    openPopup('LIFELINE · PHONE A FRIEND', 'Calling your friend…');
    say(randomOf(PRESENTER.phone));
    const dial = document.createElement('div');
    dial.className = 'dial';
    dial.textContent = 'RINGING';
    $('popup-body').appendChild(dial);
    setTimeout(() => {
      $('popup-title').textContent = 'Your friend is on the line';
      const says = document.createElement('p');
      says.className = 'friend-says';
      says.textContent = '“I’m about 70% sure it’s ' + KEYS[pick] + ': ' + item.answers[pick] + '.”';
      $('popup-body').replaceChildren(says);
      $('popup-close').hidden = false;
    }, 2800);
  }

  // Lifeline: removes two wrong options, once per test.
  function useFiftyFifty() {
    if (state.fiftyUsed || state.locked || !state.running || state.paused) return;
    const item = state.active[state.index];
    const wrong = item.answers.map((_, i) => i).filter((i) => i !== item.correct);
    state.cut = shuffle(wrong).slice(0, 2);
    state.fiftyUsed = true;
    [...$('answers').children].forEach((b, j) => {
      const out = state.cut.includes(j);
      b.classList.toggle('out', out);
      b.disabled = out;
    });
    if (state.cut.includes(state.selected)) {
      state.selected = -1;
      [...$('answers').children].forEach((b) => b.classList.remove('selected'));
      $('lock').hidden = true;
    }
    $('action-message').textContent = 'TWO WRONG ANSWERS REMOVED';
    say(randomOf(PRESENTER.fifty));
    refreshPowers();
  }

  // Time ran out: an answer that is selected is checked as if FINAL ANSWER was pressed.
  // With no selection the question counts as wrong: one life lost, the right answer is shown.
  function expireQuestion() {
    const picked = state.selected;
    if (picked < 0) return settle('timeout', -1, state.limit);
    const item = state.active[state.index];
    settle(picked === item.correct ? 'correct' : 'wrong', picked, state.limit);
  }

  function pointsFor(elapsedSeconds) {
    // Points: 500 for any correct answer, plus up to 500 more for answering fast.
    const left = Math.max(0, state.limit - elapsedSeconds) / state.limit;
    return 500 + Math.round(500 * left);
  }

  // Locks the question, colors the options, updates score and lives, then moves on.
  function settle(result, picked, elapsed) {
    state.locked = true;
    state.answered++;
    state.flags[state.index] = result === 'correct';
    const item = state.active[state.index];
    const buttons = [...$('answers').querySelectorAll('.answer')];
    buttons.forEach((b, j) => {
      b.disabled = true;
      b.classList.remove('selected');
      if (j === item.correct) b.classList.add('correct');
      else if (j === picked) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    $('lock').hidden = true;

    say(randomOf(result === 'correct' ? PRESENTER.right : result === 'timeout' ? PRESENTER.timeout : PRESENTER.wrong));
    refreshPowers();
    if (result === 'correct') {
      const points = pointsFor(elapsed);
      state.correct++;
      state.score += points;
      $('action-message').textContent = 'CORRECT // +' + points + ' POINTS';
      playSound(true);
      setMood('correct');
      flash(false);
    } else {
      loseLife();
      const head = result === 'timeout' ? 'TIME EXPIRED' : 'INCORRECT';
      $('action-message').textContent = head + ' // ANSWER: ' + item.answers[item.correct];
      playSound(false);
      setMood('wrong');
      flash(true);
    }
    $('score').textContent = pad6(state.score);
    setTimeout(() => setMood('idle'), 1000);

    renderLadder();
    const last = state.index === state.active.length - 1;
    $('action').hidden = false;
    $('action').textContent = last ? 'FINISH TEST ↗' : 'NEXT QUESTION ↗';
    clearTimeout(state.advanceTimer);
    state.advanceTimer = setTimeout(advance, 2600);
  }

  function loseLife() {
    if (state.maxLives === 0) return;
    state.lives = Math.max(0, state.lives - 1);
    renderLives();
  }

  function advance() {
    if (!state.running) return;
    clearTimeout(state.advanceTimer);
    if (state.maxLives > 0 && state.lives === 0) {
      finish('lives');
    } else if (state.index === state.active.length - 1) {
      finish('complete');
    } else {
      state.index++;
      setMood('idle');
      renderQuestion();
      if (PRESENTER.milestone[state.index]) say(PRESENTER.milestone[state.index]);
    }
  }
  $('action').addEventListener('click', advance);
  $('lock').addEventListener('click', lockIn);
  $('pow-fifty').addEventListener('click', useFiftyFifty);
  $('pow-phone').addEventListener('click', callFriend);
  $('pow-crowd').addEventListener('click', askCrowd);
  $('popup-close').addEventListener('click', closePopup);

  // Ends the test and records the result. reason: complete | lives | time
  function finish(reason) {
    if (!state.running) return;
    state.running = false;
    state.locked = true;
    cancelAnimationFrame(state.raf);
    clearTimeout(state.advanceTimer);

    const total = state.active.length;
    const pct = Math.round(state.correct / total * 100);
    const win = reason === 'complete' && pct >= PASS_PERCENT;
    const seconds = Math.round((TEST_MS - Math.max(0, state.testEnd - performance.now())) / 1000);
    const settings = loadSettings();
    const records = loadRecords();
    const previous = records.filter((r) => !r.debug).reduce((top, r) => Math.max(top, r.score), -1);
    const isRecord = !state.debug && state.score > previous;
    const record = {
      date: new Date().toISOString(),
      name: settings.name,
      score: state.score,
      correct: state.correct,
      total,
      mistakes: state.answered - state.correct,
      seconds,
      result: win ? 'win' : 'fail',
      reason,
      debug: state.debug
    };
    storeSet('records', [...records, record].slice(-100));

    $('result').dataset.outcome = win ? 'win' : 'fail';
    $('result-kicker').textContent = win ? 'Test passed' : 'Test not passed';
    $('result-title').innerHTML = win ? 'CONGRATULATIONS' : 'NOT THIS TIME';
    $('result-copy').textContent = win
      ? 'You answered ' + pct + '% correctly, above the ' + PASS_PERCENT + '% pass mark.'
      : reason === 'lives' ? 'You ran out of lives before finishing the test.'
      : reason === 'time' ? 'The 30 minutes ran out before the test was finished.'
      : 'You answered ' + pct + '% correctly. The pass mark is ' + PASS_PERCENT + '%.';
    $('final-score').textContent = pad6(state.score);
    $('stat-correct').textContent = state.correct + '/' + total;
    $('stat-accuracy').textContent = pct + '%';
    $('stat-time').textContent = fmtClock(seconds * 1000);
    $('stat-mistakes').textContent = record.mistakes;
    $('record-banner').hidden = !isRecord;
    $('previous-best').textContent = previous >= 0 && !state.debug
      ? 'Previous best: ' + pad6(previous)
      : state.debug ? 'Debug test, not counted as a record.' : 'First test on this browser.';
    show('result');
    say(randomOf(win ? PRESENTER.win : PRESENTER.lose));
    setMood(win ? 'correct' : 'wrong');
    if (win) burst(0x8bffcb, 2);
  }

  $('play-again').addEventListener('click', startTest);
  $('to-menu').addEventListener('click', () => show('menu'));

  // Keys A-D or 1-4 highlight an option, Enter locks it in, F uses 50:50; Enter or Space leaves the splash.
  document.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (!$('splash').classList.contains('hidden') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      show('menu');
      return;
    }
    if (!state.running || state.locked || state.paused) return;
    if (e.key === 'Enter') { lockIn(); return; }
    const power = e.key.toLowerCase();
    if (power === 'f') { useFiftyFifty(); return; }
    if (power === 'p') { callFriend(); return; }
    if (power === 'c') { askCrowd(); return; }
    const letter = KEYS.indexOf(e.key.toUpperCase());
    const idx = letter >= 0 ? letter : parseInt(e.key, 10) - 1;
    const btn = $('answers').children[idx];
    if (btn && !btn.disabled) selectAnswer(idx);
  });

  function flash(bad) {
    const f = $('flash');
    f.className = 'flash';
    void f.offsetWidth; // restart the animation
    f.className = 'flash play' + (bad ? ' bad' : '');
  }

  let audioCtx = null;
  function playSound(ok) {
    if (!loadSettings().sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = ok ? 'sine' : 'sawtooth';
      o.frequency.setValueAtTime(ok ? 660 : 180, t);
      o.frequency.exponentialRampToValueAtTime(ok ? 1320 : 70, t + 0.22);
      g.gain.setValueAtTime(0.06, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.3);
    } catch (err) {
      // No audio available; the game works without sound.
    }
  }

  // ---------- Three.js scene: neural-DNA environment ----------

  // ---------- Three.js scene: neural-DNA environment ----------

  let scene, camera, renderer, clock, world, core, helixGroup, neuralGroup, particleSystem, particleVelocities;
  const nodes = [];
  const rings = [];
  const shards = [];
  const pulses = [];
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  let mood = 0;
  const isMobile = matchMedia('(max-width:700px)').matches;

  function initScene() {
    if (!window.THREE) return;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: !isMobile, alpha: true, powerPreference: 'high-performance' });
    } catch (err) {
      return; // WebGL unavailable; the CSS background still shows
    }
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x03050a, 0.025);
    camera = new THREE.PerspectiveCamera(47, innerWidth / innerHeight, 0.1, 300);
    camera.position.set(0, 0, 37);
    renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.35 : 1.8));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.4;
    $('universe').appendChild(renderer.domElement);
    clock = new THREE.Clock();
    world = new THREE.Group();
    scene.add(world);

    scene.add(new THREE.AmbientLight(0x5574a0, 0.65));
    const cyanLight = new THREE.PointLight(0x35ddff, 75, 90);
    cyanLight.position.set(-12, 7, 8);
    scene.add(cyanLight);
    const violetLight = new THREE.PointLight(0x7355ff, 95, 90);
    violetLight.position.set(12, -5, -8);
    scene.add(violetLight);
    const goldLight = new THREE.PointLight(0xffbd67, 38, 60);
    goldLight.position.set(0, 10, -13);
    scene.add(goldLight);
    world.userData.lights = { cyanLight, violetLight, goldLight };

    // Organic nucleus: a displaced icosahedral shell.
    const coreGeo = new THREE.IcosahedronGeometry(4.7, 4);
    const p = coreGeo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const wave = 1 + 0.055 * Math.sin(v.x * 2.1 + v.y * 1.7) * Math.cos(v.z * 2.4) + 0.025 * Math.sin(v.y * 3.3 + v.z);
      v.multiplyScalar(wave);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    coreGeo.computeVertexNormals();
    core = new THREE.Mesh(coreGeo, new THREE.MeshPhysicalMaterial({
      color: 0x0a2236, metalness: 0.62, roughness: 0.24, transmission: 0.28, thickness: 1.5,
      emissive: 0x05283d, emissiveIntensity: 0.9, transparent: true, opacity: 0.72
    }));
    world.add(core);

    const wire = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(5.1, 2));
    const wireMesh = new THREE.LineSegments(wire, new THREE.LineBasicMaterial({
      color: 0x4adfff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending
    }));
    world.add(wireMesh);
    core.userData.wire = wireMesh;

    const nucleus = new THREE.Mesh(new THREE.OctahedronGeometry(1.45, 2), new THREE.MeshPhysicalMaterial({
      color: 0x99f5ff, emissive: 0x22cfff, emissiveIntensity: 2.8, metalness: 0.25, roughness: 0.15
    }));
    world.add(nucleus);
    core.userData.nucleus = nucleus;

    // DNA double helix with rungs.
    helixGroup = new THREE.Group();
    helixGroup.position.set(0, 0, -3);
    world.add(helixGroup);
    const strandColors = [0x5ce9ff, 0xb68bff];
    for (let strand = 0; strand < 2; strand++) {
      const points = [];
      for (let i = 0; i <= 420; i++) {
        const t = i / 420 * Math.PI * 8;
        const y = (i / 420 - 0.5) * 27;
        const a = t + strand * Math.PI;
        points.push(new THREE.Vector3(Math.cos(a) * 5.8, y, Math.sin(a) * 3.2));
      }
      const curve = new THREE.CatmullRomCurve3(points);
      helixGroup.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 500, 0.055, 5, false), new THREE.MeshBasicMaterial({
        color: strandColors[strand], transparent: true, opacity: 0.68, blending: THREE.AdditiveBlending
      })));
    }
    const rungMat = new THREE.MeshBasicMaterial({ color: 0x8b9bff, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending });
    for (let i = 0; i < 80; i++) {
      const t = i / 80 * Math.PI * 8;
      const y = (i / 80 - 0.5) * 27;
      const a = new THREE.Vector3(Math.cos(t) * 5.8, y, Math.sin(t) * 3.2);
      const b = new THREE.Vector3(Math.cos(t + Math.PI) * 5.8, y, Math.sin(t + Math.PI) * 3.2);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, a.distanceTo(b), 5), rungMat);
      rod.position.copy(a.clone().add(b).multiplyScalar(0.5));
      rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      helixGroup.add(rod);
    }

    // Neural network: nodes, branching paths and moving signals.
    neuralGroup = new THREE.Group();
    world.add(neuralGroup);
    const nodeMat = new THREE.MeshBasicMaterial({ color: 0x70eaff, transparent: true, opacity: 0.9 });
    const nodeGeo = new THREE.IcosahedronGeometry(0.09, 1);
    for (let i = 0; i < 175; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 7 + Math.random() * 15;
      const pos = new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
      nodes.push({ pos, phase: Math.random() * 6.28, speed: 0.3 + Math.random() });
      const n = new THREE.Mesh(nodeGeo, nodeMat.clone());
      n.position.copy(pos);
      n.scale.setScalar(0.5 + Math.random() * 2.1);
      neuralGroup.add(n);
    }
    const lineMat = new THREE.LineBasicMaterial({ color: 0x477ee8, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending });
    for (let i = 0; i < nodes.length; i++) {
      const nearest = nodes
        .map((n, j) => ({ j, d: n.pos.distanceTo(nodes[i].pos) }))
        .filter((x) => x.j !== i)
        .sort((a, b) => a.d - b.d)
        .slice(0, 2 + Math.floor(Math.random() * 3));
      for (const near of nearest) {
        if (near.j < i) continue;
        const a = nodes[i].pos;
        const b = nodes[near.j].pos;
        const mid = a.clone().add(b).multiplyScalar(0.5);
        mid.add(new THREE.Vector3((Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 1.4));
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(14)), lineMat.clone());
        line.material.opacity = 0.09 + Math.random() * 0.23;
        neuralGroup.add(line);
        if (Math.random() < 0.17) pulses.push({ curve, t: Math.random(), speed: 0.12 + Math.random() * 0.3 });
      }
    }

    // Particle field, fewer points on phones.
    const count = isMobile ? 2800 : 6800;
    const positions = new Float32Array(count * 3);
    particleVelocities = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const colorA = new THREE.Color(0x48dfff);
    const colorB = new THREE.Color(0x8a65ff);
    const colorC = new THREE.Color(0xffd08b);
    for (let i = 0; i < count; i++) {
      const r = 5 + Math.random() * 32;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 3 + 2] = r * Math.cos(phi);
      particleVelocities[i * 3] = (Math.random() - 0.5) * 0.015;
      particleVelocities[i * 3 + 1] = (Math.random() - 0.5) * 0.015;
      particleVelocities[i * 3 + 2] = (Math.random() - 0.5) * 0.015;
      const col = Math.random() < 0.62 ? colorA : (Math.random() < 0.7 ? colorB : colorC);
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    particleSystem = new THREE.Points(pg, new THREE.PointsMaterial({
      size: isMobile ? 0.055 : 0.075, vertexColors: true, transparent: true, opacity: 0.76,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    }));
    world.add(particleSystem);

    // Tilted orbital arcs.
    for (let i = 0; i < 7; i++) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(8 + i * 1.25, 0.012 + (i % 3) * 0.009, 4, 240),
        new THREE.MeshBasicMaterial({ color: 0x3dbde8, transparent: true, opacity: 0.12 + Math.random() * 0.2, blending: THREE.AdditiveBlending })
      );
      ring.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      world.add(ring);
      rings.push({ mesh: ring, rx: (Math.random() - 0.5) * 0.12, ry: (Math.random() - 0.5) * 0.15, rz: (Math.random() - 0.5) * 0.1 });
    }

    // Crystalline shards orbiting the core.
    const shardGeo = new THREE.TetrahedronGeometry(0.16, 0);
    const shardMat = new THREE.MeshStandardMaterial({ color: 0x72eaff, metalness: 0.65, roughness: 0.18, emissive: 0x145b9a, emissiveIntensity: 1.3 });
    for (let i = 0; i < (isMobile ? 75 : 150); i++) {
      const s = new THREE.Mesh(shardGeo, shardMat.clone());
      const r = 8 + Math.random() * 17;
      const a = Math.random() * Math.PI * 2;
      s.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 24, Math.sin(a) * r);
      s.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      s.scale.setScalar(0.3 + Math.random() * 1.5);
      s.userData = { a, r, sp: (Math.random() - 0.5) * 0.08, phase: Math.random() * 6.28 };
      world.add(s);
      shards.push(s);
    }

    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', (e) => {
      mouse.tx = (e.clientX / innerWidth - 0.5) * 2;
      mouse.ty = (e.clientY / innerHeight - 0.5) * 2;
    }, { passive: true });
    animate();
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    renderer.setPixelRatio(Math.min(devicePixelRatio, matchMedia('(max-width:700px)').matches ? 1.35 : 1.8));
  }

  function animate() {
    requestAnimationFrame(animate);
    if (!renderer) return;
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = clock.elapsedTime;
    mouse.x += (mouse.tx - mouse.x) * 0.025;
    mouse.y += (mouse.ty - mouse.y) * 0.025;

    // Parallax: camera, helix and particles move at different rates.
    camera.position.x = mouse.x * 1.7;
    camera.position.y = -mouse.y * 1.2;
    camera.lookAt(0, 0, 0);
    world.rotation.y += 0.00018;
    world.rotation.x = Math.sin(t * 0.06) * 0.012;
    core.rotation.y = t * 0.03;
    core.rotation.x = Math.sin(t * 0.08) * 0.05;
    core.scale.setScalar(1 + Math.sin(t * 1.15) * 0.018);
    core.userData.wire.rotation.copy(core.rotation);
    core.userData.nucleus.rotation.set(t * 0.15, t * 0.25, t * 0.1);
    core.userData.nucleus.scale.setScalar(1 + Math.sin(t * 2.1) * 0.1);
    helixGroup.rotation.y = Math.sin(t * 0.05) * 0.12;
    helixGroup.rotation.z = Math.sin(t * 0.04) * 0.03;
    neuralGroup.rotation.y = -t * 0.006;
    neuralGroup.rotation.x = Math.sin(t * 0.06) * 0.02;

    rings.forEach((r) => {
      r.mesh.rotation.x += r.rx * dt * 0.3;
      r.mesh.rotation.y += r.ry * dt * 0.3;
      r.mesh.rotation.z += r.rz * dt * 0.3;
    });
    shards.forEach((s) => {
      s.userData.a += s.userData.sp * dt;
      s.position.x = Math.cos(s.userData.a) * s.userData.r;
      s.position.z = Math.sin(s.userData.a) * s.userData.r;
      s.position.y += Math.sin(t * 0.7 + s.userData.phase) * 0.003;
      s.rotation.x += dt * 0.04;
      s.rotation.y += dt * 0.06;
    });
    nodes.forEach((n, i) => {
      const obj = neuralGroup.children[i];
      if (obj && obj.isMesh) {
        const pulse = 0.7 + 0.4 * Math.sin(t * n.speed + n.phase);
        obj.scale.setScalar(pulse * (0.6 + (0.5 + Math.sin(n.phase) * 0.5) * 0.8));
      }
    });
    // Signals travelling along the synapses.
    pulses.forEach((p) => {
      p.t += p.speed * dt;
      if (p.t > 1) p.t -= 1;
      if (!p.bead) {
        p.bead = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 6), new THREE.MeshBasicMaterial({ color: 0xc0f8ff, blending: THREE.AdditiveBlending }));
        world.add(p.bead);
      }
      p.bead.position.copy(p.curve.getPoint(p.t));
    });

    const pos = particleSystem.geometry.attributes.position.array;
    for (let i = 0; i < pos.length / 3; i++) {
      pos[i * 3] += particleVelocities[i * 3] + Math.sin(t * 0.3 + i) * 0.0008;
      pos[i * 3 + 1] += particleVelocities[i * 3 + 1];
      pos[i * 3 + 2] += particleVelocities[i * 3 + 2];
      const d = Math.sqrt(pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2);
      if (d > 39 || d < 4.5) {
        const a = Math.random() * Math.PI * 2;
        const b = Math.acos(2 * Math.random() - 1);
        const r = 8 + Math.random() * 29;
        pos[i * 3] = r * Math.sin(b) * Math.cos(a);
        pos[i * 3 + 1] = r * Math.sin(b) * Math.sin(a);
        pos[i * 3 + 2] = r * Math.cos(b);
      }
    }
    particleSystem.geometry.attributes.position.needsUpdate = true;
    if (mood > 0) mood = Math.max(0, mood - dt);
    renderer.render(scene, camera);
  }

  function setMood(kind) {
    if (!world) return;
    const { cyanLight, violetLight } = world.userData.lights;
    if (kind === 'correct') {
      cyanLight.color.setHex(0x8bffcb); cyanLight.intensity = 180;
      violetLight.color.setHex(0x5ce9ff); violetLight.intensity = 150;
      core.material.emissive.setHex(0x0b7959); core.material.emissiveIntensity = 3;
      core.userData.wire.material.color.setHex(0x8bffcb);
      rings.forEach((r) => r.mesh.material.color.setHex(0x8bffcb));
      burst(0x8bffcb, 1);
    } else if (kind === 'wrong') {
      cyanLight.color.setHex(0xff355e); cyanLight.intensity = 165;
      violetLight.color.setHex(0xff627f); violetLight.intensity = 125;
      core.material.emissive.setHex(0x70172b); core.material.emissiveIntensity = 3;
      core.userData.wire.material.color.setHex(0xff627f);
      burst(0xff627f, 1.4);
      shards.forEach((s) => { s.userData.r += Math.random() * 3; s.userData.sp *= 1.8; });
    } else {
      cyanLight.color.setHex(0x35ddff); cyanLight.intensity = 75;
      violetLight.color.setHex(0x7355ff); violetLight.intensity = 95;
      core.material.emissive.setHex(0x05283d); core.material.emissiveIntensity = 0.9;
      core.userData.wire.material.color.setHex(0x4adfff);
      rings.forEach((r) => r.mesh.material.color.setHex(0x3dbde8));
      shards.forEach((s) => {
        s.userData.r += (10 - s.userData.r) * 0.03;
        s.userData.sp += (Math.sign(s.userData.sp || 1) * 0.025 - s.userData.sp) * 0.03;
      });
    }
  }

  // Particle eruption that travels outward and fades.
  function burst(color, intensity = 1) {
    if (!scene) return;
    const count = isMobile ? 240 : 620;
    const positions = new Float32Array(count * 3);
    const vels = [];
    for (let i = 0; i < count; i++) {
      const d = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const r = 3 + Math.random() * 2;
      positions[i * 3] = d.x * r;
      positions[i * 3 + 1] = d.y * r;
      positions[i * 3 + 2] = d.z * r;
      vels.push(d.multiplyScalar((0.8 + Math.random() * 3.8) * intensity));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color, size: 0.12, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const points = new THREE.Points(geo, mat);
    world.add(points);
    const start = performance.now();
    const duration = 1250;
    const update = () => {
      const f = (performance.now() - start) / duration;
      if (f >= 1) {
        world.remove(points);
        geo.dispose();
        mat.dispose();
        return;
      }
      const p = geo.attributes.position.array;
      for (let i = 0; i < count; i++) {
        p[i * 3] += vels[i].x * 0.06;
        p[i * 3 + 1] += vels[i].y * 0.06;
        p[i * 3 + 2] += vels[i].z * 0.06;
        vels[i].multiplyScalar(0.994);
      }
      geo.attributes.position.needsUpdate = true;
      mat.opacity = 1 - f;
      requestAnimationFrame(update);
    };
    update();
  }

  // ---------- Start ----------

  loadBank();
  if (!state.bank.length) $('splash').querySelector('.press').textContent = 'QUESTION BANK MISSING';
  try {
    initScene();
  } catch (err) {
    // Scene failed to start; the rest of the app still works.
  }
})();
