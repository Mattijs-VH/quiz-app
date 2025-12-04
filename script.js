// script.js
// ES module style. Keep in same folder as index.html and data.json.
// Author: updated to add image->name questions and safer submit behavior.

const DATA_PATH = 'data.json'; // relative path
const MAX_OPTIONS = 4;

let rawData = {};
let selectedCategories = [];
let questionPool = [];
let currentQuestionIndex = -1;
let currentSessionQuestions = [];
let sessionScore = 0;
let sessionStreak = 0;
let bestStreak = Number(localStorage.getItem('quiz_highscore') || 0);

const el = {
  categories: document.getElementById('categories'),
  startBtn: document.getElementById('startBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  numQuestions: document.getElementById('numQuestions'),
  quizArea: document.getElementById('quizArea'),
  questionText: document.getElementById('questionText'),
  answersForm: document.getElementById('answersForm'),
  questionImage: document.getElementById('questionImage'),
  feedback: document.getElementById('feedback'),
  score: document.getElementById('score'),
  streak: document.getElementById('streak'),
  highscore: document.getElementById('highscore'),
  nextBtn: document.getElementById('nextBtn'),
  endBtn: document.getElementById('endBtn'),
  qIndex: document.getElementById('qIndex'),
};

// bootstrap
init();

async function init() {
  try {
    rawData = await fetchJSON(DATA_PATH);
  } catch (e) {
    showFatal(`Could not load ${DATA_PATH}. Make sure file exists and is valid JSON.`);
    console.error(e);
    return;
  }

  buildCategoryCheckboxes(Object.keys(rawData));
  el.highscore.textContent = bestStreak;
  el.startBtn.addEventListener('click', startQuiz);
  el.nextBtn.addEventListener('click', nextQuestion);
  el.endBtn.addEventListener('click', endSession);
}

async function fetchJSON(path) {
  const resp = await fetch(path, {cache: "no-cache"});
  if (!resp.ok) throw new Error('Failed to fetch');
  return resp.json();
}

function buildCategoryCheckboxes(categories) {
  el.categories.innerHTML = '';
  categories.forEach(cat => {
    const id = `cat_${cat}`;
    const wrapper = document.createElement('label');
    wrapper.className = 'category';
    wrapper.innerHTML = `
      <input type="checkbox" id="${id}" data-cat="${cat}" />
      <span>${capitalize(cat)}</span>
    `;
    el.categories.appendChild(wrapper);
  });
}

// Start Quiz
function startQuiz() {
  selectedCategories = Array.from(el.categories.querySelectorAll('input:checked')).map(i => i.dataset.cat);
  if (selectedCategories.length === 0) {
    showToast('Please select at least one category.');
    return;
  }
  buildQuestionPool();
  const n = Math.max(1, parseInt(el.numQuestions.value || "20", 10));
  currentSessionQuestions = shuffleArray(questionPool).slice(0, n);
  if (currentSessionQuestions.length === 0) {
    showToast('No valid questions available for the chosen categories. Add more data or choose other categories.');
    return;
  }
  sessionScore = 0;
  sessionStreak = 0;
  el.score.textContent = sessionScore;
  el.streak.textContent = sessionStreak;
  el.highscore.textContent = bestStreak;

  currentQuestionIndex = -1;
  el.quizArea.classList.remove('hidden');
  document.getElementById('setup').classList.add('hidden');
  nextQuestion();
}

// End session and return to setup
function endSession() {
  document.getElementById('setup').classList.remove('hidden');
  el.quizArea.classList.add('hidden');
}

/**
 * Find a minimal combination of properties (starting at startK up to maxCombo)
 * that uniquely identifies `item` among `items`.
 * Returns { properties: [...], valueTuple: [...] } or null if none found.
 */
function findUniquePropertyCombo(item, items, allProps, maxCombo = 3, startK = 2) {
  const maxK = Math.min(maxCombo, allProps.length);
  for (let k = startK; k <= maxK; k++) {
    const combos = combinations(allProps, k);
    for (const combo of combos) {
      const tuple = [];
      let skip = false;
      for (const p of combo) {
        const v = item[p];
        if (v === undefined || v === null) {
          skip = true;
          break;
        }
        tuple.push(v);
      }
      if (skip) continue;

      let count = 0;
      for (const it of items) {
        let match = true;
        for (let i = 0; i < combo.length; i++) {
          const p = combo[i];
          const expected = tuple[i];
          if ((it[p] ?? null) !== expected) {
            match = false;
            break;
          }
        }
        if (match) count++;
        if (count > 1) break;
      }

      if (count === 1) {
        return { properties: combo.slice(), valueTuple: tuple.slice() };
      }
    }
  }
  return null;
}

// Build question pool (analyze uniqueness)
function buildQuestionPool() {
  questionPool = [];
  // for each selected category, inspect items and properties
  for (const cat of Object.keys(rawData)) {
    if (selectedCategories.length && !selectedCategories.includes(cat)) continue;
    const items = rawData[cat] || [];
    if (!Array.isArray(items) || items.length === 0) continue;

    // collect property keys (exclude name and image)
    const sample = items[0];
    const allProps = Array.from(new Set(Object.keys(sample).filter(k => k !== 'name' && k !== 'image')));

    // Build frequency maps for single property values
    const propValueMap = {}; // prop -> value -> [items...]
    for (const p of allProps) {
      propValueMap[p] = {};
      for (const it of items) {
        const val = it[p] ?? null;
        if (!propValueMap[p][val]) propValueMap[p][val] = [];
        propValueMap[p][val].push(it);
      }
    }

    // Single-property unique values -> property -> name question (property -> name)
    for (const p of allProps) {
      for (const val of Object.keys(propValueMap[p])) {
        const arr = propValueMap[p][val];
        if (val === 'null' || val === null || val === undefined) continue;
        if (arr.length === 1) {
          const correctItem = arr[0];
          questionPool.push({
            category: cat,
            type: 'property->name',
            property: p,
            value: val,
            correct: correctItem.name,
            sourceItem: correctItem
          });
        }
      }
    }

    // Name -> property (where that property's value is unique across items)
    for (const it of items) {
      for (const p of allProps) {
        const val = it[p];
        if (val === undefined || val === null) continue;
        if ((propValueMap[p][val] || []).length === 1) {
          questionPool.push({
            category: cat,
            type: 'name->property',
            property: p,
            correct: val,
            name: it.name,
            sourceItem: it
          });
        }
      }
    }

    // Find minimal property combinations (size >=2) that uniquely identify items.
    for (const it of items) {
      const combo = findUniquePropertyCombo(it, items, allProps, 3, 2); // try k=2..3
      if (combo && combo.properties.length >= 2) {
        questionPool.push({
          category: cat,
          type: 'properties->name',
          properties: combo.properties.slice(),
          valueTuple: combo.valueTuple.slice(),
          correct: it.name,
          sourceItem: it
        });
      }
    }

    // Image-based questions
    const itemsWithImages = items.filter(i => i.image);
    console.debug(`buildQuestionPool: category=${cat} itemsWithImages=${itemsWithImages.length}`);

    // create name->image entries (show name, choose image)
    if (itemsWithImages.length >= 2) {
      for (const it of itemsWithImages) {
        questionPool.push({
          category: cat,
          type: 'name->image',
          name: it.name,
          correctImage: it.image,
          sourceItem: it
        });
      }
    }

    // create image->name entries (show image, choose name)
    // require at least 2 items with images so there is at least one distractor.
    if (itemsWithImages.length >= 2) {
      for (const it of itemsWithImages) {
        questionPool.push({
          category: cat,
          type: 'image->name',
          name: it.name,
          image: it.image,
          sourceItem: it
        });
      }
    }
  }

  // ensure uniqueness and dedupe
  questionPool = dedupeQuestions(questionPool);
  // shuffle to randomize
  questionPool = shuffleArray(questionPool);

  // Optional: log counts per type so you can verify composition
  try {
    const counts = questionPool.reduce((acc, q) => { acc[q.type] = (acc[q.type]||0)+1; return acc; }, {});
    console.debug('Question pool built:', counts);
  } catch (e) {}
}

// Navigate to next
function nextQuestion() {
  el.nextBtn.disabled = true;
  el.feedback.innerHTML = '';
  currentQuestionIndex++;
  if (currentQuestionIndex >= currentSessionQuestions.length) {
    // session over
    showToast(`Session finished. Score ${sessionScore}/${currentSessionQuestions.length}. Best streak: ${bestStreak}`);
    el.nextBtn.disabled = true;
    el.feedback.innerHTML = `<div class="correct">Session finished — Score ${sessionScore}/${currentSessionQuestions.length}. Best streak: ${bestStreak}</div>`;

    // Replace any submit/next button inside the form with an "End Session" button
    try {
      const existingBtns = el.answersForm.querySelectorAll('button.submit-btn');
      existingBtns.forEach(b => b.remove());

      const endBtn = document.createElement('button');
      endBtn.className = 'btn primary submit-btn';
      endBtn.type = 'button';
      endBtn.textContent = 'End Session';
      endBtn.style.marginTop = '12px';
      endBtn.addEventListener('click', () => {
        endSession();
      });
      el.answersForm.appendChild(endBtn);
    } catch (err) {
      console.error('Error while creating End Session button', err);
    }
    return;
  }
  const q = currentSessionQuestions[currentQuestionIndex];
  renderQuestion(q, currentQuestionIndex + 1, currentSessionQuestions.length);
}

// Render question depending on type
function renderQuestion(q, index, total) {
  el.qIndex.textContent = `Question ${index}/${total} — Category: ${capitalize(q.category)}`;
  el.answersForm.innerHTML = '';
  el.questionImage.classList.add('hidden');
  el.questionImage.src = '';

  // Build different question types
  if (q.type === 'property->name') {
    el.questionText.textContent = `Which ${q.category} has ${propLabel(q.property)} = "${q.value}"?`;
    const correct = q.correct;
    const choices = pickNameChoices(q.category, correct, MAX_OPTIONS);
    buildOptionsAndHook(choices, correct, {q});
  } else if (q.type === 'name->property') {
    el.questionText.textContent = `Which ${propLabel(q.property)} belongs to ${q.name}?`;
    const correct = q.correct;
    const choices = pickPropertyChoices(q.category, q.property, correct, MAX_OPTIONS);
    buildOptionsAndHook(choices, correct, {q});
  } else if (q.type === 'properties->name') {
    const display = q.properties.map((p, i) => `${propLabel(p)}: "${q.valueTuple[i]}"`).join(' ; ');
    el.questionText.textContent = `Which ${q.category} matches — ${display}?`;
    const correct = q.correct;
    const choices = pickNameChoices(q.category, correct, MAX_OPTIONS);
    buildOptionsAndHook(choices, correct, {q});
  } else if (q.type === 'name->image') {
    el.questionText.textContent = `Which image shows ${q.name}?`;
    // present image options (up to MAX_OPTIONS images)
    const candidates = getItemsWithImages(q.category);
    const shuffled = shuffleArray(candidates);
    const choices = shuffled.slice(0, MAX_OPTIONS).map(it => ({ label: it.name, image: it.image }));
    if (!choices.find(c => c.image === q.correctImage)) {
      if (choices.length < MAX_OPTIONS) {
        choices.push({ label: q.sourceItem.name, image: q.correctImage });
      } else {
        choices[0] = { label: q.sourceItem.name, image: q.correctImage };
      }
    }
    const final = shuffleArray(choices);
    // render image options as radio with thumbnails and no visible name (alt provides the name)
    el.answersForm.innerHTML = final.map((c, idx) => `
      <label class="answer-option" style="display:inline-block; margin:6px; text-align:center;">
        <input type="radio" name="answer" value="${escapeAttr(c.label)}" aria-label="${escapeAttr(c.label)}" />
        <img src="${escapeAttr(c.image)}" alt="${escapeAttr(c.label)}" style="display:block; max-width:120px; max-height:90px; margin-top:6px; border-radius:6px; border:1px solid #eef2ff;" />
      </label>
    `).join('');
    hookSubmit((selected) => {
      const chosen = selected;
      const correctName = q.name;
      if (chosen === correctName) {
        handleCorrect();
      } else {
        handleWrong(`Wrong — you selected “${escapeHtml(chosen)}”.`);
      }
    });
  } else if (q.type === 'image->name') {
    // Show large image in the question area and textual choices below
    el.questionText.textContent = `Which ${q.category} is shown?`;
    el.questionImage.src = q.image;
    el.questionImage.alt = q.name || 'quiz image';
    el.questionImage.classList.remove('hidden');

    // Build textual choices. Prefer distractors that also have images (so choices are consistent),
    // but fall back to all item names if not enough imaged items exist.
    const correct = q.name;
    const choices = pickNameChoicesFromImageItems(q.category, correct, MAX_OPTIONS);
    buildOptionsAndHook(choices, correct, {q});
  } else {
    el.questionText.textContent = 'Unknown question type';
  }
}

// Helpers for building option UI and submit handling
function buildOptionsAndHook(choices, correct, meta = {}) {
  // choices is an array of strings (labels)
  const shuffled = shuffleArray([...choices]);
  el.answersForm.innerHTML = shuffled.map((c, idx) => `
    <label class="answer-option">
      <input type="radio" name="answer" value="${escapeAttr(c)}" />
      <span>${escapeHtml(c)}</span>
    </label>
  `).join('');
  hookSubmit((selectedValue) => {
    const chosen = selectedValue;
    if (chosen === correct) {
      handleCorrect();
    } else {
      let detail = '';
      const q = meta.q;
      if (!q) {
        detail = `Wrong — correct: ${correct}.`;
      } else if (q.type === 'name->property') {
        detail = `Wrong — the correct ${propLabel(q.property)} for ${q.name} is “${correct}”.`;
      } else if (q.type === 'property->name') {
        detail = `Wrong — ${propLabel(q.property)} = "${q.value}" belongs to ${correct}.`;
      } else if (q.type === 'properties->name') {
        const display = q.properties.map((p,i) => `${propLabel(p)}: "${q.valueTuple[i]}"`).join(' ; ');
        detail = `Wrong — the combination (${display}) belongs to ${correct}.`;
      } else if (q.type === 'image->name') {
        // Show what the user actually selected and also indicate the correct name
        detail = `Wrong — ${correct} is what was shown here`;
      } else {
        detail = `Wrong — correct: ${correct}.`;
      }
      handleWrong(detail);
    }
  });
}

function hookSubmit(onSubmit) {
  // Do NOT replace the form node — that can remove the radio inputs just rendered.
  // Instead remove any existing submit buttons inside the form and append a single one.
  try {
    const existingBtns = el.answersForm.querySelectorAll('button.submit-btn');
    existingBtns.forEach(b => b.remove());

    const submitBtn = document.createElement('button');
    submitBtn.className = 'btn primary submit-btn';
    submitBtn.type = 'button';
    submitBtn.textContent = 'Submit';
    submitBtn.style.marginTop = '12px';
    submitBtn.dataset.answered = 'false';

    el.answersForm.appendChild(submitBtn);

    submitBtn.addEventListener('click', () => {
      if (submitBtn.dataset.answered === 'true') {
        nextQuestion();
        return;
      }

      const selected = el.answersForm.querySelector('input[name="answer"]:checked');
      if (!selected) {
        showToast('Pick an answer first.');
        return;
      }
      const val = selected.value;

      // Disable inputs to prevent multiple scoring
      const inputs = Array.from(el.answersForm.querySelectorAll('input[name="answer"]'));
      inputs.forEach(i => i.disabled = true);

      submitBtn.dataset.answered = 'true';

      try {
        onSubmit(val);
      } catch (err) {
        console.error('onSubmit handler error', err);
      }

      submitBtn.textContent = 'Next';
      el.nextBtn.disabled = false;
    });
  } catch (err) {
    console.error('hookSubmit error', err);
  }
}

// Correct/wrong handlers
function handleCorrect() {
  sessionScore += 1;
  sessionStreak += 1;
  if (sessionStreak > bestStreak) {
    bestStreak = sessionStreak;
    localStorage.setItem('quiz_highscore', bestStreak);
  }
  updateScoreUI(true);
  el.feedback.innerHTML = `<div class="correct">Correct! 🔥 Streak: ${sessionStreak}</div>`;
}

function handleWrong(detailText) {
  sessionStreak = 0;
  updateScoreUI(false);
  el.feedback.innerHTML = `<div class="wrong">Wrong — ${escapeHtml(detailText)}</div>`;
}

// UI updates
function updateScoreUI(justScored) {
  el.score.textContent = sessionScore;
  el.streak.textContent = sessionStreak;
  el.highscore.textContent = bestStreak;
}

// Utilities for picking distractors
function pickNameChoices(category, correctName, count=4) {
  const items = (rawData[category] || []).map(it => it.name);
  const others = items.filter(n => n !== correctName);
  const picks = shuffleArray(others).slice(0, count-1);
  picks.push(correctName);
  return shuffleArray(picks);
}

// Prefer distractors that have images (so image->name choices come from image-enabled items).
// Fallback to pickNameChoices if not enough imaged items exist.
function pickNameChoicesFromImageItems(category, correctName, count=4) {
  const items = rawData[category] || [];
  const withImages = items.filter(it => it.image).map(it => it.name);
  let pool = withImages.length >= (count - 1) ? withImages : items.map(it => it.name);
  // Ensure we include correctName and produce up to `count` choices
  const others = pool.filter(n => n !== correctName);
  const picks = shuffleArray(others).slice(0, count-1);
  picks.push(correctName);
  return shuffleArray(picks);
}

function pickPropertyChoices(category, property, correctValue, count=4) {
  const vals = Array.from(new Set((rawData[category] || []).map(it => it[property]).filter(v => v !== undefined && v !== null)));
  const others = vals.filter(v => v !== correctValue);
  const picks = shuffleArray(others).slice(0, count-1);
  picks.push(correctValue);
  return shuffleArray(picks);
}

function getItemsWithImages(category) {
  return (rawData[category] || []).filter(it => it.image);
}

// helpers
function showToast(msg) {
  console.info(msg);
  el.feedback.innerHTML = `<div style="color:var(--muted)">${escapeHtml(msg)}</div>`;
  setTimeout(() => {
    if (el.feedback.innerHTML.includes(msg)) el.feedback.innerHTML = '';
  }, 3000);
}

function showFatal(msg) {
  const container = document.querySelector('.container');
  container.innerHTML = `<div style="padding:20px;background:#fff0f0;border-radius:10px;color:${getComputedStyle(document.documentElement).getPropertyValue('--danger')};">${escapeHtml(msg)}</div>`;
}

function propLabel(p) {
  return p.replace(/_/g, ' ');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--) {
    const j = Math.floor(Math.random()*(i+1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function dedupeQuestions(arr) {
  const seen = new Set();
  return arr.filter(q => {
    const id = JSON.stringify([q.type, q.category, q.property || q.properties || q.name || '', q.value || q.valueTuple || q.correct || '']);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function combinations(arr, k) {
  const res = [];
  const n = arr.length;
  function go(start, path) {
    if (path.length === k) {
      res.push(path.slice());
      return;
    }
    for (let i=start;i<n;i++) {
      path.push(arr[i]);
      go(i+1, path);
      path.pop();
    }
  }
  go(0, []);
  return res;
}
