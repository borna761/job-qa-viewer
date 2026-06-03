let allPairs = [];
let categories = [];
let companies  = [];
let searchQuery = '';
let sortableInstances = [];
let activeCategory = null;
let activeCompany  = null;

// ---- Add-panel helpers ----

function populateAddPanelSelects() {
  const catSel = document.getElementById('new-category');
  catSel.innerHTML = `<option value="">Auto-categorise</option>` +
    categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

  const srcSel = document.getElementById('new-source');
  srcSel.innerHTML = companies
    .map(c => `<option value="${esc(c.file)}">${esc(c.name)}</option>`).join('');
}

function highlightNewCard(id) {
  const card = document.querySelector(`.qa-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('newly-added');
  card.addEventListener('animationend', () => card.classList.remove('newly-added'), { once: true });
}

// ---- Utilities ----

function esc(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlight(text, q) {
  if (!q) return esc(text);
  const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return esc(text).replace(new RegExp(`(${safe})`, 'gi'), '<mark>$1</mark>');
}

function countLabel(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const w = trimmed.split(/\s+/).length;
  const c = trimmed.length;
  return `${w.toLocaleString()} ${w === 1 ? 'word' : 'words'} · ${c.toLocaleString()} ${c === 1 ? 'char' : 'chars'}`;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function visiblePairs() {
  const q = searchQuery.toLowerCase();
  return allPairs.filter(p => {
    if (activeCompany && p.source !== activeCompany) return false;
    if (!q) return true;
    return (p.question && p.question.toLowerCase().includes(q)) ||
           p.answer.toLowerCase().includes(q);
  });
}

// ---- Render ----

function render() {
  const main = document.getElementById('main');
  const pairs = visiblePairs();

  if (!pairs.length) {
    main.innerHTML = '<div class="empty">No results.</div>';
    return;
  }

  const grouped = {};
  categories.forEach(c => grouped[c] = []);
  pairs.forEach(p => {
    const cat = p.category || 'Other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  });

  main.innerHTML = categories
    .filter(c => grouped[c] && grouped[c].length > 0)
    .map(cat => `
      <div class="cat-section" data-cat="${esc(cat)}">
        <div class="cat-header">
          <span class="cat-title">${esc(cat)}</span>
          <span class="cat-line"></span>
          <span class="cat-count">${grouped[cat].length}</span>
        </div>
        <div class="qa-list" data-cat="${esc(cat)}">
          ${grouped[cat].map(p => cardHTML(p)).join('')}
        </div>
      </div>
    `).join('');

  attachCardHandlers();
  attachDragHandlers();
}

function catSelectHTML(current) {
  return `<select class="cat-select" title="Category">
    ${categories.map(c => `<option value="${esc(c)}" ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('')}
  </select>`;
}

function sourceSelectHTML(current) {
  return `<select class="source-select card-source-select" title="Company">
    ${companies.map(c => `<option value="${esc(c.name)}" ${c.name === current ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
  </select>`;
}

function cardHTML(p) {
  return `
    <div class="qa-card" data-id="${esc(p.id)}">
      <div class="qa-card-head">
        <svg class="drag-handle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
          <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
          <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
        </svg>
        <div class="qa-question-text ${!p.question ? 'no-question' : ''}">
          ${p.question ? highlight(p.question, searchQuery) : 'General response'}
        </div>
        <div class="card-meta">
          ${catSelectHTML(p.category)}
          ${sourceSelectHTML(p.source)}
          <button class="btn-icon edit-btn" title="Edit">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
              <path d="M15.232 5.232 18.768 8.768M3 21l3.75-.75L18.232 8.768a2 2 0 0 0-2.536-2.536L3 17.25 3 21Z"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="qa-card-body">
        <div class="qa-answer-text">${highlight(p.answer, searchQuery)}</div>
        <div class="answer-count">${countLabel(p.answer)}</div>
      </div>
    </div>
  `;
}

// ---- Card handlers ----

function attachCardHandlers() {
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      enterEditMode(btn.closest('.qa-card'));
    });
  });

  document.querySelectorAll('.cat-select').forEach(sel => {
    sel.addEventListener('mousedown', e => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const card = sel.closest('.qa-card');
      const p = allPairs.find(x => x.id === card.dataset.id);
      p.category = sel.value;
      await saveOrder();
      render();
    });
  });

  document.querySelectorAll('.card-source-select').forEach(sel => {
    sel.addEventListener('mousedown', e => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const card = sel.closest('.qa-card');
      const p = allPairs.find(x => x.id === card.dataset.id);
      const oldSource = p.source;
      const newSource = sel.value;
      if (oldSource === newSource) return;
      const fromComp = companies.find(c => c.name === oldSource);
      const toComp   = companies.find(c => c.name === newSource);
      if (!fromComp || !toComp) return;
      const res = await fetch('/api/move-entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromFile: fromComp.file, toFile: toComp.file, id: p.id }),
      });
      if (res.ok) {
        p.source   = newSource;
        p.filePath = p.filePath.slice(0, -fromComp.file.length) + toComp.file;
        await saveOrder();
        showToast(`Moved to ${newSource}`);
        render();
        renderSidebar();
      } else {
        sel.value = oldSource;
        showToast('Error moving entry');
      }
    });
  });
}

// ---- Drag & Drop ----

function attachDragHandlers() {
  sortableInstances.forEach(s => s.destroy());
  sortableInstances = [];

  document.querySelectorAll('.qa-list').forEach(list => {
    const instance = Sortable.create(list, {
      group: 'qa',
      handle: '.drag-handle',
      animation: 150,
      ghostClass: 'sortable-ghost',
      dragClass: 'sortable-drag',
      onEnd(evt) {
        const movedId = evt.item.dataset.id;
        const newCat  = evt.to.dataset.cat;
        const movedPair = allPairs.find(p => p.id === movedId);
        if (!movedPair) return;
        movedPair.category = newCat;
        evt.to.querySelectorAll('.qa-card').forEach((el, i) => {
          const p = allPairs.find(x => x.id === el.dataset.id);
          if (p) { p.category = newCat; p.sortIndex = i; }
        });
        saveOrder().then(() => renderSidebar());
      },
    });
    sortableInstances.push(instance);
  });
}

// ---- Order ----

async function saveOrder() {
  const catCounters = {};
  const payload = allPairs.map(p => {
    const cat = p.category;
    if (!(cat in catCounters)) catCounters[cat] = 0;
    p.sortIndex = catCounters[cat]++;
    return { id: p.id, category: cat, sortIndex: p.sortIndex };
  });
  try {
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) showToast('Could not save order');
  } catch {
    showToast('Could not save order — are you offline?');
  }
}

// ---- Edit mode ----

function enterEditMode(card) {
  const p = allPairs.find(x => x.id === card.dataset.id);
  card.classList.add('editing');

  card.querySelector('.qa-card-head').innerHTML = `
    <input class="edit-q" type="text" value="${esc(p.question || '')}" placeholder="Question (optional)">
    <div class="card-meta"><span class="source-badge">${esc(p.source)}</span></div>
  `;
  card.querySelector('.qa-card-body').innerHTML = `
    <textarea class="edit-a">${esc(p.answer)}</textarea>
    <div class="answer-count edit-count">${countLabel(p.answer)}</div>
    <div class="edit-actions">
      <button class="btn btn-secondary cancel-btn">Cancel</button>
      <button class="btn btn-primary save-btn">Save</button>
    </div>
  `;

  const editA = card.querySelector('.edit-a');
  const editCount = card.querySelector('.edit-count');
  editA.addEventListener('input', () => { editCount.textContent = countLabel(editA.value); });

  card.querySelector('.cancel-btn').addEventListener('click', () => render());

  card.querySelector('.save-btn').addEventListener('click', async () => {
    const question = card.querySelector('.edit-q').value.trim() || null;
    const answer   = card.querySelector('.edit-a').value.trim();
    const res = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: p.filePath, id: p.id, question, answer }),
    });
    if (res.ok) {
      const data = await res.json();
      p.question = question;
      p.answer   = answer;
      p.id       = data.newId;
      await saveOrder();
      showToast('Saved');
      render();
    } else {
      showToast('Error saving');
    }
  });
}

// ---- Add panel ----

const addPanel = document.getElementById('add-panel');

document.getElementById('add-toggle').addEventListener('click', () => {
  addPanel.classList.toggle('open');
  if (addPanel.classList.contains('open')) document.getElementById('new-question').focus();
});

const newAnswerCount = document.getElementById('new-answer-count');
document.getElementById('new-answer').addEventListener('input', e => {
  newAnswerCount.textContent = countLabel(e.target.value);
});

document.getElementById('add-cancel').addEventListener('click', () => addPanel.classList.remove('open'));

document.getElementById('add-save').addEventListener('click', async () => {
  const question = document.getElementById('new-question').value.trim() || null;
  const answer   = document.getElementById('new-answer').value.trim();
  const category = document.getElementById('new-category').value || null;
  const source   = document.getElementById('new-source').value   || null;
  if (!answer) { showToast('Answer is required'); return; }

  const res = await fetch('/api/add-general', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, answer, source, category }),
  });

  if (res.ok) {
    const { newId } = await res.json();
    document.getElementById('new-question').value = '';
    document.getElementById('new-answer').value   = '';
    document.getElementById('new-answer-count').textContent = '';
    addPanel.classList.remove('open');
    const data = await fetch('/api/data').then(r => r.json());
    allPairs = data.pairs;
    showToast('Added');
    render();
    renderSidebar();
    if (newId) highlightNewCard(newId);
  } else {
    showToast('Error saving');
  }
});

// ---- Search ----

document.getElementById('search').addEventListener('input', e => {
  searchQuery = e.target.value;
  render();
  renderSidebar();
});

// ---- Sidebar ----

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  const pairs   = visiblePairs();

  // Category counts from currently visible pairs (respects both filters)
  const catCounts = {};
  categories.forEach(c => catCounts[c] = 0);
  pairs.forEach(p => { if (catCounts[p.category] !== undefined) catCounts[p.category]++; });

  // Company counts from search-filtered pairs only (independent of company filter)
  const q = searchQuery.toLowerCase();
  const searchPairs = q
    ? allPairs.filter(p =>
        (p.question && p.question.toLowerCase().includes(q)) ||
        p.answer.toLowerCase().includes(q))
    : allPairs;
  const companyCounts = {};
  companies.forEach(c => companyCounts[c.name] = 0);
  searchPairs.forEach(p => { if (p.source in companyCounts) companyCounts[p.source]++; });

  sidebar.innerHTML = `
    <div class="nav-label">Categories</div>
    <div class="nav-item ${activeCategory === null ? 'active' : ''}" data-cat="">
      <span>All</span><span class="nav-count">${pairs.length}</span>
    </div>
    ${categories.filter(c => catCounts[c] > 0).map(c => `
      <div class="nav-item ${activeCategory === c ? 'active' : ''}" data-cat="${esc(c)}">
        <span>${esc(c)}</span><span class="nav-count">${catCounts[c]}</span>
      </div>
    `).join('')}
    ${companies.length ? `
      <div class="nav-divider"></div>
      <div class="nav-label">Companies</div>
      <div class="nav-item nav-company ${activeCompany === null ? 'active' : ''}" data-company="">
        <span>All</span><span class="nav-count">${searchPairs.length}</span>
      </div>
      ${companies.filter(c => companyCounts[c.name] > 0).map(c => `
        <div class="nav-item nav-company ${activeCompany === c.name ? 'active' : ''}" data-company="${esc(c.name)}">
          <span>${esc(c.name)}</span><span class="nav-count">${companyCounts[c.name]}</span>
        </div>
      `).join('')}
    ` : ''}
  `;

  // Category items — scroll to section
  sidebar.querySelectorAll('.nav-item:not(.nav-company)').forEach(el => {
    el.addEventListener('click', () => {
      const cat = el.dataset.cat || null;
      if (cat) {
        const section = document.querySelector(`.cat-section[data-cat="${CSS.escape(cat)}"]`);
        if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      activeCategory = cat;
      renderSidebar();
    });
  });

  // Company items — filter (click active company again to deselect)
  sidebar.querySelectorAll('.nav-company').forEach(el => {
    el.addEventListener('click', () => {
      const company = el.dataset.company || null;
      activeCompany  = (company && activeCompany !== company) ? company : null;
      activeCategory = null;
      window.scrollTo({ top: 0, behavior: 'instant' });
      render();
      renderSidebar();
    });
  });

  const bmac = document.createElement('div');
  bmac.className = 'bmac-wrap';
  bmac.innerHTML = `<a href="https://buymeacoffee.com/borna761" target="_blank" rel="noopener">
    <img src="/assets/buymeacoffee-white.png" alt="Buy me a coffee">
  </a>`;
  sidebar.appendChild(bmac);
}

// ---- Scroll spy ----

window.addEventListener('scroll', () => {
  const sections = document.querySelectorAll('.cat-section');
  let current = null;
  sections.forEach(s => {
    if (s.getBoundingClientRect().top <= 100) current = s.dataset.cat;
  });
  if (current !== activeCategory) {
    activeCategory = current;
    renderSidebar();
  }
}, { passive: true });

// ---- Init ----

Promise.all([
  fetch('/api/data').then(r => r.json()),
  fetch('/api/companies').then(r => r.json()),
]).then(([data, companiesData]) => {
  allPairs   = data.pairs;
  categories = data.categories;
  companies  = companiesData;
  populateAddPanelSelects();
  render();
  renderSidebar();
});

// ---- Settings modal ----

let configCache = null;
let catSortable = null;

async function openSettings() {
  const [config, companiesData] = await Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/companies').then(r => r.json()),
  ]);
  configCache = config;
  companies   = companiesData;
  renderSettingsModal(config, companiesData);
  document.getElementById('settings-modal').classList.add('open');
}

function renderCompaniesSection(companiesData) {
  const list = document.getElementById('companies-list-settings');
  if (!list) return;
  list.innerHTML = companiesData.map(c => `
    <div class="company-item">
      <svg width="13" height="13" fill="none" viewBox="0 0 24 24" style="flex-shrink:0;color:#9ca3af">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"
          stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M14 2v6h6" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>
      <input class="company-name-input"
        type="text"
        value="${esc(c.name)}"
        data-file="${esc(c.file)}"
        data-original="${esc(c.name)}"
        placeholder="Company name">
    </div>
  `).join('');

  list.querySelectorAll('.company-name-input:not([readonly])').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { input.value = input.dataset.original; input.blur(); }
    });

    input.addEventListener('blur', async () => {
      const newName = input.value.trim();
      const oldName = input.dataset.original;
      const oldFile = input.dataset.file;
      if (!newName || newName === oldName) { input.value = oldName; return; }

      const res = await fetch('/api/rename-company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldFile, newName }),
      });
      const data = await res.json();

      if (res.ok) {
        // Update in-memory state
        const entry = companies.find(c => c.file === oldFile);
        if (entry) { entry.file = data.file; entry.name = data.name; }
        allPairs.forEach(p => {
          if (p.source === oldName) {
            p.source   = data.name;
            p.filePath = p.filePath.slice(0, -oldFile.length) + data.file;
          }
        });
        if (activeCompany === oldName) activeCompany = data.name;
        // Update input attributes so a second rename works
        input.value = data.name;
        input.dataset.file = data.file;
        input.dataset.original = data.name;
        populateAddPanelSelects();
        render();
        renderSidebar();
        showToast(`Renamed to "${data.name}"`);
      } else {
        input.value = oldName;
        showToast(data.error || 'Error renaming');
      }
    });
  });
}

function renderSettingsModal(config, companiesData) {
  renderCompaniesSection(companiesData);
  // Categories
  const catList = document.getElementById('cat-edit-list');
  catList.innerHTML = config.categories.map((cat, i) => `
    <div class="cat-edit-item" data-index="${i}">
      <svg class="drag-handle" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
        <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
        <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
      </svg>
      <input class="cat-name-input" type="text" value="${esc(cat)}">
      <button class="btn-icon-sm delete-cat-btn" title="Delete">
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24">
          <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `).join('');

  catList.querySelectorAll('.delete-cat-btn').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      config.categories.splice(i, 1);
      config.rules = config.rules.filter(r => config.categories.includes(r.cat));
      renderSettingsModal(config, companies);
    });
  });

  if (catSortable) catSortable.destroy();
  catSortable = Sortable.create(catList, {
    handle: '.drag-handle',
    animation: 120,
    onEnd() {
      const newOrder = [...catList.querySelectorAll('.cat-name-input')].map(el => el.value);
      config.categories = newOrder;
      // Re-render rule rows in the new order so they stay positionally in sync
      syncRulesList(config);
    },
  });

  syncRulesList(config);
}

// Re-render just the rule rows, preserving any unsaved keyword edits by old name.
// Rule rows must always be in the same relative order as non-Other categories so
// that positional matching at save time is correct.
function syncRulesList(config) {
  // Snapshot current keyword edits from the DOM before re-rendering
  const kwSnapshot = {};
  document.querySelectorAll('.rule-row').forEach(row => {
    kwSnapshot[row.dataset.cat] = row.querySelector('.rule-keywords-input').value;
  });

  const rulesList = document.getElementById('rules-list');
  if (!rulesList) return;
  rulesList.innerHTML = config.categories
    .filter(c => c !== 'Other')
    .map(cat => {
      // Prefer unsaved edits (by old name), fall back to stored rules
      const rule = config.rules.find(r => r.cat === cat);
      const keywords = kwSnapshot[cat] ?? (rule ? rule.keywords.join(', ') : '');
      return `
        <div class="rule-row" data-cat="${esc(cat)}">
          <span class="rule-cat-label">${esc(cat)}</span>
          <textarea class="rule-keywords-input" rows="2" placeholder="keyword one, keyword two…">${esc(keywords)}</textarea>
        </div>
      `;
    }).join('');
}

document.getElementById('add-cat-btn').addEventListener('click', () => {
  if (!configCache) return;
  configCache.categories.push('New category');
  renderSettingsModal(configCache, companies);
  // Focus the new input
  const inputs = document.querySelectorAll('.cat-name-input');
  inputs[inputs.length - 1].focus();
  inputs[inputs.length - 1].select();
});

document.getElementById('add-company-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-company-input');
  const name = input.value.trim();
  if (!name) { showToast('Enter a company name'); return; }
  const res = await fetch('/api/add-company', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (res.ok) {
    companies.push({ file: data.file, name: data.name });
    input.value = '';
    renderCompaniesSection(companies);
    populateAddPanelSelects();
    showToast(`Added "${data.name}"`);
  } else {
    showToast(data.error || 'Error adding company');
  }
});

document.getElementById('settings-toggle').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.remove('open');
});
document.getElementById('settings-cancel').addEventListener('click', () => {
  document.getElementById('settings-modal').classList.remove('open');
});
document.getElementById('settings-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('open');
});

document.getElementById('settings-save').addEventListener('click', async () => {
  if (!configCache) return;

  // Read current category names from inputs in their current DOM order
  const catInputs = [...document.querySelectorAll('.cat-name-input')];
  configCache.categories = catInputs.map(el => el.value.trim()).filter(Boolean);

  // Match each rule row to its category by position, not by stale data-cat.
  // syncRulesList keeps rule rows in the same relative order as non-Other categories,
  // so positional matching is always correct even after a rename or drag reorder.
  const nonOtherCats = configCache.categories.filter(c => c !== 'Other');
  configCache.rules = [...document.querySelectorAll('.rule-row')].map((row, i) => ({
    cat: nonOtherCats[i],
    keywords: row.querySelector('.rule-keywords-input').value
      .split(',').map(k => k.trim()).filter(Boolean),
  })).filter(r => r.cat);

  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(configCache),
  });

  if (res.ok) {
    document.getElementById('settings-modal').classList.remove('open');
    // Reload data so new categories/rules take effect
    const data = await fetch('/api/data').then(r => r.json());
    allPairs   = data.pairs;
    categories = data.categories;
    showToast('Settings saved');
    render();
    renderSidebar();
  } else {
    showToast('Error saving settings');
  }
});
