import { supabase, configured } from './supabase.js';
import './style.css';
import './profile-reviews.css';
import './ora-search.css';
import './features.css';
import logoMark from './galbui.png';

const SUBJECTS = ['Romanian language and literature','Mathematics','Physics','Chemistry','Biology','History','Geography','Computer science','ICT','English','French','German','Spanish','Latin','Logic','Psychology','Philosophy','Economics','Social education','Art','Music','Physical education','Religion','Technology','Natural sciences','Entrepreneurship'];
const LEVELS = ['Middle school','High school','University'];
const COUNTIES = ['București','Cluj','Iași','Brașov','Timiș','Constanța','Sibiu','Arad','Alba','Bihor','Prahova'];
const STORAGE_KEY = 'stup-local-state-v1';

const state = {
  session: null,
  profile: null,
  people: [],
  reviews: [],
  reviewsLoadError: '',
  chats: [],
  favorites: [],
  onlineUsers: new Set(),
  localUsers: [],
  view: 'discover',
  searchMode: 'subject',
  searchSubmitted: false,
  search: '',
  aiSearchResult: null,
  aiSearchError: '',
  aiSearchPending: false,
  filterSubject: 'Mathematics',
  minRating: 7,
  activeChatId: null,
  inboxListOpen: true
};

const DEFAULT_SESSIONS = 3;
const BLOCKED_COMMENT_WORDS = /(?:idiot|stupid|hate you|prost|tâmpit|fuck|shit)/i;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function highlightSubject(text, subject) {
  const value = String(text || '');
  if (!subject) return escapeHtml(value);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}])`, 'giu');
  return value.split(pattern).map((part) => part.toLocaleLowerCase() === subject.toLocaleLowerCase()
    ? `<mark class="search-subject-text">${escapeHtml(part)}</mark>`
    : escapeHtml(part)).join('');
}

function readLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state.localUsers = Array.isArray(parsed.localUsers) ? parsed.localUsers : [];
    state.reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    state.chats = Array.isArray(parsed.chats)
      ? parsed.chats.map((chat) => ({ ...chat, status: chat.status === 'declined' ? 'declined' : 'active' }))
      : [];
    state.favorites = Array.isArray(parsed.favorites) ? parsed.favorites : [];
    state.profile = parsed.profile || null;
    if (state.profile && state.profile.lumen_balance == null) state.profile.lumen_balance = DEFAULT_SESSIONS;
    state.view = parsed.view || 'discover';
    state.searchMode = parsed.searchMode || 'subject';
    state.searchSubmitted = Boolean(parsed.searchSubmitted);
    state.search = parsed.search || '';
    state.aiSearchResult = parsed.aiSearchResult
      && SUBJECTS.includes(parsed.aiSearchResult.subject)
      && typeof parsed.aiSearchResult.message === 'string'
      && Array.isArray(parsed.aiSearchResult.searchTerms)
      ? parsed.aiSearchResult
      : null;
    state.filterSubject = parsed.filterSubject || 'Mathematics';
    state.minRating = Number(parsed.minRating || 7);
    state.activeChatId = parsed.activeChatId || null;
  } catch {
    state.localUsers = [];
    state.reviews = [];
    state.chats = [];
    state.favorites = [];
    state.profile = null;
  }
}

function saveLocalState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    localUsers: state.localUsers,
    reviews: state.reviews,
    chats: state.chats,
    favorites: state.favorites,
    profile: state.profile,
    view: state.view,
    searchMode: state.searchMode,
    searchSubmitted: state.searchSubmitted,
    search: state.search,
    aiSearchResult: state.aiSearchResult,
    filterSubject: state.filterSubject,
    minRating: state.minRating,
    activeChatId: state.activeChatId
  }));
}

function levelName(level) {
  return LEVELS[Number(level)] || 'High school';
}

function ratingValue(profile, subject) {
  if (!profile || !profile.subject_ratings) return 0;
  return Number(profile.subject_ratings[subject] || 0);
}

function subjectTags(profile, limit = 5) {
  return SUBJECTS.map((subject) => ({ subject, rating: ratingValue(profile, subject) }))
    .filter((entry) => entry.rating > 0)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, limit);
}

function initials(name = '?') {
  return String(name).trim().charAt(0).toUpperCase() || '?';
}

function topSubject(profile) {
  const list = subjectTags(profile, 1);
  return list[0] ? list[0].subject : 'Mathematics';
}

function toast(message) {
  const el = document.querySelector('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3000);
}

function getPersonById(id) {
  return (state.profile?.id === id ? state.profile : null)
    || state.people.find((person) => person.id === id)
    || state.localUsers.find((person) => person.id === id)
    || null;
}

function isFavorite(profileId) {
  return state.favorites.includes(profileId);
}

async function toggleFavorite(profileId) {
  const wasFavorite = isFavorite(profileId);
  state.favorites = wasFavorite
    ? state.favorites.filter((id) => id !== profileId)
    : [...state.favorites, profileId];
  saveLocalState();

  if (configured && supabase && state.session?.user) {
    const result = wasFavorite
      ? await supabase.from('favorite_profiles').delete().match({ user_id: state.profile.id, favorite_profile_id: profileId })
      : await supabase.from('favorite_profiles').insert({ user_id: state.profile.id, favorite_profile_id: profileId });
    if (result.error) toast(result.error.message || 'Could not update favorites.');
  }
  renderDiscover();
}

function avatarMarkup(person, className = '') {
  const photoUrl = person?.profile_photo_url || '';
  return `<div class="avatar ${photoUrl ? 'has-photo' : ''} ${className}">${photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="" />` : escapeHtml(initials(person?.display_name || 'S'))}</div>`;
}

function isPersonActive(personId) {
  return state.onlineUsers.has(personId);
}

function messageMarkup(text) {
  return escapeHtml(text).replace(/(https:\/\/meet\.google\.com\/new)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function completedSessionCount(userId) {
  return state.chats.filter((chat) => chat.participants.includes(userId) && chat.session?.completed).length;
}

function sessionBalance(profile = state.profile) {
  return Number(profile?.lumen_balance ?? DEFAULT_SESSIONS);
}

function updateLocalProfile(profile) {
  state.profile = { ...state.profile, ...profile };
  const index = state.localUsers.findIndex((person) => person.id === state.profile.id);
  if (index >= 0) state.localUsers[index] = { ...state.profile };
}

async function saveSessionBalance(profile) {
  if (configured && supabase && state.session?.user) {
    const { error } = await supabase.from('profiles').update({ lumen_balance: sessionBalance(profile) }).eq('id', profile.id);
    if (error) throw error;
  }
  updateLocalProfile(profile);
  saveLocalState();
}

function reviewsForProfile(profileId) {
  return state.reviews.filter((review) => review.targetProfileId === profileId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function reviewSummary(profileId) {
  const reviews = reviewsForProfile(profileId);
  const average = reviews.length
    ? reviews.reduce((sum, review) => sum + Number(review.rating), 0) / reviews.length
    : 0;
  return { average, count: reviews.length };
}

function reviewForSession(chatId, reviewerId) {
  return state.reviews.find((review) => review.sessionId === chatId && review.reviewerId === reviewerId);
}

function shell(content) {
  const nav = state.profile ? `
    <header class="top">
      <div class="topinner">
        <div class="brand-lockup"><img class="brand-mark" src="${logoMark}" alt="" /><div class="logo">stup</div></div>
        <nav class="app-nav">
          <button class="${state.view === 'discover' ? 'active' : ''}" data-view="discover">Discover</button>
          <button class="${state.view === 'inbox' ? 'active' : ''}" data-view="inbox">Inbox</button>
          <button class="${state.view === 'settings' ? 'active' : ''}" data-view="settings">Settings</button>
        </nav>
        <span class="credit" title="Sessions are your available session balance">✦ ${sessionBalance()} Sessions</span>
      </div>
    </header>
  ` : '';

  document.querySelector('#app').innerHTML = `${nav}<main class="wrap">${content}</main><div id="toast" class="toast" role="status"></div>`;

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      if (state.view === 'inbox') state.inboxListOpen = true;
      saveLocalState();
      render();
    });
  });
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the student ID file.'));
    reader.readAsDataURL(file);
  });
}

