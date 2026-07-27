/**
 * Демо-движок чата по каркасу:
 *  - состояния: сценарий не запущен (C) / сценарий предложил чоисы (B.1) /
 *    сценарий ждёт текст (B.2) / идёт генерация (D, ввод заблокирован) /
 *    стартовый сценарий выбора типа документа (A — не прерывается командами);
 *  - перебивка: новый сценарий (командой из чата или файлом) поверх активного —
 *    вопрос «прервать?»; старый завершается, стейт обнуляется, действия не откатываются;
 *  - сценарии: стартовый (№1), привязка линии (№2), создание линии (№6),
 *    проверка документа (№15), генерация по линиям (№17), справка (№14),
 *    разбор DOCX (№3 — по скрепке).
 */

const $ = (sel, root = document) => root.querySelector(sel);

const switcherTabsEl = $('#demo-switcher-tabs');
const docBlocksEl = $('#doc-blocks');
const docPleasEl = $('#doc-pleas');
const feedEl = $('#assistant-feed');
const assistantScrollEl = $('#assistant-scroll');
const contextEl = $('#input-context');
const promptEl = $('#prompt-input');
const sendBtn = $('#btn-send');
const attachBtn = $('#btn-attach');
const assistantInputEl = $('#assistant-input');
const scenarioBannerTitleEl = $('#scenario-banner-title');
const scenarioBannerStepEl = $('#scenario-banner-step');
const scenarioBannerMenuBtn = $('#scenario-banner-menu');
const scenarioBannerDropdown = $('#scenario-banner-dropdown');
const scenarioAbortBtn = $('#scenario-abort');
const topbarTitleEl = $('#topbar-title');
const docTitleEl = $('#doc-title');
const docHeaderBodyEl = $('#doc-header-body');

/* ================= Состояние ================= */

const state = {
  tabIndex: 0,
  card: null,          // рабочая копия карточки дела (в чате не показывается)
  blocks: null,        // рабочая копия блоков документа (у блока: section 'facts'|'admission'|'law'|'defense')
  pleas: null,         // пункты просительной части
  structure: null,     // активные плейсхолдеры структуры (DOC_STRUCTURE[type]) или null
  factsSource: null,   // как заполнены обстоятельства: 'card' | 'verdict' | 'own'
  boundLines: null,    // Set id линий, уже привязанных к блокам
  warnExplained: false, // объяснение про «!» у блоков уже показано в чате
  activeBlockId: null,
  activeSubpart: null, // { blockId, key, title } — подблок конструктора в контексте чата
  docType: null,       // { key, label } после стартового сценария
  scenario: null,      // { id, title, stage: 'choices'|'text', chipsSpec, chipsEl, onText, reaskText, uninterruptible }
  busy: false
};

const clone = obj => JSON.parse(JSON.stringify(obj));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= Переключатель раскладов ================= */

function renderSwitcher() {
  switcherTabsEl.innerHTML = '';
  DEMO_TABS.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.className = 'demo-tab' + (i === state.tabIndex ? ' is-active' : '');
    btn.textContent = tab.tab;
    btn.title = tab.hint;
    btn.addEventListener('click', () => resetDemo(i));
    switcherTabsEl.appendChild(btn);
  });
}

/** Полный сброс контекста под выбранный таб. */
function resetDemo(tabIndex) {
  const tab = DEMO_TABS[tabIndex];
  state.tabIndex = tabIndex;
  state.card = clone(tab.card);
  state.blocks = clone(DOC_BLOCKS);
  state.pleas = [];
  state.structure = null;
  state.factsSource = null;
  state.boundLines = new Set();
  state.warnExplained = false;
  state.activeSubpart = null;
  state.activeBlockId = null;
  state.docType = null;
  state.scenario = null;
  state.busy = false;

  feedEl.innerHTML = '';
  promptEl.value = '';
  autosize();
  setBusy(false);

  document.body.classList.remove('text-only');
  const vt = $('#view-toggle');
  if (vt) vt.classList.add('is-on');

  topbarTitleEl.textContent = 'Новый документ';
  docTitleEl.textContent = 'Новый документ';
  docHeaderBodyEl.innerHTML = '<p class="placeholder">Шапка документа сформируется после выбора типа</p>';

  renderSwitcher();
  renderBlocks();
  renderPleas();
  renderContextChip();

  if (tab.demoNote) addMessage('demo', tab.demoNote);
  startDocTypeScenario();
}

/* ================= Документ ================= */

// позиция по приговору (admission) идёт сразу после описания судебного акта
const SECTION_ORDER = ['verdict', 'admission', 'facts', 'law', 'defense'];

/** Короткое имя линии для панели блока. */
const shortLineTitle = t => (t || '').replace(/^Линия \d+:\s*/, '').split(' — ')[0];

/** Чего не хватает блоку по его сводке (галочка не зелёная, пока список не пуст). */
function blockIssues(block) {
  const isDefense = (block.section || 'defense') === 'defense' || !!(block.parts && block.parts.length);
  if (!isDefense) {
    return hasTextPlaceholder(block.html) ? ['не заполнены поля'] : [];
  }
  const issues = [];
  if (!block.lineId) issues.push('нет линии защиты', 'нет аргументов');
  if (blockLacksEvidence(block)) issues.push('не хватает доказательств у аргументов');
  if (block.argsStale) issues.push('аргументы не обновлены');
  return issues;
}

/** Иконки действий блока (идут рядом с подписью кнопки). */
const ACT_ICONS = {
  // редактировать с ИИ — карандаш со звёздочкой
  rewrite: '<svg viewBox="0 0 24 24"><path d="M16.5 3.5a2.4 2.4 0 1 1 3.4 3.4L7 19.8 2.5 21l1.2-4.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m19 13 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="currentColor"/></svg>',
  // список аргументов
  'args-modal': '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="5" cy="6" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="5" cy="18" r="1.4" fill="currentColor"/></svg>',
  // судебная практика — книга
  'practice-modal': '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14H6.5A2.5 2.5 0 0 0 4 19.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20v4H6.5A2.5 2.5 0 0 1 4 19.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  // не хватает доказательств — предупреждение
  'scroll-evidence': '<svg viewBox="0 0 24 24"><path d="M12 4.5 21 20H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.15" fill="currentColor"/></svg>',
  // привязать линию защиты — звено цепи
  'pick-line': '<svg viewBox="0 0 24 24"><path d="M10 13.5a4 4 0 0 0 5.7.4l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10.5a4 4 0 0 0-5.7-.4l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  // перегенерировать
  regen: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/**
 * Панель состава и действий внутри блока (итерация 2):
 * флаги + кнопки (без «Короче/Подробнее/Вопрос»), справа «Перегенерировать»
 * (активна при ручных изменениях конструктора) и «Завершить/Открыть конструктор».
 */
function buildBlockMeta(block) {
  const meta = document.createElement('div');
  meta.className = 'doc-block__meta';
  meta.contentEditable = 'false';

  const isCtor = !!(block.parts && block.parts.length);
  const isDefense = (block.section || 'defense') === 'defense' || isCtor;
  // правка с ИИ и перегенерация — иконками в верхнем ряду; аргументы, практика,
  // нормы и доказательства редактируются внутри конструктора (в основаниях аргументов),
  // поэтому кнопок-дублей здесь нет; сигнал о нехватке доказательств — слева в маргиналии
  const barBtns = [];

  if (isDefense && !isCtor && block.kind === 'manual') {
    // новый пустой блок: выбор линии активен (после выбора сменить нельзя — только удалить блок)
    barBtns.push(['pick-line', 'Выбрать линию защиты', true]);
  }

  // кнопки состава блока — с иконкой и подписью: контекст считывается без наведения
  meta.innerHTML = `
    <div class="doc-block__tools">${barBtns.map(([id, label, warn]) => `
      <button data-tool="${id}" class="act-btn${warn ? ' act-btn--warn' : ''}" title="${label}">
        ${ACT_ICONS[id] || ''}<span>${label}</span>
      </button>`).join('')}
    </div>`;

  meta.querySelectorAll('button[data-tool]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.tool;
      setActiveBlock(block.id);
      if (state.busy) return;
      switch (id) {
        case 'args-modal': openArgsModal(block); return;
        case 'practice-modal': openPracticeModal(block); return;
        case 'scroll-evidence': scrollToNeedyArg(block); return;
        case 'pick-line': openLinePicker(block); return;
        case 'evidence-modal':
          onStarAction({ id: 'bind-evidence', label: BLOCK_ACTION_LABELS['bind-evidence'], needsBlock: true });
          return;
        default:
          onStarAction({ id, label: BLOCK_ACTION_LABELS[id] || btn.textContent, needsBlock: id !== 'practice' });
      }
    });
  });
  meta.querySelector('[data-special="regen"]')?.addEventListener('click', e => {
    e.stopPropagation();
    onRegenerateClick(block);
  });
  return meta;
}

/** Короткая сводка блока для первой строки (по образу отчёта в чате). */
function blockSummary(block) {
  const { episode, thesis } = blockDetails(block);
  return [blockLead(block), episode, thesis].filter(Boolean).join(' · ');
}

/** Короткое название раздела блока — постоянная подпись-маргиналия слева. */
function blockLead(block) {
  const sec = block.section || 'defense';
  if (block.kind === 'grounds') return 'Основания для отмены';
  if (sec !== 'defense' || !(block.parts && block.parts.length)) {
    const titles = { verdict: 'Описание судебного акта', facts: 'Обстоятельства дела', admission: 'Позиция по приговору', law: 'Правовое обоснование' };
    return titles[sec] || 'Текстовый блок';
  }
  const line = state.card.lines.find(l => l.id === block.lineId) || null;
  return line ? shortLineTitle(line.title) : 'Линия не привязана';
}

/**
 * Смысловые детали блока для маргиналии: эпизод (короткий ярлык привязки)
 * и тезис (суть блока). Эпизод и первая строка тезиса видны постоянно,
 * целиком тезис раскрывается у активного/наведённого блока — см. CSS.
 * Счётчиков здесь нет: нехватка доказательств — отдельной жёлтой меткой.
 */
function blockDetails(block) {
  const sec = block.section || 'defense';
  if (sec !== 'defense' || !(block.parts && block.parts.length)) return {};
  const line = state.card.lines.find(l => l.id === block.lineId) || null;
  const ep = line && line.episodeId ? state.card.episodes.findIndex(x => x.id === line.episodeId) : -1;
  return {
    episode: ep >= 0 ? cap(episodeShort(state.card.episodes[ep], ep)) : '',
    thesis: line && line.thesis ? line.thesis : ''
  };
}

/** Удаление блока с подтверждением. */
function confirmDeleteBlock(block) {
  openModal({
    title: 'Удаление блока',
    bodyHtml: `Удалить ${block.label} из документа?`,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Удалить',
        primary: true,
        onClick: () => {
          closeModal();
          const label = block.label;
          const idx = state.blocks.indexOf(block);
          if (idx >= 0) state.blocks.splice(idx, 1);
          if (state.activeBlockId === block.id) {
            state.activeBlockId = null;
            state.activeSubpart = null;
          }
          renderBlocks();
          renderContextChip();
          addMessage('assistant', `${label} удалён из документа.`);
        }
      }
    ]
  });
}

/** Конструктор: подблоки-сущности с отдельными заголовками, редактируются по одному. */
function buildConstructor(block) {
  const ctor = document.createElement('div');
  ctor.className = 'doc-constructor';
  ctor.contentEditable = 'false';
  block.parts.forEach(part => {
    const sub = document.createElement('div');
    sub.className = 'doc-sub';

    if (part.key === 'arguments') {
      // «свернуть/развернуть всё» — обзор структуры позиции без прокрутки
      const anyOpen = (block.argsList || []).some(a => a.groundsOpen !== false && (a.grounds || []).length);
      sub.innerHTML = `
        <div class="doc-sub__head">
          <span class="doc-sub__title" contenteditable="false">${part.title}</span>
          ${(block.argsList || []).some(a => (a.grounds || []).length)
            ? `<button class="doc-sub__foldall" type="button" data-open="${anyOpen ? '1' : '0'}">${anyOpen ? 'Свернуть все' : 'Развернуть все'}</button>` : ''}
        </div>`;
      sub.querySelector('.doc-sub__foldall')?.addEventListener('click', e => {
        e.stopPropagation();
        const open = e.currentTarget.dataset.open !== '1';
        (block.argsList || []).forEach(a => { a.groundsOpen = open; });
        renderBlocks();
      });
      sub.appendChild(buildArgsEditor(block));
      sub.addEventListener('click', e => {
        e.stopPropagation();
        setActiveBlock(block.id);
        setActiveSubpart({ blockId: block.id, key: 'arguments', title: 'Доводы' });
      });
      ctor.appendChild(sub);
      return;
    }

    const bodyHtml = part.key === 'norms' ? linkifyNorms(part.html) : part.html;
    sub.innerHTML = `
      <div class="doc-sub__title" contenteditable="false">${part.title}</div>
      <div class="doc-sub__body" contenteditable="true"${part.key === 'other' ? ' data-ph="Добавьте свободные факты и доводы…"' : ''}>${bodyHtml}</div>`;
    const body = sub.querySelector('.doc-sub__body');
    body.addEventListener('input', () => {
      part.html = body.innerHTML;
      markDirty(block, part.title, part.key);
    });
    // клик по подблоку кладёт его в контекст чата — можно отредактировать с ИИ
    body.addEventListener('click', e => {
      e.stopPropagation();
      setActiveBlock(block.id);
      setActiveSubpart({ blockId: block.id, key: part.key, title: part.title });
    });
    ctor.appendChild(sub);
  });

  /**
   * Главный сигнал конструктора: состав изменён, а текст блока остался прежним.
   * Стоит внизу конструктора — прямо на границе с текстом, который устарел.
   */
  if (block.dirty) {
    const stale = document.createElement('div');
    stale.className = 'doc-stale';
    stale.innerHTML = `
      <span>Текст блока не соответствует конструктору</span>
      <button type="button">Обновить текст</button>`;
    stale.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      onRegenerateClick(block);
    });
    ctor.appendChild(stale);
  }
  return ctor;
}

/** Основания одного аргумента (tree-режим): вложенный раскрывающийся список. */
function buildGroundsEl(block, arg) {
  const g = document.createElement('div');
  g.className = 'doc-arg__grounds' + (arg.groundsOpen === false ? ' is-collapsed' : '');

  // подпись группы: явно проговариваем связь «довод → чем подтверждается»
  if ((arg.grounds || []).length) {
    const cap = document.createElement('div');
    cap.className = 'doc-grounds__cap';
    cap.textContent = 'Подтверждается';
    g.appendChild(cap);
  }

  (arg.grounds || []).forEach((ground, gi) => {
    const row = document.createElement('div');
    row.className = 'doc-ground' + (ground.type === 'evidence' ? ' doc-ground--evidence' : '');
    row.draggable = true;
    // под доказательством — поле «что и почему доказывает»: пока пусто и не в фокусе,
    // сворачивается в одну строку-ссылку, чтобы не множить пустые поля
    const provesHtml = ground.type === 'evidence'
      ? `<div class="doc-ground__proves${(ground.proves || '').trim() ? '' : ' is-empty'}" contenteditable="true"
              data-ph="Пояснить, что и почему доказывает…">${ground.proves || ''}</div>`
      : '';
    row.innerHTML = `
      <span class="doc-ground__type doc-ground__type--${ground.type}" title="Перетащить основание">${GROUND_LABELS[ground.type] || ground.type}</span>
      <span class="doc-ground__text" contenteditable="true">${ground.text}${ground.evidence ? ` <i class="doc-ground__ev">(${ground.evidence})</i>` : ''}</span>
      <button class="doc-arg__del" title="Удалить основание" type="button">×</button>
      ${provesHtml}`;
    const txt = row.querySelector('.doc-ground__text');
    txt.addEventListener('input', () => {
      ground.text = txt.innerText;
      markDirty(block, 'Доводы', 'arguments');
    });
    const provesEl = row.querySelector('.doc-ground__proves');
    if (provesEl) {
      provesEl.draggable = false;
      provesEl.addEventListener('input', () => {
        ground.proves = provesEl.innerText.trim();
        provesEl.classList.toggle('is-empty', !ground.proves);
        markDirty(block, 'Доводы', 'arguments');
      });
      // в фокусе поле разворачивается, даже если ещё пустое
      provesEl.addEventListener('focus', () => provesEl.classList.remove('is-empty'));
      provesEl.addEventListener('blur', () => provesEl.classList.toggle('is-empty', !provesEl.innerText.trim()));
      // выделение текста в поле не должно инициировать перетаскивание основания
      provesEl.addEventListener('dragstart', e => { e.preventDefault(); e.stopPropagation(); });
    }
    row.querySelector('.doc-arg__del').addEventListener('click', e => {
      e.stopPropagation();
      arg.grounds.splice(gi, 1);
      block.dirty = true;
      renderBlocks();
    });
    // перетаскивание оснований между собой (внутри аргумента и между аргументами блока)
    row.addEventListener('dragstart', e => {
      e.stopPropagation();
      e.dataTransfer.setData('text/ground', JSON.stringify({ blockId: block.id, argIdx: block.argsList.indexOf(arg), gIdx: gi }));
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('is-dragging'));
    row.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('text/ground')) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('is-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
    row.addEventListener('drop', e => {
      row.classList.remove('is-drop-target');
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/ground')); } catch { return; }
      if (!data || data.blockId !== block.id) return;
      e.preventDefault();
      e.stopPropagation();
      const fromArg = block.argsList[data.argIdx];
      const moved = fromArg.grounds.splice(data.gIdx, 1)[0];
      const toIdx = arg.grounds.indexOf(ground);
      arg.grounds.splice(toIdx, 0, moved);
      block.dirty = true;
      syncArgsPart(block);
      renderBlocks();
    });
    g.appendChild(row);
  });

  if (argOnlyPractice(arg)) {
    const warn = document.createElement('div');
    warn.className = 'doc-ground__warn';
    warn.textContent = 'Основание подкреплено только практикой — рекомендуем добавить доказательство или норму.';
    g.appendChild(warn);
  }

  const addRow = document.createElement('div');
  addRow.className = 'doc-ground__add';
  const needsEv = argNeedsEvidence(arg);
  // частый случай — доказательство — отдельной кнопкой; остальные типы прячутся
  // за «+ Основание», чтобы у каждого довода не стояло четыре кнопки подряд
  addRow.innerHTML = `
    <span class="ev-split${needsEv ? ' is-hot' : ''}">
      <button type="button" data-gt="evidence">+ ${GROUND_LABELS.evidence}</button>
      ${needsEv ? '<button type="button" class="ev-split__skip" title="Снять подсветку">не нужны</button>' : ''}
    </span>
    <span class="gr-add${arg.addOpen ? ' is-open' : ''}">
      <button type="button" class="gr-add__toggle" title="Норма, практика или обстоятельство">+ Основание</button>
      <span class="gr-add__types">${['norm', 'practice', 'circumstance'].map(t =>
        `<button type="button" data-gt="${t}">${GROUND_LABELS[t]}</button>`).join('')}
        <input type="text" class="gr-add__quick" placeholder="или впишите норму: ч. 1 ст. 158 УК РФ">
      </span>
    </span>`;

  // быстрый ввод нормы с клавиатуры — без попапа выбора
  const quick = addRow.querySelector('.gr-add__quick');
  quick?.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key !== 'Enter') return;
    const val = quick.value.trim();
    if (!val) return;
    arg.grounds = arg.grounds || [];
    arg.grounds.push({ type: 'norm', text: val });
    arg.groundsOpen = true;
    arg.addOpen = false;
    block.dirty = true;
    syncArgsPart(block);
    renderBlocks();
  });
  quick?.addEventListener('click', e => e.stopPropagation());

  // раскрытие списка типов основания
  addRow.querySelector('.gr-add__toggle')?.addEventListener('click', e => {
    e.stopPropagation();
    arg.addOpen = !arg.addOpen;
    addRow.querySelector('.gr-add').classList.toggle('is-open', arg.addOpen);
  });

  addRow.querySelectorAll('button[data-gt]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const type = btn.dataset.gt;
      const push = ground => {
        arg.grounds = arg.grounds || [];
        arg.grounds.push(ground);
        arg.groundsOpen = true;
        arg.addOpen = false; // список типов сворачивается после выбора
        block.dirty = true;
        syncArgsPart(block);
        renderBlocks();
      };
      // «+ Факт» — текстовое поле как есть; остальные — попапы выбора
      if (type === 'fact') {
        push({ type: 'fact', text: '' });
        const rows = document.querySelectorAll(`.doc-block[data-block-id="${block.id}"] .doc-ground__text`);
        rows[rows.length - 1]?.focus();
        return;
      }
      if (type === 'norm') pickNormGround(block, texts => texts.forEach(t => push({ type: 'norm', text: t })));
      if (type === 'practice') pickPracticeGround(block, texts => texts.forEach(t => push({ type: 'practice', text: t })));
      if (type === 'evidence') pickEvidenceGround(block, items => items.forEach(it => push({ type: 'evidence', text: it.text, proves: it.proves || '' })));
      if (type === 'circumstance') pickCircumstanceGround(block, texts => texts.forEach(t => push({ type: 'circumstance', text: t })));
    });
  });
  addRow.querySelector('.ev-split__skip')?.addEventListener('click', e => {
    e.stopPropagation();
    arg.noEvidenceNeeded = true;
    renderBlocks();
    addMessage('assistant', `Для одного из аргументов ${labelGen(block.label)} отмечено: доказательства не требуются.`);
  });
  g.appendChild(addRow);
  return g;
}

