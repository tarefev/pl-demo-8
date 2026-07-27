/**
 * Визард ходатайств: каталог, проход по шагам, предпросмотр, вставка в документ.
 * Данные — js/motions.js и js/motion-defs.js. Работает поверх движка чата
 * (addMessage / think / startScenario), поэтому подчиняется правилам перебивки.
 */

let mwCtx = null;

/* ================= Запуск ================= */

/** Каталог ходатайств: двухуровневый — группы, внутри типы. */
function startMotionWizard() {
  startScenario('motion', 'Подготовка ходатайства');
  setStep('М.1');
  const el = addMessage('assistant', 'Какое ходатайство готовим? Выберите раздел, затем тип.');
  el.appendChild(buildCatalog());
  scrollFeed();
}

function buildCatalog() {
  const wrap = document.createElement('div');
  wrap.className = 'mw-groups';
  MOTION_CATALOG.forEach((g, gi) => {
    const grp = document.createElement('div');
    grp.className = 'mw-group' + (gi === 0 ? ' is-open' : '');
    grp.innerHTML = `
      <button class="mw-group__head" type="button">
        <span>${g.title}</span><span class="mw-group__count">${g.items.length}</span>
      </button>
      <div class="mw-group__body">${g.items.map(m =>
        `<button class="mw-item" type="button" data-id="${m.id}">${m.label}</button>`).join('')}</div>`;
    grp.querySelector('.mw-group__head').addEventListener('click', () => {
      const open = grp.classList.contains('is-open');
      wrap.querySelectorAll('.mw-group').forEach(x => x.classList.remove('is-open'));
      if (!open) grp.classList.add('is-open');
    });
    grp.querySelectorAll('.mw-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.busy) return;
        wrap.querySelectorAll('.mw-item').forEach(b => b.disabled = true);
        const id = btn.dataset.id;
        addMessage('user', findMotion(id).label);
        pickMotion(id);
      });
    });
    wrap.appendChild(grp);
  });
  return wrap;
}

/** Старт визарда по выбранному типу: определяем стадию и идём по шагам. */
async function pickMotion(id) {
  const def = MOTION_DEFS[id];
  if (!def) return endScenario('Этот тип ходатайства пока не реализован.');

  mwCtx = { id, def, stage: null, answers: {}, step: 0 };
  state.scenario.title = findMotion(id).label;
  updateScenarioBanner();

  // стадия: жёстко заданная типом, из карточки или вопросом
  if (def.forceStage) {
    mwCtx.stage = def.forceStage;
    addMessage('assistant', `Стадия: ${stageLabel(def.forceStage).toLowerCase()} — определена типом ходатайства.`);
    mwSync();               // каркас документа появляется сразу, до первого вопроса
    return mwRunStep();
  }
  const known = state.card.stage;
  if (known && MOTION_STAGES.some(s => s.key === known)) {
    mwCtx.stage = known;
    const el = addMessage('assistant', '');
    el.innerHTML = `Стадия по карточке дела: <b>${stageLabel(known)}</b>. <button class="mw-link" type="button">изменить</button>`;
    el.querySelector('.mw-link').addEventListener('click', () => askStage());
    scrollFeed();
    mwSync();               // каркас документа появляется сразу, до первого вопроса
    return mwRunStep();
  }
  askStage();
}

function askStage() {
  setStep('М.2');
  offerChoices(MOTION_STAGES.map(s => ({
    label: s.label,
    wide: true,
    onPick: () => {
      addMessage('user', s.label);
      mwCtx.stage = s.key;
      state.card.stage = s.key;
      mwCtx.step = 0;
      mwSync();
      mwRunStep();
    }
  })), 'На какой стадии находится дело? От этого зависят адресат, нормы и объём доступных материалов.');
}

/* ================= Проход по шагам ================= */

function mwVal(v, fallback) {
  return typeof v === 'function' ? v(mwCtx) : (v === undefined ? fallback : v);
}

