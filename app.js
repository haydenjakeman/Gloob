/* ============================================================
   GLOOB — UI rendering, routing, and event handling
   render() itself stays synchronous (it reads local caches from
   data.js). Anything that changes data is async: it awaits a
   Supabase call, refreshes the relevant cache, then calls render().
   ============================================================ */

let currentView = 'home';
let viewingProfileId = null;
let pendingAction = null; // callback to resume after a successful sign-in
let pendingMedia = null;  // { file, previewUrl, type: 'image' | 'video' } staged in the create view
let searchQuery = '';
let authMode = 'signin';
let feedTab = 'foryou';      // 'foryou' | 'following'
let profileTab = 'posts';    // 'posts' | 'videos'
const expandedComments = new Set();
const expandedMore = new Set();

const appContent = document.getElementById('appContent');
const authAreaMobile = document.getElementById('authAreaMobile');
const authAreaDesktop = document.getElementById('authAreaDesktop');
const modalRoot = document.getElementById('modalRoot');
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.querySelector('.sidebar-backdrop');

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function avatarHTML(user, opts) {
  opts = opts || {};
  const size = opts.size || 40;
  const cls = 'avatar' + (opts.recent ? ' recent' : '');
  const initial = user.displayName ? user.displayName[0].toUpperCase() : '?';
  const bg = user.avatarPhoto
    ? 'background-image:url(' + user.avatarPhoto + ');background-size:cover;background-position:center;'
    : 'background:' + (user.avatarColorOverride || hashColor(user.id)) + ';';
  const action = opts.static ? '' : ' data-action="view-profile" data-id="' + user.id + '"';
  return (
    '<div class="' + cls + '" style="width:' + size + 'px;height:' + size + 'px;' + bg +
    'font-size:' + Math.round(size * 0.4) + 'px"' + action + '>' +
    (user.avatarPhoto ? '' : esc(initial)) + '</div>'
  );
}

function verifiedBadge(user) {
  return user.verified ? ' <span class="verified-badge" title="Verified">\u2713</span>' : '';
}

function roleBadge(user) {
  if (user.role === 'owner') return ' <span class="role-badge owner">OWNER</span>';
  if (user.role === 'moderator') return ' <span class="role-badge mod">MOD</span>';
  return '';
}

function requireAuth(callback) {
  if (isSignedIn()) { callback(); return; }
  pendingAction = callback;
  openAuthModal();
}

// Attaches a press-and-hold gesture to `el`, firing `callback` after
// ~550ms if the pointer hasn't moved or been released.
function attachLongPress(el, callback) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const THRESHOLD_MS = 550;
  const MOVE_TOLERANCE = 10;

  function start(e) {
    const point = e.touches ? e.touches[0] : e;
    startX = point.clientX;
    startY = point.clientY;
    timer = setTimeout(() => { timer = null; callback(); }, THRESHOLD_MS);
  }
  function move(e) {
    if (!timer) return;
    const point = e.touches ? e.touches[0] : e;
    if (Math.abs(point.clientX - startX) > MOVE_TOLERANCE || Math.abs(point.clientY - startY) > MOVE_TOLERANCE) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mousemove', move);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}

/* ---------------- Sidebar (mobile drawer) ---------------- */

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('open');
}
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('open');
}

/* ---------------- Navigation ---------------- */

function navigate(view, opts) {
  opts = opts || {};
  currentView = view;
  if (opts.profileId) viewingProfileId = opts.profileId;
  render();
  window.scrollTo(0, 0);
  closeSidebar();
}

/* ---------------- Shell pieces ---------------- */

function renderAuthArea() {
  const html = isSignedIn()
    ? avatarHTML(currentUser, { size: 32 })
    : '<button class="btn btn-primary btn-sm" data-action="open-auth" type="button">Sign in</button>';
  authAreaMobile.innerHTML = html;
  authAreaDesktop.innerHTML = html;
}

function renderNav() {
  document.querySelectorAll('.sidebar-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === currentView);
  });
  const role = currentUser ? currentUser.role : null;
  const navMod = document.getElementById('navModeration');
  const navOwner = document.getElementById('navOwner');
  if (navMod) navMod.classList.toggle('hidden', !(role === 'owner' || role === 'moderator'));
  if (navOwner) navOwner.classList.toggle('hidden', role !== 'owner');
}

/* ---------------- Home ---------------- */

