# DmsSynergy — Two issues found, plus one open question

**Prepared for:** the DmsSynergy application team
**Environment tested:** `dmsuiv3.aitalkx.com`
**Date:** 2026-08-26
**Contact:** Hashim Khan — hashim.khan@extranet.ae

This note describes two confirmed issues in the application, and one thing
we noticed but have not yet confirmed is a real bug. Everything below was
verified by hand before being included here; a few things we initially
suspected turned out to be issues in our own testing setup rather than the
app, and those were dropped rather than reported. We're flagging the one
still-unconfirmed item separately and clearly, rather than folding it in
with the two confirmed findings.

---

## 1. Session refresh token expires before the session it's meant to renew

**Confirmed: the token lifetimes are inverted. Not confirmed: whether this
actually affects users** — see "What we don't know" below before assuming
this needs an urgent fix.

### What happens

When a user logs in, the app stores two tokens in the browser's local
storage: an access token (used to make API calls) and a refresh token
(used to silently get a new access token once the first one is close to
expiring, without the user noticing).

The problem: the refresh token expires in **15 minutes**, but the access
token it's supposed to renew stays valid for **60 minutes**. A refresh
token is supposed to outlive the access token it renews — here it's the
reverse, by a factor of four. This part is directly confirmed — see the
reproduction steps below.

### What we don't know

We have **not** observed a user actually being signed out because of this,
and we don't want to overstate what the token lifetimes alone tell us.
Two things determine whether this has any user-facing effect at all, and
we don't know the answer to either:

- There is a separate refresh token stored as a cookie, valid for about
  7 days — much longer-lived than either local-storage token. If the app
  automatically falls back to that cookie when the local-storage refresh
  token has expired, this inversion may never actually cause a problem for
  a real user.
- We don't know what the app does when a silent refresh fails outright —
  whether it forces a re-login, retries some other way, or simply waits
  until the access token itself expires.

We'd suggest whoever owns the refresh logic check both of those before
deciding whether this needs fixing urgently, fixing eventually, or isn't
actually a problem in practice.

### How to see it yourself

1. Log in to the app normally.
2. Open your browser's developer tools → Application tab → Local Storage
   → the `dmsuiv3.aitalkx.com` entry.
3. Find the access token and refresh token values. Each is a JWT (three
   dot-separated sections). Paste the middle section of each into a JWT
   decoder (or run `atob()` on it in the console) to read its `iat`
   (issued-at) and `exp` (expiry) fields.
4. Compare the two: the refresh token's `exp` will be exactly 15 minutes
   after `iat`; the access token's `exp` will be 60 minutes after the same
   `iat`.

### Suggested fix

Confirm whether the cookie-based refresh token is actually used as a
fallback once the local-storage one expires. If it isn't (or the fallback
isn't automatic), lengthen the local-storage refresh token's lifetime so it
safely outlives the access token it renews — the usual pattern. Either way,
worth documenting what's supposed to happen when a silent refresh has
nothing valid to use.

---

## 2. The More options menu doesn't close when you press Escape

**Severity: Low.** A minor accessibility gap, not a functional break.

### What happens

In File Explorer, opening a workspace's "More options" menu (a dropdown
menu with actions like Star, Edit, Download, Share, Delete) and then
pressing the `Escape` key does nothing — the menu stays open. Clicking
anywhere else on the page *does* close it immediately, so the menu isn't
stuck; it's just that `Escape` specifically isn't wired up to close it.

This matters because `Escape` closing an open menu is the standard,
expected keyboard behavior for this kind of control (it's part of the
WAI-ARIA design pattern most menus follow). Keyboard users and screen
reader users, who may not have an easy "click elsewhere" gesture available,
rely on `Escape` to back out of a menu without having to hunt for a safe
place to click.

### How to see it yourself

1. Go to File Explorer.
2. Click the "More options" (⋯) button on any workspace row to open its
   menu.
3. Press `Escape`.
4. The menu remains open. Click anywhere outside the menu instead, and it
   closes right away.

### Suggested fix

Wire the standard `Escape`-to-close behavior into this menu component,
matching how a click outside the menu already closes it.

---

## Open question — not confirmed

The following is something we observed but have **not** traced to a cause.
We're including it only because it might be useful for someone with direct
knowledge of this component to take a quick look — please treat it as
"here's what we saw," not "here's a bug."

**Where:** the document upload wizard, on the step where you pick a
destination folder (after picking a workspace, which itself works
correctly — you select a workspace and the wizard moves straight to the
folder-picking step, no complaints there).

**What we saw, across a few separate attempts on that folder-picking
step:**
- Clicking a folder sometimes left the "Next" button disabled for several
  seconds afterward, with nothing on screen changing in that time.
- In one attempt, a folder row that appeared visually highlighted before
  being clicked lost that highlighting afterward, without "Next" becoming
  enabled.
- In one attempt, clicking a folder appeared to send the wizard all the
  way back to the very first step (choosing a workspace again), instead of
  either staying on the folder step or moving forward.

We saw three different outcomes across a handful of tries and didn't get
far enough to know whether this is a genuine issue in the app, a quirk of
how we were interacting with the page, or something else entirely (e.g. a
slow network response arriving after we'd already stopped waiting). If
someone familiar with this part of the app wants to poke at it, that would
be more useful than anything further we could say about it right now.

---

*How we found these: we're building an automated test suite against this
application, and both confirmed issues above turned up while writing tests
for ordinary, everyday flows (staying logged in during normal use; using a
dropdown menu). Happy to share more detail on either one if useful.*