async function uploadStudentPhoto(file) {
  if (!file) return '';
  if (configured && supabase) {
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `student-ids/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('student-ids').upload(path, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || 'image/jpeg'
      });
      if (!error) {
        const { data } = supabase.storage.from('student-ids').getPublicUrl(path);
        return data.publicUrl;
      }
    } catch {
      // fall back below
    }
  }
  return await readDataUrl(file);
}

async function uploadProfilePhoto(file, userId) {
  if (!configured || !supabase) return await readDataUrl(file);
  const extension = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${userId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage.from('profile-photos').upload(path, file, {
    cacheControl: '0',
    upsert: false,
    contentType: file.type
  });
  if (error) throw error;
  const { data } = supabase.storage.from('profile-photos').getPublicUrl(path);
  return data.publicUrl;
}

async function fetchPeople() {
  if (configured && supabase) {
    const { data, error } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (!error) {
      state.people = (data || []).filter((person) => person.id !== state.profile?.id);
      return;
    }
  }

  const localCurrentId = state.profile?.id || null;
  state.people = state.localUsers.filter((person) => person.id !== localCurrentId);
}

async function fetchReviews() {
  if (!configured || !supabase || !state.session?.user) return;

  const { data, error } = await supabase.from('profile_reviews')
    .select('id,target_profile_id,reviewer_profile_id,session_id,rating,comment,created_at')
    .order('created_at', { ascending: false });
  if (error) {
    state.reviewsLoadError = error.message;
    return;
  }

  state.reviewsLoadError = '';
  state.reviews = (data || []).map((review) => ({
    id: review.id,
    targetProfileId: review.target_profile_id,
    reviewerId: review.reviewer_profile_id,
    sessionId: review.session_id,
    rating: Number(review.rating),
    comment: review.comment,
    createdAt: review.created_at
  }));
}

async function fetchConversations() {
  if (!configured || !supabase || !state.session?.user) return;
  const { data: memberships, error } = await supabase.from('conversation_members')
    .select('conversation_id,user_id').eq('user_id', state.session.user.id);
  if (error || !memberships?.length) return;
  const ids = memberships.map((row) => row.conversation_id);
  const [{ data: allMembers }, { data: messages }] = await Promise.all([
    supabase.from('conversation_members').select('conversation_id,user_id').in('conversation_id', ids),
    supabase.from('messages').select('conversation_id,sender_id,body,created_at').in('conversation_id', ids).order('created_at')
  ]);
  state.chats = ids.map((id) => {
    const participants = (allMembers || []).filter((row) => row.conversation_id === id).map((row) => row.user_id);
    const remoteMessages = (messages || []).filter((row) => row.conversation_id === id);
    return { id, participants, status: 'active', requesterId: state.session.user.id,
      messages: remoteMessages.map((row) => ({ sender: row.sender_id, text: row.body })),
      lastUpdated: remoteMessages.at(-1)?.created_at || Date.now(),
      session: { date: '', method: 'online', completed: false } };
  });
  saveLocalState();
}

async function fetchFavorites() {
  if (!configured || !supabase || !state.session?.user) return;
  const { data, error } = await supabase.from('favorite_profiles').select('favorite_profile_id').eq('user_id', state.profile.id);
  if (!error) {
    state.favorites = (data || []).map((row) => row.favorite_profile_id);
    saveLocalState();
  }
}

function searchTokens(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().match(/[\p{L}\p{N}+#]+/gu)?.filter((token) => token.length > 2) || [];
}

const SUBJECT_HINTS = {
  Mathematics: ['math', 'mathematics', 'algebra', 'geometry', 'equation', 'inequality', 'calculus', 'matematica', 'ecuatie', 'ecuatii', 'inegalitate', 'inegalitati', 'geometrie'],
  Physics: ['physics', 'mechanics', 'force', 'motion', 'electricity', 'fizica', 'mecanica', 'forta', 'miscare', 'electricitate'],
  Chemistry: ['chemistry', 'chemical', 'molecule', 'reaction', 'chimie', 'molecula', 'reactie'],
  Biology: ['biology', 'cell', 'cells', 'division', 'mitosis', 'meiosis', 'chromosome', 'genetics', 'anatomy', 'biologie', 'celula', 'celule', 'diviziune', 'mitoza', 'meioza', 'cromozom', 'genetica', 'anatomie'],
  'Computer science': ['programming', 'programare', 'coding', 'code', 'javascript', 'python', 'algorithm', 'algoritm', 'informatics', 'informatica'],
  English: ['english', 'grammar', 'essay', 'vocabulary', 'engleza', 'gramatica', 'eseu', 'vocabular'],
  'Romanian language and literature': ['romanian', 'romana', 'literature', 'literatura', 'gramatica', 'poezie', 'poem', 'comentariu'],
  History: ['history', 'historical', 'istorie', 'istoric'],
  Geography: ['geography', 'map', 'climate', 'geografie', 'harta', 'clima'],
  Economics: ['economics', 'business', 'finance', 'economie', 'afaceri', 'finante'],
  Psychology: ['psychology', 'behavior', 'psihologie', 'comportament']
};

function searchPeopleByAI(list, result) {
  const queryTerms = new Set(result.searchTerms.flatMap(searchTokens));
  return list.map((person) => {
    const subjectRating = ratingValue(person, result.subject);
    const profileTerms = new Set(searchTokens([person.main_subject || '', person.bio || '', ...Object.keys(person.subject_ratings || {})].join(' ')));
    const termMatches = [...queryTerms].filter((term) => profileTerms.has(term)).length;
    const hasSubject = subjectRating > 0 || person.main_subject === result.subject;
    const score = termMatches * 2 + subjectRating / 10 + (person.main_subject === result.subject ? 1 : 0);
    return { person, score, termMatches, hasSubject };
  }).filter(({ score, termMatches, hasSubject }) => score > 0 && (hasSubject || termMatches > 0))
    .sort((a, b) => b.score - a.score).map(({ person }) => ({ ...person, _searchSubject: result.subject }));
}

function localAISearch(query) {
  const tokens = searchTokens(query);
  const ranked = Object.entries(SUBJECT_HINTS).map(([subject, hints]) => ({ subject, score: hints.filter((hint) => tokens.includes(hint)).length }))
    .sort((a, b) => b.score - a.score);
  const subject = ranked[0]?.score ? ranked[0].subject : 'Mathematics';
  const searchTerms = [...new Set(tokens)].slice(0, 12);
  return { subject, searchTerms: searchTerms.length ? searchTerms : [subject], message: `Searching locally for students who can help with ${subject}.` };
}

function subscribeToMessages() {
  if (!configured || !supabase || !state.session?.user) return;
  supabase.channel(`stup-messages-${state.session.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const row = payload.new;
      const chat = state.chats.find((entry) => entry.id === row.conversation_id);
      if (!chat || row.sender_id === state.profile.id) return;
      chat.messages.push({ sender: row.sender_id, text: row.body });
      chat.lastUpdated = row.created_at;
      saveLocalState();
      if (state.view === 'inbox') renderInbox();
    })
    .subscribe();
}

