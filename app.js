/* ============================================================
   STUDYFLOW – app.js
   AI-powered schedule organizer using Anthropic claude-opus-4-6
   ============================================================ */

'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-opus-4-6';

// Timeline: 7am–10pm = 15 hours
const TIMELINE_START = 7;   // 7am
const TIMELINE_END   = 22;  // 10pm (exclusive label, blocks end at 22:00)
const PX_PER_HOUR    = 64;

// Subject colour palette (auto-assigned by index)
const SUBJECT_COLORS = [
  { bg: '#EDE9FE', fg: '#6D28D9', border: '#DDD6FE' },
  { bg: '#DBEAFE', fg: '#1D4ED8', border: '#BFDBFE' },
  { bg: '#D1FAE5', fg: '#065F46', border: '#A7F3D0' },
  { bg: '#FEF3C7', fg: '#92400E', border: '#FDE68A' },
  { bg: '#FCE7F3', fg: '#9D174D', border: '#FBCFE8' },
  { bg: '#FEE2E2', fg: '#991B1B', border: '#FECACA' },
  { bg: '#E0F2FE', fg: '#075985', border: '#BAE6FD' },
  { bg: '#F0FDF4', fg: '#14532D', border: '#BBF7D0' },
];

// ============================================================
// STATE
// ============================================================
const state = {
  apiKey:          '',
  tasks:           [],      // Task[]
  classes:         [],      // RecurringClass[]
  schedule:        [],      // ScheduleSession[]
  settings:        { workStart: '08:00', workEnd: '22:00' },
  currentView:     'daily',
  currentDate:     new Date(),
  subjectColorMap: {},      // subject -> color index
  _nextColorIdx:   0,
};

// ============================================================
// PERSISTENCE
// ============================================================
function loadState() {
  try {
    state.apiKey   = localStorage.getItem('sf_apiKey')   || '';
    state.tasks    = JSON.parse(localStorage.getItem('sf_tasks')    || '[]');
    state.classes  = JSON.parse(localStorage.getItem('sf_classes')  || '[]');
    state.schedule = JSON.parse(localStorage.getItem('sf_schedule') || '[]');
    const saved    = JSON.parse(localStorage.getItem('sf_settings') || '{}');
    state.settings = { workStart: saved.workStart || '08:00', workEnd: saved.workEnd || '22:00' };
    state.subjectColorMap = JSON.parse(localStorage.getItem('sf_colorMap') || '{}');
    // restore next color index
    state._nextColorIdx = Object.keys(state.subjectColorMap).length;
  } catch(e) { console.warn('loadState error', e); }
}

function saveState() {
  localStorage.setItem('sf_apiKey',   state.apiKey);
  localStorage.setItem('sf_tasks',    JSON.stringify(state.tasks));
  localStorage.setItem('sf_classes',  JSON.stringify(state.classes));
  localStorage.setItem('sf_schedule', JSON.stringify(state.schedule));
  localStorage.setItem('sf_settings', JSON.stringify(state.settings));
  localStorage.setItem('sf_colorMap', JSON.stringify(state.subjectColorMap));
}

