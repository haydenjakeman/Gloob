/* ============================================================
   GLOOB — data layer, backed by a real Supabase project
   ============================================================
   Reads are served from local caches (cachedUsers, cachedPosts,
   etc.) so the existing synchronous render() functions in app.js
   don't need to change. The caches are refreshed from Supabase
   after sign-in and after every action that changes data — that
   refresh step is the async part, done in the action handlers
   in app.js.

   OWNER ACCOUNT: "gloob" is a reserved username — a database
   trigger automatically makes whoever signs up with that exact
   username the owner. There's no password stored in this file.

   Auth note: Supabase Auth is email-based. To keep the "sign in
   with just a username" experience, this file quietly builds a
   fake email like "yourname@gloob.local" behind the scenes — you
   still only ever see/type a username.
   ============================================================ */

const SUPABASE_URL = 'https://arbkoywsslprhfzmdrid.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_tPvge6pUUKwo-7hRplCsOg_ogjy7WGI';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function hashColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return 'hsl(' + hue + ', 65%, 45%)';
}

function usernameToEmail(username) {
  return username.trim().toLowerCase() + '@gloob.local';
}

/* ---------------- Local caches (what render() reads) ---------------- */

let currentUser = null;   // normalized profile row, or null
let cachedUsers = [];     // normalized profile rows
let cachedPosts = [];     // normalized post rows (with likes + comments embedded)
let allFollows = [];      // [{follower_id, following_id}]
let cachedFollowing = new Set(); // ids currentUser follows
let cachedReports = [];   // raw report rows, only populated for owner/mod (RLS-limited)

function normalizeUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    bio: u.bio || '',
    avatarPhoto: u.avatar_photo_url || null,
    avatarColorOverride: u.avatar_color || null,
    role: u.role,
    credits: u.credits,
    verified: u.verified,
    banned: u.banned,
    banExpiresAt: u.ban_expires_at ? new Date(u.ban_expires_at).getTime() : null,
    assignedModeratorId: u.assigned_moderator_id,
    reports: [],
  };
}

function normalizePost(p) {
  return {
    id: p.id,
    authorId: p.author_id,
    text: p.text || '',
    imageUrl: p.image_url,
    videoUrl: p.video_url,
    timestamp: new Date(p.created_at).getTime(),
    likes: (p.likes || []).map((l) => l.user_id),
    comments: (p.comments || [])
      .map((c) => ({ id: c.id, authorId: c.author_id, text: c.text, timestamp: new Date(c.created_at).getTime() }))
      .sort((a, b) => a.timestamp - b.timestamp),
  };
}

/* ---------------- Refreshing caches from Supabase ---------------- */

async function refreshSession() {
  const { data } = await sb.auth.getSession();
  if (!data.session) { currentUser = null; return; }
  const { data: profile } = await sb.from('profiles').select('*').eq('id', data.session.user.id).single();
  currentUser = profile ? normalizeUser(profile) : null;
}

async function refreshUsers() {
  const { data } = await sb.from('profiles').select('*');
  cachedUsers = (data || []).map(normalizeUser);
  if (currentUser) {
    const fresh = cachedUsers.find((u) => u.id === currentUser.id);
    if (fresh) currentUser = fresh;
  }
}

async function refreshPosts() {
  const { data } = await sb
    .from('posts')
    .select('*, likes(user_id), comments(id, author_id, text, created_at)')
    .order('created_at', { ascending: false });
  cachedPosts = (data || []).map(normalizePost);
}

async function refreshFollows() {
  const { data } = await sb.from('follows').select('follower_id, following_id');
  allFollows = data || [];
  cachedFollowing = new Set(currentUser ? allFollows.filter((f) => f.follower_id === currentUser.id).map((f) => f.following_id) : []);
}

async function refreshReportsForQueue() {
  if (!currentUser || (currentUser.role !== 'owner' && currentUser.role !== 'moderator')) { cachedReports = []; return; }
  const { data } = await sb.from('reports').select('*').order('created_at', { ascending: true });
  cachedReports = data || [];
}

async function refreshAll() {
  await Promise.all([refreshUsers(), refreshPosts(), refreshFollows()]);
  await refreshReportsForQueue();
}

/* ---------------- Auth ---------------- */

function isSignedIn() {
  return !!currentUser;
}

function isBannedNow(user) {
  if (!user.banned) return false;
  if (user.banExpiresAt === null) return true;
  return user.banExpiresAt > Date.now();
}

function friendlyAuthError(error) {
  const msg = (error && error.message) || '';
  if (msg.indexOf('already registered') !== -1) return 'That username is taken.';
  if (msg.indexOf('Invalid login') !== -1) return 'Wrong username or password.';
  if (msg.indexOf('Email not confirmed') !== -1) {
    return "This project still has email confirmation on, so accounts can't sign in yet. See README.md — it's a one-time toggle in the Supabase dashboard.";
  }
  return msg || 'Something went wrong.';
}

