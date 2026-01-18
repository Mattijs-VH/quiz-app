// ============================================================
//  QUIZ APP — Refactored Version (Part 1)
//  Supports multi-image items with random selection per question
//  Fully backward compatible with "image" fields
//  No HTML/CSS changes required
//  Added: optional typed-answer mode for "name" answers (case-insensitive)
//  Fix: prevent form submit reload and handle Enter in text input
//  Added: per-category typed-answer metadata support and per-category % controls
//  Update: categories not present in _meta behave as if typed: false
//  Update: attempt to avoid browser autofill for typed inputs (randomized input name,
//          autocomplete/off, autocapitalize/off, spellcheck=false)
//  Update: accept typed answers that are one edit away (insertion/deletion/replacement)
//  Update: when a fuzzy match is accepted, show feedback with the correct spelling
// ============================================================

const DATA_PATH = 'data.json';
const MAX_OPTIONS = 4;
// Default probability that a "name" answer question will ask for typed input instead of multiple-choice (0..1)
const TYPED_ANSWER_PROB = 0.25;

// ------------------------------------------------------------
//  GLOBAL STATE
// ------------------------------------------------------------
let rawData = {};
let selectedCategories = [];
let questionPool = [];
let currentSessionQuestions = [];
let currentQuestionIndex = -1;

let sessionScore = 0;
let sessionStreak = 0;
let bestStreak = Number(localStorage.getItem('quiz_highscore') || 0);

// per-category typed entry probability (values 0..1)
const typedProbByCategory = {};

// category metadata read from data._meta (or empty)
let categoryMeta = {};

// ------------------------------------------------------------
//  DOM ELEMENTS
// ------------------------------------------------------------
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

// ------------------------------------------------------------
//  INITIALIZATION
// ------------------------------------------------------------
init();

async function init() {
  try {
    rawData = await fetchJSON(DATA_PATH);
  } catch (err) {
    showFatal(`Could not load ${DATA_PATH}. Ensure it exists and is valid JSON.`);
    console.error(err);
    return;
  }

  // load category metadata (optional)
  categoryMeta = rawData._meta || {};

  buildCategoryCheckboxes(Object.keys(rawData).filter(k => k !== '_meta'));
  el.highscore.textContent = bestStreak;

  el.startBtn.addEventListener('click', startQuiz);
  el.nextBtn.addEventListener('click', nextQuestion);
  el.endBtn.addEventListener('click', endSession);

  // Prevent the answers form from performing a full-page submit (Enter key)
  el.answersForm.addEventListener('submit', e => {
    e.preventDefault();
  });
  // Try to disable browser autofill by turning off autocomplete for the form
  // (browsers sometimes ignore this, but combined with randomized input names it helps)
  el.answersForm.setAttribute('autocomplete', 'off');
}

// ------------------------------------------------------------
//  DATA LOADING
// ------------------------------------------------------------
async function fetchJSON(path) {
  const resp = await fetch(path, { cache: 'no-cache' });
  if (!resp.ok) throw new Error('Failed to fetch JSON');
  return resp.json();
}

