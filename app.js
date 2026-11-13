/*
 * 暖芽 · 儿童穿衣建议 Agent ｜ 首版 MVP
 * 纯前端、零依赖、数据仅保存在浏览器本机 localStorage。
 * 规则引擎为确定性温度分层 + 场景约束，非医学或安全标准，仅用于验证产品流程。
 */

// =============================================================================
// 0. 存储层
// =============================================================================
const STORAGE_KEYS = {
  profile: 'nunya.profile.v1',
  weather: 'nunya.weather.v1',
  wardrobe: 'nunya.wardrobe.v1',
};

const Storage = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (err) {
      console.warn('[storage] 读取失败', key, err);
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn('[storage] 写入失败', key, err);
      return false;
    }
  },
  available() {
    try {
      const probe = '__nunya_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  },
};

// =============================================================================
// 1. 规则引擎 —— 温度分层 + 场景约束
// =============================================================================

/** 衣物类别中文名 */
const CATEGORY_LABEL = {
  top: '上装',
  bottom: '下装',
  base: '内搭',
  onepiece: '连体衣',
  outerwear: '外套',
  rainwear: '雨具',
  socks: '鞋袜',
};

/** 保暖等级中文名 */
const WARMTH_LABEL = { 1: '薄款', 2: '适中', 3: '厚款' };

/** 温度分层表（用于流程验证的初始规则，非医学或安全标准） */
// 字段说明：min/max 为该层适用的当前温度范围；
// base/top/bottom/outerwear/onepiece/rainwear/socks 为推荐保暖等级（数组，表示该层允许的可选等级）；
// 解释模板中的 {weather} {temp} {precip} {wind} 会被动态替换。
const TEMP_TIERS = [
  {
    id: 'frozen',
    range: { min: -Infinity, max: 0 },
    label: '严寒',
    needOuter: true,
    preferredBase: [2, 3],
    preferredTop: [2, 3],
    preferredBottom: [3],
    preferredOuterwear: [3],
    preferredOnepiece: [2, 3],
    preferredRainwear: [1],
    preferredSocks: [3],
    layers: ['内搭', '上装', '下装', '外套', '鞋袜'],
    reason: '当前温度较低，需要保留更多空气层锁温，优先厚款内搭与厚外套搭配。',
  },
  {
    id: 'cold',
    range: { min: 1, max: 8 },
    label: '冷',
    needOuter: true,
    preferredBase: [1, 2],
    preferredTop: [2, 3],
    preferredBottom: [2, 3],
    preferredOuterwear: [2, 3],
    preferredOnepiece: [2],
    preferredRainwear: [1],
    preferredSocks: [2, 3],
    layers: ['内搭', '上装', '下装', '外套', '鞋袜'],
    reason: '气温偏低，建议穿适中厚度的内搭和外套叠穿，方便根据活动量微调。',
  },
  {
    id: 'chilly',
    range: { min: 9, max: 14 },
    label: '偏凉',
    needOuter: true,
    preferredBase: [1],
    preferredTop: [2],
    preferredBottom: [2],
    preferredOuterwear: [1, 2],
    preferredOnepiece: [1, 2],
    preferredRainwear: [1],
    preferredSocks: [1, 2],
    layers: ['内搭', '上装', '下装', '外套', '鞋袜'],
    reason: '体感偏凉，一件薄到适中的外套即可，不必叠加过多层次。',
  },
  {
    id: 'mild',
    range: { min: 15, max: 20 },
    label: '温和',
    needOuter: false,
    preferredBase: [0, 1],
    preferredTop: [1, 2],
    preferredBottom: [1, 2],
    preferredOuterwear: [],
    preferredOnepiece: [1, 2],
    preferredRainwear: [1],
    preferredSocks: [1],
    layers: ['上装', '下装', '鞋袜'],
    reason: '气温舒适，单层适中厚度衣物即可。',
  },
  {
    id: 'warm',
    range: { min: 21, max: 26 },
    label: '温暖',
    needOuter: false,
    preferredBase: [0],
    preferredTop: [1],
    preferredBottom: [1],
    preferredOuterwear: [],
    preferredOnepiece: [1],
    preferredRainwear: [1],
    preferredSocks: [1],
    layers: ['上装', '下装', '鞋袜'],
    reason: '天气偏暖，优先选薄款透气面料。',
  },
  {
    id: 'hot',
    range: { min: 27, max: Infinity },
    label: '炎热',
    needOuter: false,
    preferredBase: [0],
    preferredTop: [1],
    preferredBottom: [1],
    preferredOuterwear: [],
    preferredOnepiece: [1],
    preferredRainwear: [1],
    preferredSocks: [1],
    layers: ['上装', '下装', '鞋袜'],
    reason: '气温较高，优先选薄款、宽松、吸汗的衣物。',
  },
];

function getTempTier(temp) {
  const t = Number(temp);
  if (Number.isNaN(t)) return null;
  return TEMP_TIERS.find((tier) => t >= tier.range.min && t <= tier.range.max) || TEMP_TIERS[TEMP_TIERS.length - 1];
}

/** 冷热偏好修正：'cold' 偏好提升一档保暖，'hot' 降低一档 */
function applyPreference(preference, warmthList) {
  if (!warmthList || warmthList.length === 0) return warmthList;
  if (preference === 'cold') return warmthList.map((w) => Math.min(3, w + 1));
  if (preference === 'hot') return warmthList.map((w) => Math.max(0, w - 1));
  return warmthList;
}

/**
 * 从可用衣橱中为指定类别挑选一件保暖等级匹配的衣物。
 * 优先取保暖等级精确匹配的；没有则降级取最接近的可用衣物。
 * 同一输入下结果确定（按 id 排序后取首件）。
 */
function pickItem(availableItems, category, preferredWarmth) {
  const candidates = availableItems.filter((it) => it.category === category);
  if (candidates.length === 0) return null;

  if (!preferredWarmth || preferredWarmth.length === 0) {
    // 该类别在本温度层不强制需要，但若候选只有一类可直接返回最薄的
    return [...candidates].sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  // 先找精确匹配
  const exact = candidates.filter((c) => preferredWarmth.includes(c.warmth));
  if (exact.length > 0) {
    return [...exact].sort((a, b) => a.id.localeCompare(b.id))[0];
  }

  // 没有精确匹配 → 取最接近的
  const sorted = [...candidates].sort((a, b) => {
    const da = Math.min(...preferredWarmth.map((w) => Math.abs(w - a.warmth)));
    const db = Math.min(...preferredWarmth.map((w) => Math.abs(w - b.warmth)));
    if (da !== db) return da - db;
    return a.id.localeCompare(b.id);
  });
  return sorted[0];
}

/**
 * 主入口：根据档案 + 天气 + 衣橱生成建议。
 * 返回 { ok: boolean, outfit: [...], reasons: [...], missingCategories: [...], errors: [...] }
 */
function generateRecommendation({ profile, weather, wardrobe }) {
  const errors = [];

  // 1. 检查必填输入
  if (!profile || typeof profile.age !== 'number' || Number.isNaN(profile.age)) {
    errors.push('档案中的年龄未填写或格式不正确。');
  }
  if (!profile || !['neutral', 'cold', 'hot'].includes(profile.preference)) {
    errors.push('档案中的冷热偏好未填写。');
  }
  if (!profile || !['outdoor', 'mixed'].includes(profile.scenario)) {
    errors.push('档案中的当天场景未填写。');
  }
  if (!weather || ['currentTemp', 'minTemp', 'maxTemp'].some((k) => typeof weather[k] !== 'number' || Number.isNaN(weather[k]))) {
    errors.push('天气信息中温度未填写或格式不正确。');
  }
  if (!weather || !['none', 'rain', 'snow'].includes(weather.precipitation)) {
    errors.push('天气信息中降水情况未选择。');
  }
  if (!weather || !['light', 'moderate', 'strong'].includes(weather.wind)) {
    errors.push('天气信息中风力情况未选择。');
  }
  if (!Array.isArray(wardrobe) || wardrobe.length === 0) {
    errors.push('衣橱还是空的，先录入能穿到的衣物。');
  }

  if (errors.length > 0) {
    return { ok: false, outfit: [], reasons: [], missingCategories: [], errors };
  }

  // 2. 过滤可用衣物
  const availableItems = wardrobe.filter((it) => it.available !== false);
  if (availableItems.length === 0) {
    return { ok: false, outfit: [], reasons: [], missingCategories: [], errors: ['衣橱里所有衣物都标记为不可用，请先启用或新增。'] };
  }

  // 3. 锁定温度分层
  const tier = getTempTier(weather.currentTemp);
  if (!tier) {
    return { ok: false, outfit: [], reasons: [], missingCategories: [], errors: ['温度值无法匹配任何分层，请检查输入。'] };
  }

  const pref = profile.preference;
  const outfit = [];
  const reasons = [];
  const missingCategories = [];

  // 4. 逐类挑选 —— 有连体衣优先连体衣替代上下装
  const onepiece = pickItem(availableItems, 'onepiece', applyPreference(pref, tier.preferredOnepiece));
  if (onepiece) {
    outfit.push({ layer: '连体衣', item: onepiece, reason: '已有连体衣可替代上装 + 下装，优先选它。' });
  } else {
    const top = pickItem(availableItems, 'top', applyPreference(pref, tier.preferredTop));
    const bottom = pickItem(availableItems, 'bottom', applyPreference(pref, tier.preferredBottom));
    if (top) outfit.push({ layer: '上装', item: top, reason: '匹配当前温度分层的保暖等级。' });
    else missingCategories.push('上装');
    if (bottom) outfit.push({ layer: '下装', item: bottom, reason: '匹配当前温度分层的保暖等级。' });
    else missingCategories.push('下装');
  }

  // 内搭（温和及以上可以省略）
  if (tier.preferredBase && tier.preferredBase.length > 0 && !tier.preferredBase.includes(0)) {
    const base = pickItem(availableItems, 'base', applyPreference(pref, tier.preferredBase));
    if (base) outfit.unshift({ layer: '内搭', item: base, reason: '提供基础保暖层，方便热时脱卸。' });
    else missingCategories.push('内搭');
  }

  // 外套（严寒/冷/偏凉层需要）
  if (tier.needOuter) {
    const outer = pickItem(availableItems, 'outerwear', applyPreference(pref, tier.preferredOuterwear));
    if (outer) outfit.push({ layer: '外套', item: outer, reason: '当前温度需要一件外层衣物。' });
    else missingCategories.push('外套');
  }

  // 鞋袜 —— 只要衣橱里有就加
  const socks = pickItem(availableItems, 'socks', applyPreference(pref, tier.preferredSocks));
  if (socks) outfit.push({ layer: '鞋袜', item: socks, reason: '脚部保暖是体感舒适度的关键。' });

  // 雨具
  if (weather.precipitation !== 'none') {
    const rainwear = availableItems.find((it) => it.category === 'rainwear' && it.waterproof)
      || pickItem(availableItems, 'rainwear', [1]);
    if (rainwear) {
      outfit.push({ layer: '雨具', item: rainwear, reason: weather.precipitation === 'rain' ? '有雨，建议带一件雨具。' : '有雪或低温，建议穿戴防水外层。' });
    } else {
      missingCategories.push('雨具');
    }
  }

  // 5. 解释 —— 引用实际天气和偏好
  reasons.push(`当前温度 ${weather.currentTemp}°C，处于"${tier.label}"分层，${tier.reason}`);
  if (weather.precipitation === 'rain') reasons.push('今日有雨，记得带伞或防水外套。');
  else if (weather.precipitation === 'snow') reasons.push('今日有雪，建议额外注意脚部和裤脚防湿。');
  if (weather.wind === 'moderate' || weather.wind === 'strong') reasons.push('风力较大，外套建议选择领口可收紧的款式。');
  if (pref === 'cold') reasons.push(`孩子标记为"比较怕冷"，整体保暖等级已向上调整一档。`);
  if (pref === 'hot') reasons.push(`孩子标记为"比较怕热"，整体保暖等级已向下调整一档。`);
  if (profile.scenario === 'mixed') reasons.push('当天室内外往返，建议优先选可叠穿脱卸的组合。');

  return {
    ok: missingCategories.length === 0 && outfit.length > 0,
    outfit,
    reasons,
    missingCategories,
    errors: [],
    tier,
  };
}

// =============================================================================
// 2. UI 层 —— DOM 引用 & 表单绑定
// =============================================================================
const $ = (id) => document.getElementById(id);

const ui = {
  // 表单
  profileForm: $('profileForm'),
  childName: $('childName'),
  age: $('age'),
  ageUnit: $('ageUnit'),
  preference: $('preference'),
  scenario: $('scenario'),
  profileStatus: $('profileStatus'),

  weatherForm: $('weatherForm'),
  currentTemp: $('currentTemp'),
  minTemp: $('minTemp'),
  maxTemp: $('maxTemp'),
  precipitation: $('precipitation'),
  wind: $('wind'),
  weatherStatus: $('weatherStatus'),

  wardrobeForm: $('wardrobeForm'),
  wardrobeId: $('wardrobeId'),
  itemName: $('itemName'),
  itemCategory: $('itemCategory'),
  itemWarmth: $('itemWarmth'),
  itemWaterproof: $('itemWaterproof'),
  itemAvailable: $('itemAvailable'),
  wardrobeSubmit: $('wardrobeSubmit'),
  cancelEdit: $('cancelEdit'),
  wardrobeStatus: $('wardrobeStatus'),
  wardrobeList: $('wardrobeList'),
  wardrobeCount: $('wardrobeCount'),
  emptyWardrobe: $('emptyWardrobe'),

  // 生成 & 结果
  generateButton: $('generateButton'),
  result: $('result'),
  profileReady: $('profileReady'),
  weatherReady: $('weatherReady'),
  wardrobeReady: $('wardrobeReady'),

  storageNotice: $('storageNotice'),
};

// =============================================================================
// 3. 状态 & 渲染
// =============================================================================
let state = {
  profile: null,
  weather: null,
  wardrobe: [],
};

function loadState() {
  state.profile = Storage.get(STORAGE_KEYS.profile, null);
  state.weather = Storage.get(STORAGE_KEYS.weather, null);
  state.wardrobe = Storage.get(STORAGE_KEYS.wardrobe, []);

  // 档案回填
  if (state.profile) {
    ui.childName.value = state.profile.childName || '';
    ui.age.value = state.profile.age ?? '';
    ui.ageUnit.value = state.profile.ageUnit || 'years';
    ui.preference.value = state.profile.preference || 'neutral';
    ui.scenario.value = state.profile.scenario || 'outdoor';
  }

  // 天气回填
  if (state.weather) {
    ui.currentTemp.value = state.weather.currentTemp ?? '';
    ui.minTemp.value = state.weather.minTemp ?? '';
    ui.maxTemp.value = state.weather.maxTemp ?? '';
    ui.precipitation.value = state.weather.precipitation || 'none';
    ui.wind.value = state.weather.wind || 'light';
  }

  renderWardrobe();
  updateReadiness();
}

function renderWardrobe() {
  const list = state.wardrobe;
  ui.wardrobeCount.textContent = `${list.length} 件`;

  if (list.length === 0) {
    ui.emptyWardrobe.hidden = false;
    ui.wardrobeList.innerHTML = '';
    return;
  }

  ui.emptyWardrobe.hidden = true;
  ui.wardrobeList.innerHTML = list
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => {
      const offBadge = item.available === false ? '<span class="item-badge off">不可用</span>' : '';
      const rainBadge = item.waterproof ? '<span class="item-badge rain">防雨</span>' : '';
      return `
        <li class="wardrobe-item ${item.available === false ? 'unavailable' : ''}" data-id="${item.id}">
          <div class="item-main">
            <div class="item-title">
              <strong>${escapeHtml(item.name)}</strong>
              ${offBadge}${rainBadge}
            </div>
            <div class="item-meta">
              ${CATEGORY_LABEL[item.category] || item.category} · ${WARMTH_LABEL[item.warmth] || item.warmth}
            </div>
          </div>
          <div class="item-actions">
            <button class="icon-button" data-action="edit" aria-label="编辑">编辑</button>
            <button class="icon-button danger" data-action="delete" aria-label="删除">删除</button>
          </div>
        </li>
      `;
    })
    .join('');
}

function updateReadiness() {
  const profileOk = !!(
    state.profile
    && typeof state.profile.age === 'number'
    && state.profile.preference
    && state.profile.scenario
  );
  const weatherOk = !!(
    state.weather
    && typeof state.weather.currentTemp === 'number'
    && typeof state.weather.minTemp === 'number'
    && typeof state.weather.maxTemp === 'number'
    && state.weather.precipitation
    && state.weather.wind
  );
  const wardrobeOk = state.wardrobe.length > 0;

  setReadyBadge(ui.profileReady, profileOk, profileOk ? '档案已保存' : '档案未保存');
  setReadyBadge(ui.weatherReady, weatherOk, weatherOk ? '天气已保存' : '天气未保存');
  setReadyBadge(ui.wardrobeReady, wardrobeOk, wardrobeOk ? `衣橱 ${state.wardrobe.length} 件` : '衣橱为空');

  ui.generateButton.disabled = !(profileOk && weatherOk && wardrobeOk);
  if (ui.generateButton.disabled) {
    ui.generateButton.title = '请先完成档案、天气并录入衣物';
  } else {
    ui.generateButton.title = '';
  }
}

function setReadyBadge(el, ready, text) {
  el.textContent = text;
  el.classList.toggle('ready', ready);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setFormStatus(el, message, type) {
  el.textContent = message || '';
  el.classList.remove('success', 'error');
  if (type) el.classList.add(type);
  if (message) {
    setTimeout(() => {
      if (el.textContent === message) {
        el.textContent = '';
        el.classList.remove('success', 'error');
      }
    }, 2600);
  }
}

// =============================================================================
// 4. 表单事件
// =============================================================================
ui.profileForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const age = Number(ui.age.value);
  if (Number.isNaN(age) || age < 0) {
    setFormStatus(ui.profileStatus, '请输入有效年龄。', 'error');
    return;
  }
  const profile = {
    childName: ui.childName.value.trim(),
    age,
    ageUnit: ui.ageUnit.value,
    preference: ui.preference.value,
    scenario: ui.scenario.value,
    savedAt: Date.now(),
  };
  state.profile = profile;
  Storage.set(STORAGE_KEYS.profile, profile);
  setFormStatus(ui.profileStatus, '已保存 ✓', 'success');
  updateReadiness();
});