function renderHome() {
  const posts = feedTab === 'following' ? getFollowingFeed() : getFeed();
  const newestId = posts.length ? posts[0].id : null;

  let body;
  if (feedTab === 'following' && !isSignedIn()) {
    body = emptyState('Sign in to see posts from people you follow.');
  } else if (!posts.length) {
    body = emptyState(feedTab === 'following' ? 'Nobody you follow has posted yet.' : 'No posts yet — be the first to say something.');
  } else {
    body = posts.map((p) => postHTML(p, p.id === newestId)).join('');
  }

  return (
    '<section><h1 class="view-title">Home</h1>' +
    composePromptHTML() +
    '<div class="feed-tabs">' +
      '<button class="feed-tab ' + (feedTab === 'foryou' ? 'active' : '') + '" data-action="feed-tab" data-tab="foryou">For you</button>' +
      '<button class="feed-tab ' + (feedTab === 'following' ? 'active' : '') + '" data-action="feed-tab" data-tab="following">Following</button>' +
    '</div>' +
    body +
    '</section>'
  );
}

function composePromptHTML() {
  if (!isSignedIn()) {
    return '<div class="compose-prompt" data-action="open-auth"><span>Sign in to post something...</span></div>';
  }
  return (
    '<div class="compose-prompt" data-action="nav-create">' +
      avatarHTML(currentUser, { size: 36, static: true }) +
      "<span>What's happening?</span>" +
    '</div>'
  );
}

/* ---------------- Posts ---------------- */

function postHTML(post, isNewest) {
  const author = getUser(post.authorId);
  if (!author) return '';
  const liked = isLikedByMe(post);
  const showMore = isSignedIn() && canDeletePost(currentUser, post);
  const commentLabel = post.comments.length + (post.comments.length === 1 ? ' comment' : ' comments');
  return (
    '<article class="post" data-post-id="' + post.id + '">' +
      (showMore ? moreMenuHTML(post.id) : '') +
      '<div class="post-head">' +
        avatarHTML(author, { recent: isNewest }) +
        '<div class="info" data-action="view-profile" data-id="' + author.id + '">' +
          '<div class="name">' + esc(author.displayName) + verifiedBadge(author) + roleBadge(author) + '</div>' +
          '<div class="handle">@' + esc(author.username) + ' · ' + timeAgo(post.timestamp) + '</div>' +
        '</div>' +
      '</div>' +
      (post.text ? '<p class="post-text">' + esc(post.text) + '</p>' : '') +
      (post.imageUrl ? '<img class="post-media" src="' + post.imageUrl + '" alt="" />' : '') +
      (post.videoUrl ? '<video class="post-media" src="' + post.videoUrl + '" controls playsinline></video>' : '') +
      '<div class="post-actions">' +
        '<button class="action-btn' + (liked ? ' liked' : '') + '" data-action="toggle-like" data-id="' + post.id + '">' +
          (liked ? '\u2665' : '\u2661') + ' ' + post.likes.length +
        '</button>' +
        '<button class="action-btn" data-action="toggle-comments" data-id="' + post.id + '">' + commentLabel + '</button>' +
      '</div>' +
      '<div class="comments' + (expandedComments.has(post.id) ? '' : ' hidden') + '" id="comments-' + post.id + '">' +
        post.comments.map(commentHTML).join('') +
        '<div class="comment-input-row">' +
          '<input type="text" placeholder="' + (isSignedIn() ? 'Write a comment...' : 'Sign in to comment') + '" data-comment-input="' + post.id + '" />' +
          '<button class="btn btn-primary btn-sm" data-action="add-comment" data-id="' + post.id + '">Post</button>' +
        '</div>' +
      '</div>' +
    '</article>'
  );
}

function moreMenuHTML(postId) {
  return (
    '<div class="post-more">' +
      '<button class="more-btn" data-action="toggle-more" data-id="' + postId + '">\u22EF</button>' +
      '<div class="more-menu' + (expandedMore.has(postId) ? '' : ' hidden') + '" id="more-' + postId + '">' +
        '<button data-action="delete-post" data-id="' + postId + '">Delete</button>' +
      '</div>' +
    '</div>'
  );
}

function commentHTML(c) {
  const author = getUser(c.authorId);
  if (!author) return '';
  return (
    '<div class="comment">' +
      avatarHTML(author, { size: 28 }) +
      '<div><span class="name">' + esc(author.displayName) + verifiedBadge(author) + '</span> ' +
      '<span class="text">' + esc(c.text) + '</span></div>' +
    '</div>'
  );
}

/* ---------------- Explore ---------------- */

function renderExplore() {
  const recs = getRecommended(10);
  const tags = ['#pcbuild', '#indiedev', '#firstpost', '#latenight', '#wip'];
  return (
    '<section><h1 class="view-title">Explore</h1>' +
    '<h2 class="section-label">Who to follow</h2>' +
    (recs.length ? recs.map(userRowHTML).join('') : emptyState("You're following everyone already!")) +
    '<h2 class="section-label">Trending</h2>' +
    '<div class="tag-row">' + tags.map((t) => '<span class="tag">' + t + '</span>').join('') + '</div>' +
    '</section>'
  );
}