/** Следующий подходящий шаг (учитывает условия when). */
function mwRunStep() {
  const steps = mwCtx.def.steps;
  while (mwCtx.step < steps.length) {
    const s = steps[mwCtx.step];
    if (!s.when || s.when(mwCtx)) break;
    mwCtx.step += 1;
  }
  if (mwCtx.step >= steps.length) return mwPreview();

  const s = steps[mwCtx.step];
  setStep(`М.${mwCtx.step + 3}`);
  const total = steps.filter(x => !x.when || x.when(mwCtx)).length;
  const done = steps.slice(0, mwCtx.step).filter(x => !x.when || x.when(mwCtx)).length;

  mwLockPast();          // прошлые шаги в ленте больше не кликаются
  const el = addMessage('assistant', '');
  el.innerHTML = `
    <div class="mw-head">
      <span class="mw-step">Шаг ${done + 1} из ${total}</span>
      <button class="mw-back" type="button">← Назад</button>
    </div>
    <div class="mw-q">${s.q}</div>` +
    (s.hint ? `<div class="mw-hint">${s.hint}</div>` : '');
  el.querySelector('.mw-back').addEventListener('click', () => {
    if (state.busy) return;
    el.querySelectorAll('button, input, .mw-input').forEach(x => { x.disabled = true; x.contentEditable = 'false'; });
    mwBack();
  });

  const render = {
    'choice': mwChoice, 'choice-group': mwChoiceGroup, 'multi': mwMulti,
    'multi-group': mwMultiGroup, 'text': mwText, 'form': mwForm,
    'evidence': mwEvidence, 'confirm': mwConfirm
  }[s.type];
  if (render) render(el, s);
  scrollFeed();
}

function mwNext(answer, key) {
  if (key) mwCtx.answers[key] = answer;
  mwCtx.step += 1;
  mwSync();      // документ дособирается сразу — до следующего вопроса
  mwRunStep();
}

/** Шаг назад: снимаем ответ предыдущего шага и возвращаемся к нему. */
function mwBack() {
  const steps = mwCtx.def.steps;
  let i = mwCtx.step - 1;
  while (i >= 0 && steps[i].when && !steps[i].when(mwCtx)) i -= 1;
  if (i < 0) {
    // с первого шага возвращаемся к выбору типа ходатайства
    addMessage('user', 'Назад, к выбору ходатайства');
    mwCtx = null;
    state.scenario = null;
    return startMotionWizard();
  }
  delete mwCtx.answers[steps[i].key];
  mwCtx.step = i;
  addMessage('user', 'Назад');
  mwSync();
  mwRunStep();
}

/**
 * Живая сборка: документ обновляется на каждом шаге, а не в конце.
 * Всё, чего ещё нет в ответах, стоит жёлтыми метками — видно, что осталось заполнить.
 */
function mwSync() {
  if (!mwCtx) return;
  let built;
  try { built = mwCtx.def.build(mwCtx); } catch { return; }
  mwCtx.built = built;

  const title = mwCtx.def.title(mwCtx);
  applyDocTitle(title);
  state.docType = { key: 'motion', label: title };
  state.motionNorms = built.norms;
  renderDocHeader(mwHeaderLines(), { silent: true });

  // мотивировочная часть — один блок, обновляем на месте, чтобы не мигал весь документ
  const html = built.body.map(p => `<p>${p}</p>`).join('');
  let body = state.blocks.find(b => b.kind === 'motion-body');
  const changed = !body || body.html !== html;
  if (body) body.html = html;
  else body = getBlock(insertBlock(html, { section: 'facts', kind: 'motion-body' }));

  // приложения + дата и подпись (по шаблону идут после просительной части)
  const attHtml = (built.attachments && built.attachments.length
    ? `<p><b>Приложение:</b></p><ol>${built.attachments.map(a => `<li>${a}</li>`).join('')}</ol>` : '')
    + mwSignHtml();
  const att = state.blocks.find(b => b.kind === 'motion-att');
  if (att) att.html = attHtml;
  else insertBlock(attHtml, { section: 'law', kind: 'motion-att' });

  // просительная часть
  state.pleas = [];
  built.plea.forEach(p => { if (!state.pleas.includes(p)) state.pleas.push(p); });

  renderBlocks();
  renderPleas();
  updateChecklist();
  if (changed && body) flashBlock(body.id);
}

/**
 * Гасим управление в уже пройденных шагах: активным остаётся только последний.
 * Иначе клик по «Назад» старого шага уводит не туда, куда ожидает пользователь.
 */