ui.weatherForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const currentTemp = Number(ui.currentTemp.value);
  const minTemp = Number(ui.minTemp.value);
  const maxTemp = Number(ui.maxTemp.value);
  if ([currentTemp, minTemp, maxTemp].some((v) => Number.isNaN(v))) {
    setFormStatus(ui.weatherStatus, '请输入有效温度。', 'error');
    return;
  }
  if (minTemp > currentTemp || maxTemp < currentTemp) {
    setFormStatus(ui.weatherStatus, '当前温度应在当日最低和最高之间。', 'error');
    return;
  }
  const weather = {
    currentTemp,
    minTemp,
    maxTemp,
    precipitation: ui.precipitation.value,
    wind: ui.wind.value,
    savedAt: Date.now(),
  };
  state.weather = weather;
  Storage.set(STORAGE_KEYS.weather, weather);
  setFormStatus(ui.weatherStatus, '已保存 ✓', 'success');
  updateReadiness();
});

ui.wardrobeForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const mode = ui.wardrobeId.value ? 'edit' : 'add';
  const name = ui.itemName.value.trim();
  if (!name) {
    setFormStatus(ui.wardrobeStatus, '请输入衣物名称。', 'error');
    return;
  }
  const item = {
    id: ui.wardrobeId.value || cryptoId(),
    name,
    category: ui.itemCategory.value,
    warmth: Number(ui.itemWarmth.value),
    waterproof: ui.itemWaterproof.checked,
    available: ui.itemAvailable.checked,
    updatedAt: Date.now(),
  };

  if (mode === 'edit') {
    const idx = state.wardrobe.findIndex((it) => it.id === item.id);
    if (idx >= 0) state.wardrobe[idx] = item;
  } else {
    state.wardrobe.push(item);
  }
  Storage.set(STORAGE_KEYS.wardrobe, state.wardrobe);
  resetWardrobeForm();
  renderWardrobe();
  updateReadiness();
  setFormStatus(ui.wardrobeStatus, mode === 'edit' ? '已更新 ✓' : '已添加 ✓', 'success');
});