function userRowHTML(user) {
  const following = isFollowing(user.id);
  const isSelf = currentUser && currentUser.id === user.id;
  return (
    '<div class="user-row">' +
      avatarHTML(user) +
      '<div class="info" data-action="view-profile" data-id="' + user.id + '">' +
        '<div class="name">' + esc(user.displayName) + verifiedBadge(user) + roleBadge(user) + '</div>' +
        '<div class="handle">@' + esc(user.username) + '</div>' +
        (user.bio ? '<div class="bio">' + esc(user.bio) + '</div>' : '') +
      '</div>' +
      (isSelf ? '' : '<button class="btn btn-sm ' + (following ? 'btn-following' : 'btn-primary') + '" data-action="follow" data-id="' + user.id + '">' + (following ? 'Following' : 'Follow') + '</button>') +
    '</div>'
  );
}

/* ---------------- Search ---------------- */

function renderSearch() {
  return (
    '<section><h1 class="view-title">Search</h1>' +
    '<input type="text" class="search-field" id="searchField" placeholder="Search people and posts..." value="' + esc(searchQuery) + '" />' +
    '<div id="searchResults">' + searchResultsHTML(searchQuery) + '</div>' +
    '</section>'
  );
}

function searchResultsHTML(query) {
  if (!query.trim()) return emptyState('Start typing to search Gloob.');
  const result = searchAll(query);
  if (!result.users.length && !result.posts.length) return emptyState('No matches.');
  let html = '';
  if (result.users.length) html += '<h2 class="section-label">People</h2>' + result.users.map(userRowHTML).join('');
  if (result.posts.length) html += '<h2 class="section-label">Posts</h2>' + result.posts.map((p) => postHTML(p, false)).join('');
  return html;
}

/* ---------------- Create ---------------- */

function renderCreate() {
  if (!isSignedIn()) {
    return '<section>' + emptyState('Sign in to create a post.') + '<div class="center-btn"><button class="btn btn-primary" data-action="open-auth">Sign in</button></div></section>';
  }
  return (
    '<section><h1 class="view-title">Create</h1>' +
    '<textarea id="createText" class="create-text" placeholder="What\'s happening?" rows="4"></textarea>' +
    '<div class="attach-row">' +
      '<label class="image-attach"><input type="file" id="mediaImageInput" accept="image/*" hidden /><span class="btn btn-outline btn-sm">Attach image</span></label>' +
      '<label class="video-attach"><input type="file" id="mediaVideoInput" accept="video/*" hidden /><span class="btn btn-outline btn-sm">Attach video</span></label>' +
    '</div>' +
    '<div id="mediaPreviewWrap">' + (pendingMedia ? mediaPreviewHTML() : '') + '</div>' +
    '<div id="createError" class="auth-error"></div>' +
    '<button class="btn btn-primary create-submit" data-action="submit-post">Post</button>' +
    '</section>'
  );
}

function mediaPreviewHTML() {
  if (!pendingMedia) return '';
  const tag = pendingMedia.type === 'image'
    ? '<img src="' + pendingMedia.previewUrl + '" alt="" />'
    : '<video src="' + pendingMedia.previewUrl + '" controls playsinline></video>';
  return tag + '<button type="button" class="btn btn-outline btn-sm clear-media-btn" data-action="clear-media">Remove</button>';
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  const u = currentUser;
  const theme = document.documentElement.dataset.theme || 'dark';
  let html = '<section><h1 class="view-title">Settings</h1>';

  html += '<div class="settings-section"><h3>Account</h3>';
  html += u
    ? '<p>Signed in as <strong>@' + esc(u.username) + '</strong></p><button class="btn btn-outline" data-action="sign-out">Sign out</button>'
    : "<p>You're browsing as a guest.</p><button class=\"btn btn-primary\" data-action=\"open-auth\">Sign in</button>";
  html += '</div>';

  if (u) {
    html +=
      '<div class="settings-section"><h3>Profile</h3>' +
      avatarEditorHTML(u) +
      '<div class="field"><label>Username</label><input type="text" id="settingsUsername" value="' + esc(u.username) + '" /></div>' +
      '<div class="field"><label>Display name</label><input type="text" id="settingsName" value="' + esc(u.displayName) + '" /></div>' +
      '<div class="field"><label>Bio</label><textarea id="settingsBio" rows="2">' + esc(u.bio || '') + '</textarea></div>' +
      '<div id="settingsError" class="auth-error"></div>' +
      '<button class="btn btn-primary btn-sm" data-action="save-profile">Save</button>' +
      '</div>';
  }

  html +=
    '<div class="settings-section"><h3>Appearance</h3>' +
    '<div class="theme-toggle-row"><span>Dark mode</span>' +
    '<label class="switch"><input type="checkbox" id="themeToggle" ' + (theme === 'dark' ? 'checked' : '') + ' />' +
    '<span class="slider"></span></label></div></div>';

  html += '</section>';
  return html;
}