function subscribeToPresence() {
  if (!configured || !supabase || !state.session?.user) return;
  supabase.channel('stup-presence', { config: { presence: { key: state.session.user.id } } })
    .on('presence', { event: 'sync' }, () => {
      const presenceState = supabase.getChannels().find((channel) => channel.topic === 'realtime:stup-presence')?.presenceState() || {};
      state.onlineUsers = new Set(Object.keys(presenceState));
      if (state.view === 'inbox') renderInbox();
    })
    .track({ online_at: new Date().toISOString() });
}

function renderDiscover() {
  const availablePeople = state.people.filter((person) => !state.profile || person.county === state.profile.county);
  let filteredPeople = [];
  let resultTitle = '';
  let matchedSubject = '';
  let searchMessage = '';

  if (state.searchSubmitted) {
    if (state.searchMode === 'ai') {
      filteredPeople = state.aiSearchResult ? searchPeopleByAI(availablePeople, state.aiSearchResult) : [];
      resultTitle = 'Students with matching strengths';
      matchedSubject = state.aiSearchResult?.subject || '';
      searchMessage = state.aiSearchResult?.message || '';
    } else {
      filteredPeople = availablePeople
        .filter((person) => ratingValue(person, state.filterSubject) >= state.minRating)
        .sort((a, b) => ratingValue(b, state.filterSubject) - ratingValue(a, state.filterSubject));
      resultTitle = `${state.filterSubject}, ${state.minRating}+`;
    }
  } else {
    filteredPeople = availablePeople;
  }

  shell(`
    <section class="ora-search">
      <div class="search-segment" role="group" aria-label="Choose search type">
        <button class="${state.searchMode === 'subject' ? 'selected' : ''}" data-search-mode="subject" aria-pressed="${state.searchMode === 'subject'}">Subject</button>
        <button class="${state.searchMode === 'ai' ? 'selected' : ''}" data-search-mode="ai" aria-pressed="${state.searchMode === 'ai'}">Ask AI</button>
      </div>
      ${state.searchMode === 'subject' ? `
        <select id="subjectfilter" aria-label="Subject">
          ${SUBJECTS.map((subject) => `<option value="${escapeHtml(subject)}" ${state.filterSubject === subject ? 'selected' : ''}>${escapeHtml(subject)}</option>`).join('')}
        </select>
        <select id="minrating" aria-label="Minimum subject rating">
          ${[1,2,3,4,5,6,7,8,9,10].map((rating) => `<option value="${rating}" ${Number(state.minRating) === rating ? 'selected' : ''}>${rating}+</option>`).join('')}
        </select>
      ` : `
        <input id="smartsearch" value="${escapeHtml(state.search)}" placeholder="Describe what you need help with" aria-label="Describe what you need help with" />
      `}
      <button class="btn" data-search-submit ${state.aiSearchPending ? 'disabled' : ''}>${state.aiSearchPending ? 'Searching…' : 'Search'}</button>
    </section>
    ${state.searchMode === 'ai' ? '<p class="ai-privacy-note">Gemini does not collect or store any of your search queries.</p>' : ''}
    <div class="filters">
      <span class="pill">${escapeHtml(state.profile.county)}</span>
      <span class="pill">${escapeHtml(levelName(state.profile.school_level))}</span>
    </div>

    ${state.searchSubmitted ? `
      <div class="search-results-heading">
        <b>${escapeHtml(resultTitle)}</b>
        <button class="btn secondary" data-search-clear>Clear</button>
      </div>
      ${state.searchMode === 'ai' ? `<p class="search-personalized">${escapeHtml(searchMessage)}</p>` : ''}
    ` : ''}

    <div class="cards">
      ${filteredPeople.length ? filteredPeople.map((person) => {
        const tags = subjectTags(person, 4);
        const searchSubject = state.searchSubmitted ? (state.searchMode === 'ai' ? person._searchSubject : state.filterSubject) : '';
        if (searchSubject && !tags.some((tag) => tag.subject === searchSubject)) {
          tags.unshift({ subject: searchSubject, rating: ratingValue(person, searchSubject) });
        } else if (searchSubject) {
          tags.sort((a, b) => Number(b.subject === searchSubject) - Number(a.subject === searchSubject));
        }
        const review = reviewSummary(person.id);
        return `
          <article class="card person">
            <div class="personhead">
              ${avatarMarkup(person)}
              <div class="personinfo">
                <b>${escapeHtml(person.display_name)} ${person.verified ? '<span class="verified" title="Student ID verified">✓</span>' : ''}</b>
                <small>${escapeHtml(levelName(person.school_level))} · ${escapeHtml(person.county)}</small>
              </div>
            </div>

            ${person.bio ? `<p class="person-bio">${highlightSubject(person.bio, searchSubject)}</p>` : ''}

            <div class="subject-ratings">
              ${tags.length ? tags.map(({ subject, rating }) => `
                <div class="rating-row ${subject === searchSubject ? 'search-subject-match' : ''}">
                  <span>${escapeHtml(subject)}</span>
                  <span class="rating-number">${rating}/10</span>
                  <div class="ratingbar"><i style="width:${rating * 10}%"></i></div>
                </div>
              `).join('') : '<span class="muted small">No ratings yet</span>'}
            </div>

            <div class="chips">
              <span class="chip">★ ${review.count ? escNumber(review.average) : '—'} (${review.count})</span>
              ${searchSubject
                ? `<span class="chip search-subject-chip">Help with: <b>${escapeHtml(searchSubject)}</b> · ${ratingValue(person, searchSubject) || ratingValue(person, person.main_subject) || '—'}/10</span>`
                : `<span class="chip"><b>${escNumber(ratingValue(person, person.main_subject || topSubject(person)))}</b> / 10</span>
                   <span class="chip">${escapeHtml(person.main_subject || 'Study help')}</span>`}
            </div>

            <div class="person-actions">
              <button class="btn secondary" data-view-profile="${escapeHtml(person.id)}">View profile</button>
              <button class="btn secondary favorite-button ${isFavorite(person.id) ? 'is-favorite' : ''}" data-favorite="${escapeHtml(person.id)}" aria-label="${isFavorite(person.id) ? 'Remove from favorites' : 'Add to favorites'}">${isFavorite(person.id) ? '♥ Saved' : '♡ Favorite'}</button>
              <button class="btn" data-start-chat="${escapeHtml(person.id)}">Message</button>
            </div>
          </article>
        `;
      }).join('') : `
        <section class="card empty">
          <div class="avatar">✦</div>
          <h3>${state.searchMode === 'ai' ? 'No matching profiles just yet.' : 'No students match that search.'}</h3>
          <p class="muted">${state.searchMode === 'ai' ? `We understood that you need help with ${escapeHtml(matchedSubject || 'your topic')}, but no matching student was found.` : 'Try another subject, lower the rating, or search a different topic.'}</p>
        </section>
      `}
    </div>
  `);

  document.querySelectorAll('[data-search-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.searchMode = button.dataset.searchMode;
      state.searchSubmitted = false;
      saveLocalState();
      renderDiscover();
    });
  });

  const searchInput = document.querySelector('#smartsearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.search = searchInput.value;
      saveLocalState();
    });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitDiscoverSearch();
      }
    });
  }

  const subjectSelect = document.querySelector('#subjectfilter');
  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      state.filterSubject = subjectSelect.value;
    });
    document.querySelector('#minrating').addEventListener('change', (event) => {
      state.minRating = Number(event.target.value);
    });
  }

  document.querySelector('[data-search-submit]').addEventListener('click', submitDiscoverSearch);
  document.querySelector('[data-search-clear]')?.addEventListener('click', () => {
    state.searchSubmitted = false;
    state.aiSearchResult = null;
    saveLocalState();
    renderDiscover();
  });

  document.querySelectorAll('[data-start-chat]').forEach((button) => {
    button.addEventListener('click', () => startOrOpenChat(button.dataset.startChat));
  });

  document.querySelectorAll('[data-view-profile]').forEach((button) => {
    button.addEventListener('click', () => openProfileModal(button.dataset.viewProfile));
  });

  document.querySelectorAll('[data-favorite]').forEach((button) => {
    button.addEventListener('click', () => toggleFavorite(button.dataset.favorite));
  });

}

