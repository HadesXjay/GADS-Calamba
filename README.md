# Gentle Angels Down Syndrome of Calamba (GADs) — website

A static site (no build step) with:
- Public pages: Home, About, Contact
- Family registration → admin review → real login for approved families
- Member dashboard: upcoming/ongoing/past events, RSVP yes/no
- Admin dashboard: approve/decline registrations, manage members, create/edit/delete events, see RSVP tallies

Backend: **Firebase** (Authentication + Firestore) — free tier is plenty for an org this size.
Hosting: **Vercel** (free tier, static site).

---

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com → **Add project** → name it anything (e.g. `gads-calamba`).
2. Once created, click the **`</>`** (web) icon to register a web app. Name it anything, skip Firebase Hosting (you're using Vercel instead).
3. Firebase shows you a config object that looks like:
   ```js
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```
   Copy those values into **`firebase-config.js`** in this project, replacing the `REPLACE_ME` placeholders.

4. In the left sidebar: **Build → Authentication → Get started → Sign-in method** → enable **Email/Password**.
5. **Build → Firestore Database → Create database** → start in **production mode** → pick a region close to the Philippines (e.g. `asia-southeast1`).

## 2. Create the admin account (your mom's login)

There's no separate "admin username" system — the admin *is* a real Firebase account:

1. **Authentication → Users → Add user**.
2. Enter your mom's real email and a password she'll remember (she can change it later from the app's "Forgot password" flow).
3. Open **`firebase-config.js`** and set `ADMIN_EMAIL` to that exact same email.
4. Open **`firestore.rules`** and replace `REPLACE_ME@example.com` with that same email too.

That email+password is now the only way into `/admin` on the site.

## 3. Deploy the Firestore security rules

These rules are what actually enforce privacy (they matter more than anything in the UI) — the rules
say: anyone can submit a registration or read events, but member data and RSVPs are only readable
by the admin or by the family member themselves.

**Easiest way (no install needed):**
1. Firebase console → **Firestore Database → Rules** tab.
2. Paste in the contents of `firestore.rules` (after you've edited the admin email in step 2).
3. Click **Publish**.

**Or with the CLI**, if you'd rather:
```bash
npm install -g firebase-tools
firebase login
firebase init firestore   # choose your existing project, keep default file names
firebase deploy --only firestore:rules
```

## 4. Run it locally to test

Because `app.js` uses ES module imports, you can't just double-click `index.html` — browsers block
module imports over the `file://` protocol. Use a tiny local server instead:

- **VS Code**: install the "Live Server" extension → right-click `index.html` → "Open with Live Server".
- **Or**, if you have Node installed:
  ```bash
  npx serve .
  ```
  then open the URL it prints.

Try the full loop: submit a test registration → log in as admin → Approve it → check the test
email's inbox (and spam folder) for the "reset your password" email from Firebase → set a password →
log in as that member → RSVP to an event you create from the admin Events tab.

## 5. Deploy to Vercel

1. Push this folder to a GitHub repo (or use the Vercel CLI directly, below).
2. Go to https://vercel.com → **Add New → Project** → import the GitHub repo.
3. Framework preset: choose **"Other"** (it's a plain static site, no build command needed).
4. Click **Deploy**. You'll get a live `https://your-project.vercel.app` URL.

**Or via CLI**, from inside this folder:
```bash
npm install -g vercel
vercel
```
Follow the prompts — no environment variables are needed, since the Firebase config is a public
client-side config by design (that's normal and expected for Firebase web apps; security is enforced
by the Firestore rules, not by hiding this file).

### Custom domain (optional)
In the Vercel project → **Settings → Domains** → add your domain (e.g. `gentleangelscalamba.org`) and
follow the DNS instructions Vercel gives you.

---

## How the security model works (read this before you launch)

- **Events** are public — anyone can view them, only the admin can create/edit them.
- **Registrations** (new applications) can be submitted by anyone, but only the admin can read the list.
- **Members** (approved families) can only read their *own* record — not each other's.
- **RSVPs** can only be created/edited by the member they belong to; the admin can read all of them
  (needed for the attendance tally).
- The admin is a real Firebase account, gated both in the UI *and* in the database rules — so even
  someone who inspects the website's code can't read member data without actually being logged in
  as that account.

### Known limitations to be aware of
- The registration form has no spam protection (no CAPTCHA). If it becomes a problem, Firebase's
  **App Check** feature can be added later to block bots.
- "Revoke" on a member sets their status to inactive so they lose access to the dashboard, but their
  login still technically exists. To fully delete it, remove them under
  **Authentication → Users** in the Firebase console.
- Password reset / welcome emails are sent by Firebase's default system — they work out of the box,
  but can look more official if you customize the sender name and template under
  **Authentication → Templates**.

---

## File overview

```
index.html          the page shell (loads style.css and app.js)
style.css            all styling (white / light yellow palette)
app.js                all app logic + Firebase calls (registration, login, dashboards, events, RSVPs)
firebase-config.js   your Firebase project keys + the admin email — edit this first
firestore.rules      the database security rules — edit the admin email here too, then deploy
assets/logo.png      your org's logo
```

All homepage/About/Contact copy is placeholder — search `app.js` for the `renderHome`, `renderAbout`,
and `renderContact` functions and swap in your mom's real wording, contact details, and social links.