// ------------------------------------------------------------
//  CATEGORY CHECKBOXES
//  - Supports optional rawData._meta[category] = { typed: true, typedProbability: 0.3 }
//  - When typed:true is present, a small percentage input appears next to the checkbox.
//  - Categories not present in _meta are treated as typed: false (no control shown).
// ------------------------------------------------------------
function buildCategoryCheckboxes(categories) {
  el.categories.innerHTML = '';

  const metaRoot = categoryMeta;

  categories.forEach(cat => {
    const id = `cat_${cat}`;
    const wrapper = document.createElement('label');
    wrapper.className = 'category';

    // Check if this category has typed-answer metadata and is enabled
    const meta = metaRoot[cat];
    const enabledForTyped = Boolean(meta && meta.typed);

    // Determine initial percentage (0..100). Only relevant when enabledForTyped === true
    const initialPct = normalizeMetaProbToPct(meta && meta.typedProbability, TYPED_ANSWER_PROB);

    // store initial in typedProbByCategory as fraction only if enabled
    if (enabledForTyped) {
      typedProbByCategory[cat] = pctToFraction(initialPct);
    }

    // Build inner HTML. If meta indicates typed support, include a small numeric control (hidden unless checked).
    wrapper.innerHTML = `
      <input type="checkbox" id="${id}" data-cat="${cat}" />
      <span style="margin-right:8px;">${capitalize(cat)}</span>
      ${enabledForTyped ? `
        <span class="typed-control" style="margin-left:6px; font-size:0.9em; color:var(--muted);">
          <input
            type="number"
            class="typed-prob"
            data-cat="${cat}"
            min="0"
            max="100"
            step="5"
            value="${escapeAttr(String(initialPct))}"
            title="Percent of questions that will require typed answers for this set"
            style="width:64px; padding:4px; margin-right:4px; border-radius:6px; border:1px solid #ddd;"
            disabled
          />
          %
        </span>
      ` : ''}
    `;

    el.categories.appendChild(wrapper);

    // Wire up the checkbox to enable the control when selected
    const checkbox = wrapper.querySelector('input[type="checkbox"]');
    const probInput = wrapper.querySelector('input.typed-prob');

    if (probInput) {
      // Enable the input only when checkbox is checked (user wanted this category)
      checkbox.addEventListener('change', () => {
        probInput.disabled = !checkbox.checked;
      });

      // Ensure initial disabled state (checkbox unchecked by default)
      probInput.disabled = true;

      // Update typedProbByCategory when user changes the percentage
      probInput.addEventListener('input', () => {
        const v = Number(probInput.value);
        if (Number.isNaN(v)) return;
        const clamped = Math.max(0, Math.min(100, Math.round(v)));
        probInput.value = String(clamped);
        typedProbByCategory[cat] = pctToFraction(clamped);
      });

      // Also handle blur to normalize/validate
      probInput.addEventListener('blur', () => {
        const v = Number(probInput.value);
        if (Number.isNaN(v)) {
          const pct = Math.round(fractionToPct(typedProbByCategory[cat] ?? TYPED_ANSWER_PROB));
          probInput.value = String(pct);
        } else {
          const clamped = Math.max(0, Math.min(100, Math.round(v)));
          probInput.value = String(clamped);
          typedProbByCategory[cat] = pctToFraction(clamped);
        }
      });
    }
  });
}

// Helper: normalize metadata probability into integer percentage 0..100
function normalizeMetaProbToPct(metaVal, fallbackFraction) {
  if (metaVal === undefined || metaVal === null) {
    return Math.round(fallbackFraction * 100);
  }
  const n = Number(metaVal);
  if (Number.isNaN(n)) return Math.round(fallbackFraction * 100);
  // accept either fraction (0..1) or percentage (0..100)
  if (n > 1) return Math.max(0, Math.min(100, Math.round(n)));
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}
function pctToFraction(pct) {
  return Math.max(0, Math.min(1, Number(pct) / 100));
}
function fractionToPct(frac) {
  return Math.round((frac || 0) * 100);
}

// ------------------------------------------------------------
//  START / END SESSION
// ------------------------------------------------------------
function startQuiz() {
  selectedCategories = Array.from(
    el.categories.querySelectorAll('input[type="checkbox"]:checked')
  ).map(i => i.dataset.cat);

  if (selectedCategories.length === 0) {
    showToast('Please select at least one category.');
    return;
  }

  // Ensure typedProbByCategory has entries for selected categories only if categoryMeta enables it.
  selectedCategories.forEach(cat => {
    const meta = categoryMeta[cat];
    if (meta && meta.typed) {
      // If there's a numeric input in the UI, prefer that value (it's already wired to update typedProbByCategory)
      const input = el.categories.querySelector(`input.typed-prob[data-cat="${cat}"]`);
      if (input && input.value !== '') {
        typedProbByCategory[cat] = pctToFraction(Number(input.value));
      } else if (typedProbByCategory[cat] === undefined) {
        // fall back to meta specified probability or global
        typedProbByCategory[cat] = (typeof meta.typedProbability === 'number')
          ? (meta.typedProbability > 1 ? pctToFraction(meta.typedProbability) : meta.typedProbability)
          : TYPED_ANSWER_PROB;
      }
    } else {
      // category not enabled for typing -> ensure it's treated as typed:false
      typedProbByCategory[cat] = 0;
    }
  });

  buildQuestionPool();

  const n = Math.max(1, parseInt(el.numQuestions.value || '20', 10));
  currentSessionQuestions = shuffleArray(questionPool).slice(0, n);

  if (currentSessionQuestions.length === 0) {
    showToast('No valid questions available for these categories.');
    return;
  }

  sessionScore = 0;
  sessionStreak = 0;
  el.score.textContent = sessionScore;
  el.streak.textContent = sessionStreak;
  el.highscore.textContent = bestStreak;

  currentQuestionIndex = -1;
  document.getElementById('setup').classList.add('hidden');
  el.quizArea.classList.remove('hidden');

  nextQuestion();
}