async function submitDiscoverSearch() {
  if (state.searchMode === 'ai') {
    const query = state.search.trim();
    if (!query) {
      toast('Describe what you need help with first.');
      return;
    }
    state.aiSearchPending = true;
    state.searchSubmitted = false;
    state.aiSearchResult = null;
    renderDiscover();
    state.aiSearchResult = localAISearch(query);
    state.searchSubmitted = true;
    state.aiSearchPending = false;
    saveLocalState();
    renderDiscover();
    return;
  }

  state.searchSubmitted = true;
  saveLocalState();
  renderDiscover();
}

function escNumber(value) {
  return Number(value || 0).toFixed(1).replace(/\.0$/, '');
}

function openProfileModal(personId) {
  const existingModal = document.querySelector('.profile-modal[data-profile-modal]');
  if (existingModal) {
    if (existingModal.dataset.personId === personId) {
      existingModal._closeProfileModal();
      return;
    }
    existingModal._closeProfileModal();
  }

  const person = getPersonById(personId);
  if (!person) return;

  const tags = subjectTags(person, SUBJECTS.length);
  const modal = document.createElement('div');
  modal.className = 'profile-modal';
  modal.dataset.profileModal = '';
  modal.dataset.personId = personId;
  modal.innerHTML = `
    <section class="profile-panel card" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <div class="threadtitle">
        ${avatarMarkup(person)}
        <div>
          <b id="profile-title">${escapeHtml(person.display_name)}</b>
          <small>${escapeHtml(levelName(person.school_level))} · ${escapeHtml(person.county)}</small>
        </div>
      </div>
      <p>${escapeHtml(person.bio || 'No bio added yet.')}</p>
      ${person.verified ? '<span class="tag">Verified student</span>' : '<span class="muted small">Student ID pending verification</span>'}
      <h3>Subject ratings</h3>
      ${tags.length ? `<div class="subject-ratings">
        ${tags.map(({ subject, rating }) => `
          <div class="rating-row">
            <span>${escapeHtml(subject)}</span>
            <span class="rating-number">${rating}/10</span>
            <div class="ratingbar"><i style="width:${rating * 10}%"></i></div>
          </div>
        `).join('')}
      </div>` : '<p class="muted">No subject ratings yet.</p>'}
      <h3>Student reviews</h3>
      ${(() => {
        const reviews = reviewsForProfile(person.id);
        const summary = reviewSummary(person.id);
        return `
          <p class="profile-rating">${summary.count ? `★ ${escNumber(summary.average)} / 5 · ${summary.count} ${summary.count === 1 ? 'rating' : 'ratings'}` : 'No ratings yet'}</p>
          ${state.reviewsLoadError ? `<p class="muted">Could not load reviews: ${escapeHtml(state.reviewsLoadError)}</p>` : ''}
          ${reviews.length ? `<div class="profile-reviews">${reviews.map((review) => {
            const reviewer = getPersonById(review.reviewerId);
            return `
              <article class="review">
                <div class="review-heading">
                  <b>${escapeHtml(reviewer?.display_name || 'Student')}</b>
                  <span class="review-stars" aria-label="${review.rating} out of 5 stars">${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}</span>
                </div>
                ${review.comment ? `<p>${escapeHtml(review.comment)}</p>` : ''}
              </article>
            `;
          }).join('')}</div>` : '<p class="muted">No comments yet. Reviews appear after a completed session.</p>'}
        `;
      })()}
      <div class="row">
        <button class="btn secondary favorite-button ${isFavorite(person.id) ? 'is-favorite' : ''}" data-profile-favorite>${isFavorite(person.id) ? '♥ Saved' : '♡ Favorite'}</button>
        <button class="btn" data-profile-message>Message</button>
        <button class="btn secondary" data-profile-report>Report</button>
        <button class="btn secondary" data-profile-close>Close</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);

  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const close = () => {
    modal.remove();
    document.body.style.overflow = previousOverflow;
    document.removeEventListener('keydown', onKeyDown);
  };
  modal._closeProfileModal = close;
  const onKeyDown = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKeyDown);
  modal.querySelector('[data-profile-close]').addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector('[data-profile-message]').addEventListener('click', () => {
    close();
    startOrOpenChat(personId);
  });
  modal.querySelector('[data-profile-favorite]').addEventListener('click', async () => {
    await toggleFavorite(personId);
    close();
  });
  modal.querySelector('[data-profile-report]').addEventListener('click', () => openReportModal(personId));
}

async function startOrOpenChat(otherUserId) {
  const currentId = state.profile.id;
  const existingChat = state.chats.find((chat) => chat.participants.includes(currentId) && chat.participants.includes(otherUserId));
  if (existingChat) {
    state.activeChatId = existingChat.id;
    state.view = 'inbox';
    saveLocalState();
    render();
    return;
  }

  const otherUser = state.people.find((person) => person.id === otherUserId) || state.localUsers.find((person) => person.id === otherUserId);
  let conversationId = `chat-${Date.now()}`;
  if (configured && supabase && state.session?.user) {
    const { data, error } = await supabase.rpc('get_or_create_conversation', { other_user: otherUserId });
    if (error) {
      toast(error.message || 'Could not start the conversation.');
      return;
    }
    conversationId = data;
  }
  const newChat = {
    id: conversationId,
    participants: [currentId, otherUserId],
    status: 'active',
    requesterId: currentId,
    messages: [],
    lastUpdated: Date.now(),
    session: { date: '', method: 'online', completed: false }
  };

  state.chats.unshift(newChat);
  state.activeChatId = newChat.id;
  state.view = 'inbox';
  saveLocalState();
  render();
}

function renderInbox() {
  const currentUserId = state.profile.id;
  const isMobile = window.matchMedia('(max-width: 640px)').matches;
  const chats = state.chats.filter((chat) => chat.participants.includes(currentUserId));
  const activeChat = chats.find((chat) => chat.id === state.activeChatId) || chats[0] || null;
  if (activeChat) state.activeChatId = activeChat.id;

  shell(`
    <div class="inboxgrid">
      <section class="card inbox-contacts ${isMobile && !state.inboxListOpen ? 'mobile-hidden' : ''}">
        <h2>Inbox</h2>
        ${chats.length ? chats.map((chat) => {
          const partnerId = chat.participants.find((personId) => personId !== currentUserId);
          const partner = getPersonById(partnerId);
          return `
            <button class="chatitem ${activeChat && activeChat.id === chat.id ? 'selected' : ''}" data-chat-id="${chat.id}">
              ${avatarMarkup(partner, 'small-avatar')}
              <span>
                <b>${escapeHtml(partner?.display_name || 'Student')}</b>
              <small>${isPersonActive(partnerId) ? 'Active now' : 'Offline'}</small>
              </span>
            </button>
          `;
        }).join('') : '<p class="muted">No conversations yet.</p>'}
      </section>

      <section class="card thread ${isMobile && state.inboxListOpen ? 'mobile-hidden' : ''}">
        ${isMobile && activeChat ? '<button class="btn secondary inbox-back" data-inbox-back>← All contacts</button>' : ''}
        ${activeChat ? renderThread(activeChat) : '<div class="emptyline">Start a conversation from Discover.</div>'}
      </section>
    </div>
  `);

  document.querySelectorAll('[data-chat-id]').forEach((button) => {
    button.addEventListener('click', () => {
      state.activeChatId = button.dataset.chatId;
      state.inboxListOpen = false;
      saveLocalState();
      renderInbox();
    });
  });

  document.querySelector('[data-inbox-back]')?.addEventListener('click', () => {
    state.inboxListOpen = true;
    renderInbox();
  });

  const acceptButton = document.querySelector('[data-accept]');
  const declineButton = document.querySelector('[data-decline]');
  const sendButton = document.querySelector('[data-send]');
  const finishButton = document.querySelector('[data-finish]');
  const rateButton = document.querySelector('[data-rate-session]');
  const meetButton = document.querySelector('[data-meet]');

  if (acceptButton) acceptButton.addEventListener('click', () => acceptChat(activeChat.id));
  if (declineButton) declineButton.addEventListener('click', () => declineChat(activeChat.id));
  if (sendButton) sendButton.addEventListener('click', () => sendMessage(activeChat.id));
  if (finishButton) finishButton.addEventListener('click', () => completeSession(activeChat.id));
  if (rateButton) rateButton.addEventListener('click', () => openReviewModal(activeChat.id));
  if (meetButton) meetButton.addEventListener('click', () => openMeetLink(activeChat.id));
}

function renderThread(chat) {
  const currentUserId = state.profile.id;
  const partner = getPersonById(chat.participants.find((personId) => personId !== currentUserId));

  let body = `
    <div class="threadtitle">
      ${avatarMarkup(partner)}
      <div>
        <b>${escapeHtml(partner?.display_name || 'Student')}</b>
        <small class="presence ${isPersonActive(partner?.id) ? 'online' : ''}">${isPersonActive(partner?.id) ? 'Active now' : 'Offline'}</small>
      </div>
    </div>

    <div class="messages">
      ${(chat.messages || []).map((message) => {
        const mine = message.sender === currentUserId;
        return `
          <div class="bubble ${mine ? 'mine' : ''}">
            <p>${messageMarkup(message.text)}</p>
            <small>${mine ? 'You' : escapeHtml(partner?.display_name || 'Them')}</small>
          </div>
        `;
      }).join('') || '<div class="emptyline">No messages yet.</div>'}
    </div>
  `;

  if (chat.status === 'active') {
    body += `
      <div class="sendform">
        <input id="messageInput" placeholder="Write a message…" />
        <button class="btn" data-send>Send</button>
      </div>
      ${chat.session && chat.session.date ? `
        <div class="notice">
          <strong>${chat.session.completed ? 'Session completed:' : 'Session booked:'}</strong> ${escapeHtml(chat.session.date)} · ${escapeHtml(chat.session.method)}
        </div>
        <div class="row">
          ${chat.session.completed
            ? (chat.requesterId !== currentUserId
              ? ''
              : reviewForSession(chat.id, currentUserId)
              ? '<span class="muted">You rated this session.</span>'
              : '<button class="btn" data-rate-session>Rate and comment</button>')
            : '<button class="btn" data-finish>Session complete</button>'}
        </div>
      ` : '<p class="muted meeting-note">No date booking is needed. Start a Google Meet when you are ready.</p>'}
      <div class="row">
        <button class="btn" data-meet>Open Google Meet</button>
      </div>
    `;
  }

  if (chat.status === 'declined') {
    body += '<p class="muted">This request was declined.</p>';
  }

  return body;
}

function acceptChat(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;
  chat.status = 'active';
  chat.messages.push({ sender: state.profile.id, text: 'Accepted — let\'s study together.' });
  saveLocalState();
  render();
}

function declineChat(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;
  chat.status = 'declined';
  saveLocalState();
  render();
}

async function sendMessage(chatId) {
  const input = document.querySelector('#messageInput');
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat || !input) return;
  const text = input.value.trim();
  if (!text) return;
  if (BLOCKED_COMMENT_WORDS.test(text)) {
    toast('Message blocked. Keep the conversation respectful.');
    return;
  }
  if (configured && supabase && state.session?.user && !String(chatId).startsWith('chat-')) {
    const { error } = await supabase.from('messages').insert({ conversation_id: chatId, sender_id: state.profile.id, body: text });
    if (error) {
      toast(error.message || 'Could not send your message.');
      return;
    }
  }
  chat.messages.push({ sender: state.profile.id, text });
  chat.lastUpdated = Date.now();
  saveLocalState();
  render();
}

function bookSession(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;
  if (sessionBalance() < 1) {
    toast('You need 1 session credit to book. Complete a teaching session to earn one.');
    return;
  }
  const date = window.prompt('Choose a date and time (YYYY-MM-DD HH:mm)', '2026-11-02 18:30');
  if (!date) return;
  const method = window.prompt('Session type: online or in-person?', 'online');
  const normalizedMethod = (method || 'online').toLowerCase().includes('in') ? 'in-person' : 'online';
  if (normalizedMethod === 'in-person' && !state.profile.verified) {
    toast('In-person sessions require a verified student ID. Choose online or verify your profile first.');
    return;
  }
  if (Number.isNaN(new Date(date.replace(' ', 'T')).getTime())) {
    toast('Choose a valid date and time.');
    return;
  }
  chat.session = {
    date,
    method: normalizedMethod,
    completed: false,
    paid: true
  };
  state.profile.lumen_balance = sessionBalance() - 1;
  chat.messages.push({ sender: state.profile.id, text: `Session booked for ${date} (${chat.session.method}).` });
  saveSessionBalance(state.profile).catch((error) => toast(error.message || 'Could not save your session balance.'));
  render();
}

async function completeSession(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;
  chat.session.completed = true;
  chat.messages.push({ sender: state.profile.id, text: 'Session completed — thanks for the help.' });
  const partnerId = chat.participants.find((userId) => userId !== state.profile.id);
  const partner = getPersonById(partnerId);
  if (partner) {
    partner.lumen_balance = sessionBalance(partner) + 1;
    if (configured && supabase && state.session?.user && partner.id !== state.profile.id) {
      const { error } = await supabase.from('profiles').update({ lumen_balance: partner.lumen_balance }).eq('id', partner.id);
      if (error) {
        toast(error.message || 'Session marked complete, but the teacher reward could not be saved.');
        return;
      }
    }
    if (partner.id === state.profile.id) updateLocalProfile(partner);
  }
  saveLocalState();
  render();
}

function openReviewModal(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat?.session?.completed) return;
  if (chat.requesterId !== state.profile.id) {
    toast('Only the student who requested this session can rate it.');
    return;
  }
  if (reviewForSession(chat.id, state.profile.id)) {
    toast('You have already rated this session.');
    return;
  }

  const targetProfileId = chat.participants.find((userId) => userId !== state.profile.id);
  const target = getPersonById(targetProfileId);
  if (!target) {
    toast('Could not find this student’s profile.');
    return;
  }

  const modal = document.createElement('div');
  modal.className = 'profile-modal';
  modal.innerHTML = `
    <section class="profile-panel card" role="dialog" aria-modal="true" aria-labelledby="review-title">
      <h2 id="review-title">Rate your session</h2>
      <label class="review-comment-label" for="review-rating">Rating</label>
      <select id="review-rating">
        ${[5, 4, 3, 2, 1].map((rating) => `<option value="${rating}">${'★'.repeat(rating)}</option>`).join('')}
      </select>
      <label class="review-comment-label" for="review-comment">Comment</label>
      <textarea id="review-comment" rows="3" maxlength="1000" placeholder="Comment"></textarea>
      <div class="row">
        <button class="btn" data-submit-review>Post</button>
        <button class="btn secondary" data-cancel-review>Cancel</button>
      </div>
    </section>
  `;
  document.body.appendChild(modal);

  const close = () => modal.remove();
  modal.querySelector('[data-cancel-review]').addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });
  modal.querySelector('[data-submit-review]').addEventListener('click', async () => {
    const rating = Number(modal.querySelector('#review-rating').value);
    const comment = modal.querySelector('#review-comment').value.trim();
    if (comment && BLOCKED_COMMENT_WORDS.test(comment)) {
      toast('Comment blocked. Keep feedback respectful and free of insults.');
      return;
    }
    const review = {
      id: `review-${Date.now()}`,
      targetProfileId,
      reviewerId: state.profile.id,
      sessionId: chat.id,
      rating,
      comment,
      createdAt: new Date().toISOString()
    };

    if (configured && supabase && state.session?.user) {
      const { data, error } = await supabase.from('profile_reviews').insert({
        target_profile_id: targetProfileId,
        reviewer_profile_id: state.profile.id,
        session_id: chat.id,
        rating,
        comment
      }).select('id,created_at').single();
      if (error) {
        toast(error.message || 'Could not save your review.');
        return;
      }
      review.id = data.id;
      review.createdAt = data.created_at;
    }

    state.reviews.push(review);
    state.reviewsLoadError = '';
    saveLocalState();
    close();
    toast('Review posted.');
    render();
  });
}

function openMeetLink(chatId) {
  const chat = state.chats.find((entry) => entry.id === chatId);
  if (!chat) return;
  const meetUrl = 'https://meet.google.com/new';
  window.open(meetUrl, '_blank', 'noopener,noreferrer');
  const alreadyShared = chat.messages.some((message) => message.text === meetUrl);
  if (!alreadyShared) {
    chat.messages.push({ sender: state.profile.id, text: `Google Meet link: ${meetUrl}` });
    chat.lastUpdated = Date.now();
    saveLocalState();
    if (configured && supabase && state.session?.user && !String(chatId).startsWith('chat-')) {
      supabase.from('messages').insert({ conversation_id: chatId, sender_id: state.profile.id, body: `Google Meet link: ${meetUrl}` })
        .then(({ error }) => { if (error) toast(error.message || 'The meeting link was not sent.'); });
    }
    renderInbox();
  }
}

function openReportModal(partnerId, chatId = 'profile') {
  const partner = getPersonById(partnerId);
  if (!partner) return;

  const modal = document.createElement('div');
  modal.className = 'report-modal';
  modal.innerHTML = `
    <div class="report-panel">
      <h3>Report ${escapeHtml(partner?.display_name || 'this student')}</h3>
      <p class="muted">This flags misconduct, no-shows, unsafe behavior, or inappropriate content.</p>
      <textarea id="reportReason" rows="5" placeholder="Describe what happened…"></textarea>
      <div class="row">
        <button class="btn" id="reportSubmit">Submit report</button>
        <button class="btn secondary" id="reportCancel">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#reportSubmit').addEventListener('click', async () => {
    const reason = document.querySelector('#reportReason').value.trim();
    if (!reason || reason.length < 10) {
      toast('Please add a short explanation.');
      return;
    }

    const report = {
      id: `report-${Date.now()}`,
      targetUserId: partnerId,
      reporterId: state.profile.id,
      reason,
      createdAt: new Date().toISOString(),
      chatId
    };

    if (configured && supabase && state.session?.user) {
      const { error } = await supabase.from('reports').insert({
        target_profile_id: partnerId,
        reporter_profile_id: state.profile.id,
        conversation_id: chatId,
        reason
      });
      if (error) {
        toast(error.message || 'Could not send report.');
        return;
      }
    }

    const key = `stup-reports-v1`;
    const existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push(report);
    localStorage.setItem(key, JSON.stringify(existing));

    toast('Report sent.');
    document.body.removeChild(modal);
  });

  modal.querySelector('#reportCancel').addEventListener('click', () => {
    document.body.removeChild(modal);
  });
}

