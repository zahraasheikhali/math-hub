# Turning on phone notifications — step by step

You do this **once**. It takes about 15 minutes. Nothing here costs money.

Keep `YOUR-KEYS.txt` open beside you — you'll copy from it. **Never put that file in GitHub.**

---

## Part 1 — Put the files in your repo

Copy these into your `math-hub` folder, keeping the folders exactly as they are:

```
index.html          ← replaces the old one
manifest.webmanifest
sw.js
icon-192.png
icon-512.png
icon-maskable-512.png
apple-touch-icon.png
wrangler.toml       ← replaces the old one
src/index.js        ← NEW folder called "src", with index.js inside it
```

Do **not** copy `YOUR-KEYS.txt` or this guide into the repo.

Then: GitHub Desktop → Commit → **Push origin**.

The site will look broken for a minute or two while Cloudflare rebuilds. That's expected — it now runs a small program as well as serving files.

---

## Part 2 — Make a place to remember who wants notifications

1. Go to **dash.cloudflare.com** and sign in
2. In the left menu open **Storage & Databases** → **KV**
3. Click **Create a namespace**
4. Name it exactly: `PUSH_SUBS`
5. Click **Add**
6. You'll see it listed with an **ID** — a long string of letters and numbers. **Copy it.**

Now open `wrangler.toml` in your repo and replace

```
id = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"
```

with the ID you copied, keeping the quote marks. Commit and **Push origin** again.

---

## Part 3 — Store the secret keys

1. In Cloudflare, open **Compute (Workers)** → click your worker, **math-hub**
2. Go to **Settings** → **Variables and Secrets**
3. Add these **four**, one at a time. For the two marked *secret*, choose the **Secret** type (it hides the value):

| Name | Value | Type |
|---|---|---|
| `VAPID_PUBLIC` | the VAPID_PUBLIC line from your keys file | Text |
| `VAPID_PRIVATE` | the VAPID_PRIVATE line | **Secret** |
| `VAPID_SUBJECT` | `mailto:zahraa.sheikhali@outlook.com` | Text |
| `TEACHER_TOKEN` | the TEACHER_TOKEN line | **Secret** |

4. Click **Deploy** / **Save**

---

## Part 4 — Tell the app your token

1. Open your website and sign in as teacher
2. Go to the **Registrations** page
3. At the top you'll see **🔔 Phone notifications**
4. Paste your `TEACHER_TOKEN` and press **Save**

This is stored **only in your own browser**. It is never uploaded, never in GitHub, and no student can ever see it. If you use a different laptop, paste it there too.

---

## Part 5 — Test it

1. On your phone, open the website
2. **iPhone only:** you must first add it to the Home Screen (Share → Add to Home Screen), then open it from the icon. Notifications do not work in a Safari tab.
3. Sign in, then press **🔔 Turn on notifications** in the menu, and tap **Allow**
4. Back on your laptop, on the Registrations page, press **Send a test**
5. Your phone should buzz

If it says "Sent to 0 devices", nobody has turned notifications on yet.

---

## What sends a notification, once it's working

| When you… | Who gets it |
|---|---|
| Save a mark | only that student |
| Post an announcement | everyone |
| Add homework or a mock | everyone |

Students turn it on themselves with the 🔔 button. Anyone who doesn't simply gets nothing — it never breaks anything.

---

## If something goes wrong

**"Could not reach the server"** — the Worker isn't deployed. Check Part 1 pushed properly and Cloudflare finished building.

**"Server said: not allowed"** — the token in the app doesn't match `TEACHER_TOKEN` in Cloudflare. Check for a stray space.

**Nothing arrives on an iPhone** — it must be opened from the Home Screen icon, not Safari. Also needs iOS 16.4 or newer.

**Nothing arrives on Android** — check the phone's notification settings for the app, and that they tapped Allow.

**The site itself breaks after Part 1** — the most likely cause is `src/index.js` not being in a folder called `src`. Check the structure and push again.