async function signUp(username, displayName, password) {
  username = (username || '').trim().toLowerCase();
  displayName = (displayName || '').trim();
  if (!username || !displayName || !password) return { error: 'Fill in every field.' };

  const { data, error } = await sb.auth.signUp({
    email: usernameToEmail(username),
    password,
    options: { data: { username, display_name: displayName } },
  });
  if (error) return { error: friendlyAuthError(error) };
  if (!data.session) {
    return { error: "Account created, but no session came back — check that email confirmation is off (see README.md)." };
  }
  await refreshSession();
  await refreshAll();
  return { user: currentUser };
}

async function signIn(username, password) {
  username = (username || '').trim().toLowerCase();
  const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password });
  if (error) return { error: friendlyAuthError(error) };
  await refreshSession();
  if (currentUser && isBannedNow(currentUser)) {
    const msg = currentUser.banExpiresAt
      ? 'This account is banned until ' + new Date(currentUser.banExpiresAt).toLocaleString() + '.'
      : 'This account has been banned.';
    await sb.auth.signOut();
    currentUser = null;
    return { error: msg };
  }
  await refreshAll();
  return { user: currentUser };
}

async function signOut() {
  await sb.auth.signOut();
  currentUser = null;
  cachedReports = [];
  cachedFollowing = new Set();
}

/* ---------------- Profile ---------------- */

async function updateProfile(updates) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  const patch = {};
  if (updates.username !== undefined) {
    const uname = updates.username.trim().toLowerCase();
    if (!uname) return { error: 'Username cannot be empty.' };
    patch.username = uname;
  }
  if (updates.displayName !== undefined) {
    const name = updates.displayName.trim();
    if (!name) return { error: 'Display name cannot be empty.' };
    patch.display_name = name;
  }
  if (updates.bio !== undefined) patch.bio = updates.bio.trim();

  const { error } = await sb.from('profiles').update(patch).eq('id', currentUser.id);
  if (error) return { error: error.message.indexOf('duplicate') !== -1 ? 'That username is taken.' : error.message };
  await refreshSession();
  await refreshUsers();
  return { user: currentUser };
}

async function setAvatarPhoto(file) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  const path = 'avatars/' + currentUser.id + '-' + Date.now() + '-' + file.name;
  const { error: upErr } = await sb.storage.from('media').upload(path, file, { upsert: true });
  if (upErr) return { error: upErr.message };
  const { data: pub } = sb.storage.from('media').getPublicUrl(path);
  const { error } = await sb.from('profiles').update({ avatar_photo_url: pub.publicUrl, avatar_color: null }).eq('id', currentUser.id);
  if (error) return { error: error.message };
  await refreshSession();
  await refreshUsers();
  return { ok: true };
}

async function setAvatarColor(color) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  const { error } = await sb.from('profiles').update({ avatar_color: color, avatar_photo_url: null }).eq('id', currentUser.id);
  if (error) return { error: error.message };
  await refreshSession();
  await refreshUsers();
  return { ok: true };
}

/* ---------------- Users ---------------- */

function getUser(id) {
  return cachedUsers.find((u) => u.id === id) || null;
}

function getRecommended(limit) {
  limit = limit || 6;
  return cachedUsers
    .filter((u) => !currentUser || (u.id !== currentUser.id && !cachedFollowing.has(u.id)))
    .slice(0, limit);
}

function isFollowing(userId) {
  return cachedFollowing.has(userId);
}

function followerCount(userId) {
  return allFollows.filter((f) => f.following_id === userId).length;
}

function followingCountOf(userId) {
  return allFollows.filter((f) => f.follower_id === userId).length;
}

async function toggleFollow(userId) {
  if (!isSignedIn()) return;
  if (cachedFollowing.has(userId)) {
    await sb.from('follows').delete().eq('follower_id', currentUser.id).eq('following_id', userId);
  } else {
    await sb.from('follows').insert({ follower_id: currentUser.id, following_id: userId });
  }
  await refreshFollows();
}

/* ---------------- Roles & moderation ---------------- */