function mwLockPast() {
  document.querySelectorAll('#assistant-feed .msg').forEach(msg => {
    msg.querySelectorAll('.mw-back, .mw-ok, .mw-add, .mw-item, .mw-all, .mw-check input, .mw-input, .mw-field input, .mw-field select, .mw-chip button')
      .forEach(x => { x.disabled = true; if (x.isContentEditable) x.contentEditable = 'false'; });
  });
}

/** Показ предупреждения под шагом (правовой предохранитель). */
function mwWarn(el, text) {
  if (!text) return;
  const w = document.createElement('div');
  w.className = 'mw-warn';
  w.textContent = text;
  el.appendChild(w);
  scrollFeed();
}

/* ---------- Типы шагов ---------- */

function mwChoice(el, s) {
  const opts = mwVal(s.options, []);
  const box = document.createElement('div');
  box.className = 'mw-choices';
  opts.forEach(o => {
    const b = document.createElement('button');
    b.className = 'mw-choice';
    b.type = 'button';
    b.textContent = o;
    b.addEventListener('click', () => {
      if (state.busy) return;
      box.querySelectorAll('button').forEach(x => x.disabled = true);
      b.classList.add('is-picked');
      addMessage('user', o);
      const warn = s.warn && s.warn(o, mwCtx);
      if (warn) mwWarn(el, warn);
      mwNext(o, s.key);
    });
    box.appendChild(b);
  });
  if (s.allowOther) box.appendChild(mwOtherButton(v => { addMessage('user', v); mwNext(v, s.key); }, 'Свой вариант'));
  el.appendChild(box);
}

function mwChoiceGroup(el, s) {
  const groups = mwVal(s.groups, []);
  const wrap = document.createElement('div');
  wrap.className = 'mw-groups';
  groups.forEach((g, gi) => {
    const grp = document.createElement('div');
    grp.className = 'mw-group' + (gi === 0 ? ' is-open' : '');
    grp.innerHTML = `
      <button class="mw-group__head" type="button">
        <span>${g.title}</span><span class="mw-group__count">${g.items.length}</span>
      </button>
      ${g.note ? `<div class="mw-group__note">${g.note}</div>` : ''}
      <div class="mw-group__body">${g.items.map((it, i) =>
        `<button class="mw-item" type="button" data-g="${gi}" data-i="${i}">${it.text}${it.norm ? `<span class="mw-item__norm">${it.norm}</span>` : ''}</button>`).join('')}</div>`;
    grp.querySelector('.mw-group__head').addEventListener('click', () => {
      const open = grp.classList.contains('is-open');
      wrap.querySelectorAll('.mw-group').forEach(x => x.classList.remove('is-open'));
      if (!open) grp.classList.add('is-open');
    });
    grp.querySelectorAll('.mw-item').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.busy) return;
        const item = groups[+btn.dataset.g].items[+btn.dataset.i];
        wrap.querySelectorAll('.mw-item').forEach(b => b.disabled = true);
        btn.classList.add('is-picked');
        addMessage('user', item.text);
        const warn = s.warn && s.warn(item, mwCtx);
        if (warn) mwWarn(el, warn);
        mwNext(item, s.key);
      });
    });
    wrap.appendChild(grp);
  });
  el.appendChild(wrap);
  if (s.allowOther) el.appendChild(mwOtherButton(v => { addMessage('user', v); mwNext({ text: v }, s.key); }, 'Другой вариант'));
}