// ============================================================
// UTILITIES
// ============================================================
function uuid() {
  return 'sf-' + Math.random().toString(36).slice(2,10) + '-' + Date.now().toString(36);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKey(d) {
  // Returns "YYYY-MM-DD"
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

function todayKey() { return dateKey(new Date()); }

function timeToMinutes(t) {
  // "HH:MM" -> total minutes from midnight
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function formatHour12(h) {
  if (h === 0)  return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function formatTimeRange(start, end) {
  return `${formatTime12(start)} – ${formatTime12(end)}`;
}

function formatTime12(t) {
  const [h, m] = t.split(':').map(Number);
  const suffix = h < 12 ? 'am' : 'pm';
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${pad2(m)}${suffix}`;
}

function formatDateLong(d) {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatDateShort(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function weekStart(d) {
  const r = new Date(d);
  r.setDate(r.getDate() - r.getDay()); // Sunday
  r.setHours(0,0,0,0);
  return r;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}

// Get or assign a color for a subject
function subjectColor(subject) {
  const key = (subject || 'General').toLowerCase().trim();
  if (state.subjectColorMap[key] === undefined) {
    state.subjectColorMap[key] = state._nextColorIdx % SUBJECT_COLORS.length;
    state._nextColorIdx++;
  }
  return SUBJECT_COLORS[state.subjectColorMap[key]];
}

// Day-of-week index from string ("monday" -> 1, "sunday" -> 0)
const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
function dayIndex(name) { return DAY_NAMES.indexOf(name.toLowerCase()); }

// Clamp minutes within timeline range
function clampToTimeline(mins) {
  const start = TIMELINE_START * 60;
  const end   = TIMELINE_END   * 60;
  return Math.min(Math.max(mins, start), end);
}

// ============================================================
// ANTHROPIC API
// ============================================================
async function callClaude(userPrompt) {
  if (!state.apiKey) throw new Error('No API key set.');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key':                              state.apiKey,
      'anthropic-version':                      '2023-06-01',
      'content-type':                           'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 4096,
      thinking:   { type: 'adaptive' },
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }

  const data = await response.json();
  // Find the text block (skip thinking blocks)
  const textBlock = data.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ============================================================
// SCHEDULE GENERATION
// ============================================================
async function generateSchedule(taskIds = null) {
  const tasksToSchedule = taskIds
    ? state.tasks.filter(t => taskIds.includes(t.id) && !t.completed)
    : state.tasks.filter(t => !t.completed);

  if (tasksToSchedule.length === 0) return;

  const now     = new Date();
  const nowKey  = dateKey(now);
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

  // Build date range: today through the furthest due date
  const maxDue = new Date(Math.max(...tasksToSchedule.map(t => new Date(t.dueDate))));
  const dateList = [];
  let d = new Date(now);
  d.setHours(0,0,0,0);
  while (d <= maxDue) {
    dateList.push(dateKey(d));
    d = addDays(d, 1);
  }
  if (dateList.length === 0) dateList.push(nowKey);

  const prompt = buildSchedulePrompt(tasksToSchedule, dateList, now, nowTime);

  const raw = await callClaude(prompt);

  // Extract JSON array from response
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('AI returned an unexpected format. Please try again.');

  let sessions;
  try {
    sessions = JSON.parse(match[0]);
  } catch(e) {
    throw new Error('Could not parse the AI schedule. Please try again.');
  }

  // Validate and stamp IDs
  const validSessions = sessions
    .filter(s => s.taskId && s.date && s.startTime && s.endTime)
    .map(s => ({
      id:        uuid(),
      taskId:    s.taskId,
      taskName:  s.taskName   || (state.tasks.find(t => t.id === s.taskId)?.name) || 'Session',
      subject:   s.subject    || '',
      date:      s.date,
      startTime: s.startTime,
      endTime:   s.endTime,
      duration:  s.duration   || 1,
      priority:  s.priority   || 'medium',
      completed: false,
    }));

  // Remove old sessions for the re-scheduled tasks, keep others
  const keptSessions = taskIds
    ? state.schedule.filter(s => !taskIds.includes(s.taskId))
    : [];

  state.schedule = [...keptSessions, ...validSessions];
  saveState();
}

function buildSchedulePrompt(tasks, dateList, now, nowTime) {
  const classesStr = state.classes.length
    ? JSON.stringify(state.classes.map(c => ({
        name:  c.name,
        days:  c.days,
        start: c.start,
        end:   c.end,
      })), null, 2)
    : 'None';

  const tasksStr = JSON.stringify(tasks.map(t => ({
    id:            t.id,
    name:          t.name,
    subject:       t.subject,
    dueDate:       t.dueDate,
    estimatedTime: t.estimatedTime,
    priority:      t.priority,
  })), null, 2);

  return `You are StudyFlow's AI scheduling engine. Generate an optimal study schedule.

TODAY: ${now.toISOString()}
CURRENT TIME: ${nowTime}
AVAILABLE DATES: ${dateList.join(', ')}

TASKS TO SCHEDULE:
${tasksStr}

RECURRING COMMITMENTS (block these time windows):
${classesStr}
Each recurring commitment repeats every week on the listed days.

SCHEDULING PREFERENCES:
- Work hours: ${state.settings.workStart} to ${state.settings.workEnd}
- Max study load per day: 6 hours
- Session length: 30–90 minutes each

SCHEDULING RULES:
1. Split each task across multiple sessions to cover its full estimatedTime.
2. Never schedule a session after a task's dueDate.
3. Today's sessions must start at or after the current time (${nowTime}).
4. Never overlap any session with recurring commitments.
5. Spread sessions across the available dates — do not pile everything on one day.
6. High priority tasks get earlier slots; low priority can be pushed to later days.
7. Leave at least 15 minutes between sessions.
8. For tasks due within 24 hours, schedule sessions today.
9. Schedule sessions only within work hours: ${state.settings.workStart}–${state.settings.workEnd}.

OUTPUT: Return ONLY a valid JSON array — no explanation, no markdown, no comments.
[
  {
    "taskId": "<id from task>",
    "taskName": "<task name>",
    "subject": "<subject>",
    "priority": "low|medium|high",
    "date": "YYYY-MM-DD",
    "startTime": "HH:MM",
    "endTime": "HH:MM",
    "duration": <decimal hours>
  }
]

Generate the FULL schedule covering ALL provided tasks.`;
}

// ============================================================
// TASK CRUD
// ============================================================
function createTask(data) {
  const task = {
    id:            uuid(),
    name:          data.name.trim(),
    subject:       data.subject.trim() || 'General',
    dueDate:       data.dueDate,
    estimatedTime: parseFloat(data.estimatedTime),
    priority:      data.priority || 'medium',
    completed:     false,
    createdAt:     new Date().toISOString(),
  };
  state.tasks.push(task);
  saveState();
  return task;
}

function updateTask(id, data) {
  const idx = state.tasks.findIndex(t => t.id === id);
  if (idx === -1) return null;
  state.tasks[idx] = { ...state.tasks[idx], ...data };
  saveState();
  return state.tasks[idx];
}

function deleteTask(id) {
  state.tasks    = state.tasks.filter(t => t.id !== id);
  state.schedule = state.schedule.filter(s => s.taskId !== id);
  saveState();
}

function toggleTaskComplete(id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  // Mark all sessions for this task as completed too
  state.schedule.forEach(s => {
    if (s.taskId === id) s.completed = task.completed;
  });
  saveState();
}

// ============================================================
// RECURRING CLASS CRUD
// ============================================================
function createClass(data) {
  const cls = {
    id:    uuid(),
    name:  data.name.trim(),
    days:  data.days,
    start: data.start,
    end:   data.end,
  };
  state.classes.push(cls);
  saveState();
  return cls;
}

function deleteClass(id) {
  state.classes = state.classes.filter(c => c.id !== id);
  saveState();
}

// ============================================================
// SCHEDULE QUERIES
// ============================================================
function sessionsForDay(dateStr) {
  return state.schedule.filter(s => s.date === dateStr);
}

function classesForDay(dateStr) {
  // Convert dateStr to day-of-week name
  const dow = DAY_NAMES[new Date(dateStr + 'T12:00:00').getDay()];
  return state.classes
    .filter(c => c.days.includes(dow))
    .map(c => ({
      id:        'class-' + c.id + '-' + dateStr,
      isClass:   true,
      name:      c.name,
      startTime: c.start,
      endTime:   c.end,
      date:      dateStr,
    }));
}

function allBlocksForDay(dateStr) {
  const sessions = sessionsForDay(dateStr).map(s => ({ ...s, isClass: false }));
  const classes  = classesForDay(dateStr);
  return [...sessions, ...classes].sort((a, b) =>
    timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
}

// ============================================================
// COLOUR HELPER FOR SESSIONS
// ============================================================
function sessionStyle(block) {
  if (block.isClass) return { bg: 'rgba(6,182,212,.15)', fg: '#0E7490', border: 'rgba(6,182,212,.3)' };
  return subjectColor(block.subject);
}

// ============================================================
// VIEW: DAILY
// ============================================================
function renderDailyView() {
  const tl     = document.getElementById('dailyTimeline');
  const dStr   = dateKey(state.currentDate);
  const blocks = allBlocksForDay(dStr);

  tl.innerHTML = '';
  tl.style.position = 'relative';

  const totalHours = TIMELINE_END - TIMELINE_START;
  tl.style.height  = (totalHours * PX_PER_HOUR) + 'px';

  // Hour rows (grid lines + labels)
  for (let h = TIMELINE_START; h < TIMELINE_END; h++) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.style.cssText = `position:absolute;left:0;right:0;top:${(h-TIMELINE_START)*PX_PER_HOUR}px;height:${PX_PER_HOUR}px;display:grid;grid-template-columns:54px 1fr;border-bottom:1px solid var(--border-light);`;

    const lbl = document.createElement('div');
    lbl.className = 'tl-label';
    lbl.textContent = formatHour12(h);

    const slot = document.createElement('div');
    slot.className = 'tl-slot';
    // Half-hour marker
    const half = document.createElement('div');
    half.className = 'tl-half';
    slot.appendChild(half);

    row.appendChild(lbl);
    row.appendChild(slot);
    tl.appendChild(row);
  }

  // Current time line (if today)
  if (sameDay(state.currentDate, new Date())) {
    const now     = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const clamp   = clampToTimeline(nowMins);
    const top     = ((clamp - TIMELINE_START*60) / 60) * PX_PER_HOUR;

    const dot = document.createElement('div');
    dot.className = 'now-dot';
    dot.style.top = (top - 3) + 'px';
    tl.appendChild(dot);

    const line = document.createElement('div');
    line.className = 'now-line';
    line.style.top = top + 'px';
    tl.appendChild(line);
  }

  // Session/class blocks
  blocks.forEach(block => {
    const startMins = timeToMinutes(block.startTime);
    const endMins   = timeToMinutes(block.endTime);
    const clampedS  = Math.max(startMins, TIMELINE_START * 60);
    const clampedE  = Math.min(endMins,   TIMELINE_END   * 60);
    if (clampedS >= clampedE) return;

    const top    = ((clampedS - TIMELINE_START*60) / 60) * PX_PER_HOUR;
    const height = ((clampedE - clampedS) / 60) * PX_PER_HOUR;

    const col = sessionStyle(block);
    const el  = document.createElement('div');
    el.className = 'tl-session' + (block.isClass ? ' is-class' : '') + (block.completed ? ' completed' : '');
    el.style.cssText = `top:${top}px;height:${Math.max(height,22)}px;background:${col.bg};color:${col.fg};border:1px solid ${col.border};left:58px;right:6px;`;

    const nameEl = document.createElement('div');
    nameEl.className = 'tl-session-name';
    nameEl.textContent = block.name + (block.isClass ? ' 📌' : '');

    const timeEl = document.createElement('div');
    timeEl.className = 'tl-session-time';
    timeEl.textContent = formatTimeRange(block.startTime, block.endTime);

    el.appendChild(nameEl);
    if (height > 30) el.appendChild(timeEl);

    if (!block.isClass) {
      el.addEventListener('click', () => openTaskDetail(block.taskId));
    }
    tl.appendChild(el);
  });

  // Due soon panel
  renderDueSoonPanel();
  renderTaskListPanel();
}

function renderDueSoonPanel() {
  const list = document.getElementById('dueSoonList');
  const now  = new Date();
  const tasks = state.tasks
    .filter(t => !t.completed)
    .map(t => ({ ...t, _due: new Date(t.dueDate) }))
    .filter(t => t._due >= now)
    .sort((a,b) => a._due - b._due)
    .slice(0, 6);

  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-small">All clear! 🎉</p>';
    return;
  }

  list.innerHTML = tasks.map(t => {
    const diff = (t._due - now) / (1000*60*60);
    const [badge, cls] = diff < 24  ? ['Urgent!', 'urgent']
                        : diff < 72  ? ['Soon',    'soon']
                        : ['Upcoming', 'upcoming'];
    const col = subjectColor(t.subject);
    return `
      <div class="due-soon-item" onclick="openTaskDetail('${t.id}')" style="border-left:3px solid ${col.fg};">
        <div class="due-soon-meta">
          <div class="due-soon-name">${esc(t.name)}</div>
          <div class="due-soon-date">${formatDateShort(t._due)} • ${t.estimatedTime}h</div>
        </div>
        <span class="due-badge ${cls}">${badge}</span>
      </div>`;
  }).join('');
}

function renderTaskListPanel() {
  const list = document.getElementById('taskListSidebar');
  if (!list) return;
  const tasks = [...state.tasks].sort((a,b) => {
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });

  if (tasks.length === 0) {
    list.innerHTML = '<p class="empty-small">No tasks yet.</p>';
    return;
  }

  list.innerHTML = tasks.map(t => {
    const col = subjectColor(t.subject);
    return `
      <div class="task-item ${t.completed ? 'completed-task' : ''}" onclick="openTaskDetail('${t.id}')">
        <div class="task-check ${t.completed ? 'checked' : ''}" onclick="event.stopPropagation();handleToggleComplete('${t.id}')">
          ${t.completed ? '✓' : ''}
        </div>
        <div class="task-item-info">
          <div class="task-item-name" style="color:${col.fg}">${esc(t.name)}</div>
          <div class="task-item-sub">${esc(t.subject)} • due ${formatDateShort(new Date(t.dueDate))}</div>
        </div>
        <span class="priority-tag ${t.priority}">${t.priority}</span>
      </div>`;
  }).join('');
}

// ============================================================
// VIEW: WEEKLY
// ============================================================
function renderWeeklyView() {
  const grid = document.getElementById('weeklyGrid');
  const ws   = weekStart(state.currentDate);
  const today = todayKey();

  grid.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const day    = addDays(ws, i);
    const dStr   = dateKey(day);
    const blocks = allBlocksForDay(dStr);
    const isToday = dStr === today;

    const col = document.createElement('div');
    col.className = 'weekly-day-col';

    const hdr = document.createElement('div');
    hdr.className = `weekly-day-header${isToday ? ' today' : ''}`;
    hdr.innerHTML = `
      <div class="weekly-day-name">${day.toLocaleDateString('en-US',{weekday:'short'})}</div>
      <div class="weekly-day-num">${day.getDate()}</div>`;

    const sessions = document.createElement('div');
    sessions.className = 'weekly-sessions';

    if (blocks.length === 0) {
      sessions.innerHTML = '<div class="empty-day">Free day</div>';
    } else {
      blocks.forEach(block => {
        const col2 = sessionStyle(block);
        const card = document.createElement('div');
        card.className = `weekly-session-card${block.isClass ? ' is-class' : ''}${block.completed ? ' completed' : ''}`;
        card.style.cssText = `background:${col2.bg};color:${col2.fg};border:1px solid ${col2.border}`;
        card.innerHTML = `
          <div class="weekly-session-name">${esc(block.name)}</div>
          <div class="weekly-session-time">${formatTimeRange(block.startTime, block.endTime)}</div>`;
        if (!block.isClass) {
          card.addEventListener('click', () => openTaskDetail(block.taskId));
        }
        sessions.appendChild(card);
      });
    }

    col.appendChild(hdr);
    col.appendChild(sessions);
    grid.appendChild(col);
  }
}

// ============================================================
// VIEW: MONTHLY
// ============================================================
function renderMonthlyView() {
  const grid  = document.getElementById('monthlyGrid');
  const year  = state.currentDate.getFullYear();
  const month = state.currentDate.getMonth();
  const today = todayKey();

  // First day of month and padding
  const firstDay = new Date(year, month, 1);
  const lastDay  = new Date(year, month+1, 0);
  const startDOW = firstDay.getDay(); // 0=Sun

  grid.innerHTML = '';

  // Build cells: padding + days + trailing
  const totalCells = Math.ceil((startDOW + lastDay.getDate()) / 7) * 7;

  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(year, month, 1 - startDOW + i);
    const dStr     = dateKey(cellDate);
    const isMonth  = cellDate.getMonth() === month;
    const isToday  = dStr === today;

    const blocks   = allBlocksForDay(dStr);
    // Tasks due on this day
    const dueToday = state.tasks.filter(t => {
      const td = new Date(t.dueDate);
      return !t.completed && dateKey(td) === dStr;
    });

    const cell = document.createElement('div');
    cell.className = `month-cell${!isMonth ? ' other-month' : ''}${isToday ? ' today-cell' : ''}`;
    cell.addEventListener('click', () => {
      state.currentDate = cellDate;
      switchView('daily');
    });

    const numEl = document.createElement('div');
    numEl.className = 'month-date-num';
    numEl.textContent = cellDate.getDate();
    cell.appendChild(numEl);

    // Show up to 3 sessions as pills
    const pillsDiv = document.createElement('div');
    pillsDiv.className = 'month-sessions';
    const maxShow = 3;
    blocks.slice(0, maxShow).forEach(block => {
      const col2 = sessionStyle(block);
      const pill = document.createElement('div');
      pill.className = `month-session-pill${block.isClass ? ' is-class' : ''}`;
      pill.style.cssText = `background:${col2.bg};color:${col2.fg}`;
      pill.textContent = block.name;
      pillsDiv.appendChild(pill);
    });
    if (blocks.length > maxShow) {
      const more = document.createElement('div');
      more.className = 'month-more';
      more.textContent = `+${blocks.length - maxShow} more`;
      pillsDiv.appendChild(more);
    }
    // Due date markers
    dueToday.slice(0, 2).forEach(t => {
      const dm = document.createElement('div');
      dm.className = 'due-marker';
      dm.textContent = '📅 ' + t.name;
      pillsDiv.appendChild(dm);
    });
    cell.appendChild(pillsDiv);
    grid.appendChild(cell);
  }
}

// ============================================================
// VIEW: SIDEBAR STATS
// ============================================================
function renderSidebar() {
  const total    = state.tasks.length;
  const done     = state.tasks.filter(t => t.completed).length;
  const today    = sessionsForDay(todayKey()).length;
  const now      = new Date();
  const urgent   = state.tasks.filter(t =>
    !t.completed && (new Date(t.dueDate) - now) < 24*60*60*1000 &&
    new Date(t.dueDate) >= now
  ).length;

  document.getElementById('statTotal').textContent  = total;
  document.getElementById('statToday').textContent  = today;
  document.getElementById('statUrgent').textContent = urgent;
  document.getElementById('statDone').textContent   = done;

  // Upcoming list
  const ul = document.getElementById('upcomingList');
  const upcoming = state.tasks
    .filter(t => !t.completed && new Date(t.dueDate) >= now)
    .sort((a,b) => new Date(a.dueDate) - new Date(b.dueDate))
    .slice(0, 6);

  if (upcoming.length === 0) {
    ul.innerHTML = '<p class="empty-small">No tasks yet. Add one!</p>';
    return;
  }

  ul.innerHTML = upcoming.map(t => {
    const diff = (new Date(t.dueDate) - now) / (1000*60*60*24);
    const dueStr = diff < 1 ? 'Due today' : diff < 2 ? 'Due tomorrow' : `Due ${formatDateShort(new Date(t.dueDate))}`;
    return `
      <div class="upcoming-item" onclick="openTaskDetail('${t.id}')">
        <div class="upcoming-item-name">${esc(t.name)}</div>
        <div class="upcoming-item-meta">
          <span class="priority-dot ${t.priority}"></span>
          <span>${dueStr} • ${t.estimatedTime}h</span>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
// NAV LABEL
// ============================================================
function updateNavLabel() {
  const lbl = document.getElementById('dateNavLabel');
  if (state.currentView === 'daily') {
    lbl.textContent = formatDateLong(state.currentDate);
  } else if (state.currentView === 'weekly') {
    const ws = weekStart(state.currentDate);
    const we = addDays(ws, 6);
    lbl.textContent = `${formatDateShort(ws)} – ${formatDateShort(we)}`;
  } else {
    lbl.textContent = state.currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
}

// ============================================================
// FULL RENDER
// ============================================================
function renderAll() {
  updateNavLabel();
  renderSidebar();
  if (state.currentView === 'daily')   renderDailyView();
  if (state.currentView === 'weekly')  renderWeeklyView();
  if (state.currentView === 'monthly') renderMonthlyView();
}

// ============================================================
// SWITCH VIEW
// ============================================================
function switchView(view) {
  state.currentView = view;
  // Update nav buttons
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  // Show/hide views
  document.getElementById('dailyView').classList.toggle('active-view', view === 'daily');
  document.getElementById('dailyView').classList.toggle('hidden', view !== 'daily');
  document.getElementById('weeklyView').classList.toggle('hidden', view !== 'weekly');
  document.getElementById('monthlyView').classList.toggle('hidden', view !== 'monthly');

  // Update topbar title
  const titles = { daily: "Today's Schedule", weekly: 'Weekly View', monthly: 'Monthly View' };
  document.getElementById('viewTitle').textContent = titles[view] || '';

  renderAll();
}

// ============================================================
// MODALS
// ============================================================
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// Clicking backdrop closes modal
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    const id = e.target.id;
    if (id !== 'apiKeyModal') closeModal(id);
  }
});

// Close button handler
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-close]');
  if (btn) closeModal(btn.dataset.close);
});