ui.cancelEdit.addEventListener('click', resetWardrobeForm);

ui.wardrobeList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const li = e.target.closest('li.wardrobe-item');
  if (!li) return;
  const id = li.dataset.id;

  if (btn.dataset.action === 'edit') {
    const item = state.wardrobe.find((it) => it.id === id);
    if (!item) return;
    ui.wardrobeId.value = item.id;
    ui.itemName.value = item.name;
    ui.itemCategory.value = item.category;
    ui.itemWarmth.value = String(item.warmth);
    ui.itemWaterproof.checked = !!item.waterproof;
    ui.itemAvailable.checked = item.available !== false;
    ui.wardrobeSubmit.textContent = '保存修改';
    ui.cancelEdit.hidden = false;
    ui.itemName.focus();
  } else if (btn.dataset.action === 'delete') {
    state.wardrobe = state.wardrobe.filter((it) => it.id !== id);
    Storage.set(STORAGE_KEYS.wardrobe, state.wardrobe);
    renderWardrobe();
    updateReadiness();
  }
});

function resetWardrobeForm() {
  ui.wardrobeForm.reset();
  ui.itemAvailable.checked = true;
  ui.wardrobeId.value = '';
  ui.wardrobeSubmit.textContent = '添加衣物';
  ui.cancelEdit.hidden = true;
}