function mwMulti(el, s) {
  const opts = mwVal(s.options, []);
  const picked = new Set(mwVal(s.defaults, []) || []);
  const box = document.createElement('div');
  box.className = 'mw-multi';
  const draw = () => {
    box.innerHTML = opts.map(o =>
      `<label class="mw-check${picked.has(o) ? ' is-on' : ''}"><input type="checkbox" ${picked.has(o) ? 'checked' : ''}><span>${o}</span></label>`).join('')
      + [...picked].filter(p => !opts.includes(p)).map(o =>
        `<label class="mw-check is-on"><input type="checkbox" checked><span>${o}</span></label>`).join('');
    box.querySelectorAll('.mw-check').forEach((lab, i) => {
      lab.querySelector('input').addEventListener('change', e => {
        const text = lab.querySelector('span').textContent;
        if (e.target.checked) picked.add(text); else picked.delete(text);
        lab.classList.toggle('is-on', e.target.checked);
        const warn = s.warn && s.warn([...picked], mwCtx);
        el.querySelectorAll('.mw-warn').forEach(w => w.remove());
        if (warn) mwWarn(el, warn);
      });
    });
  };
  draw();
  el.appendChild(box);

  const actions = document.createElement('div');
  actions.className = 'mw-actions';
  if (s.allowOther) {
    const add = document.createElement('button');
    add.className = 'mw-add'; add.type = 'button';
    add.textContent = s.otherLabel || 'Добавить свой вариант';
    add.addEventListener('click', () => mwPrompt(v => { picked.add(v); draw(); }));
    actions.appendChild(add);
  }
  const ok = document.createElement('button');
  ok.className = 'mw-ok'; ok.type = 'button';
  ok.textContent = 'Готово';
  ok.addEventListener('click', () => {
    if (state.busy) return;
    if (!picked.size && !s.optional) return mwWarn(el, 'Выберите хотя бы один вариант.');
    el.querySelectorAll('button, input').forEach(x => x.disabled = true);
    addMessage('user', picked.size ? [...picked].join('; ') : 'Пропустить');
    mwNext([...picked], s.key);
  });
  actions.appendChild(ok);
  el.appendChild(actions);
}

function mwMultiGroup(el, s) {
  const groups = mwVal(s.groups, []);
  const picked = new Set(mwVal(s.defaults, []) || []);

  const basket = document.createElement('div');
  basket.className = 'mw-basket';
  const wrap = document.createElement('div');
  wrap.className = 'mw-groups';

  const drawBasket = () => {
    basket.innerHTML = picked.size
      ? `<div class="mw-basket__title">Выбрано: ${picked.size}</div>` +
        [...picked].map(p => `<span class="mw-chip">${p}<button type="button" data-x="${p.replace(/"/g, '&quot;')}">×</button></span>`).join('')
      : '<div class="mw-basket__empty">Ничего не выбрано</div>';
    basket.querySelectorAll('button[data-x]').forEach(b => b.addEventListener('click', () => {
      picked.delete(b.dataset.x);
      drawBasket(); syncChecks();
    }));
  };
  const syncChecks = () => wrap.querySelectorAll('.mw-check').forEach(lab => {
    const on = picked.has(lab.querySelector('span').textContent);
    lab.classList.toggle('is-on', on);
    lab.querySelector('input').checked = on;
  });

  groups.forEach((g, gi) => {
    const items = g.items.map(i => (typeof i === 'string' ? i : i.text));
    const grp = document.createElement('div');
    grp.className = 'mw-group' + (gi === 0 ? ' is-open' : '');
    grp.innerHTML = `
      <button class="mw-group__head" type="button">
        <span>${g.title}</span><span class="mw-group__count">${items.length}</span>
      </button>
      ${g.note ? `<div class="mw-group__note">${g.note}</div>` : ''}
      <div class="mw-group__body">
        <button class="mw-all" type="button">Выбрать всё в разделе</button>
        ${items.map(t => `<label class="mw-check"><input type="checkbox"><span>${t}</span></label>`).join('')}
      </div>`;
    grp.querySelector('.mw-group__head').addEventListener('click', () => {
      const open = grp.classList.contains('is-open');
      wrap.querySelectorAll('.mw-group').forEach(x => x.classList.remove('is-open'));
      if (!open) grp.classList.add('is-open');
    });
    grp.querySelector('.mw-all').addEventListener('click', () => {
      items.forEach(t => picked.add(t));
      drawBasket(); syncChecks(); showWarn();
    });
    grp.querySelectorAll('.mw-check input').forEach(inp => {
      inp.addEventListener('change', e => {
        const text = e.target.closest('.mw-check').querySelector('span').textContent;
        if (e.target.checked) picked.add(text); else picked.delete(text);
        drawBasket(); syncChecks(); showWarn();
      });
    });
    wrap.appendChild(grp);
  });

  const showWarn = () => {
    el.querySelectorAll('.mw-warn').forEach(w => w.remove());
    const warn = s.warn && s.warn([...picked], mwCtx);
    if (warn) mwWarn(el, warn);
  };

  drawBasket();
  el.appendChild(basket);
  el.appendChild(wrap);

  const ok = document.createElement('button');
  ok.className = 'mw-ok'; ok.type = 'button';
  ok.textContent = 'Готово';
  ok.addEventListener('click', () => {
    if (state.busy) return;
    if (!picked.size && !s.optional) return mwWarn(el, 'Выберите хотя бы один пункт.');
    el.querySelectorAll('button, input').forEach(x => x.disabled = true);
    addMessage('user', `Выбрано: ${picked.size}`);
    mwNext([...picked], s.key);
  });
  el.appendChild(ok);
}