// ============================================================
// TASK FORM
// ============================================================
function openAddTaskModal(taskId = null) {
  const form = document.getElementById('taskForm');
  form.reset();
  document.getElementById('taskModalTitle').textContent = taskId ? 'Edit Task' : 'New Task';
  document.getElementById('editTaskId').value = taskId || '';
  document.getElementById('taskFormError').classList.add('hidden');

  // Default due = tomorrow at 23:59
  const def = new Date();
  def.setDate(def.getDate() + 1);
  def.setHours(23, 59, 0, 0);
  document.getElementById('fTaskDue').value = def.toISOString().slice(0,16);

  if (taskId) {
    const t = state.tasks.find(x => x.id === taskId);
    if (t) {
      document.getElementById('fTaskName').value     = t.name;
      document.getElementById('fTaskSubject').value  = t.subject;
      document.getElementById('fTaskPriority').value = t.priority;
      document.getElementById('fTaskDue').value      = new Date(t.dueDate).toISOString().slice(0,16);
      document.getElementById('fTaskHours').value    = t.estimatedTime;
    }
  }
  openModal('addTaskModal');
}

document.getElementById('taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const errEl = document.getElementById('taskFormError');
  errEl.classList.add('hidden');

  const name    = document.getElementById('fTaskName').value.trim();
  const subject = document.getElementById('fTaskSubject').value.trim();
  const due     = document.getElementById('fTaskDue').value;
  const hours   = parseFloat(document.getElementById('fTaskHours').value);
  const priority= document.getElementById('fTaskPriority').value;
  const editId  = document.getElementById('editTaskId').value;

  if (!name || !due || !hours) {
    errEl.textContent = 'Please fill in all required fields.';
    errEl.classList.remove('hidden');
    return;
  }
  if (hours <= 0 || hours > 200) {
    errEl.textContent = 'Estimated time must be between 0.25 and 200 hours.';
    errEl.classList.remove('hidden');
    return;
  }
  if (new Date(due) < new Date()) {
    errEl.textContent = 'Due date must be in the future.';
    errEl.classList.remove('hidden');
    return;
  }

  closeModal('addTaskModal');
  showLoading(true, `Scheduling "${name}" with AI…`);

  try {
    let task;
    if (editId) {
      task = updateTask(editId, { name, subject: subject||'General', dueDate: due, estimatedTime: hours, priority });
      // Remove old sessions for this task before re-scheduling
      state.schedule = state.schedule.filter(s => s.taskId !== editId);
    } else {
      task = createTask({ name, subject: subject||'General', dueDate: due, estimatedTime: hours, priority });
    }

    await generateSchedule([task.id]);
    showToast(`"${name}" scheduled successfully! ✨`, 'success');
  } catch(err) {
    showToast('AI scheduling failed: ' + err.message, 'error');
  } finally {
    showLoading(false);
    renderAll();
  }
});