function avatarEditorHTML(u) {
  const colors = ['#ff5d7a', '#7c5cff', '#3ddc97', '#ffb020', '#3ea8ff', '#ff8a5c'];
  return (
    '<div class="avatar-editor">' +
      avatarHTML(u, { size: 64, static: true }) +
      '<div>' +
        '<label class="btn btn-outline btn-sm">Upload photo<input type="file" id="avatarPhotoInput" accept="image/*" hidden /></label>' +
        '<div class="avatar-swatches">' +
          colors.map((c) => '<span class="avatar-swatch' + (u.avatarColorOverride === c && !u.avatarPhoto ? ' selected' : '') + '" data-action="pick-avatar-color" data-color="' + c + '" style="background:' + c + '"></span>').join('') +
        '</div>' +
      '</div>' +
    '</div>'
  );
}

/* ---------------- Profile ---------------- */

function renderProfile(id) {
  const user = id ? getUser(id) : null;
  if (!user) {
    return '<section>' + emptyState('Sign in to see your profile.') + '<div class="center-btn"><button class="btn btn-primary" data-action="open-auth">Sign in</button></div></section>';
  }
  const allPosts = getPostsByUser(user.id);
  const videoPosts = allPosts.filter((p) => p.videoUrl);
  const following = isFollowing(user.id);
  const isSelf = currentUser && currentUser.id === user.id;
  const canModerateThisUser = !isSelf && currentUser && (currentUser.role === 'owner' || currentUser.role === 'moderator') && canModerateUser(currentUser, user);

  const body = profileTab === 'videos'
    ? (videoPosts.length ? '<div class="video-grid">' + videoPosts.map(videoGridItemHTML).join('') + '</div>' : emptyState('No videos yet.'))
    : (allPosts.length ? allPosts.map((p) => postHTML(p, false)).join('') : emptyState('No posts yet.'));

  return (
    '<section>' +
    (isSelf && isBannedNow(user) ? '<div class="ban-banner">Your account is banned' + (user.banExpiresAt ? ' until ' + new Date(user.banExpiresAt).toLocaleString() : '') + '.</div>' : '') +
    '<div class="profile-head">' +
      avatarHTML(user, { size: 88, static: true }) +
      '<h1 class="view-title">' + esc(user.displayName) + verifiedBadge(user) + roleBadge(user) + '</h1>' +
      '<div class="handle">@' + esc(user.username) + '</div>' +
      (user.bio ? '<p class="bio">' + esc(user.bio) + '</p>' : '') +
      '<div class="stat-row"><span><strong>' + followerCount(user.id) + '</strong> followers</span>' +
      '<span><strong>' + followingCountOf(user.id) + '</strong> following</span>' +
      '<span><strong>' + user.credits + '</strong> credits</span></div>' +
      (isSelf
        ? '<button class="btn btn-outline" data-action="nav-settings">Edit profile</button>'
        : '<button class="btn ' + (following ? 'btn-following' : 'btn-primary') + '" data-action="follow" data-id="' + user.id + '">' + (following ? 'Following' : 'Follow') + '</button>') +
      (canModerateThisUser ? ' <button class="btn btn-outline" data-action="open-modmenu" data-id="' + user.id + '">Moderate</button>' : '') +
      (isSelf ? '' : ' <button class="btn-link" data-action="open-report" data-id="' + user.id + '">Report</button>') +
    '</div>' +
    '<div class="profile-tabs">' +
      '<button class="feed-tab ' + (profileTab === 'posts' ? 'active' : '') + '" data-action="profile-tab" data-tab="posts">Posts</button>' +
      '<button class="feed-tab ' + (profileTab === 'videos' ? 'active' : '') + '" data-action="profile-tab" data-tab="videos">Videos</button>' +
    '</div>' +
    body +
    '</section>'
  );
}

function videoGridItemHTML(post) {
  return (
    '<div class="video-grid-item" data-action="open-video" data-id="' + post.id + '">' +
      '<video src="' + post.videoUrl + '" muted preload="metadata" playsinline></video>' +
      '<span class="play-badge">\u25B6</span>' +
    '</div>'
  );
}