function mwText(el, s) {
  const box = document.createElement('div');
  box.className = 'mw-text';
  box.innerHTML = `<div class="mw-input" contenteditable="true" data-ph="Введите текст…"></div>`;
  const input = box.querySelector('.mw-input');
  const actions = document.createElement('div');
  actions.className = 'mw-actions';

  if (s.ai && typeof LLM !== 'undefined') {
    const ai = document.createElement('button');
    ai.className = 'mw-add'; ai.type = 'button';
    ai.textContent = 'Черновик с ИИ';
    ai.addEventListener('click', async () => {
      if (!LLM.enabled()) return mwWarn(el, 'Нейросеть не подключена — заполните текст вручную.');
      ai.disabled = true; ai.textContent = 'Готовлю черновик…';
      try {
        const draft = await LLM.complete(mwDraftPrompt(s), { maxTokens: 2000 });
        input.innerText = draft.trim();
      } catch (err) {
        mwWarn(el, `ИИ недоступен: ${err.message}. Заполните текст вручную.`);
      }
      ai.disabled = false; ai.textContent = 'Черновик с ИИ';
    });
    actions.appendChild(ai);
  }

  const ok = document.createElement('button');
  ok.className = 'mw-ok'; ok.type = 'button';
  ok.textContent = 'Готово';
  ok.addEventListener('click', () => {
    if (state.busy) return;
    const v = input.innerText.trim();
    if (!v && s.required) return mwWarn(el, 'Это поле обязательно: без него ходатайство теряет смысл.');
    el.querySelectorAll('button, .mw-input').forEach(x => { x.disabled = true; x.contentEditable = 'false'; });
    addMessage('user', v || 'Пропустить');
    mwNext(v, s.key);
  });
  actions.appendChild(ok);
  el.appendChild(box);
  el.appendChild(actions);
  setTimeout(() => input.focus(), 50);
}

function mwForm(el, s) {
  const fields = mwVal(s.fields, []);
  const box = document.createElement('div');
  box.className = 'mw-form';
  box.innerHTML = fields.map(f =>
    `<label class="mw-field"><span>${f.label}${f.optional ? '' : ' *'}</span>
      <input type="text" data-k="${f.key}" value="${(f.preset ? f.preset() : '') || ''}"></label>`).join('');
  el.appendChild(box);

  const ok = document.createElement('button');
  ok.className = 'mw-ok'; ok.type = 'button';
  ok.textContent = 'Готово';
  let warned = false;
  ok.addEventListener('click', () => {
    if (state.busy) return;
    const val = {};
    box.querySelectorAll('input[data-k]').forEach(i => { if (i.value.trim()) val[i.dataset.k] = i.value.trim(); });
    const missing = fields.filter(f => !f.optional && !val[f.key]);
    // первое нажатие с пробелами — предупреждаем; второе — продолжаем с жёлтой меткой
    if (missing.length && !s.optional && !warned) {
      warned = true;
      ok.textContent = 'Всё равно продолжить';
      return mwWarn(el, `Не заполнено: ${missing.map(f => f.label.toLowerCase()).join(', ')}. Заполните или нажмите ещё раз — в документе останется жёлтая метка.`);
    }
    el.querySelectorAll('button, input').forEach(x => x.disabled = true);
    addMessage('user', Object.values(val).join(', ') || 'Пропустить');
    mwNext(val, s.key);
  });
  el.appendChild(ok);
}