/** Скролл к ближайшему аргументу без доказательства (открывает конструктор при необходимости). */
function scrollToNeedyArg(block) {
  // разворачиваем конструктор и раскрываем основания у проблемного аргумента
  const needy = (block.argsList || []).find(argNeedsEvidence);
  if (needy) needy.groundsOpen = true;
  if (block.constructorDone) block.constructorDone = false;
  renderBlocks();

  const el = document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-arg--needs-ev`);
  if (!el) return;
  // прокручиваем документ к аргументу и подсвечиваем его
  smoothScrollTo(el);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/* ---------- Двухпанельный попап в дизайне сайта (список + детали + добавление) ---------- */

let spState = null;

function openSitePicker({ title, context, items, addable, addFields, applyLabel, hint, single, onApply, onAdd, startId }) {
  spState = {
    items: items.map(it => ({ ...it })),
    current: startId != null ? Math.max(0, items.findIndex(it => it.id === startId)) : 0,
    single: !!single,
    onApply
  };

  modalEl.innerHTML = `
    <div class="modal__title">${title}</div>
    ${context ? `<div class="modal__context">${context}</div>` : ''}
    <div class="sp-layout">
      <div class="sp-list">
        <div class="sp-list__head"><span>${hint || ''}</span>${addable ? `<button class="sp-add" type="button">+ Добавить</button>` : ''}</div>
        <div class="sp-list__items"></div>
      </div>
      <div class="sp-detail"></div>
    </div>
    <div class="modal__footer">
      <span class="sp-footer-hint">${hint || 'Выберите элементы'}</span>
      <button class="modal__btn">Отмена</button>
      <button class="modal__btn modal__btn--primary">${applyLabel || 'Применить'}</button>
    </div>`;
  modalOverlay.hidden = false;
  modalEl.classList.add('modal--site');

  const listEl = modalEl.querySelector('.sp-list__items');
  const detailEl = modalEl.querySelector('.sp-detail');

  const renderDetail = () => {
    const it = spState.items[spState.current];
    if (!it) { detailEl.innerHTML = ''; return; }
    detailEl.innerHTML = `
      <div class="sp-detail__title" ${it.editable ? 'contenteditable="true"' : ''}>${it.title}</div>
      <div class="sp-detail__rows">
        ${(it.fields || []).map(([l, v], fi) => `
          <div class="sp-row"><span>${l}</span><b ${it.editable ? `contenteditable="true" data-fi="${fi}"` : ''}>${v}</b></div>`).join('')}
        ${it.provesField ? `
          <div class="sp-row"><span>Что доказывает</span><b contenteditable="true" data-proves data-ph="опишите, что именно подтверждает это доказательство">${it.proves || ''}</b></div>` : ''}
      </div>`;
    if (it.editable) {
      const t = detailEl.querySelector('.sp-detail__title');
      t.addEventListener('input', () => {
        it.title = t.innerText.trim();
        listEl.children[spState.current].querySelector('.sp-item__title').textContent = it.title || 'Без названия';
        if (it.fields && it.fields[0]) it.fields[0][1] = it.title;
      });
      detailEl.querySelectorAll('b[data-fi]').forEach(bEl => {
        bEl.addEventListener('input', () => {
          it.fields[+bEl.dataset.fi][1] = bEl.innerText.trim();
        });
      });
    }
    // «Что доказывает» — редактируется у любого доказательства
    detailEl.querySelector('b[data-proves]')?.addEventListener('input', e => {
      it.proves = e.target.innerText.trim();
    });
  };

  const renderList = () => {
    listEl.innerHTML = '';
    spState.items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'sp-item' + (i === spState.current ? ' is-current' : '');
      row.innerHTML = `
        <div class="sp-item__body">
          <div class="sp-item__title">${it.title || 'Без названия'}</div>
          ${it.sub ? `<div class="sp-item__sub">${it.sub}</div>` : ''}
        </div>
        <input type="checkbox" ${it.checked ? 'checked' : ''}>`;
      row.addEventListener('click', e => {
        if (e.target.tagName === 'INPUT') return;
        spState.current = i;
        renderList();
        renderDetail();
      });
      row.querySelector('input').addEventListener('change', e => {
        if (spState.single && e.target.checked) {
          spState.items.forEach((x, xi) => { x.checked = xi === i; });
          renderList();
        } else {
          it.checked = e.target.checked;
        }
      });
      listEl.appendChild(row);
    });
  };

  modalEl.querySelector('.sp-add')?.addEventListener('click', () => {
    // onAdd переопределяет «+ Добавить»: например, открывает следующий попап выбора
    if (onAdd) { modalEl.classList.remove('modal--site'); closeModal(); onAdd(); return; }
    const base = items.find(x => x.provesField);
    spState.items.push({
      id: null, title: '', sub: 'добавлено вручную', checked: true, editable: true,
      provesField: !!(base || (items[0] && items[0].provesField)) || !!(addFields && addFields.proves),
      fields: (addFields && addFields.fields) ? addFields.fields.map(f => [...f]) : [['Описание', ''], ['Тип', '—'], ['Комментарий', '—']]
    });
    if (spState.single) spState.items.forEach((x, xi) => { x.checked = xi === spState.items.length - 1; });
    spState.current = spState.items.length - 1;
    renderList();
    renderDetail();
    detailEl.querySelector('.sp-detail__title')?.focus();
  });

  const [cancelBtn, applyBtn] = modalEl.querySelectorAll('.modal__footer .modal__btn');
  cancelBtn.addEventListener('click', () => { modalEl.classList.remove('modal--site'); closeModal(); });
  applyBtn.addEventListener('click', () => {
    const selected = spState.items.filter(it => it.checked && !it.editable);
    const added = spState.items.filter(it => it.checked && it.editable && (it.title || '').trim());
    modalEl.classList.remove('modal--site');
    closeModal();
    onApply(selected, added);
  });

  renderList();
  renderDetail();
}

/** Попап выбора нормы из правовой базы; первыми — подсказки ИИ по линии блока. */
function pickNormGround(block, onApply) {
  const line = state.card.lines.find(l => l.id === block.lineId);
  const keys = Object.keys(NORMS_DB);
  const aiKeys = keys.filter(k => line && line.norms && line.norms.includes(k));
  const ordered = [...aiKeys, ...keys.filter(k => !aiKeys.includes(k))];

  const items = ordered.map(k => `
    <label class="evidence-item">
      <input type="checkbox" data-key="${k}">
      <span><b>${k}</b>${aiKeys.includes(k) ? ' <span class="ai-hint">подсказка ИИ</span>' : ''}<br>
      <small class="modal-sub">${NORMS_DB[k].act} · ${NORMS_DB[k].title}</small></span>
    </label>`).join('');

  openModal({
    title: 'Правовая база — выбор нормы',
    context: blockModalContext(block),
    bodyHtml: items,
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Добавить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-key]:checked')].map(i => i.dataset.key);
          closeModal();
          if (sel.length) onApply(sel.map(k => `${k} — ${NORMS_DB[k].title}`));
        }
      }
    ]
  });
}

/** Попап выбора практики для основания — продуктовый вид. */
function pickPracticeGround(block, onApply) {
  const pool = (state.card.practice && state.card.practice.length) ? state.card.practice : PRACTICE_CASES;
  openModal({
    title: 'Практика по линии защиты — выбор дела',
    context: blockModalContext(block),
    bodyHtml: pool.map((c, i) => practiceCaseHtml(c, i, {})).join(''),
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Добавить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
          closeModal();
          if (sel.length) onApply(sel.map(i => `${pool[i].num} (${pool[i].court}) — ${pool[i].decision || pool[i].result}`));
        }
      }
    ]
  });
}

/** Попап выбора доказательства для основания — двухпанельный, с полем «Что доказывает». */
function pickEvidenceGround(block, onApply) {
  openSitePicker({
    title: 'Доказательства',
    context: blockModalContext(block),
    hint: 'Выберите доказательства',
    addable: true,
    addFields: { proves: true, fields: [['Описание', ''], ['Статья', '—'], ['Тип', '—']] },
    items: state.card.evidence.map((ev, i) => ({
      id: i,
      title: `Доказательство ${i + 1}`,
      sub: ev.slice(0, 60),
      checked: false,
      provesField: true,
      fields: [['Описание', ev], ['Статья', '—'], ['Тип', '—'], ['Кто использовал', 'Сторона защиты'], ['Результат рассмотрения', '—']]
    })),
    onApply: (selected, added) => {
      added.forEach(a => state.card.evidence.push(a.title));
      // «что доказывает» — отдельным полем (в конструкторе под доказательством), не в текст
      const toGround = it => ({
        text: it.id !== null && it.id !== undefined ? state.card.evidence[it.id] : it.title,
        proves: it.proves || ''
      });
      const grounds = [...selected, ...added].map(toGround);
      if (grounds.length) onApply(grounds);
    }
  });
}

/** Попап выбора обстоятельства для основания — двухпанельный, в дизайне сайта. */
function pickCircumstanceGround(block, onApply) {
  openSitePicker({
    title: 'Обстоятельства',
    context: blockModalContext(block),
    hint: 'Выберите обстоятельства',
    addable: true,
    items: state.card.circumstances.map((c, i) => ({
      id: i,
      title: `Обстоятельство ${i + 1}`,
      sub: c.slice(0, 60),
      checked: false,
      fields: [['Описание', c], ['Тип', 'Смягчающее'], ['Категория', 'Иное обстоятельство, смягчающее наказание'], ['Результат рассмотрения', 'Принято во внимание']]
    })),
    onApply: (selected, added) => {
      added.forEach(a => state.card.circumstances.push(a.title));
      const texts = [...selected.map(s => state.card.circumstances[s.id]), ...added.map(a => a.title)];
      if (texts.length) onApply(texts);
    }
  });
}

/**
 * Выбор линии защиты для нового пустого блока: первый шаг — линии карточки дела,
 * «+ Добавить» открывает библиотеку всех линий (дерево УПК); выбранная там линия
 * попадает в этот список доступных (preselectId) и применяется отсюда.
 */
function openLinePicker(block, preselectId) {
  const lines = state.card.lines;

  openSitePicker({
    title: 'Линии защиты',
    hint: 'Карточка дела · «+ Добавить» — новая линия из библиотеки',
    single: true,
    addable: true,
    onAdd: () => openLineLibraryPicker(block),
    applyLabel: 'Применить',
    startId: preselectId,
    items: lines.map(l => ({
      id: l.id,
      title: shortLineTitle(l.title),
      sub: 'карточка дела' + (l.thesis ? ' · ' + l.thesis.slice(0, 50) : ''),
      checked: l.id === preselectId,
      fields: [
        ['Линия защиты', shortLineTitle(l.title)],
        ['Тезис', l.thesis || '—'],
        ['Эпизод', l.episodeId ? (state.card.episodes.find(e => e.id === l.episodeId) || {}).title || '—' : '—'],
        ['Нормативка', l.norms || '—']
      ]
    })),
    onApply: (selected) => {
      if (!selected.length) return;
      const line = lines.find(l => l.id === selected[0].id);
      if (line) applyLineToBlock(block, line);
    }
  });
}

/** Второй шаг «+ Добавить»: все линии библиотеки (дерево УПК) + свободный ввод своей. */
function openLineLibraryPicker(block) {
  const libItems = (typeof DEFENSE_LINES_LIBRARY !== 'undefined' ? DEFENSE_LINES_LIBRARY : []).map((l, i) => ({
    id: `lib-${i}`,
    lib: l,
    title: `${l.code} ${l.title}`,
    sub: l.norms.slice(0, 3).map(n => n.art).join(', ') || 'библиотека линий',
    checked: false,
    fields: [
      ['Линия защиты', `${l.code} ${l.title}`],
      ['Раздел дерева', l.code],
      ['Нормативка', l.norms.slice(0, 5).map(n => n.art).join('; ') || '—'],
      ...l.norms.slice(0, 4).map(n => [n.art, (n.note || '—').slice(0, 160)])
    ]
  }));

  openSitePicker({
    title: 'Новая линия защиты — библиотека',
    hint: 'Все линии дерева УПК · «+ Добавить» — своя линия',
    single: true,
    addable: true,
    addFields: { fields: [['Линия защиты', ''], ['Тезис', ''], ['Эпизод', '—'], ['Нормативка', '—']] },
    applyLabel: 'Применить',
    items: libItems,
    onApply: (selected, added) => {
      // линия из библиотеки: создаём в карточке с нормативкой из дерева
      const libPick = selected.find(s => s.lib);
      if (libPick) {
        const l = libPick.lib;
        const line = {
          id: `line-lib-${state.card.lines.length + 1}`,
          episodeId: null,
          title: `${l.code} ${l.title}`,
          thesis: '',
          norms: l.norms.map(n => n.art).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6).join('; '),
          normsDetailed: l.norms,
          argumentsPool: null,
          plea: null
        };
        state.card.lines.push(line);
        addMessage('assistant', `Линия «${line.title}» добавлена в список из библиотеки — нормативка по дереву УПК подтянута в карточку.`);
        openLinePicker(block, line.id);
        return;
      }
      // своя линия, введённая вручную
      if (added.length) {
        const a = added[0];
        const thesisField = (a.fields || []).find(f => f[0] === 'Тезис');
        const line = {
          id: `line-user-${state.card.lines.length + 1}`,
          episodeId: null,
          title: a.title,
          thesis: thesisField && thesisField[1] !== '—' ? thesisField[1] : '',
          norms: '',
          argumentsPool: null,
          plea: null
        };
        state.card.lines.push(line);
        addMessage('assistant', `Создана новая линия защиты: «${a.title}» — сохранена в карточку дела.`);
        openLinePicker(block, line.id);
      }
    }
  });
}

/**
 * Редактор аргументов: подподблоки с источниками, перетаскиванием и удалением.
 * Последний элемент — всегда пустой с плейсхолдером; ввод создаёт новый пустой.
 * tree: у каждого аргумента раскрываются его основания (факт/норма/практика);
 * flat: основания лежат одной строкой внутри аргумента.
 */
function buildArgsEditor(block) {
  const wrap = document.createElement('div');
  wrap.className = 'doc-args';

  if (block.argsStale) {
    const banner = document.createElement('div');
    banner.className = 'doc-args__stale';
    banner.innerHTML = '<span>Данные обновлены</span><button type="button">Обновить аргументы</button>';
    banner.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      refreshArguments(block);
    });
    wrap.appendChild(banner);
  }

  (block.argsList || []).forEach((arg, i) => {
    const item = document.createElement('div');
    item.className = 'doc-arg' + (argNeedsEvidence(arg) ? ' doc-arg--needs-ev' : '');
    const groundsFlat = ARGS_MODE === 'flat' && (arg.grounds || []).length
      ? `<div class="doc-arg__flatgrounds">Основания: ${arg.grounds.map(gr =>
          `<b>${GROUND_LABELS[gr.type]}</b> — ${gr.text}${gr.evidence ? ' (' + gr.evidence + ')' : ''}`).join(' · ')}</div>`
      : '';
    item.innerHTML = `
      <span class="doc-arg__grip" draggable="true" title="Перетащить аргумент">⋮⋮</span>
      <div class="doc-arg__main">
        <div class="doc-arg__text" contenteditable="true">${arg.text}</div>
        ${groundsFlat}
        ${ARGS_MODE === 'flat' && argOnlyPractice(arg) ? '<div class="doc-ground__warn">Основание подкреплено только практикой — рекомендуем добавить доказательство или норму.</div>' : ''}
      </div>
      <span class="doc-arg__src${arg.auto ? '' : ' doc-arg__src--manual'}"
            title="${arg.auto ? (SRC_HINTS[arg.source] || SRC_HINTS.fact) : 'Довод добавлен вручную'}">${
        arg.auto ? 'ИИ · ' + (SRC_LABELS[arg.source] || SRC_LABELS.fact) : 'вручную'}</span>
      ${ARGS_MODE === 'tree' ? `<button class="doc-arg__fold" type="button" title="Свернуть или развернуть основания довода"><svg viewBox="0 0 24 24" style="transform: rotate(${arg.groundsOpen === false ? 0 : 180}deg)"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : ''}
      <button class="doc-arg__del" title="Удалить довод" type="button">×</button>`;

    const text = item.querySelector('.doc-arg__text');
    text.addEventListener('input', () => {
      arg.text = text.innerText;
      syncArgsPart(block);
      markDirty(block, 'Доводы', 'arguments');
    });
    // клавиатура: Enter — следующий довод, Tab — к кнопкам оснований этого довода
    text.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        focusNewArg(block);
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-arg__grounds:nth-of-type(${i + 1}) button[data-gt="evidence"]`)?.focus();
      }
    });
    item.querySelector('.doc-arg__del').addEventListener('click', e => {
      e.stopPropagation();
      block.argsList.splice(i, 1);
      syncArgsPart(block);
      block.dirty = true;
      block.dirtyNotified = true;
      renderBlocks();
      addMessage('assistant', `Аргумент удалён из ${labelGen(block.label)}. Кнопка «Перегенерировать» активна.`);
    });
    item.querySelector('.doc-arg__fold')?.addEventListener('click', e => {
      e.stopPropagation();
      arg.groundsOpen = arg.groundsOpen === false;
      renderBlocks();
    });

    // перетаскивание аргументов
    const grip = item.querySelector('.doc-arg__grip');
    grip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/arg-idx', String(i));
      e.dataTransfer.setData('text/arg-block', block.id);
      item.classList.add('is-dragging');
    });
    grip.addEventListener('dragend', () => item.classList.remove('is-dragging'));
    item.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('text/arg-idx')) return;
      e.preventDefault();
      item.classList.add('is-drop-target');
    });
    item.addEventListener('dragleave', () => item.classList.remove('is-drop-target'));
    item.addEventListener('drop', e => {
      item.classList.remove('is-drop-target');
      if (e.dataTransfer.getData('text/arg-block') !== block.id) return;
      const from = +e.dataTransfer.getData('text/arg-idx');
      if (Number.isNaN(from) || from === i) return;
      e.preventDefault();
      const moved = block.argsList.splice(from, 1)[0];
      block.argsList.splice(i, 0, moved);
      syncArgsPart(block);
      block.dirty = true;
      renderBlocks();
    });

    wrap.appendChild(item);

    if (ARGS_MODE === 'tree') wrap.appendChild(buildGroundsEl(block, arg));
  });

  // постоянный пустой довод-плейсхолдер вместо кнопки добавления
  const empty = document.createElement('div');
  empty.className = 'doc-arg doc-arg--empty';
  empty.innerHTML = `
    <span class="doc-arg__grip" style="visibility:hidden">⋮⋮</span>
    <div class="doc-arg__main"><div class="doc-arg__text" contenteditable="true" data-ph="${ARGS_MODE === 'flat' ? 'Добавьте свой довод и его основания (норма, практика, доказательство)' : 'Добавьте свой довод — Enter создаст следующий'}"></div></div>`;
  const emptyText = empty.querySelector('.doc-arg__text');
  emptyText.addEventListener('input', () => {
    const val = emptyText.innerText.trim();
    if (!val) return;
    block.argsList = block.argsList || [];
    block.argsList.push({ text: val, source: null, auto: false, poolIdx: null, grounds: [] });
    syncArgsPart(block);
    markDirty(block, 'Доводы', 'arguments');
    // элемент становится настоящим доводом, ниже появляется новый пустой
    renderBlocks();
    const items = document.querySelectorAll(`.doc-block[data-block-id="${block.id}"] .doc-arg:not(.doc-arg--empty) .doc-arg__text`);
    const lastReal = items[items.length - 1];
    if (lastReal) {
      lastReal.focus();
      const r = document.createRange();
      r.selectNodeContents(lastReal);
      r.collapse(false);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  });
  // Enter в пустом поле — сразу перейти к следующему доводу
  emptyText.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (emptyText.innerText.trim()) focusNewArg(block);
    }
  });
  empty.addEventListener('click', e => e.stopPropagation());
  wrap.appendChild(empty);

  return wrap;
}

/** Enter в доводе: создаём следующий пустой и ставим в него курсор. */
function focusNewArg(block) {
  const el = document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-arg--empty .doc-arg__text`);
  if (!el) return;
  el.focus();
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
  el.scrollIntoView({ block: 'nearest' });
}

