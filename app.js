/* ===================== GADs — Gentle Angels Down Syndrome of Calamba =====================
   Firebase-backed version: real admin login (email/password), real member accounts,
   Firestore for events / registrations / members / rsvps / announcements / eventPhotos.
   See README.md for setup.
=========================================================================================== */

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc, getDoc,
  onSnapshot, query, where, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-storage.js";

import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const LOGO_SRC = "assets/logo.png";

const HERO_PHOTOS = [
  "assets/Photo1.jpg",
  "assets/Photo2.jpg",
  "assets/Photo3.jpg",
  "assets/Photo4.jpg",
  "assets/Photo5.jpg",
  "assets/Photo6.jpg"
];

function heroSlideshowHTML() {
  return `<div class="hero-slideshow">
    ${HERO_PHOTOS.map((src, i) =>
      `<img src="${src}" alt="GADs community photo ${i + 1}" class="hero-slide ${i === 0 ? "active" : ""}" loading="${i === 0 ? "eager" : "lazy"}" />`
    ).join("")}
  </div>`;
}
/* ---------------------------- state ---------------------------- */

let state = {
  view: "home",
  booting: true,
  authChecked: false,
  isAdmin: false,
  currentMember: null,   // { id (=uid), guardianName, memberName, ... }
  events: [],
  registrations: [],     // admin-only, pending/declined applications
  members: [],           // admin-only, approved member accounts
  myRsvps: [],           // current member's own rsvps
  allRsvps: [],          // admin-only, all rsvps (for tallies)
  adminTab: "pending",
  editingEventId: null,
  notice: null,
  modal: null,
  mobileNavOpen: false,
  announcements: [],
  eventPhotos: []
};

let unsubEvents = null, unsubRegs = null, unsubMembers = null, unsubMyRsvps = null,
    unsubAllRsvps = null, unsubAnnouncements = null, unsubEventPhotos = null;