function mwEvidence(el, s) {
  const list = (state.card.evidence || []).map(e => (typeof e === 'string' ? { title: e } : e));
  const box = document.createElement('div');
  box.className = 'mw-evidence';
  box.innerHTML = list.length
    ? list.map((e, i) => `<button class="mw-item" type="button" data-i="${i}">${e.title}</button>`).join('')
    : '<div class="mw-hint">В карточке дела нет доказательств — добавьте новое.</div>';
  el.appendChild(box);

  const addBtn = document.createElement('button');
  addBtn.className = 'mw-add'; addBtn.type = 'button';
  addBtn.textContent = '+ Добавить новое доказательство';
  el.appendChild(addBtn);

  const openForm = (base) => {
    el.querySelectorAll('.mw-item, .mw-add').forEach(b => b.disabled = true);
    const form = document.createElement('div');
    form.className = 'mw-form';
    const needSource = s.needSource;
    form.innerHTML = `
      <label class="mw-field"><span>Наименование *</span><input type="text" data-k="title" value="${(base && base.title) || ''}"></label>
      ${s.needPlace ? `
      <label class="mw-field"><span>Том *</span><input type="text" data-k="volume" value="${(base && base.volume) || ''}"></label>
      <label class="mw-field"><span>Листы дела *</span><input type="text" data-k="sheets" value="${(base && base.sheets) || ''}"></label>` : ''}
      ${needSource ? `
      <label class="mw-field"><span>Способ получения *</span>
        <select data-k="obtainedBy">
          <option value="">— выберите —</option>
          <option value="advocate-request">Адвокатский запрос</option>
          <option value="survey">Опрос лица с его согласия</option>
          <option value="client">Представлено доверителем</option>
          <option value="specialist">Заключение специалиста</option>
        </select></label>` : ''}`;
    el.appendChild(form);

    const ok = document.createElement('button');
    ok.className = 'mw-ok'; ok.type = 'button';
    ok.textContent = 'Готово';
    let warned = false;
    ok.addEventListener('click', () => {
      const val = { ...(base || {}) };
      form.querySelectorAll('[data-k]').forEach(i => { if (i.value.trim()) val[i.dataset.k] = i.value.trim(); });
      const need = ['title', ...(s.needPlace ? ['volume', 'sheets'] : []), ...(needSource ? ['obtainedBy'] : [])];
      const missing = need.filter(k => !val[k]);
      // первое нажатие с пробелами — предупреждаем и даём заполнить; второе — идём дальше с жёлтой меткой
      if (missing.length && !warned) {
        warned = true;
        mwWarn(el, s.needPlace && (missing.includes('volume') || missing.includes('sheets'))
          ? 'Том и листы дела обязательны: без точной ссылки суд не обязан искать доказательство. Заполните поля или нажмите ещё раз — в документе останется жёлтая метка.'
          : 'Заполните обязательные поля или нажмите ещё раз — в документе останется жёлтая метка.');
        ok.textContent = 'Всё равно продолжить';
        return;
      }
      if (needSource && val.obtainedBy === 'survey') {
        mwWarn(el, 'При опросе лица приложите его письменное согласие — без него доказательство легко оспорить.');
      }
      form.querySelectorAll('input, select').forEach(x => x.disabled = true);
      ok.disabled = true;
      addMessage('user', val.title || 'Доказательство');
      mwNext(val, s.key);
    });
    el.appendChild(ok);
    setTimeout(() => form.querySelector('input')?.focus(), 50);
  };

  box.querySelectorAll('.mw-item').forEach(b => b.addEventListener('click', () => {
    if (state.busy) return;
    openForm(list[+b.dataset.i]);
  }));
  addBtn.addEventListener('click', () => { if (!state.busy) openForm(null); });
}

function mwConfirm(el, s) {
  const box = document.createElement('div');
  box.className = 'mw-confirm';
  box.innerHTML = `<label class="mw-check${s.defaultOn ? ' is-on' : ''}"><input type="checkbox" ${s.defaultOn ? 'checked' : ''}><span>${s.label}</span></label>`;
  const inp = box.querySelector('input');
  inp.addEventListener('change', () => box.querySelector('.mw-check').classList.toggle('is-on', inp.checked));
  el.appendChild(box);

  const ok = document.createElement('button');
  ok.className = 'mw-ok'; ok.type = 'button';
  ok.textContent = 'Готово';
  ok.addEventListener('click', () => {
    if (state.busy) return;
    if (!inp.checked && !s.optional) {
      return mwWarn(el, 'Без этой отметки документ будет помечен как неготовый к подаче.');
    }
    el.querySelectorAll('button, input').forEach(x => x.disabled = true);
    addMessage('user', inp.checked ? 'Подтверждаю' : 'Пропустить');
    mwNext(inp.checked, s.key);
  });
  el.appendChild(ok);
}

/** Кнопка «свой вариант» с полем ввода. */
function mwOtherButton(cb, label) {
  const b = document.createElement('button');
  b.className = 'mw-add'; b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', () => mwPrompt(cb));
  return b;
}