/** Обновление аргументов после изменения связанных данных (источников). */
async function refreshArguments(block) {
  if (state.busy) return;
  await think(`Обновляю аргументы ${labelGen(block.label)}`, 1500);

  const hasPractice = !!(block.parts && block.parts.find(p => p.key === 'practice'));
  const hasCirc = !!(block.parts && block.parts.find(p => p.key === 'circumstances'));
  block.argsList = (block.argsList || []).filter(a => {
    if (!a.auto) return true;
    if (a.source === 'practice' && !hasPractice) return false;
    if (a.source === 'circumstances' && !hasCirc) return false;
    return true;
  });
  if ((block.evidence || []).length && !block.argsList.some(a => a.source === 'evidence')) {
    block.argsList.push({ text: 'Позиция защиты подтверждается приобщёнными доказательствами, исследованными в судебном заседании.', source: 'evidence', auto: true, poolIdx: null });
  }
  block.argsStale = false;
  syncArgsPart(block);
  block.dirty = true;
  block.dirtyNotified = true;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Аргументы ${labelGen(block.label)} обновлены с учётом изменённых данных. Проверьте состав и нажмите «Перегенерировать».`);
}

/** Пометить аргументы устаревшими (изменился связанный подблок) без перерисовки. */
function markArgsStale(block) {
  if (!block.parts || block.argsStale) return;
  block.argsStale = true;
  const el = document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-args`);
  if (el && !el.querySelector('.doc-args__stale')) {
    const banner = document.createElement('div');
    banner.className = 'doc-args__stale';
    banner.innerHTML = '<span>Данные обновлены</span><button type="button">Обновить аргументы</button>';
    banner.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      refreshArguments(block);
    });
    el.prepend(banner);
  }
  updateChecklist();
}

/** Кликабельные нормы права в «Нормативной опоре». */
function linkifyNorms(html) {
  if (!html || html.includes('norm-link')) return html;
  let out = html;
  Object.keys(NORMS_DB).sort((a, b) => b.length - a.length).forEach(k => {
    out = out.split(k).join(`<span class="norm-link" data-norm="${k}">${k}</span>`);
  });
  return out;
}

function openNormModal(key) {
  const db = NORMS_DB[key];
  if (!db) return;
  openModal({
    title: `Нормативная база · ${db.act}`,
    bodyHtml: `<div class="norm-view"><div class="norm-view__title">${db.title}</div><p>${db.text}</p></div>`,
    buttons: [{ label: 'Закрыть' }]
  });
}

// capture-фаза: клики подблоков гасят всплытие, а норма должна открыться в любом случае
docBlocksEl.addEventListener('click', e => {
  const link = e.target.closest('.norm-link');
  if (link) {
    e.stopPropagation();
    e.preventDefault();
    openNormModal(link.dataset.norm);
  }
}, true);

/** Подблок сгенерированного текста (снизу); пустой — с ручным вводом. */
function buildGenerated(block) {
  const gen = document.createElement('div');
  gen.className = 'doc-generated';
  gen.contentEditable = 'false';
  // подпись «Текст блока» не нужна — текст говорит сам за себя
  gen.innerHTML = `
    <div class="doc-generated__body" contenteditable="true" data-ph="Введите текст блока…">${block.generated || ''}</div>`;
  const body = gen.querySelector('.doc-generated__body');
  body.addEventListener('input', () => {
    block.generated = body.innerHTML;
  });
  return gen;
}

/** «Блок 3» → «Блока 3» для отбивок в чат. */
const labelGen = label => (label || '').replace(/^Блок /, 'Блока ');

/** Ручное изменение конструктора: активируем «Перегенерировать», одно уведомление в чат. */
function markDirty(block, what, partKey) {
  block.dirty = true;
  // иконка перегенерации в ряду действий становится активной
  const btn = document.querySelector(`.doc-block[data-block-id="${block.id}"] [data-h="regen"]`);
  if (btn) {
    btn.disabled = false;
    btn.classList.add('is-on');
    btn.title = 'Перегенерировать текст по данным конструктора';
  }
  // предупреждение «текст не соответствует конструктору» — сразу, без перерисовки
  // (перерисовка увела бы курсор из поля, которое пользователь правит)
  const ctor = document.querySelector(`.doc-block[data-block-id="${block.id}"] .doc-constructor`);
  if (ctor && !ctor.querySelector('.doc-stale')) {
    const stale = document.createElement('div');
    stale.className = 'doc-stale';
    stale.innerHTML = '<span>Текст блока не соответствует конструктору</span><button type="button">Обновить текст</button>';
    stale.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      onRegenerateClick(block);
    });
    ctor.appendChild(stale);
  }
  // связанные с аргументами подблоки изменились — аргументы требуют обновления
  if (partKey && partKey !== 'arguments' && ['norms', 'practice', 'circumstances', 'other', 'evidence'].includes(partKey)) {
    markArgsStale(block);
  }
  if (!block.dirtyNotified) {
    block.dirtyNotified = true;
    addMessage('assistant', `Изменён конструктор ${labelGen(block.label)}: ${what.toLowerCase()}. Кнопка «Перегенерировать» стала активна.`);
  }
  updateChecklist();
}

async function onRegenerateClick(block) {
  if (state.busy || !block.dirty) return;

  // с подключённой нейронкой — складный юридический текст по данным конструктора,
  // включая содержание нормативных актов; без неё — шаблонная сборка
  if (typeof LLM !== 'undefined' && LLM.enabled()) {
    try {
      const text = await thinkWhile(`Анализирую данные конструктора и генерирую текст ${labelGen(block.label)} нейросетью`, () =>
        LLM.complete(fillPrompt(PROMPTS.regenerateBlock, blockPromptVars(block)), { maxTokens: 8000 }));
      block.generated = text.split(/\n{2,}/).map(p => `<p>${p.trim()}</p>`).join('');
      addMessage('assistant', `Текст ${labelGen(block.label)} сгенерирован нейросетью по данным конструктора.`);
    } catch (err) {
      block.generated = generateFromParts(block.parts);
      addMessage('assistant', `(ИИ недоступен: ${err.message} — текст собран по шаблону.)`);
    }
  } else {
    await think(`Перегенерирую текст ${labelGen(block.label)}`, 1800);
    block.generated = generateFromParts(block.parts);
    addMessage('assistant', `Текст ${labelGen(block.label)} перегенерирован по данным конструктора.`);
  }

  block.dirty = false;
  block.dirtyNotified = false;
  renderBlocks();
  flashBlock(block.id);
}

function toggleConstructor(block) {
  block.constructorDone = !block.constructorDone;
  renderBlocks();
}

function renderBlocks() {
  docBlocksEl.innerHTML = '';
  let counter = 0;

  const renderBlockEl = block => {
    counter += 1;
    block.label = `Блок ${counter}`;
    const issues = blockIssues(block);
    const issuesOk = !issues.length;
    const isCtor = !!(block.parts && block.parts.length);
    const el = document.createElement('div');
    // готовность блока показывает вертикальная полоса у текста (галок и меток нет)
    el.className = 'doc-block' + (block.id === state.activeBlockId ? ' is-active' : '') +
      (issuesOk ? ' is-ok' : ' is-warn');
    el.dataset.blockId = block.id;
    el.title = issuesOk ? '' : issues.join('; ');

    // ЛЕВАЯ колонка — маргиналия: короткое название раздела и, если чего-то не
    // хватает, жёлтая метка-переход к проблемному месту; детали (эпизод, тезис)
    // раскрываются у активного/наведённого блока
    const details = blockDetails(block);
    const needsEv = blockLacksEvidence(block);
    const info = document.createElement('div');
    info.className = 'doc-info';
    info.contentEditable = 'false';
    // отдельной ручки нет: блок перетаскивается за само название раздела
    info.innerHTML = `
      <div class="doc-info__row">
        <span class="doc-info__title" draggable="true"
              title="${blockSummary(block).replace(/"/g, '&quot;')}&#10;Перетащите, чтобы переставить блок">${blockLead(block)}</span>
      </div>
      ${needsEv ? `<button class="doc-info__alert" data-h="needs-ev" title="Развернуть конструктор и перейти к аргументу без доказательства">Не хватает доказательств</button>` : ''}
      ${details.episode ? `<div class="doc-info__episode">${details.episode}</div>` : ''}
      ${details.thesis ? `<div class="doc-info__thesis" title="${details.thesis.replace(/"/g, '&quot;')}">${details.thesis}</div>` : ''}`;

    info.querySelector('[data-h="needs-ev"]')?.addEventListener('click', e => {
      e.stopPropagation();
      setActiveBlock(block.id);
      if (state.busy) return;
      scrollToNeedyArg(block);
    });

    // ПРАВАЯ колонка: служебный ряд (свернуть/удалить) + кнопки действий с подписями
    const act = document.createElement('div');
    act.className = 'doc-act';
    act.contentEditable = 'false';
    // сетка 2×2: частые действия сверху (конструктор · ИИ), реже/опасное снизу
    // (перегенерация · удаление); у секций без конструктора — один ряд: ИИ · удаление
    const svgAi = '<svg viewBox="0 0 24 24"><path d="M16.5 3.5a2.4 2.4 0 1 1 3.4 3.4L7 19.8 2.5 21l1.2-4.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="m19 13 .8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" fill="currentColor"/></svg>';
    const svgDel = '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m3 0-.7 12.1a2 2 0 0 1-2 1.9H8.7a2 2 0 0 1-2-1.9L6 7m4 4v6m4-6v6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const svgToggle = `<svg viewBox="0 0 24 24" style="transform: rotate(${block.constructorDone ? 0 : 180}deg)"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const svgRegen = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const btnAi = `<button class="head-ic head-ic--ai" data-h="ai" title="Редактировать с ИИ">${svgAi}</button>`;
    const btnDel = `<button class="head-ic head-ic--del" data-h="delete" title="Удалить блок">${svgDel}</button>`;
    const btnToggle = `<button class="head-ic" data-h="toggle" title="${block.constructorDone ? 'Открыть конструктор' : 'Закрыть конструктор'}">${svgToggle}</button>`;
    const btnRegen = `<button class="head-ic head-ic--regen${block.dirty ? ' is-on' : ''}" data-h="regen" ${block.dirty ? '' : 'disabled'} title="${block.dirty ? 'Перегенерировать текст по данным конструктора' : 'Перегенерация доступна после изменений в конструкторе'}">${svgRegen}</button>`;
    act.innerHTML = isCtor
      ? `<div class="doc-act__row">${btnToggle}${btnAi}</div>
         <div class="doc-act__row">${btnRegen}${btnDel}</div>`
      : `<div class="doc-act__row">${btnAi}${btnDel}</div>`;
    act.appendChild(buildBlockMeta(block));

    act.querySelector('[data-h="ai"]').addEventListener('click', e => {
      e.stopPropagation();
      setActiveBlock(block.id);
      if (state.busy) return;
      onStarAction({ id: 'rewrite', label: BLOCK_ACTION_LABELS['rewrite'], needsBlock: true });
    });
    act.querySelector('[data-h="regen"]')?.addEventListener('click', e => {
      e.stopPropagation();
      onRegenerateClick(block);
    });
    act.querySelector('[data-h="toggle"]')?.addEventListener('click', e => {
      e.stopPropagation();
      toggleConstructor(block);
    });
    act.querySelector('[data-h="delete"]').addEventListener('click', e => {
      e.stopPropagation();
      confirmDeleteBlock(block);
    });

    // перетаскивание блока за название раздела
    const grip = info.querySelector('.doc-info__title');
    grip.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/block-id', block.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('is-dragging');
    });
    grip.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', e => {
      if (![...e.dataTransfer.types].includes('text/block-id')) return;
      e.preventDefault();
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('is-drop-target'));
    el.addEventListener('drop', e => {
      const dragId = e.dataTransfer.getData('text/block-id');
      el.classList.remove('is-drop-target');
      if (!dragId || dragId === block.id) return;
      e.preventDefault();
      const from = state.blocks.findIndex(b => b.id === dragId);
      const target = state.blocks.findIndex(b => b.id === block.id);
      const dragged = state.blocks[from];
      if (!dragged || (dragged.section || 'defense') !== (block.section || 'defense')) return;
      state.blocks.splice(from, 1);
      // тянем вниз — встаём ПОСЛЕ цели, вверх — перед ней (иначе перенос на
      // соседа снизу возвращал блок на прежнее место)
      const idx = state.blocks.findIndex(b => b.id === block.id);
      state.blocks.splice(from < target ? idx + 1 : idx, 0, dragged);
      renderBlocks();
      addMessage('assistant', `${dragged.label} перемещён.`);
    });

    // три колонки: описание — текст — кнопки
    const body = document.createElement('div');
    body.className = 'doc-block__body';
    el.appendChild(info);
    el.appendChild(body);
    el.appendChild(act);

    if (isCtor) {
      // конструкторный блок: конструктор (если открыт) -> сгенерированный текст
      el.contentEditable = 'false';
      if (!block.constructorDone) body.appendChild(buildConstructor(block));
      body.appendChild(buildGenerated(block));
    } else {
      const content = document.createElement('div');
      content.className = 'doc-block__content';
      content.contentEditable = 'true';
      content.innerHTML = block.html;
      body.appendChild(content);
      // правки пользователя сохраняются в стейт и переживают перерисовку
      content.addEventListener('input', () => {
        block.html = content.innerHTML;
        updateChecklist();
      });
    }

    el.addEventListener('focusin', () => setActiveBlock(block.id));
    el.addEventListener('click', () => {
      setActiveBlock(block.id);
      if (state.activeSubpart && state.activeSubpart.blockId === block.id) setActiveSubpart(null);
    });
    docBlocksEl.appendChild(el);
  };

  // точка вставки нового блока между блоками (появляется при наведении, «+» слева)
  const addInsertZone = afterBlock => {
    const z = document.createElement('div');
    z.className = 'doc-insert';
    z.contentEditable = 'false';
    z.innerHTML = '<div class="doc-insert__line"></div><button class="doc-insert__btn" title="Создать блок здесь">+</button>';
    z.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      insertEmptyBlock(afterBlock.id, afterBlock.section || 'defense');
    });
    docBlocksEl.appendChild(z);
  };

  // постоянная точка вставки в конце, перед просительной частью
  const appendAddBlockButton = () => {
    const btn = document.createElement('button');
    btn.className = 'doc-add-block';
    btn.textContent = '+ Новый блок';
    btn.title = 'Добавить блок в конец документа, перед просительной частью';
    btn.addEventListener('click', () => insertEmptyBlock(null, 'defense'));
    docBlocksEl.appendChild(btn);
  };

  if (!state.structure) {
    if (!state.blocks.length) {
      docBlocksEl.innerHTML = '<div class="doc-empty">В документе пока нет блоков — текст появится по мере работы сценариев</div>';
    } else {
      state.blocks.forEach(b => { renderBlockEl(b); addInsertZone(b); });
    }
    appendAddBlockButton();
    updateChecklist();
    return;
  }

  // документ со структурой: секции по порядку, пустая секция = рамка-плейсхолдер
  // (секции-шаблоны, template: true, рамок не имеют — заполняются текстом сразу)
  SECTION_ORDER.forEach(sec => {
    const secBlocks = state.blocks.filter(b => (b.section || 'defense') === sec);
    const ph = state.structure.find(p => p.kind === sec);
    if (secBlocks.length) secBlocks.forEach(b => { renderBlockEl(b); addInsertZone(b); });
    else if (ph && !ph.template) docBlocksEl.appendChild(buildPlaceholder(ph));
  });
  appendAddBlockButton();
  updateChecklist();
  markShortBlocks();
}

/**
 * У коротких блоков скобка на полях рисуется без загибов — иначе она
 * читается рамкой-выделением, а не разметкой границ блока.
 */
// порог по высоте текста (~3 строки), а не по высоте блока: у блока своя
// минимальная высота из-за колонок с кнопками
const SHORT_BLOCK_H = 82;
function markShortBlocks() {
  const apply = () => document.querySelectorAll('.doc-block').forEach(el => {
    const body = el.querySelector('.doc-block__body');
    const h = body ? body.getBoundingClientRect().height : 0;
    // блок в процессе генерации короткий лишь временно — скобку не урезаем
    const pending = !!el.querySelector('.gen-pending');
    el.classList.toggle('is-short', !pending && h < SHORT_BLOCK_H);
  });
  apply();                        // сразу после рендера
  requestAnimationFrame(apply);   // и ещё раз, когда контент дорисован
}

/** Пустой блок в указанном месте: сразу активен, можно печатать или привязать линию. */
function insertEmptyBlock(afterId, section) {
  const opts = afterId ? { afterId, section, kind: 'manual' } : { section, kind: 'manual' };
  const id = insertBlock('', opts);
  setActiveBlock(id);
  const el = document.querySelector(`.doc-block[data-block-id="${id}"]`);
  if (el) el.focus();
  addMessage('assistant', `Добавлен пустой ${getBlock(id).label} — введите текст прямо в документе или привяжите линию защиты.`);
}

/* ================= Просительная часть ================= */

function pleaIntro() {
  const k = state.docType ? state.docType.key : null;
  if (k === 'appeal') return 'На основании изложенного, руководствуясь ст. 389.15, 389.20 УПК РФ, ПРОШУ:';
  if (k === 'cassation') return 'На основании изложенного, руководствуясь ст. 401.14, 401.15 УПК РФ, ПРОШУ:';
  if (k === 'motion') return 'На основании изложенного, руководствуясь ст. 119–122 УПК РФ, ПРОШУ:';
  return 'На основании изложенного ПРОШУ:';
}

function renderPleas() {
  if (!state.pleas.length) {
    // рамка-плейсхолдер просительной части (не интерактивная — по спеке)
    if (state.structure && state.structure.some(p => p.kind === 'pleas')) {
      const after = state.docType && state.docType.key === 'motion' ? 'обоснования' : 'защитной части';
      docPleasEl.innerHTML = `
        <div class="doc-ph doc-ph--static">
          <div class="doc-ph__title">Просительная часть</div>
          <div class="doc-ph__note">Будет сгенерирована автоматически после заполнения ${after}</div>
        </div>`;
    } else {
      docPleasEl.innerHTML = '';
    }
    updateChecklist();
    return;
  }
  docPleasEl.innerHTML = `
    <div class="doc-pleas" contenteditable="true">
      <div class="doc-pleas__intro">${pleaIntro()}</div>
      <ol>${state.pleas.map(p => `<li>${p}</li>`).join('')}</ol>
    </div>`;
  updateChecklist();
}

/** Добавляет пункт в просительную часть (без дублей) и подсвечивает её. */
function addPlea(text) {
  if (!text || state.pleas.includes(text)) return;
  state.pleas.push(text);
  renderPleas();
  const el = docPleasEl.querySelector('.doc-pleas');
  if (el) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }
}

/* ================= Структура документа: плейсхолдеры и чеклист (ревизия 16.07.26) ================= */

const factsFilled = () => state.blocks.some(b => (b.section || 'defense') === 'facts');

const PH_ACTION_TITLES = {
  'verdict-card': 'Заполнить описание приговора',
  'verdict-own': 'Описание приговора своими словами',
  'facts-card': 'Заполнить обстоятельства из карточки дела',
  'facts-verdict': 'Разбор файла',
  'facts-own': 'Заполнить обстоятельства своими словами',
  'admission-fill': 'Заполнить признание по эпизодам',
  'defense-add': 'Создание линии защиты',
  'law-auto': 'Подобрать правовое обоснование',
  'law-own': 'Правовое обоснование своими словами'
};

/** Подсказка на рамке-плейсхолдере: клик сразу вставляет блок. */
const PH_HINT = {
  verdict: 'Нажмите, чтобы вставить описание судебного акта',
  facts: 'Нажмите, чтобы вставить описание обстоятельств дела',
  admission: 'Нажмите, чтобы вставить позицию по приговору',
  defense: 'Нажмите, чтобы добавить блок защитной части',
  law: 'Нажмите, чтобы вставить правовое обоснование'
};

/** Рамка-плейсхолдер секции: клик по рамке сразу вставляет блок (без кнопок выбора). */
function buildPlaceholder(ph) {
  const el = document.createElement('div');
  el.className = 'doc-ph doc-ph--click';
  el.dataset.kind = ph.kind;
  el.innerHTML = `
    <div class="doc-ph__title">${ph.title}</div>
    <div class="doc-ph__note">${PH_HINT[ph.kind] || 'Нажмите, чтобы вставить блок'} · правка с ИИ доступна после вставки</div>`;
  el.addEventListener('click', () => onPlaceholderClick(ph.kind));
  return el;
}

/** Первичное действие вставки для секции (без выбора — сразу блок). */
function placeholderInsert(kind) {
  switch (kind) {
    case 'verdict': return runPlaceholderAction(state.card.verdict ? 'verdict-card' : 'verdict-own');
    case 'facts': return runPlaceholderAction(state.card.episodes.length ? 'facts-card' : 'facts-own');
    case 'admission': return runPlaceholderAction('admission-fill');
    case 'law': return runPlaceholderAction('law-auto');
    case 'defense': insertEmptyBlock(null, 'defense'); return;
  }
}

/** Клик по рамке-плейсхолдеру: вставка блока; поверх сценария спрашиваем «прервать?». */
function onPlaceholderClick(kind) {
  if (state.busy) return;
  const run = () => placeholderInsert(kind);
  if (state.scenario) {
    askInterrupt(`Вставка блока: ${(state.structure.find(p => p.kind === kind) || {}).title || kind}`, run);
    return;
  }
  run();
}