// ============================================================
// TASK DETAIL MODAL
// ============================================================
function openTaskDetail(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;

  document.getElementById('detailTaskName').textContent = task.name;

  const col = subjectColor(task.subject);
  const due = new Date(task.dueDate);
  const now = new Date();
  const diff = Math.round((due - now) / (1000*60*60));
  const dueStr = diff < 0   ? `Overdue by ${Math.abs(diff)}h`
               : diff < 24  ? `Due in ${diff}h`
               : diff < 48  ? 'Due tomorrow'
               : `Due ${formatDateLong(due)}`;

  document.getElementById('taskDetailBody').innerHTML = `
    <div class="task-detail-row">
      <span class="task-detail-label">Subject</span>
      <span class="task-detail-val" style="color:${col.fg};font-weight:600">${esc(task.subject)}</span>
    </div>
    <div class="task-detail-row">
      <span class="task-detail-label">Priority</span>
      <span class="task-detail-val"><span class="priority-tag ${task.priority}">${task.priority}</span></span>
    </div>
    <div class="task-detail-row">
      <span class="task-detail-label">Due Date</span>
      <span class="task-detail-val">${esc(dueStr)}</span>
    </div>
    <div class="task-detail-row">
      <span class="task-detail-label">Estimated Time</span>
      <span class="task-detail-val">${task.estimatedTime} hours</span>
    </div>
    <div class="task-detail-row">
      <span class="task-detail-label">Status</span>
      <span class="task-detail-val">${task.completed ? '✅ Completed' : '⏳ In progress'}</span>
    </div>`;

  // Sessions
  const sessions = state.schedule.filter(s => s.taskId === taskId)
    .sort((a,b) => a.date.localeCompare(b.date) || timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  const sessDiv = document.getElementById('taskDetailSessions');
  if (sessions.length === 0) {
    sessDiv.innerHTML = '<p class="empty-small">No sessions scheduled yet.</p>';
  } else {
    sessDiv.innerHTML = sessions.map(s => `
      <div class="session-detail-item" style="border-left:3px solid ${col.fg}">
        <span class="session-detail-date">${s.date}</span>
        <span class="session-detail-time">${formatTimeRange(s.startTime, s.endTime)} (${s.duration}h)</span>
        ${s.completed ? '<span style="color:var(--success);font-weight:600">✓</span>' : ''}
      </div>`).join('');
  }

  // Buttons
  document.getElementById('detailCompleteBtn').textContent = task.completed ? '↩ Mark Incomplete' : '✓ Mark Complete';
  document.getElementById('detailCompleteBtn').onclick = () => {
    handleToggleComplete(taskId);
    closeModal('taskDetailModal');
  };
  document.getElementById('detailEditBtn').onclick = () => {
    closeModal('taskDetailModal');
    openAddTaskModal(taskId);
  };
  document.getElementById('detailDeleteBtn').onclick = () => {
    if (confirm(`Delete "${task.name}"?`)) {
      deleteTask(taskId);
      closeModal('taskDetailModal');
      renderAll();
      showToast('Task deleted.', 'success');
    }
  };

  openModal('taskDetailModal');
}

function handleToggleComplete(taskId) {
  toggleTaskComplete(taskId);
  renderAll();
  const task = state.tasks.find(t => t.id === taskId);
  if (task) showToast(task.completed ? `"${task.name}" marked complete! 🎉` : `"${task.name}" marked incomplete.`, 'success');
}
// Expose to inline handlers
window.openTaskDetail   = openTaskDetail;
window.handleToggleComplete = handleToggleComplete;

// ============================================================
// SETTINGS MODAL
// ============================================================
function openSettingsModal() {
  // Pre-fill work hours
  document.getElementById('fWorkStart').value = state.settings.workStart;
  document.getElementById('fWorkEnd').value   = state.settings.workEnd;
  renderClassesList();
  openModal('settingsModal');
}

function renderClassesList() {
  const list = document.getElementById('classesList');
  if (state.classes.length === 0) {
    list.innerHTML = '<p class="empty-small">No commitments added.</p>';
    return;
  }
  list.innerHTML = state.classes.map((c, i) => {
    const col2 = SUBJECT_COLORS[i % SUBJECT_COLORS.length];
    const daysStr = c.days.map(d => d.slice(0,3).charAt(0).toUpperCase() + d.slice(1,3)).join(', ');
    return `
      <div class="class-item">
        <div class="class-color-dot" style="background:${col2.fg}"></div>
        <div class="class-info">
          <div class="class-name">${esc(c.name)}</div>
          <div class="class-meta">${daysStr} • ${formatTime12(c.start)} – ${formatTime12(c.end)}</div>
        </div>
        <button class="class-delete" onclick="handleDeleteClass('${c.id}')">✕</button>
      </div>`;
  }).join('');
}

document.getElementById('classForm').addEventListener('submit', e => {
  e.preventDefault();
  const errEl  = document.getElementById('classFormError');
  errEl.classList.add('hidden');

  const name  = document.getElementById('fClassName').value.trim();
  const start = document.getElementById('fClassStart').value;
  const end   = document.getElementById('fClassEnd').value;
  const days  = [...document.querySelectorAll('#settingsModal .settings-days-picker input:checked')].map(i => i.value);

  if (!name) { errEl.textContent = 'Please enter a name.'; errEl.classList.remove('hidden'); return; }
  if (days.length === 0) { errEl.textContent = 'Select at least one day.'; errEl.classList.remove('hidden'); return; }
  if (timeToMinutes(start) >= timeToMinutes(end)) { errEl.textContent = 'End time must be after start time.'; errEl.classList.remove('hidden'); return; }

  createClass({ name, days, start, end });
  document.getElementById('classForm').reset();
  document.getElementById('fClassStart').value = '15:00';
  document.getElementById('fClassEnd').value   = '16:00';
  renderClassesList();
  showToast(`"${name}" added to schedule.`, 'success');
});

function handleDeleteClass(id) {
  deleteClass(id);
  renderClassesList();
  showToast('Commitment removed.', 'success');
}
window.handleDeleteClass = handleDeleteClass;

// ============================================================
// ADD CLASS MODAL
// ============================================================

// Preset day sets
const DAY_PRESETS = {
  everyday: ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'],
  weekdays: ['monday','tuesday','wednesday','thursday','friday'],
  weekends: ['saturday','sunday'],
};

function applyDayPreset(preset, pickerSelector) {
  const values = DAY_PRESETS[preset] || [];
  document.querySelectorAll(`${pickerSelector} input[type=checkbox]`).forEach(cb => {
    cb.checked = values.includes(cb.value);
  });
}

function openAddClassModal() {
  document.getElementById('addClassForm').reset();
  document.getElementById('acStart').value = '08:25';
  document.getElementById('acEnd').value   = '15:15';
  document.getElementById('addClassError').classList.add('hidden');
  // Clear all preset active states
  document.querySelectorAll('#addClassModal .preset-btn').forEach(b => b.classList.remove('active'));
  openModal('addClassModal');
}

// Delegated handler for ALL preset buttons (both modals)
document.addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn');
  if (!btn) return;
  const preset = btn.dataset.preset;
  const target = btn.dataset.target; // "settings" or undefined (= addClassModal)

  if (target === 'settings') {
    applyDayPreset(preset, '#settingsModal .settings-days-picker');
    // Visual active state in Settings
    document.querySelectorAll('#settingsModal .preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  } else {
    applyDayPreset(preset, '#addClassModal .ac-days-picker');
    // Visual active state in Add Class modal
    document.querySelectorAll('#addClassModal .preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
});

// Individual chip click clears active preset highlight
document.addEventListener('change', e => {
  if (e.target.closest('#addClassModal .ac-days-picker')) {
    document.querySelectorAll('#addClassModal .preset-btn').forEach(b => b.classList.remove('active'));
  }
  if (e.target.closest('#settingsModal .settings-days-picker')) {
    document.querySelectorAll('#settingsModal .preset-btn').forEach(b => b.classList.remove('active'));
  }
});

// Add Class form submit
document.getElementById('addClassForm').addEventListener('submit', e => {
  e.preventDefault();
  const errEl = document.getElementById('addClassError');
  errEl.classList.add('hidden');

  const name  = document.getElementById('acName').value.trim();
  const start = document.getElementById('acStart').value;
  const end   = document.getElementById('acEnd').value;
  const days  = [...document.querySelectorAll('#addClassModal .ac-days-picker input:checked')].map(i => i.value);

  if (!name)              { errEl.textContent = 'Please enter a class name.'; errEl.classList.remove('hidden'); return; }
  if (days.length === 0)  { errEl.textContent = 'Select at least one day.';   errEl.classList.remove('hidden'); return; }
  if (timeToMinutes(start) >= timeToMinutes(end)) {
    errEl.textContent = 'End time must be after start time.';
    errEl.classList.remove('hidden');
    return;
  }

  createClass({ name, days, start, end });
  closeModal('addClassModal');
  const daysLabel = days.length === 7 ? 'every day'
    : days.length === 5 && !days.includes('saturday') && !days.includes('sunday') ? 'weekdays'
    : days.map(d => d.slice(0,3).charAt(0).toUpperCase() + d.slice(1,3)).join(', ');
  showToast(`"${name}" blocked ${daysLabel} ${formatTime12(start)}–${formatTime12(end)} ✅`, 'success');
  renderAll();
});

document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  state.settings.workStart = document.getElementById('fWorkStart').value;
  state.settings.workEnd   = document.getElementById('fWorkEnd').value;
  saveState();
  closeModal('settingsModal');
  showToast('Settings saved.', 'success');
  renderAll();
});