function emptyState(msg) {
  return '<p class="empty-state">' + esc(msg) + '</p>';
}

/* ---------------- Moderate menu (long-press or "Moderate" button) ---------------- */

function openModerateMenu(targetId) {
  const target = getUser(targetId);
  const actor = currentUser;
  if (!target || !actor) return;
  const isOwner = actor.role === 'owner';
  let actions = '';

  if (isBannedNow(target)) {
    actions += '<button class="btn btn-outline" data-action="mod-unban" data-id="' + target.id + '">Unban</button>';
  } else {
    actions += isOwner
      ? '<button class="btn btn-outline" data-action="mod-ban" data-id="' + target.id + '" data-days="">Ban</button>'
      : '<button class="btn btn-outline" data-action="mod-ban" data-id="' + target.id + '" data-days="3">Ban 3 days</button>';
  }

  if (isOwner) {
    actions += target.role === 'moderator'
      ? '<button class="btn btn-outline" data-action="mod-demote" data-id="' + target.id + '">Remove moderator</button>'
      : '<button class="btn btn-outline" data-action="mod-promote" data-id="' + target.id + '">Make moderator</button>';
  }

  actions += target.verified
    ? '<button class="btn btn-outline" data-action="mod-unverify" data-id="' + target.id + '">Remove verification</button>'
    : '<button class="btn btn-outline" data-action="mod-verify" data-id="' + target.id + '">Verify (green tick)</button>';

  modalRoot.innerHTML =
    '<div class="modal-backdrop" data-action="close-modmenu">' +
      '<div class="modal">' +
        '<h3 style="margin-top:0">Moderate @' + esc(target.username) + '</h3>' +
        '<div class="mod-menu-actions">' + actions + '</div>' +
        '<div id="modMenuError" class="auth-error"></div>' +
      '</div>' +
    '</div>';
}

function openReportModal(targetId) {
  modalRoot.innerHTML =
    '<div class="modal-backdrop" data-action="close-report">' +
      '<div class="modal">' +
        '<h3 style="margin-top:0">Report this account</h3>' +
        '<div class="field"><label>Reason</label><textarea id="reportReason" rows="3" placeholder="What\'s going on?"></textarea></div>' +
        '<div id="reportError" class="auth-error"></div>' +
        '<button class="btn btn-primary" data-action="submit-report" data-id="' + targetId + '" style="width:100%">Submit report</button>' +
      '</div>' +
    '</div>';
}

/* ---------------- Moderation queue ---------------- */

function renderModeration() {
  if (!currentUser || (currentUser.role !== 'owner' && currentUser.role !== 'moderator')) {
    return '<section>' + emptyState('Not authorized.') + '</section>';
  }
  const queue = getModerationQueue(currentUser);
  return (
    '<section><h1 class="view-title">Moderation queue</h1>' +
    (queue.length ? queue.map(moderationCaseHTML).join('') : emptyState('No flagged accounts right now.')) +
    '</section>'
  );
}

function moderationCaseHTML(user) {
  const reportsHTML = user.reports.map((r) => {
    const reporter = getUser(r.reporterId);
    return '<div class="report-line">reported by <strong>@' + esc(reporter ? reporter.username : 'unknown') + '</strong>: ' + esc(r.reason) + '</div>';
  }).join('');
  const isOwner = currentUser.role === 'owner';
  return (
    '<div class="mod-case">' +
      '<div class="user-row">' + avatarHTML(user) +
        '<div class="info" data-action="view-profile" data-id="' + user.id + '">' +
          '<div class="name">' + esc(user.displayName) + verifiedBadge(user) + '</div>' +
          '<div class="handle">@' + esc(user.username) + ' · ' + user.reports.length + ' reports</div>' +
        '</div>' +
      '</div>' +
      '<div class="report-list">' + reportsHTML + '</div>' +
      '<div class="mod-case-actions">' +
        '<button class="btn btn-outline btn-sm" data-action="mod-ban" data-id="' + user.id + '" data-days="' + (isOwner ? '' : '3') + '">' + (isOwner ? 'Ban' : 'Ban 3 days') + '</button>' +
        '<button class="btn btn-outline btn-sm" data-action="dismiss-report" data-id="' + user.id + '">Dismiss</button>' +
      '</div>' +
    '</div>'
  );
}

/* ---------------- Owner panel ---------------- */