async function runPlaceholderAction(act) {
  switch (act) {
    case 'verdict-card': {
      await think('Формирую описание приговора', 1500);
      const vId = await insertSectionBlock('verdict', composeVerdictText(), { atStart: true, section: 'verdict', kind: 'verdict' });
      maybeInsertAppealGrounds(vId);
      addMessage('assistant', 'Описание приговора заполнено из карточки дела' + (state.docType && state.docType.key === 'appeal' ? '; добавлен стандартный блок оснований для отмены/изменения приговора.' : '.'));
      break;
    }

    case 'verdict-own': {
      const vId = insertBlock('<span class="ph-mark">Опишите приговор первой инстанции</span>', { atStart: true, section: 'verdict', kind: 'verdict-own' });
      maybeInsertAppealGrounds(vId);
      addMessage('assistant', 'Заполните описание приговора самостоятельно в документе.');
      break;
    }

    case 'facts-card':
      state.factsSource = 'card';
      await think('Формирую описание обстоятельств из карточки дела', 1600);
      await insertSectionBlock('facts', composeFactsText(), { atStart: true, section: 'facts', kind: 'facts' });
      addMessage('assistant', 'Обстоятельства дела заполнены из карточки дела.');
      await maybeAutoAdmission();
      break;

    case 'facts-verdict':
      state.factsSource = 'verdict';
      runDocxScenario(); // сценарий 3, по завершении сам запустит 17
      break;

    case 'facts-own':
      state.factsSource = 'own';
      insertBlock('<span class="ph-mark">Опишите обстоятельства дела</span>', { atStart: true, section: 'facts', kind: 'facts-own' });
      addMessage('assistant', 'Заполните обстоятельства дела самостоятельно в документе или сформулируйте кратко в чате.');
      break;

    case 'admission-fill':
      await think('Формирую позицию по приговору', 1400);
      await insertSectionBlock('admission', composeAdmissionText(), { section: 'admission', kind: 'admission' });
      addMessage('assistant', 'Позиция по приговору заполнена.');
      break;

    case 'defense-add':
      startCreateLine(); // сценарий 6
      break;

    case 'law-auto':
      await think('Подбираю правовое обоснование', 1500);
      insertBlock(MOTION_LAW_TEXT, { section: 'law', kind: 'law' });
      addMessage('assistant', 'Правовое обоснование добавлено в документ.');
      break;

    case 'law-own':
      insertBlock('<span class="ph-mark">Изложите правовое обоснование ходатайства</span>', { section: 'law', kind: 'law-own' });
      addMessage('assistant', 'Заполните правовое обоснование самостоятельно в документе.');
      break;
  }
}

/** Разово поясняем в чате индикацию готовности блоков полосой. */
function maybeExplainWarnings() {
  if (state.warnExplained) return;
  if (!state.blocks.some(b => blockIssues(b).length)) return;
  state.warnExplained = true;
  const el = addMessage('assistant', '');
  el.innerHTML = 'Готовность блока показывает вертикальная полоса у текста: зелёная — блок заполнен, <span class="msg-warn-icon">жёлтая</span> — требует завершения, например не хватает доказательств. Чего именно не хватает, видно в описании блока.';
  scrollFeed();
}

/** Если позиция по приговору известна по всем эпизодам — генерируем секцию автоматически. */
async function maybeAutoAdmission({ silent, deferred } = {}) {
  if (!state.structure || !state.structure.some(p => p.kind === 'admission')) return false;
  if (state.blocks.some(b => (b.section || 'defense') === 'admission')) return false;
  const eps = state.card.episodes;
  if (!eps.length || !eps.every(ep => ep.admission)) return false;

  await think('Формирую позицию по приговору', 1200);
  await insertSectionBlock('admission', composeAdmissionText(), { section: 'admission', kind: 'admission', deferred });
  if (!silent) addMessage('assistant', 'Позиция по приговору заполнена автоматически по данным карточки дела.');
  return true;
}

/* ---------- Идентификация эпизодов (кратко и конкретно, без «эпизод N») ---------- */

/** Суть/место эпизода без служебного «Эпизод N —» и без хвостовой квалификации в скобках. */
function episodePlace(ep, i) {
  let d = (ep.title || '').replace(/^Эпизод\s*\d+\s*[—:–-]\s*/i, '').trim();
  d = d.replace(/\s*\([^()]*\)\s*$/, '').trim();
  if (!d || /^из введённой фабулы/i.test(d)) {
    const t = stripTags(ep.text || '').replace(/\s+/g, ' ').trim();
    d = t ? t.split(/[.;]/)[0].slice(0, 70).trim() : '';
  }
  return d;
}

/** Развёрнутое «по факту совершения деяния…» для начала предложения (фабула). */
function episodeFactRef(ep, i) {
  const qual = ep.qualification || '';
  const place = episodePlace(ep, i);
  const base = qual
    ? `по факту совершения деяния, предусмотренного ${qual}`
    : `по факту совершения инкриминируемого деяния`;
  return place ? `${base} (${place})` : base;
}

/** Родительный «деяния, предусмотренного …» — для встраивания в оборот (позиция). */
function episodeDeedRef(ep, i) {
  const qual = ep.qualification || '';
  const place = episodePlace(ep, i);
  const base = qual ? `деяния, предусмотренного ${qual}` : `инкриминируемого деяния`;
  return place ? `${base} (${place})` : base;
}

/** Краткий идентификатор эпизода для сводки/чипа блока. */
function episodeShort(ep, i) {
  return episodePlace(ep, i) || (ep.qualification ? `по ${ep.qualification}` : `эпизод ${i + 1}`);
}

/** Классификация статуса признания по свободному тексту. */
function admissionKind(admText) {
  const s = (admText || '').toLowerCase();
  if (!s.trim()) return 'unknown';
  if (/частичн/.test(s)) return 'partial';
  if (/не\s+призна|не\s+согла|не\s+винов/.test(s)) return 'deny';
  if (/призна|винов/.test(s)) return 'full';
  return 'unknown';
}

const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/** Блок «Позиция по приговору»: несогласие по статусу признания, кратко. */
function composeAdmissionText() {
  if (state.factsSource === 'own') {
    return '<p><span class="ph-mark">Информация о признании отсутствует — введите позицию по приговору вручную.</span></p>';
  }
  const fromVerdict = state.factsSource === 'verdict';
  const eps = state.card.episodes;

  // нет данных о признании ни в карточке дела, ни в приговоре — просим ввести вручную
  const noData = !eps.length || eps.every(ep => !ep.admission);
  if (noData && !fromVerdict) {
    return '<p><span class="ph-mark">Информация о признании вины не найдена в карточке дела и в приговоре — введите позицию по приговору вручную.</span></p>';
  }

  const single = eps.length === 1;
  const rows = eps.map((ep, i) => {
    const deed = episodeDeedRef(ep, i);
    switch (admissionKind(ep.admission || (fromVerdict ? 'вину не признал' : ''))) {
      case 'full':
        return `сторона защиты, не оспаривая решение суда и причастность подзащитного к совершению ${single ? 'преступления' : deed}, не согласна с квалификацией содеянного и справедливостью назначенного наказания`;
      case 'partial':
        return `сторона защиты не согласна с решением суда в части${single ? ' квалификации содеянного и назначенного наказания' : ', касающейся ' + deed}`;
      case 'deny':
        return `сторона защиты не согласна с решением суда${single ? '' : ' в отношении ' + deed}, полагая выводы о виновности не подтверждёнными совокупностью исследованных доказательств`;
      default:
        return `по эпизоду «${episodeShort(ep, i)}» <span class="ph-mark">статус признания не найден — укажите позицию вручную</span>`;
    }
  });
  return `<p>${cap(rows.join('; '))}.</p>`;
}

/* ---------- Чеклист наполнения (строка состояния) ---------- */

const docChecklistEl = $('#doc-checklist');