// ============================================================
// LOADING
// ============================================================
function showLoading(show, msg = 'Working…') {
  const ol = document.getElementById('loadingOverlay');
  if (show) {
    document.getElementById('loadingMsg').textContent = msg;
    ol.classList.remove('hidden');
  } else {
    ol.classList.add('hidden');
  }
}

// ============================================================
// TOAST
// ============================================================
let _toastTimer = null;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  document.getElementById('toastMsg').textContent = msg;
  t.className = `toast${type ? ' '+type : ''}`;
  t.classList.remove('hidden');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ============================================================
// ESCAPE
// ============================================================
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ============================================================
// API KEY MANAGEMENT
// ============================================================
function showApiKeyModal() {
  document.getElementById('apiKeyInput').value = '';
  document.getElementById('apiKeyError').classList.add('hidden');
  document.getElementById('apiKeyModal').style.display = 'flex';
}

function hideApiKeyModal() {
  document.getElementById('apiKeyModal').style.display = 'none';
}

document.getElementById('saveApiKeyBtn').addEventListener('click', () => {
  const key = document.getElementById('apiKeyInput').value.trim();
  const errEl = document.getElementById('apiKeyError');
  if (!key.startsWith('sk-ant-')) {
    errEl.textContent = 'Invalid API key format. It should start with "sk-ant-".';
    errEl.classList.remove('hidden');
    return;
  }
  state.apiKey = key;
  saveState();
  hideApiKeyModal();
  document.getElementById('app').classList.remove('hidden');
  renderAll();
});