function endSession() {
  document.getElementById('setup').classList.remove('hidden');
  el.quizArea.classList.add('hidden');
}

// ------------------------------------------------------------
//  MULTI-IMAGE SUPPORT HELPERS
// ------------------------------------------------------------
function hasImages(item) {
  return (
    (Array.isArray(item.images) && item.images.length > 0) ||
    typeof item.image === 'string'
  );
}

function pickRandomImage(item) {
  if (Array.isArray(item.images) && item.images.length > 0) {
    return item.images[Math.floor(Math.random() * item.images.length)];
  }
  if (item.image) return item.image; // backward compatibility
  return null;
}

// ------------------------------------------------------------
//  UNIQUE PROPERTY COMBINATIONS
// ------------------------------------------------------------
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
          if ((it[combo[i]] ?? null) !== tuple[i]) {
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

// ------------------------------------------------------------
//  QUESTION POOL GENERATION
// ------------------------------------------------------------
function buildQuestionPool() {
  questionPool = [];

  for (const cat of Object.keys(rawData)) {
    if (cat === '_meta') continue;
    if (!selectedCategories.includes(cat)) continue;

    const items = rawData[cat] || [];
    if (!Array.isArray(items) || items.length === 0) continue;

    const sample = items[0];
    const allProps = Object.keys(sample).filter(
      k => k !== 'name' && k !== 'image' && k !== 'images'
    );

    // Build frequency maps
    const propValueMap = {};
    for (const p of allProps) {
      propValueMap[p] = {};
      for (const it of items) {
        const val = it[p] ?? null;
        if (!propValueMap[p][val]) propValueMap[p][val] = [];
        propValueMap[p][val].push(it);
      }
    }

    // property -> name
    for (const p of allProps) {
      for (const val of Object.keys(propValueMap[p])) {
        const arr = propValueMap[p][val];
        if (val === 'null' || val === null) continue;
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

    // name -> property
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

    // property combinations
    for (const it of items) {
      const combo = findUniquePropertyCombo(it, items, allProps, 3, 2);
      if (combo) {
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

    // IMAGE-BASED QUESTIONS
    const itemsWithImages = items.filter(it => hasImages(it));

    // name -> image
    if (itemsWithImages.length >= 2) {
      for (const it of itemsWithImages) {
        questionPool.push({
          category: cat,
          type: 'name->image',
          name: it.name,
          correctImage: pickRandomImage(it),
          sourceItem: it
        });
      }
    }

    // image -> name
    if (itemsWithImages.length >= 2) {
      for (const it of itemsWithImages) {
        questionPool.push({
          category: cat,
          type: 'image->name',
          name: it.name,
          image: pickRandomImage(it),
          sourceItem: it
        });
      }
    }
  }

  questionPool = dedupeQuestions(questionPool);
  questionPool = shuffleArray(questionPool);
}

// ------------------------------------------------------------
//  NAVIGATION
// ------------------------------------------------------------
function nextQuestion() {
  el.nextBtn.disabled = true;
  el.feedback.innerHTML = '';

  currentQuestionIndex++;

  if (currentQuestionIndex >= currentSessionQuestions.length) {
    finishSession();
    return;
  }

  const q = currentSessionQuestions[currentQuestionIndex];
  renderQuestion(q, currentQuestionIndex + 1, currentSessionQuestions.length);
}

// ------------------------------------------------------------
//  SESSION FINISH
// ------------------------------------------------------------
function finishSession() {
  showToast(
    `Session finished. Score ${sessionScore}/${currentSessionQuestions.length}. Best streak: ${bestStreak}`
  );

  el.feedback.innerHTML = `
    <div class="correct">
      Session finished — Score ${sessionScore}/${currentSessionQuestions.length}. Best streak: ${bestStreak}
    </div>
  `;

  const existingBtns = el.answersForm.querySelectorAll('button.submit-btn');
  existingBtns.forEach(b => b.remove());

  const endBtn = document.createElement('button');
  endBtn.className = 'btn primary submit-btn';
  endBtn.type = 'button';
  endBtn.textContent = 'End Session';
  endBtn.style.marginTop = '12px';
  endBtn.addEventListener('click', endSession);

  el.answersForm.appendChild(endBtn);
}
// ============================================================
//  QUIZ APP — Refactored Version (Part 2)
//  Rendering, submit logic, scoring, utilities, zoom modal
//  Added typed answer rendering + handling
// ============================================================

// ------------------------------------------------------------
//  QUESTION RENDERING
// ------------------------------------------------------------
function renderQuestion(q, index, total) {
  el.qIndex.textContent = `Question ${index}/${total} — Category: ${capitalize(q.category)}`;
  el.answersForm.innerHTML = '';
  el.questionImage.classList.add('hidden');
  el.questionImage.src = '';

  if (q.type === 'property->name') {
    renderPropertyToName(q);
  } else if (q.type === 'name->property') {
    renderNameToProperty(q);
  } else if (q.type === 'properties->name') {
    renderPropertiesToName(q);
  } else if (q.type === 'name->image') {
    renderNameToImage(q);
  } else if (q.type === 'image->name') {
    renderImageToName(q);
  } else {
    el.questionText.textContent = 'Unknown question type';
  }
}

function renderPropertyToName(q) {
  el.questionText.textContent =
    `Which ${q.category} has ${propLabel(q.property)} = "${q.value}"?`;
  const correct = q.correct;

  // Use per-category probability if available
  if (shouldUseTypedEntry(q.category)) {
    renderTypedNameQuestion(correct, { q });
    return;
  }

  const choices = pickNameChoices(q.category, correct, MAX_OPTIONS);
  buildOptionsAndHook(choices, correct, { q });
}

function renderNameToProperty(q) {
  el.questionText.textContent =
    `Which ${propLabel(q.property)} belongs to ${q.name}?`;
  const correct = q.correct;
  const choices = pickPropertyChoices(q.category, q.property, correct, MAX_OPTIONS);
  buildOptionsAndHook(choices, correct, { q });
}

function renderPropertiesToName(q) {
  const display = q.properties
    .map((p, i) => `${propLabel(p)}: "${q.valueTuple[i]}"`)
    .join(' ; ');

  el.questionText.textContent =
    `Which ${q.category} matches — ${display}?`;

  const correct = q.correct;

  if (shouldUseTypedEntry(q.category)) {
    renderTypedNameQuestion(correct, { q });
    return;
  }

  const choices = pickNameChoices(q.category, correct, MAX_OPTIONS);
  buildOptionsAndHook(choices, correct, { q });
}

function renderNameToImage(q) {
  el.questionText.textContent = `Which image shows ${q.name}?`;

  const candidates = getItemsWithImages(q.category);
  const shuffled = shuffleArray(candidates);

  // Each option gets a random image from that item
  const choices = shuffled.slice(0, MAX_OPTIONS).map(it => ({
    label: it.name,
    image: pickRandomImage(it)
  }));

  // Ensure the correct image/name pair is present
  const correctImage = pickRandomImage(q.sourceItem) || q.correctImage;
  if (!choices.find(c => c.label === q.name)) {
    if (choices.length < MAX_OPTIONS) {
      choices.push({ label: q.sourceItem.name, image: correctImage });
    } else {
      choices[0] = { label: q.sourceItem.name, image: correctImage };
    }
  }

  const final = shuffleArray(choices);

  el.answersForm.innerHTML = final.map(c => `
    <label class="answer-option" style="display:inline-block; margin:6px; text-align:center;">
      <input
        type="radio"
        name="answer"
        value="${escapeAttr(c.label)}"
        aria-label="${escapeAttr(c.label)}"
      />
      <img
        src="${escapeAttr(c.image)}"
        alt="${escapeAttr(c.label)}"
        style="display:block; max-width:120px; max-height:90px; margin-top:6px; border-radius:6px; border:1px solid #eef2ff;"
      />
    </label>
  `).join('');

  hookSubmit(selected => {
    const chosen = selected;
    const correctName = q.name;
    if (chosen === correctName) {
      handleCorrect();
    } else {
      handleWrong(`you selected “${escapeHtml(chosen)}”.`);
    }
  });
}

function renderImageToName(q) {
  el.questionText.textContent = `Which ${q.category} is shown?`;

  const imgSrc = pickRandomImage(q.sourceItem) || q.image;
  el.questionImage.src = imgSrc;
  el.questionImage.alt = q.name || 'quiz image';
  el.questionImage.classList.remove('hidden');

  const correct = q.name;

  if (shouldUseTypedEntry(q.category)) {
    renderTypedNameQuestion(correct, { q });
    return;
  }

  const choices = pickNameChoicesFromImageItems(q.category, correct, MAX_OPTIONS);
  buildOptionsAndHook(choices, correct, { q });
}

// ------------------------------------------------------------
//  ANSWER OPTIONS + SUBMIT HANDLING
// ------------------------------------------------------------
function buildOptionsAndHook(choices, correct, meta = {}) {
  const shuffled = shuffleArray([...choices]);

  el.answersForm.innerHTML = shuffled.map(c => `
    <label class="answer-option">
      <input type="radio" name="answer" value="${escapeAttr(c)}" />
      <span>${escapeHtml(c)}</span>
    </label>
  `).join('');

  hookSubmit(selectedValue => {
    const chosen = selectedValue;
    const q = meta.q;

    if (chosen === correct) {
      handleCorrect();
    } else {
      let detail = '';

      if (!q) {
        detail = `Wrong — correct: ${correct}.`;
      } else if (q.type === 'name->property') {
        detail = `Wrong — the correct ${propLabel(q.property)} for ${q.name} is “${correct}”.`;
      } else if (q.type === 'property->name') {
        detail = `Wrong — ${propLabel(q.property)} = "${q.value}" belongs to ${correct}.`;
      } else if (q.type === 'properties->name') {
        const display = q.properties
          .map((p, i) => `${propLabel(p)}: "${q.valueTuple[i]}"`)
          .join(' ; ');
        detail = `Wrong — the combination (${display}) belongs to ${correct}.`;
      } else if (q.type === 'image->name') {
        detail = `Wrong — ${correct} is what was shown here.`;
      } else {
        detail = `Wrong — correct: ${correct}.`;
      }

      handleWrong(detail);
    }
  });
}

// New: render a typed input for "name" answers (case-insensitive)
// This version uses a randomized input name and class "typed-answer-input" and sets autocomplete/off
function renderTypedNameQuestion(correctName, meta = {}) {
  // simple accessible form: a text input and submit button
  const placeholder = 'Type the name here';

  // generate a randomized input name to avoid matching browser-saved values
  const rndName = `typedAnswer_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  el.answersForm.innerHTML = `
    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
      <label style="flex:1; min-width:200px;">
        <input
          type="text"
          class="typed-answer-input"
          name="${escapeAttr(rndName)}"
          placeholder="${escapeAttr(placeholder)}"
          aria-label="Type your answer"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          style="width:100%; padding:8px; border-radius:6px; border:1px solid #ddd;"
        />
      </label>
    </div>
  `;

  // hookTextSubmit will query the input by class .typed-answer-input
  hookTextSubmit(val => {
    const q = meta.q;
    const chosenRaw = val;
    if (chosenRaw === null || chosenRaw === undefined) {
      showToast('Pick an answer first.');
      return;
    }

    const chosen = String(chosenRaw).trim();

    // Compare using fuzzy check which distinguishes exact vs fuzzy matches
    const cmp = compareAnswers(chosen, correctName);
    if (cmp === 'exact') {
      handleCorrect();
    } else if (cmp === 'fuzzy') {
      // accepted because within one edit: show correct spelling in the positive feedback
      handleCorrect(correctName);
    } else {
      // Show the correct answer when typed answer is wrong
      handleWrong(`you typed “${escapeHtml(chosen)}”. The correct answer is "${escapeHtml(correctName)}".`);
    }
  });
}

// Existing hookSubmit for choice inputs (radios)
function hookSubmit(onSubmit) {
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

      const inputs = Array.from(
        el.answersForm.querySelectorAll('input[name="answer"]')
      );
      inputs.forEach(i => (i.disabled = true));

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

// New: hook for typed text entry questions
// This queries the input by class ".typed-answer-input" (instead of stable name) to avoid browser autofill matching.
function hookTextSubmit(onSubmit) {
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

    // Query the input that was rendered and wire Enter to submit
    const input = el.answersForm.querySelector('.typed-answer-input');
    if (input) {
      // pressing Enter triggers the same submit flow (and prevented from reloading)
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitBtn.click();
        }
      });
    }

    submitBtn.addEventListener('click', () => {
      if (submitBtn.dataset.answered === 'true') {
        nextQuestion();
        return;
      }

      const inputNow = el.answersForm.querySelector('.typed-answer-input');
      if (!inputNow) {
        showToast('No input found.');
        return;
      }

      const val = inputNow.value;

      if (!val || val.trim() === '') {
        showToast('Type an answer first.');
        return;
      }

      // disable input after answering
      inputNow.disabled = true;
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
    console.error('hookTextSubmit error', err);
  }
}

// ------------------------------------------------------------
//  SCORING / FEEDBACK
// ------------------------------------------------------------
// note: `note` is optional. When provided it is used to show the correct spelling in the feedback.
function handleCorrect(note) {
  sessionScore += 1;
  sessionStreak += 1;

  if (sessionStreak > bestStreak) {
    bestStreak = sessionStreak;
    localStorage.setItem('quiz_highscore', bestStreak);
  }

  updateScoreUI();

  if (note) {
    el.feedback.innerHTML =
      `<div class="correct">Correct! 🔥 Streak: ${sessionStreak}. Correct spelling: "${escapeHtml(note)}"</div>`;
  } else {
    el.feedback.innerHTML =
      `<div class="correct">Correct! 🔥 Streak: ${sessionStreak}</div>`;
  }
}

function handleWrong(detailText) {
  sessionStreak = 0;
  updateScoreUI();
  el.feedback.innerHTML =
    `<div class="wrong">Wrong — ${escapeHtml(detailText)}</div>`;
}

function updateScoreUI() {
  el.score.textContent = sessionScore;
  el.streak.textContent = sessionStreak;
  el.highscore.textContent = bestStreak;
}

// ------------------------------------------------------------
//  CHOICE GENERATION HELPERS
// ------------------------------------------------------------
function pickNameChoices(category, correctName, count = 4) {
  const items = (rawData[category] || []).map(it => it.name);
  const others = items.filter(n => n !== correctName);
  const picks = shuffleArray(others).slice(0, count - 1);
  picks.push(correctName);
  return shuffleArray(picks);
}

function pickNameChoicesFromImageItems(category, correctName, count = 4) {
  const items = rawData[category] || [];
  const withImages = items.filter(it => hasImages(it)).map(it => it.name);

  const pool =
    withImages.length >= count - 1 ? withImages : items.map(it => it.name);

  const others = pool.filter(n => n !== correctName);
  const picks = shuffleArray(others).slice(0, count - 1);
  picks.push(correctName);
  return shuffleArray(picks);
}

function pickPropertyChoices(category, property, correctValue, count = 4) {
  const vals = Array.from(
    new Set(
      (rawData[category] || [])
        .map(it => it[property])
        .filter(v => v !== undefined && v !== null)
    )
  );

  const others = vals.filter(v => v !== correctValue);
  const picks = shuffleArray(others).slice(0, count - 1);
  picks.push(correctValue);
  return shuffleArray(picks);
}

function getItemsWithImages(category) {
  return (rawData[category] || []).filter(it => hasImages(it));
}

// ------------------------------------------------------------
//  GENERIC UTILITIES
// ------------------------------------------------------------
function showToast(msg) {
  console.info(msg);
  el.feedback.innerHTML =
    `<div style="color:var(--muted)">${escapeHtml(msg)}</div>`;
  setTimeout(() => {
    if (el.feedback.innerHTML.includes(msg)) {
      el.feedback.innerHTML = '';
    }
  }, 3000);
}

function showFatal(msg) {
  const container = document.querySelector('.container');
  container.innerHTML = `
    <div
      style="padding:20px;background:#fff0f0;border-radius:10px;
             color:${getComputedStyle(document.documentElement)
               .getPropertyValue('--danger')};">
      ${escapeHtml(msg)}
    </div>`;
}

function propLabel(p) {
  return p.replace(/_/g, ' ');
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function dedupeQuestions(arr) {
  const seen = new Set();
  return arr.filter(q => {
    const id = JSON.stringify([
      q.type,
      q.category,
      q.property || q.properties || q.name || '',
      q.value || q.valueTuple || q.correct || ''
    ]);
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
    for (let i = start; i < n; i++) {
      path.push(arr[i]);
      go(i + 1, path);
      path.pop();
    }
  }

  go(0, []);
  return res;
}

// Helper: decide whether to show typed entry for a name-answer question
// Uses per-category probability only if that category is enabled in categoryMeta.
// Categories not present in categoryMeta or without typed:true will never show typed entry.
function shouldUseTypedEntry(category) {
  const meta = categoryMeta[category];
  if (!meta || !meta.typed) return false;
  const p = typedProbByCategory[category];
  const prob = (typeof p === 'number' && !Number.isNaN(p)) ? p : TYPED_ANSWER_PROB;
  return Math.random() < prob;
}

// ------------------------------------------------------------
//  FUZZY MATCH (allow one edit: insert/delete/replace)
// ------------------------------------------------------------
// Normalize strings: trim, lower-case and remove diacritics
function normalizeForCompare(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .trim()
    .toLowerCase();
}

// Compare answers and distinguish exact vs fuzzy vs no match
// returns 'exact' | 'fuzzy' | 'no'
function compareAnswers(a, b) {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (x === y) return 'exact';
  if (isEditDistanceAtMostOne(x, y)) return 'fuzzy';
  return 'no';
}

// Linear-time check whether edit distance <= 1 (supports insertion, deletion, replacement)
function isEditDistanceAtMostOne(s, t) {
  const n = s.length;
  const m = t.length;
  if (Math.abs(n - m) > 1) return false;

  // if lengths equal => check for at most one replacement
  if (n === m) {
    let diff = 0;
    for (let i = 0; i < n; i++) {
      if (s[i] !== t[i]) {
        diff++;
        if (diff > 1) return false;
      }
    }
    return diff <= 1;
  }

  // ensure s is the shorter
  if (n > m) return isEditDistanceAtMostOne(t, s);

  // now m = n+1: check if you can insert one char into s to make t
  let i = 0, j = 0;
  let skipped = false;
  while (i < n && j < m) {
    if (s[i] === t[j]) {
      i++; j++;
    } else {
      if (skipped) return false;
      skipped = true;
      j++; // skip one char in longer string
    }
  }
  return true; // either matched with <=1 skip or reached end
}

// ------------------------------------------------------------
//  IMAGE ZOOM / DRAG / SCROLL
// ------------------------------------------------------------
let currentScale = 1;
let isDragging = false;
let startX, startY, imgX = 0, imgY = 0;

const modal = document.getElementById('imgModal');
const zoomImg = document.getElementById('zoomImg');

document.addEventListener('click', e => {
  const img = e.target.closest('img');
  if (!img || !img.src) return;

  zoomImg.src = img.src;
  currentScale = 1;
  imgX = 0;
  imgY = 0;
  zoomImg.style.transform = 'translate(0px, 0px) scale(1)';

  modal.style.display = 'flex';
});

modal.addEventListener('click', e => {
  if (e.target === modal) {
    modal.style.display = 'none';
  }
});

zoomImg.addEventListener('mousedown', e => {
  isDragging = true;
  startX = e.clientX - imgX;
  startY = e.clientY - imgY;
});

document.addEventListener('mouseup', () => {
  isDragging = false;
});

document.addEventListener('mousemove', e => {
  if (!isDragging) return;
  imgX = e.clientX - startX;
  imgY = e.clientY - startY;
  zoomImg.style.transform = `translate(${imgX}px, ${imgY}px) scale(${currentScale})`;
});

zoomImg.addEventListener('wheel', e => {
  e.preventDefault();
  const scaleAmount = e.deltaY < 0 ? 0.1 : -0.1;
  currentScale = Math.min(Math.max(0.2, currentScale + scaleAmount), 5);
  zoomImg.style.transform = `translate(${imgX}px, ${imgY}px) scale(${currentScale})`;
});