const CHECK_ICONS = {
  empty: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" opacity=".18"/><path d="M12 7v6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1.3" fill="currentColor"/></svg>',
  done: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="currentColor" opacity=".18"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

const hasTextPlaceholder = html => /ph-mark|&lt;вставить|<вставить/i.test(html || '');

function updateChecklist() {
  if (!docChecklistEl) return;
  if (!state.docType || !state.structure) {
    docChecklistEl.hidden = true;
    return;
  }

  const items = [];

  // шапка — обязательно; незавершённое заполнение (плейсхолдеры) подсвечиваем жёлтым
  const headerHtml = docHeaderBodyEl.innerHTML;
  const headerHasPh = /ph-mark|вставить/i.test(headerHtml);
  const headerEmpty = /placeholder/i.test(headerHtml);
  items.push({ label: 'Шапка', kind: 'header', st: headerEmpty ? 'empty' : headerHasPh ? 'warn' : 'done' });

  state.structure.forEach(ph => {
    if (ph.kind === 'pleas') {
      items.push({ label: ph.title, kind: 'pleas', st: state.pleas.length ? 'done' : 'empty' });
      return;
    }
    const secBlocks = state.blocks.filter(b => (b.section || 'defense') === ph.kind);
    if (!secBlocks.length) {
      items.push({ label: ph.title, kind: ph.kind, st: 'empty' });
      return;
    }
    // текстовые плейсхолдеры внутри — заполнение не завершено, жёлтым
    const blockHasPh = b => hasTextPlaceholder(b.html) ||
      (b.parts && b.parts.some(p => hasTextPlaceholder(p.html))) ||
      hasTextPlaceholder(b.generated);
    if (secBlocks.some(blockHasPh)) {
      items.push({ label: ph.title, kind: ph.kind, st: 'warn' });
      return;
    }
    if (ph.kind === 'defense') {
      const issuesFree = secBlocks.every(b => !blockIssues(b).length);
      items.push({ label: ph.title, kind: ph.kind, st: issuesFree ? 'done' : 'warn' });
      return;
    }
    items.push({ label: ph.title, kind: ph.kind, st: 'done' });
  });

  docChecklistEl.hidden = false;
  docChecklistEl.innerHTML = items.map(i =>
    `<button class="check-item check-item--${i.st}" data-goto="${i.kind || ''}" title="${i.st === 'done' ? 'Готово' : i.st === 'warn' ? 'Имеются недостатки' : 'Не заполнено'} — перейти к части">${CHECK_ICONS[i.st]}${i.label}</button>`
  ).join('');
  docChecklistEl.querySelectorAll('[data-goto]').forEach(btn =>
    btn.addEventListener('click', () => scrollToSection(btn.dataset.goto)));
}

/** Плавный скролл к элементу документа с гарантированным фолбэком. */
function smoothScrollTo(el) {
  const scroller = document.querySelector('#doc-scroll');
  const top = Math.max(0, el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 70);
  scroller.scrollTo({ top, behavior: 'smooth' });
  setTimeout(() => {
    if (Math.abs(scroller.scrollTop - top) > 60) scroller.scrollTop = top;
  }, 450);
}

/** Переход к части документа из чеклиста + подсветка части. */
function scrollToSection(kind) {
  let el = null;
  if (kind === 'header') el = document.querySelector('.doc-header');
  else if (kind === 'pleas') el = document.querySelector('#doc-pleas .doc-pleas, #doc-pleas .doc-ph');
  else {
    const block = state.blocks.find(b => (b.section || 'defense') === kind);
    el = block
      ? document.querySelector(`.doc-block[data-block-id="${block.id}"]`)
      : document.querySelector(`.doc-ph[data-kind="${kind}"]`);
  }
  if (!el) return;
  smoothScrollTo(el);
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/** Метки источников аргументов. */
/** Откуда подобран довод — человеческим языком (бейдж + расшифровка в подсказке). */
const SRC_LABELS = {
  practice: 'по практике',
  circumstances: 'по обстоятельствам',
  norms: 'по нормам',
  evidence: 'по доказательствам',
  fact: 'по фактам дела'
};
const SRC_HINTS = {
  practice: 'Довод подобран автоматически по судебной практике',
  circumstances: 'Довод подобран автоматически по обстоятельствам дела',
  norms: 'Довод подобран автоматически по нормам права',
  evidence: 'Довод подобран автоматически по доказательствам',
  fact: 'Довод подобран автоматически по фактам дела'
};

/** Стартовый список аргументов по линии: первые два из пула, авто (с основаниями). */
function defaultArgsList(line) {
  const pool = line.argumentsPool || [];
  if (!pool.length) {
    // осмысленный аргумент/тезис; заглушку REGEN_FALLBACK_TEXT в аргумент не подставляем —
    // иначе новый (ручной) блок получает короткий шаблонный текст вместо реального
    const raw = (line.argument && line.argument !== REGEN_FALLBACK_TEXT) ? line.argument : line.thesis;
    const text = (raw || '').replace(/\s+/g, ' ').trim();
    return text ? [{ text, source: 'fact', auto: true, poolIdx: null, grounds: [] }] : [];
  }
  return pool.slice(0, 2).map((a, i) => ({
    text: a.text, source: a.source, auto: true, poolIdx: i,
    grounds: (a.grounds || []).map(g => ({ ...g }))
  }));
}

/** Основание только из практики — рекомендуем подкрепить доказательством или нормой. */
function argOnlyPractice(arg) {
  const g = arg.grounds || [];
  return g.length > 0 && g.every(x => x.type === 'practice');
}

/** Аргументу не хватает доказательства (и пользователь не отметил «не нужны»). */
function argNeedsEvidence(arg) {
  if (arg.noEvidenceNeeded) return false;
  if (!(arg.text || '').trim()) return false;
  return !(arg.grounds || []).some(g => g.type === 'evidence' || (g.type === 'fact' && g.evidence));
}

/** Есть ли в блоке аргументы без доказательств. */
function blockLacksEvidence(block) {
  return !!(block.argsList && block.argsList.some(argNeedsEvidence));
}

/* ================= Нейронка (итерация 8): сбор контекста и вызовы ================= */

/** Короткая фактура дела для промтов. */
function caseSummaryForPrompt() {
  const c = state.card;
  const eps = c.episodes.map((e, i) => `${cap(episodeFactRef(e, i))}: ${stripTags(e.text).replace(/\s+/g, ' ').slice(0, 260)} Позиция по признанию: ${e.admission || 'не указана'}.`).join('\n');
  return [
    c.client ? `Доверитель: ${c.client}.` : '',
    c.verdict ? `Судебный акт: приговор ${c.verdict.courtName} от ${c.verdict.date}, ${c.verdict.qualification}, наказание: ${c.verdict.sentence}.` : '',
    eps,
    c.circumstances.length ? `Смягчающие обстоятельства: ${c.circumstances.join('; ')}.` : ''
  ].filter(Boolean).join('\n');
}

/** Данные конструктора блока для промта перегенерации (включая тексты норм). */
function blockPromptVars(block) {
  const line = state.card.lines.find(l => l.id === block.lineId) || {};
  const args = (block.argsList || []).map((a, i) => {
    const gr = (a.grounds || []).map(g => `  - ${GROUND_LABELS[g.type] || g.type}: ${stripTags(g.text)}${g.type === 'evidence' && g.proves ? ` (доказывает: ${stripTags(g.proves)})` : ''}`).join('\n');
    return `${i + 1}. ${a.text}${gr ? '\n' + gr : ''}`;
  }).join('\n');

  // тексты нормативных актов, упомянутых в основаниях и нормативке линии
  const mentioned = new Set();
  const scanText = `${line.norms || ''} ${(block.argsList || []).flatMap(a => (a.grounds || []).map(g => g.text)).join(' ')}`;
  Object.keys(NORMS_DB).forEach(k => { if (scanText.includes(k)) mentioned.add(k); });
  const normsWithTexts = [...mentioned].map(k => `${k} (${NORMS_DB[k].act}, ${NORMS_DB[k].title}): ${NORMS_DB[k].text}`).join('\n') || '—';

  const pool = (state.card.practice && state.card.practice.length) ? state.card.practice : PRACTICE_CASES;
  const practice = (block.selectedPractice || []).map(i => pool[i]).filter(Boolean)
    .map(p => `${p.num} (${p.court}) — ${p.decision || p.result}`).join('\n') || '—';

  // предыдущая редакция текста блока (плейсхолдер генерации не считается текстом)
  const prevText = stripTags(block.generated || '').replace(/\s+/g, ' ').trim();
  const previousText = prevText && !prevText.includes('Генерируется нейросетью') ? prevText : '—';

  return {
    docType: state.docType ? state.docType.label : 'процессуальный документ',
    lineTitle: shortLineTitle(line.title || ''),
    thesis: line.thesis || '—',
    argumentsWithGrounds: args || '—',
    normsWithTexts,
    practice,
    circumstances: state.card.circumstances.join('; ') || '—',
    caseSummary: caseSummaryForPrompt(),
    previousText
  };
}

/**
 * Генерация текста секции (описание судебного акта / обстоятельства / позиция
 * по приговору): с нейронкой — развёрнуто, без — шаблонный fallback.
 */
async function generateSectionText(kind, fallbackHtml) {
  if (typeof LLM === 'undefined' || !LLM.enabled()) return fallbackHtml;
  const names = { verdict: 'Описание судебного акта первой инстанции', facts: 'Описание обстоятельств дела', admission: 'Позиция по приговору' };
  try {
    const text = await thinkWhile(`Анализирую материалы дела и формирую раздел «${names[kind] || kind}» нейросетью`, () =>
      LLM.complete(fillPrompt(PROMPTS.generateSection, {
        sectionName: names[kind] || kind,
        docType: state.docType ? state.docType.label : 'документ',
        caseSummary: caseSummaryForPrompt(),
        sectionData: `Черновик раздела (можно опираться): ${stripTags(fallbackHtml).replace(/\s+/g, ' ')}`
      })));
    return text.split(/\n{2,}/).map(p => `<p>${p.trim()}</p>`).join('');
  } catch (err) {
    addMessage('assistant', `(ИИ недоступен: ${err.message} — использован шаблон.)`);
    return fallbackHtml;
  }
}

/** Информативный плейсхолдер на время генерации нейросетью. */
function pendingHtml(what) {
  return `<span class="gen-pending">Генерируется нейросетью: ${what}<span class="dots"></span></span>`;
}

/** Догенерация текста защитного блока нейронкой сразу после вставки. */
async function llmGenerateBlock(blockId) {
  if (typeof LLM === 'undefined' || !LLM.enabled()) return;
  const block = getBlock(blockId);
  if (!block || !block.parts) return;
  try {
    const text = await thinkWhile(`Анализирую данные конструктора и генерирую текст ${labelGen(block.label)} нейросетью`, () =>
      LLM.complete(fillPrompt(PROMPTS.regenerateBlock, blockPromptVars(block)), { maxTokens: 8000 }));
    block.generated = text.split(/\n{2,}/).map(p => `<p>${p.trim()}</p>`).join('');
    renderBlocks();
  } catch (err) {
    // не оставляем висящий плейсхолдер — откатываемся на шаблон
    block.generated = generateFromParts(block.parts);
    renderBlocks();
    addMessage('assistant', `(ИИ недоступен для ${labelGen(block.label)}: ${err.message} — оставлен шаблонный текст.)`);
  }
}

/** Отложенные генерации секций: blockId → {kind, fallbackHtml}; порядок задаёт generateInDocOrder. */
const deferredSectionFills = new Map();

/** Догенерация текста секции в уже вставленный pending-блок. */
async function fillSectionBlock(id, kind, fallbackHtml) {
  const text = await generateSectionText(kind, fallbackHtml);
  const block = getBlock(id);
  if (block) {
    block.html = text;
    renderBlocks();
    flashBlock(id);
  }
}

/**
 * Вставка секции (судебный акт / обстоятельства / позиция): с нейронкой блок
 * появляется сразу с информативным плейсхолдером, текст подтягивается по готовности.
 * opts.deferred — только вставить плейсхолдер; текст сгенерит generateInDocOrder.
 */
async function insertSectionBlock(kind, fallbackHtml, opts) {
  const names = { verdict: 'описание судебного акта первой инстанции', facts: 'описание обстоятельств дела по фабуле', admission: 'позиция по приговору' };
  if (typeof LLM === 'undefined' || !LLM.enabled()) {
    return insertBlock(fallbackHtml, opts);
  }
  const id = insertBlock(pendingHtml(names[kind] || kind), opts);
  if (opts && opts.deferred) {
    deferredSectionFills.set(id, { kind, fallbackHtml });
    return id;
  }
  await fillSectionBlock(id, kind, fallbackHtml);
  return id;
}

/**
 * Генерация текстов по порядку следования блоков в документе (сверху вниз):
 * секции с отложенной генерацией и защитные блоки из lineBlockIds.
 */
async function generateInDocOrder(lineBlockIds = []) {
  const order = state.structure
    ? SECTION_ORDER.flatMap(sec => state.blocks.filter(b => (b.section || 'defense') === sec))
    : [...state.blocks];
  for (const b of order) {
    const job = deferredSectionFills.get(b.id);
    if (job) {
      deferredSectionFills.delete(b.id);
      await fillSectionBlock(b.id, job.kind, job.fallbackHtml);
    } else if (lineBlockIds.includes(b.id)) {
      await llmGenerateBlock(b.id);
    }
  }
}

/** Текстовое представление аргументов (в tree — вместе с их основаниями). */
function argsListToHtml(argsList) {
  return (argsList || []).map(a => {
    let t = (a.text || '').trim();
    if (!t) return '';
    if (ARGS_MODE === 'tree' && a.grounds && a.grounds.length) {
      t += ` Это подтверждается: ${a.grounds.map(g =>
        `${g.text}${g.evidence ? ' (' + g.evidence + ')' : ''}${g.type === 'evidence' && g.proves ? ' — доказывает: ' + g.proves : ''}`).filter(Boolean).join('; ')}.`;
    }
    return t;
  }).filter(Boolean).join(' ');
}

/** Синхронизация подблока «Аргументы» с списком аргументов блока. */
function syncArgsPart(block) {
  if (!block.parts) return;
  const html = argsListToHtml(block.argsList);
  const part = block.parts.find(p => p.key === 'arguments');
  if (part) part.html = html;
  else block.parts.splice(1, 0, { key: 'arguments', title: 'Доводы', html });
}

/** Подблоки конструктора по линии защиты; sel — аргументы/дела практики. */
function buildLineParts(line, sel = {}) {
  const parts = [];
  parts.push({ key: 'line', title: 'Линия защиты', html: shortLineTitle(line.title) });
  // тезис — отдельный подблок (в текущей модели тезис один на линию, по ревизии №5)
  if (line.thesis) parts.push({ key: 'thesis', title: 'Тезис', html: line.thesis });

  const argsList = sel.argsList || defaultArgsList(line);
  parts.push({ key: 'arguments', title: 'Доводы', html: argsListToHtml(argsList) });

  if (ARGS_MODE === 'flat') {
    // плоский вариант: общие подблоки остаются на уровне блока
    if (line.norms) parts.push({ key: 'norms', title: 'Нормативная опора', html: line.norms });
    const practice = state.card.practice;
    if (practice && practice.length) {
      const pSel = (sel.selectedPractice || [0, 1]).filter(i => practice[i]);
      if (pSel.length) {
        parts.push({ key: 'practice', title: 'Практика', html: pSel.map(i => `${practice[i].num} (${practice[i].court}) — ${practice[i].result.toLowerCase()}`).join('; ') + '.' });
      }
    }
    if (state.card.circumstances && state.card.circumstances.length) {
      parts.push({ key: 'circumstances', title: 'Обстоятельства', html: state.card.circumstances.join('; ') + '.' });
    }
  }
  // в tree-режиме нормативка/практика/обстоятельства живут в основаниях аргументов —
  // на уровне блока не дублируются; отдельный подблок «Другие факты и доводы» убран,
  // свободные доводы добавляются как аргументы
  return parts;
}

/** Генерация текста блока по фактуре конструктора. */
function generateFromParts(parts) {
  const get = k => stripTags((parts.find(p => p.key === k) || {}).html || '').replace(/\.$/, '');
  const dot = s => s ? s + '.' : '';
  const args = get('arguments');
  // нет ядра (аргументов) — не собираем шаблонный обрывок: пусть блок покажет
  // плейсхолдер «Введите текст блока…», текст добавит пользователь или ИИ
  if (!args) return '';
  const circ = get('circumstances');
  const ev = get('evidence');
  const norms = get('norms');
  const practice = get('practice');

  let text = dot(args);
  if (circ) text += ` При оценке содеянного подлежат учёту обстоятельства: ${circ.charAt(0).toLowerCase()}${circ.slice(1)}.`;
  if (ev) text += ` Изложенное подтверждается доказательствами: ${ev.charAt(0).toLowerCase()}${ev.slice(1)}.`;
  if (norms) text += ` Правовое обоснование: ${norms}.`;
  if (practice) text += ` Аналогичная позиция отражена в судебной практике: ${practice}.`;
  return text.trim();
}

/** Вставка конструкторного блока по линии: конструктор + сразу сгенерированный текст. */
function insertLineBlock(line, opts = {}) {
  const argsList = defaultArgsList(line);
  const selectedPractice = state.card.practice && state.card.practice.length
    ? [0, 1].filter(i => state.card.practice[i]) : null;
  const parts = buildLineParts(line, { argsList, selectedPractice });
  // с нейронкой — информативный плейсхолдер вместо заглушечного текста до генерации
  const initialText = (typeof LLM !== 'undefined' && LLM.enabled())
    ? pendingHtml(`текст по линии «${shortLineTitle(line.title)}» — аргументы, основания, нормативная опора`)
    : generateFromParts(parts);
  const id = insertBlock('', { ...opts, lineId: line.id, parts, generated: initialText });
  const b = getBlock(id);
  b.argsList = argsList;
  b.selectedPractice = selectedPractice;
  b.argsStale = false;
  return id;
}

/** Привязка линии к блоку: полная перезаливка конструктора и текста. */
function applyLineToBlock(block, line, { silent } = {}) {
  block.lineId = line.id;
  block.argsList = defaultArgsList(line);
  block.argsStale = false;
  block.selectedPractice = state.card.practice && state.card.practice.length
    ? [0, 1].filter(i => state.card.practice[i]) : null;
  block.parts = buildLineParts(line, { argsList: block.argsList, selectedPractice: block.selectedPractice });
  block.generated = generateFromParts(block.parts);
  block.evidence = block.evidence || [];
  block.dirty = false;
  block.dirtyNotified = false;
  block.constructorDone = true; // свёрнут по умолчанию
  state.boundLines.add(line.id);
  addPlea(line.plea || PLEA_FALLBACK);
  renderBlocks();
  flashBlock(block.id);
  if (!silent) addMessage('assistant', `К ${labelGen(block.label).replace('Блока', 'Блоку')} привязана линия «${shortLineTitle(line.title)}» — конструктор и текст заполнены заново.`);
  // текст блока сразу генерится нейронкой (если подключена)
  llmGenerateBlock(block.id);
}

/** «Вся информация блока будет удалена» — блок становится пустым. */
function clearBlockInfo(block) {
  block.lineId = null;
  block.parts = null;
  block.generated = '';
  block.html = '';
  block.evidence = [];
  block.argsList = null;
  block.argsStale = false;
  block.selectedPractice = null;
  block.dirty = false;
  block.dirtyNotified = false;
  block.constructorDone = false;
  renderBlocks();
  updateChecklist();
}

/**
 * Текст блока по линии — сущности отдельными абзацами (ревизия v3):
 * линия защиты, аргументы, нормативка, практика, обстоятельства.
 * Доказательства добавляются своим абзацем при привязке (16.1).
 */
function composeBlockText(line) {
  const paras = [];
  paras.push(`<p><b>Линия защиты:</b> ${shortLineTitle(line.title)}${line.thesis ? '. Тезис: ' + line.thesis : ''}</p>`);
  paras.push(`<p><b>Аргументы:</b> ${line.argument || line.thesis || REGEN_FALLBACK_TEXT}</p>`);
  if (line.norms) paras.push(`<p><b>Нормативное обоснование:</b> ${line.norms}</p>`);
  const practice = state.card.practice;
  if (practice && practice.length) {
    paras.push(`<p><b>Практика:</b> ${practice.slice(0, 2).map(p => `${p.num} (${p.court}) — ${p.result.toLowerCase()}`).join('; ')}.</p>`);
  }
  if (state.card.circumstances && state.card.circumstances.length) {
    paras.push(`<p><b>Обстоятельства:</b> ${state.card.circumstances.join('; ')}.</p>`);
  }
  return paras.join('');
}

/** Описание приговора первой инстанции (для кассации — плюс апелляционное определение). */
function composeVerdictText() {
  const c = state.card;
  const v = c.verdict || {};
  const mark = t => `<span class="ph-mark">${t}</span>`;
  const client = c.client || mark('указать ФИО осуждённого');
  const parts = [
    `Приговором ${v.courtName || mark('указать суд')} от ${v.date || mark('указать дату')} ` +
    `${client}${v.born ? ', ' + v.born + ',' : ''} признан виновным в совершении преступления, ` +
    `предусмотренного ${v.qualification || mark('указать квалификацию')}, и ему назначено наказание ` +
    `в виде ${v.sentence || mark('указать наказание')}.`
  ];
  if (state.docType && state.docType.key === 'cassation') {
    parts.push(c.appellateRuling || mark('Опишите апелляционное определение'));
  }
  return parts.map(p => `<p>${p}</p>`).join('');
}

/**
 * Стандартный блок оснований для отмены/изменения приговора (апелляция):
 * требования к приговору + основания ст. 389.15 + позиция КС РФ и ст. 17, 14 УПК РФ.
 * Текст фиксированный (шаблон), нейросетью не перегенерируется.
 */
const APPEAL_GROUNDS_PARAS = [
  'В соответствии со ст.ст. 297, 302 УПК РФ приговор суда должен быть законным, обоснованным и справедливым, а обвинительный приговор постановляется лишь при условии, что в ходе судебного разбирательства виновность подсудимого в совершении преступления подтверждена совокупностью исследованных доказательств.',
  'В соответствии со статьёй 389.15 УПК РФ основанием отмены или изменения судебного решения в апелляционном порядке является несоответствие выводов суда, изложенных в приговоре, фактическим обстоятельствам уголовного дела, установленным судом первой инстанции.',
  'Приговор основан исключительно на доказательствах, полученных в ходе предварительного следствия, при этом доказательства, установленные в ходе судебного разбирательства, судом объективно не оценены, не учтены и обоснованно не опровергнуты, что указывает на обвинительный уклон суда при вынесении решения.',
  'Как указал Конституционный Суд Российской Федерации в Определении от 8 апреля 2010 года № 601-О-О, в основу обвинительного приговора могут быть положены лишь доказательства, не вызывающие сомнения в их достоверности и допустимости. Обвинение может быть признано обоснованным только при условии, что все противостоящие ему обстоятельства дела объективно исследованы и опровергнуты стороной обвинения (Постановление Конституционного Суда Российской Федерации от 29.06.2004 года № 13-П).',
  'В части первой статьи 17 УПК РФ в качестве принципа оценки доказательств закреплено адресованное судье требование не только исходить при такой оценке из своего внутреннего убеждения и совести, но и основываться на совокупности имеющихся в деле доказательств и руководствоваться законом. При этом правило о том, что никакие доказательства не имеют заранее установленной силы (часть вторая ст. 17 УПК РФ), раскрывая данный принцип, запрещает правоприменителю отдавать предпочтение тем или иным доказательствам на основании формальных критериев; неустранимые сомнения в виновности лица, возникающие при оценке доказательств, должны толковаться в пользу обвиняемого (часть 3 ст. 14 УПК РФ).'
];

function composeAppealGroundsText() {
  return APPEAL_GROUNDS_PARAS.map(p => `<p>${p}</p>`).join('');
}

/** Вставляет стандартный блок оснований сразу после описания приговора (только апелляция, единожды). */
function maybeInsertAppealGrounds(afterVerdictId) {
  if (!state.docType || state.docType.key !== 'appeal') return;
  if (state.blocks.some(b => b.kind === 'grounds')) return;
  insertBlock(composeAppealGroundsText(), { afterId: afterVerdictId, section: 'verdict', kind: 'grounds' });
}

/** Спец-идентификатор шапки документа в контексте чата. */
const HEADER_ID = '__header__';

function setActiveBlock(id) {
  if (state.activeBlockId === id) return;
  state.activeBlockId = id;
  state.activeSubpart = null;
  document.querySelectorAll('.doc-block').forEach(el =>
    el.classList.toggle('is-active', el.dataset.blockId === id));
  // шапка документа тоже может быть активным контекстом (пилз «Шапка»)
  document.querySelector('.doc-header')?.classList.toggle('is-active', id === HEADER_ID);
  renderContextChip();
}

function setActiveSubpart(sp) {
  state.activeSubpart = sp;
  renderContextChip();
}

function getBlock(id) {
  return state.blocks.find(b => b.id === id);
}

/** Заменяет текст блока, ставит ✓ и подсвечивает. */
function regenerateBlock(id, newText) {
  const block = getBlock(id);
  if (!block) return;
  block.html = newText;
  block.status = 'done';
  renderBlocks();
  flashBlock(id);
}

/** Вставляет новый блок (в начало, после activeBlock или в конец), возвращает его id. */
function insertBlock(text, { afterId, lineId, atStart, kind, section, parts, generated } = {}) {
  const n = state.blocks.length + 1;
  const block = {
    id: `block-new-${n}`,
    label: `Блок ${n}`,
    status: 'done',
    lineId: lineId || null,
    kind: kind || null,
    section: section || 'defense',
    parts: parts || null,        // подблоки конструктора [{key, title, html}]
    generated: generated || '',  // сгенерированный текст под конструктором
    constructorDone: !!(parts && parts.length), // блоки свёрнуты по умолчанию
    dirty: false,
    html: text
  };
  if (atStart) {
    state.blocks.unshift(block);
  } else {
    const idx = afterId ? state.blocks.findIndex(b => b.id === afterId) : -1;
    if (idx >= 0) state.blocks.splice(idx + 1, 0, block);
    else state.blocks.push(block);
  }
  renderBlocks(); // нумерация «Блок N» проставляется при рендере по порядку секций
  flashBlock(block.id);
  return block.id;
}

function flashBlock(id) {
  const el = document.querySelector(`.doc-block[data-block-id="${id}"]`);
  if (!el) return;
  el.classList.add('flash');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/* ================= Шапка и заголовок документа ================= */

function applyDocTitle(title) {
  topbarTitleEl.textContent = title;
  docTitleEl.textContent = title;
}

/** Генерация шапки по типу документа и данным карточки (плейсхолдеры, где данных нет). */
function generateHeaderLines(type) {
  const c = state.card;
  const advName = c.advocateGen || c.advocate;
  const cliName = c.clientGen || c.client;
  const ph = t => `<span class="ph-mark">&lt;${t}&gt;</span>`;
  const advLine = advName ? `от адвоката ${advName}` : `от адвоката ${ph('вставить ФИО адвоката')}`;
  const cliLine = cliName
    ? `в интересах ${c.clientStatus ? c.clientStatus + ' ' : ''}${cliName}`
    : `в интересах ${ph('вставить ФИО доверителя')}`;

  if (type.court) {
    const court = c.court ? (type.key === 'appeal' ? c.court.appeal : c.court.cassation) : null;
    if (court) {
      // полные данные для шапки есть в карточке дела
      const lines = [`В ${court.name}`, court.address];
      // жалоба подаётся через суд первой инстанции (ст. 389.3, 401.3 УПК РФ)
      if (c.court.firstInstance) lines.push(`через ${c.court.firstInstance}`);
      lines.push('');
      lines.push(advLine);
      if (c.advocateDetails) lines.push(c.advocateDetails);
      lines.push('');
      lines.push(cliLine);
      if (c.court.caseNum) lines.push(`по уголовному делу № ${c.court.caseNum}`);
      if (c.court.firstInstanceRef) lines.push(`(${c.court.firstInstanceRef})`);
      return lines;
    }
    return [`В суд ${type.court}`, `через ${ph('вставить суд первой инстанции')}`, '', advLine, cliLine];
  }
  return [advLine, cliLine];
}

function renderDocHeader(lines) {
  docHeaderBodyEl.innerHTML = lines.map(l => `<p>${l}</p>`).join('');
  const wrap = docHeaderBodyEl.closest('.doc-header');
  wrap.classList.add('flash');
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => wrap.classList.remove('flash'), 1600);
  updateChecklist();
}

// правка шапки руками тоже обновляет чеклист (убрал <вставить...> — шапка готова)
docHeaderBodyEl.addEventListener('input', () => updateChecklist());

// клик/фокус в шапке кладёт её в контекст чата пилзом «Шапка»
['click', 'focusin'].forEach(ev => docHeaderBodyEl.addEventListener(ev, () => {
  setActiveBlock(HEADER_ID);
}));

/** Правка шапки по команде из чата (через нейронку; без неё — подсказка). */
async function editHeaderWithAI(text) {
  if (typeof LLM === 'undefined' || !LLM.enabled()) {
    addMessage('assistant', '(Демо) Правка шапки по команде доступна с подключённой нейронкой (кнопка «ИИ» вверху) — либо отредактируйте шапку прямо в документе.');
    return;
  }
  try {
    const out = await thinkWhile('Анализирую запрос и переписываю шапку документа нейросетью', () =>
      LLM.complete(fillPrompt(PROMPTS.editTarget, {
        docType: state.docType ? state.docType.label : 'документ',
        targetName: 'Шапка документа',
        userCommand: text,
        caseSummary: caseSummaryForPrompt(),
        blockText: '—',
        currentText: docHeaderBodyEl.innerText.replace(/\s+/g, ' ').trim()
      })));
    docHeaderBodyEl.innerHTML = out.split(/\n+/).map(l => `<p>${l.trim()}</p>`).join('');
    const wrap = docHeaderBodyEl.closest('.doc-header');
    wrap.classList.add('flash');
    setTimeout(() => wrap.classList.remove('flash'), 1600);
    updateChecklist();
    addMessage('assistant', 'Шапка документа обновлена согласно вашему запросу.');
  } catch (err) {
    addMessage('assistant', `(ИИ недоступен: ${err.message} — шапка не изменена.)`);
  }
}

/* ================= Чип контекста во вводе ================= */

function renderContextChip() {
  updateScenarioBanner();
  contextEl.innerHTML = '';
  if (!state.activeBlockId) return;
  const isHeader = state.activeBlockId === HEADER_ID;
  const block = isHeader ? { label: 'Шапка' } : getBlock(state.activeBlockId);
  if (!block) return;

  const chip = document.createElement('span');
  chip.className = 'context-chip';
  const sp = state.activeSubpart;
  const chipLabel = block.label + (sp && sp.blockId === block.id ? ' · ' + sp.title : '');
  // пока идёт сценарий — пилз блока без крестика
  chip.innerHTML = state.scenario ? chipLabel : `${chipLabel}
    <button title="Отвязать блок">
      <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  const closeBtn = chip.querySelector('button');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    state.activeBlockId = null;
    state.activeSubpart = null;
    document.querySelectorAll('.doc-block').forEach(el => el.classList.remove('is-active'));
    document.querySelector('.doc-header')?.classList.remove('is-active');
    renderContextChip();
  });
  contextEl.appendChild(chip);
}

/* ================= Баннер «Выполняется сценарий» ================= */

function updateScenarioBanner() {
  const sc = state.scenario;
  assistantInputEl.classList.toggle('has-scenario', !!sc);
  scenarioBannerTitleEl.textContent = sc ? sc.title : '';
  scenarioBannerStepEl.hidden = !(sc && sc.step);
  scenarioBannerStepEl.textContent = sc && sc.step ? 'шаг ' + sc.step : '';
  scenarioBannerDropdown.classList.remove('is-open');
}

/** Текущий шаг сценария по нумерации из дока «Ревизия сценариев». */
function setStep(step) {
  if (!state.scenario) return;
  state.scenario.step = step;
  updateScenarioBanner();
}

scenarioBannerMenuBtn.addEventListener('click', e => {
  e.stopPropagation();
  scenarioBannerDropdown.classList.toggle('is-open');
});
document.addEventListener('click', e => {
  if (!scenarioBannerDropdown.contains(e.target)) scenarioBannerDropdown.classList.remove('is-open');
});
scenarioAbortBtn.addEventListener('click', () => {
  const sc = state.scenario;
  if (!sc) return;
  if (sc.chipsEl) sc.chipsEl.classList.add('is-answered');
  state.scenario = null;
  renderContextChip();
  addMessage('assistant', `Сценарий «${sc.title}» прерван. Уже выполненные действия не откатываются.`);
});

/* ================= Лента ассистента ================= */

function scrollFeed() {
  assistantScrollEl.scrollTop = assistantScrollEl.scrollHeight;
  // и ещё раз после отрисовки — на случай, если контент дорастёт после layout
  requestAnimationFrame(() => {
    assistantScrollEl.scrollTop = assistantScrollEl.scrollHeight;
  });
}

// любое изменение ленты (сообщение, чипы, «думает», правка текста) прокручивает чат к низу
new MutationObserver(scrollFeed).observe(feedEl, { childList: true, subtree: true, characterData: true });

function addMessage(kind, text) {
  const el = document.createElement('div');
  el.className = `msg msg--${kind}`;
  el.textContent = text;
  feedEl.appendChild(el);
  scrollFeed();
  return el;
}

/** Сообщение-файл от пользователя. */
function addFileMessage(fileName) {
  const el = document.createElement('div');
  el.className = 'msg msg--user msg--file';
  el.innerHTML = `<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>${fileName}`;
  feedEl.appendChild(el);
  scrollFeed();
}

/** «Думает», пока выполняется реальная асинхронная работа (LLM-вызов). */
async function thinkWhile(text, fn) {
  setBusy(true);
  const el = document.createElement('div');
  el.className = 'msg msg--thinking';
  el.innerHTML = `${text}<span class="dots"></span>`;
  feedEl.appendChild(el);
  scrollFeed();
  try {
    return await fn();
  } finally {
    el.remove();
    setBusy(false);
  }
}

/** «Генерация» (состояние D): блокирует ввод и чипы. */
async function think(text, ms = 1400) {
  setBusy(true);
  const el = document.createElement('div');
  el.className = 'msg msg--thinking';
  el.innerHTML = `${text}<span class="dots"></span>`;
  feedEl.appendChild(el);
  scrollFeed();
  await sleep(ms);
  el.remove();
  setBusy(false);
}

function setBusy(busy) {
  state.busy = busy;
  promptEl.disabled = busy;
  sendBtn.disabled = busy;
  const star = document.querySelector('#btn-star');
  if (star) star.disabled = busy;
  feedEl.classList.toggle('is-busy', busy);
}

/* ================= Движок сценариев ================= */

function startScenario(id, title, { uninterruptible } = {}) {
  state.scenario = {
    id, title,
    stage: null, step: null, chipsSpec: null, chipsEl: null,
    onText: null, reaskText: null,
    uninterruptible: !!uninterruptible
  };
  renderContextChip();
}

function endScenario(finalText) {
  if (finalText) addMessage('assistant', finalText);
  state.scenario = null;
  renderContextChip();
}

/**
 * Группа чипов. options: [{label, sub, wide, ghost, episode, onPick}]
 * После выбора группа замораживается, выбранный чип подсвечивается.
 */
function addChips(options) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';

  options.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'chip'
      + (opt.wide ? ' chip--wide' : '')
      + (opt.ghost ? ' chip--ghost' : '')
      + (opt.episode ? ' chip--episode' : '');
    btn.innerHTML = `<span>${opt.label}${opt.sub ? `<small class="chip__sub">${opt.sub}</small>` : ''}</span>`;
    btn.addEventListener('click', () => {
      if (state.busy || wrap.classList.contains('is-answered')) return;
      wrap.classList.add('is-answered');
      btn.classList.add('is-chosen');
      opt.onPick();
    });
    wrap.appendChild(btn);
  });

  feedEl.appendChild(wrap);
  scrollFeed();
  return wrap;
}

/** Чоисы в рамках сценария (B.1): запоминаем для перебивки и повторного показа. */
function offerChoices(options, intro) {
  if (intro) addMessage('assistant', intro);
  if (state.scenario) {
    state.scenario.stage = 'choices';
    state.scenario.chipsSpec = options;
    state.scenario.onText = null;
    state.scenario.chipsEl = addChips(options);
    return state.scenario.chipsEl;
  }
  return addChips(options);
}

/** Ожидание текстового ввода в рамках сценария (B.2). */
function awaitText(promptText, handler) {
  if (promptText) addMessage('assistant', promptText);
  state.scenario.stage = 'text';
  state.scenario.chipsSpec = null;
  state.scenario.chipsEl = null;
  state.scenario.onText = handler;
  state.scenario.reaskText = promptText;
}

/* ---------- Роутинг свободного ввода ---------- */

const normalize = s => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

function matchTrigger(text) {
  return SCENARIO_TRIGGERS.find(t => t.re.test(text)) || null;
}

/** «Если есть пилз с таким текстом — выбираем пилз». */
function matchChipButton(text) {
  const sc = state.scenario;
  if (!sc || !sc.chipsEl || sc.chipsEl.classList.contains('is-answered')) return null;
  const q = normalize(text);
  if (q.length < 3) return null;
  return [...sc.chipsEl.querySelectorAll('.chip')].find(btn => {
    const label = normalize(btn.textContent);
    return label.includes(q) || q.includes(label);
  }) || null;
}

function launchScenario(trigger) {
  switch (trigger.id) {
    case 'bind-line': startBindLine(); break;
    case 'create-line': startCreateLine(); break;
    case 'check-doc': startCheckDoc(); break;
    case 'gen-by-lines': startGenByLines(); break;
    case 'help': startHelp(); break;
  }
}

/** Вопрос «прервать сценарий?» (правила B.1.1 / B.1.4 каркаса). */
function askInterrupt(actionTitle, onConfirm) {
  const sc = state.scenario;
  const savedSpec = sc.chipsSpec;
  const savedEl = sc.chipsEl;
  const savedStage = sc.stage;
  const savedOnText = sc.onText;
  const savedReask = sc.reaskText;

  const resume = () => {
    if (savedStage === 'choices' && savedSpec) {
      offerChoices(savedSpec, 'Продолжаем. Выберите один из вариантов:');
    } else if (savedStage === 'text') {
      sc.stage = 'text';
      sc.onText = savedOnText;
      if (savedReask) addMessage('assistant', savedReask);
    }
  };

  offerChoices([
    {
      label: 'Прервать сценарий',
      onPick: () => {
        addMessage('user', 'Прервать сценарий');
        if (savedEl) savedEl.classList.add('is-answered');
        const old = state.scenario;
        state.scenario = null;
        renderContextChip();
        addMessage('assistant', `Сценарий «${old.title}» прерван. Уже выполненные действия не откатываются.`);
        onConfirm();
      }
    },
    {
      label: 'Продолжить текущий',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Продолжить текущий');
        resume();
      }
    }
  ], `Сейчас идёт сценарий «${sc.title}». Прервать его и выполнить «${actionTitle}»?`);
}

/** Текст не подходит под контекст ожидания (B.2.3.2): ответ / переформулировать / новый вопрос. */
function askTextMismatch(text, trigger) {
  const sc = state.scenario;
  const savedOnText = sc.onText;
  const savedReask = sc.reaskText;

  offerChoices([
    {
      label: 'Это был ответ',
      onPick: () => {
        addMessage('user', 'Это был ответ');
        sc.stage = 'text';
        savedOnText(text);
      }
    },
    {
      label: 'Переформулирую',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Переформулирую');
        awaitText(savedReask || 'Слушаю.', savedOnText);
      }
    },
    {
      label: 'Это новый вопрос',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Это новый вопрос');
        const old = state.scenario;
        state.scenario = null;
        renderContextChip();
        addMessage('assistant', `Сценарий «${old.title}» завершён.`);
        launchScenario(trigger);
      }
    }
  ], 'Похоже, это не ответ на мой вопрос. Это был ответ, переформулируете или это новый вопрос?');
}

/** Текст похож на название типа документа (определитель A.1.3.2). */
const DOC_TYPE_NAME_RE = /жалоб|ходатайств|заявлен|позици|возражен|апелляц|кассац|отзыв|обращени|документ/i;

async function routeText(text) {
  const trigger = matchTrigger(text);
  const sc = state.scenario;

  // Сценарий не запущен (состояние C): свободный ввод правит выбранную зону
  if (!sc) {
    if (trigger) return launchScenario(trigger);
    if (state.activeSubpart) return editSubpartWithAI(text);
    if (state.activeBlockId === HEADER_ID) return editHeaderWithAI(text);
    // выбран блок целиком — свободный ввод редактирует его текст
    if (state.activeBlockId) {
      const block = getBlock(state.activeBlockId);
      if (block) return onRewriteBlock(block, text);
    }
    return onFreeInput(text);
  }

  // Состояние A: стартовый сценарий — команды его не прерывают
  if (sc.id === 'start-doc' && sc.stage === 'choices') {
    const chipBtn = matchChipButton(text);
    if (chipBtn) return chipBtn.click();
    if (text.length <= 60 && DOC_TYPE_NAME_RE.test(text)) {
      const label = text.charAt(0).toUpperCase() + text.slice(1);
      return finalizeDocType({ key: 'other' }, label);
    }
    addMessage('assistant', 'Сначала выберем тип документа. Выберите вариант ниже или напишите название документа своими словами.');
    return offerChoices(sc.chipsSpec);
  }

  // B.1: предложены чоисы
  if (sc.stage === 'choices') {
    const chipBtn = matchChipButton(text);
    if (chipBtn) return chipBtn.click();
    if (trigger) return askInterrupt(trigger.title, () => launchScenario(trigger));
    addMessage('assistant', 'Выберите, пожалуйста, один из предложенных вариантов. Если хотите другое действие — введите команду, и я предложу прервать сценарий.');
    if (sc.chipsSpec) offerChoices(sc.chipsSpec);
    return;
  }

  // B.2: ждём текстовый ввод
  if (sc.stage === 'text') {
    if (trigger) return askTextMismatch(text, trigger);
    const handler = sc.onText;
    sc.onText = null;
    return handler(text);
  }
}

/** Редактирование активного подблока конструктора с ИИ по запросу из чата. */
async function editSubpartWithAI(text) {
  const sp = state.activeSubpart;
  const block = getBlock(sp.blockId);
  const part = block && block.parts ? block.parts.find(p => p.key === sp.key) : null;
  if (!block || !part) {
    setActiveSubpart(null);
    return onFreeInput(text);
  }

  await think(`Редактирую подблок «${part.title}» ${labelGen(block.label)}`, 1600);

  if (sp.key === 'arguments') {
    // запрос из чата добавляет ручной аргумент
    block.argsList = block.argsList || [];
    block.argsList.push({ text: `${text.charAt(0).toUpperCase()}${text.slice(1).replace(/\.?$/, '.')}`, source: null, auto: false, poolIdx: null, grounds: [] });
    syncArgsPart(block);
  } else if (typeof LLM !== 'undefined' && LLM.enabled()) {
    // нейронка переписывает выбранный подблок согласно команде пользователя
    try {
      const out = await thinkWhile(`Анализирую запрос и переписываю подблок «${part.title}» нейросетью`, () =>
        LLM.complete(fillPrompt(PROMPTS.editTarget, {
          docType: state.docType ? state.docType.label : 'документ',
          targetName: `${block.label} · ${part.title}`,
          userCommand: text,
          caseSummary: caseSummaryForPrompt(),
          blockText: stripTags(block.generated || '').replace(/\s+/g, ' ').trim() || '—',
          currentText: stripTags(part.html).replace(/\s+/g, ' ')
        })));
      part.html = out.replace(/\n{2,}/g, ' ').trim();
    } catch (err) {
      addMessage('assistant', `(ИИ недоступен: ${err.message} — применена шаблонная правка.)`);
      const base = stripTags(part.html).replace(/\s+/g, ' ').trim();
      part.html = `${base} Дополнительно учтено: ${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.?$/, '.')}`;
    }
    if (['norms', 'practice', 'circumstances', 'other'].includes(sp.key)) block.argsStale = true;
  } else {
    const base = stripTags(part.html).replace(/\s+/g, ' ').trim();
    const lead = base.split('. ').slice(0, 2).join('. ').replace(/\.?$/, '.');
    part.html = `${lead} Дополнительно учтено: ${text.charAt(0).toLowerCase()}${text.slice(1).replace(/\.?$/, '.')}`;
    if (['norms', 'practice', 'circumstances', 'other'].includes(sp.key)) block.argsStale = true;
  }
  block.dirty = true;
  block.dirtyNotified = true;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Подблок «${part.title}» ${labelGen(block.label)} отредактирован с учётом запроса. Кнопка «Перегенерировать» стала активна.`);
}