document.getElementById('changeKeyBtn').addEventListener('click', showApiKeyModal);

// ============================================================
// EVENT LISTENERS
// ============================================================

// Nav
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Add Task
document.getElementById('addTaskBtn').addEventListener('click', () => openAddTaskModal());

// Add Class
document.getElementById('addClassBtn').addEventListener('click', openAddClassModal);

// Settings
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);

// Prev / Next / Today
document.getElementById('prevBtn').addEventListener('click', () => {
  if (state.currentView === 'daily') {
    state.currentDate = addDays(state.currentDate, -1);
  } else if (state.currentView === 'weekly') {
    state.currentDate = addDays(state.currentDate, -7);
  } else {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth()-1, 1);
  }
  renderAll();
});

document.getElementById('nextBtn').addEventListener('click', () => {
  if (state.currentView === 'daily') {
    state.currentDate = addDays(state.currentDate, 1);
  } else if (state.currentView === 'weekly') {
    state.currentDate = addDays(state.currentDate, 7);
  } else {
    state.currentDate = new Date(state.currentDate.getFullYear(), state.currentDate.getMonth()+1, 1);
  }
  renderAll();
});

document.getElementById('todayBtn').addEventListener('click', () => {
  state.currentDate = new Date();
  renderAll();
});

// Regenerate entire schedule
document.getElementById('regenerateBtn').addEventListener('click', async () => {
  if (state.tasks.filter(t => !t.completed).length === 0) {
    showToast('No incomplete tasks to schedule.', 'warning');
    return;
  }
  showLoading(true, 'Regenerating full schedule with AI…');
  try {
    state.schedule = [];
    await generateSchedule();
    showToast('Schedule regenerated! ✨', 'success');
  } catch(err) {
    showToast('Regeneration failed: ' + err.message, 'error');
  } finally {
    showLoading(false);
    renderAll();
  }
});

// Update "now" line every minute
setInterval(() => {
  if (state.currentView === 'daily' && sameDay(state.currentDate, new Date())) {
    renderDailyView();
  }
}, 60 * 1000);

// ============================================================
// INIT
// ============================================================
function init() {
  loadState();

  if (state.apiKey) {
    hideApiKeyModal();
    document.getElementById('app').classList.remove('hidden');
    renderAll();
  } else {
    showApiKeyModal();
  }

  // Set today as default date
  state.currentDate = new Date();
}

init();
