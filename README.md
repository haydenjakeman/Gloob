# Gloob

A real, shared social app: sign in/sign up, a feed with text/image/video
posts, likes and comments, follows, a TikTok-style video grid on profiles,
and a full moderation system (owner, moderators, bans, reports,
verification, credits). It's backed by an actual Supabase project — real
accounts, real shared data, visible to every visitor, not just you.

## ⚠️ One required step before anyone can sign in

This Supabase project currently has **email confirmation** turned on by
default. Gloob signs people up with a private placeholder address
(`username@gloob.local`) instead of a real email, so that confirmation
link can never be clicked — which means sign-ups will get stuck.

**Turn it off once:** in your Supabase dashboard, go to
**Authentication → Sign In / Providers → Email**, and switch off
**"Confirm email."** After that, sign-up and sign-in both work
immediately, for everyone.

## The owner account

`gloob` is a reserved username. Whoever signs up with that exact username
is automatically made the owner — full control over roles, bans, and
credits. There's no password stored anywhere in this code (that would be
public on GitHub) — just sign up as `gloob` with whatever password you
want, once the step above is done.

## Roles

- **Owner** (`gloob`) — ban or unban anyone except themself, promote or
  demote moderators, ban moderators, set anyone's credits, verify
  accounts, remove any post.
- **Moderators** — ban regular members for exactly 3 days, remove other
  members' video posts, verify accounts. Can't touch the owner or other
  moderators.
- **Members** — everything else: post, follow, comment, like, report.

Long-press (or tap "Moderate" on mobile) on someone's profile if you
have authority over them, for a quick ban/promote/verify menu.

## Reports

Anyone can report an account from their profile. Once an account
reaches **3 reports**, it's automatically assigned to one random
moderator (visible in their Moderation queue, with every report's
reason). The owner sees every flagged account, not just their own
assignments.

## Try it right now

Open `index.html` in a browser. Since this talks to a real backend,
you'll need a real internet connection — there's no offline demo mode
anymore, unlike earlier versions of this project.

## Deploy it

1. Go to `app.netlify.com/drop` and drag the whole `gloob` folder in
   (unzip `gloob.zip` first if needed). You'll get a live link — no
   environment variables or build step needed, since the Supabase
   connection details are already in `data.js`.
2. Or push it to GitHub (**Add file → Upload files** works fine, no
   subfolders in this project) and connect the repo in Netlify for
   auto-deploys.

## How the security actually works

- Every table has Row Level Security on. Posts, profiles, comments,
  likes, and follows are readable by anyone, but you can only ever
  write rows as yourself.
- Sensitive fields — role, credits, verified, banned — can't be changed
  by a direct database update from the client at all, even your own.
  They only change through dedicated database functions
  (`admin_ban_user`, `admin_set_role`, etc.) that check the same
  owner/moderator rules on the server, no matter what the client sends.
- The publishable key in `data.js` is meant to be public — it doesn't
  grant access by itself. The rules above are what actually protect
  the data.

## Customize

- **Colors, fonts, theme** — top of `style.css`.
- **What each role can do** — the SQL functions in your Supabase
  project (`can_moderate`, `admin_*`), not in the JS.
- **Trending tags** — `renderExplore()` in `app.js` (still static text
  for now).

## Notes

- Sign-in is by username, but Supabase Auth is email-based under the
  hood — this project quietly converts `username` to
  `username@gloob.local` so you never see or need a real email.
- Videos, images, and avatar photos are uploaded to a `media` storage
  bucket on your Supabase project and are publicly viewable via their
  URL, same as any social app.
- No `npm install` or build step anywhere in this project.