function renderOwnerPanel() {
  if (!currentUser || currentUser.role !== 'owner') {
    return '<section>' + emptyState('Not authorized.') + '</section>';
  }
  const others = cachedUsers.filter((u) => u.id !== currentUser.id);
  return (
    '<section><h1 class="view-title">Owner panel</h1>' +
    (others.length ? others.map(ownerRowHTML).join('') : emptyState('No other accounts yet.')) +
    '</section>'
  );
}

function ownerRowHTML(user) {
  const banStatus = isBannedNow(user)
    ? (user.banExpiresAt ? 'Banned until ' + new Date(user.banExpiresAt).toLocaleDateString() : 'Banned (permanent)')
    : 'Not banned';
  return (
    '<div class="owner-row">' +
      '<div class="user-row">' + avatarHTML(user) +
        '<div class="info" data-action="view-profile" data-id="' + user.id + '">' +
          '<div class="name">' + esc(user.displayName) + verifiedBadge(user) + roleBadge(user) + '</div>' +
          '<div class="handle">@' + esc(user.username) + ' · ' + banStatus + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="owner-row-controls">' +
        '<div class="field"><label>Credits</label><input type="number" class="credits-input" data-id="' + user.id + '" value="' + user.credits + '" /></div>' +
        '<button class="btn btn-outline btn-sm" data-action="save-credits" data-id="' + user.id + '">Save credits</button>' +
        (user.role === 'moderator'
          ? '<button class="btn btn-outline btn-sm" data-action="mod-demote" data-id="' + user.id + '">Remove moderator</button>'
          : '<button class="btn btn-outline btn-sm" data-action="mod-promote" data-id="' + user.id + '">Make moderator</button>') +
        (isBannedNow(user)
          ? '<button class="btn btn-outline btn-sm" data-action="mod-unban" data-id="' + user.id + '">Unban</button>'
          : '<button class="btn btn-outline btn-sm" data-action="mod-ban" data-id="' + user.id + '" data-days="">Ban</button>') +
        (user.verified
          ? '<button class="btn btn-outline btn-sm" data-action="mod-unverify" data-id="' + user.id + '">Remove tick</button>'
          : '<button class="btn btn-outline btn-sm" data-action="mod-verify" data-id="' + user.id + '">Verify</button>') +
      '</div>' +
    '</div>'
  );
}

/* ---------------- Lightbox (tapped video from a profile grid) ---------------- */

function openVideoLightbox(postId) {
  const post = cachedPosts.find((p) => p.id === postId);
  if (!post) return;
  const author = getUser(post.authorId);
  if (!author) return;
  modalRoot.innerHTML =
    '<div class="modal-backdrop" data-action="close-lightbox">' +
      '<div class="modal lightbox-modal">' +
        '<button class="lightbox-close" data-action="close-lightbox">Close</button>' +
        '<video src="' + post.videoUrl + '" controls autoplay playsinline></video>' +
        '<div class="lightbox-info">' +
          avatarHTML(author, { size: 36, static: true }) +
          '<div><div class="name">' + esc(author.displayName) + '</div>' +
          (post.text ? '<p class="post-text">' + esc(post.text) + '</p>' : '') + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
}

function closeLightbox() {
  modalRoot.innerHTML = '';
}

/* ---------------- Auth modal ---------------- */

function openAuthModal() {
  authMode = 'signin';
  renderAuthModal();
}

function closeAuthModal() {
  modalRoot.innerHTML = '';
  pendingAction = null;
}

function closeAuthModalAfterSuccess() {
  const cb = pendingAction;
  pendingAction = null;
  modalRoot.innerHTML = '';
  return cb;
}

function renderAuthModal() {
  const isSigninMode = authMode === 'signin';
  modalRoot.innerHTML =
    '<div class="modal-backdrop" data-action="close-auth">' +
      '<div class="modal">' +
        '<div class="modal-tabs">' +
          '<button class="tab ' + (isSigninMode ? 'active' : '') + '" data-action="auth-tab" data-mode="signin">Sign in</button>' +
          '<button class="tab ' + (!isSigninMode ? 'active' : '') + '" data-action="auth-tab" data-mode="signup">Sign up</button>' +
        '</div>' +
        '<div id="authError" class="auth-error"></div>' +
        '<div class="field"><label>Username</label><input type="text" id="authUsername" autocomplete="username" /></div>' +
        (isSigninMode ? '' : '<div class="field"><label>Display name</label><input type="text" id="authDisplayName" /></div>') +
        '<div class="field"><label>Password</label><input type="password" id="authPassword" autocomplete="' + (isSigninMode ? 'current-password' : 'new-password') + '" /></div>' +
        '<button class="btn btn-primary" data-action="' + (isSigninMode ? 'do-signin' : 'do-signup') + '" style="width:100%">' + (isSigninMode ? 'Sign in' : 'Create account') + '</button>' +
        '<p class="modal-note">Real account on your Supabase project.</p>' +
      '</div>' +
    '</div>';
}