function renderSettings() {
  let selectedProfilePhoto = null;
  let previewObjectUrl = '';
  const ownReviewSummary = reviewSummary(state.profile.id);
  const ownReviews = reviewsForProfile(state.profile.id);

  shell(`
    <section class="settings">
      <h1>Your profile</h1>
      <div class="card own-rating-card">
        <div>
          <strong>Your student rating</strong>
          <p class="muted small">Based on feedback from completed sessions.</p>
        </div>
        <div class="own-rating-value">
          <span class="review-stars" aria-label="${ownReviewSummary.count ? `${escNumber(ownReviewSummary.average)} out of 5 stars` : 'No ratings yet'}">${ownReviewSummary.count ? `${'★'.repeat(Math.round(ownReviewSummary.average))}${'☆'.repeat(5 - Math.round(ownReviewSummary.average))}` : '☆☆☆☆☆'}</span>
          <b>${ownReviewSummary.count ? `${escNumber(ownReviewSummary.average)} / 5` : 'No ratings yet'}</b>
          ${ownReviewSummary.count ? `<small class="muted">${ownReviewSummary.count} ${ownReviewSummary.count === 1 ? 'rating' : 'ratings'}</small>` : ''}
        </div>
        ${ownReviews.length ? `<div class="own-rating-reviews">${ownReviews.slice(0, 3).map((review) => `<p>“${escapeHtml(review.comment || 'Session rating')}” <span class="review-stars">${'★'.repeat(review.rating)}</span></p>`).join('')}</div>` : ''}
      </div>
      <div class="card form">
        <div class="profile-summary">
          <strong>✦ ${sessionBalance()} Sessions</strong>
          <span class="muted small">Spend 1 session credit to book. Teaching earns it back.</span>
        </div>
        <div class="profile-photo-setting">
          ${avatarMarkup(state.profile, 'profile-photo-preview')}
          <label for="profile-photo">Profile picture</label>
          <input id="profile-photo" type="file" accept="image/jpeg,image/png,image/webp" />
          <small class="muted">Choose a JPG, PNG, or WebP image up to 5 MB.</small>
        </div>
        <label>
          Display name
          <input id="profile-name" value="${escapeHtml(state.profile.display_name)}" />
        </label>
        <label>
          School level
          <select id="profile-level">
            ${LEVELS.map((level, index) => `<option value="${index}" ${Number(state.profile.school_level) === index ? 'selected' : ''}>${level}</option>`).join('')}
          </select>
        </label>
        <label>
          County
          <select id="profile-county">
            ${COUNTIES.map((county) => `<option value="${county}" ${state.profile.county === county ? 'selected' : ''}>${county}</option>`).join('')}
          </select>
        </label>
        <label>
          Bio
          <textarea id="profile-bio" rows="3">${escapeHtml(state.profile.bio || '')}</textarea>
        </label>
        <div class="notice">
          <strong>${state.profile.verified ? '✓ Student ID verified' : 'Student ID pending verification'}</strong>
          <p class="muted small">${state.profile.verified ? 'In-person sessions are available.' : 'Online sessions are available now. A verified ID is required for in-person meetings.'}</p>
        </div>

        <div class="subject-ratings">
          ${SUBJECTS.map((subject) => `
            <div class="rating-row rating-editor-row ${ratingValue(state.profile, subject) === 0 ? 'rating-disabled' : ''}">
              <span>${escapeHtml(subject)}</span>
              <span class="rating-number" data-rating-value>${ratingValue(state.profile, subject) || 0}/10</span>
              <input type="range" min="0" max="10" step="1" value="${ratingValue(state.profile, subject) || 0}" data-subject="${escapeHtml(subject)}" style="--rating:${(ratingValue(state.profile, subject) || 0) * 10}%" aria-label="${escapeHtml(subject)} rating" />
            </div>
          `).join('')}
        </div>

        <div class="row">
          <button class="btn" id="save-profile">Save profile</button>
          <button class="btn secondary" id="logout">Log out</button>
        </div>
      </div>
    </section>
  `);

  document.querySelector('#profile-photo').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      event.target.value = '';
      selectedProfilePhoto = null;
      toast('Choose a JPG, PNG, or WebP image smaller than 5 MB.');
      return;
    }
    selectedProfilePhoto = file;
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(file);
    const image = document.createElement('img');
    image.src = previewObjectUrl;
    image.alt = '';
    const preview = document.querySelector('.profile-photo-preview');
    preview.replaceChildren(image);
  });

  document.querySelectorAll('[data-subject]').forEach((input) => {
    const row = input.closest('.rating-editor-row');
    const valueLabel = row.querySelector('[data-rating-value]');
    const updateRatingPreview = () => {
      const value = Number(input.value);
      valueLabel.textContent = `${value}/10`;
      input.style.setProperty('--rating', `${value * 10}%`);
      row.classList.toggle('rating-disabled', value === 0);
    };
    input.addEventListener('input', updateRatingPreview);
  });

  const saveButton = document.querySelector('#save-profile');
  saveButton.addEventListener('click', async () => {
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    try {
      const profileName = document.querySelector('#profile-name').value.trim();
      const level = Number(document.querySelector('#profile-level').value);
      const county = document.querySelector('#profile-county').value;
      const bio = document.querySelector('#profile-bio').value.trim();
      const subjectRatings = {};

      document.querySelectorAll('[data-subject]').forEach((input) => {
        const value = Number(input.value);
        if (value > 0) {
          subjectRatings[input.dataset.subject] = value;
        }
      });

      if (!profileName) throw new Error('Please add your display name.');

      let profilePhotoUrl = state.profile.profile_photo_url || '';
      if (selectedProfilePhoto) {
        profilePhotoUrl = await uploadProfilePhoto(selectedProfilePhoto, state.profile.id);
      }

      const updatedProfile = {
        ...state.profile,
        display_name: profileName,
        school_level: level,
        county,
        bio,
        profile_photo_url: profilePhotoUrl,
        subject_ratings: subjectRatings,
        main_subject: Object.entries(subjectRatings).sort((a, b) => b[1] - a[1])[0]?.[0] || state.profile.main_subject || 'Mathematics'
      };

      if (configured && supabase && state.session?.user) {
        const { data, error } = await supabase.from('profiles').update({
          display_name: updatedProfile.display_name,
          school_level: updatedProfile.school_level,
          county: updatedProfile.county,
          main_subject: updatedProfile.main_subject,
          subject_ratings: updatedProfile.subject_ratings,
          bio: updatedProfile.bio,
          student_id_photo_url: updatedProfile.student_id_photo_url || null,
          profile_photo_url: updatedProfile.profile_photo_url || null
        }).eq('id', state.session.user.id).select('id').maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Your profile could not be found in Supabase. Please sign in again.');
      }

      const previousProfile = state.profile;
      const previousUsers = state.localUsers;
      state.profile = updatedProfile;
      const existingIndex = state.localUsers.findIndex((person) => person.id === updatedProfile.id);
      if (existingIndex >= 0) {
        state.localUsers = state.localUsers.map((person) => person.id === updatedProfile.id ? { ...updatedProfile } : person);
      } else {
        state.localUsers = [...state.localUsers, { ...updatedProfile }];
      }

      try {
        saveLocalState();
      } catch (error) {
        if (configured && supabase && state.session?.user) {
          toast('Profile saved to your account, but this browser could not update its local cache.');
          render();
          return;
        }
        state.profile = previousProfile;
        state.localUsers = previousUsers;
        throw new Error(error.name === 'QuotaExceededError'
          ? 'Your profile could not be saved because browser storage is full. Remove a large image and try again.'
          : 'Your profile could not be saved in this browser.');
      }
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      toast('Profile saved.');
      render();
    } catch (error) {
      toast(error.message || 'Could not save your profile.');
    } finally {
      if (saveButton.isConnected) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save profile';
      }
    }
  });

  document.querySelector('#logout').addEventListener('click', async () => {
    if (configured && supabase) {
      await supabase.auth.signOut();
    }
    state.profile = null;
    state.session = null;
    saveLocalState();
    authScreen('login');
  });
}