async function onFreeInput(text) {
  await think('Обрабатываю запрос', 1000);
  addMessage('assistant', 'Чтобы отредактировать текст свободным вводом, выберите зону — блок, подблок или шапку (кликните по ней в документе), затем опишите правку. Команды доступны всегда: наберите «справка».');
}

/* ================= Сценарий №1: стартовый (выбор типа документа) ================= */

function startDocTypeScenario() {
  startScenario('start-doc', 'Выбор типа документа', { uninterruptible: true });
  setStep('1.1');
  addMessage('assistant', WELCOME_TEXT).classList.add('msg--pre');
  offerDocTypeChoices();
}

function offerDocTypeChoices(intro) {
  offerChoices(DOC_TYPES.map(t => ({
    label: t.label,
    onPick: () => {
      addMessage('user', t.label);
      onDocTypePicked(t);
    }
  })), intro);
}

function onDocTypePicked(type) {
  // 1.1.1 Ходатайство: второй набор чойсов
  if (type.key === 'motion') {
    setStep('1.1.1');
    offerChoices(MOTION_TYPES.map(m => ({
      label: m,
      onPick: () => {
        addMessage('user', m);
        finalizeDocType(type, `Ходатайство ${m.charAt(0).toLowerCase()}${m.slice(1)}`);
      }
    })), 'Какое ходатайство готовим? Выберите тип или напишите свой:');
    return;
  }
  finalizeDocType(type, type.label);
}

/** Шаг 2 стартового: тип выбран — шапка и переход к следующему сценарию. */
async function finalizeDocType(type, title) {
  state.docType = { key: type.key, label: title };
  applyDocTitle(title);

  setStep(type.key === 'motion' ? '2.2' : type.key === 'other' ? '2.3' : '2.1.1');
  await think('Формирую шапку документа', 1600);
  renderDocHeader(generateHeaderLines(type));

  // короткое сообщение: тип + шапка + (для жалоб) следующий шаг
  // апелляция подаётся не только на приговор, но и на постановление или определение суда
  const uploadHint = type.key === 'appeal'
    ? ' Следующим шагом загрузите обжалуемый судебный акт первой инстанции — приговор, постановление или определение суда.'
    : type.key === 'cassation'
      ? ' Следующим шагом загрузите приговор первой инстанции и апелляционное определение.'
      : '';
  addMessage('assistant', `Тип документа выбран: «${title}». Шапка документа сформирована.${uploadHint}`);

  // 2.1.1.2 / 2.2 — плейсхолдеры структуры вставляются молча
  state.structure = DOC_STRUCTURE[type.key] || null;
  if (state.structure) {
    setStep(type.key === 'motion' ? '2.2' : '2.1.1.2');
    renderBlocks();
    renderPleas();
  }

  // 2.1 апелляция/кассация: следующим шагом предлагаем загрузить документы (или пропустить)
  if (type.key === 'appeal' || type.key === 'cassation') {
    const sc = state.scenario;
    sc.id = 'upload-docs';
    sc.title = type.key === 'appeal' ? 'Загрузка приговора' : 'Загрузка приговора и апелляционного определения';
    sc.uninterruptible = false;
    updateScenarioBanner();

    const goGen = () => {
      state.scenario = null;
      renderContextChip();
      startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
      runGenByLines();
    };

    offerChoices([
      {
        label: type.key === 'appeal' ? 'Загрузить судебный акт' : 'Загрузить документы',
        onPick: () => {
          addMessage('user', type.key === 'appeal' ? 'Загрузить судебный акт' : 'Загрузить документы');
          state.scenario = null;
          renderContextChip();
          runDocxScenario();
        }
      },
      {
        label: 'Пропустить',
        ghost: true,
        onPick: () => {
          addMessage('user', 'Пропустить');
          goGen();
        }
      }
    ]);
    return;
  }

  // позиция защиты → сразу сценарий 17
  if (type.key === 'position') {
    state.scenario = null;
    startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
    runGenByLines();
    return;
  }

  // 2.2 ходатайство → текстовый шаблон с плейсхолдерами + сценарий 18
  if (type.key === 'motion') {
    insertMotionTemplate();
    addMessage('assistant', 'В документ вставлен шаблон ходатайства — незаполненные места отмечены жёлтым.');
    const sc = state.scenario;
    sc.id = 'motion';
    sc.title = 'Подготовка ходатайства';
    sc.uninterruptible = false;
    setStep('18');
    awaitText('Уточните: какие обстоятельства обосновывают ходатайство и о чём просим суд?', onMotionDetails);
    return;
  }

  // 2.3 другой тип → сценарий 19 → справка (сценарий 14)
  endScenario('Документ создан. Дальше можно работать командами из чата.');
  startHelp();
}

/** Шаблон ходатайства: текст с плейсхолдерами по данным карточки (чего нет — жёлтым). */
function insertMotionTemplate() {
  const c = state.card;
  const mark = t => `<span class="ph-mark">${t}</span>`;
  const caseNum = c.court && c.court.caseNum ? `№ ${c.court.caseNum}` : mark('указать номер дела');
  const courtName = c.court && c.court.appeal ? 'Киевского районного суда г. Симферополя' : mark('указать суд или орган');
  const client = c.clientGen || mark('указать ФИО доверителя');
  const qual = c.episodes[0] && c.episodes[0].qualification ? c.episodes[0].qualification : mark('указать квалификацию');

  insertBlock(
    `<p>В производстве ${courtName} находится уголовное дело ${caseNum} в отношении ${client}, обвиняемого в совершении преступления, предусмотренного ${qual}.</p>` +
    `<p>${mark('Изложите обстоятельства, обосновывающие ходатайство')}</p>`,
    { section: 'facts', kind: 'motion-tpl' });

  insertBlock(MOTION_LAW_TEXT, { section: 'law', kind: 'law' });
}

/** Сценарий 18: детали от пользователя заполняют плейсхолдер обоснования в шаблоне. */
async function onMotionDetails(text) {
  await think('Генерирую текст ходатайства', 2000);
  const filled = `${text.charAt(0).toUpperCase()}${text.slice(1)}. Изложенные обстоятельства имеют существенное значение для дела и подтверждаются его материалами (статьи 119, 120 УПК РФ).`;

  const tpl = state.blocks.find(b => b.kind === 'motion-tpl');
  if (tpl) {
    tpl.html = tpl.html.replace(/<span class="ph-mark">Изложите обстоятельства[^<]*<\/span>/, filled);
    renderBlocks();
    flashBlock(tpl.id);
  } else {
    insertBlock(filled, { section: 'facts', kind: 'motion-facts' });
  }
  addPlea(PLEA_MOTION);
  endScenario('Обоснование ходатайства заполнено, просительная часть сформирована.');
  startHelp();
}

/* ================= Сценарий №2: привязка линии защиты к блоку ================= */

function startBindLine() {
  startScenario('bind-line', 'Привязка линии защиты к блоку');
  setStep('2.1');

  // 2.1 Блок известен?
  if (!state.activeBlockId) {
    endScenario('Блок не выбран. Кликните на нужный блок в документе и вызовите привязку линии ещё раз.');
    return;
  }

  // 2.2 Эпизоды
  if (!state.card.episodes.length) {
    setStep('2.2.1');
    awaitText(
      'Карточка дела не заполнена: эпизодов фабулы нет. Введите краткую фабулу своими словами прямо в чат либо приложите DOCX с приговором или постановлением о возбуждении дела (скрепка внизу).',
      onFabulaEntered
    );
    return;
  }

  if (state.card.episodes.length === 1) {
    onEpisodeChosen(state.card.episodes[0], { silent: true });
  } else {
    setStep('2.2.2');
    offerChoices(
      state.card.episodes.map(ep => ({
        label: ep.title,
        sub: ep.text,
        wide: true,
        episode: true,
        onPick: () => {
          addMessage('user', ep.title);
          onEpisodeChosen(ep);
        }
      })),
      'К какому эпизоду относится этот блок? Выберите эпизод.'
    );
  }
}

/** 2.2.1.1.1 — фабула введена текстом: распознаём и сохраняем эпизод. */
async function onFabulaEntered(text) {
  setStep('2.2.1.1');
  await think('Распознаю фабулу', 2000);

  const episode = {
    id: 'ep-user-1',
    title: 'Эпизод 1 — из введённой фабулы',
    text: text
  };
  state.card.episodes.push(episode);

  addMessage('assistant', 'Фабула распознана и сохранена в карточку дела.');
  onEpisodeChosen(episode, { silent: true });
}

/** 2.3 — эпизод известен, смотрим линии. */
function onEpisodeChosen(episode, { silent } = {}) {
  const lines = state.card.lines.filter(l => !l.episodeId || l.episodeId === episode.id);

  if (!lines.length) {
    setStep('2.3.2');
    addMessage('assistant',
      (silent ? `Эпизод определён: ${episode.title}. ` : '') +
      'Для данного эпизода ещё нет линий защиты. Создайте новую линию.');
    offerCreateLine(episode, { stepBase: '2.3.2' });
    return;
  }

  setStep('2.3.1');
  offerChoices([
    ...lines.map(line => ({
      label: line.title,
      wide: true,
      onPick: () => {
        addMessage('user', line.title);
        onLineChosen(line, episode);
      }
    })),
    { label: 'Создать новую линию', ghost: true, onPick: () => { addMessage('user', 'Создать новую линию'); offerCreateLine(episode, { skipIntro: true, stepBase: '2.3.1.2' }); } },
    { label: 'Оставить свободным', ghost: true, onPick: () => { addMessage('user', 'Оставить свободным'); endScenario('Блок оставлен свободным — вернуться к выбору линии можно в любой момент.'); } }
  ], 'Выберите линию защиты для этого блока, создайте новую или оставьте блок свободным.');
}

/** 2.3.х — способ создания линии. */
function offerCreateLine(episode, { skipIntro, stepBase = '2.3.2' } = {}) {
  setStep(stepBase);
  offerChoices([
    { label: 'Подобрать по практике', onPick: () => { addMessage('user', 'Подобрать по практике'); offerPracticeLines(episode, 0, `${stepBase}.1`); } },
    { label: 'Написать тезис своими словами', onPick: () => { addMessage('user', 'Своими словами'); askThesis(episode, `${stepBase}.2`); } }
  ], skipIntro ? null : 'Как создать линию защиты?');
}

/** Пилзы линий из практики с пагинацией «Показать еще». */
function offerPracticeLines(episode, offset, step) {
  if (step && offset === 0) setStep(step);
  const page = PRACTICE_LINES.slice(offset, offset + PRACTICE_PAGE_SIZE);
  const hasMore = offset + PRACTICE_PAGE_SIZE < PRACTICE_LINES.length;

  offerChoices([
    ...page.map(p => ({
      label: p.title,
      sub: `${p.cases} дел в практике`,
      wide: true,
      onPick: () => {
        addMessage('user', p.title);
        createLine(episode, p.title, null);
      }
    })),
    ...(hasMore ? [{ label: 'Показать еще', ghost: true, onPick: () => offerPracticeLines(episode, offset + PRACTICE_PAGE_SIZE, step) }] : [])
  ], offset === 0 ? 'Линии защиты с наиболее объёмной практикой:' : null);
}

/** Ждём тезис свободным вводом (B.2). */
function askThesis(episode, stepBase = '2.3.2.2') {
  setStep(`${stepBase}.1`);
  awaitText('Введите тезис защиты своими словами.', text => {
    setStep(`${stepBase}.2`);
    onThesisEntered(episode, text);
  });
}