/* ---------------- Event delegation ---------------- */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case 'toggle-sidebar': sidebar.classList.contains('open') ? closeSidebar() : openSidebar(); break;
    case 'close-sidebar': closeSidebar(); break;

    case 'nav-home': navigate('home'); break;
    case 'nav-explore': navigate('explore'); break;
    case 'nav-search': navigate('search'); break;
    case 'nav-create': navigate('create'); break;
    case 'nav-settings': navigate('settings'); break;
    case 'nav-moderation': navigate('moderation'); break;
    case 'nav-owner': navigate('owner'); break;
    case 'nav-profile':
      if (isSignedIn()) navigate('profile', { profileId: currentUser.id });
      else openAuthModal();
      break;
    case 'view-profile': navigate('profile', { profileId: id }); break;

    case 'open-auth': openAuthModal(); break;
    case 'close-auth': if (e.target === el) closeAuthModal(); break;
    case 'auth-tab': authMode = el.dataset.mode; renderAuthModal(); break;

    case 'do-signin': {
      const username = document.getElementById('authUsername').value;
      const password = document.getElementById('authPassword').value;
      el.disabled = true; el.textContent = 'Signing in...';
      const result = await signIn(username, password);
      el.disabled = false; el.textContent = 'Sign in';
      if (result.error) {
        document.getElementById('authError').textContent = result.error;
      } else {
        const cb = closeAuthModalAfterSuccess();
        render();
        if (cb) cb();
      }
      break;
    }
    case 'do-signup': {
      const username = document.getElementById('authUsername').value;
      const displayName = document.getElementById('authDisplayName').value;
      const password = document.getElementById('authPassword').value;
      el.disabled = true; el.textContent = 'Creating account...';
      const result = await signUp(username, displayName, password);
      el.disabled = false; el.textContent = 'Create account';
      if (result.error) {
        document.getElementById('authError').textContent = result.error;
      } else {
        const cb = closeAuthModalAfterSuccess();
        render();
        if (cb) cb();
      }
      break;
    }
    case 'sign-out': await signOut(); navigate('home'); break;

    case 'follow': requireAuth(async () => { await toggleFollow(id); render(); }); break;
    case 'toggle-like': requireAuth(async () => { await toggleLike(id); render(); }); break;

    case 'toggle-comments': {
      if (expandedComments.has(id)) expandedComments.delete(id);
      else expandedComments.add(id);
      const box = document.getElementById('comments-' + id);
      if (box) box.classList.toggle('hidden');
      break;
    }
    case 'add-comment': {
      const input = document.querySelector('[data-comment-input="' + id + '"]');
      const text = input ? input.value : '';
      requireAuth(async () => {
        const result = await addComment(id, text);
        if (!result.error) render();
      });
      break;
    }

    case 'toggle-more': {
      if (expandedMore.has(id)) expandedMore.delete(id);
      else expandedMore.add(id);
      const menu = document.getElementById('more-' + id);
      if (menu) menu.classList.toggle('hidden');
      break;
    }
    case 'delete-post': {
      const result = await deletePost(id);
      if (!result.error) {
        expandedMore.delete(id);
        expandedComments.delete(id);
        render();
      }
      break;
    }

    case 'feed-tab': feedTab = el.dataset.tab; render(); break;
    case 'profile-tab': profileTab = el.dataset.tab; render(); break;

    case 'open-video': openVideoLightbox(id); break;
    case 'close-lightbox': if (e.target === el) closeLightbox(); break;

    case 'open-modmenu': openModerateMenu(id); break;
    case 'close-modmenu': if (e.target === el) modalRoot.innerHTML = ''; break;
    case 'mod-ban': {
      const days = el.dataset.days ? Number(el.dataset.days) : null;
      const result = await banUser(id, days);
      if (result.error) { const err = document.getElementById('modMenuError'); if (err) err.textContent = result.error; }
      else { modalRoot.innerHTML = ''; render(); }
      break;
    }
    case 'mod-unban': {
      const result = await unbanUser(id);
      if (!result.error) { modalRoot.innerHTML = ''; render(); }
      break;
    }
    case 'mod-promote': await promoteModerator(id); modalRoot.innerHTML = ''; render(); break;
    case 'mod-demote': await demoteModerator(id); modalRoot.innerHTML = ''; render(); break;
    case 'mod-verify': await setVerified(id, true); modalRoot.innerHTML = ''; render(); break;
    case 'mod-unverify': await setVerified(id, false); modalRoot.innerHTML = ''; render(); break;

    case 'open-report': requireAuth(() => openReportModal(id)); break;
    case 'close-report': if (e.target === el) modalRoot.innerHTML = ''; break;
    case 'submit-report': {
      const reason = document.getElementById('reportReason').value;
      const result = await reportUser(id, reason);
      const errEl = document.getElementById('reportError');
      if (result.error) { errEl.textContent = result.error; }
      else { modalRoot.innerHTML = ''; }
      break;
    }
    case 'dismiss-report': {
      const result = await dismissReports(id);
      if (!result.error) render();
      break;
    }

    case 'clear-media': {
      if (pendingMedia && pendingMedia.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
      pendingMedia = null;
      const wrap = document.getElementById('mediaPreviewWrap');
      if (wrap) wrap.innerHTML = '';
      break;
    }
    case 'submit-post': {
      const text = document.getElementById('createText').value;
      el.disabled = true; el.textContent = 'Posting...';
      const result = await createPost(text, pendingMedia ? pendingMedia.file : null, pendingMedia ? pendingMedia.type : null);
      el.disabled = false; el.textContent = 'Post';
      if (result.error) {
        const err = document.getElementById('createError');
        if (err) err.textContent = result.error;
      } else {
        if (pendingMedia && pendingMedia.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
        pendingMedia = null;
        navigate('home');
      }
      break;
    }

    case 'pick-avatar-color': await setAvatarColor(el.dataset.color); render(); break;

    case 'save-profile': {
      const result = await updateProfile({
        username: document.getElementById('settingsUsername').value,
        displayName: document.getElementById('settingsName').value,
        bio: document.getElementById('settingsBio').value,
      });
      const errorEl = document.getElementById('settingsError');
      if (result.error) { errorEl.textContent = result.error; }
      else { errorEl.textContent = ''; render(); }
      break;
    }

    case 'save-credits': {
      const input = document.querySelector('.credits-input[data-id="' + id + '"]');
      const result = await setCredits(id, input ? input.value : '');
      if (!result.error) render();
      break;
    }
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'mediaImageInput' || e.target.id === 'mediaVideoInput') {
    const file = e.target.files[0];
    if (!file) return;
    if (pendingMedia && pendingMedia.previewUrl) URL.revokeObjectURL(pendingMedia.previewUrl);
    const type = e.target.id === 'mediaImageInput' ? 'image' : 'video';
    pendingMedia = { file, previewUrl: URL.createObjectURL(file), type };
    const wrap = document.getElementById('mediaPreviewWrap');
    if (wrap) wrap.innerHTML = mediaPreviewHTML();
  }
  if (e.target.id === 'avatarPhotoInput') {
    const file = e.target.files[0];
    if (!file || !isSignedIn()) return;
    const result = await setAvatarPhoto(file);
    if (!result.error) render();
  }
  if (e.target.id === 'themeToggle') {
    document.documentElement.dataset.theme = e.target.checked ? 'dark' : 'light';
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'searchField') {
    searchQuery = e.target.value;
    const results = document.getElementById('searchResults');
    if (results) results.innerHTML = searchResultsHTML(searchQuery);
  }
});