function render() {
  if (!state.profile) {
    authScreen('login');
    return;
  }

  if (state.view === 'discover') {
    renderDiscover();
  } else if (state.view === 'inbox') {
    renderInbox();
  } else {
    renderSettings();
  }
}

function authScreen(mode = 'signup') {
  const signup = mode === 'signup';
  shell(`
    <section class="auth">
      <div class="brand-lockup auth-brand"><img class="brand-mark" src="${logoMark}" alt="" /><div class="logo big">stup</div></div>
      <h1>${signup ? 'Learn from students who just got it.' : 'Welcome back.'}</h1>
      <p class="muted">Teach what you know. Ask for help when you need it.</p>

      <form id="authform" class="card form">
        ${signup ? `
          <label>
            Full name
            <input name="display_name" required maxlength="40" placeholder="Alex Popescu" />
          </label>
          <label>
            Student ID photo
            <input name="student_photo" type="file" accept="image/*" />
          </label>
        ` : ''}

        <label>
          Email
          <input name="email" type="email" required placeholder="you@example.com" />
        </label>

        <label>
          Password
          <input name="password" type="password" required minlength="8" placeholder="At least 8 characters" />
        </label>

        ${signup ? `
          <label>
            School level
            <select name="school_level">
              ${LEVELS.map((level, index) => `<option value="${index}">${level}</option>`).join('')}
            </select>
          </label>

          <label>
            County
            <select name="county">
              ${COUNTIES.map((county) => `<option value="${county}">${county}</option>`).join('')}
            </select>
          </label>

          <p class="muted small">If Supabase is enabled, we’ll save the student ID image in the student-ids bucket when available.</p>
        ` : ''}

        <button class="btn" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        <p class="muted small">
          ${signup ? 'Already have an account?' : 'New to stup?'}
          <a href="#" id="toggleauth">${signup ? 'Log in' : 'Create account'}</a>
        </p>
      </form>
    </section>
  `);

  document.querySelector('#toggleauth').addEventListener('click', (event) => {
    event.preventDefault();
    authScreen(signup ? 'login' : 'signup');
  });

  document.querySelector('#authform').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') || '').trim().toLowerCase();
    const password = String(form.get('password') || '');

    if (!email || !password) {
      toast('Email and password are required.');
      return;
    }

    try {
      if (mode === 'signup') {
        const display_name = String(form.get('display_name') || '').trim();
        const school_level = Number(form.get('school_level') || 1);
        const county = String(form.get('county') || 'București');
        const studentPhoto = form.get('student_photo');
        if (!display_name) {
          toast('Please add your full name.');
          return;
        }

        if (configured && supabase) {
          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                display_name,
                school_level,
                county
              }
            }
          });
          if (error) throw error;

          const userId = data?.user?.id;
          if (userId) {
            if (!data.session) {
              const localUser = {
                id: `local-${Date.now()}`,
                display_name,
                school_level,
                county,
                main_subject: 'Mathematics',
                subject_ratings: {},
                bio: '',
                lumen_balance: DEFAULT_SESSIONS,
                verified: false,
                student_id_photo_url: '',
                profile_photo_url: '',
                password,
                email,
                sessions: 0
              };
              state.localUsers.push(localUser);
              state.profile = { ...localUser };
              state.people = state.localUsers.filter((person) => person.id !== localUser.id);
              state.view = 'discover';
              saveLocalState();
              toast('Email confirmation is not configured, so this demo account was created locally.');
              render();
              return;
            }
            const photoUrl = studentPhoto && studentPhoto.size ? await uploadStudentPhoto(studentPhoto) : '';
            const { data: profileRow, error: profileError } = await supabase.from('profiles').upsert({
              id: userId,
              display_name,
              school_level,
              county,
              main_subject: 'Mathematics',
              subject_ratings: {},
              bio: '',
              lumen_balance: DEFAULT_SESSIONS,
              verified: false,
              student_id_photo_url: photoUrl || null,
              profile_photo_url: null
            }).select().single();
            if (profileError) throw profileError;
            state.profile = profileRow;
            state.session = { user: { id: userId } };
            state.people = [];
            state.view = 'discover';
            await fetchReviews();
            await fetchFavorites();
            saveLocalState();
            await render();
            return;
          }
        }

        const newUser = {
          id: `local-${Date.now()}`,
          display_name,
          school_level,
          county,
          main_subject: 'Mathematics',
          subject_ratings: {},
          bio: '',
          lumen_balance: DEFAULT_SESSIONS,
          verified: false,
          student_id_photo_url: studentPhoto && studentPhoto.size ? await readDataUrl(studentPhoto) : '',
          profile_photo_url: '',
          password,
          email,
          sessions: 0
        };

        state.localUsers.push(newUser);
        state.profile = { ...newUser };
        state.people = state.localUsers.filter((person) => person.id !== newUser.id);
        saveLocalState();
        state.view = 'discover';
        render();
        return;
      }

      if (configured && supabase) {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          const localDemoUser = state.localUsers.find((person) => person.email === email && person.password === password);
          if (localDemoUser) {
            state.profile = { ...localDemoUser };
            state.people = state.localUsers.filter((person) => person.id !== localDemoUser.id);
            state.view = 'discover';
            saveLocalState();
            render();
            return;
          }
          throw error;
        }
        state.session = data.session;
        const { data: profileRow, error: profileErr } = await supabase.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
        if (profileErr) throw profileErr;
        if (profileRow) {
          state.profile = profileRow;
        } else {
          const newProfile = { id: data.user.id, display_name: data.user.user_metadata?.display_name || data.user.email.split('@')[0], school_level: Number(data.user.user_metadata?.school_level ?? 1), county: data.user.user_metadata?.county || 'București', main_subject: 'Mathematics', subject_ratings: {}, bio: '', lumen_balance: DEFAULT_SESSIONS, verified: false, student_id_photo_url: null, profile_photo_url: null };
          const { data: createdProfile, error: createProfileError } = await supabase.from('profiles').insert(newProfile).select().single();
          if (createProfileError) throw createProfileError;
          state.profile = createdProfile;
        }
        state.view = 'discover';
        await fetchPeople();
        await fetchReviews();
        await fetchConversations();
        await fetchFavorites();
        subscribeToMessages();
        subscribeToPresence();
        saveLocalState();
        render();
        return;
      }

      const existingUser = state.localUsers.find((person) => person.email.toLowerCase() === email && person.password === password);
      if (!existingUser) {
        toast('Wrong email or password.');
        return;
      }

      state.profile = { ...existingUser };
      state.view = 'discover';
      saveLocalState();
      render();
    } catch (error) {
      if (mode === 'signup' && error?.message === 'Failed to fetch') {
        const display_name = String(form.get('display_name') || '').trim();
        const school_level = Number(form.get('school_level') || 1);
        const county = String(form.get('county') || 'București');
        const studentPhoto = form.get('student_photo');
        const existingUser = state.localUsers.find((person) => person.email === email);
        if (existingUser) {
          toast('This email already has a local demo account.');
          return;
        }
        const localUser = {
          id: `local-${Date.now()}`,
          display_name,
          school_level,
          county,
          main_subject: 'Mathematics',
          subject_ratings: {},
          bio: '',
          lumen_balance: DEFAULT_SESSIONS,
          verified: false,
          student_id_photo_url: studentPhoto && studentPhoto.size ? await readDataUrl(studentPhoto) : '',
          profile_photo_url: '',
          password,
          email,
          sessions: 0
        };
        state.localUsers.push(localUser);
        state.profile = { ...localUser };
        state.people = state.localUsers.filter((person) => person.id !== localUser.id);
        state.view = 'discover';
        saveLocalState();
        toast('Supabase is unavailable, so this demo account was created locally.');
        render();
        return;
      }
      const message = error?.message === 'Failed to fetch'
        ? 'Could not reach Supabase. Check your internet connection and VITE_SUPABASE_URL.'
        : error.message || 'Something went wrong.';
      toast(message);
      }
  });
}

async function bootstrap() {
  readLocalState();
  if (!configured || !supabase) {
    state.view = 'discover';
    await fetchPeople();
    render();
    return;
  }

  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;
  if (session) {
    const { data: profileRow, error } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (!error && profileRow) {
      state.profile = profileRow;
    }
    await fetchPeople();
    await fetchReviews();
    await fetchConversations();
    await fetchFavorites();
    subscribeToMessages();
    subscribeToPresence();
  }

  render();
}

bootstrap();