function mwPrompt(cb) {
  openModal({
    title: 'Свой вариант',
    bodyHtml: '<input type="text" id="mw-other" style="width:100%;font:inherit;padding:8px 10px;border:1px solid #d7dae3;border-radius:8px;outline:none">',
    buttons: [
      { label: 'Отмена' },
      { label: 'Добавить', primary: true, onClick: () => {
        const v = (document.getElementById('mw-other') || {}).value || '';
        closeModal();
        if (v.trim()) cb(v.trim());
      } }
    ]
  });
  setTimeout(() => document.getElementById('mw-other')?.focus(), 60);
}

/** Промт для черновика обоснования: только переданные данные. */
function mwDraftPrompt(step) {
  const def = mwCtx.def;
  const parts = Object.entries(mwCtx.answers).map(([k, v]) => {
    const val = Array.isArray(v) ? v.join('; ') : (v && typeof v === 'object' ? Object.values(v).join(', ') : v);
    return `${k}: ${val}`;
  }).join('\n');
  return `Составь фрагмент мотивировочной части процессуального документа — ходатайства по уголовному делу.
Тип ходатайства: ${def.title(mwCtx)}.
Стадия: ${stageLabel(mwCtx.stage)}.
Вопрос, на который отвечает фрагмент: ${step.q}

Данные, выбранные защитником:
${parts || '—'}

Сведения о деле:
${caseSummaryForPrompt()}

Требования: 2–4 связных предложения строгим юридическим языком; не выдумывай фактов,
дат, номеров и содержания норм сверх переданного; не ссылайся на нормы, которых нет в
переданных данных; пиши от стороны защиты.`;
}

/* ================= Предпросмотр и вставка ================= */

function mwPreview() {
  setStep('М.Ф');
  mwSync();                       // финальная пересборка
  const built = mwCtx.built;
  const title = mwCtx.def.title(mwCtx);

  mwLockPast();
  const el = addMessage('assistant', '');
  el.classList.add('msg--card');
  const gaps = built.checklist.filter(c => !c.ok);
  el.innerHTML = `
    <div class="mw-preview__title">Документ собран — он слева, в редакторе</div>
    <div class="mw-check-list">
      <div class="mw-check-list__title">Готовность к подаче</div>
      ${built.checklist.map(c => `<div class="mw-cl ${c.ok ? 'is-ok' : 'is-gap'}">${c.ok ? '✓' : '!'} ${c.label}</div>`).join('')}
      ${gaps.length ? '<div class="mw-cl__note">Пункты со знаком «!» отмечены в документе жёлтым — заполните их перед подачей.</div>' : ''}
    </div>
    <div class="mw-note">Ходатайство подлежит рассмотрению непосредственно после заявления, а если это невозможно — не позднее трёх суток (ст. 121 УПК РФ). Решение оформляется постановлением (ст. 122 УПК РФ).</div>`;

  const actions = document.createElement('div');
  actions.className = 'mw-actions';
  const done = document.createElement('button');
  done.className = 'mw-ok'; done.type = 'button';
  done.textContent = 'Готово, документ верен';
  done.addEventListener('click', () => {
    actions.querySelectorAll('button').forEach(b => b.disabled = true);
    mwFinish(built);
  });
  const back = document.createElement('button');
  back.className = 'mw-add'; back.type = 'button';
  back.textContent = '← Изменить ответы';
  back.addEventListener('click', () => {
    if (state.busy) return;
    actions.querySelectorAll('button').forEach(b => b.disabled = true);
    mwCtx.step = mwCtx.def.steps.length;   // встаём в конец и шагаем назад
    mwBack();
  });
  actions.appendChild(done);
  actions.appendChild(back);
  el.appendChild(actions);
  scrollFeed();
}

/** Завершение: документ уже в редакторе, остаётся зафиксировать результат. */
function mwFinish(built) {
  const gaps = built.checklist.filter(c => !c.ok).length;
  endScenario(gaps
    ? `Ходатайство собрано. Осталось заполнить ${gaps} ${gaps === 1 ? 'пункт' : 'пункта(ов)'} — они отмечены жёлтым в документе.`
    : 'Ходатайство собрано и готово к подаче.');
  mwCtx = null;
}