/* ---------------------------- utilities ---------------------------- */

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function randomPassword() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function icsEscape(str) {
  return String(str ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function addEventToCalendar(eventId) {
  const e = state.events.find(ev => ev.id === eventId);
  if (!e) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  let dtStart, dtEnd;
  if (e.time) {
    const [h, m] = e.time.split(":").map(Number);
    const start = new Date(e.date + "T00:00:00");
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // default 2-hour block
    const fmt = (d) => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}T${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}00`;
    dtStart = `DTSTART:${fmt(start)}`;
    dtEnd = `DTEND:${fmt(end)}`;
  } else {
    const d = e.date.replace(/-/g, "");
    const next = new Date(e.date + "T00:00:00");
    next.setDate(next.getDate() + 1);
    const dNext = `${next.getFullYear()}${String(next.getMonth()+1).padStart(2,"0")}${String(next.getDate()).padStart(2,"0")}`;
    dtStart = `DTSTART;VALUE=DATE:${d}`;
    dtEnd = `DTEND;VALUE=DATE:${dNext}`;
  }
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GADs Calamba//Events//EN",
    "BEGIN:VEVENT",
    `UID:${e.id}@gads-calamba`,
    `DTSTAMP:${stamp}`,
    dtStart, dtEnd,
    `SUMMARY:${icsEscape(e.title)}`,
    `LOCATION:${icsEscape(e.location)}`,
    e.description ? `DESCRIPTION:${icsEscape(e.description)}` : "",
    "END:VEVENT", "END:VCALENDAR"
  ].filter(Boolean).join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${e.title.replace(/[^a-z0-9]+/gi, "-")}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setNotice(kind, text, ms = 4000) {
  state.notice = { kind, text };
  render();
  clearTimeout(setNotice._t);
  setNotice._t = setTimeout(() => { state.notice = null; render(); }, ms);
}

function goto(view) {
  state.view = view;
  state.notice = null;
  state.mobileNavOpen = false;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------------------------- auth state ---------------------------- */

onAuthStateChanged(auth, async (user) => {
  state.authChecked = true;
  detachMemberOnlyListeners();
  detachAdminOnlyListeners();
  detachAnnouncementsListener();

  if (!user) {
    state.isAdmin = false;
    state.currentMember = null;
  } else if (user.email === ADMIN_EMAIL) {
    state.isAdmin = true;
    state.currentMember = null;
    attachAdminOnlyListeners();
    attachAnnouncementsListener();
    if (state.view === "home" || state.view === "adminLogin" || state.view === "login") state.view = "adminDashboard";
  } else {
    // a member account
    try {
      const snap = await getDoc(doc(db, "members", user.uid));
      if (snap.exists() && snap.data().status === "active") {
        state.currentMember = { id: user.uid, ...snap.data() };
        attachMemberOnlyListeners(user.uid);
        attachAnnouncementsListener();
        if (state.view === "home" || state.view === "login") state.view = "memberDashboard";
      } else {
        await signOut(auth);
        setNotice("error", "Your account isn't active. Please contact GADs.");
      }
    } catch (e) {
      console.error(e);
    }
  }
  state.booting = false;
  render();
});

/* ---------------------------- realtime listeners ---------------------------- */

function attachPublicListeners() {
  unsubEvents = onSnapshot(collection(db, "events"), (snap) => {
    state.events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("events listener", err));

  unsubEventPhotos = onSnapshot(collection(db, "eventPhotos"), (snap) => {
    state.eventPhotos = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    render();
  }, (err) => console.error("eventPhotos listener", err));
}

function eventPhotosFor(eventId) {
  return state.eventPhotos.filter(p => p.eventId === eventId);
}

function attachAdminOnlyListeners() {
  unsubRegs = onSnapshot(collection(db, "registrations"), (snap) => {
    state.registrations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("registrations listener", err));

  unsubMembers = onSnapshot(collection(db, "members"), (snap) => {
    state.members = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("members listener", err));

  unsubAllRsvps = onSnapshot(collection(db, "rsvps"), (snap) => {
    state.allRsvps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("rsvps listener", err));
}

function detachAdminOnlyListeners() {
  if (unsubRegs) { unsubRegs(); unsubRegs = null; }
  if (unsubMembers) { unsubMembers(); unsubMembers = null; }
  if (unsubAllRsvps) { unsubAllRsvps(); unsubAllRsvps = null; }
  state.registrations = []; state.members = []; state.allRsvps = [];
}

function attachMemberOnlyListeners(uid) {
  const q = query(collection(db, "rsvps"), where("memberId", "==", uid));
  unsubMyRsvps = onSnapshot(q, (snap) => {
    state.myRsvps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => console.error("my rsvps listener", err));
}

function detachMemberOnlyListeners() {
  if (unsubMyRsvps) { unsubMyRsvps(); unsubMyRsvps = null; }
  state.myRsvps = [];
}

// Announcements are visible to any signed-in user (admin or an approved
// member) but not to anonymous public visitors — see firestore.rules.
function attachAnnouncementsListener() {
  unsubAnnouncements = onSnapshot(collection(db, "announcements"), (snap) => {
    state.announcements = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    render();
  }, (err) => console.error("announcements listener", err));
}

function detachAnnouncementsListener() {
  if (unsubAnnouncements) { unsubAnnouncements(); unsubAnnouncements = null; }
  state.announcements = [];
}

/* ---------------------------- actions: registration ---------------------------- */

async function submitRegistration(form) {
  const fd = new FormData(form);
  const guardianName = fd.get("guardianName").trim();
  const memberName = fd.get("memberName").trim();
  const relationship = fd.get("relationship").trim();
  const email = fd.get("email").trim().toLowerCase();
  const phone = fd.get("phone").trim();
  const notes = fd.get("notes").trim();
  const password = fd.get("password");
  const confirmPassword = fd.get("confirmPassword");

  if (!guardianName || !memberName || !email || !phone || !password) {
    setNotice("error", "Please fill in all required fields.");
    return;
  }
  if (password.length < 6) {
    setNotice("error", "Password must be at least 6 characters.");
    return;
  }
  if (password !== confirmPassword) {
    setNotice("error", "Passwords don't match.");
    return;
  }

  // Create their login right now, on a secondary app instance so this
  // doesn't sign the browser in as a not-yet-approved account. The account
  // will just sit unapproved (no "members" doc) until an admin approves it.
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  let authUid = null;
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    authUid = cred.user.uid;
    await signOut(secondaryAuth);
  } catch (e) {
    await deleteApp(secondaryApp);
    if (e.code === "auth/email-already-in-use") {
      setNotice("error", "That email already has an account. Try logging in, or use a different email.");
    } else if (e.code === "auth/weak-password") {
      setNotice("error", "Please choose a stronger password (at least 6 characters).");
    } else {
      console.error(e);
      setNotice("error", "Something went wrong submitting your registration. Please try again.");
    }
    return;
  }
  await deleteApp(secondaryApp);

  try {
    await addDoc(collection(db, "registrations"), {
      guardianName, memberName, relationship, email, phone, notes, authUid,
      status: "pending", createdAt: serverTimestamp()
    });
    goto("registerSuccess");
  } catch (e) {
    console.error(e);
    setNotice("error", "Something went wrong submitting your registration. Please try again.");
  }
}

/* ---------------------------- actions: admin auth ---------------------------- */

async function adminLogin(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    if (cred.user.email !== ADMIN_EMAIL) {
      await signOut(auth);
      setNotice("error", "This account isn't set up as the admin.");
    }
    // onAuthStateChanged handles the rest
  } catch (e) {
    setNotice("error", "Incorrect email or password.");
  }
}

/* ---------------------------- actions: approve / decline ---------------------------- */

async function approveRegistration(regId) {
  const reg = state.registrations.find(r => r.id === regId);
  if (!reg) return;

  // Families who registered after the self-service password feature shipped
  // already have an auth account (reg.authUid) — approving just activates it.
  // Older pending registrations from before that change won't have an
  // authUid, so we fall back to creating the account + emailing a reset link.
  if (reg.authUid) {
    try {
      await setDoc(doc(db, "members", reg.authUid), {
        guardianName: reg.guardianName, memberName: reg.memberName,
        relationship: reg.relationship || "", email: reg.email, phone: reg.phone,
        status: "active", createdAt: serverTimestamp()
      });
      await updateDoc(doc(db, "registrations", regId), { status: "approved" });
      setNotice("success", `Approved. ${reg.email} can log in now with the password they set.`);
    } catch (e) {
      console.error(e);
      setNotice("error", "Couldn't approve — please try again.");
    }
    return;
  }

  // Legacy path: no self-set password on file for this registration.
  const secondaryApp = initializeApp(firebaseConfig, "secondary-" + Date.now());
  const secondaryAuth = getAuth(secondaryApp);
  try {
    const tempPassword = randomPassword();
    const cred = await createUserWithEmailAndPassword(secondaryAuth, reg.email, tempPassword);
    const uid = cred.user.uid;

    await setDoc(doc(db, "members", uid), {
      guardianName: reg.guardianName, memberName: reg.memberName,
      relationship: reg.relationship || "", email: reg.email, phone: reg.phone,
      status: "active", createdAt: serverTimestamp()
    });

    await sendPasswordResetEmail(secondaryAuth, reg.email);
    await updateDoc(doc(db, "registrations", regId), { status: "approved" });
    await signOut(secondaryAuth);

    setNotice("success", `Approved. ${reg.email} will get an email to set their password.`);
  } catch (e) {
    console.error(e);
    if (e.code === "auth/email-already-in-use") {
      setNotice("error", "That email already has an account. Check the Members tab.");
    } else {
      setNotice("error", "Couldn't approve — please try again.");
    }
  } finally {
    await deleteApp(secondaryApp);
  }
}

async function declineRegistration(regId) {
  try {
    await updateDoc(doc(db, "registrations", regId), { status: "declined" });
  } catch (e) { console.error(e); setNotice("error", "Couldn't update — try again."); }
}

async function revokeMember(uid) {
  try {
    await updateDoc(doc(db, "members", uid), { status: "revoked" });
    setNotice("success", "Access revoked. (To fully delete their login, remove the user in the Firebase console under Authentication.)");
  } catch (e) { console.error(e); setNotice("error", "Couldn't update — try again."); }
}

async function deleteMember(uid) {
  try {
    await deleteDoc(doc(db, "members", uid));
    setNotice("success", "Member record deleted. (To fully remove their login, also delete the user in the Firebase console under Authentication.)");
  } catch (e) { console.error(e); setNotice("error", "Couldn't delete — try again."); }
}

async function deleteRegistration(regId) {
  try {
    await deleteDoc(doc(db, "registrations", regId));
    setNotice("success", "Registration removed.");
  } catch (e) { console.error(e); setNotice("error", "Couldn't delete — try again."); }
}

async function resendReset(email) {
  try {
    await sendPasswordResetEmail(auth, email);
    setNotice("success", `Password reset email sent to ${email}.`);
  } catch (e) { console.error(e); setNotice("error", "Couldn't send that email — try again."); }
}

/* ---------------------------- actions: member auth ---------------------------- */

async function memberLogin(email, password) {
  try {
    await signInWithEmailAndPassword(auth, email.trim(), password);
    // onAuthStateChanged handles the rest
  } catch (e) {
    setNotice("error", "Incorrect email or password.");
  }
}

async function forgotPassword(email) {
  if (!email) { setNotice("error", "Type your email above first, then click this again."); return; }
  try {
    await sendPasswordResetEmail(auth, email.trim());
    setNotice("success", "Check your email for a reset link.");
  } catch (e) {
    setNotice("error", "Couldn't send reset email — check the address and try again.");
  }
}

function logout() {
  signOut(auth);
  goto("home");
}

/* ---------------------------- actions: events ---------------------------- */

async function createOrUpdateEvent(form) {
  const fd = new FormData(form);
  const title = fd.get("title").trim();
  const description = fd.get("description").trim();
  const date = fd.get("date");
  const time = fd.get("time");
  const location = fd.get("location").trim();

  if (!title || !date || !location) {
    setNotice("error", "Please fill in the title, date, and location.");
    return;
  }
  try {
    if (state.editingEventId) {
      await updateDoc(doc(db, "events", state.editingEventId), { title, description, date, time, location });
      state.editingEventId = null;
      setNotice("success", "Event updated.");
    } else {
      await addDoc(collection(db, "events"), {
        title, description, date, time, location, status: "upcoming", createdAt: serverTimestamp()
      });
      setNotice("success", "Event created.");
    }
    render();
    form.reset();
  } catch (e) { console.error(e); setNotice("error", "Couldn't save the event — try again."); }
}

function startEditEvent(id) {
  state.editingEventId = id;
  render();
  const el = document.getElementById("event-form-anchor");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}
function cancelEditEvent() { state.editingEventId = null; render(); }

async function setEventStatus(id, status) {
  try { await updateDoc(doc(db, "events", id), { status }); }
  catch (e) { console.error(e); setNotice("error", "Couldn't update status — try again."); }
}

async function deleteEvent(id) {
  try { await deleteDoc(doc(db, "events", id)); setNotice("success", "Event deleted."); }
  catch (e) { console.error(e); setNotice("error", "Couldn't delete — try again."); }
}

/* ---------------------------- actions: event photos ---------------------------- */

async function uploadEventPhoto(eventId, file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { setNotice("error", "Please choose an image file."); return; }
  if (file.size > 8 * 1024 * 1024) { setNotice("error", "Image is too large (max 8MB)."); return; }
  try {
    setNotice("success", "Uploading photo…", 2000);
    const path = `event-photos/${eventId}/${Date.now()}-${file.name}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    await addDoc(collection(db, "eventPhotos"), {
      eventId, url, storagePath: path, createdAt: serverTimestamp(), createdAtMs: Date.now()
    });
    setNotice("success", "Photo uploaded.");
  } catch (e) {
    console.error(e);
    setNotice("error", "Couldn't upload the photo — try again.");
  }
}

async function deleteEventPhoto(photoId, storagePath) {
  try {
    if (storagePath) {
      try { await deleteObject(storageRef(storage, storagePath)); } catch (err) { console.warn("storage delete failed", err); }
    }
    await deleteDoc(doc(db, "eventPhotos", photoId));
    setNotice("success", "Photo removed.");
  } catch (e) { console.error(e); setNotice("error", "Couldn't remove the photo — try again."); }
}

/* ---------------------------- actions: announcements ---------------------------- */

async function createAnnouncement(form) {
  const fd = new FormData(form);
  const title = fd.get("title").trim();
  const body = fd.get("body").trim();
  if (!title || !body) { setNotice("error", "Please fill in both the title and message."); return; }
  try {
    await addDoc(collection(db, "announcements"), {
      title, body, createdAt: serverTimestamp(), createdAtMs: Date.now()
    });
    setNotice("success", "Announcement posted.");
    form.reset();
  } catch (e) { console.error(e); setNotice("error", "Couldn't post — try again."); }
}

async function deleteAnnouncement(id) {
  try { await deleteDoc(doc(db, "announcements", id)); setNotice("success", "Announcement removed."); }
  catch (e) { console.error(e); setNotice("error", "Couldn't remove — try again."); }
}

/* ---------------------------- actions: rsvp ---------------------------- */

function openRsvpModal(eventId, title) { state.modal = { eventId, title }; render(); }
function closeModal() { state.modal = null; render(); }

async function submitRsvp(eventId, response) {
  if (!state.currentMember) return;
  try {
    await setDoc(doc(db, "rsvps", `${eventId}_${state.currentMember.id}`), {
      eventId, memberId: state.currentMember.id, response, respondedAt: serverTimestamp()
    }, { merge: true });
    state.modal = null;
    render();
    setNotice("success", response === "yes" ? "You're on the list!" : "Thanks for letting us know.");
  } catch (e) { console.error(e); setNotice("error", "Couldn't save your response — try again."); }
}

function getMyRsvp(eventId) {
  return state.myRsvps.find(r => r.eventId === eventId) || null;
}
function rsvpCounts(eventId) {
  const list = state.allRsvps.filter(r => r.eventId === eventId);
  return { yes: list.filter(r => r.response === "yes").length, no: list.filter(r => r.response === "no").length, list };
}

/* ---------------------------- rendering ---------------------------- */

function statusPill(status) {
  const map = {
    pending: ["Pending", "pill-pending"], approved: ["Approved", "pill-approved"],
    declined: ["Declined", "pill-declined"], active: ["Active", "pill-approved"],
    revoked: ["Revoked", "pill-declined"], upcoming: ["Upcoming", "pill-upcoming"],
    ongoing: ["Ongoing", "pill-ongoing"], completed: ["Completed", "pill-completed"]
  };
  const [label, cls] = map[status] || [status, ""];
  return `<span class="pill ${cls}">${label}</span>`;
}

function navBar(active) {
  return `
  <header class="site-header">
    <div class="wrap nav-inner">
      <div class="brand" data-nav="home">
        <img src="${LOGO_SRC}" alt="GADs logo" class="brand-logo" />
        <div class="brand-text">
          <span class="brand-title">Gentle Angels</span>
          <span class="brand-sub">Down Syndrome of Calamba</span>
        </div>
      </div>
      <nav class="nav-links">
        <a data-nav="home" class="${active === 'home' ? 'active' : ''}">Home</a>
        <a data-nav="about" class="${active === 'about' ? 'active' : ''}">About</a>
        <a data-nav="contact" class="${active === 'contact' ? 'active' : ''}">Contact</a>
      </nav>
      <div class="nav-actions nav-actions-public">
        <button class="btn btn-ghost" data-nav="login">Member Login</button>
        <button class="btn btn-primary" data-nav="register">Register</button>
      </div>
      <button class="mobile-menu-btn" data-mobile-toggle="1" aria-label="Menu">
        <span></span><span></span><span></span>
      </button>
    </div>
    <div class="mobile-nav-panel ${state.mobileNavOpen ? 'open' : ''}">
      <a data-nav="home" class="${active === 'home' ? 'active' : ''}">Home</a>
      <a data-nav="about" class="${active === 'about' ? 'active' : ''}">About</a>
      <a data-nav="contact" class="${active === 'contact' ? 'active' : ''}">Contact</a>
      <a data-nav="login" class="${active === 'login' ? 'active' : ''}">Member Login</a>
      <button class="btn btn-primary full-width" data-nav="register">Register</button>
    </div>
  </header>`;
}

function noticeBanner() {
  if (!state.notice) return "";
  return `<div class="notice notice-${state.notice.kind}">${escapeHtml(state.notice.text)}</div>`;
}

function renderHome() {
  const upcoming = state.events
    .filter(e => e.status !== "completed")
    .sort((a, b) => (a.date + (a.time||"")).localeCompare(b.date + (b.time||"")))
    .slice(0, 3);

  return `
  ${navBar("home")}
  <main>
    <section class="hero hero-full">
  ${heroSlideshowHTML()}
  <div class="hero-overlay"></div>
  <div class="wrap hero-inner">
    <div class="hero-copy">
      <span class="eyebrow">Calamba, Laguna</span>
      <h1>Every gentle angel deserves a place to belong.</h1>
      <p class="lead">Gentle Angels Down Syndrome of Calamba (GADs) is a community of families supporting
      individuals with Down syndrome in Calamba — through friendship, advocacy, and shared milestones.</p>
      <div class="hero-actions">
        <button class="btn btn-primary btn-lg" data-nav="register">Join our community</button>
        <button class="btn btn-outline btn-lg" data-nav="about">Learn more</button>
      </div>
    </div>
  </div>
  <div class="hero-dots">
    ${HERO_PHOTOS.map((_, i) => `<span class="hero-dot ${i === 0 ? "active" : ""}" data-dot="${i}"></span>`).join("")}
  </div>
  ${wingDivider()}
</section>

    <section class="section section-soft">
      <div class="wrap">
        <span class="eyebrow center">Proud member of</span>
        <h2 class="center">Special Olympics</h2>
        <p class="lead center narrow">GADs is part of the Special Olympics movement — giving our members year-round
        access to sports training and competition, and a bigger stage to show what they can do.</p>
        <div class="badge-row">
          <div class="badge-card"><div class="badge-icon">🏅</div><h3>Training</h3><p>Regular practices that build skill, confidence, and teamwork.</p></div>
          <div class="badge-card"><div class="badge-icon">🤝</div><h3>Inclusion</h3><p>A welcoming space where every family knows they're not alone.</p></div>
          <div class="badge-card"><div class="badge-icon">🎉</div><h3>Competition</h3><p>Chances to compete, celebrate, and be seen — on and off the field.</p></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="wrap">
        <div class="section-head">
          <div><span class="eyebrow">What's coming up</span><h2>Upcoming events</h2></div>
          <button class="btn btn-ghost" data-nav="login">Members, log in to RSVP →</button>
        </div>
        ${upcoming.length ? `<div class="event-grid">${upcoming.map(publicEventCard).join("")}</div>` : `<p class="empty">No events posted yet — check back soon.</p>`}
      </div>
    </section>

    <section class="section section-soft">
      <div class="wrap">
        <span class="eyebrow center">Moments</span>
        <h2 class="center">From our recent events</h2>
        ${state.eventPhotos.length
          ? `<div class="gallery-grid">${state.eventPhotos.slice(0, 8).map(p => `<div class="gallery-item"><img src="${p.url}" alt="GADs event photo" loading="lazy" /></div>`).join("")}</div>`
          : `<p class="empty center">Photos from our events will appear here soon.</p>`}
      </div>
    </section>

    <section class="section section-cta">
      <div class="wrap cta-inner">
        <h2>New to GADs?</h2>
        <p>Register your family and our team will review and welcome you in.</p>
        <button class="btn btn-primary btn-lg" data-nav="register">Register your family</button>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function publicEventCard(e) {
  return `
  <div class="event-card">
    <div class="event-date">
      <span class="event-date-badge">${statusPill(e.status)}</span>
      <h4>${escapeHtml(e.title)}</h4>
      <p class="event-meta">📅 ${fmtDate(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}</p>
      <p class="event-meta">📍 ${escapeHtml(e.location)}</p>
      ${e.description ? `<p class="event-desc">${escapeHtml(e.description)}</p>` : ""}
    </div>
  </div>`;
}

function renderAbout() {
  return `
  ${navBar("about")}
  <main>
    <section class="section page-hero">
      <div class="wrap">
        <span class="eyebrow">About us</span>
        <h1>Who we are</h1>
        <p class="lead narrow">GADs was formed in Calamba by families who wanted their loved ones with Down syndrome
        to grow up surrounded by community — not in spite of their diagnosis, but celebrated alongside it.</p>
      </div>
    </section>
    <section class="section section-soft">
      <div class="wrap two-col">
        <div><h3>Our mission</h3><p>To support individuals with Down syndrome and their families in Calamba through fellowship,
        advocacy, learning sessions, and sports — so no family walks this journey alone.</p></div>
        <div><h3>Special Olympics</h3><p>As part of the Special Olympics movement, GADs gives our members access to organized training
        and competition, building confidence, fitness, and friendship through sport.</p></div>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function renderContact() {
  return `
  ${navBar("contact")}
  <main>
    <section class="section page-hero">
      <div class="wrap">
        <span class="eyebrow">Get in touch</span>
        <h1>We'd love to hear from you</h1>
        <p class="lead narrow">Questions about joining, events, or partnering with GADs? Reach out any time.</p>
      </div>
    </section>
    <section class="section">
      <div class="wrap contact-grid">
        <div class="contact-card"><div class="contact-icon">📍</div><h4>Location</h4><p>Calamba, Laguna, Philippines</p></div>
        <div class="contact-card"><div class="contact-icon">✉️</div><h4>Email</h4><p>alicealzona.016@gmail.com</p></div>
        <div class="contact-card"><div class="contact-icon">📱</div><h4>Phone / Messenger</h4><p>(+63917-303-7810)</p></div>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function footer() {
  return `
  <footer class="site-footer">
    <div class="wrap footer-inner">
      <div class="brand">
        <img src="${LOGO_SRC}" alt="GADs logo" class="brand-logo small" />
        <span class="brand-title small">Gentle Angels Down Syndrome of Calamba</span>
      </div>
      <div class="footer-links">
        <a data-nav="about">About</a>
        <a data-nav="contact">Contact</a>
        <a data-nav="login">Member Login</a>
        <a data-nav="adminLogin" class="footer-admin">Admin</a>
      </div>
    </div>
  </footer>`;
}

function renderRegister() {
  return `
  ${navBar("register")}
  <main>
    <section class="section narrow-section">
      <div class="wrap wrap-narrow">
        <span class="eyebrow">Join GADs</span>
        <h1>Register your family</h1>
        <p class="lead">Fill this in and choose a password now. Our team will review your registration, and once
        approved you can log in right away with the password you set below.</p>
        <form id="register-form" class="card form-card">
          <label>Parent / Guardian full name *<input name="guardianName" required /></label>
          <label>Name of family member with Down syndrome *<input name="memberName" required /></label>
          <label>Relationship to member<input name="relationship" placeholder="e.g. Mother, Father, Sibling" /></label>
          <div class="two-col">
            <label>Email address *<input type="email" name="email" required /></label>
            <label>Phone number *<input type="tel" name="phone" required /></label>
          </div>
          <div class="two-col">
            <label>Create a password *<input type="password" name="password" minlength="6" required /></label>
            <label>Confirm password *<input type="password" name="confirmPassword" minlength="6" required /></label>
          </div>
          <p class="fine-print">At least 6 characters. You'll use this to log in once you're approved.</p>
          <label>Anything you'd like us to know<textarea name="notes" rows="3"></textarea></label>
          <button type="submit" class="btn btn-primary btn-lg full-width">Submit registration</button>
        </form>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function renderRegisterSuccess() {
  return `
  ${navBar("register")}
  <main>
    <section class="section narrow-section center-section">
      <div class="wrap wrap-narrow center">
        <div class="big-emoji">💛</div>
        <h1>Thank you!</h1>
        <p class="lead">Your registration is in. Our team will review it, and once you're approved you can log in
        to the member dashboard right away with the password you just created.</p>
        <button class="btn btn-outline" data-nav="home">Back to home</button>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function renderLogin() {
  return `
  ${navBar("login")}
  <main>
    <section class="section narrow-section center-section">
      <div class="wrap wrap-narrow">
        <span class="eyebrow center">Members</span>
        <h1 class="center">Log in to your dashboard</h1>
        <p class="lead center">Use the email you registered with, and the password you set.</p>
        <form id="login-form" class="card form-card">
          <label>Email address<input type="email" name="email" required /></label>
          <label>Password<input type="password" name="password" required /></label>
          <button type="submit" class="btn btn-primary btn-lg full-width">Log in</button>
        </form>
        <p class="fine-print center"><button class="link small" id="forgot-btn" type="button">Forgot your password?</button></p>
        <p class="fine-print center">Not registered yet? <a data-nav="register" class="link">Register here</a>.</p>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function renderAdminLogin() {
  return `
  ${navBar("adminLogin")}
  <main>
    <section class="section narrow-section center-section">
      <div class="wrap wrap-narrow">
        <span class="eyebrow center">Admin</span>
        <h1 class="center">Organizer login</h1>
        <form id="admin-login-form" class="card form-card">
          <label>Admin email<input type="email" name="email" required /></label>
          <label>Password<input type="password" name="password" required /></label>
          <button type="submit" class="btn btn-primary btn-lg full-width">Log in</button>
        </form>
      </div>
    </section>
  </main>
  ${footer()}`;
}

function renderMemberDashboard() {
  const m = state.currentMember;
  const sorted = [...state.events].sort((a, b) => (a.date + (a.time||"")).localeCompare(b.date + (b.time||"")));
  const groups = { upcoming: [], ongoing: [], completed: [] };
  sorted.forEach(e => groups[e.status] && groups[e.status].push(e));

  const nextUp = [...groups.ongoing, ...groups.upcoming]
    .sort((a, b) => (a.date + (a.time||"")).localeCompare(b.date + (b.time||"")))[0] || null;

  const card = (e) => {
    const mine = getMyRsvp(e.id);
    const canRsvp = e.status !== "completed";
    return `
    <div class="event-card dash-card">
      <div class="event-top">${statusPill(e.status)}</div>
      <h4>${escapeHtml(e.title)}</h4>
      <p class="event-meta">📅 ${fmtDate(e.date)}${e.time ? " · " + fmtTime(e.time) : ""}</p>
      <p class="event-meta">📍 ${escapeHtml(e.location)}</p>
      ${e.description ? `<p class="event-desc">${escapeHtml(e.description)}</p>` : ""}
      ${canRsvp ? `
        ${mine
          ? `<div class="rsvp-status rsvp-${mine.response}">
               ${mine.response === "yes" ? "✅ You're going!" : "❎ Not attending"}
               <button class="link small" data-rsvp-open="${e.id}" data-rsvp-title="${escapeHtml(e.title)}">Change</button>
             </div>`
          : `<button class="btn btn-primary full-width" data-rsvp-open="${e.id}" data-rsvp-title="${escapeHtml(e.title)}">Will you join?</button>`}
        <button class="link small ics-link" data-ics="${e.id}">📅 Add to Calendar</button>
      ` : `<p class="fine-print">This event has ended.</p>`}
    </div>`;
  };

  const nextUpBannerHTML = () => {
    if (!nextUp) return "";
    const mine = getMyRsvp(nextUp.id);
    return `
    <div class="next-up-banner">
      <span class="next-up-label">${nextUp.status === "ongoing" ? "Happening now" : "Next up"}</span>
      <h2>${escapeHtml(nextUp.title)}</h2>
      <p class="next-up-meta">📅 ${fmtDate(nextUp.date)}${nextUp.time ? " · " + fmtTime(nextUp.time) : ""} &nbsp;·&nbsp; 📍 ${escapeHtml(nextUp.location)}</p>
      <div class="next-up-actions">
        ${mine
          ? `<span class="rsvp-status rsvp-${mine.response} inline">${mine.response === "yes" ? "✅ You're going!" : "❎ Not attending"}</span>
             <button class="link small light" data-rsvp-open="${nextUp.id}" data-rsvp-title="${escapeHtml(nextUp.title)}">Change</button>`
          : `<button class="btn btn-primary" data-rsvp-open="${nextUp.id}" data-rsvp-title="${escapeHtml(nextUp.title)}">Will you join?</button>`}
        <button class="btn btn-outline light" data-ics="${nextUp.id}">📅 Add to Calendar</button>
      </div>
    </div>`;
  };

  const announcementsHTML = () => {
    if (!state.announcements.length) return "";
    return `
    <div class="announcements-block">
      <h2 class="section-sub">Announcements</h2>
      <div class="announcement-list">
        ${state.announcements.slice(0, 5).map(a => `
          <div class="announcement-card">
            <h4>${escapeHtml(a.title)}</h4>
            <p>${escapeHtml(a.body)}</p>
          </div>`).join("")}
      </div>
    </div>`;
  };

  return `
  <header class="site-header">
    <div class="wrap nav-inner">
      <div class="brand" data-nav="home"><img src="${LOGO_SRC}" class="brand-logo" alt="GADs logo"/>
        <div class="brand-text"><span class="brand-title">Gentle Angels</span><span class="brand-sub">Member Dashboard</span></div>
      </div>
      <div class="nav-actions">
        <span class="welcome-name">Hi, ${escapeHtml(m.guardianName.split(" ")[0])} 👋</span>
        <button class="btn btn-ghost" data-logout="1">Log out</button>
      </div>
    </div>
  </header>
  <main>
    <section class="section">
      <div class="wrap">
        ${nextUpBannerHTML()}
        ${announcementsHTML()}
        <h1>Upcoming events</h1>
        ${groups.upcoming.length ? `<div class="event-grid">${groups.upcoming.map(card).join("")}</div>` : `<p class="empty">No upcoming events right now — check back soon.</p>`}
        ${groups.ongoing.length ? `<h2 class="section-sub">Happening now</h2><div class="event-grid">${groups.ongoing.map(card).join("")}</div>` : ""}
        ${groups.completed.length ? `<h2 class="section-sub">Past events</h2><div class="event-grid">${groups.completed.map(card).join("")}</div>` : ""}
      </div>
    </section>
  </main>
  ${rsvpModal()}`;
}

/* RSVP modal — closes only on overlay-background click or explicit Cancel,
   never on clicks inside the card, so Yes/No buttons always reach the
   delegated document click listener. */
function rsvpModal() {
  if (!state.modal) return "";
  return `
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal-card">
      <h3>Will you join</h3>
      <p class="modal-event-title">${escapeHtml(state.modal.title)}?</p>
      <div class="modal-actions">
        <button class="btn btn-primary" data-rsvp-yes="${state.modal.eventId}">Yes, count me in</button>
        <button class="btn btn-outline" data-rsvp-no="${state.modal.eventId}">Can't make it</button>
      </div>
      <button class="link small modal-cancel" data-modal-close="1">Cancel</button>
    </div>
  </div>`;
}

function renderAdminDashboard() {
  const pending = state.registrations.filter(r => r.status === "pending");
  const decidedRegs = state.registrations.filter(r => r.status !== "pending");
  const active = state.members.filter(m => m.status === "active");
  const revoked = state.members.filter(m => m.status === "revoked");

  const tabs = `
  <div class="admin-tabs">
    <button class="tab ${state.adminTab === 'pending' ? 'active' : ''}" data-admin-tab="pending">
      Pending ${pending.length ? `<span class="tab-count">${pending.length}</span>` : ""}
    </button>
    <button class="tab ${state.adminTab === 'members' ? 'active' : ''}" data-admin-tab="members">Members</button>
    <button class="tab ${state.adminTab === 'events' ? 'active' : ''}" data-admin-tab="events">Events</button>
    <button class="tab ${state.adminTab === 'announcements' ? 'active' : ''}" data-admin-tab="announcements">Announcements</button>
  </div>`;

  let body = "";
  if (state.adminTab === "pending") {
    body = pending.length ? `
      <div class="table-wrap"><table class="admin-table">
        <thead><tr><th>Guardian</th><th>Member</th><th>Contact</th><th>Notes</th><th>Action</th></tr></thead>
        <tbody>
          ${pending.map(r => `
            <tr>
              <td>${escapeHtml(r.guardianName)}<br><span class="fine-print">${escapeHtml(r.relationship||"")}</span></td>
              <td>${escapeHtml(r.memberName)}</td>
              <td>${escapeHtml(r.email)}<br><span class="fine-print">${escapeHtml(r.phone)}</span></td>
              <td class="notes-cell">${escapeHtml(r.notes || "—")}</td>
              <td class="actions-cell">
                <button class="btn btn-primary btn-sm" data-approve="${r.id}">Approve</button>
                <button class="btn btn-outline btn-sm" data-decline="${r.id}">Decline</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table></div>` : `<p class="empty">No pending registrations.</p>`;

    if (decidedRegs.length) {
      body += `<h3 class="section-sub">Past applications</h3><div class="table-wrap"><table class="admin-table">
        <thead><tr><th>Guardian</th><th>Member</th><th>Status</th><th></th></tr></thead>
        <tbody>${decidedRegs.map(r => `<tr><td>${escapeHtml(r.guardianName)}</td><td>${escapeHtml(r.memberName)}</td><td>${statusPill(r.status)}</td><td class="actions-cell"><button class="btn btn-outline btn-sm" data-delete-registration="${r.id}">Delete</button></td></tr>`).join("")}</tbody>
      </table></div>`;
    }
  }

  if (state.adminTab === "members") {
    const row = (m, showActions) => `
      <tr>
        <td>${escapeHtml(m.guardianName)}<br><span class="fine-print">${escapeHtml(m.relationship||"")}</span></td>
        <td>${escapeHtml(m.memberName)}</td>
        <td>${escapeHtml(m.email)}<br><span class="fine-print">${escapeHtml(m.phone)}</span></td>
        <td>${statusPill(m.status)}</td>
        <td class="actions-cell">${showActions ? `
          <button class="btn btn-outline btn-sm" data-resend="${escapeHtml(m.email)}">Resend reset email</button>
          <button class="btn btn-outline btn-sm" data-revoke="${m.id}">Revoke</button>` : ""}
          <button class="btn btn-outline btn-sm" data-delete-member="${m.id}">Delete</button></td>
      </tr>`;
    body = `
      <div class="table-wrap"><table class="admin-table">
        <thead><tr><th>Guardian</th><th>Member</th><th>Contact</th><th>Status</th><th></th></tr></thead>
        <tbody>${active.map(m => row(m, true)).join("")}${revoked.map(m => row(m, false)).join("")}</tbody>
      </table></div>
      ${!active.length && !revoked.length ? `<p class="empty">No members yet.</p>` : ""}
      <p class="fine-print" style="margin-top:14px">To fully delete a revoked member's login, remove them in the
        Firebase console under <strong>Authentication → Users</strong>.</p>`;
  }

  if (state.adminTab === "events") {
    const editing = state.editingEventId ? state.events.find(e => e.id === state.editingEventId) : null;
    const sorted = [...state.events].sort((a, b) => (a.date + (a.time||"")).localeCompare(b.date + (b.time||"")));

    body = `
      <div id="event-form-anchor" class="card form-card event-form">
        <h3>${editing ? "Edit event" : "Create a new event"}</h3>
        <form id="event-form">
          <label>Title *<input name="title" required value="${editing ? escapeHtml(editing.title) : ""}" /></label>
          <div class="two-col">
            <label>Date *<input type="date" name="date" required value="${editing ? editing.date : ""}" /></label>
            <label>Time<input type="time" name="time" value="${editing ? (editing.time||"") : ""}" /></label>
          </div>
          <label>Location *<input name="location" required value="${editing ? escapeHtml(editing.location) : ""}" /></label>
          <label>Description<textarea name="description" rows="3">${editing ? escapeHtml(editing.description||"") : ""}</textarea></label>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">${editing ? "Save changes" : "Create event"}</button>
            ${editing ? `<button type="button" class="btn btn-outline" data-cancel-edit="1">Cancel</button>` : ""}
          </div>
        </form>
      </div>

      <h3 class="section-sub">All events</h3>
      ${sorted.length ? sorted.map(e => {
        const c = rsvpCounts(e.id);
        const attendees = c.list.filter(r => r.response === "yes")
          .map(r => state.members.find(m => m.id === r.memberId)?.memberName || "—");
        return `
        <div class="admin-event-row">
          <div class="admin-event-info">
            <div class="event-top">${statusPill(e.status)}</div>
            <h4>${escapeHtml(e.title)}</h4>
            <p class="event-meta">📅 ${fmtDate(e.date)}${e.time ? " · " + fmtTime(e.time) : ""} &nbsp;·&nbsp; 📍 ${escapeHtml(e.location)}</p>
            <p class="rsvp-tally">✅ ${c.yes} going &nbsp; ❎ ${c.no} not going</p>
            ${attendees.length ? `<p class="fine-print">Going: ${attendees.map(escapeHtml).join(", ")}</p>` : ""}
          </div>
          <div class="admin-event-actions">
            <select data-status-select="${e.id}">
              <option value="upcoming" ${e.status==="upcoming"?"selected":""}>Upcoming</option>
              <option value="ongoing" ${e.status==="ongoing"?"selected":""}>In progress</option>
              <option value="completed" ${e.status==="completed"?"selected":""}>Completed</option>
            </select>
            <button class="btn btn-outline btn-sm" data-edit-event="${e.id}">Edit</button>
            <button class="btn btn-outline btn-sm" data-delete-event="${e.id}">Delete</button>
          </div>
          <div class="admin-event-photos">
            <label class="btn btn-outline btn-sm photo-upload-btn">
              📷 Upload Photo
              <input type="file" accept="image/*" data-photo-upload="${e.id}" hidden />
            </label>
            ${eventPhotosFor(e.id).length ? `<div class="photo-thumb-row">
              ${eventPhotosFor(e.id).map(p => `
                <div class="photo-thumb">
                  <img src="${p.url}" alt="" />
                  <button class="photo-thumb-remove" data-delete-photo="${p.id}" data-photo-path="${escapeHtml(p.storagePath)}">✕</button>
                </div>`).join("")}
            </div>` : `<p class="fine-print">No photos yet — upload some to showcase this event.</p>`}
          </div>
        </div>`;
      }).join("") : `<p class="empty">No events yet — create the first one above.</p>`}
    `;
  }

  if (state.adminTab === "announcements") {
    body = `
      <div class="card form-card">
        <h3>Post a new announcement</h3>
        <form id="announcement-form">
          <label>Title *<input name="title" required /></label>
          <label>Message *<textarea name="body" rows="3" required></textarea></label>
          <button type="submit" class="btn btn-primary">Post announcement</button>
        </form>
      </div>
      <h3 class="section-sub">Posted announcements</h3>
      ${state.announcements.length ? state.announcements.map(a => `
        <div class="admin-event-row">
          <div class="admin-event-info">
            <h4>${escapeHtml(a.title)}</h4>
            <p class="event-desc">${escapeHtml(a.body)}</p>
          </div>
          <div class="admin-event-actions">
            <button class="btn btn-outline btn-sm" data-delete-announcement="${a.id}">Delete</button>
          </div>
        </div>`).join("") : `<p class="empty">No announcements yet.</p>`}
    `;
  }

  return `
  <header class="site-header">
    <div class="wrap nav-inner">
      <div class="brand" data-nav="home"><img src="${LOGO_SRC}" class="brand-logo" alt="GADs logo"/>
        <div class="brand-text"><span class="brand-title">Gentle Angels</span><span class="brand-sub">Admin Panel</span></div>
      </div>
      <div class="nav-actions"><button class="btn btn-ghost" data-logout="1">Log out</button></div>
    </div>
  </header>
  <main>
    <section class="section">
      <div class="wrap">
        <h1>Organizer dashboard</h1>
        ${tabs}
        <div class="admin-body">${body}</div>
      </div>
    </section>
  </main>`;
}

/* ---------------------------- decorative SVGs ---------------------------- */

function wingHeartSVG() {
  return `
  <svg viewBox="0 0 400 320" xmlns="http://www.w3.org/2000/svg">
    <path d="M200 90 C 170 40, 90 40, 70 100 C 50 160, 110 210, 200 270 C 290 210, 350 160, 330 100 C 310 40, 230 40, 200 90 Z"
      fill="none" stroke="var(--yellow-deep)" stroke-width="10" stroke-linecap="round"/>
    <path d="M120 150 C 60 130, 30 150, 10 180 C 50 185, 70 175, 90 190 C 60 195, 45 205, 30 225 C 70 225, 95 215, 115 200"
      fill="var(--navy)" opacity="0.9"/>
    <path d="M280 150 C 340 130, 370 150, 390 180 C 350 185, 330 175, 310 190 C 340 195, 355 205, 370 225 C 330 225, 305 215, 285 200"
      fill="var(--navy)" opacity="0.9"/>
    <ellipse cx="200" cy="185" rx="70" ry="55" fill="var(--coral)"/>
    <ellipse cx="200" cy="150" rx="78" ry="18" fill="var(--coral)" opacity="0.85"/>
  </svg>`;
}
function wingDivider() {
  return `<svg class="wing-divider" viewBox="0 0 1200 60" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0,30 C 300,80 900,-20 1200,30 L1200,60 L0,60 Z" fill="var(--bg)"/>
  </svg>`;
}

/* ---------------------------- main render + events ---------------------------- */

function render() {
  const el = document.getElementById("app");
  if (state.booting || !state.authChecked) {
    el.innerHTML = `<div class="boot"><div class="spinner"></div><p>Loading GADs…</p></div>`;
    return;
  }
  let html = noticeBanner();
  switch (state.view) {
    case "about": html += renderAbout(); break;
    case "contact": html += renderContact(); break;
    case "register": html += renderRegister(); break;
    case "registerSuccess": html += renderRegisterSuccess(); break;
    case "login": html += renderLogin(); break;
    case "adminLogin": html += renderAdminLogin(); break;
    case "memberDashboard": html += state.currentMember ? renderMemberDashboard() : renderLogin(); break;
    case "adminDashboard": html += state.isAdmin ? renderAdminDashboard() : renderAdminLogin(); break;
    default: html += renderHome();
  }
  el.innerHTML = html;
}

document.addEventListener("click", (ev) => {
  const mobileToggle = ev.target.closest("[data-mobile-toggle]");
  if (mobileToggle) { state.mobileNavOpen = !state.mobileNavOpen; render(); return; }

  const nav = ev.target.closest("[data-nav]");
  if (nav) { goto(nav.getAttribute("data-nav")); return; }

  if (ev.target.closest("[data-logout]")) { logout(); return; }

  const approve = ev.target.closest("[data-approve]");
  if (approve) { approveRegistration(approve.getAttribute("data-approve")); return; }

  const decline = ev.target.closest("[data-decline]");
  if (decline) { declineRegistration(decline.getAttribute("data-decline")); return; }

  const revoke = ev.target.closest("[data-revoke]");
  if (revoke) { revokeMember(revoke.getAttribute("data-revoke")); return; }

  const delMember = ev.target.closest("[data-delete-member]");
  if (delMember) {
    if (confirm("Delete this member record? This can't be undone. (Their login will still exist in Firebase Authentication unless you also remove it there.)")) {
      deleteMember(delMember.getAttribute("data-delete-member"));
    }
    return;
  }

  const delRegistration = ev.target.closest("[data-delete-registration]");
  if (delRegistration) {
    if (confirm("Delete this registration record? This can't be undone.")) {
      deleteRegistration(delRegistration.getAttribute("data-delete-registration"));
    }
    return;
  }

  const resend = ev.target.closest("[data-resend]");
  if (resend) { resendReset(resend.getAttribute("data-resend")); return; }

  const tab = ev.target.closest("[data-admin-tab]");
  if (tab) { state.adminTab = tab.getAttribute("data-admin-tab"); render(); return; }

  const rsvpOpen = ev.target.closest("[data-rsvp-open]");
  if (rsvpOpen) { openRsvpModal(rsvpOpen.getAttribute("data-rsvp-open"), rsvpOpen.getAttribute("data-rsvp-title")); return; }

  const rsvpYes = ev.target.closest("[data-rsvp-yes]");
  if (rsvpYes) { submitRsvp(rsvpYes.getAttribute("data-rsvp-yes"), "yes"); return; }

  const rsvpNo = ev.target.closest("[data-rsvp-no]");
  if (rsvpNo) { submitRsvp(rsvpNo.getAttribute("data-rsvp-no"), "no"); return; }

  const icsBtn = ev.target.closest("[data-ics]");
  if (icsBtn) { addEventToCalendar(icsBtn.getAttribute("data-ics")); return; }

  const modalClose = ev.target.id === "modal-overlay" || ev.target.closest("[data-modal-close]");
  if (modalClose) { closeModal(); return; }

  const editEvent = ev.target.closest("[data-edit-event]");
  if (editEvent) { startEditEvent(editEvent.getAttribute("data-edit-event")); return; }

  const cancelEdit = ev.target.closest("[data-cancel-edit]");
  if (cancelEdit) { cancelEditEvent(); return; }

  const delEvent = ev.target.closest("[data-delete-event]");
  if (delEvent) {
    if (confirm("Delete this event? This can't be undone.")) deleteEvent(delEvent.getAttribute("data-delete-event"));
    return;
  }

  const delPhoto = ev.target.closest("[data-delete-photo]");
  if (delPhoto) {
    if (confirm("Remove this photo?")) deleteEventPhoto(delPhoto.getAttribute("data-delete-photo"), delPhoto.getAttribute("data-photo-path"));
    return;
  }

  const delAnnouncement = ev.target.closest("[data-delete-announcement]");
  if (delAnnouncement) {
    if (confirm("Delete this announcement?")) deleteAnnouncement(delAnnouncement.getAttribute("data-delete-announcement"));
    return;
  }

  const forgotBtn = ev.target.closest("#forgot-btn");
  if (forgotBtn) {
    const emailInput = document.querySelector('#login-form input[name="email"]');
    forgotPassword(emailInput ? emailInput.value : "");
    return;
  }
});

document.addEventListener("change", (ev) => {
  const sel = ev.target.closest("[data-status-select]");
  if (sel) { setEventStatus(sel.getAttribute("data-status-select"), sel.value); return; }

  const photoInput = ev.target.closest("[data-photo-upload]");
  if (photoInput) {
    const eventId = photoInput.getAttribute("data-photo-upload");
    const file = photoInput.files && photoInput.files[0];
    uploadEventPhoto(eventId, file);
    photoInput.value = "";
  }
});

document.addEventListener("submit", (ev) => {
  ev.preventDefault();
  if (ev.target.id === "register-form") submitRegistration(ev.target);
  if (ev.target.id === "login-form") {
    const fd = new FormData(ev.target);
    memberLogin(fd.get("email"), fd.get("password"));
  }
  if (ev.target.id === "admin-login-form") {
    const fd = new FormData(ev.target);
    adminLogin(fd.get("email"), fd.get("password"));
  }
  if (ev.target.id === "event-form") createOrUpdateEvent(ev.target);
  if (ev.target.id === "announcement-form") createAnnouncement(ev.target);
});

attachPublicListeners();
render();

let heroSlideIndex = 0;
function showHeroSlide(i) {
  const slides = document.querySelectorAll(".hero-slide");
  const dots = document.querySelectorAll(".hero-dot");
  if (!slides.length) return;
  slides.forEach(s => s.classList.remove("active"));
  dots.forEach(d => d.classList.remove("active"));
  heroSlideIndex = ((i % slides.length) + slides.length) % slides.length;
  slides[heroSlideIndex].classList.add("active");
  if (dots[heroSlideIndex]) dots[heroSlideIndex].classList.add("active");
}

setInterval(() => showHeroSlide(heroSlideIndex + 1), 3500);

document.addEventListener("click", (ev) => {
  const dot = ev.target.closest("[data-dot]");
  if (dot) showHeroSlide(parseInt(dot.getAttribute("data-dot"), 10));
});