/** «Нейронка» угадывает 3 линии по тезису. */
async function onThesisEntered(episode, thesis) {
  await think('Подбираю подходящие линии защиты', 1600);
  offerChoices([
    ...GUESSED_LINES.map(title => ({
      label: title,
      wide: true,
      onPick: () => {
        addMessage('user', title);
        createLine(episode, title, thesis);
      }
    })),
    {
      label: 'Не устроил ни один из вариантов',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не устроил ни один из вариантов');
        createLine(episode, null, thesis);
      }
    }
  ], 'Похоже на одну из этих линий — выберите подходящую:');
}

/** Создание линии + привязка. */
async function createLine(episode, title, thesis) {
  await think('Создаю линию защиты', 1500);

  const line = {
    id: `line-new-${state.card.lines.length + 1}`,
    episodeId: episode ? episode.id : null,
    title: title || 'Новая линия защиты (без названия)',
    thesis: thesis || 'Тезис сформирован автоматически по материалам практики.',
    argument: REGEN_FALLBACK_TEXT
  };
  state.card.lines.push(line);
  addMessage('assistant', `Линия защиты сохранена в карточку дела: «${line.title}».`);

  onLineChosen(line, episode, { created: true });
}

/** 2.4 — линия привязана, предлагаем перегенерацию блока. */
async function onLineChosen(line, episode, { created } = {}) {
  setStep('2.4');
  if (!created) await think('Привязываю линию к блоку', 1200);

  state.boundLines.add(line.id);
  const boundBlock = getBlock(state.activeBlockId);
  if (boundBlock) boundBlock.lineId = line.id;
  updateChecklist();
  const blockLabel = boundBlock?.label || 'блоку';

  offerChoices([
    {
      label: 'Перегенерировать блок',
      onPick: async () => {
        addMessage('user', 'Перегенерировать блок');
        await think('Генерирую новый текст блока', 2000);
        const target = getBlock(state.activeBlockId);
        if (target) applyLineToBlock(target, line, { silent: true });
        endScenario('Текст блока обновлён по конструктору линии, просительная часть пересобрана.');
      }
    },
    {
      label: 'Не перегенерировать',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не перегенерировать');
        endScenario('Готово: линия привязана к блоку. Текст блока оставлен без изменений.');
      }
    }
  ], `${created ? '' : 'Линия привязана к ' + blockLabel + ', эпизод — к линии. '}Перегенерировать текст блока с учётом привязанной информации?`);
}

/* ================= Сценарий №6: создание линии защиты ================= */

function startCreateLine() {
  startScenario('create-line', 'Создание линии защиты');
  setStep('6');
  const episode = state.card.episodes[0] || null;

  offerChoices([
    { label: 'Подобрать по практике', onPick: () => { addMessage('user', 'Подобрать по практике'); offerPracticeLines6(episode, 0); } },
    { label: 'Написать тезис своими словами', onPick: () => { addMessage('user', 'Своими словами'); setStep('6.2.1'); awaitText('Введите тезис защиты своими словами.', text => { setStep('6.2.2'); onThesis6(episode, text); }); } }
  ], 'Как создать линию защиты?');
}

function offerPracticeLines6(episode, offset) {
  if (offset === 0) setStep('6.1');
  const page = PRACTICE_LINES.slice(offset, offset + PRACTICE_PAGE_SIZE);
  const hasMore = offset + PRACTICE_PAGE_SIZE < PRACTICE_LINES.length;

  offerChoices([
    ...page.map(p => ({
      label: p.title,
      sub: `${p.cases} дел в практике`,
      wide: true,
      onPick: () => {
        addMessage('user', p.title);
        createLine6(episode, p.title, null);
      }
    })),
    ...(hasMore ? [{ label: 'Показать еще', ghost: true, onPick: () => offerPracticeLines6(episode, offset + PRACTICE_PAGE_SIZE) }] : [])
  ], offset === 0 ? 'Линии защиты с наиболее объёмной практикой:' : null);
}

async function onThesis6(episode, thesis) {
  await think('Подбираю подходящие линии защиты', 1600);
  offerChoices([
    ...GUESSED_LINES.map(title => ({
      label: title,
      wide: true,
      onPick: () => {
        addMessage('user', title);
        createLine6(episode, title, thesis);
      }
    })),
    { label: 'Не устроил ни один из вариантов', ghost: true, onPick: () => { addMessage('user', 'Не устроил ни один из вариантов'); createLine6(episode, null, thesis); } }
  ], 'Похоже на одну из этих линий — выберите подходящую:');
}

/** 6.3 — куда добавить текст по созданной линии. */
async function createLine6(episode, title, thesis) {
  setStep('6.3');
  await think('Создаю линию защиты', 1500);

  const line = {
    id: `line-new-${state.card.lines.length + 1}`,
    episodeId: episode ? episode.id : null,
    title: title || 'Новая линия защиты (без названия)',
    thesis: thesis || 'Тезис сформирован автоматически по материалам практики.',
    argument: REGEN_FALLBACK_TEXT
  };
  state.card.lines.push(line);

  const options = [];
  if (state.activeBlockId) {
    options.push({
      label: 'Добавить после активного блока',
      onPick: async () => {
        addMessage('user', 'Добавить после активного блока');
        await think('Генерирую текст по линии защиты', 1800);
        const afterActiveId = insertLineBlock(line, { afterId: state.activeBlockId });
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        await llmGenerateBlock(afterActiveId);
        endScenario('Текст по линии добавлен после активного блока, просительная часть обновлена.');
        maybeExplainWarnings();
      }
    });
  }
  options.push(
    {
      label: 'Добавить в конец документа',
      onPick: async () => {
        addMessage('user', 'Добавить в конец документа');
        await think('Генерирую текст по линии защиты', 1800);
        const atEndId = insertLineBlock(line);
        state.boundLines.add(line.id);
        addPlea(line.plea || PLEA_FALLBACK);
        await llmGenerateBlock(atEndId);
        endScenario('Текст по линии добавлен в конец документа, просительная часть обновлена.');
        maybeExplainWarnings();
      }
    },
    {
      label: 'Не добавлять',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Не добавлять');
        endScenario('Линия создана и сохранена в карточку дела. Текст в документ не добавлялся.');
      }
    }
  );

  offerChoices(options, `Линия создана: «${line.title}». Добавить текст по ней в документ?`);
}

/* ================= Сценарий №15: проверка документа ================= */

function unboundLines() {
  return state.card.lines.filter(l => !state.boundLines.has(l.id));
}

function startCheckDoc() {
  startScenario('check-doc', 'Проверка документа');
  step15_1();
}

async function step15_1() {
  setStep('15.1');
  await think('Проверяю линии защиты, не добавленные в документ', 1300);
  const unbound = unboundLines();

  if (!unbound.length) {
    addMessage('assistant', state.card.lines.length
      ? 'Все линии защиты добавлены в документ.'
      : 'В карточке дела пока нет линий защиты.');
    return step15_rest();
  }

  offerChoices([
    {
      label: 'Добавить все линии',
      onPick: async () => {
        addMessage('user', 'Добавить все линии');
        setStep('15.1.2');
        await think('Генерирую текст документа по выбранным линиям защиты', 2200);
        const addedIds = [];
        unbound.forEach(line => {
          addedIds.push(insertLineBlock(line));
          state.boundLines.add(line.id);
          addPlea(line.plea || PLEA_FALLBACK);
        });
        for (const id of addedIds) await llmGenerateBlock(id);
        addMessage('assistant', `Текст по ${unbound.length} лини${unbound.length === 1 ? 'и' : 'ям'} добавлен в документ, просительная часть обновлена.`);
        maybeExplainWarnings();
        step15_rest();
      }
    },
    {
      label: 'Пропустить',
      ghost: true,
      onPick: () => {
        addMessage('user', 'Пропустить');
        step15_rest();
      }
    }
  ], `Обнаружены линии защиты, не добавленные в текст документа: ${unbound.length}. Добавить?`);
}

/** Шаги 15.2–15.7 — последовательный чек-лист. */
async function step15_rest() {
  setStep('15.2');
  await think('Проверяю привязку блоков к линиям защиты', 1100);
  const warnBlocks = state.blocks.filter(b => blockIssues(b).length).length;
  addMessage('assistant', !state.blocks.length
    ? 'В документе пока нет блоков.'
    : warnBlocks
      ? `Есть блоки без привязанной линии защиты: ${warnBlocks} (отмечены «!»). Привязать линию можно командой «привяжи линию» по активному блоку.`
      : 'Все блоки привязаны к линиям защиты.');

  setStep('15.3');
  await think('Проверяю доказательства по линиям защиты', 1100);
  addMessage('assistant', state.card.evidence.length
    ? 'У всех линий защиты есть доказательства.'
    : 'В карточке дела нет доказательств — привязка доказательств к линиям будет доступна из меню ии-звёздочки.');

  setStep('15.5');
  await think('Проверяю просительную часть', 1100);
  if (state.pleas.length) {
    addMessage('assistant', 'Просительная часть заполнена и покрывает текущий состав блоков.');
  } else if (state.blocks.length) {
    await think('Собираю просительную часть', 1200);
    state.card.lines.filter(l => state.boundLines.has(l.id)).forEach(l => addPlea(l.plea || PLEA_FALLBACK));
    addMessage('assistant', state.pleas.length
      ? 'Просительная часть собрана.'
      : 'Просительная часть будет собрана после привязки линий защиты к блокам.');
  } else {
    addMessage('assistant', 'Документ пуст — просительная часть будет собрана после добавления блоков.');
  }

  setStep('15.6');
  await think('Проверяю полноту документа', 1300);
  addMessage('assistant', 'Документ можно дополнить: указание на смягчающие обстоятельства (ст. 61 УК РФ) и ходатайство об исследовании видеозаписи в судебном заседании.');

  setStep('15.7');
  await think('Проверяю противоречия между блоками', 1300);
  endScenario('Противоречий между блоками не найдено. Проверка документа завершена.');
}

/* ================= Сценарий №17: генерация текста по линиям ================= */

function startGenByLines() {
  startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
  runGenByLines();
}

async function runGenByLines() {
  setStep('17.1');
  const unbound = unboundLines();
  if (!unbound.length) {
    // 17.1.2 — линий нет: отбивка и справка (сценарий 14)
    if (!state.card.lines.length) {
      endScenario('В карточке дела нет линий защиты — блоки по линиям сгенерировать пока нечем.');
      startHelp();
    } else {
      endScenario('Все линии защиты уже привязаны к блокам документа.');
    }
    return;
  }

  setStep('17.2');
  await think('Генерирую текст по непривязанным линиям защиты', 2200);
  const insertedIds = [];
  unbound.forEach(line => {
    insertedIds.push(insertLineBlock(line));
    state.boundLines.add(line.id);
    addPlea(line.plea || PLEA_FALLBACK);
  });

  // 17.3 Сутевая часть дела (фабула) — первым блоком после заголовка
  let factsAdded = false;
  if (state.card.episodes.length && !factsFilled()) {
    setStep('17.3');
    await think('Генерирую сутевую часть дела по фабуле', 1800);
    await insertSectionBlock('facts', composeFactsText(), { atStart: true, section: 'facts', kind: 'facts', deferred: true });
    if (!state.factsSource) state.factsSource = 'card';
    factsAdded = true;
  }

  // описание приговора (апелляция/кассация) — самой первой секцией
  if (state.structure && state.structure.some(p => p.kind === 'verdict') && state.card.verdict
      && !state.blocks.some(b => (b.section || 'defense') === 'verdict')) {
    await think('Формирую описание приговора', 1400);
    const vId = await insertSectionBlock('verdict', composeVerdictText(), { atStart: true, section: 'verdict', kind: 'verdict', deferred: true });
    // стандартный блок оснований для отмены/изменения приговора (апелляция) — сразу после описания
    maybeInsertAppealGrounds(vId);
  }

  // признание известно по карточке — заполняем автоматически (без отдельной отбивки)
  await maybeAutoAdmission({ silent: true, deferred: true });

  // нейронка заполняет тексты по порядку следования блоков в документе (сверху вниз)
  await generateInDocOrder(insertedIds);

  setStep('17.4');
  endScenario();

  // акцентное финальное сообщение: переводим адвоката в документ слева
  const doneSections = [];
  if (state.blocks.some(b => (b.section || 'defense') === 'verdict')) doneSections.push('описание приговора');
  if (factsFilled()) doneSections.push('обстоятельства дела');
  if (state.blocks.some(b => (b.section || 'defense') === 'admission')) doneSections.push('признание');
  doneSections.push(`защитная часть (${unbound.length} блок${unbound.length === 1 ? '' : 'а'})`, 'просительная часть');

  const accent = addMessage('assistant', '');
  accent.classList.add('msg--accent');
  accent.innerHTML = `
    <div class="msg-accent__title">Черновик собран — продолжайте в документе слева</div>
    <ul>
      <li>Заполнено: ${doneSections.join(', ')}.</li>
      <li><span class="msg-warn-icon">Жёлтая</span> полоса у блока и чеклист сверху показывают, что требует завершения.</li>
      <li>Раскройте конструктор блока, чтобы уточнить аргументы, доказательства и практику.</li>
    </ul>`;
  scrollFeed();
  state.warnExplained = true;
}

/** 17.3 — сутевая часть: фабула всех эпизодов дела. */
function composeFactsText() {
  const c = state.card;
  const caseRef = c.court && c.court.caseNum ? ` № ${c.court.caseNum}` : '';
  const client = c.clientDat || c.client;
  const intro = `По уголовному делу${caseRef} моему доверителю${client ? ' ' + client : ''} вменяются следующие деяния.`;
  const episodes = c.episodes.map((ep, i) => {
    const text = stripTags(ep.text).replace(/\s+/g, ' ').trim();
    const sentences = text.split('. ');
    return `${cap(episodeFactRef(ep, i))}: ${sentences.slice(0, 2).join('. ')}${sentences.length > 1 ? '.' : ''}`;
  }).join(' ');
  return `${intro} ${episodes}`;
}

/* ================= Сценарий №14: справка ================= */

function startHelp() {
  const el = addMessage('assistant', '');
  el.classList.add('msg--help');
  el.innerHTML = HELP_HTML;
  scrollFeed();
}

/* ================= Сценарий №3: разбор DOCX (по скрепке) ================= */

function onAttachClick() {
  if (state.busy) return;

  const sc = state.scenario;

  // приложили файл во время стартового сценария: разбираем и возвращаемся к выбору типа
  if (sc && sc.id === 'start-doc') {
    runDocxDuringStart();
    return;
  }
  if (sc) {
    askInterrupt('Разбор файла', () => runDocxScenario());
    return;
  }
  runDocxScenario();
}

/** Общий пайплайн разбора приговора (шаги 3.1–3.4). Для кассации — плюс апелляционное определение. */
async function runDocxPipeline() {
  const isCassation = state.docType && state.docType.key === 'cassation';
  addFileMessage(DOCX_FILE_NAME);
  if (isCassation) addFileMessage(DOCX_FILE_NAME_APPEAL_RULING);

  setStep('3.1');
  await think(isCassation ? 'Проверяю приложенные документы' : 'Определяю тип судебного акта', 1500);
  addMessage('assistant', isCassation
    ? 'Это приговор первой инстанции и апелляционное определение — продолжаю разбор.'
    : 'Это приговор первой инстанции (поддерживаются также постановления и определения суда) — продолжаю разбор.');

  setStep('3.2');
  await think('Разбираю документ: доверитель, фабула, доказательства, стадии, участники, обстоятельства, линии защиты', 3000);

  setStep('3.3');
  state.card = clone(DOCX_PARSED_CARD);

  setStep('3.4');
  const c = state.card;
  const report = addMessage('assistant', '');
  report.classList.add('msg--card');
  report.innerHTML = `
    <div class="msg-card__title">Разбор завершён — карточка дела заполнена</div>
    <ul>
      <li>Доверитель: ${c.client}</li>
      <li>Эпизоды (${c.episodes.length}):<ul>${c.episodes.map(e =>
        `<li>${e.title}${e.admission ? ' — ' + e.admission : ''}</li>`).join('')}</ul></li>
      <li>Линии защиты (${c.lines.length}):<ul>${c.lines.map(l =>
        `<li>${shortLineTitle(l.title)}</li>`).join('')}</ul></li>
      <li>Доказательства: ${c.evidence.length} · Обстоятельства: ${c.circumstances.length}</li>
    </ul>`;
  scrollFeed();
}

/** Разбор из состояния C или после перебивки: далее сценарий 17. */
async function runDocxScenario() {
  startScenario('docx', 'Разбор документа');
  await runDocxPipeline();

  state.scenario = null;
  startScenario('gen-by-lines', 'Генерация текста по линиям защиты');
  runGenByLines();
}

/** Разбор во время стартового сценария: после отчёта возвращаемся к выбору типа. */
async function runDocxDuringStart() {
  const sc = state.scenario;
  const savedTitle = sc.title;
  sc.title = 'Разбор документа';
  updateScenarioBanner();

  await runDocxPipeline();

  sc.title = savedTitle;
  setStep('1.1');
  offerDocTypeChoices('Теперь выберите тип документа — данные из приговора будут использованы при подготовке:');
}

/* ================= Меню ии-звёздочки (сценарии 16.x) ================= */

const starBtn = $('#btn-star');
const starMenu = $('#star-menu');
const modalOverlay = $('#modal-overlay');
const modalEl = $('#modal');

function renderStarMenu() {
  starMenu.innerHTML = '';
  CHAT_STAR_ACTIONS.forEach(action => {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      starMenu.classList.remove('is-open');
      onStarAction(action);
    });
    starMenu.appendChild(btn);
  });
}

starBtn.addEventListener('click', e => {
  e.stopPropagation();
  if (state.busy) return;
  renderStarMenu();
  starMenu.classList.toggle('is-open');
});
document.addEventListener('click', e => {
  if (!starMenu.contains(e.target) && !starBtn.contains(e.target)) starMenu.classList.remove('is-open');
});

/** Вход 1 каркаса: пилз из выпадайки-звёздочки. */
function onStarAction(action) {
  if (state.busy) return;
  const sc = state.scenario;

  // Состояние A: стартовый сценарий — игнорируем, предлагаем чоисы снова
  if (sc && sc.id === 'start-doc') {
    addMessage('assistant', 'Сначала выберем тип документа — после этого действия из ИИ-меню станут доступны.');
    if (sc.chipsSpec) offerChoices(sc.chipsSpec);
    return;
  }
  // Состояние B: спросить, прервать ли сценарий
  if (sc) {
    askInterrupt(action.label, () => runStarAction(action));
    return;
  }
  // Состояние C: выполнить согласно id
  runStarAction(action);
}

function runStarAction(action) {
  const block = getBlock(state.activeBlockId);
  if (action.needsBlock && !block) {
    addMessage('assistant', 'Блок не выбран. Кликните на нужный блок в документе и вызовите действие из ИИ-меню ещё раз.');
    return;
  }

  switch (action.id) {
    case 'bind-line':
      addMessage('user', action.label);
      startBindLine();
      break;
    case 'bind-evidence':
      openEvidenceModal(block);
      break;
    case 'practice':
      openPracticeModal(block);
      break;
    case 'shorter':
      addMessage('user', `${block.label}: Перепеши короче`);
      rewriteBlockAuto(block, 'shorter');
      break;
    case 'longer':
      addMessage('user', `${block.label}: Перепеши подробнее`);
      rewriteBlockAuto(block, 'longer');
      break;
    case 'rewrite':
      startScenario('rewrite-block', 'Редактировать с ИИ');
      setStep('16.6');
      awaitText('Как хотите изменить текст блока?', text => onRewriteBlock(block, text));
      break;
    case 'help':
      addMessage('user', 'Показать справку');
      startHelp();
      break;
    case 'check-doc':
      addMessage('user', 'Проверить документ');
      startCheckDoc();
      break;
    case 'create-line':
      addMessage('user', 'Новая линия защиты');
      startCreateLine();
      break;
  }
}

/* ---------- Меню действий у блока (ховер-звёздочка) ---------- */

const blockMenuEl = $('#block-menu');

const BLOCK_ACTION_LABELS = {
  'bind-line': 'Привязать линию защиты',
  'practice': 'Практика по линии защиты',
  'bind-evidence': 'Привязать доказательство',
  'rewrite': 'Редактировать с ИИ',
  'longer': 'Сделать подробнее',
  'shorter': 'Сделать короче'
};

function openBlockMenu(block, anchorBtn) {
  closeBlockMenu();
  const line = state.card.lines.find(l => l.id === block.lineId) || null;
  const evCount = (block.evidence || []).length;

  blockMenuEl.innerHTML = `
    <div class="block-menu__summary">${line ? 'Линия защиты: ' + line.title : 'Линия защиты не привязана'}</div>
    ${line
      ? '<button data-action="practice">Практика по линии защиты</button>'
      : '<button data-action="bind-line">Привязать линию защиты</button>'}
    <div class="block-menu__divider"></div>
    <div class="block-menu__row"><span>Доказательства</span><span>${evCount}</span></div>
    <button data-action="bind-evidence">Привязать доказательство</button>
    <div class="block-menu__divider"></div>
    <button data-action="rewrite">Скорректировать блок</button>
    <button data-action="longer">Сделать подробнее</button>
    <button data-action="shorter">Сделать короче</button>
    <button data-action="ask-question">Задать вопрос по блоку</button>`;

  blockMenuEl.hidden = false;
  const r = anchorBtn.getBoundingClientRect();
  const w = 300;
  blockMenuEl.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
  blockMenuEl.style.top = Math.min(r.bottom + 6, window.innerHeight - blockMenuEl.offsetHeight - 8) + 'px';

  blockMenuEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const actionId = btn.dataset.action;
      closeBlockMenu();
      setActiveBlock(block.id);
      if (actionId === 'ask-question') {
        // 16.4: вопрос по блоку = активный блок + ввод вопроса в чат
        promptEl.focus();
        return;
      }
      onStarAction({ id: actionId, label: BLOCK_ACTION_LABELS[actionId], needsBlock: actionId !== 'practice' });
    });
  });
}