function cryptoId() {
  // 优先用 crypto.randomUUID，回退到时间戳 + 随机
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// 5. 生成 & 结果渲染
// =============================================================================
ui.generateButton.addEventListener('click', () => {
  const start = performance.now();
  const result = generateRecommendation({
    profile: state.profile,
    weather: state.weather,
    wardrobe: state.wardrobe,
  });
  const elapsedMs = performance.now() - start;
  renderResult(result, elapsedMs);
});

function renderResult(result, elapsedMs) {
  const container = ui.result;

  if (result.ok === false && result.errors && result.errors.length > 0) {
    container.innerHTML = `
      <div class="result-errors">
        <h3>暂时无法生成建议</h3>
        <ul>${result.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>
      </div>
    `;
    return;
  }

  const tier = result.tier ? `${result.tier.label}（${result.tier.range.min === -Infinity ? '<0' : result.tier.range.min}~${result.tier.range.max === Infinity ? '∞' : result.tier.range.max}°C）` : '';
  const weather = state.weather;

  const outfitHTML = result.outfit
    .map((o) => `
      <div class="outfit-item">
        <span class="outfit-layer">${escapeHtml(o.layer)}</span>
        <strong>${escapeHtml(o.item.name)}</strong>
        <small>${CATEGORY_LABEL[o.item.category]} · ${WARMTH_LABEL[o.item.warmth]}${o.item.waterproof ? ' · 防雨' : ''}</small>
      </div>
    `)
    .join('');

  const reasonsHTML = result.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  const missingHTML =
    result.missingCategories && result.missingCategories.length > 0
      ? `
        <div class="missing-box">
          <h4>衣橱还缺少这些类别</h4>
          <ul>${result.missingCategories.map((c) => `<li>${CATEGORY_LABEL[c] || c}</li>`).join('')}</ul>
          <p style="margin:8px 0 0;color:#806334;font-size:0.7rem;">当前结果为部分可用组合，建议补全后再生成一次。</p>
        </div>`
      : '';

  const child = state.profile && state.profile.childName ? `给 ${state.profile.childName}` : '今天';

  container.innerHTML = `
    <div class="result-header">
      <div>
        <h3>${escapeHtml(child)}穿什么</h3>
        <p>规则计算耗时 ${elapsedMs.toFixed(1)} ms · 温度分层：${escapeHtml(tier)}</p>
      </div>
      <span class="result-status ${result.ok ? '' : 'incomplete'}">${result.ok ? '完整组合' : '部分组合'}</span>
    </div>

    <div class="weather-summary">
      <span>当前 ${weather.currentTemp}°C</span>
      <span>当日 ${weather.minTemp}°C ~ ${weather.maxTemp}°C</span>
      <span>降水 ${({ none: '无', rain: '有雨', snow: '有雪' })[weather.precipitation]}</span>
      <span>风力 ${({ light: '较小', moderate: '适中', strong: '较强' })[weather.wind]}</span>
    </div>

    <div class="outfit-grid">${outfitHTML}</div>

    ${missingHTML}

    <div class="result-columns">
      <div class="result-section">
        <h4>为什么这样穿</h4>
        <ul>${reasonsHTML}</ul>
      </div>
      <div class="result-section">
        <h4>额外提示</h4>
        <ul>
          <li>室内暖气或空调温度可能与室外不同，进入室内后可酌情脱卸外套。</li>
          <li>孩子活动量大时，出汗较多请及时更换内层衣物。</li>
          <li>本建议不替代专业健康判断，有发热、咳嗽等症状请及时就医。</li>
        </ul>
      </div>
    </div>

    <p class="result-disclaimer">以上建议基于初始温度分层规则生成，仅作一般参考；规则与衣物属性的对应关系仍需结合专业育儿意见审核。</p>
  `;
}

// =============================================================================
// 6. 启动
// =============================================================================
function boot() {
  if (!Storage.available()) {
    ui.storageNotice.hidden = false;
    ui.storageNotice.textContent = '浏览器禁用了本地存储，档案、天气和衣橱无法持久化，刷新后会丢失。';
  }
  loadState();
}

boot();