/**
 * Шапка ходатайства по шаблону: адресат, номер дела, полные реквизиты защитника,
 * в чьих интересах и по какому обвинению, адрес и телефон для корреспонденции.
 */
function mwHeaderLines() {
  const c = state.card;
  const court = c.court || {};
  const ph = t => `<span class="ph-mark">&lt;${t}&gt;</span>`;
  const lines = [];

  // адресат
  if (mwCtx && mwCtx.stage === 'court') {
    lines.push(`В ${court.firstInstanceCourt || court.firstInstance || ph('вставить наименование суда')}`);
    if (court.judge) lines.push(court.judge);
  } else {
    // в карточке наименование органа часто уже входит в строку следователя — не дублируем
    const org = (c.investigatorOrg || '').replace(/^В\s+/, '');
    const inv = c.investigator || '';
    if (org && !(inv && inv.includes(org))) lines.push(`В ${org}`);
    lines.push(inv || ph('вставить должность, ФИО следователя'));
  }
  lines.push(court.caseNum ? `по уголовному делу № ${court.caseNum}` : `по уголовному делу ${ph('вставить номер')}`);
  lines.push('');

  // защитник и его реквизиты
  const status = c.clientStatus || 'обвиняемого';
  lines.push(`от защитника ${status} ${c.clientGen || ph('вставить ФИО доверителя')}`);
  lines.push(`${c.advocateGen || ph('вставить ФИО адвоката')}, адвоката,`);
  lines.push(`регистрационный № ${c.advocateReg || ph('номер')} в реестре адвокатов ${c.advocateRegion || ph('субъект РФ')},`);
  lines.push(`удостоверение № ${c.advocateCert || ph('номер')}${c.advocateCertDate ? ` от ${c.advocateCertDate}` : ` от ${ph('дата')}`},`);

  // в чьих интересах и по какому обвинению (у осуждённого — «осуждённого по ст. …»)
  const qual = (c.episodes[0] || {}).qualification || ph('часть, статья УК РФ');
  lines.push(`действующего в защиту интересов ${c.clientGen || ph('вставить ФИО доверителя')},`);
  lines.push(/осужд/.test(status)
    ? `${status} по ${qual}`
    : `${status} в совершении преступления, предусмотренного ${qual}`);
  lines.push(`адрес для корреспонденции: ${c.advocateAddr || ph('вставить адрес')}`);
  lines.push(`тел.: ${c.advocatePhone || ph('вставить телефон')}`);
  return lines;
}

/**
 * Формула просительной части: статьи УПК собираются в один ряд, как в
 * бумажном шаблоне («руководствуясь ст. 47, 53, 119–122 УПК РФ»), а не
 * перечисляются с частями и пунктами.
 */
function motionPleaIntro() {
  const norms = state.motionNorms || [];
  const upk = [];
  const other = [];
  norms.forEach(n => {
    const m = /^ст\.\s*([\d.]+)/.exec(n);
    if (m && /УПК РФ/.test(n)) { if (!upk.includes(m[1])) upk.push(m[1]); }
    else if (/УК РФ|Федерального закона|Правительства/.test(n) && !other.includes(n)) other.push(n);
  });
  // 119–122 идут блоком: это общий порядок заявления и разрешения ходатайств
  const base = ['119', '120', '121', '122'];
  const own = upk.filter(x => !base.includes(x)).sort((a, b) => parseFloat(a) - parseFloat(b));
  const parts = [];
  if (own.length || upk.some(x => base.includes(x))) {
    parts.push(`ст. ${[...own, '119–122'].join(', ')} УПК РФ`);
  }
  other.slice(0, 2).forEach(o => parts.push(o));
  return parts.length
    ? `На основании изложенного и руководствуясь ${parts.join(', ')}, ПРОШУ:`
    : 'На основании изложенного и руководствуясь ст. 119–122 УПК РФ, ПРОШУ:';
}

/** Блок даты и подписи — общий для всех ходатайств. */
function mwSignHtml() {
  const c = state.card;
  const ph = t => `<span class="ph-mark">&lt;${t}&gt;</span>`;
  return `<p class="mw-sign">«${ph('дата')}» ${ph('месяц')} 20${ph('год')} г.</p>` +
    `<p class="mw-sign">Защитник ________________ / ${c.advocate || ph('Ф. И. О.')}</p>`;
}