/* ---------------- Main render ---------------- */

function render() {
  renderNav();
  renderAuthArea();
  let html = '';
  switch (currentView) {
    case 'home': html = renderHome(); break;
    case 'explore': html = renderExplore(); break;
    case 'search': html = renderSearch(); break;
    case 'create': html = renderCreate(); break;
    case 'settings': html = renderSettings(); break;
    case 'moderation': html = renderModeration(); break;
    case 'owner': html = renderOwnerPanel(); break;
    case 'profile': html = renderProfile(viewingProfileId); break;
  }
  appContent.innerHTML = html;
  afterRender();
}

function afterRender() {
  if (currentView === 'profile') {
    const target = getUser(viewingProfileId);
    if (target && currentUser && target.id !== currentUser.id) {
      const canAct = (currentUser.role === 'owner' || currentUser.role === 'moderator') && canModerateUser(currentUser, target);
      if (canAct) {
        const head = document.querySelector('.profile-head');
        if (head) attachLongPress(head, () => openModerateMenu(target.id));
      }
    }
  }
}

/* ---------------- Init ---------------- */

document.documentElement.dataset.theme = 'dark';
appContent.innerHTML = '<p class="empty-state">Loading Gloob…</p>';

async function init() {
  await refreshSession();
  await refreshAll();
  render();
}
init();

sb.auth.onAuthStateChange(async () => {
  await refreshSession();
  await refreshFollows();
  await refreshReportsForQueue();
  render();
});