function canModerateUser(actor, target) {
  if (!actor || !target) return false;
  if (actor.id === target.id) return false;
  if (target.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  if (actor.role === 'moderator') return target.role === 'member';
  return false;
}

async function banUser(targetId, days) {
  const { error } = await sb.rpc('admin_ban_user', { target_id: targetId, days: days || null });
  if (error) return { error: error.message };
  await refreshUsers();
  await refreshReportsForQueue();
  return { ok: true };
}

async function unbanUser(targetId) {
  const { error } = await sb.rpc('admin_unban_user', { target_id: targetId });
  if (error) return { error: error.message };
  await refreshUsers();
  return { ok: true };
}

async function promoteModerator(targetId) {
  const { error } = await sb.rpc('admin_set_role', { target_id: targetId, new_role: 'moderator' });
  if (error) return { error: error.message };
  await refreshUsers();
  return { ok: true };
}

async function demoteModerator(targetId) {
  const { error } = await sb.rpc('admin_set_role', { target_id: targetId, new_role: 'member' });
  if (error) return { error: error.message };
  await refreshUsers();
  return { ok: true };
}

async function setVerified(targetId, verified) {
  const { error } = await sb.rpc('admin_set_verified', { target_id: targetId, is_verified: !!verified });
  if (error) return { error: error.message };
  await refreshUsers();
  return { ok: true };
}

async function setCredits(targetId, amount) {
  const n = Number(amount);
  if (isNaN(n)) return { error: 'Enter a number.' };
  const { error } = await sb.rpc('admin_set_credits', { target_id: targetId, amount: n });
  if (error) return { error: error.message };
  await refreshUsers();
  return { ok: true };
}

async function reportUser(targetId, reason) {
  const { error } = await sb.rpc('report_user', { target_id: targetId, reason: (reason || '').trim() });
  if (error) return { error: error.message };
  await refreshUsers();
  await refreshReportsForQueue();
  return { ok: true };
}

async function dismissReports(targetId) {
  const { error } = await sb.rpc('dismiss_reports', { target_id: targetId });
  if (error) return { error: error.message };
  await refreshUsers();
  await refreshReportsForQueue();
  return { ok: true };
}

function getModerationQueue(viewer) {
  if (!viewer) return [];
  const grouped = {};
  cachedReports.forEach((r) => {
    if (!grouped[r.target_id]) grouped[r.target_id] = [];
    grouped[r.target_id].push({ id: r.id, reporterId: r.reporter_id, reason: r.reason, timestamp: new Date(r.created_at).getTime() });
  });
  return Object.keys(grouped)
    .filter((id) => grouped[id].length >= 3)
    .map((id) => {
      const u = getUser(id);
      return u ? Object.assign({}, u, { reports: grouped[id] }) : null;
    })
    .filter((u) => u && (viewer.role === 'owner' || u.assignedModeratorId === viewer.id));
}

/* ---------------- Posts ---------------- */

function getFeed() {
  return cachedPosts;
}

function getFollowingFeed() {
  if (!currentUser) return [];
  return cachedPosts.filter((p) => cachedFollowing.has(p.authorId));
}

function getPostsByUser(userId) {
  return cachedPosts.filter((p) => p.authorId === userId);
}

async function createPost(text, mediaFile, mediaType) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  text = (text || '').trim();
  if (!text && !mediaFile) return { error: 'Add some text, an image, or a video.' };

  let imageUrl = null;
  let videoUrl = null;
  if (mediaFile) {
    const path = 'posts/' + currentUser.id + '-' + Date.now() + '-' + mediaFile.name;
    const { error: upErr } = await sb.storage.from('media').upload(path, mediaFile);
    if (upErr) return { error: 'Upload failed: ' + upErr.message };
    const { data: pub } = sb.storage.from('media').getPublicUrl(path);
    if (mediaType === 'image') imageUrl = pub.publicUrl;
    if (mediaType === 'video') videoUrl = pub.publicUrl;
  }

  const { error } = await sb.from('posts').insert({ author_id: currentUser.id, text, image_url: imageUrl, video_url: videoUrl });
  if (error) return { error: error.message };
  await refreshPosts();
  return { ok: true };
}

function canDeletePost(viewer, post) {
  if (!viewer) return false;
  if (post.authorId === viewer.id) return true;
  if (viewer.role === 'owner') return true;
  if (viewer.role === 'moderator' && post.videoUrl) {
    const author = getUser(post.authorId);
    return canModerateUser(viewer, author);
  }
  return false;
}

async function deletePost(postId) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  const { error } = await sb.from('posts').delete().eq('id', postId);
  if (error) return { error: 'Not allowed.' };
  await refreshPosts();
  return { ok: true };
}

async function toggleLike(postId) {
  if (!isSignedIn()) return;
  const post = cachedPosts.find((p) => p.id === postId);
  if (!post) return;
  const liked = post.likes.indexOf(currentUser.id) !== -1;
  if (liked) {
    await sb.from('likes').delete().eq('post_id', postId).eq('user_id', currentUser.id);
  } else {
    await sb.from('likes').insert({ post_id: postId, user_id: currentUser.id });
  }
  await refreshPosts();
}

function isLikedByMe(post) {
  return !!(currentUser && post.likes.indexOf(currentUser.id) !== -1);
}

async function addComment(postId, text) {
  if (!isSignedIn()) return { error: 'Sign in first.' };
  text = (text || '').trim();
  if (!text) return { error: 'Comment is empty.' };
  const { error } = await sb.from('comments').insert({ post_id: postId, author_id: currentUser.id, text });
  if (error) return { error: error.message };
  await refreshPosts();
  return { ok: true };
}

function searchAll(query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { users: [], posts: [] };
  return {
    users: cachedUsers.filter((u) => u.username.indexOf(q) !== -1 || u.displayName.toLowerCase().indexOf(q) !== -1),
    posts: cachedPosts.filter((p) => p.text.toLowerCase().indexOf(q) !== -1),
  };
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  return d + 'd';
}