function closeBlockMenu() {
  blockMenuEl.hidden = true;
  blockMenuEl.innerHTML = '';
}

document.addEventListener('click', e => {
  if (!blockMenuEl.contains(e.target) && !e.target.closest('.doc-block__star')) closeBlockMenu();
});
$('#doc-scroll').addEventListener('scroll', closeBlockMenu);

const stripTags = html => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent.replace(/\s+/g, ' ').trim();
};

/** 16.5 / 16.7 — короче/подробнее без вопросов и подтверждений (учитывает абзацы-сущности). */
async function rewriteBlockAuto(block, mode) {
  await think(mode === 'shorter' ? 'Переписываю блок короче' : 'Переписываю блок подробнее', 1800);

  const d = document.createElement('div');
  d.innerHTML = block.html;
  const paras = [...d.querySelectorAll('p')];

  if (paras.length) {
    if (mode === 'shorter') {
      // каждый абзац-сущность сокращаем до первого предложения, сохраняя подпись
      paras.forEach(p => {
        const label = p.querySelector('b');
        const labelHtml = label ? label.outerHTML + ' ' : '';
        const text = p.textContent.replace(label ? label.textContent : '', '').replace(/\s+/g, ' ').trim();
        const first = text.split('. ')[0];
        p.innerHTML = labelHtml + first + (first.endsWith('.') ? '' : '.');
      });
    } else {
      const extra = document.createElement('p');
      extra.innerHTML = '<b>Дополнительно:</b> ' + DETAIL_SENTENCE.replace(/\s+/g, ' ').trim();
      d.appendChild(extra);
    }
    block.html = d.innerHTML;
  } else {
    const text = stripTags(block.html);
    if (mode === 'shorter') {
      const sentences = text.split('. ');
      block.html = sentences.slice(0, 2).join('. ') + (sentences.length > 2 ? '.' : '');
    } else {
      block.html = text + ' ' + DETAIL_SENTENCE.replace(/\s+/g, ' ').trim();
    }
  }
  block.htmlBase = null;
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', mode === 'shorter' ? 'Блок переписан короче.' : 'Блок переписан подробнее.');
}

/** Ручная правка без нейронки: сохраняем текст блока и дописываем учтённый запрос абзацем. */
function applyManualBlockEdit(block, request, isCtor) {
  const baseHtml = (isCtor ? (block.generated || '') : (block.html || '')).trim();
  const isPlaceholder = !baseHtml || /gen-pending|Введите текст блока|ph-mark/i.test(baseHtml);
  const req = request.replace(/\s+/g, ' ').trim();
  const html = isPlaceholder
    ? `<p>${cap(req).replace(/\.?$/, '.')}</p>`
    : `${baseHtml}<p>Дополнительно учтено: ${req.charAt(0).toLowerCase()}${req.slice(1).replace(/\.?$/, '.')}</p>`;
  if (isCtor) block.generated = html;
  else { block.html = html; block.htmlBase = null; }
}

/** 16.6 — редактирование блока с ИИ по свободному запросу (предыдущий текст — в контексте). */
async function onRewriteBlock(block, request) {
  const isCtor = !!(block.parts && block.parts.length);
  const currentText = stripTags(isCtor ? (block.generated || '') : (block.html || '')).replace(/\s+/g, ' ').trim();

  if (typeof LLM !== 'undefined' && LLM.enabled()) {
    try {
      const out = await thinkWhile(`Анализирую запрос и редактирую текст ${labelGen(block.label)} нейросетью`, () =>
        LLM.complete(fillPrompt(PROMPTS.editTarget, {
          docType: state.docType ? state.docType.label : 'документ',
          targetName: `${block.label} · текст блока`,
          userCommand: request,
          caseSummary: caseSummaryForPrompt(),
          blockText: '—',
          currentText: currentText || '—'
        }), { maxTokens: 8000 }));
      const html = out.split(/\n{2,}/).map(p => `<p>${p.trim()}</p>`).join('');
      if (isCtor) block.generated = html;
      else { block.html = html; block.htmlBase = null; }
    } catch (err) {
      addMessage('assistant', `(ИИ недоступен: ${err.message} — правка внесена без переформулирования.)`);
      applyManualBlockEdit(block, request, isCtor);
    }
  } else {
    await think('Вношу правку в текст блока', 1400);
    applyManualBlockEdit(block, request, isCtor);
  }

  renderBlocks();
  flashBlock(block.id);
  endScenario(`Текст ${labelGen(block.label)} отредактирован согласно вашему запросу.`);
}

/* ---------- Модалки ---------- */

function openModal({ title, bodyHtml, buttons, context }) {
  modalEl.innerHTML = `
    <div class="modal__title">${title}</div>
    ${context ? `<div class="modal__context">${context}</div>` : ''}
    <div class="modal__body">${bodyHtml}</div>
    <div class="modal__footer"></div>`;
  const footer = modalEl.querySelector('.modal__footer');
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'modal__btn' + (b.primary ? ' modal__btn--primary' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', () => b.onClick ? b.onClick() : closeModal());
    footer.appendChild(btn);
  });
  modalOverlay.hidden = false;
}

function closeModal() {
  modalOverlay.hidden = true;
  modalEl.innerHTML = '';
}

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

/** Контекст модалки: к какой линии/тезису относится выбираемая сущность. */
function blockModalContext(block) {
  const line = block ? state.card.lines.find(l => l.id === block.lineId) : null;
  if (!line) return null;
  return `Линия защиты: ${shortLineTitle(line.title)}${line.thesis ? ' · Тезис: ' + line.thesis.split('. ')[0] : ''}`;
}

/** Секция «Свободный ввод» в модалке: ввели текст — галочка и новая пустая строка. */
function freeInputSectionHtml() {
  return `
    <div class="args-group free-input">
      <div class="args-group__title">Свободный ввод</div>
      <label class="evidence-item free-row">
        <input type="checkbox" tabindex="-1">
        <span class="free-row__text" contenteditable="true" data-ph="Начните вводить…"></span>
      </label>
    </div>`;
}

function wireFreeInputs() {
  const wrap = modalEl.querySelector('.free-input');
  if (!wrap) return;
  const attach = row => {
    const span = row.querySelector('.free-row__text');
    span.addEventListener('input', () => {
      const filled = !!span.innerText.trim();
      row.querySelector('input').checked = filled;
      const rows = [...wrap.querySelectorAll('.free-row')];
      if (filled && rows[rows.length - 1] === row) {
        const next = row.cloneNode(true);
        next.querySelector('input').checked = false;
        next.querySelector('.free-row__text').innerHTML = '';
        wrap.appendChild(next);
        attach(next);
      }
    });
  };
  wrap.querySelectorAll('.free-row').forEach(attach);
}

function collectFreeInputs() {
  return [...modalEl.querySelectorAll('.free-row__text')]
    .map(s => s.innerText.trim()).filter(Boolean);
}

/** 16.1 — попап привязки доказательств к блоку. */
function openEvidenceModal(block) {
  const evidence = state.card.evidence;
  if (!evidence.length) {
    openModal({
      title: 'Привязать доказательства',
      bodyHtml: 'В карточке дела нет доказательств. Они появятся после разбора приговора (скрепка внизу чата).',
      buttons: [{ label: 'Закрыть' }]
    });
    return;
  }

  block.evidence = block.evidence || [];
  const items = evidence.map((ev, i) => `
    <label class="evidence-item">
      <input type="checkbox" data-idx="${i}" ${block.evidence.includes(i) ? 'checked' : ''}>
      <span>${ev}</span>
    </label>`).join('');

  openModal({
    title: `Привязать доказательства · ${block.label}`,
    context: blockModalContext(block),
    bodyHtml: items + freeInputSectionHtml(),
    buttons: [
      { label: 'Отмена' },
      { label: 'Привязать', primary: true, onClick: () => applyEvidence(block) }
    ]
  });
  wireFreeInputs();
}

async function applyEvidence(block) {
  const selected = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
  // свободный ввод: новые доказательства попадают в карточку дела и сразу выбраны
  collectFreeInputs().forEach(text => {
    state.card.evidence.push(text);
    selected.push(state.card.evidence.length - 1);
  });
  closeModal();

  const prev = block.evidence || [];
  const changed = selected.length !== prev.length || selected.some(i => !prev.includes(i));
  if (!changed) {
    addMessage('assistant', 'Состав доказательств не изменился — перегенерация не требуется.');
    return;
  }

  block.evidence = selected;
  const list = selected.map(i => state.card.evidence[i]);

  // конструкторный блок: обновляем подблок «Доказательства», текст перегенерируется кнопкой
  if (block.parts && block.parts.length) {
    const html = list.length ? list.join('; ') + '.' : '';
    const evPart = block.parts.find(p => p.key === 'evidence');
    if (evPart) {
      if (html) evPart.html = html;
      else block.parts.splice(block.parts.indexOf(evPart), 1);
    } else if (html) {
      block.parts.push({ key: 'evidence', title: 'Доказательства', html });
    }
    block.dirty = true;
    block.dirtyNotified = true;
    block.argsStale = true;
    renderBlocks();
    flashBlock(block.id);
    addMessage('assistant', `Доказательства добавлены в ${block.label}: ${list.length} шт. Данные аргументов обновились — нажмите «Обновить аргументы», затем «Перегенерировать».`);
    return;
  }

  addMessage('assistant', 'Провожу перегенерацию текста документа с учётом новых доказательств.');
  await think('Перегенерирую текст блока', 2000);

  if (!block.htmlBase) block.htmlBase = block.html;
  block.html = block.htmlBase + (list.length
    ? `<p><b>Доказательства:</b> ${list.join('; ')}.</p>`
    : '');
  renderBlocks();
  flashBlock(block.id);
  addMessage('assistant', `Текст ${block.label} перегенерирован.`);
}

/** Модалка выбора линии защиты для блока (чекбоксы, текущая отмечена). */
function openLineModal(block) {
  const lines = state.card.lines;
  if (!lines.length) {
    openModal({
      title: 'Линия защиты',
      bodyHtml: 'В карточке дела пока нет линий защиты. Создайте линию командой «создай линию» или через меню ✦ в чате.',
      buttons: [{ label: 'Закрыть' }]
    });
    return;
  }

  const items = lines.map(l => `
    <label class="evidence-item">
      <input type="checkbox" data-line-id="${l.id}" ${block.lineId === l.id ? 'checked' : ''}>
      <span><b>${shortLineTitle(l.title)}</b>${l.thesis ? `<br><small class="modal-sub">${l.thesis}</small>` : ''}</span>
    </label>`).join('');

  openModal({
    title: `Линия защиты · ${block.label}`,
    bodyHtml: items,
    buttons: [{ label: 'Закрыть' }]
  });

  modalEl.querySelectorAll('input[data-line-id]').forEach(cb => {
    cb.addEventListener('change', () => {
      const lineId = cb.dataset.lineId;
      if (!cb.checked && block.lineId === lineId) {
        // сняли галку с используемой линии
        confirmLineChange(block, null);
      } else if (cb.checked && lineId !== block.lineId) {
        const newLine = lines.find(l => l.id === lineId);
        if (block.lineId) confirmLineChange(block, newLine);
        else { closeModal(); applyLineToBlock(block, newLine); }
      }
    });
  });
}

/** Подтверждение смены/снятия линии: информация блока будет удалена. */
function confirmLineChange(block, newLine) {
  openModal({
    title: 'Смена линии защиты',
    bodyHtml: 'Уверены, что хотите поменять линию? При смене линии вся информация блока будет удалена.',
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Да, поменять',
        primary: true,
        onClick: () => {
          closeModal();
          const label = block.label;
          clearBlockInfo(block);
          if (newLine) applyLineToBlock(block, newLine);
          else addMessage('assistant', `Линия защиты отвязана от ${labelGen(label)}, информация блока удалена.`);
        }
      }
    ]
  });
}

/** Модалка аргументов: авто-предложения, сгруппированные по источникам. */
function openArgsModal(block) {
  const line = state.card.lines.find(l => l.id === block.lineId);
  if (!line) {
    openModal({ title: 'Доводы', bodyHtml: 'Сначала привяжите к блоку линию защиты.', buttons: [{ label: 'Закрыть' }] });
    return;
  }
  const pool = line.argumentsPool || [];
  const usedIdx = new Set((block.argsList || []).filter(a => a.auto && a.poolIdx !== null).map(a => a.poolIdx));

  const GROUPS = [['practice', 'Практика'], ['circumstances', 'Обстоятельства'], ['norms', 'Нормативная опора'], ['fact', 'Факты']];
  const groupsHtml = GROUPS.map(([src, title]) => {
    const items = pool.map((a, i) => ({ a, i })).filter(x => (x.a.source || 'fact') === src);
    if (!items.length) return '';
    return `
      <div class="args-group">
        <div class="args-group__title">${title}</div>
        ${items.map(({ a, i }) => `
          <label class="evidence-item">
            <input type="checkbox" data-idx="${i}" ${usedIdx.has(i) ? 'checked' : ''}>
            <span>${a.text}</span>
          </label>`).join('')}
      </div>`;
  }).join('');

  openModal({
    title: `Доводы · ${block.label}`,
    context: blockModalContext(block),
    bodyHtml: (groupsHtml || 'Для этой линии аргументы не подобраны.') + freeInputSectionHtml(),
    buttons: [
      { label: 'Отмена' },
      {
        label: 'Применить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
          const free = collectFreeInputs();
          closeModal();
          const manual = (block.argsList || []).filter(a => !a.auto);
          block.argsList = [
            ...sel.sort((x, y) => x - y).map(i => ({
              text: pool[i].text, source: pool[i].source, auto: true, poolIdx: i,
              grounds: (pool[i].grounds || []).map(g => ({ ...g }))
            })),
            ...manual,
            ...free.map(t => ({ text: t, source: null, auto: false, poolIdx: null, grounds: [] }))
          ];
          block.argsStale = false;
          syncArgsPart(block);
          block.dirty = true;
          block.dirtyNotified = true;
          renderBlocks();
          flashBlock(block.id);
          addMessage('assistant', `Состав аргументов ${labelGen(block.label)} обновлён: выбрано ${sel.length} из ${pool.length} предложенных${free.length ? ` + ${free.length} свободным вводом` : ''}. Кнопка «Перегенерировать» активна.`);
        }
      }
    ]
  });
  wireFreeInputs();
}

/** Карточка дела из практики в продуктовом стиле (как в попапе сайта). */
function practiceCaseHtml(c, i, { checked, disabled } = {}) {
  const row = (label, value) => `<div class="pcase__row"><span>${label}</span><b>${value}</b></div>`;
  return `
    <label class="pcase">
      <input type="checkbox" data-idx="${i}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <div class="pcase__body">
        <div class="pcase__title">${c.fullNum || c.num} <span class="pcase__ic">ⓘ</span></div>
        <div class="pcase__meta">
          <span class="pcase__pct">${c.percent || 90}%</span>
          <span class="pcase__qual">${c.qualification || ''}</span>
          <span class="pcase__inst">${c.instance || 'СУД ПЕРВОЙ ИНСТАНЦИИ'}</span>
        </div>
        <div class="pcase__rows">
          ${row('Статус признания', c.admission || '—')}
          ${row('Решение суда по преступлению', c.decision || c.result || '—')}
          ${row('Название суда', c.court || '—')}
          ${row('Наказание по преступлению', c.sentence || '—')}
          ${row('Общее наказание', c.totalSentence || c.sentence || '—')}
        </div>
        <span class="pcase__src">источник</span>
      </div>
    </label>`;
}

/** 16.3 — практика: продуктовый вид, чекбоксы по делам, отмечены упомянутые в блоке. */
function openPracticeModal(block) {
  const pool = (state.card.practice && state.card.practice.length) ? state.card.practice : PRACTICE_CASES;
  const canBind = !!(block && block.parts && block.parts.length);
  const selected = canBind ? (block.selectedPractice || []) : [];

  const items = pool.map((c, i) =>
    practiceCaseHtml(c, i, { checked: selected.includes(i), disabled: !canBind })).join('');

  openModal({
    title: canBind ? `Практика по линии · ${block.label}` : 'Практика по линии защиты',
    context: canBind ? blockModalContext(block) : null,
    bodyHtml: items,
    buttons: canBind ? [
      { label: 'Отмена' },
      {
        label: 'Применить',
        primary: true,
        onClick: () => {
          const sel = [...modalEl.querySelectorAll('input[data-idx]:checked')].map(i => +i.dataset.idx);
          closeModal();
          block.selectedPractice = sel;
          const html = sel.map(i => `${pool[i].num} (${pool[i].court}) — ${pool[i].result.toLowerCase()}`).join('; ') + (sel.length ? '.' : '');
          const existing = block.parts.find(p => p.key === 'practice');
          if (sel.length) {
            if (existing) existing.html = html;
            else {
              const idx = block.parts.findIndex(p => p.key === 'circumstances');
              const item = { key: 'practice', title: 'Практика', html };
              if (idx >= 0) block.parts.splice(idx, 0, item);
              else block.parts.push(item);
            }
          } else if (existing) {
            block.parts.splice(block.parts.indexOf(existing), 1);
          }
          block.dirty = true;
          block.dirtyNotified = true;
          block.argsStale = true;
          renderBlocks();
          flashBlock(block.id);
          addMessage('assistant', `Практика ${labelGen(block.label)} обновлена: выбрано дел — ${sel.length}. Кнопка «Перегенерировать» активна.`);
        }
      }
    ] : [{ label: 'Закрыть' }]
  });
}

/* ================= Ввод ================= */

function sendPrompt() {
  if (state.busy) return;
  const text = promptEl.value.trim();
  if (!text) return;
  promptEl.value = '';
  autosize();
  addMessage('user', text);
  routeText(text);
}

function autosize() {
  promptEl.style.height = 'auto';
  promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
}

promptEl.addEventListener('input', autosize);
promptEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
sendBtn.addEventListener('click', sendPrompt);
attachBtn.addEventListener('click', onAttachClick);

/* ================= Настройки нейронки (ключ — только в localStorage) ================= */

const aiBtn = $('#demo-ai');

function refreshAiButton() {
  if (!aiBtn) return;
  aiBtn.textContent = LLM.enabled() ? `ИИ: вкл · ${LLM.model}` : 'ИИ: выкл';
  aiBtn.classList.toggle('is-on', LLM.enabled());
}

aiBtn?.addEventListener('click', () => {
  openModal({
    title: 'Подключение нейронки',
    bodyHtml: `
      <div class="ai-note">Ключ хранится только в этом браузере (localStorage) и не попадает
      в код или репозиторий. Работает с любым OpenAI-совместимым API. Без ключа демо
      использует шаблонные тексты.</div>
      <label class="ai-field">API-ключ <input type="password" id="ai-key" value="${LLM.key}" placeholder="sk-…"></label>
      <label class="ai-field">Endpoint <input type="text" id="ai-url" value="${LLM.url}"></label>
      <label class="ai-field">Модель <input type="text" id="ai-model" value="${LLM.model}"></label>`,
    buttons: [
      { label: 'Отключить', onClick: () => { LLM.clear(); refreshAiButton(); closeModal(); addMessage('assistant', 'Нейронка отключена — работаю на шаблонных текстах.'); } },
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        primary: true,
        onClick: () => {
          LLM.save({
            key: modalEl.querySelector('#ai-key').value,
            url: modalEl.querySelector('#ai-url').value,
            model: modalEl.querySelector('#ai-model').value
          });
          refreshAiButton();
          closeModal();
          addMessage('assistant', LLM.enabled()
            ? `Нейронка подключена (${LLM.model}). «Перегенерировать», правки по чату и генерация секций теперь идут через неё.`
            : 'Ключ пуст — остаюсь на шаблонных текстах.');
        }
      }
    ]
  });
});

refreshAiButton();

/* ================= Режим «только текст документа» ================= */

// столбец кнопок фиксирован справа (переключатель стороны убран)
document.body.classList.add('ctrl-right');

// тумблер вида в тулбаре: нажат (по умолчанию) = показаны колонки блоков,
// отжат = только текст документа
const viewToggle = $('#view-toggle');
function applyViewMode(full) {
  document.body.classList.toggle('text-only', !full);
  viewToggle.classList.toggle('is-on', full);
  viewToggle.title = full
    ? 'Показаны колонки блоков — нажмите, чтобы оставить только текст документа'
    : 'Только текст документа — нажмите, чтобы показать колонки блоков';
}
viewToggle.addEventListener('click', () => applyViewMode(!viewToggle.classList.contains('is-on')));
applyViewMode(true);

/* ================= Шапка ================= */

$('#btn-download').addEventListener('click', () => window.print());
$('#btn-print').addEventListener('click', () => window.print());
$('#btn-logs').addEventListener('click', e => e.preventDefault());

/* ================= Старт ================= */

resetDemo(0);
